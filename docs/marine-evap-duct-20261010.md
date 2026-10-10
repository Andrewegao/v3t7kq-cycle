# 大气波导 (evaporation duct height) reaches the GFS bake through the producer pin

Owner, 2026-10-10: 「在系统的海洋图层里，加上大气波导输出」. The producer and the map layer live in
atmos (`data/add_evapduct.py`, design and measurements in
`docs/engineering/tasks/WX-MARINE-EVAP-DUCT-20261010.md` there). This repository needs **no workflow,
secret or schedule change** for it: `core (gfs)` already runs atmos `data/enrich_gfs.sh` at the
declared producer SHA, and that script gains one step (`add_evapduct.py`, right after
`add_sst.py`). `docs/WORKFLOWS.md` was regenerated and is byte-identical.

What the step adds to a GFS run, measured on 2026100918: one manifest variable `evapduct`
(73 gray+alpha PNGs, 32.3 MB per run, 0–40 m), 146 bounded NODD byte ranges (~80 MB) for raw
`TMP:2 m above ground` and `TMP:surface`, 22 s of CPU and 414 MB peak RSS. It is an optional
enrichment (atmos `OPTIONAL_GFS_VARS`), so a miss logs a FAIL line and the strict component gate
decides, exactly as for `sst`.

## Owner steps, in order

1. Merge the atmos PR. Note the resulting master SHA (call it `S`).
2. In this repository: `node tools/atmos-source-pin.mjs --set S`, rewrite `atmosSubject` in
   `ops/atmos-production-source.json` to account for every atmos master change between the current
   pin `4ca4efd69bdd2b235de5ccd9a68e3bc74ef82a88` and `S` (the span carries more than this layer),
   then `node --test tests/atmos-source-pin.mjs`. Open as a PR; squash-merge.
3. Set the environment variable `production/CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA` to `S`
   (the declaration's `approvalVariables`).
4. Wait for the next scheduled `bake.yml`, or dispatch it with `model: gfs`. In the `core (gfs)` log
   look for `OK: baked evapduct into <run> (73 frames)` and per-frame sea medians of roughly
   13–14 m; then confirm `https://weatherx.org/data/gfs/runs/<run>/manifest.json` lists
   `evapduct`. Staging reads the same production release (`docs/STAGING_SHARED_READ.md`).
5. Merge atmos branch `feat/marine-evap-duct-enable-20261010` (removes the `NOT_YET_REAL` gate), then
   release the UI as usual (`ui-release.yml`; staging follows master).

Rollback, read before step 2: once one published GFS run carries `evapduct`, the component gate
(atmos `ops/platform/validate-model-component.py`, `compare_live`) refuses any later GFS candidate
without it, as it does for `sst`. Moving the pin back to a SHA without the producer would therefore
withhold every GFS publish until a run with `evapduct` is live again. Roll forward instead (fix in
atmos, move the pin), or add `evapduct` to a retirement path in atmos first. A single failed
`add_evapduct.py` run likewise withholds that one GFS cycle; the previous run stays live.
