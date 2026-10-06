#!/usr/bin/env python3
"""Pinned native collection and strict five-family admission. No storage/publication credentials."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

SOURCE = "5e68af94c24517eaaaf6a9d25aec0cadc3d9b135"
FAMILIES = {
    "metar": ("stations/", "metar.json", 6 * 1024**2, 25000, 180),
    "synop": ("synop/", "stations.json", 6 * 1024**2, 30000, 420),
    "buoys": ("buoys/", "stations.json", 4 * 1024**2, 20000, 420),
    "openaq": ("openaq/", "stations.json", 8 * 1024**2, 30000, 900),
    "fires": ("fires/", "fires.json", 32 * 1024**2, 400000, 300),
}
MAX_TOTAL = 256 * 1024**2
MAX_FILES = 655
THIN_RULE = "brightest detections (highest FRP) kept to stay under the app\'s per-file size limit"


class AdmissionError(ValueError):
    """Only fixed controller-authored codes may enter the public outcome receipt."""


def require(value, reason):
    if not value:
        raise AdmissionError(reason)


def stamp(value):
    require(isinstance(value, str), "timestamp-required")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.tzinfo is not None, "utc-timestamp-required")
    return parsed.astimezone(timezone.utc)


def json_file(path, cap):
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= cap, "object-byte-bound")
    value = json.loads(path.read_bytes(), parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite-json")))
    require(isinstance(value, dict), "object-schema")
    return value


def inventory(root):
    require(root.is_dir() and not root.is_symlink(), "real-output-directory")
    result = []
    total = 0
    for p in sorted(root.rglob("*")):
        require(not p.is_symlink(), "linked-output")
        if p.is_dir():
            continue
        require(p.is_file() and len(result) < MAX_FILES, "output-file-bound")
        size = p.stat().st_size
        require(0 < size and total + size <= MAX_TOTAL, "output-total-bound")
        digest = hashlib.sha256()
        read = 0
        with p.open("rb") as stream:
            while block := stream.read(1024 * 1024):
                read += len(block)
                require(read <= size, "output-changed-during-inventory")
                digest.update(block)
        require(read == size, "output-changed-during-inventory")
        total += size
        result.append(dict(path=str(p.relative_to(root)), size=size, sha256=digest.hexdigest()))
    require(result and sum(r["size"] for r in result) <= MAX_TOTAL, "output-total-bound")
    return result


def age_minutes(value, now):
    return (now - stamp(value)).total_seconds() / 60


def validate_family(family, root, started, now):
    _, filename, cap, row_cap, _ = FAMILIES[family]
    doc = json_file(root / filename, cap)
    baked = stamp(doc.get("baked_at"))
    require(started.replace(microsecond=0) <= baked <= now and age_minutes(doc["baked_at"], now) <= 60,
            "old-or-future-bake")
    require(isinstance(doc.get("source"), str) and doc["source"], "source-label-required")
    rows = doc.get("fires" if family == "fires" else "stations")
    require(isinstance(rows, list) and 0 < len(rows) <= row_cap, "nonempty-row-bound")
    fresh = 0
    fresh_readings = 0
    for row in rows:
        require(isinstance(row, dict), "record-schema")
        require(all(isinstance(row.get(k), (int, float)) and not isinstance(row[k], bool)
                    and math.isfinite(row[k]) for k in ("lat", "lon")), "record-coordinate")
        require(-90 <= row["lat"] <= 90 and -180 <= row["lon"] <= 180, "record-coordinate")
        age = age_minutes(row.get("acq" if family == "fires" else "obs_time"), now)
        maximum = {"metar": 90, "synop": 360, "openaq": 180, "fires": 1440}.get(family)
        if family == "buoys":
            require(row.get("src") in ("ndbc", "dwd"), "buoy-source")
            maximum = 90 if row["src"] == "ndbc" else 180
        require(age >= -15, "future-record")
        fresh += age <= maximum
        if family == "openaq":
            require(doc.get("freshness", {}).get("max_age_min") == 180 and row.get("lic") in
                    doc.get("license", {}).get("allowed", []), "openaq-license-freshness")
            require(isinstance(row.get("v"), dict) and row["v"], "openaq-empty-readings")
            elapsed = age_minutes(doc["baked_at"], now)
            for pair in row["v"].values():
                require(isinstance(pair, list) and len(pair) == 2 and all(
                    isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in pair)
                    and pair[0] >= 0 and 0 <= pair[1] <= 180, "openaq-reading-schema")
                fresh_readings += pair[1] + elapsed <= 180
    require(fresh > 0 and (family != "openaq" or fresh_readings > 0), "no-current-real-record")
    expected = {filename}
    missing = []
    if family == "fires":
        index = json_file(root / "index.json", 512 * 1024)
        require(index.get("schemaVersion") == 1 and index.get("cell_deg") == 10
                and index.get("tiles") == "tiles/" and index.get("overview") == "overview.json"
                and index.get("baked_at") == doc["baked_at"], "fire-index-schema")
        require(all(index.get(key) == doc.get(key) for key in ("source", "attribution", "missing_feeds")), "fire-source-label-coherence")
        cells = index.get("cells")
        require(isinstance(cells, dict) and 0 < len(cells) <= 648, "fire-cell-bound")
        total = 0
        thinned = index.get("thinned", {})
        detected = 0
        current_tiles = 0
        for key, count in cells.items():
            parts = key.split("_")
            require(len(parts) == 2 and all(p.isdigit() for p in parts) and
                    0 <= int(parts[0]) < 36 and 0 <= int(parts[1]) < 18 and
                    key == f"{int(parts[0])}_{int(parts[1])}", "fire-cell-key")
            require(type(count) is int and count > 0, "fire-cell-count")
            tile = json_file(root / "tiles" / (key + ".json"), 4 * 1024**2)
            tile_rows = tile.get("fires")
            require(tile.get("baked_at") == doc["baked_at"] and isinstance(tile_rows, list)
                    and len(tile_rows) == count, "fire-tile-coherence")
            for row in tile_rows:
                require(all(isinstance(row.get(k), (int, float)) and not isinstance(row[k], bool)
                    and math.isfinite(row[k]) for k in ("lat", "lon", "frp")) and row["frp"] >= 0,
                    "fire-tile-record")
                require(-90 <= row["lat"] <= 90 and -180 <= row["lon"] <= 180, "fire-tile-coordinate")
                cell = f"{min(35, max(0, math.floor((row['lon'] + 180) / 10)))}_{min(17, max(0, math.floor((row['lat'] + 90) / 10)))}"
                require(cell == key, "fire-tile-cell")
                require(isinstance(row.get("sat"), str), "fire-tile-satellite")
                acquisition_age = age_minutes(row.get("acq"), now)
                require(acquisition_age >= -15, "fire-tile-future")
                current_tiles += acquisition_age <= 1440
            receipt = thinned.get("cells", {}).get(key)
            require(tile.get("thinned") == receipt, "fire-tile-thinning-receipt")
            if receipt:
                require(receipt.get("kept") == count and type(receipt.get("detected")) is int
                        and receipt["detected"] >= count and receipt.get("rule") == THIN_RULE, "fire-thinning")
            detected += receipt["detected"] if receipt else count
            total += count
            expected.add("tiles/" + key + ".json")
        require(current_tiles > 0, "no-current-fire-detail")
        require(set(thinned.get("cells", {})) <= set(cells) and (not thinned or thinned.get("rule") == THIN_RULE), "fire-thinning-schema")
        require(total == index.get("total") and detected == index.get("detected_total"), "fire-total-coherence")
        legacy_thinned = doc.get("thinned")
        require((not legacy_thinned and len(rows) == detected) or (isinstance(legacy_thinned, dict)
                and legacy_thinned.get("detected") == detected and legacy_thinned.get("kept") == len(rows)
                and legacy_thinned.get("rule") == THIN_RULE), "fire-legacy-thinning-receipt")
        overview = json_file(root / "overview.json", 4 * 1024**2)
        require(all(overview.get(key) == doc.get(key) for key in ("source", "attribution", "missing_feeds")), "fire-source-label-coherence")
        overview_rows = overview.get("fires")
        require(overview.get("baked_at") == doc["baked_at"] and isinstance(overview_rows, list)
                and 0 < len(overview_rows) == index.get("overview_rows"), "fire-overview-coherence")
        require(overview.get("thinned") == thinned.get("overview"), "fire-overview-thinning-receipt")
        if thinned.get("overview"):
            require(thinned["overview"].get("kept") == len(overview_rows)
                    and type(thinned["overview"].get("detected")) is int
                    and thinned["overview"]["detected"] >= len(overview_rows) and thinned["overview"].get("rule") == THIN_RULE, "fire-overview-thinning-count")
        current_overview = 0
        for row in overview_rows:
            require(all(isinstance(row.get(k), (int, float)) and not isinstance(row[k], bool)
                    and math.isfinite(row[k]) for k in ("lat", "lon", "frp")) and row["frp"] >= 0
                    and -90 <= row["lat"] <= 90 and -180 <= row["lon"] <= 180, "fire-overview-record")
            acquisition_age = age_minutes(row.get("acq"), now)
            require(acquisition_age >= -15, "fire-overview-future")
            current_overview += acquisition_age <= 1440
            require(type(row.get("count")) is int and row["count"] > 0, "fire-overview-count")
        require(current_overview > 0, "no-current-fire-overview")
        overview_total = sum(row["count"] for row in overview_rows)
        require(overview_total <= detected and (overview_total == detected or thinned.get("overview")), "fire-overview-thinning")
        missing = index.get("missing_feeds", [])
        require(isinstance(missing, list) and all(isinstance(v, str) for v in missing), "fire-missing-feed-receipt")
        expected |= {"index.json", "overview.json"}
    files = inventory(root)
    require({r["path"] for r in files} == expected, "unexpected-or-missing-mount-file")
    result = dict(family=family, componentId="obs-" + family, mount="data-atmos/" + FAMILIES[family][0],
                generationTime=doc["baked_at"], rows=len(rows), currentRecords=fresh,
                currentReadings=fresh_readings if family == "openaq" else None, missingFeeds=missing, files=files)
    if family == "fires":
        result["fireRecords"] = {"legacy": dict(retained=len(rows), current24h=fresh),
                                 "detail": dict(retained=total, current24h=current_tiles),
                                 "overview": dict(retained=len(overview_rows), current24h=current_overview)}
    return result


def native_validate(atmos, family, path, env):
    subprocess.run([str(atmos / "data/.venv/bin/python"), str(atmos / "data" / ("fetch_" + family + ".py")),
                    "--validate", str(path)], env=env, timeout=30, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def validate_all(atmos, stage, receipt, now=None):
    now = now or datetime.now(timezone.utc)
    require(receipt.get("schemaVersion") == 1 and receipt.get("sourceSha") == SOURCE and
            set(receipt.get("families", {})) == set(FAMILIES), "all-five-source-receipt-required")
    current = {}
    for family in FAMILIES:
        expected = receipt["families"][family]
        root = stage / family
        native_validate(atmos, family, root / FAMILIES[family][1], safe_env())
        actual = validate_family(family, root, stamp(receipt["startedAt"]), now)
        require(actual["files"] == expected["files"] and actual["generationTime"] == expected["generationTime"], "collected-bytes-changed")
        current[family] = dict(rows=actual["rows"], currentRecords=actual["currentRecords"], currentReadings=actual["currentReadings"], missingFeeds=actual["missingFeeds"])
        if family == "fires":
            current[family]["fireRecords"] = actual["fireRecords"]
    return current


def safe_env():
    return {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR", "SYSTEMROOT")}


def collect(atmos, stage):
    require(not stage.exists(), "fresh-external-stage-required")
    require(not stage.resolve().is_relative_to(atmos.resolve()), "stage-outside-source-required")
    require(subprocess.check_output(["git", "-C", str(atmos), "rev-parse", "HEAD"], text=True).strip() == SOURCE, "exact-atmos-source")
    require(subprocess.run(["git", "-C", str(atmos), "diff", "--quiet", "HEAD"]).returncode == 0, "pristine-producer-source")
    started = datetime.now(timezone.utc)
    receipt = dict(schemaVersion=1, sourceSha=SOURCE, startedAt=started.isoformat(), families={})
    stage.mkdir()
    deadline = time.monotonic() + 22 * 60
    def one(family):
        directory, filename, _, _, cap = FAMILIES[family]
        env = safe_env()
        if family == "openaq":
            require(bool(os.environ.get("OPENAQ_API_KEY")), "openaq-key-required")
            env["OPENAQ_API_KEY"] = os.environ["OPENAQ_API_KEY"]
        subprocess.run([str(atmos / "data/.venv/bin/python"), str(atmos / "data" / ("fetch_" + family + ".py")), "--bake"],
                       cwd=atmos / "data", env=env, timeout=min(cap, max(1, deadline-time.monotonic())), check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        source = atmos / "app/public/data-atmos" / directory
        phases[family] = "native-schema"
        native_validate(atmos, family, source / filename, safe_env())
        phases[family] = "admission"
        row = validate_family(family, source, started, datetime.now(timezone.utc))
        phases[family] = "copy"
        shutil.copytree(source, stage / family)
        require(inventory(stage / family) == row["files"], "source-changed-during-copy")
        return row
    outcomes = {}
    phases = {family: "collect" for family in FAMILIES}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(one, family): family for family in FAMILIES}
        for future in as_completed(futures):
            family = futures[future]
            try:
                receipt["families"][family] = future.result()
                outcomes[family] = dict(status="passed")
            except Exception as error:
                code = str(error) if isinstance(error, AdmissionError) else (
                    "deadline-exceeded" if isinstance(error, subprocess.TimeoutExpired) else
                    "native-process-failed" if isinstance(error, subprocess.CalledProcessError) else "invalid-or-unavailable-output")
                outcomes[family] = dict(status="refused", stage=phases[family], code=code)
    (stage / "collection-outcomes.json").write_text(json.dumps(outcomes, sort_keys=True) + "\n")
    require(all(outcomes.get(family, {}).get("status") == "passed" for family in FAMILIES),
            "family-refused:" + ",".join(family for family in FAMILIES if outcomes.get(family, {}).get("status") != "passed"))
    validate_all(atmos, stage, receipt)
    (stage / "receipt.json").write_text(json.dumps(receipt, sort_keys=True) + "\n")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("operation", choices=("collect", "verify"));p.add_argument("atmos");p.add_argument("stage")
    args = p.parse_args();atmos=Path(args.atmos).resolve();stage=Path(args.stage).resolve()
    try:
        if args.operation == "collect": collect(atmos, stage)
        else:
            print(json.dumps(validate_all(atmos, stage, json_file(stage / "receipt.json", 1024**2)), sort_keys=True))
            return 0
        print("five-feed admission passed")
    except Exception:
        outcomes = stage / "collection-outcomes.json"
        if outcomes.is_file(): print(json.dumps(json_file(outcomes, 4096), sort_keys=True))
        print("five-feed admission refused", file=sys.stderr);return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
