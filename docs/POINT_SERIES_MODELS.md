# Point-series components for AIFS and ICON

Status: cloud-side plumbing prepared 2026-09-03. Nothing here dispatches, deploys or merges a
producer. The Atmos side (producer, publisher, edge allowlist, client) is a separate change and
is the blocker; see "Atmos prerequisites".

## How ECMWF/GFS point series reach production today

- `bake.yml` (cron 02:30/08:30/14:30/20:30 UTC) checks out Atmos at the pinned collector
  `dbc97a26…` and runs `ops/bake-weatherx.sh` → `data/bake.sh`, which builds
  `app/public/point-series/v2/{ecmwf,gfs}/<run>/chunks/<y>/<x>.bin.gz` from the int16 stages the
  two fetchers write (`--point-out data/.ecmwf-point`, `data/.gfs-point`), validates them with
  `ops/platform/validate-point-series.mjs`, and publishes them inside the immutable whole release
  as `releases/<id>/point-series/…`. The release manifest and `releases/current.json` carry
  `pointSeries.models.{ecmwf,gfs}` (`schemaVersion: 2`, WXPS1). `POINT_SERIES_REQUIRED=1` makes a
  map-only release a hard publish failure.
- The Worker resolves `/api/v1/point-series/<model>` from `pointer.pointSeries.models[model]`
  (whole-release path) unless the catalog holds a `point-<model>` component with mount
  `point-series/v2/<model>/`. Production currently serves from the whole release
  (`X-WeatherX-Release: cycle-…`); the fast lane `catalog-bake.yml` is pinned to `4e5177d9…`,
  which predates point components, so no `point-ecmwf`/`point-gfs` component exists yet.
- Measured 2026-09-03 (preparation run 33810907625): whole release 27,325 objects / 4.56 GB, of
  which `point-series/` is 8,281 objects / 1.14 GB (ECMWF 81 leads × 7 fields, GFS 73 × 8; gzip
  ≈ 47% of raw int16). Point download to the preparation runner took 36 s.

## What the pins gate

| Pin | Where | Gates | Must move for AIFS/ICON points? |
| --- | --- | --- | --- |
| `dbc97a26…` | `bake.yml` | the production collector itself | **Yes** — to an Atmos commit whose `data/bake.sh` builds `aifs`/`icon` stages; the maintenance-checkpoint producer fingerprint changes with it (first run after the move is a checkpoint miss, not a failure) |
| `dbc97a26…` | `staging-data.yml`, `staging-current-selection.yml`, `tools/shared-data.mjs`, `tools/staging-current-selection.mjs`, `tests/staging-data.mjs` | only `ops/platform/validate-point-series.mjs` is imported; it is byte-identical on master and admits 1–16 models generically | No |
| `4e5177d9…` | `staging-data-activate.yml`, `staging-consumer-refresh.yml` | the staging Worker code; its `pointSeries.ts` serves any model in the whole-release descriptor | No for the whole-release path; yes before any catalog `point-*` component may be served on staging |
| `4e5177d9…` | `catalog-bake.yml` | fast-lane component publisher without point support | Only if `point-aifs`/`point-icon` should ride the fast lane; then `POINT_SERIES_MODELS` in `platform/edge/src/catalog.ts` must include them and the data edge Worker be redeployed (`data-edge-deploy.yml`, ref master), otherwise the catalog API refuses the promotion (`component_mount_invalid`) |

## Atmos prerequisites (blockers, not in this repository)

1. `data/build_point_series.py`: `SOURCE` entries for `aifs` and `icon` (label, license review,
   `fresh_h`, `cadence_s`); keep the global 0.25° grid requirement.
2. AIFS stage: `data/fetch_aifs.py` has no `--point-out`; `data/bake_model_inputs.py` passes
   `points=False` for AIFS. Fields available from the decoded grids: 2t, 10u, 10v, tp, 2d (no gust,
   no solar, no visibility) → 5 storage fields, 61 six-hourly leads.
3. ICON stage: the maintained `data/fetch_icon.py` writes a China-window 0.25° verification
   sidecar only; `experiments/models/fetch_icon_global_layers.py` is opt-in, 0–48 h. A global
   0.25° ICON point stage is a new collection step in `collect_maintenance_inputs` (DWD open data,
   icosahedral → nearest-neighbour), plus `.icon-point` in `ops/maintenance_checkpoint.py` ROOTS.
