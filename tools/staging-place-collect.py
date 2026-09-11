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
import math
import os
import re
import sys
import threading
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Mapping


SURF_SPOTS = 49
SURF_LEADS = 73
SURF_MIN_REMAINING = timedelta(hours=6)
TIDE_REFERENCE_STATIONS = 1256
TIDE_MIN_AVAILABLE = 1251
TIDE_REQUESTS_PER_SECOND = 2.0
TIDE_CHECKPOINT_MANIFEST_MAX_BYTES = 2_097_152
_CREDENTIAL = re.compile(
    r"^(?:STAGING_R2_WRITE_|STAGING_PLACES_SEED_KEY$|UI_|AWS_|RCLONE_|"
    r"CLOUDFLARE_|CF_API_|R2_|SHARED_R2_|STAGING_WORKER_)"
)


class CollectionRefused(RuntimeError):
    """A candidate could not be collected without weakening its contract."""


_FAILURE_PHASES = {"setup", "source", "roster", "fetch", "checkpoint", "validate", "finalize", "session", "collector"}
_FAILURE_CLASSES = {"contract", "environment", "provider", "provider-cooldown", "minimum-availability", "unknown"}
_COUNT_LIMIT = 20_000


class CollectionFailure(CollectionRefused):
    """A collection failure carrying only explicitly safe diagnostic fields."""

    def __init__(self, phase: str, category: str, **fields: Any):
        super().__init__("staging place collection failed")
        self.diagnostic = {"phase": phase, "class": category, **fields}


class _RequestTelemetry:
    """Thread-safe aggregate request observations; never retain request or response data."""

    _COUNT_KEYS = ("http2xx", "http403", "http429", "http5xx", "httpOther", "timeouts", "overlongRetryAfter")

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._counts = {key: 0 for key in self._COUNT_KEYS}

    def _increment(self, key: str) -> None:
        with self._lock:
            self._counts[key] = min(_COUNT_LIMIT, self._counts[key] + 1)

    @staticmethod
    def _overlong_retry_after(value: Any, limit: Any) -> bool:
        if not isinstance(value, str) or not isinstance(limit, (int, float)):
            return False
        try:
            stripped = value.strip()
            if len(stripped) > 128:
                return stripped.isdigit() and math.isfinite(float(limit))
            if re.fullmatch(r"\d+", stripped):
                seconds = float(stripped)
            else:
                parsed = parsedate_to_datetime(stripped)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                seconds = max(0.0, (parsed.astimezone(timezone.utc) - datetime.now(timezone.utc)).total_seconds())
            return math.isfinite(float(limit)) and seconds > float(limit)
        except (TypeError, ValueError, OverflowError):
            return False

    @staticmethod
    def _is_timeout(error: BaseException) -> bool:
        return (isinstance(error, TimeoutError) or getattr(error, "code", None) == "ETIMEDOUT"
                or (type(error).__module__ == "requests.exceptions"
                    and type(error).__name__ in {"Timeout", "ConnectTimeout", "ReadTimeout"}))

    def instrument(self, session: Any, producer: ModuleType) -> None:
        original = getattr(session, "get", None)
        if not callable(original):
            return

        def observed(*args: Any, **kwargs: Any) -> Any:
            try:
                response = original(*args, **kwargs)
            except Exception as error:
                if self._is_timeout(error):
                    self._increment("timeouts")
                raise
            try:
                status = getattr(response, "status_code", None)
                if isinstance(status, int) and 200 <= status < 300:
                    self._increment("http2xx")
                elif status == 403:
                    self._increment("http403")
                elif status == 429:
                    self._increment("http429")
                elif isinstance(status, int) and 500 <= status < 600:
                    self._increment("http5xx")
                else:
                    self._increment("httpOther")
                headers = getattr(response, "headers", None)
                retry_after = headers.get("Retry-After") if hasattr(headers, "get") else None
                if self._overlong_retry_after(retry_after, getattr(producer, "MAX_RETRY_AFTER_S", None)):
                    self._increment("overlongRetryAfter")
            except Exception:
                # Observability must not change the pinned producer's response path.
                pass
            return response

        session.get = observed

    def snapshot(self, producer: ModuleType | None = None) -> dict[str, Any]:
        with self._lock:
            result = dict(self._counts)
        pacer = getattr(producer, "_GLOBAL_PACER", None) if producer is not None else None
        result["pacerStopped"] = getattr(pacer, "_stopped", None) is True
        return result


