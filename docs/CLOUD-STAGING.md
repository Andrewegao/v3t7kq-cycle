# Same-account shared weather data and isolated staging

## Current implementation versus activation

`staging-data.yml` prepares an immutable copy of already-published weather data on a
GitHub-hosted runner. It does **not** run collectors or meteorological processing, issue a
new forecast, move serving pointers, deploy UI, or write production storage. The original
independent staging collection draft has been removed. No local weather bake is permitted.

The account is `a89f9a1af485021fbc60a68b163c7c6e`; a second Cloudflare account is not required.
Preparation does transfer/copy bytes into staging buckets; this is not zero-transfer reuse.
Once a snapshot is prepared and activated, ordinary UI tests reuse it without another bake.

Production component updates and whole-release maintenance remain unchanged. The latter
is still responsible for observations/truth, accuracy, point-series and vault archival.
Never disable maintenance or attach a UI deployment to either bake.

## Exact shared snapshot

The manual input selects four values: whole release ID, canonical whole-manifest SHA-256,
component catalog ID and exact catalog byte SHA-256. Their canonical selection hash must
match the independently reviewed `STAGING_DATA_APPROVED_SELECTION_SHA256` environment pin.
Current production pointers must identify that selection at acquisition; later production
updates do not rewrite an in-flight immutable copy.

The controller validates both independent identities. It checks the pinned point descriptor
schema and aggregate inventory, required nonempty accuracy/ledger products, original
component gate receipts, freshness margin, model allowlist, every referenced size and
hash, and exact inventories. It uses a fixed reviewed schema validator—not candidate code.
This is byte-preserving reuse of previously published data, not a new meteorological skill
assessment, full point-pack re-decode or attestation of a collector SHA absent from upstream
receipts. New model source admission is not implied.

Only ECMWF/GFS/HRRR/AIFS components are admitted by this initial reuse lane. No weather
producer, Python dependency install, Pages token, Worker token, UI dispatch or local fallback
exists in the workflow. Synthetic local tests exercise orchestration, not weather collection.

No destination upload starts until the entire acquired snapshot passes. Transfers use
immutable-copy mode and download/readback verification. An interrupted upload can leave
inert objects, but no successful preparation receipt or new serving pointer. A repeat
refuses conflicting bytes. No sync/delete/purge operation is available.

Prepared control documents live at `staging-candidates/<selection-sha256>/`; `receipt.json`
is written last and explicitly states `collected:false`, `processed:false`, `activated:false`,
`productionWritten:false`. This is **not a live staging release receipt**.

### Transfer diagnostics and freshness

Run `33410167126` exceeded its 90-minute job limit without a preparation receipt.
Its captured subprocess output did not identify the internal stopping phase, so do not
claim a specific historical phase or infer progress from elapsed time alone.

The transfer now emits controller-owned phase labels, inventory counts/bytes, elapsed
milliseconds, and allowlisted subprocess exit/signal/timeout fields. Raw subprocess
errors and credential-bearing request metadata are never emitted. A phase-start record
can precede a long synchronous operation; it is not a percentage-complete estimate.

Inventory listings request only the fields actually checked (Path/Size/IsDir). Pinned
rclone 1.75.0 against a synthetic paginated S3 fixture demonstrates 24 unnecessary object
HEAD requests for 24 objects with default metadata, and zero with `--no-modtime` plus
`--no-mimetype`; both retain the same three listing pages and identical required fields.
This proves request amplification, not historical timing or end-to-end throughput.
Full local SHA256 inventory and immutable staging upload/download-readback are unchanged.

Freshness is rechecked against the live clock before any staging upload and before the
final receipt. A long copy cannot certify an expired selection. The independent activation
controller still performs its own freshness checks. If acquisition expires, select a newer
already-published release; do not alter timestamps, waive the margin, or blindly retry.

### Bounded bulk-transfer parallelism

Bulk acquisition/upload now uses sixteen file transfers and sixteen checkers; download
readback also uses sixteen checkers. These are fixed controller limits, not user-controlled
environment knobs. Prefixes remain sequential, and no upload starts before all acquired
source bytes validate. The existing 40 GiB / 100,000-object inventory limits, scoped S3
credentials, immutable writes, full download-readback, failure propagation, freshness checks
and receipt-last ordering are unchanged. No timeout or retry limit is increased.

`--fast-list` reduces recursive directory round trips for copy/check. This trades metadata
memory for fewer requests, not less verification. Rclone documents roughly 1 KiB per listed
object; the accepted inventory cap is therefore material to this choice. That estimate is
not a hard process-RSS bound. Sixteen file workers also increase buffering; no weather
collector or other prefix is run concurrently on this preparation runner. Multipart settings
remain unchanged. Do not increase these bounds without measuring hosted memory and timing.

`tests/shared-data-throughput.mjs` runs the exact hosted rclone 1.75.0 against loopback-only
synthetic objects with controlled request latency. It measures listing calls and actual
GET/PUT concurrency in separate one-variable arms and the combined settings. Every arm
requires identical full inventories/bytes, a readback GET for every object and rejection of
equal-size corruption. This is a mechanism test, not a Cloudflare throughput benchmark or a
promise that the 6.9 GB snapshot completes within a specific time. Small paginated trees can
even take longer with fast-list despite fewer LIST calls. Hosted transfer phase receipts
remain the end-to-end acceptance evidence.

Local independent replay on 2026-08-31 used 64 x 16 KiB objects, a 35 ms per-request
loopback delay and 12-object ListV2 pages. Baseline download/upload/readback was
821/1417/847 ms; the combined settings measured 480/430/480 ms (3.085 s to 1.390 s).
Both read every source object and read back every destination object; combined observed
GET/PUT peaks were sixteen, versus four. Source/readback LIST requests fell from 25 to 6,
including all five continuation pages. Fast-list alone measured 935/1344/920 ms: fewer
requests are not automatically lower wall time. There is deliberately no flaky timing
threshold in the test. The loopback backend's filesystem-parent concurrency limitation
and empty-parent fixture setup are documented in the test, not attributed to Cloudflare.

