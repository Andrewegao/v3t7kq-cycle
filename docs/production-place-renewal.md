# Production place renewal (tides)

[`production-place-renewal.yml`](../.github/workflows/production-place-renewal.yml) renews production NOAA CO-OPS tide predictions once a day. Controller: [`tools/production-place-renewal.mjs`](../tools/production-place-renewal.mjs); policy: [`tools/production-place-renewal-policy.json`](../tools/production-place-renewal-policy.json); tests: [`tests/production-place-renewal.mjs`](../tests/production-place-renewal.mjs). It closes audit finding P-1 / F1 (2026-10-10): `https://weatherx.org/data-atmos/tides/tides.json` was baked 2026-08-08 21:10Z, its predictions ended 2026-08-09, `/data-atmos/tides/v2/catalog.json` was 404, and no production lane renewed tides. The stale file rode along in every whole-data release (header `X-WeatherX-Release: cycle-38008209877` on 10-10); the whole bake's own tide step has not landed a newer file since August.

## What production reads, and where this lane writes

The production data Worker (Atmos `platform/edge/src/dataEdge.ts` → `servePrivateData` in `data.ts`, env `production-serve`, `DATA_CATALOG_MODE=serve`) resolves `/data-atmos/<path>` in this order:

1. the active catalog (`catalogs/current.json`): the component whose mount is the longest prefix of the path serves `components/<id>/<artifact>/<rest>` (response header `X-WeatherX-Catalog`). The five observation components and the energy components already reach production this way;
2. otherwise the whole release (`releases/current.json` → `releases/<id>/<path>`, header `X-WeatherX-Release`).

The staging pointer the staging lane activates (`shared-read/places-tides.json`) is read only by `resolveStagingPlace`, which returns nothing unless the origin is `https://staging.weatherx.org`. Production therefore cannot use the staging pointer without an Atmos Worker change and deploy. Instead this lane publishes one immutable catalog component:

| | |
| --- | --- |
| Component | `places-tides` |
| Mount | `data-atmos/tides/` |
| Objects | `tides.json` (legacy reader), `v2/catalog.json`, `v2/versions/<dataset>/stations/<id>/window.json`, `v2/versions/<dataset>/availability-<sha>.json` |
| Bucket / prefix | `weatherx-components-production` / `components/places-tides/places-tides-<YYYYMMDDTHHMMSSZ>-<run>-<attempt>/` |

Those are exactly the URLs the production app reads: `app/src/tides/data.ts` loads `/data-atmos/tides/v2/catalog.json` and its station windows, and falls back to `/data-atmos/tides/tides.json` (production UI `34efee01d959`, 2026-10-09, and Atmos master). The candidate directory the staging collector produces already has this layout, so the component is the qualified candidate tree, byte for byte. Once the component is active, the whole release's `data-atmos/tides/tides.json` is shadowed (longest mount wins); a later whole bake that does refresh its own copy changes nothing that is served.

Only tides are served on production. `/data/surf/index.json`, `/data/paragliding/index.json` and `/data-atmos/{surf,paragliding}/` are 404 on weatherx.org; surf needs a six-hourly renewal and paragliding an encrypted reviewed seed. Adding either is a product decision, and the policy refuses any family but `tides`.

## Steps and safety, next to the staging lane

