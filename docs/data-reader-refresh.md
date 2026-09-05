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
inactive with strict `latest` binding inheritance. The first expected predecessor
is the reviewed active version; the second is our verified read-only upload.
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
   broaden authority. Pages inspection prefers the existing `PAGES_READ_TOKEN`;
   if absent, it uses the already-present `CLOUDFLARE_WORKERS_API_TOKEN` only for
   GET inspection of the fixed account's `atmos-platform` Pages project. A token's
   name does not prove its permissions: a bounded early GET must succeed before
   dependency installation, tests, build, or any mutation. Failure stops the lane;
   it does not grant permissions, retry with UI deployment credentials, or skip
   the complete Pages boundary proof. The same selected credential is used for
   every later Pages boundary GET. Only permission/status is printed, never a
   token or Pages configuration. Cloudflare's
   [project GET API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/)
   accepts existing Pages Read or Pages Write authority; this lane adds neither.
3. Review a freshly captured boundary digest: complete normalized data/platform
   settings, schedules, subdomains, both active versions, all zone routes,
   Pages canonical deployment and configuration hashes. All zeroes print the
   observed digest and safely refuse before upload; re-dispatch only after review.
4. Dispatch with exact merged SHA, reviewed digest and
   `REFRESH-DATA-READER-ONLY`, through the production approval environment.
5. Separately confirm an exclusive production **data Worker control-plane**
   window with `exclusive_window=EXCLUSIVE-DATA-WORKER-CONTROL-WINDOW` for this
   run. No other actor may upload/deploy code, modify settings, or rotate secrets
   until this run (including recovery) finishes. This does not authorize UI,
   platform Worker or route changes. Ordinary R2 weather-data publishers remain
   separate. The confirmation is explicit per run, not inferred from release
   approval. Keep the window reserved while a failure needs manual containment.

The private, atomically written receipt binds controller SHA, source SHA, run and
attempt, exact bundle digests, original catalog/whole pointer hashes, version
UUIDs and ownership tags. No credential values or signed URLs are retained.

## Cloudflare API preservation contract

The [version upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/)
documents inactive upload and `bindings_inherit=strict`. The live classic API
refused explicit inheritance UUIDs (10057: only literal `latest` supported),
despite the broader generated schema. Each binding therefore explicitly uses
`version_id: "latest"` and strict mode remains mandatory. Versioned placement,
limits, cache options and usage model are carried from the reviewed state. The
entire returned inactive `script_runtime` must equal the prior active runtime.
The server-returned script ETag is pinned and re-read for identity; it is not
misrepresented as a locally computed module SHA256. The receipt separately
records the exact module bytes SHA256 sent in the authenticated upload.

The initial latest upload must equal the single reviewed 100%-active version.
Before and after each upload, before each activation, after qualification and
before containment, the controller checks the ordered version history. Only
`[owned-full, owned-readonly, original, ...reviewed-history]` is admitted as the
operation advances; sequential numbers must be original +1 and +2. Every owned
version is re-read for exact binding/runtime/source/ETag identity. Missing,
unreadable, duplicated, reordered or foreign history refuses activation. Lost
upload responses never permit guessing ownership or retrying the upload.

**These checks are not an atomic compare-and-swap or proof of hidden secret
values.** Secret binding metadata exposes names/types only; version details have
no inheritance-parent field. Sequential history and ownership tags cannot prove
cryptographic parentage. Concurrent control-plane writers can race observations,
and another API can delete versions. The owner-reserved exclusive window is
therefore required. The four known Cycle lanes (`data-reader-refresh`,
`consumer-refresh`, `data-edge-deploy`, `point-route-activate`) share the
`weatherx-production-data-edge` non-cancelling lock; dashboard/manual API and
other repositories do not. Detected foreign ownership is never overwritten,
including during recovery. No setting, secret, route or pointer is changed to
manufacture this exclusion.

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
