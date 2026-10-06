# Observation and fire component refresh

[`observation-refresh.yml`](../.github/workflows/observation-refresh.yml) refreshes the five served observation components — `obs-metar`, `obs-synop`, `obs-buoys`, `obs-openaq` and `obs-fires` — every 30 minutes (`14,44 * * * *` UTC). It has no dependency on any model collector, so a GFS (or any model) failure can no longer stop airport weather, ground stations, buoys, air quality or fires from refreshing. The [manual recovery](five-feed-recovery-20261006.md) runs the same refresh job (byte-identical apart from `FIVE_FEED_MODE`, enforced by `tests/five-feed-recovery.mjs`) behind its literal confirmation. It is a copy rather than a reusable-workflow call so that no `scheduler/` contract file changes: any `scheduler/` change redeploys the scheduler Worker on merge.

## Modes

| Mode | Caller | Admission | Publication |
| --- | --- | --- | --- |
| `scheduled` | this workflow's schedule, or a dispatch of it with the literal `RECOVER FIVE OBSERVATION FEEDS` | each family independently | every admitted family in one CAS `promote-set`; refused families keep their served component |
| `recovery` | [`five-feed-recovery.yml`](../.github/workflows/five-feed-recovery.yml) dispatched with `RECOVER FIVE OBSERVATION FEEDS` | all five or nothing | all five in one CAS `promote-set` |

The controller binds each mode to exactly one caller workflow ref and event set before any credential is used (`FIVE_FEED_MODE`, `GITHUB_EVENT_NAME`, `GITHUB_WORKFLOW_REF`). Both modes keep the unchanged guarantees of the five-feed controller: exact pinned producers, fixed per-family producer deadlines (METAR 3 min, SYNOP 7, buoys 7, OpenAQ 15, fires 5; 22 min overall), byte/row bounds, current-record admission, immutable staging with `PROMOTE=0`, authenticated predecessor/rollback-epoch CAS, release-pointer stability, the 31 s catalog-cache settle and hash readback of every public alias on both origins. In scheduled mode the successor check additionally requires every non-admitted `obs-*` component to be unchanged.

Scheduled readback runs while the hourly component bake and the whole bake keep promoting unrelated models and releases. It therefore accepts unrelated catalog sequence advances and a new whole release during readback, and proves only what this lane owns: each admitted `obs-*` entry is exactly this run's candidate, each refused family's entry is unchanged, and the rollback epoch is unchanged; every snapshot re-runs the whole-release mount-shadow preflight. Manual recovery keeps the strict rule (exactly one successor, unchanged release pointer, unchanged catalog through readback). A `promotion-requested-not-accepted` result is still a real acceptance failure; the next scheduled run collects afresh and compare-and-swaps against the current predecessors rather than repeating the old request, but inspect the retained intent first.

## Lock

The refresh job uses `weatherx-observation-components-production` (cancel-in-progress false), shared by every `obs-*` writer. It deliberately does not use `weatherx-data-maintenance`: GitHub keeps one pending job per concurrency group and cancels the older pending job, so a 30-minute schedule in the maintenance group would cancel the whole bake's queued maintenance job. Whole maintenance never promotes `obs-*` components (it publishes the whole release through `promote-release`, a separate pointer); a concurrent release-pointer or target change makes the observation lane refuse rather than overwrite.

## Plan job

The `plan` job has no environment, lock or secret (it reads the Actions API with `actions: read`). In order it:

- refuses a manual dispatch without the literal confirmation (red, nothing refreshed);
- lists jobs holding `weatherx-observation-components-production` (this lane's `refresh`, the recovery's `recover`) and turns red when one has waited at the production environment gate for more than 30 minutes, measured from that deployment's `waiting` status rather than from when the job queued behind the lock — the owner must cancel that run;
- reports `SKIPPED` when `OBSERVATION_REFRESH_ENABLED` is not `true`;
- reports `SKIPPED` while a `five-feed-recovery.yml` run is queued, pending, waiting or in progress, so the schedule cannot cancel it. If the Actions API is unavailable it notes that and refreshes anyway.

Before dispatching a manual recovery, set `OBSERVATION_REFRESH_ENABLED` to anything but `true` (and restore it afterwards); that closes the remaining race between the plan check and the refresh job.

## Verdict and receipts

`tools/observation-summary.mjs` runs after publication (always) and writes the step summary: each family's outcome (refreshed, refused with stage/code, admitted-not-published, promotion-requested-not-accepted, not-collected), newest-record age, bake age and current/total records. For fires it lists retained versus current-24 h detections in the legacy, detail and overview views and the missing satellite feeds; when fires are not refreshed it states the served fire bake's age. The step fails unless all five families were refreshed and accepted, so a partially refreshed run is red even though the admitted families were published. A run with the schedule disabled writes `Observation refresh: SKIPPED`.

The public artifact `five-feed-acceptance-<run>-<attempt>` keeps `acceptance.json`, `observation-receipt.json`, `observation-refresh-v1.json` (the same verdict in Atmos's `weatherx-observation-refresh-v1` shape), the public promotion intent/result and `collection-outcomes.json`. When the pinned Atmos source contains `ops/report-refresh.py`, the lane also renders the shared Atmos refresh table with `--strict`; until then the controller verdict is the only report.

## Source pin

Every ordinary production producer runs the one Atmos commit declared in [`ops/atmos-production-source.json`](../ops/atmos-production-source.json). Workflow checkouts keep literal refs; `node tools/atmos-source-pin.mjs --check` proves every listed literal equals the declaration and that every other 40-hex value in workflows and tools is classified (another qualified Atmos pin in its listed files, or a known non-Atmos hash; `uses:` action pins excepted), so a new pin site cannot appear unnoticed; add `--atmos-repo <atmos clone>` to also prove the classification against Atmos history, and `node tools/atmos-source-pin.mjs --set <sha>` moves all of them together. The five-feed tools and the staging Wind100 policy check read the declaration directly.

Moving the pin always requires these protected values to change at the same time as the merge (setting them earlier refuses current main; later refuses the new main):

- `production` environment variable `CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA` = the new declared SHA (model publishers and this lane).
- `data-staging` environment variable `STAGING_WIND100_CONTROLLER_SHA256` = `node -e "import('./tools/staging-wind100.mjs').then(m=>console.log(m.controllerDigest()))"` at the merged commit (the policy's `coreSourceSha` is in that digest).
- `data-production-wind100` variables `PRODUCTION_WIND100_CONTROLLER_SHA256` and `PRODUCTION_WIND100_GC_READY_SHA256` = the production controller digest, only when that disabled lane is enabled (its digest also covers `bake.yml`).

## Owner controls

- Repository variable `OBSERVATION_REFRESH_ENABLED=true` turns the schedule on; any other value reports SKIPPED.
- The `production` environment currently has only a protected-branch policy (no required reviewers, no wait timer), so scheduled runs do not wait for approval. If reviewers are ever added, every scheduled run will wait for approval while holding this lane's lock; exempt the schedule or approve runs. Nothing in this repository bypasses an approval.
- GitHub may delay or drop scheduled events. Only a real run proves timing; the external scheduler can dispatch this workflow in a later, separately reviewed change.
