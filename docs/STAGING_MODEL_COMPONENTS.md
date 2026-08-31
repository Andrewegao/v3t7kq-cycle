# Immutable staging model display qualification

This manual lane prepares one model's actual readable staging catalog snapshot.
It does not change either current pointer, deploy UI/Workers, issue fusion, or
claim that browser qualification has passed. Four-model shared collection,
staging replay and production publication stay unchanged.

## Authority and inputs

`staging-model-components.yml` requires main, workflow_dispatch, the protected
data-staging environment, the exact hosted job/workflow identity and these
explicit approvals (none are enabled by the code):

- `STAGING_DATA_ISOLATION_APPROVED=true`
- `STAGING_MODEL_COMPONENTS_ENABLED=true`
- `STAGING_MODEL_APPROVED_SOURCE_SHA`: original collector commit
- `STAGING_MODEL_VALIDATOR_SOURCE_SHA`: reviewed sanitizer commit
- `STAGING_MODEL_COMPONENTS_APPROVED_REQUESTS_JSON`: protected JSON map from each
  canonical model ID to the SHA-256 of its exact `canonical(request(env))`
- The fixed staging Cloudflare account plus its staging-bucket S3 credentials

The approved request binds the model, exact six-hour source cycle, original
Actions run and attempt, collector and validator SHAs, plaintext receipt hash,
actual encrypted-archive completion marker hash, and the prior isolated model
catalog ID/hash. Both prior fields must be literal `none` for an explicitly
approved first admission. No `latest` source or arbitrary recipient/prefix exists.
The approval map may authorize all seven independent models simultaneously;
per-model workflow concurrency prevents same-model overlap. Never overwrite a
single shared request approval while queued jobs depend on it. Unknown model
keys, invalid hashes, missing selected models and changed requests fail closed.

The archive encryption key is available only during restore. Storage credentials
are absent during dependency installation, tests and scientific validation.
The sanitizer uses full Git ancestry and exact producer-byte compatibility;
collection is never relabeled as produced by the later validator.

## Prepare sequence

1. Verify marker identity/hash and AES-256-GCM receipt; verify original cloud
   invocation, source/hash inventory and key fingerprint. Check available disk
   against the entire archive, twice its staged subtree, and 512 MiB headroom.
2. Decrypt two objects at a time into the exact original private
   `RUNNER_TEMP/weatherx-model-inputs/<model>` root. Every plaintext hash/size and
   the complete remote key set must match. Recheck marker and receipt afterward.
   The marker is retained outside the restored inventory. HRDPS's original
   launch-root and ancestry requirements are preserved, never rewritten.
3. Execute approved `qualify_cloud_model_display.py` without cloud credentials.
   It reuses original scientific validators, offline planning and assembly,
   producing exactly `display/` (150 typed files) and `qualification.json`.
   No weather recollection occurs in this lane.
4. Check exact science receipt, source-run and validator-run binding, complete
   49-lead/48-hour horizon and unchanged unpromoted holds. Hash all display bytes.
5. If a prior experimental catalog was approved, verify its actual snapshot
   metadata, descriptor and complete 150-object inventory, then compare model
   cycle, grid, wind reference, variable encodings and forecast lead coverage.
6. Write only immutable `weatherx-components-staging/components/<model>/stage-…/`
   display objects with conditional creation. Re-read every byte plus content
   headers. Write the descriptor only after successful data verification.
7. Write `weatherx-data-staging/catalogs/snapshots/stage-<model>-<run>-<attempt>.json`
   with its required SHA-256 metadata. Validate it with the unchanged, exactly
   pinned `4e5177d…` consumer. Finally write the safe selection entry beneath
   `staging-candidates/model-components/<catalog-id>/selection.json`.

The immutable catalog contains only that additional model. Its URLs are usable
as `/data/_catalog/<catalog-id>/<model>/…`; a missing model in that snapshot must
return 404, not borrow another catalog or whole release. Neither
`catalogs/current.json` nor `releases/current.json` is read for fallback or written.

## Honest quality boundaries

The sanitizer supplies actual `coverage`, `freshness`, `horizon`, `cadence`,
`grid`, `referenced_bytes`, `native_wind` and `source_binding` results. The
controller adds actual manifest/inventory verification, prior-model superset
comparison (or approved first admission), and full remote byte verification.
These are the component's passed *data* checks. There is no invented browser
check, native-resolution guarantee, learned skill claim, or fusion promotion.

`completedAt` is sampled after remote display readback, not at scientific
validation time. Reverification of the same completed immutable candidate keeps
its original timestamp after rechecking every byte. Colliding/different objects
fail rather than overwrite. Partial failures may leave immutable **unselected**
objects; no rollback or deletion can affect a current publisher. A retry needs a
fresh approved invocation; stale cycles fail before and after expensive phases.

The public selection entry has `status: DATA_QUALIFIED`, source/run identity,
catalog and component hashes, exact 150 model-relative display inventory, its
canonical digest, grid/variables/wind reference and explicit
`browserQualified=false`, `fusionEligible=false`, `productionPublishable=false`,
`weatherxFusionIssued=false`. Private launch paths, raw values, archive file
paths, provider URLs and original receipts are not published.

A separately approved staging UI build may aggregate verified entries into
`/assets/staging-model-selection.json`, pin that artifact's hash, and admit them
only on `https://staging.weatherx.org`. That integration must preserve regional
domain/device checks and honest point/fusion fallback. It is not performed here.

## Verification and limits

Offline tests cover real AES-authenticated restore, path/size/disk constraints,
identity/hold negatives, partial/corrupt writes, prior non-regression and actual
pinned-reader acceptance/rejection. Reader fixtures contain synthetic bytes, not
scientific/weather or browser-rendering proof. Run with Node 22.15+ and
`STAGING_CONSUMER_ROOT` pointing to an exact clean `4e5177d…` checkout to include
the actual reader test. Cloud qualification runs that test before private reads.

Archive restore retains the collector's 30-GiB total and 512-MiB/file limits;
display upload is capped at 3 GiB and four concurrent objects. The hosted runner's
actual memory and wall time still require measured qualification. All output
stays private except the typed public display, descriptor, snapshot and minimal
selection entry. No Actions data artifacts or cache are created.
