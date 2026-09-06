# Staging-only startup compression — integration checkpoint

Goal: reduce useful-weather startup on cold 400 kbit/s, 800 ms latency, CPU4
without reducing weather quality, functionality or interaction smoothness.
This is an opt-in experiment, not a completed latency qualification.

## Implementation

- Explicit request `release-roster-core-br11-v1`; existing defaults unchanged.
- Requires both protected staging approvals: core `release-roster-core-v1`
  and `UI_STAGING_STATIC_COMPRESSION_APPROVED=static-br11-v1`.
- Requires source ancestry of Atmos `b06c012f171cade42c98ca67fa655f456d720cd8`
  and the existing exact-current-master check. No bypass of that check.
- The credential-free build compiles the existing Functions once, selects the
  entry/App/MapView static-import closure and entry CSS, then composes the
  precompressed overlay **before** generating the release receipt.
- Candidate admission verifies raw/decompressed byte equality, sidecar inventory,
  final Worker/routes/headers hashes and manifest seal without executing source.
- An ordinary profile cannot carry compression metadata/sidecars. Production
  rejects the experimental profile. The production workflow is unchanged.
- The guarded staging verification probes actual raw Brotli HTTP bytes, identity
  fallback, security headers, browser caching, ETags, HEAD and 304 for every
  selected file, with at most four concurrent probe chains. This runs inside
  the rollback transaction. Retention requires its artifact-bound proof.
- Cloudflare's private CDN cache header may be stripped on the wire; runtime
  contracts check emission. See the official [header documentation](https://developers.cloudflare.com/cache/concepts/cdn-cache-control/).

## Evidence on 2026-09-06

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
2. Merge/pin the reviewed source and controller through their usual lanes; the
   compression source is not current master at this checkpoint.
3. Explicitly approve and deploy this profile to staging only. No approval
   variables or Cloudflare state have been changed by this integration work.
4. Verify live HTTP delivery, repeat counterbalanced normal/moderate/severe
   startup and first-use/layer/zoom/point measurements, all 11 model paths and
   recovery. Reject the experiment if the extra Worker routing offsets savings.
5. Continue reducing mandatory startup bytes. The prior local compression
   experiment improved ~25.8s to ~23.5s; it does not meet the <10s target.

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
