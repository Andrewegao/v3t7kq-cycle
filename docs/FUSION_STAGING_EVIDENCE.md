# Isolated staging forecast evidence

This lane records prospective issuance and independently received observations only in `weatherx-fusion-archive-staging`. It never deploys Workers, changes buckets, touches a customer route, promotes calibration, or publishes an accuracy claim. `fusion-staging-evidence.yml` is a separate workflow; the existing production issuance/evaluation workflows are unchanged.

## Current audit and activation blockers

Read-only Cloudflare inspection on 2026-09-13 found the archive Worker already deployed, with active version `424d4ff2-e33b-4125-991f-06f3a621223c`, compatibility date 2026-08-30, `nodejs_compat`, the sole R2 binding `FUSION_ARCHIVE_BUCKET=weatherx-fusion-archive-staging`, and the two archive secret names. Secret values were not retrieved. A complete live routes/domain inventory and authenticated append/readback have **not** been qualified by this lane.

The Cycle staging environment has issuance/read/deploy secret names, but no staging evidence engine pin or enabled flag. No remote resources, settings, secrets, data, or workflow variables were changed.

Two source-side blockers prevent activation:

1. The current Atmos `canonicalObservationUrl` calls the WeatherX production NOAA proxy. The new workflow executes that function locally and rejects it before collection. The engine must provide direct `https://aviationweather.gov/api/data/metar` observation acquisition, with the same canonical data/provenance checks. No historical record may be relabeled as a prior issuance.
2. The existing public staging facade reads production weather buckets; the learning canary also binds production buckets. Neither is permitted in this lane. A reviewed, unrouted `weatherx-fusion-evidence-reader-staging` must use **only** `weatherx-fusion-evidence-data-staging` and `weatherx-fusion-evidence-components-staging`, with `DATA_SOURCE_MODE=own`. Those names are a required future isolation contract, not a claim that the resources exist. Populate them from independently acquired data or retained immutable test fixtures. Fixtures qualify only synthetic/replay behavior; they cannot establish live prospective evidence.

These blockers belong to Atmos/source infrastructure. This Cycle branch does not edit Atmos or provision them. Do not enable the schedule while they remain open. The current source policy check intentionally fails closed.

## Operation after qualification

Pin `FUSION_STAGING_ENGINE_SHA` to a reviewed clean 40-character Atmos commit in the staging environment. Its collector and reader must first satisfy the source constraints above. The fixed Cloudflare account, archive and reader names are not workflow inputs. Preflight reads settings, account subdomain, zones/routes and custom domains. It requires complete bounded inventories and rejects foreign bindings or customer routes. The deployment credential needs those read permissions; the job cannot infer isolation if any API read is forbidden.

Run one manual dispatch on Cycle `main`. The workflow collects all 64 frozen stations, publishes immutable issuance/observation records to the isolated archive, pulls seven days of **that archive**, and runs `score` only. The score snapshot contains the canonical forecast/observation pair references; the immutable issued records contain the values needed to reconstruct them. No refitting or accuracy publication occurs. Receipts, station completeness, pair-reference snapshot, and run/gap status are retained as GitHub artifacts for 90 days. This is a staging validation retention policy, not a permanent commercial archive promise.

A partial collection is retained but the run fails: failed stations are gaps. Every post-checkout failure records skipped/failed stage outcomes; a failure before Cycle checkout or a workflow that GitHub never starts can only be seen in Actions run history, not in an artifact. Missing cron executions therefore remain a reliability check; no continuous-history claim is allowed from this implementation alone. Empty matching snapshots are expected until forecast valid times and independent observations arrive.

After a successful real append/readback, source isolation proof and retained pair snapshot, enable only `FUSION_STAGING_EVIDENCE_ENABLED=true`. The schedule runs at 00:33, 06:33, 12:33 and 18:33 UTC. A first run does not prove long-term schedule reliability or forecast skill.

## Rollback

Set only `FUSION_STAGING_EVIDENCE_ENABLED=false`, then cancel any active `WeatherX staging forecast evidence` run. Cancellation can leave already accepted immutable records; preserve them and record the gap. Do not delete the archive, rotate keys, deploy a Worker, touch production flags, or rewind evidence timestamps. Manual dispatch remains an explicit operation and must not be invoked after rollback. No customer-facing state or calibration changes need reversal.

## Local validation

Run `node --test tests/fusion-staging-evidence.mjs tests/workflow-inventory.mjs tests/workflow-timing.mjs`, `node tools/workflow-inventory.mjs --check`, and the scheduler's existing `npm run check --prefix scheduler`. The new tests exercise isolation rejection, direct-observation boundaries, partial receipts and workflow scope. These are synthetic policy tests; no live collection or append/readback is claimed.