| Property | Staging (`staging-place-renewal.yml`) | Production (this lane) |
| --- | --- | --- |
| Reviewed code | `STAGING_PLACES_RENEWAL_CONTROLLER_SHA256` over the staging closure | `PRODUCTION_PLACES_RENEWAL_CONTROLLER_SHA256` over the production closure: this workflow, its policy and controller, and every staging module it imports (`staging-place-renewal.mjs`, `staging-place-collect.py`, `staging-place-python`, `staging-places*.mjs`, `shared-data.mjs`, `staging-places-requirements.txt`). The staging closure and digest are unchanged |
| Reviewed source | `STAGING_PLACES_RENEWAL_ATMOS_SHA` = policy `sourceSha` | `PRODUCTION_PLACES_RENEWAL_ATMOS_SHA` = policy `sourceSha` (today the same `681deba659e7faa9600e25e3ec7f578e0fcb5511`, the 1,260-station roster) |
| Collection | pinned NOAA collector, 2 requests/s, roster 1,260, minimum 1,255 | the same collector and contract, run from the same function (`staging-place-collect.py`), no storage or catalog credential in the step |
| Qualification | Atmos `app/e2e/qualify-staging-places.mjs`, digest `f0a1e29b…c663`, producer/consumer/coverage/roster receipt | the same qualifier, digest and receipt (`runRuntimeProof`) |
| Immutable publication | S3 `If-None-Match: *` per object, readback per object | Atmos publisher `ops/platform/publish-r2-component.sh` at the declared production pin with `PROMOTE=0`: `rclone copy --immutable`, `rclone check --download` (byte readback), object count, then `component.json` immutable |
| Staged readback | completion and manifest digests | the staged `component.json` is read back from R2: its digest, id, artifact, mount, generation time, object count and inventory digest (recomputed locally with Atmos's traversal, cross-checked against `build-component-manifest.mjs`) must match, and the inventory must equal the qualified candidate exactly |
| Conditional activation | pointer `If-Match` CAS | signed `promote` on `/api/platform/internal/catalog` with `expectedPreviousManifestSha256` (null on the first publication) and `expectedRollbackEpoch`; the controller refuses an older `generationTime` before any upload (Atmos master's catalog refuses it too). The precondition is checked before upload and the freshness again after it. A failed or uncertain promotion is never retried: the catalog readback decides |
| Never roll back | newer identity and freshness required | the served component's generation time must not be newer; the tide identity (`noaa-coops-<UTC>`) and the catalog's `retrievedAt` are bound |
| Lease | pointer `expiresAt` ≤ 24 h; the staging Worker answers 503 after it | none: catalog components have no lease and the production Worker has no lease reader. Substitutes: publication requires at least 6 h of the seven-day window (checked before upload and right before promotion); the app refuses expired coverage itself (`TidePredictionCoverageError`, shown as stale, never as a current prediction); daily renewal. A hard lease is an Atmos Worker change (follow-up) |
| Nothing else hidden | n/a | the precondition refuses if any other component claims `data-atmos/tides/` or a deeper mount, or if the whole release holds anything under `data-atmos/tides/` other than tide files of the same grammar (for example EOT20 model tides) |
| Live readback | staging origin, `X-WeatherX-Release: places-<id>` | `https://weatherx.org`: v2 catalog, `tides.json`, one station window and the availability report, each 200, `X-WeatherX-Catalog` (one snapshot id), no `X-WeatherX-Release`, `X-WeatherX-Data-Source: own`, `nosniff`, JSON, exact bytes and SHA-256; reads retried up to 12 × 15 s for the 30 s catalog cache |
| Environment and lock | `data-staging`, group `weatherx-staging-publication` | `production` (protected branches: only `main`), group `weatherx-places-production`. R2 and catalog credentials exist only in the publish step's environment; every other step's gate refuses them |

The places-tides component and the observation components never overlap (`data-atmos/tides/` against `data-atmos/stations/`, `synop/`, `buoys/`, `openaq/`, `fires/`), so neither lane's mount preflight refuses the other. Like a model promotion, a tides promotion during a manual five-feed recovery's readback makes that recovery's strict single-successor check red; scheduled observation runs accept unrelated catalog advances.

## Cadence and trigger

Decision: daily, dispatched by the scheduler Worker at `52 9 * * *` with `caller=scheduler`, and two GitHub-native fallback slots (`52 9,21 * * *`).

- Horizon. A collection covers the day before through about 8.8 days ahead (10-10 04:30Z collection: event coverage ends 10-18 08:06–23:58Z). The full seven-day window (`sourceExpiresAt`) lasts about 1.5 days, and the legacy `tides.json` lists only the next few events (10-10 collection: last events 10-10 12:41Z to 10-12 02:55Z). Weekly renewal would leave the legacy reader expired for five days a week and the seven-day view short for most of the week; daily keeps the v2 look-ahead between about 7.8 and 8.8 days and the legacy file current.
- Cost. One renewal is about 31 minutes of hosted runner time (staging's tides job, 31 of 75 minutes); this repository is public. About 2,520 NOAA requests at 2 requests/s, at 09:52 UTC, away from staging's `47 5,17` tide slots.
- Trigger. GitHub fired 59–68 % of this repository's daily-class schedules over 10-03→10-10, a median 2.5–4.6 hours late (audit §2.1), so the Worker is the clock (#421). Its dedupe stands aside when a run of this workflow is already queued or running in the slot. In the workflow, the plan job reads the public v2 catalog without a credential and stands aside (green) for the schedule and for `caller=scheduler` when production already serves a dataset retrieved in the last 20 hours (`renewAfterHours`). A late or second fallback is therefore a 20-second no-op, and a dropped Worker tick is covered by the 21:52 fallback. A person's dispatch (no `caller`) always renews.
- The scheduler dispatch obeys `PRODUCTION_PLACES_RENEWAL_ENABLED` exactly like the schedule (job `if`), so the Worker can be released before the lane is enabled without red runs. The Worker is released by hand (`scheduler-deploy.yml` plan, then release); until that release the GitHub fallback slots are the only trigger.

## Release guards

Atmos `ops/release/verify-platform-production.sh` probes `/data-atmos/tides/tides.json` by default and requires `X-WeatherX-Release`. Once `places-tides` serves that path the header is `X-WeatherX-Catalog`, so every production UI release (`tools/ui-release.mjs`) and platform Worker release (`tools/platform-worker-production-release.mjs`) would fail its guard. Both now pass `EDGE_DATA_PROBE_PATH=/data-atmos/airports/airports.json` (release-served on both origins, as staging has done since #394/#408). `tools/ui-release.mjs` is a UI policy file: a UI candidate staged before this merges must be staged again (`release policy changed: stage again`). Atmos's own `deploy-code-only.sh` and `deploy-production-shell.sh` keep the tides default; nothing in this repository runs them.

## Owner setup

No new secret. Existing secrets used: repository `ATMOS_DEPLOY_KEY`, `R2_PRODUCTION_ACCESS_KEY_ID`, `R2_PRODUCTION_SECRET_ACCESS_KEY`, `CATALOG_PROMOTION_KEY_PRODUCTION`; existing `production` variable `CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA` (must equal the workflow's publisher pin, as for every production publisher).

| Variable | Scope | Value |
| --- | --- | --- |
| `PRODUCTION_PLACES_RENEWAL_ATMOS_SHA` | environment `production` | `681deba659e7faa9600e25e3ec7f578e0fcb5511` (policy `sourceSha`) |
| `PRODUCTION_PLACES_RENEWAL_CONTROLLER_SHA256` | environment `production` | `node tools/production-place-renewal.mjs digest` at the merged commit |
| `PRODUCTION_PLACES_RENEWAL_ENABLED` | repository (the job `if` reads it) | `true` turns the schedule on; a dispatch also needs it |

First run after the variables exist: `gh workflow run production-place-renewal.yml -R Andrewegao/v3t7kq-cycle --ref main -f family=tides`.

The controller digest covers the workflow, whose publisher pin moves with every `node tools/atmos-source-pin.mjs --set`. While this lane is enabled, every pin move also needs `PRODUCTION_PLACES_RENEWAL_CONTROLLER_SHA256` re-attested at the merged commit (like the Wind100 digests), and any change to the imported staging modules needs both the staging and the production digest re-attested.

## Verify

```sh
curl -sI https://weatherx.org/data-atmos/tides/tides.json | grep -i '^x-weatherx'
# x-weatherx-catalog: <catalog id>, x-weatherx-data-source: own, and no x-weatherx-release
curl -s https://weatherx.org/data-atmos/tides/tides.json | python3 -c 'import json,sys; d=json.load(sys.stdin); e=[s["series"][-1]["t"] for s in d["stations"]]; print(d["baked_at"], len(d["stations"]), min(e), max(e))'
curl -s https://weatherx.org/data-atmos/tides/v2/catalog.json | python3 -c 'import json,sys,datetime as D; d=json.load(sys.stdin); t=lambda ms: D.datetime.fromtimestamp(ms/1000, D.timezone.utc).isoformat(); c=[s["eventCoverage"]["endMs"] for s in d["stations"]]; print(d["datasetId"], d["retrievedAt"], len(d["stations"]), t(min(c)), t(max(c)))'
```

Expected after a successful run: `baked_at` and `retrievedAt` within the last day, about 1,255 v2 stations, event coverage ending about 8–9 days after `retrievedAt`, and legacy last events about 1–2 days ahead. The run's step summary names the dataset, the new manifest key and the catalog transition (`predecessor -> new`).

## Stop and roll back

- Stop renewing: set `PRODUCTION_PLACES_RENEWAL_ENABLED` to anything but `true`. The served component stays; the app marks it stale when its coverage ends.
- Bad dataset: fix forward with another dispatch (a newer collection replaces it). A normal promotion cannot re-promote an older artifact (`component_generation_regressed`).
- Back to the whole release's file: there is no per-component removal; a catalog rollback to the predecessor catalog id (printed by the run, `predecessorCatalogId`) removes `places-tides` together with every later catalog change. Use the existing procedure (`submit-catalog-mutation.mjs rollback <endpoint> <catalogId> <expectedCurrentCatalogId>`); first disable this lane and `OBSERVATION_REFRESH_ENABLED`, which otherwise republish within a day and within 30 minutes.

## Known limits

- The availability report is the pinned producer's staging-partial policy output and is labelled `"scope": "staging-only"` inside the public file (the app reads only the catalog's summary of it). The production pin's producer has a stricter `--allow-no-predictions` policy (only NOAA's explicit "no predictions" may be missing); moving to it needs collector support and a new reviewed `sourceSha`.
- Each renewal stores about 130 MB (1,255 station windows of about 100 kB plus a 2.9 MB catalog) under `components/places-tides/`; like the observation components, nothing prunes superseded artifacts.
- The whole bake still runs its own tide step (`ops/bake-weatherx.sh`, a shared 1,800 s budget); its output is shadowed once this lane has published. Why it has not landed a newer file since August is not visible in the job log and is not investigated here.