4. `data/bake.sh`: add the stages to `point_series_inputs_ready` and `build_point_series.py
   --input`. Decide whether AIFS/ICON points are release-critical; once staging has activated a
   release carrying them, the activation non-regression check refuses a later release without them
   (`point model removed`), so they should be as required as ECMWF/GFS.
5. Client: `app/src/data/pointForecast.ts` `PointModel` is `'ecmwf' | 'gfs'`.
6. Fast lane only: `ops/bake-model-component.sh` cases, `catalog.ts` `POINT_SERIES_MODELS`.

## Cost and freshness

- AIFS: 61 leads × 5 fields ≈ 0.65 GB raw → ≈ 0.30 GB gzip, 4,141 objects per cycle.
- ICON: 6 fields (T2M, U/V10, VMAX, TOT_PREC, TD2M); 79 hourly leads (0–78 h) ≈ 0.47 GB gzip, or
  113 leads with the 3-hourly tail to 180 h ≈ 0.68 GB; 4,141 objects per cycle.
- Per cycle +0.8 to +1.0 GB and +8,282 objects; per day (4 cycles) +3.1 to +3.9 GB in
  `weatherx-data-production`, again per staging copy. Releases are immutable and no pruning
  script exists in `ops/platform`, so this accumulates until the owner prunes. Staging budgets
  (40 GiB / 100,000 objects) stay far away (≈ 5.5 GB / 35.6 k objects); preparation gains ≈ 30 s.
- Bake runtime: the AIFS stage is a transposition of arrays already decoded for the map. The
  ICON global fetch is new and unmeasured (≈ 500–700 GRIB files per cycle); `bake.yml` has a
  300-minute limit and the current bake takes ≈ 3 h 05 (20:30 cron → 23:35 `generatedAt`).
- Freshness: the 12 h / 18 h rule in `app/src/chrome/forecastModels.ts` (line 142) gates map
  manifests, not point series; the point client only refuses `quality: 'stale'`, which the Worker
  derives from the descriptor's `freshUntil` (= init + `fresh_h`). At the 20:30 bake AIFS 12Z is
  published ≈ 11.6 h old and ICON (`PUBLISH_LAG_H = 3`) also lands ≈ 11.6 h old; with
  `fresh_h = 12` both would read stale within 30 minutes of publication, with 18 there is a
  5.5 h stale gap each cycle. Use `fresh_h ≥ 24` for both. Staging copies are one-shot
  activations one cycle behind production (today 00Z vs 12Z), so the 30-minute freshness margin
  refuses activation of an AIFS/ICON-bearing release prepared too late in its window;
  `STAGING_FRESHNESS.md` (PR #113, Track A) is the structural fix.

## Owner runbook (whole-release path)

1. Atmos: merge the producer/client change; let CI and `ops/test_*` pass.
2. Cycle repo: merge this PR (contracts admit the new point models; no variable changes).
3. Cycle repo, separate PR: move the `bake.yml` collector pin to the reviewed Atmos SHA. The next
   scheduled cycle runs it; a failed gate leaves the live pointer untouched. Do not repin the
   validator/consumer pins.
4. Confirm production: `https://weatherx.org/api/v1/point-series/aifs?lat=31.2&lon=121.5&variables=temperature&start=<now>&end=<now+1d>`
   returns 200 with `quality: complete` (today: 404 `model_unavailable`); same for `icon`.
5. Dispatch `staging-current-selection.yml`; download `selection.json`; check `pointModels`
   lists `aifs`/`icon`; set `STAGING_DATA_APPROVED_SELECTION_SHA256` to `selectionSha256`.
6. Dispatch `staging-data.yml` with the four selection values while every point model's
   `freshUntil` is more than 30 minutes away; approve the `data-staging` environment.
7. Set `STAGING_DATA_APPROVED_RECEIPT_SHA256` to the prepared `receipt.json` byte hash and keep
   `STAGING_DATA_ACTIVATION_ENABLED=true`; dispatch `staging-data-activate.yml` with the same
   four values. The live proof now decodes 7 points per point model (28 with both new models).
8. Confirm `https://staging.weatherx.org/api/v1/point-series/aifs?…` and `…/icon?…`.
9. Optional fast lane later: repin `catalog-bake.yml`, redeploy the data edge Worker, extend the
   live proof to catalog-served packs, then repin the staging consumer. Until the live proof
   understands catalog point components, keep the staging consumer at `4e5177d9…`; a
   catalog-aware consumer makes the proof fail closed (`source decoder escaped selected release`).
