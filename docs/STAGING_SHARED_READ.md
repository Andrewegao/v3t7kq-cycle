# Staging shares the production data release, read-only

Status: design reviewed against measured evidence and implemented behind configuration
(2026-09-04). Nothing here has been dispatched or deployed. No production variable, bucket,
token or pointer changes in either repository; every production-touching step below is an
owner action listed in the runbook.

Owner's words: "for staging, we should share the same data pipeline as prod".

## The problem, measured

On 2026-09-04 04:52 UTC production served release `cycle-33814346540`, catalog
`83-0d83357f-…`, ECMWF point run `2026090312`. At the same moment staging served release
`cycle-33787533759`, catalog `40-staging-33813643628-1`, ECMWF point run `2026090300` with
`freshUntil 2026-09-04T06:00Z`: one full cycle behind and about an hour from going stale.
Staging data is a one-shot copy: discovery (`staging-current-selection.yml`) → owner sets
`STAGING_DATA_APPROVED_SELECTION_SHA256` → preparation (`staging-data.yml`, ~6.9 GB copied
on a 90-minute runner) → owner sets `STAGING_DATA_APPROVED_RECEIPT_SHA256` → activation
(`staging-data-activate.yml`). Production publishes four times a day; nobody runs that chain
four times a day, so staging degrades within hours of every activation.

## Options

### (a) Staging edge reads production storage read-only and follows `releases/current.json`

Two sub-variants exist and they are not equivalent:

- **(a1) R2 bucket binding.** Wrangler's `r2_buckets` binding has exactly four fields
  (`binding`, `bucket_name`, `jurisdiction`, `preview_bucket_name`); there is no read-only or
  permission option ([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)).
  A binding to `weatherx-data-production` gives the staging Worker `put`, `delete` and `list`
  on production. Write isolation would rest on staging code never calling them, i.e. on review
  of a Worker that exists precisely to run unqualified candidates.
- **(a2) Read-only S3 credential (recommended).** The bucket-scoped **Object Read** credential
  `SHARED_R2_READ_*` already exists, was provisioned with approval on 2026-08-31, and was
  proven: reads pass in its two production buckets, both cross-environment reads return 403
  (`CLOUD-STAGING.md`). The staging Worker signs `GET`/`HEAD` requests (AWS SigV4, WebCrypto,
  no dependency) against `https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`. Cloudflare,
  not staging code, refuses every write. No production bucket is bound at all, so a bindings
  audit of the staging Worker stays "staging buckets only".

Freshness: staging follows the production pointers with the existing 30 s pointer cache, so it
is never more than 30 s behind production and there is no per-cycle chain at all. An optional
staging-owned pin (`shared-read/pin.json` in `weatherx-data-staging`) freezes staging on one
already-published production release/catalog for canary tests; it expires by itself.

### (b) Production bake writes a second copy for staging automatically

The bake would need staging write credentials next to production ones on the same runner,
which `UI-STAGING-PROMOTION.md` and `tests/ui-approval-boundary.mjs` deliberately forbid
(`bake.yml` has an explicit credential allowlist). It doubles class-A operations and storage on
every cycle, adds 60 to 90 minutes of copying to a lane that must finish before the next cycle,
and still leaves staging pointers to be moved by something. It also couples a staging failure
(quota, throttling, a full bucket) to production publication. Rejected.

### (c) PR #113 (`STAGING_FRESHNESS.md`, Track A)

Track A keeps the copy and automates it: a scheduled follower runs discovery, preparation and
activation in one job 40 minutes after each bake, replacing the two owner hashes with Actions
API checks and a coherence gate. It is a sound design for the copy model, but the copy model is
the cost: every cycle copies ~6.9 GB (class-A puts for ~10k objects, 40 GiB/100k-object
inventory limits, a 90-minute runner that has already timed out once, run `33410167126`),
storage grows by a full snapshot per cycle because writes are immutable and there is no delete
lane, and staging is still 40 to 130 minutes behind production by construction. Track B
(signed regional selections without a UI rebuild) is orthogonal to this decision and remains
valuable; nothing here conflicts with it.

### Comparison

| | (a2) shared read, read-only S3 | (a1) R2 binding | (b) bake copies | (c) PR #113 Track A |
| --- | --- | --- | --- | --- |
| Write isolation | Credential-level: Object Read only, 403 on writes, proven; no production binding; module has no put/delete/list surface | Code-level only; binding has full access | Bake runner holds staging write next to production write | Same as today: staging write credential in staging lanes only |
| Freshness | ≤ 30 s behind production; no per-cycle work | same | one bake ≈ 60 to 90 min | 40 to 130 min behind, one job per cycle |
| R2 storage | none added (production already stores every release) | none | +6.9 GB per cycle, never deleted | +6.9 GB per cycle, never deleted |
| Class A ops | none | none | ~10k puts per cycle | ~10k puts per cycle |
| Class B ops | staging reads hit production buckets (staging traffic is tiny; $0.36 per million) | same | none extra | none extra |
| Egress | free (R2 to Workers and S3 API) | free | free | free |
| Owner steps per cycle | none | none | none | none once enabled |
| Staging-only experiments | layered lookup, own buckets first | same | needs the copy lanes unchanged | unchanged |
| Blast radius of a bad production release | staging shows it too (see below) | same | after the next copy | after the next follow run |

