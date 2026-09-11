#!/usr/bin/env python3
"""Exercise the pinned Atmos map closure across the staging Wind100 checkout split.

Synthetic tiny grids only: this test performs no provider, storage, or serving calls.
"""

from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch


CYCLE = Path(__file__).resolve().parent.parent
GRID = {
    "lon0": 100.0, "lat0": 30.0, "lonStep": 0.25, "latStep": -0.25,
    "width": 2, "height": 2, "wrapLongitude": False,
}
INIT = "2026-09-04T12:00:00Z"
OLDER = "2026-09-04T00:00:00Z"
INVOCATION = "34563442326-1"


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_artifact(source):
    policy = json.loads((CYCLE / "tools/staging-wind100-policy.json").read_text())
    expected_source = policy["sourceSha"]
    require(source.is_dir() and not source.is_symlink(), "Atmos source must be a real directory")
    require(subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True,
    ).strip() == expected_source, "Atmos source differs from the reviewed Wind100 pin")
    module_path = source / "ops/core_model_artifact.py"
    require(module_path.is_file() and not module_path.is_symlink(), "core artifact module is unsafe")
    require(digest(module_path) == policy["sourceClosure"]["ops/core_model_artifact.py"],
            "core artifact module differs from the reviewed closure")
    spec = importlib.util.spec_from_file_location("wind100_core_artifact", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, expected_source


def write_map(artifact, root, init, *, enriched=False):
    from PIL import Image

    instant = datetime.fromisoformat(init.replace("Z", "+00:00"))
    run_id = instant.strftime("%Y%m%d%H")
    model = root / "app/public/data/ecmwf"
    run = model / f"runs/{run_id}"
    variables = {
        "temp": {"file": "temp/{i}.png", "channels": ["t"], "units": "C", "range": [0, 10]},
    }
    if enriched:
        variables["gh925"] = {
            "file": "gh925/{i}.png", "channels": ["gh"], "units": "gpm",
            "range": [0, 10], "level_hPa": 925,
        }
    artifact.write_json(run / "manifest.json", {
        "schemaVersion": 1, "model": "ecmwf", "init_time": init,
        "grid": {"width": 2, "height": 2, "lon0": 100, "lon1": 100.25,
                 "lat0": 30, "lat1": 29.75},
        "variables": variables,
        "frames": [{"i": i, "valid_time": (instant + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M:%SZ")}
                   for i in (0, 1)],
    })
    for field in variables:
        for i in (0, 1):
            path = run / field / f"{i:03d}.png"
            path.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGBA", (2, 2)).save(path)
    artifact.write_json(model / "index.json", {
        "schemaVersion": 1, "model": "ecmwf",
        "runs": [{"init_time": init, "path": f"runs/{run_id}/"}],
    })
    return model, run


def add_raw_stages(artifact, root):
    import numpy as np

    fields = {name: np.ones((2, 2, 2), dtype=np.float32)
              for name in artifact.points.REQUIRED_STORAGE}
    artifact.points.write_stage(
        "ecmwf", root / "data/.ecmwf-point", run="20260904/12z", steps=[0, 1],
        fields=fields, grid=GRID,
    )
    floats = root / "data/.ecmwf-float"
    artifact.write_json(floats / "meta.json", {
        "run": "20260904/12z", "model": "ecmwf", "steps": [0, 1], "grid": [2, 2],
        "window": [30, 29.75, 100, 100.25],
    })
    artifact.write_json(floats / "gustwin.json", {"0": {"hours": 0}, "1": {"hours": 1}})
    for field in artifact.FLOAT_FIELDS:
        np.save(floats / f"{field}.npy", np.ones((2, 2, 2), dtype=np.float32))


def main():
    require(len(sys.argv) == 2, "usage: staging-wind100-core-flow.py ATMOS_SOURCE")
    source_argument = Path(sys.argv[1]).absolute()
    source_checkout = source_argument.resolve(strict=True)
    require(source_argument == source_checkout and not source_argument.is_symlink(),
            "Atmos source path must not traverse a symlink")
    artifact, source_sha = load_artifact(source_checkout)
    artifact.STEPS = {**artifact.STEPS, "ecmwf": [0, 1]}
    artifact.points.GLOBAL_GRID = GRID
    artifact.maps.NATIVE_REQUIRED_MODELS = frozenset()

    with tempfile.TemporaryDirectory(prefix="weatherx-wind100-core-flow-") as temporary:
        root = Path(temporary)
        producer, validator, packs = root / "producer", root / "validator", root / "packs"
        producer.mkdir(); validator.mkdir()

        # Reproduce the failed topology: a previously enriched same-cycle tree is
        # refreshed with a surface-only manifest while enrichment files remain.
        baseline, current = write_map(artifact, validator, INIT, enriched=True)
        enriched_manifest = artifact.read_json(current / "manifest.json")
        artifact.map_tree(baseline, "ecmwf")
        refreshed_manifest = {**enriched_manifest,
                              "variables": {"temp": enriched_manifest["variables"]["temp"]}}
        artifact.write_json(current / "manifest.json", refreshed_manifest)
        try:
            artifact.map_tree(baseline, "ecmwf")
        except ValueError as error:
            require("missing or unreferenced files" in str(error), "wrong same-cycle refusal")
        else:
            raise AssertionError("same-cycle enrichment surplus unexpectedly passed map closure")

        # The repaired topology keeps provider output clean, seals that one run,
        # and lets the existing transactional installer merge only older exact history.
        artifact.write_json(current / "manifest.json", enriched_manifest)
        fresh_map, _ = write_map(artifact, producer, INIT)
        add_raw_stages(artifact, producer)
        artifact.seal("ecmwf", source_sha, producer, packs, INVOCATION)
        older_model, _ = write_map(artifact, validator, OLDER)
        old_row = artifact.read_json(older_model / "index.json")["runs"][0]
        artifact.write_json(baseline / "index.json", {
            "schemaVersion": 1, "model": "ecmwf",
            "runs": [{"init_time": INIT, "path": "runs/2026090412/"}, old_row],
        })
        artifact.map_tree(baseline, "ecmwf")
        manifest_hash = artifact.digest(packs / "ecmwf/manifest.json")
        with patch.object(artifact, "assert_checkout_source"):
            artifact.install_component(
                "ecmwf", source_sha, validator, packs, INVOCATION, manifest_hash,
                clock=lambda: datetime(2026, 9, 4, 13, tzinfo=timezone.utc),
            )
        result, _ = artifact.map_tree(validator / "app/public/data/ecmwf", "ecmwf")
        require([row["path"] for row in result["runs"]] ==
                ["runs/2026090412/", "runs/2026090400/"], "installer did not retain two exact runs")
        require(not (validator / "app/public/data/ecmwf/runs/2026090412/gh925").exists(),
                "same-run hydrated enrichment leaked into the fresh manifest")
        require((validator / "app/public/data/ecmwf/runs/2026090400/temp/000.png").is_file(),
                "older referenced history was not retained")
        require(artifact.inventory(fresh_map / "runs/2026090412") == artifact.inventory(
            validator / "app/public/data/ecmwf/runs/2026090412"
        ), "fresh same-run bytes changed during install")

    print("staging Wind100 core checkout split: same-run surplus refused; clean seal/install exact")


if __name__ == "__main__":
    main()
