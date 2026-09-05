# Production data reader upgrade — Phase 1 only

This manual lane prepares and activates code for the existing
`weatherx-data-edge-production`. It does not deploy Pages/UI, change the platform
Worker, add point-series routes, edit settings/secrets/crons, or write weather
objects/catalog pointers. Existing scheduled publishers remain separate.

## Why two versions

The old reader cannot parse catalogs containing point-series component mounts.
A pointer comparison followed by restoration of the old version has a race with
ongoing publishers; it is not safe rollback. This lane never deploys the old
version, even when both pointer hashes appear unchanged.

Both candidates come from the same reviewed merged Atmos SHA. The read-only
entrypoint delegates all reads to the full reader and refuses the internal
catalog prefix with 503 `catalog_publication_paused`. Both are first uploaded
inactive with strict binding inheritance from the recorded preflight version.
The read-only candidate is activated and qualified before the full candidate.
On failure the only recovery deployment permitted is our own compatible
read-only version. **Publication is then paused and manual forward repair is
required.** No automatic retry, old-version restore, route change, or pointer
rollback is allowed. In-flight old requests may still finish; pointer changes
before full activation refuse the cutover but retain compatible reads.

Cloudflare deployment APIs do not offer an atomic ownership compare-and-swap.
The shared data-edge workflow lock plus immediate active-version/boundary
rechecks detect known drift. A foreign version, unreadable API state, or boundary
drift causes refusal rather than overwriting an outsider. This is guarded
containment, not a guarantee of atomic rollback against arbitrary external writes.

## Required review before dispatch

1. Merge and qualify the Atmos normal and read-only entrypoints. Review the exact
   14-module data-only bundle closure (plus the fallback wrapper), full Worker
   tests including paired promotion / whole-release promotion / legacy reads.
2. Confirm existing token capabilities permit Worker version upload/deploy and
   read-only R2/zone/platform/Pages inspection. The lane does not create tokens or
   broaden authority. Pages token access is read-only in this controller.
3. Review a freshly captured boundary digest: complete normalized data/platform
   settings, schedules, subdomains, both active versions, all zone routes,
   Pages canonical deployment and configuration hashes. All zeroes print the
   observed digest and safely refuse before upload; re-dispatch only after review.
4. Dispatch with exact merged SHA, reviewed digest and
   `REFRESH-DATA-READER-ONLY`, through the production approval environment.

The private, atomically written receipt binds controller SHA, source SHA, run and
attempt, exact bundle digests, original catalog/whole pointer hashes, version
UUIDs and ownership tags. No credential values or signed URLs are retained.

## Cloudflare API preservation contract

The [version upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)
documents inactive upload and `bindings_inherit=strict`; each inherited binding
uses an explicit recorded prior version UUID, not `latest`. Versioned placement,
limits, cache options and usage model are carried from the reviewed state. The
entire returned inactive `script_runtime` must equal the prior active runtime.
The server-returned script ETag is pinned and re-read for identity; it is not
misrepresented as a locally computed module SHA256. The receipt separately
records the exact module bytes SHA256 sent in the authenticated upload.

The locked Wrangler implementation's `versions upload` path explicitly omits
non-versioned observability/logpush; ordinary deploy calls a separate settings
PATCH for observability, logpush and tails. This controller never performs that
PATCH. Full before/after settings equality guards these fields, including tags,
unknown future settings, and all non-secret binding metadata. Only the exact
receipt-owned tag/source/message annotation delta is normalized, because the
[combined settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/)
reports version annotations; server-owned `workers/triggered_by` is not copied
back as writable configuration. Foreign or extra user annotations are rejected.

## Qualification is not a fresh-data claim

Preflight and repeated live checks validate current catalog/snapshot/component
manifest identities, actual immutable map read parity, and numerically decoded
whole-release point packs under both entrypoints. Legacy stale quality is
recorded, never relabeled complete. Component object bytes are read and compared
to actual pinned live responses; this is not a fresh full-bucket inventory audit.
Existing producer inventory/scientific/freshness gates remain mandatory.

After Phase 1, new scheduled/approved data publications can use `promote-set` and
`promote-release`. Fresh matching map/point publication must pass before a
separately reviewed Phase 2 exact `/api/v1/point-series/*` route activation.
This lane contains no Phase 2 route mutation.
