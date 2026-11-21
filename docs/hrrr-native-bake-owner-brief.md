# HRRR native 3 km points: bake branch owner brief

Branch `feat/hrrr-native-bake`. Do not merge it while `ops/atmos-production-source.json` still
declares the placeholder `deadbeefdeadbeefdeadbeefdeadbeefdeadbeef`: every pinned checkout would
fail (`test "$(git rev-parse HEAD)" = "deadbeef..."`). Facts below come from this repository and
Atmos at the time of writing; 待考 marks what code alone cannot settle.

## What the branch changes

- `collect-core-model.yml`, `catalog-bake.yml` (staging and production) and
  `publish-current-model-production.yml` pass `WEATHERX_HRRR_NATIVE_POINT` for `hrrr` only, from
  the repository variables `WEATHERX_HRRR_NATIVE_POINT` and `WEATHERX_HRRR_NATIVE_POINT_STAGING`.
  Unset means `0`: nothing native is collected, sealed or published.
- `publish-current-model-production.yml`: the model's status comes only from its own log lines;
  the standalone `point-hrrr-native` lane is reported as `native_status` and never changes the
  HRRR job's result.
- Cost files: only the native lane writes one (`NATIVE_POINT_PUBLISH_METRICS_DIR`,
  `point-hrrr-native.json`). `COMPONENT_PUBLISH_METRICS_DIR` stays unset, so the cost writer in
  Atmos `ops/platform/publish-r2-component.sh` stays off for every map and 0.25 degree point
  publication, as on main.
- Component retention: `hrrr-native` is in `windowOnlyModels`. Outside the 168 h window an
  unreferenced `point-hrrr-native` root is a delete candidate (`historyCopy: null`); `hrrr` and
  `point-hrrr` keep one copy of every run as before.
- `tools/component-bake-stand-aside.mjs`: a note that re-reviewing `HRRR_REVIEWED_ATMOS_SHA` for a
  pin carrying the native lane must first add `point-hrrr-native` to `decide()`.

## What replacing the placeholder does

`node tools/atmos-source-pin.mjs --set <merged atmos master sha>` moves every declared pin site
together (`bake.yml`, `collect-core-model.yml`, `collect-regional-model.yml`,
`publish-current-model-production.yml`, `observation-refresh.yml`, `five-feed-recovery.yml`,
`staging-wind100-recurring.yml`, `production-wind100-recurring.yml`, `glofas-ingest.yml`,
`cams-ingest.yml`, `production-place-renewal.yml`, `catalog-bake.yml`, and `coreSourceSha` in both
Wind100 policies). Today's pin is `30a211be7692868f36380b809cd9b2bb01011e6a`. Atmos master
`9097613b8c` is 497 commits (79 first-parent) past it, with 63 files changed under `data/` and
`ops/`, among them `ops/bake-model-component.sh`, `data/fetch.py` and `data/fetch_hrrr.py`
(`ops/platform/publish-r2-component.sh` and `ops/core_model_artifact.py` on master are
byte-identical to the pin). The feature branch adds more on top. A full review of what every
pinned lane executes at the new SHA has not been done (待考); the declaration's `atmosSubject` must
carry that review before merge.

Stand-asides at a new pin (from the code):

- `tools/component-bake-stand-aside.mjs` (`catalog-bake.yml`): the HRRR and AIFS checks require
  the checkout to be `HRRR_REVIEWED_ATMOS_SHA` / `AIFS_REVIEWED_ATMOS_SHA` (`30a211be`), so both
  switch off. The ECMWF and GFS checks keep only the collector-call text guard; the branch's
  `ops/bake-model-component.sh` still contains all four `COLLECTOR_CALLS` and all
  `SAME_RUN_GUARDS` lines, so ECMWF and GFS stay eligible. With the check off, the HRRR and AIFS
  lanes hydrate and collect on every tick; the pinned bake still uploads only when the run id
  moves (it prints `unchanged` and exits for a served run), so the cost is runner time, not R2
  writes (待考: exact minutes per tick).
- `tools/current-run-publisher-stand-aside.mjs` (the ECMWF publisher behind `bake.yml`): it
  requires `REVIEWED_ATMOS_SHA` (`30a211be`) for both the checkout and the slow lane's pin, so it
  switches off. Its header says that without it the publisher rebuilds the viewport-native
  sidecars and re-uploads the whole ECMWF map component (about 10.5 k objects) for a run production
  already serves, on every whole-bake run, until the constant is re-reviewed and moved.
- One-time re-bake: `DEFINITION_PATHS` (`catalog-bake.yml`, `tools/component-bake-stand-aside.mjs`,
  `tools/component-upstream-probe.py`) changed in this branch, so every served ECMWF/GFS/HRRR/AIFS
  component that completed before the merge commit re-bakes once on its next tick.

