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


def populate_partial_upperair(artifact, model, init):
    instant = datetime.fromisoformat(init.replace("Z", "+00:00"))
    run = model / f"runs/{instant.strftime('%Y%m%d%H')}"
    manifest = artifact.read_json(run / "manifest.json")
    manifest["frames"] = [
        {"i": i, "valid_time": (instant + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M:%SZ")}
        for i in range(81)
    ]
    artifact.write_json(run / "manifest.json", manifest)
    png = (run / "temp/000.png").read_bytes()
    for i in range(2, 81):
        (run / f"temp/{i:03d}.png").write_bytes(png)
    for field in ("gh925", "gh850", "gh500", "wind925", "wind850", "wind500"):
        (run / field).mkdir()
        for i in range(69):
            (run / field / f"{i:03d}.png").write_bytes(png)
    return run


def attest_component_baseline(artifact, root, proof_root):
    model = root / "app/public/data/ecmwf"
    rows = artifact.inventory(model)
    generation = artifact.read_json(model / "index.json")["runs"][0]["init_time"]
    generated = datetime.fromisoformat(generation.replace("Z", "+00:00"))
    artifact_id = f"ecmwf-{generated.strftime('%Y%m%d%H')}-component"
    root_prefix = f"components/ecmwf/{artifact_id}/"
    component = proof_root / "component.json"
    artifact.write_json(component, {
        "schemaVersion": 1, "componentId": "ecmwf", "artifactId": artifact_id,
        "generationTime": generation,
        "completedAt": (generated + timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "rootPrefix": root_prefix, "mounts": ["data/ecmwf/"],
        "objectCount": len(rows),
        "inventorySha256": hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest(),
        "quality": {"status": "passed", "checks": [
            "manifest", "inventory", "remote_bytes", "coverage", "freshness",
            "live_superset", "horizon", "cadence", "grid", "referenced_bytes",
        ]},
    })
    component_entry = {
        **artifact.read_json(component),
        "manifestKey": f"{root_prefix}component.json",
        "manifestSha256": artifact.digest(component),
    }
    catalog = proof_root / "catalog.json"
    published = (generated + timedelta(minutes=6)).strftime("%Y-%m-%dT%H:%M:%SZ")
    artifact.write_json(catalog, {
        "schemaVersion": 2, "sequence": 7, "parentCatalogId": "6-previous",
        "createdAt": published, "components": {"ecmwf": component_entry},
    })
    pointer = proof_root / "pointer.json"
    artifact.write_json(pointer, {
        "schemaVersion": 2, "catalogId": "7-component-baseline", "sequence": 7,
        "publishedAt": published, "catalogSha256": artifact.digest(catalog),
        "previousCatalogId": "6-previous",
    })
    return pointer, catalog, component


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

        # Mirror the populated staging baseline that failed after collection:
        # referenced map history plus 414 unadvertised partial upper-air frames.
        baseline, _ = write_map(artifact, validator, OLDER)
        retained = populate_partial_upperair(artifact, baseline, OLDER)
        try:
            artifact.map_tree(baseline, "ecmwf")
        except ValueError as error:
            require("missing or unreferenced files" in str(error), "wrong populated-baseline refusal")
        else:
            raise AssertionError("partial upper-air baseline unexpectedly passed strict map closure")

        proof_root = root / "baseline-proof"
        proof_root.mkdir()
        pointer, catalog, component = attest_component_baseline(artifact, validator, proof_root)
        proof = artifact.verify_component_baseline("ecmwf", validator, pointer, catalog, component)
        require(proof["normalizableExtraCount"] == 414, "preflight did not identify exact partial baseline")
        require(proof["publicationAuthorized"] is False, "baseline preflight authorized publication")

        # Provider output remains clean and sealed. Without the three authenticated
        # catalog proofs the installer still refuses the populated baseline.
        fresh_map, _ = write_map(artifact, producer, INIT)
        add_raw_stages(artifact, producer)
        artifact.seal("ecmwf", source_sha, producer, packs, INVOCATION)
        manifest_hash = artifact.digest(packs / "ecmwf/manifest.json")
        with patch.object(artifact, "assert_checkout_source"):
            try:
                artifact.install_component(
                    "ecmwf", source_sha, validator, packs, INVOCATION, manifest_hash,
                    clock=lambda: datetime(2026, 9, 4, 13, tzinfo=timezone.utc),
                )
            except ValueError as error:
                require("missing or unreferenced files" in str(error), "no-proof refusal changed")
            else:
                raise AssertionError("populated baseline installed without authentication")
            before = {p.relative_to(retained).as_posix(): p.read_bytes()
                      for p in retained.rglob("*") if p.is_file()}
            receipt = root / "normalization.json"
            artifact.install_component(
                "ecmwf", source_sha, validator, packs, INVOCATION, manifest_hash,
                clock=lambda: datetime(2026, 9, 4, 13, tzinfo=timezone.utc),
                baseline_catalog_pointer=pointer,
                baseline_catalog_snapshot=catalog,
                baseline_component_manifest=component,
                normalization_receipt=receipt,
            )
        result, _ = artifact.map_tree(validator / "app/public/data/ecmwf", "ecmwf")
        require([row["path"] for row in result["runs"]] ==
                ["runs/2026090412/", "runs/2026090400/"], "installer did not retain two exact runs")
        after = {p.relative_to(retained).as_posix(): p.read_bytes()
                 for p in retained.rglob("*") if p.is_file()}
        require(after == {name: value for name, value in before.items()
                          if name == "manifest.json" or name.startswith("temp/")},
                "normalization changed referenced history or retained partial extras")
        normalization = artifact.read_json(receipt)
        require(normalization["omittedCount"] == 414 and normalization["publicationAuthorized"] is False,
                "normalization receipt did not bind exact omitted inventory")
        require((validator / "app/public/data/ecmwf/runs/2026090400/temp/000.png").is_file(),
                "older referenced history was not retained")
        require(artifact.inventory(fresh_map / "runs/2026090412") == artifact.inventory(
            validator / "app/public/data/ecmwf/runs/2026090412"
        ), "fresh same-run bytes changed during install")

    print("staging Wind100 core checkout split: populated baseline authenticated; clean seal/install exact")


if __name__ == "__main__":
    main()
