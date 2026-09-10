#!/usr/bin/env python3
"""Collect fresh staging-only surf or tide candidates with pinned Atmos producers.

This file owns orchestration only.  Forecast decoding, normalization, packaging and
validation remain in the reviewed Atmos checkout supplied with ``--source``.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import importlib.util
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Mapping


SURF_SPOTS = 49
SURF_LEADS = 73
SURF_MIN_REMAINING = timedelta(hours=6)
TIDE_REFERENCE_STATIONS = 1256
TIDE_MIN_AVAILABLE = 1251
TIDE_CHECKPOINT_MANIFEST_MAX_BYTES = 2_097_152
_CREDENTIAL = re.compile(
    r"^(?:STAGING_R2_WRITE_|STAGING_PLACES_SEED_KEY$|UI_|AWS_|RCLONE_|"
    r"CLOUDFLARE_|CF_API_|R2_|SHARED_R2_|STAGING_WORKER_)"
)


class CollectionRefused(RuntimeError):
    """A candidate could not be collected without weakening its contract."""


class _Sink:
    """Discard producer chatter so public automation emits only bounded receipts."""

    def write(self, value: str) -> int:
        return len(value)

    def flush(self) -> None:
        pass


def _utc(value: datetime) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise CollectionRefused("invalid collection clock")
    return value.astimezone(timezone.utc)


def _iso(value: datetime) -> str:
    return _utc(value).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def select_surf_run(now: datetime) -> str:
    """Latest six-hour cycle whose initialization is at least six hours old."""
    eligible = _utc(now) - timedelta(hours=6)
    initialized = eligible.replace(hour=(eligible.hour // 6) * 6, minute=0, second=0, microsecond=0)
    return initialized.strftime("%Y%m%d%H")


def _contains(parent: Path, child: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def confined_roots(source_arg: str | Path, root_arg: str | Path) -> tuple[Path, Path]:
    source_input, root_input = Path(source_arg), Path(root_arg)
    if not source_input.is_absolute() or not root_input.is_absolute():
        raise CollectionRefused("absolute source and run roots required")
    source = source_input.resolve(strict=True)
    if not source.is_dir() or source != source_input:
        raise CollectionRefused("source must be a canonical directory")
    if root_input.exists() or root_input.is_symlink():
        raise CollectionRefused("run root already exists")
    parent = root_input.parent.resolve(strict=True)
    root = parent / root_input.name
    if root != root_input or _contains(source, root) or _contains(root, source):
        raise CollectionRefused("run root must stay outside the source checkout")
    return source, root


def refuse_credentials(env: Mapping[str, str]) -> None:
    if any(value and _CREDENTIAL.match(name) for name, value in env.items()):
        raise CollectionRefused("publication credentials are not accepted")


def _load(source: Path, family: str) -> ModuleType:
    name = "surf_forecast" if family == "surf" else "fetch_tides"
    file = source / "data" / f"{name}.py"
    if not file.is_file() or file.is_symlink() or file.resolve() != file:
        raise CollectionRefused("reviewed producer module is unavailable")
    spec = importlib.util.spec_from_file_location(f"weatherx_collector_{name}", file)
    if spec is None or spec.loader is None:
        raise CollectionRefused("reviewed producer module is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _session(factory: Callable[[], Any]) -> Any:
    session = factory()
    if hasattr(session, "trust_env"):
        session.trust_env = False
    return session


def _default_session() -> Any:
    import requests

    return requests.Session()


def _parse_iso(value: Any) -> datetime:
    if not isinstance(value, str):
        raise CollectionRefused("candidate timestamp is invalid")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise CollectionRefused("candidate timestamp is invalid") from error
    return parsed


def collect_surf(
    source: Path,
    root: Path,
    producer: ModuleType,
    *,
    clock: Callable[[], datetime],
    session_factory: Callable[[], Any],
) -> dict[str, Any]:
    started = _utc(clock())
    run_id = select_surf_run(started)
    catalog_path = source / "app" / "public" / "surf" / "catalog.json"
    catalog = producer.load_catalog(catalog_path)
    if len(catalog.get("spots", [])) != SURF_SPOTS:
        raise CollectionRefused("reviewed surf roster differs")

    checkpoint = root / "checkpoint"
    candidate = root / "candidate"
    checkpoint.mkdir(mode=0o700)
    stage_path = checkpoint / "stage.json"
    session = _session(session_factory)
    try:
        with contextlib.redirect_stdout(_Sink()), contextlib.redirect_stderr(_Sink()):
            stage = producer.collect_direct(
                catalog_path, stage_path, run_id, producer.MAX_HOURS, session=session
            )
    finally:
        close = getattr(session, "close", None)
        if callable(close):
            close()

    producer.validate_stage(stage, catalog)
    if not producer.stage_matches(stage_path, catalog_path, run_id):
        raise CollectionRefused("surf stage is not the complete selected run")
    rows = stage.get("spots")
    if not isinstance(rows, list) or len(rows) != SURF_SPOTS or any(
        not isinstance(row.get("samples"), list) or len(row["samples"]) != SURF_LEADS
        for row in rows
    ):
        raise CollectionRefused("surf pilot horizon or roster differs")

    stage_bytes = stage_path.read_bytes()
    release_id = f"surf-{run_id}-{hashlib.sha256(stage_bytes).hexdigest()[:12]}"
    index = producer.finalize(stage_path, catalog_path, candidate, release_id)
    checked = _utc(clock())
    initialized = _parse_iso(stage.get("initializedAt"))
    fresh_until = _parse_iso(stage.get("freshUntil"))
    if initialized > checked or fresh_until - checked < SURF_MIN_REMAINING:
        raise CollectionRefused("surf candidate lacks six hours of remaining freshness")
    if (
        index.get("releaseId") != release_id
        or index.get("source", {}).get("runId") != run_id
        or index.get("source", {}).get("initializedAt") != stage.get("initializedAt")
        or index.get("source", {}).get("freshUntil") != stage.get("freshUntil")
        or len(index.get("times", [])) != SURF_LEADS
        or len(index.get("spots", [])) != SURF_SPOTS
    ):
        raise CollectionRefused("final surf candidate changed collected identity or time")
    return {
        "family": "surf",
        "identity": release_id,
        "candidate": "candidate",
        "checkpoint": "checkpoint",
        "sourceExpiresAt": stage["freshUntil"],
    }


def _freeze_tide_roster(
    producer: ModuleType, checkpoint: Path, session: Any, retrieved: datetime
) -> dict[str, Any]:
    stations = producer.fetch_stations(session)
    roster = producer._canonical_roster(stations, ("R",))
    if len(roster) != TIDE_REFERENCE_STATIONS:
        raise CollectionRefused("official reference roster differs")
    day = retrieved.date()
    manifest = {
        "schemaVersion": producer.CHECKPOINT_SCHEMA_VERSION,
        "kind": "weatherx-tide-fetch",
        "retrievedAt": producer._iso(retrieved),
        "beginDate": (day - timedelta(days=producer.LOOKBACK_DAYS)).isoformat(),
        "endDate": (
            day + timedelta(days=producer.FORECAST_DAYS + producer.RIGHT_BRACKET_DAYS)
        ).isoformat(),
        "includeSubordinate": False,
        "stations": roster,
    }
    producer._atomic_json(checkpoint / "manifest.json", manifest)
    if producer._checkpoint_manifest(checkpoint) != manifest:
        raise CollectionRefused("frozen tide roster failed producer validation")
    return manifest


def _tide_minimum_failure_count(error: BaseException) -> int | None:
    """Recognize only the pinned producer's explicit partial-minimum refusal."""
    if type(error) is not RuntimeError or len(error.args) != 1 or type(error.args[0]) is not str:
        return None
    message = error.args[0]
    if len(message) > 160:
        return None
    match = re.fullmatch(
        r"Staging tide minimum not met \(([0-9]{1,4}) available, ([0-9]{1,4}) required\); "
        r"previous catalog preserved",
        message,
    )
    if match is None:
        return None
    available, required = map(int, match.groups())
    if required != TIDE_MIN_AVAILABLE or not 0 < available < required:
        return None
    return available