def _configure_tide_pacer(producer: ModuleType, requests_per_second: float) -> Any:
    """Tighten only the existing reviewed pacer's spacing before any request."""
    try:
        pacer_class = producer._GlobalPacer
        pacer = producer._GLOBAL_PACER
        lock = pacer._lock
        if (requests_per_second != TIDE_REQUESTS_PER_SECOND
                or producer.MAX_REQUESTS_PER_SECOND != 4.0
                or not isinstance(pacer_class, type)
                or type(pacer) is not pacer_class
                or not callable(getattr(lock, "acquire", None))
                or not callable(getattr(lock, "release", None))):
            raise ValueError
        with lock:
            gap = pacer._gap
            next_slot = pacer._next
            cooldown = pacer._cooldown
            stopped = pacer._stopped
            clock = pacer._clock
            sleep = pacer._sleep
            if (not isinstance(gap, (int, float)) or isinstance(gap, bool) or not math.isfinite(gap) or gap <= 0
                    or not isinstance(next_slot, (int, float)) or isinstance(next_slot, bool)
                    or not math.isfinite(next_slot) or next_slot < 0
                    or not isinstance(cooldown, (int, float)) or isinstance(cooldown, bool)
                    or not math.isfinite(cooldown) or cooldown < 0
                    or type(stopped) is not bool or not callable(clock) or not callable(sleep)):
                raise ValueError
            if stopped:
                raise CollectionFailure("session", "provider", requestCounts=_RequestTelemetry().snapshot(producer))
            pacer._gap = max(float(gap), 1.0 / requests_per_second)
        return pacer
    except CollectionFailure:
        raise
    except Exception:
        raise CollectionFailure("session", "contract") from None


def _bounded_count(value: Any, maximum: int = _COUNT_LIMIT) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= maximum else None


def _request_counts(value: Any) -> dict[str, Any] | None:
    expected = {*_RequestTelemetry._COUNT_KEYS, "pacerStopped"}
    if not isinstance(value, dict) or set(value) != expected or type(value.get("pacerStopped")) is not bool:
        return None
    result = {key: _bounded_count(value.get(key)) for key in _RequestTelemetry._COUNT_KEYS}
    if any(count is None for count in result.values()):
        return None
    return {**result, "pacerStopped": value["pacerStopped"]}


def failure_receipt(family: str, error: BaseException) -> dict[str, Any]:
    row = error.diagnostic if isinstance(error, CollectionFailure) else {}
    phase = row.get("phase") if row.get("phase") in _FAILURE_PHASES else "collector"
    category = row.get("class") if row.get("class") in _FAILURE_CLASSES else "unknown"
    result: dict[str, Any] = {"schemaVersion": 1, "kind": "staging-place-collection", "status": "failed",
                              "family": family if family in ("surf", "tides") else "surf",
                              "phase": phase, "class": category}
    for key, maximum in (("rosterStationCount", 5000), ("availableStationCount", 5000),
                         ("requiredStationCount", 5000), ("resumeAttempts", 1),
                         ("firstPassAvailableStationCount", 5000)):
        count = _bounded_count(row.get(key), maximum)
        if count is not None:
            result[key] = count
    for key in ("firstPassRequestCounts", "requestCounts"):
        counts = _request_counts(row.get(key))
        if counts is not None:
            result[key] = counts
    return result


