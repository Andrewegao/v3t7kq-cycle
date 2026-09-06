# Staging-only startup compression — integration checkpoint

Goal: reduce useful-weather startup on cold 400 kbit/s, 800 ms latency, CPU4
without reducing weather quality, functionality or interaction smoothness.
This is an opt-in experiment, not a completed latency qualification.

## Implementation

- Explicit request `release-roster-core-br11-v1`; existing defaults unchanged.
- Requires both protected staging approvals: core `release-roster-core-v1`
  and `UI_STAGING_STATIC_COMPRESSION_APPROVED=static-br11-v1`.
- Requires source ancestry of Atmos `a22db10b3f76ff84c422352e566c879868b45706`
  and the existing exact-current-master check. No bypass of that check.
- The credential-free build compiles the existing Functions once and exhaustively
  selects emitted browser JS/CSS, including lazy modules and separately built workers.
  The bundler names these `/assets/wxbr11v1-*` before hashing and rewriting references;
  the precompressed overlay is composed **before** generating the release receipt.
  Non-code assets and flag-off Lab/Road output retain their original naming.
- The manifest must be a bijection with all emitted JS/CSS (1–512 files). Unsalted
  JS/CSS, malformed reserved names, symlinks, omissions and overlapping original
  asset routes are refused. One fixed namespace route is appended; the runtime
  still serves only sealed exact paths at the staging origin. A future change to
  the representation/header/routing contract requires a new namespace version.
- Candidate admission verifies raw/decompressed byte equality, sidecar inventory,
  final Worker/routes/headers hashes and manifest seal without executing source.
- An ordinary profile cannot carry compression metadata/sidecars. Production
  rejects the experimental profile. The production workflow is unchanged.
- The guarded staging verification probes actual raw Brotli HTTP bytes, identity
  fallback, security headers, browser caching, ETags, HEAD and 304 for every
  selected file, with at most four concurrent probe chains. This runs inside
  the rollback transaction. Retention requires its artifact-bound proof.
- First failure stops scheduling and aborts all in-flight HTTPS peers before returning
  control to rollback. The original contextual failure is retained, not replaced by an
  abort error. The exact hash-bound public wire receipt is retained alongside the
  encrypted candidate; it contains no response bodies, server code or credentials.
- Cloudflare's private CDN cache header may be stripped on the wire; runtime
  contracts check emission. See the official [header documentation](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/).

## Current repair evidence on 2026-09-06

### Full candidate file budget follow-up

After the reviewed retry closed fuse #175, run 34047704810 passed the application
tests, Weather Lab gate, Vite build and Functions compilation, then refused before
deployment with `artifact exceeds size/file limit`. The shell receipt counted
3,734 files but excludes 1,365 retained ground tiles and the receipt itself: the
complete candidate has 5,100 files. It exceeded the 5,000-file inventory limit,
not the 96 MiB byte limit. Overlay-only local validation had missed this boundary.

The compressed staging profile now admits at most 5,000 ordinary files, 512
hash-named Brotli sidecars, and one sealed manifest. Full candidate admission
still verifies the manifest/sidecar bijection and decoded equality. The combined
96 MiB byte limit, encrypted transport bounds, baseline/production 5,000-file
limit, and production rejection of compressed candidates are unchanged. The
profile is carried through disk reads, candidate validation, restore and both
pre/post-deployment exact-byte checks; an allowance at build time alone is not enough.

Regression evidence: the new full-envelope test failed on the old limit and
passes through candidate creation, RSA build transport, AES candidate retention,
restore, and inventory verification. Tests retain ordinary-file and byte overflow
refusals, enforce the 512-sidecar cap, and reject relabeling for production.
All 113 UI-controller tests pass locally. A public-only copy of the actual frozen
build passed with 5,100 files / 29,387,074 bytes / 39,911,438 encrypted bytes and
exact restored inventory. Evidence: `/private/tmp/weatherx-candidate-budget-47N0CE/`.
This is local packaging evidence, not a cloud deployment or latency qualification.

### Earlier namespace repair

Run 34038808522 failed wire qualification and restored the prior staging
deployment. Fuse #175 was subsequently closed after diagnosis and fresh validation
were reviewed; do not blindly retry. Raw GET evidence found old automatic-compression
cache responses on unchanged asset URLs. This is the leading diagnosis, not
certainty about the original unlogged failed path. The repair's failure messages
now record a bounded path/phase/status/header summary without bodies or secrets.

