#!/usr/bin/env python3
"""Offline full-grid memory and byte-equivalence gate for the GFS frame writer."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import statistics
import sys
import tempfile
import threading
import time


EXPECTED_SOURCE = "0335a3b0a85b629c8659032a032bbc5ea0911eff"
EXPECTED_BASE = "48be0a6c7cef9a0c831831952cefd80ce967ad2d"


def mib(value: int) -> float:
    return round(value / 1024 / 1024, 2)


def linux_rss_bytes() -> int:
    status = Path("/proc/self/status")
    if status.exists():
        for line in status.read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) * 1024
    # macOS reports bytes; Linux reports KiB. This fallback is only for local smoke tests.
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value if sys.platform == "darwin" else value * 1024


def maximum_rss_bytes() -> int:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return value if sys.platform == "darwin" else value * 1024


def linux_available_bytes() -> int | None:
    meminfo = Path("/proc/meminfo")
    if not meminfo.exists():
        return None
    for line in meminfo.read_text().splitlines():
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) * 1024
    return None


class MemorySampler:
    def __init__(self) -> None:
        self.peak_rss = 0
        self.minimum_available: int | None = None
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self._sample, name="memory-sampler", daemon=True)

    def _sample(self) -> None:
        while not self.stop.is_set():
            self.peak_rss = max(self.peak_rss, linux_rss_bytes())
            available = linux_available_bytes()
            if available is not None:
                self.minimum_available = available if self.minimum_available is None else min(self.minimum_available, available)
            self.stop.wait(0.05)

    def __enter__(self) -> "MemorySampler":
        self.thread.start()
        return self

    def __exit__(self, *_args: object) -> None:
        self.stop.set()
        self.thread.join()
        self._sample_once()

    def _sample_once(self) -> None:
        self.peak_rss = max(self.peak_rss, linux_rss_bytes())
        available = linux_available_bytes()
        if available is not None:
            self.minimum_available = available if self.minimum_available is None else min(self.minimum_available, available)


def tree_hashes(root: Path) -> tuple[dict[str, str], int]:
    result: dict[str, str] = {}
    total = 0
    for path in sorted(root.rglob("*.png")):
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
        result[str(path.relative_to(root))] = digest.hexdigest()
        total += path.stat().st_size
    return result, total


def old_serial_frames(fetch, out: Path, values: dict) -> None:
    """Frozen pre-change loop, independent of the new bounded scheduler."""
    extra_keys = [name for name, *_ in fetch.EXTRA_FIELDS if name not in fetch.BRICK_ONLY_FIELDS]
    wave_keys = ("waves", "wwave", "swell", "wperiod", "wpower")
    names = ("wind", "temp", "gust", "mslp", *extra_keys, *wave_keys)
    for name in names:
        (out / name).mkdir(parents=True, exist_ok=True)
    for index in range(values["hours"] + 1):
        fetch.save_png(out / "wind" / f"{index:03d}.png", fetch.encode(values["u"][index], *fetch.WIND_RANGE), fetch.encode(values["v"][index], *fetch.WIND_RANGE))
        fetch.save_png(out / "temp" / f"{index:03d}.png", fetch.encode(values["t2m"][index], *values["ranges"]["temp"]))
        fetch.save_png(out / "gust" / f"{index:03d}.png", fetch.encode(values["gust"][index], *values["ranges"]["gust"]))
        fetch.save_png(out / "mslp" / f"{index:03d}.png", fetch.encode(values["mslp"][index], *values["ranges"]["mslp"]))
        for name in extra_keys:
            fetch.save_png(out / name / f"{index:03d}.png", fetch.encode(values["ex"][name][index], *values["ranges"][name]))
        for name in wave_keys:
            fetch.save_png(out / name / f"{index:03d}.png", fetch.encode(values["wave"][name][index], *values["ranges"][name]))
    for path in sorted(out.rglob("*.png")):
        bad = fetch.BAD_CHUNKS & set(fetch.png_chunk_names(path.read_bytes()))
        assert not bad, f"{path}: color chunks {bad} survived strip"


def field(shape, base, lo: float, hi: float, offset: int):
    import numpy as np

    result = np.empty(shape, dtype=np.float32)
    span = hi - lo
    for index in range(shape[0]):
        # One frame-sized temporary keeps construction bounded while touching every page.
        result[index] = lo + np.mod(base + offset * 37 + index * 17, 1009) * (span / 1008.0)
    result.flags.writeable = False
    return result


def inputs(fetch, hours: int, height: int, width: int) -> dict:
    import numpy as np

    shape = (hours + 1, height, width)
    row = np.arange(height, dtype=np.float32)[:, None] * 31
    column = np.arange(width, dtype=np.float32)[None, :] * 17
    base = np.mod(row + column, 1009)
    ranges = {"wind": list(fetch.WIND_RANGE), "temp": [-60, 60], "gust": [0, 100], "mslp": [850, 1100]}
    core = {}
    for offset, (name, range_name) in enumerate((("u", "wind"), ("v", "wind"), ("t2m", "temp"), ("gust", "gust"), ("mslp", "mslp"))):
        core[name] = field(shape, base, *ranges[range_name], offset)
    extras = {}
    for offset, (name, *_rest) in enumerate(fetch.EXTRA_FIELDS, start=len(core)):
        ranges[name] = [0, float(offset + 2)]
        extras[name] = field(shape, base, *ranges[name], offset)
    waves = {}
    for offset, name in enumerate(("waves", "wwave", "swell", "wperiod", "wpower"), start=len(core) + len(extras)):
        ranges[name] = [0, float(offset + 2)]
        waves[name] = field(shape, base, *ranges[name], offset)
    # The actual collector also retains this copy after point staging returns.
    point_gust = core["gust"].copy()
    point_gust.flags.writeable = False
    assert len(core) + len(extras) + len(waves) + 1 == 25, "production GFS resident input count changed"
    return {"hours": hours, **core, "ex": extras, "wave": waves, "ranges": ranges, "point_gust": point_gust}


def writer_values(values: dict) -> dict:
    return {name: value for name, value in values.items() if name != "point_gust"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--atmos-root", type=Path, required=True)
    parser.add_argument("--source-sha", default=EXPECTED_SOURCE)
    parser.add_argument("--hours", type=int, default=72)
    parser.add_argument("--height", type=int, default=721)
    parser.add_argument("--width", type=int, default=1440)
    parser.add_argument("--minimum-headroom-mib", type=int, default=1024)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    assert args.source_sha == EXPECTED_SOURCE, "qualification source is not the reviewed candidate"
    assert args.hours >= 1 and args.height >= 2 and args.width >= 2
    data = args.atmos_root.resolve() / "data"
    sys.path.insert(0, str(data))
    import fetch

    assert len(fetch.EXTRA_FIELDS) == 14
    started = time.monotonic()
    with MemorySampler() as memory, tempfile.TemporaryDirectory(prefix="wx-bake-qualification-") as temporary:
        root = Path(temporary)
        values = inputs(fetch, args.hours, args.height, args.width)
        resident_input_rss = linux_rss_bytes()
        timings = {"serial": [], "parallel": []}
        reference_hashes = None
        reference_bytes = None
        all_bytes_equal = True
        all_hashes_equal = True
        observed_files = 0
        for sequence, mode in enumerate(("serial", "parallel", "serial", "parallel")):
            output = root / f"{sequence}-{mode}"
            run_started = time.monotonic()
            if mode == "serial":
                old_serial_frames(fetch, output, values)
            else:
                fetch.write_run_frames(output, workers=2, **writer_values(values))
            timings[mode].append(time.monotonic() - run_started)
            hashes, byte_count = tree_hashes(output)
            observed_files = len(hashes)
            if reference_hashes is None:
                reference_hashes, reference_bytes = hashes, byte_count
            else:
                all_hashes_equal = all_hashes_equal and hashes == reference_hashes
                all_bytes_equal = all_bytes_equal and byte_count == reference_bytes
            shutil.rmtree(output)
        expected_files = (args.hours + 1) * 20
        serial_median = statistics.median(timings["serial"])
        parallel_median = statistics.median(timings["parallel"])
    minimum_available = memory.minimum_available
    gates = {
        "exactPngHashes": all_hashes_equal,
        "exactPngBytes": all_bytes_equal,
        "expectedFileCount": observed_files == expected_files,
        "repeatedSpeedImprovement": max(timings["parallel"]) < min(timings["serial"]) * 0.95,
        "runnerHeadroom": not sys.platform.startswith("linux") or (
            minimum_available is not None and minimum_available >= args.minimum_headroom_mib * 1024 * 1024
        ),
    }
    receipt = {
        "schemaVersion": 1,
        "candidateSourceSha": args.source_sha,
        "productionBaselineSha": EXPECTED_BASE,
        "published": False,
        "providerRequests": 0,
        "dimensions": {"frames": args.hours + 1, "height": args.height, "width": args.width},
        "residentFloat32Arrays": 25,
        "outputVariables": 20,
        "pngFiles": observed_files,
        "pngBytes": reference_bytes,
        "serialSeconds": [round(value, 3) for value in timings["serial"]],
        "parallelSeconds": [round(value, 3) for value in timings["parallel"]],
        "medianSpeedup": round(serial_median / parallel_median, 3),
        "residentInputRssMiB": mib(resident_input_rss),
        "peakProcessRssMiB": mib(maximum_rss_bytes()),
        "sampledPeakProcessRssMiB": mib(memory.peak_rss),
        "minimumRunnerAvailableMiB": None if minimum_available is None else mib(minimum_available),
        "minimumRequiredHeadroomMiB": args.minimum_headroom_mib,
        "treeSha256": hashlib.sha256(json.dumps(reference_hashes, sort_keys=True).encode()).hexdigest(),
        "gates": gates,
        "qualified": all(gates.values()),
        "elapsedSeconds": round(time.monotonic() - started, 3),
    }
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, indent=2, sort_keys=True), flush=True)
    failed = [name for name, passed in gates.items() if not passed]
    if failed:
        raise SystemExit("qualification failed: " + ", ".join(failed))


if __name__ == "__main__":
    main()