R2 prices used: storage $0.015/GB-month, class A $4.50 per million, class B $0.36 per million,
egress free ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)).

### Blast radius: a bad production release is also on staging

Yes, and that is the point of a staging environment that shares the pipeline: staging exists to
qualify **UI and edge code** against the real data contract, not to qualify data. Data is
qualified by the production publishers (component gates, point validators, release receipts),
and production already serves it to users the moment it is current; hiding it from staging only
delays the discovery. Two things protect staging tests that need a stable input:

- the canary pin: `shared-read/pin.json` freezes staging on one release/catalog for up to 48
  hours from the controller (7 days hard limit in the Worker), so a qualification run sees one
  identity from start to finish; production releases are immutable and never deleted, so a pin
  cannot dangle;
- the follow probe (`staging-shared-read-probe.yml`) fails loudly when staging and production
  disagree, when a point run is stale, or when the Worker is in shared mode without its
  credential.

What must not happen is the reverse: staging must never be able to make production bad. That is
the credential boundary above.

### What breaks and how it is kept working

Staging-only components (the seven regional model selections, future point models) live in
`weatherx-components-staging` under catalogs `catalogs/snapshots/stage-<model>-…` in
`weatherx-data-staging`, and the UI addresses them as `/data/_catalog/<catalog-id>/<model>/…`.
The edge now resolves a pinned catalog in **layers**: the Worker's own staging buckets first,
then the shared production release. Objects are always read from the layer that produced the
catalog; a snapshot never borrows objects from another layer, so the existing
"missing model in a staging catalog returns 404" rule is unchanged. The current pointers and
whole-release objects come from production only; staging's own `releases/current.json`,
`catalogs/current.json` and copied releases are simply ignored in shared mode.

## Recommendation

**(a2).** It is the only option whose write-isolation guarantee is enforced by Cloudflare rather
than by code review, it removes the per-cycle chain entirely, it costs nothing in storage or
class-A operations, and it keeps every staging-only experiment path working through the
layered lookup. PR #113's Track A should be closed in favour of this; its Track B (signed
regional selections) is unaffected and can proceed separately.

## What was implemented

Atmos (branch `codex/staging-shared-read-20260903`, PR against `master`, edge only):

- `platform/edge/src/sharedRead.ts`: SigV4 read-only S3 bucket (`get`/`head` only; the test
  scans the source for any mutating operation), `ReadBucket` type that data serving must use,
  layered `DataSources`, pin resolution.
- `data.ts`, `pointSeries.ts`, `catalog.ts`: pointer/catalog/object resolution through
  `DataSources`; `X-WeatherX-Data-Source: own|shared` on every data and point response;
  pinned-release pointers derived from the immutable manifest; fail closed on refused or missing
  credentials (`503 release_unavailable` / `503 shared_read_unconfigured`, never a fallback to
  stale copies).
- `index.ts`: staging `/api/platform/data-health` adds `dataSource`, `sharedReadConfigured`,
  `pin`, `sharedRead.{dataBucket,componentBucket,pinKey}` without touching production storage.
- `wrangler.jsonc` staging env: `DATA_SOURCE_MODE=shared`, `SHARED_READ_ACCOUNT_ID`,
  `SHARED_READ_DATA_BUCKET`, `SHARED_READ_COMPONENT_BUCKET`, `SHARED_READ_PIN_KEY`, and the two
  required secrets `SHARED_READ_ACCESS_KEY_ID` / `SHARED_READ_SECRET_ACCESS_KEY`. `r2_buckets`
  is unchanged (staging buckets only). `local` and `production` carry none of these;
  `scripts/verify-config.mjs` locks that shape. 412 edge tests green, including the AWS SigV4
  `get-vanilla` reference vector.

Cycle (this PR):

- `tools/staging-shared-read.mjs`: `config` (audit an Atmos `wrangler.jsonc` for the shared-read
  shape), `probe` (read production current pointers with `SHARED_R2_READ_*`, read what staging
  serves through public headers, assert they match or match the active pin), `pin`/`unpin`
  (compare-and-swap on `shared-read/pin.json` with staging write credentials only).
- `staging-shared-read-probe.yml` (dispatch, plus a half-hourly schedule gated by
  `STAGING_SHARED_READ_PROBE_ENABLED`; read credential only) and `staging-shared-read-pin.yml`
  (manual, `STAGING_SHARED_READ_PIN_ENABLED`, staging write credential only).
- `tools/staging-consumer.mjs`: the guarded staging Worker refresh admits exactly one more
  delta on top of the public-mode pair: the shared-read variables and the two read secrets,
  and only when the reviewed configuration declares them. A production bucket binding is
  refused in configuration and in live bindings.