References: [rclone S3 listing/performance and memory tradeoffs](https://rclone.org/s3/),
[download-based byte verification](https://rclone.org/commands/rclone_check/).

## Credentials and activation boundaries

The protected `data-staging` environment is main-only with administrator bypass disabled.
Keep `STAGING_DATA_ENABLED=false` and `STAGING_DATA_ISOLATION_APPROVED=false` until the
actual permissions and target identities are audited.

| Credential | Effective permission | Resource scope |
| --- | --- | --- |
| `SHARED_R2_READ_ACCESS_KEY_ID` / `SHARED_R2_READ_SECRET_ACCESS_KEY` | Object Read | `weatherx-data-production`, `weatherx-components-production` only |
| `STAGING_R2_WRITE_ACCESS_KEY_ID` / `STAGING_R2_WRITE_SECRET_ACCESS_KEY` | Object Read & Write | `weatherx-data-staging`, `weatherx-components-staging` only |
| `ATMOS_DEPLOY_KEY` | Source read | Pinned private validator checkout only |

These are bucket-scoped **S3** credentials; R2 Object Read/Write scopes do not work with
the Cloudflare REST object API. Inherited rclone config, remotes and broad API credentials
are excluded from transfer subprocesses. A misleading secret name is not scope evidence.

`weatherx-data-staging` also contains a vault used by archival work. The trusted controller
never copies or mutates that prefix. Bucket scope is not prefix-level isolation: do not
give this write credential to candidate/experimental scripts. Experimental processors need
their own narrower output boundary before activation.

## Separate publication and backend work

Preparation does not select the staging current release/catalog. The separate manual
`staging-data-activate.yml` controller rechecks every inventory/hash from staging storage,
freshness, the approved preparation receipt and pinned consumer compatibility. It requires
existing prior pointers, preserves both in a durable intent, uses conditional S3 writes,
and verifies actual layer indexes, ledger/accuracy and fourteen numeric point responses.
Interrupted activations have a same-run recovery step; recovery restores only pointers
still owned by that transaction, never a competing publisher's selection.

Catalog sequences are environment-local. For example, older staging sequence 36 can be
replaced with staging sequence 37 whose components are copied exactly from newer production
sequence 34. The source catalog remains immutable; the derived staging snapshot keeps its
own parent/rollback history and verified custom hash metadata. Per-model generation times
and whole-release point cycles may not regress. A staging-only `stagingActivation` pointer
extension makes different activations content-distinct for ETag ownership. The pinned real
consumer validators must accept these pointer bodies before any selection changes.

The activation job has only staging-scoped S3 credentials, not production read/write or
Worker/Pages credentials. The official S3 SDK is integrity-locked in `staging-controller/`.
Hashing is streamed with at most eight concurrent object reads. Data preparation and UI
qualification remain separate operations; this is not a local or duplicate meteorological bake.

The separate Atmos staging repair makes staging weather reads public/cacheable, disables
billing and adds its missing data-health route. It changes no production configuration.
That source change is not a Worker deployment. `staging-consumer-refresh.yml` is the separate
manual repair, pinned to qualified Atmos `4e5177d925f0fc32fe57d17e478daf3c9e31dc7c`.
It admits only the AUTH_MODE/BILLING_MODE change, audits all existing bindings, and uploads
an inactive version before activation. Three public-mode probes and complete settings
verification are required; failure restores its own previous version. Deployment tokens
must never reach candidate build or experimental processor code.

The actual existing staging Worker has five routes; the pinned source also names three
ancillary routes not yet installed. This code-only repair deliberately preserves the five
actual routes and does not deploy triggers, queues, bindings, migrations or extra routes.
Its health acceptance is not a claim that stale staging data has become fresh—that requires
the separate data activation and source-bound numerical proof.

UI build/deploy isolation is documented in `UI-STAGING-PROMOTION.md`: candidate code runs
on a credential-free runner; a fresh trusted publishing job handles staging-only deployment.
Production UI remains a separate manually triggered, owner-approved artifact promotion.
Neither preparing data nor merging these files deploys either website.

## Explicit remaining scope

- Dedicated S3 credentials were provisioned with approval on 2026-08-31. Real reads passed
  in their allowed buckets; both cross-environment reads returned 403. Cloud preparation
  run `33410167126` is the first copy qualification; its dispatch is not completion evidence.
- Qualify the new activation controllers in cloud CI; separately approve the dedicated
  account-scoped staging deployment credentials and exact existing Worker settings digest.
  General Cloudflare approval was given, but token creation remains blocked pending the
  tool's explicit account-scoped Workers/Pages credential approval. Do not work around it.
- Enable `STAGING_CONSUMER_ENABLED` only for its reviewed previous-version/settings pin.
  Enable `STAGING_DATA_ACTIVATION_ENABLED` only after public consumer health and approval of
  the exact prepared `receipt.json` byte hash in `STAGING_DATA_APPROVED_RECEIPT_SHA256`.
- Run guarded backend update and data activation, then qualify the actual staging UI;
  neither source merge nor successful preparation is a live staging receipt.
- Shared immutable **raw input** archives for experimental processing still need a complete
  source/producer/config/schema manifest. This lane reuses finished releases instead.
- A future approved-collector pin migration is separate; production source selection has not
  been changed here. New models/fusion experiments must remain non-serving until qualified.

References: [R2 scoped S3 permissions](https://developers.cloudflare.com/r2/api/tokens/),
[Cloudflare account-scoped Pages permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