def _tide_manifest_seal(checkpoint: Path) -> str:
    path = checkpoint / "manifest.json"
    try:
        stat = path.stat()
        if (path.is_symlink() or not path.is_file() or stat.st_nlink != 1
                or path.resolve() != path
                or not 0 < stat.st_size <= TIDE_CHECKPOINT_MANIFEST_MAX_BYTES):
            raise CollectionRefused("frozen tide manifest changed")
        body = path.read_bytes()
    except OSError as error:
        raise CollectionRefused("frozen tide manifest changed") from error
    if len(body) != stat.st_size:
        raise CollectionRefused("frozen tide manifest changed")
    return hashlib.sha256(body).hexdigest()


def _require_frozen_tide_manifest(
    producer: ModuleType,
    checkpoint: Path,
    manifest: dict[str, Any],
    retrieved: datetime,
    manifest_sha256: str,
) -> None:
    if (_tide_manifest_seal(checkpoint) != manifest_sha256
            or producer._checkpoint_manifest(checkpoint) != manifest
            or manifest.get("retrievedAt") != _iso(retrieved)):
        raise CollectionRefused("frozen tide manifest changed")


def collect_tides(
    root: Path,
    producer: ModuleType,
    *,
    clock: Callable[[], datetime],
    session_factory: Callable[[], Any] | None,
) -> dict[str, Any]:
    retrieved = _utc(clock()).replace(microsecond=0)
    checkpoint = root / "checkpoint"
    candidate = root / "candidate"
    checkpoint.mkdir(mode=0o700)
    session = _session(session_factory or producer._session)
    resume_attempts = 0
    first_pass_available = None
    try:
        with contextlib.redirect_stdout(_Sink()), contextlib.redirect_stderr(_Sink()):
            manifest = _freeze_tide_roster(producer, checkpoint, session, retrieved)
            manifest_sha256 = _tide_manifest_seal(checkpoint)

            def bake() -> tuple[dict[str, Any], int]:
                return producer.bake_v2(
                    session,
                    manifest["stations"],
                    candidate / "v2",
                    candidate / "tides.json",
                    now=retrieved,
                    include_subordinate=False,
                    checkpoint_dir=checkpoint,
                    staging_partial=True,
                    min_available_stations=TIDE_MIN_AVAILABLE,
                )

            try:
                catalog, failed = bake()
            except Exception as error:
                first_pass_available = _tide_minimum_failure_count(error)
                if first_pass_available is None:
                    raise
                _require_frozen_tide_manifest(
                    producer, checkpoint, manifest, retrieved, manifest_sha256
                )
                resume_attempts = 1
                # Exactly one retry reuses the same session, manifest and product cache.
                # The outer 45-minute process deadline remains the overall bound.
                catalog, failed = bake()
            _require_frozen_tide_manifest(
                producer, checkpoint, manifest, retrieved, manifest_sha256
            )
    finally:
        close = getattr(session, "close", None)
        if callable(close):
            close()

    available = catalog.get("stations")
    availability = catalog.get("availability")
    if (
        catalog.get("retrievedAt") != manifest["retrievedAt"]
        or catalog.get("datasetId") != "noaa-coops-" + retrieved.strftime("%Y%m%dT%H%M%SZ")
        or not isinstance(available, list)
        or len(available) < TIDE_MIN_AVAILABLE
        or failed != TIDE_REFERENCE_STATIONS - len(available)
        or not isinstance(availability, dict)
        or availability.get("requestedCount") != TIDE_REFERENCE_STATIONS
        or availability.get("availableCount") != len(available)
        or availability.get("unavailableCount") != failed
    ):
        raise CollectionRefused("tide staging availability contract differs")
    result = {
        "family": "tides",
        "identity": catalog["datasetId"],
        "candidate": "candidate",
        "checkpoint": "checkpoint",
        "requestedStationCount": TIDE_REFERENCE_STATIONS,
        "availableStationCount": len(available),
    }
    if resume_attempts:
        result.update({
            "resumeAttempts": resume_attempts,
            "firstPassAvailableStationCount": first_pass_available,
        })
    return result


def collect(
    source_arg: str | Path,
    root_arg: str | Path,
    family: str,
    *,
    env: Mapping[str, str] = os.environ,
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    modules: Mapping[str, ModuleType] | None = None,
    session_factory: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    if family not in ("surf", "tides"):
        raise CollectionRefused("only fresh forecast families can be collected")
    refuse_credentials(env)
    source, root = confined_roots(source_arg, root_arg)
    producer = modules[family] if modules is not None else _load(source, family)
    root.mkdir(mode=0o700)
    if family == "surf":
        return collect_surf(
            source,
            root,
            producer,
            clock=clock,
            session_factory=session_factory or _default_session,
        )
    return collect_tides(
        root,
        producer,
        clock=clock,
        session_factory=session_factory,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--family", required=True, choices=("surf", "tides"))
    args = parser.parse_args(argv)
    try:
        if sys.version_info[:2] != (3, 12):
            raise CollectionRefused("Python 3.12 is required")
        result = collect(args.source, args.root, args.family)
    except Exception:
        print("staging place collection refused", file=sys.stderr)
        return 1
    print(json.dumps(result, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