def success_receipt(result: Mapping[str, Any]) -> dict[str, Any]:
    family = result.get("family")
    receipt: dict[str, Any] = {"schemaVersion": 1, "kind": "staging-place-collection",
                               "status": "succeeded", "family": family}
    if family == "surf":
        receipt.update(spotCount=result.get("spotCount"), leadCount=result.get("leadCount"))
    elif family == "tides":
        for key in ("rosterStationCount", "requiredStationCount", "availableStationCount",
                    "resumeAttempts", "firstPassAvailableStationCount", "firstPassRequestCounts"):
            if key in result:
                receipt[key] = result[key]
    else:
        raise CollectionRefused("invalid collection result")
    receipt["requestCounts"] = result.get("requestCounts")
    return receipt


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
    telemetry = _RequestTelemetry()
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
    telemetry.instrument(session, producer)
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
        "spotCount": SURF_SPOTS,
        "leadCount": SURF_LEADS,
        "requestCounts": telemetry.snapshot(producer),
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
    requests_per_second: float = TIDE_REQUESTS_PER_SECOND,
) -> dict[str, Any]:
    telemetry = _RequestTelemetry()
    _configure_tide_pacer(producer, requests_per_second)
    retrieved = _utc(clock()).replace(microsecond=0)
    checkpoint = root / "checkpoint"
    candidate = root / "candidate"
    checkpoint.mkdir(mode=0o700)
    session = _session(session_factory or producer._session)
    telemetry.instrument(session, producer)
    resume_attempts = 0
    first_pass_available = None
    first_pass_request_counts = None
    roster_count = None
    phase = "roster"
    try:
        try:
            with contextlib.redirect_stdout(_Sink()), contextlib.redirect_stderr(_Sink()):
                try:
                    manifest = _freeze_tide_roster(producer, checkpoint, session, retrieved)
                except CollectionFailure:
                    raise
                except Exception as error:
                    raise CollectionFailure("roster", "contract" if isinstance(error, CollectionRefused) else "provider",
                                            requestCounts=telemetry.snapshot(producer)) from None
                roster_count = len(manifest["stations"])
                phase = "checkpoint"
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

                phase = "fetch"
                try:
                    catalog, failed = bake()
                except Exception as error:
                    first_pass_available = _tide_minimum_failure_count(error)
                    if first_pass_available is None:
                        raise
                    first_pass_request_counts = telemetry.snapshot(producer)
                    if first_pass_request_counts["pacerStopped"]:
                        raise CollectionFailure(
                            "fetch", "provider-cooldown", rosterStationCount=roster_count,
                            availableStationCount=first_pass_available, requiredStationCount=TIDE_MIN_AVAILABLE,
                            resumeAttempts=0, firstPassAvailableStationCount=first_pass_available,
                            firstPassRequestCounts=first_pass_request_counts,
                            requestCounts=first_pass_request_counts,
                        ) from None
                    phase = "checkpoint"
                    _require_frozen_tide_manifest(
                        producer, checkpoint, manifest, retrieved, manifest_sha256
                    )
                    resume_attempts = 1
                    # Exactly one retry reuses the same session, manifest and product cache.
                    # The outer 45-minute process deadline remains the overall bound.
                    phase = "fetch"
                    catalog, failed = bake()
                phase = "checkpoint"
                _require_frozen_tide_manifest(
                    producer, checkpoint, manifest, retrieved, manifest_sha256
                )
        except CollectionFailure:
            raise
        except Exception as error:
            available = _tide_minimum_failure_count(error)
            fields: dict[str, Any] = {"resumeAttempts": resume_attempts,
                                      "requestCounts": telemetry.snapshot(producer)}
            if roster_count is not None:
                fields["rosterStationCount"] = roster_count
            if first_pass_available is not None:
                fields["firstPassAvailableStationCount"] = first_pass_available
            if first_pass_request_counts is not None:
                fields["firstPassRequestCounts"] = first_pass_request_counts
            if available is not None:
                fields.update(availableStationCount=available, requiredStationCount=TIDE_MIN_AVAILABLE)
                category = "minimum-availability"
            else:
                category = "contract" if isinstance(error, CollectionRefused) else "provider"
            raise CollectionFailure(phase, category, **fields) from None
    finally:
        close = getattr(session, "close", None)
        if callable(close):
            close()

    phase = "validate"
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
        raise CollectionFailure("validate", "contract", rosterStationCount=roster_count,
                                resumeAttempts=resume_attempts, requestCounts=telemetry.snapshot(producer))
    result = {
        "family": "tides",
        "identity": catalog["datasetId"],
        "candidate": "candidate",
        "checkpoint": "checkpoint",
        "rosterStationCount": roster_count,
        "requiredStationCount": TIDE_MIN_AVAILABLE,
        "requestedStationCount": TIDE_REFERENCE_STATIONS,
        "availableStationCount": len(available),
        "resumeAttempts": resume_attempts,
        "requestCounts": telemetry.snapshot(producer),
    }
    if resume_attempts:
        result.update({
            "firstPassAvailableStationCount": first_pass_available,
            "firstPassRequestCounts": first_pass_request_counts,
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
    tide_requests_per_second: float = TIDE_REQUESTS_PER_SECOND,
) -> dict[str, Any]:
    phase = "setup"
    try:
        if family not in ("surf", "tides"):
            raise CollectionRefused("only fresh forecast families can be collected")
        try:
            refuse_credentials(env)
        except CollectionRefused:
            raise CollectionFailure("setup", "environment") from None
        source, root = confined_roots(source_arg, root_arg)
        phase = "source"
        producer = modules[family] if modules is not None else _load(source, family)
        root.mkdir(mode=0o700)
        phase = "fetch"
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
            requests_per_second=tide_requests_per_second,
        )
    except CollectionFailure:
        raise
    except Exception as error:
        category = "contract" if isinstance(error, CollectionRefused) else "environment" if isinstance(error, OSError) else "provider"
        raise CollectionFailure(phase, category) from None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--root", required=True)
    parser.add_argument("--family", required=True, choices=("surf", "tides"))
    parser.add_argument("--tide-requests-per-second")
    args = parser.parse_args(argv)
    try:
        if sys.version_info[:2] != (3, 12):
            raise CollectionFailure("setup", "environment")
        if args.tide_requests_per_second != "2":
            raise CollectionFailure("setup", "contract")
        result = collect(args.source, args.root, args.family,
                         tide_requests_per_second=TIDE_REQUESTS_PER_SECOND)
    except Exception as error:
        print(json.dumps(failure_receipt(args.family, error), separators=(",", ":")), file=sys.stderr)
        return 1
    print(json.dumps(success_receipt(result), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