- `tools/staging-s3.mjs`: `shared-read/pin.json` is the only new writable key.
- `tools/staging-data.mjs`: staging health in shared mode must report
  `sharedReadConfigured: true`, so a Worker refresh without its secret rolls back instead of
  leaving staging dark.

## Migration runbook (every step is an owner action; order matters)

Preconditions: this PR and the Atmos PR are merged; nothing has been dispatched.

1. **Read-only credential for the Worker.** Reuse the existing `SHARED_R2_READ_*` S3 credential
   (Object Read, buckets `weatherx-data-production` + `weatherx-components-production` only) or
   mint a second one with the identical scope for the Worker so GitHub and Worker copies can be
   rotated independently. Re-run the 2026-08-31 proof: a read in each production bucket
   succeeds, a `PutObject` and a read of `weatherx-data-staging` return 403.
2. **Worker secrets (staging only).** From the merged Atmos checkout:
   `npx wrangler secret put SHARED_READ_ACCESS_KEY_ID --env staging` and
   `npx wrangler secret put SHARED_READ_SECRET_ACCESS_KEY --env staging`.
   Secrets must exist before the version upload; the guarded refresh compares the uploaded
   version's bindings with the reviewed configuration and refuses activation if either secret
   binding is missing. Nothing is deployed by this step.
3. **Pin the guarded refresh to the merged Atmos SHA.** Update `SOURCE_SHA` in
   `tools/staging-consumer.mjs` (`tools/staging-live-proof.mjs` imports it) and the
   `ref:`/`STAGING_CONSUMER_SOURCE_SHA` pair in `staging-consumer-refresh.yml`, in a reviewed
   cycle PR. Run `node cycle/tools/staging-shared-read.mjs config control/platform/edge/wrangler.jsonc`
   in that PR's CI against the pinned checkout.
4. **Preflight, then refresh.** Dispatch `staging-consumer-refresh.yml` with
   `CONFIRM=REFRESH-STAGING-CONSUMER`; approve `STAGING_CONSUMER_APPROVED_VERSION` and
   `STAGING_CONSUMER_APPROVED_SETTINGS_SHA256` from its preflight receipt. The lane uploads an
   inactive version, checks bindings equal the reviewed configuration (public-mode pair plus
   the shared-read delta, no production binding), activates, probes health three times, and
   restores the previous version on any failure. Health must now show
   `dataSource: "shared"`, `sharedReadConfigured: true`.
5. **Prove the follow.** Dispatch `staging-shared-read-probe.yml`. It must report staging
   serving exactly production's current release and catalog with
   `X-WeatherX-Data-Source: shared` and fresh point series. Then set
   `STAGING_SHARED_READ_PROBE_ENABLED=true` on `data-staging` for the half-hourly schedule.
6. **Enable canary pins when needed.** Set `STAGING_SHARED_READ_PIN_ENABLED=true`; dispatch
   `staging-shared-read-pin.yml` with `action=pin`, a production release and/or catalog id and
   a lifetime (1 to 48 h). The probe then verifies the pin instead of current. `action=unpin`
   releases it early; expiry releases it otherwise.
7. **Re-qualify the staging UI once** (`ui-staging.yml`) so `scripts/staging-eleven.mjs` and the
   regional model browser prove that `_catalog/stage-…` reads still resolve from the own layer
   and production layers serve the rest.

Rollback to the copy lanes (any time, no data loss): dispatch `staging-consumer-refresh.yml`
against the previous pinned SHA (or `wrangler versions deploy <previous-version>@100% --env staging`
from the owner's shell). The Worker then reads its own buckets again, where the last activated
copy still is, unchanged. Nothing in production needs to be restored because nothing in
production was changed.

## What the existing copy lanes become

- `staging-current-selection.yml`, `staging-data.yml`, `staging-data-activate.yml`: **retired
  from routine use.** They remain in the repository, disabled by their existing variables, as
  the rollback path above and as the only way to seed staging's own buckets should a
  staging-only experiment ever need a whole-release copy. They are not needed for canary pins:
  pins reference production's immutable releases directly.
- `staging-model-components.yml`, `staging-model-selection.yml`: unchanged; they write
  staging-only catalogs that the layered read finds first.
- `staging-consumer-refresh.yml`: unchanged in shape, now also the vehicle for the shared-read
  configuration delta.
- PR #113: Track A superseded by this design; Track B still open.

## Open decisions for the owner

1. Reuse `SHARED_R2_READ_*` for the Worker or mint a dedicated Object Read credential
   (recommended: dedicated, same scope, independent rotation).
2. Keep the copy lanes as a documented rollback path (recommended) or delete them after one
   month of green probes.
3. Whether the probe's schedule (every 30 minutes) should page anyone, or stay a receipt.
4. Pin lifetime ceiling: 48 h in the controller, 7 days in the Worker. Lower either if canaries
   never need it.
