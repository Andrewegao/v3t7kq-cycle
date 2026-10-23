"""Print the run (YYYYMMDDHH) the pinned Atmos collector would select upstream right now.

Read-only probe for tools/component-bake-stand-aside.mjs. It calls the collector's own selector
with the arguments ops/bake-model-component.sh passes, so "newest available" means exactly what
the bake would collect:

  ecmwf  data/fetch_ecmwf.py --hours 336    latest_run(336): step 0 and step 336 .index both
                                            published (HEAD on the official AWS mirror, then
                                            data.ecmwf.int), newest of the last 12 cycles
  gfs    data/fetch.py --hours 72           pick_init(zarr, 72): core fields readable at +72 h in
                                            the dynamical.org store and the NODD +72 h .idx present
  hrrr   data/fetch_hrrr.py --hours 48      pick_init(zarr, 48): newest of the last 7 inits whose 2 m
                                            temperature and 10 m u wind are readable at +48 h in the
                                            dynamical.org 48-hour store, after the collector's own
                                            hourly lead_time assertion
  aifs   data/fetch_aifs.py --hours 360     latest_run(360): step 0 and step 360 .index both
                                            published and both steps' grib2 at least as long as
                                            their index says (HEAD on the official AWS mirror, then
                                            data.ecmwf.int), newest of the last 8 cycles

It downloads no field data and writes nothing. Any change to the selector signatures or a failed
probe exits non-zero, and the caller then lets the bake run.
"""
import inspect
import os
import sys
from pathlib import Path

ECMWF_HOURS = 336
GFS_HOURS = 72
HRRR_HOURS = 48
AIFS_HOURS = 360


def ecmwf_last_step(hours):
    # fetch_ecmwf.main(): 3-hourly to 144 h, then 6-hourly from 150 h.
    steps = list(range(0, min(hours, 144) + 1, 3))
    if hours > 144:
        steps += list(range(150, hours + 1, 6))
    return steps[-1]


def aifs_last_step(hours):
    # fetch_aifs.main(): a flat 6-hourly grid, capped at 360 h.
    return list(range(0, min(hours, 360) + 1, 6))[-1]


def require_parameters(function, names):
    actual = list(inspect.signature(function).parameters)
    if actual != names:
        raise SystemExit(f"collector selector signature changed: {function.__name__}{tuple(actual)}")


def main(argv):
    if len(argv) != 3 or argv[1] not in ("ecmwf", "gfs", "hrrr", "aifs"):
        raise SystemExit("usage: component-upstream-probe.py ecmwf|gfs|hrrr|aifs ATMOS_ROOT")
    model, root = argv[1], Path(argv[2]).resolve()
    data = root / "data"
    os.chdir(data)
    sys.path.insert(0, str(data))
    if model == "ecmwf":
        import fetch_ecmwf
        require_parameters(fetch_ecmwf.latest_run, ["last_step", "start", "short_last_step"])
        init = fetch_ecmwf.latest_run(ecmwf_last_step(ECMWF_HOURS))
    elif model == "hrrr":
        import fetch_hrrr
        import numpy as np
        import zarr
        require_parameters(fetch_hrrr.pick_init, ["g", "hours", "want"])
        g = zarr.open_group(fetch_hrrr.STORE, mode="r")
        # fetch_hrrr.main() asserts this before pick_init; a store that fails it fails the bake too.
        lead = g["lead_time"][: HRRR_HOURS + 1]
        if not (lead == np.arange(HRRR_HOURS + 1) * 3600).all():
            raise SystemExit("lead_time not hourly")
        _, init = fetch_hrrr.pick_init(g, HRRR_HOURS)
    elif model == "aifs":
        import fetch_aifs
        require_parameters(fetch_aifs.latest_run, ["last_step", "start"])
        init = fetch_aifs.latest_run(aifs_last_step(AIFS_HOURS))
    else:
        import fetch
        import zarr
        require_parameters(fetch.pick_init, ["g", "hours", "start"])
        _, init = fetch.pick_init(zarr.open_group(fetch.STORE, mode="r"), GFS_HOURS)
    print(init.strftime("%Y%m%d%H"))


if __name__ == "__main__":
    main(sys.argv)
