#!/usr/bin/env python3
"""Run only the reviewed Atmos point-candidate entry points under Python isolated mode."""

from __future__ import annotations

import importlib.abc
import importlib.util
import runpy
import sys
from pathlib import Path


ALLOWED = {
    "data/augment_ecmwf_wind100.py",
    "data/fetch.py",
    "data/fetch_ecmwf.py",
    "data/build_point_series.py",
}
LOCAL_MODULES = {
    "bake_model_inputs",
    "build_bricks",
    "build_point_series",
    "fetch_ecmwf",
    "health_snapshot",
    "hrrr_point",
    "native_wind100",
}


class ReviewedAtmosModules(importlib.abc.MetaPathFinder):
    """Resolve only the explicitly reviewed sibling modules, never all of data/."""

    def __init__(self, source: Path) -> None:
        self.source = source

    def find_spec(self, fullname: str, path: object = None, target: object = None):
        del path, target
        if fullname not in LOCAL_MODULES:
            return None
        requested = (self.source / "data" / f"{fullname}.py").absolute()
        module = requested.resolve(strict=True)
        stat = module.stat()
        if module != requested or module.parent != self.source / "data" or not module.is_file() or stat.st_nlink != 1:
            raise ImportError("invalid reviewed Atmos module")
        return importlib.util.spec_from_file_location(fullname, module)


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("usage: staging-wind100-python.py SOURCE_ROOT SCRIPT [ARG ...]")
    source = Path(sys.argv[1]).resolve(strict=True)
    relative = sys.argv[2]
    if relative not in ALLOWED:
        raise SystemExit("unapproved Atmos entry point")
    requested = (source / relative).absolute()
    script = requested.resolve(strict=True)
    stat = script.stat()
    if script != requested or script.parent != source / "data" or not script.is_file() or stat.st_nlink != 1:
        raise SystemExit("invalid Atmos entry point")
    # -I intentionally removes the script directory. A narrow finder restores
    # only the source-closure modules required by the reviewed entry points, so
    # an unrelated sibling such as data/json.py cannot shadow a trusted import.
    sys.meta_path.insert(0, ReviewedAtmosModules(source))
    sys.argv = [str(script), *sys.argv[3:]]
    runpy.run_path(str(script), run_name="__main__")


if __name__ == "__main__":
    main()