Frozen repair artifacts under `/private/tmp/weatherx-severe-baseline.i5Ldvc/`:

- 163 JS/CSS assets, including five workers; 5,567,746 raw / 1,503,081 Brotli bytes.
- 20 routes: all 19 originals plus `/assets/wxbr11v1-*`; 37 non-code assets unchanged.
- 589 resolved imports; seal `5d9c07b93ae0227c475a9329f8fb90fbc8dd4068c74fb48a5bf96f1f910512e0`.
- Actual compiled Functions with local Pages ASSETS passed 1,304 wire probes over
  all 163 assets plus five non-asset OPTIONS parity checks. A loopback-origin adapter
  and symmetric local rebundling were used; these are not cloud CDN receipts.
- Three paired runs per network profile for point and layer journeys plus three
  extra counterbalanced normal-only pairs each: 48 journeys passed. Severe weather
  median about 24.8 -> 23.6 s against captured local Pages automatic Brotli,
  not a gzip baseline. Normal results are small and mixed; no proven normal gain.
- Candidate with live staging catalog 141 passed ten explicit model-point rows,
  causal map/zoom pixels and rapid switching. AROME Antilles failed freshness
  (`2026090518`, expired 12:00Z). No all-eleven success or data repair is claimed.

## Historical pre-namespace evidence (superseded contract)

Real frozen-build composition passed in
`/private/tmp/weatherx-controller-compression-QdvQ8O/`:

- 30 startup files; 2,151,416 original bytes, 531,706 Brotli bytes.
- 49 routes: 19 original routes preserved plus 30 exact asset routes.
- All compressed files independently decode to exact source bytes.
- Overlay seal `5e769d5de6871f0490e58b7813a2078d661277e95d28566fdd797add6aa038da`.
- `controller-receipt.json` records these results; this is **not** a new latency run.

The first local fixture copied data folders from a retained benchmark build and
was correctly refused by UI candidate inventory. The rerun used the cloud
build's UI-only exclusions (`data` and `data-atmos`); no data was baked or published.

The UI controller suite passes. A broader all-files test invocation also exposed
unrelated local harness prerequisites: system rclone is 1.74.3 rather than the
required 1.75.0, and the synthetic S3 test needs SHARED_DATA_VALIDATOR_MODULE.
Those checks were not removed or weakened. The missing locked AWS SDK was
installed with the same staging-controller npm-ci step used in CI.

## Remaining before acceptance

1. Review source and controller changes, including existing recovery contracts.
2. Merge/pin the reviewed source and controller through their usual lanes. PR #172
   and Cycle #174 merged the initial experiment; repair PRs Atmos #173 and Cycle
   #176 are not yet merged at this checkpoint.
3. Review the fuse diagnosis and fresh repair evidence before a guarded staging-only
   deployment using the existing protected approval. Keep automatic rollback and all
   wire assertions intact. No approval variable or Cloudflare configuration change
   is required by this namespace repair.
4. Verify live HTTP delivery, repeat counterbalanced normal/moderate/severe
   startup and first-use/layer/zoom/point measurements, all 11 model paths and
   recovery. Reject the experiment if the extra Worker routing offsets savings.
5. Continue reducing mandatory startup bytes. The fairer automatic-Brotli comparison
   improved ~24.8s to ~23.6s; it does not meet the <10s target.

No production deployment, configuration or weather data changed.

## Independent review follow-up

Two findings were reproduced with failing tests, then repaired before activation:

- Removing compression metadata and sidecars must not leave its asset Worker
  routes in a noncompression candidate. Baseline/core now reject asset invocation
  rules; compressed candidates require exactly the sealed asset route selection.
  Existing synthetic candidate fixtures now use real API-only route schemas
  instead of empty JSON placeholders.
- A no-cache-only probe can conceal representation contamination. The live gate
  now separates a freshness probe from ordinary br/identity/gzip/br requests,
  verifies decoded bytes and Vary/security/browser-cache policy for every variant,
  and requires raw 200 when the Brotli ETag is presented for identity. CF cache
  status and Age are recorded, not assumed to identify the outer cache layer.

The updated UI suite passes 103 tests. This does not replace live qualification;
no cloud settings or deployment have been changed.