## Variables that must change in the same step as the merge

Setting them earlier makes current main refuse; later makes the new main refuse
(`docs/observation-refresh.md`, Source pin).

1. `production` environment `CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA` = the new declared SHA.
2. `production` environment `CURRENT_RUN_CATALOG_BAKE_ATMOS_SHA` = the new declared SHA.
3. `data-production-components-cleanup` `PRODUCTION_COMPONENTS_GC_CONTROLLER_SHA256` =
   `7326949da697f6da22aa750af2d65c8806f2a3a2798c363aedc900a369f6780e` (this branch's
   `controllerDigest()`; main's is `95d5deb8d5e12227fe8677a2ef72f27673c625bb436a404f4cb3221ba610d4c7`).
   It does not depend on the Atmos pin. The retention and scope-preflight workflows refuse to run
   until it matches.

Also per `docs/observation-refresh.md`, for each of these lanes that is enabled (which ones are
enabled today: 待考, the doc says production and staging Wind100 were on at 2026-10-20), recompute
at the merged commit and set at the same time: `STAGING_WIND100_CONTROLLER_SHA256`,
`PRODUCTION_WIND100_CONTROLLER_SHA256`, `PRODUCTION_WIND100_GC_READY_SHA256`,
`PRODUCTION_WIND100_GC_CONTROLLER_SHA256`, `PRODUCTION_PLACES_RENEWAL_CONTROLLER_SHA256`. Their
values exist only after `--set`, so they are not listed here.

## Ordered steps

1. Atmos `feat/hrrr-native-points` merges to master with every flag off; note the merge SHA `S`.
2. Deploy the catalog readers first (Atmos `docs/platform/HRRR_NATIVE_POINT_ROLLOUT.md`): staging
   platform Worker, then production platform Worker, data Worker and fusion-learning canary.
3. On this branch: `node tools/atmos-source-pin.mjs --set S`, write the reviewed `atmosSubject`,
   run `node tools/atmos-source-pin.mjs --check` and the scheduler CI; the three tests that pin
   `30a211be` (`tests/atmos-source-pin.mjs` 1, `tests/component-bake-stand-aside.mjs` 14 and 22)
   must then be updated to the new review (待考: whether to re-review and move
   `HRRR_REVIEWED_ATMOS_SHA`, `AIFS_REVIEWED_ATMOS_SHA` and `REVIEWED_ATMOS_SHA` now, which would
   need `point-hrrr-native` in `decide()` first).
4. Merge, and in the same step set the three variables above (and any enabled Wind100 or
   place-renewal digests).
5. Staging: `WEATHERX_HRRR_NATIVE_POINT_STAGING=1`, check the Front Range pair on staging.
6. Production: `WEATHERX_HRRR_NATIVE_POINT=1` only after the retention digest is set (step 4).
7. Client `VITE_HRRR_NATIVE_POINT=1` through the Atmos release.

## Rollback

- Native only: set `WEATHERX_HRRR_NATIVE_POINT` (and `_STAGING`) to `0`. The last native run stays
  in the catalog until withdrawn; retention deletes unreferenced native roots outside 168 h.
- Whole branch: revert the merge (or `--set 30a211be7692868f36380b809cd9b2bb01011e6a`), and in the
  same step set `CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA` and `CURRENT_RUN_CATALOG_BAKE_ATMOS_SHA`
  back to `30a211be7692868f36380b809cd9b2bb01011e6a`, `PRODUCTION_COMPONENTS_GC_CONTROLLER_SHA256`
  back to `95d5deb8d5e12227fe8677a2ef72f27673c625bb436a404f4cb3221ba610d4c7`, and any Wind100 or
  place-renewal digest back to its pre-merge value. Main's retention policy does not list `hrrr-native`
  in `models`, so its `scopedRoot()` leaves every `point-hrrr-native` root out of scope (counted as
  non-canonical, never deleted): native runs then accumulate until they are removed by hand or the
  branch returns.
- Before rolling back any catalog reader Worker, withdraw `point-hrrr-native` from that catalog
  first (Atmos rollout doc, Rollback).

## Not done in this branch

The joined bake (`bake.yml`, step "receive sealed core model inputs") still downloads and unzips
the whole HRRR artifact, native stage included (up to about 1.31 GB). `download-artifact` selects
whole artifacts, and Atmos `ops/core_model_artifact.py install` checks the native rows by path
and size against the sealed manifest, so a narrower download pattern alone would fail the install.
Skipping it needs: Atmos `seal` writing the native stage as its own pack with its own manifest;
`collect-core-model.yml` uploading it as a separate artifact (for example
`core-native-packs-hrrr`); the HRRR publish lane downloading both; and `install` no longer
expecting native rows in the HRRR manifest.
