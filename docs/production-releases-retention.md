# Production whole-release retention

`weatherx-data-production` grew from 100 GB / 0.63 M objects on 2026-10-07 to 492 GB / 3.28 M
objects on 2026-10-21, about 30 GB a day, with zero deletes. Each successful whole-data bake
(`bake.yml` step "bake → gate → publish immutable data release" → Atmos `ops/bake-weatherx.sh` →
`ops/platform/publish-r2-release.sh`) uploads a complete new release, about 51–56 k objects and
7.5–8 GB (for example `releases/cycle-39493311523/manifest.json` has `objectCount` 55915), to
`releases/cycle-<run id>/` about four times a day and promotes `releases/current.json`. Nothing
deletes old releases. This controller is the approval-gated cleanup, with the same shape as the
[component retention](production-components-retention.md) and the
[Wind100 retention](production-wind100-retention.md): a read-only dry run, a plan digest, an
approved execution that recomputes and re-checks before every delete, a bounded number of deletes
per run, and no pointer, catalog or manifest ever written.

The reviewed profile is `release-pointer-window-gc-v1`
([policy](../tools/production-releases-retention-policy.json),
[controller](../tools/production-releases-retention.mjs),
[workflow](../.github/workflows/production-releases-retention.yml)).

It is a sibling of the component controller, not a second profile in it. The two share only the
plan, approve and execute frame (about 60 lines); the object models differ (a verified catalog
chain over component roots versus one release pointer over release prefixes), they delete in
different buckets with different parent tokens, and editing the component controller would change
its `controllerDigest` and invalidate the already-reviewed `PRODUCTION_COMPONENTS_GC_CONTROLLER_SHA256`.

## What is kept

A release id is never a candidate when any of these holds. Everything is evaluated as of the dry
run's `plan_as_of`, so the execution recomputes the same answer.

1. **It is the current release.** The `releaseId` of `releases/current.json` read by the dry run
   (`baseline_release_id`), and the live pointer read again by the execution. The execution also
   re-reads the pointer **before every delete** and stops if it names a candidate (a rollback
   onto a candidate). A promotion to any other release, such as a new bake, does not stop it.
2. **It is among the newest `keepNewestReleases` (8) complete releases.** The pointer carries no
   history (Atmos `platform/edge/src/releasePromotion.ts` overwrites it with a conditional put),
   so promotion order is taken from each release's own `manifest.json` `createdAt`, and separately
   from the GitHub run id in `cycle-<run id>`. The newest 8 by **either** order are kept, and the
   summary says when the two orders disagree. Key sort order is never used. Every successful bake
   from 10-07 to 10-20 printed `promoted cycle-<own run id>`, so creation order is promotion
   order in practice; an upload that failed to promote would only occupy one of the 8 places.
   Eight releases are about two days of rollback; the policy refuses fewer than two (the Atmos
   runbook's "two last-good releases").
3. **It is younger than `minimumAgeHours` (168 h, seven days).** A release with any object, or a
   manifest `createdAt`, newer than `plan_as_of − 168 h` is kept. This covers uploads in flight,
   open app sessions and the runbook minimum below. The policy refuses less than 72 h.
4. **The staging shared-read pin names it.** If `weatherx-data-staging/shared-read/pin.json` has
   a `releaseId`, that release is kept whether or not the pin has expired. Any change to the pin
   during an execution stops it.
5. **Its upload is incomplete or inconsistent.** A missing, unparsable or oversized (over 16 MiB,
   the data Worker's own manifest bound) `manifest.json`, a manifest naming another release, or a
   prefix that lists more objects than its manifest plus `manifest.json` is kept and listed under
   "Incomplete or inconsistent" in the summary. v1 never deletes these; inspect them by hand.
6. **It is out of scope.** Only `releases/cycle-<digits>/` prefixes are candidates.
   `releases/current.json`, any other release id (for example a laptop-format id), and every key
   outside `releases/` are never listed for deletion; nothing outside `releases/` is listed at all.

Everything else in scope is **eligible**. A plan selects the oldest eligible releases, up to
`maximumDeletesPerRun` (500,000) objects. Each selected release is listed in full (every page),
and the plan records its object count, bytes, manifest digest and the SHA-256 of its sorted
`[key, size, etag]` rows. A release with fewer objects than its manifest names, but with the
manifest present, can only be the remainder of an interrupted deletion (the publisher uploads
`manifest.json` last); it is planned as `partial` and finished by the next run.

### Why these windows (Atmos evidence at production pin `30a211be7`)

- **Data Worker.** `platform/edge/src/data.ts` serves `releases/<current>/<path>` for every path
  the catalog does not cover (`resolveRelease`, line 320) and `releases/<id>/<path>` for an
  explicit `/data/_release/<id>/…` address (`dataAddress`, line 356). It has no fallback to an
  older release: a stale cached pointer is kept only between 30-second refreshes
  (`RELEASE_CACHE_TTL_MS`). Only the current id and ids that a client pinned are ever read.
- **App sessions.** `app/src/engine/manifest.ts:142-153` pins a session to the release named by
  the run index's `X-WeatherX-Release` header. The pin has no fixed lifetime: it lasts until
  `app/src/chrome/RunSelfRefresh.tsx` sees a newer model run (polling at most every 90 s once one
  is due, and not while the tab is hidden) or the page reloads. The persisted boot manifest is
  dropped 20 hours after its run's init time (`App.tsx:1211`). A visible tab therefore holds an id
  for hours, a tab hidden for longer than the window can still ask for its old id once on return,
  and then gets a 404 until its next poll swaps runs. Seven days covers every realistic session.
- **Fusion feedback.** Issuance records store
  `/data/_release/<id>/verify/runs/<run>/…` (`app/src/fusion/feedbackContract.ts:78`). The
  collector fetches that tile once at issuance and stores its SHA-256 (`ops/fusion/cli.ts:180-203`);
  nothing reads the path again later (the only other use is the contract's string check). It
  needs the release for minutes, inside one collection run.
- **Staging shared-read.** `platform/edge/src/sharedRead.ts:131-145` lets the staging pin name a
  production `releaseId` for at most seven days (`MAX_PIN_LIFETIME_MS`). Rule 4 keeps it
  regardless of expiry.
- **Catalogs.** A catalog snapshot (`platform/edge/src/catalog.ts` `DataCatalog`) names only
  components, never a release id, so no catalog is read.
- **Rollback runbook.** `docs/platform/SECURITY_SCALE_RUNBOOK.md` §5: "Keep at least two
  last-good releases plus seven days of pointers/manifests. Delete old immutable releases only
  with a separately reviewed retention job; never use a broad recursive target." The pointer has
  no history object, and a release's manifest lives inside its prefix, so seven days of manifests
  means seven days of releases. That is why `minimumAgeHours` defaults to 168, not 72. Lowering
  it to 72 (about 12 releases, 90 GB) needs that runbook line changed first.
- **Rollback.** `ops/platform/activate-r2-release.sh` promotes an existing release only after
  downloading the whole prefix and verifying it against its manifest, so a partially deleted
  release can never be rolled back to by the runbook path.

## Plan, approval and execution

1. **Dry run.** Dispatch `production-releases-retention.yml` with `dry_run: true`. The job
   summary shows `planSha256`, `plan_as_of`, `baseline_release_id`, what is kept by which reason,
   the eligible totals, what this run deletes, the totals after it, the protected releases
   proven whole, and any incomplete, partial or out-of-scope prefix. The full plan is the
   `production-releases-retention-plan` artifact (7 days). The dry run holds no delete token and
   refuses to start if one is present.
2. **Review and approve.** Set the protected variable `PRODUCTION_RELEASES_GC_APPROVED_PLAN_SHA256`
   to that `planSha256`.
3. **Execute.** Dispatch with `dry_run: false`, `plan_as_of` and `baseline_release_id` set to
   the dry run's values, within `maximumPlanAgeHours` (24 h). The execution:
   - recomputes the whole plan at that `plan_as_of` and baseline and refuses unless its SHA-256
     equals the approved one. Releases uploaded after `plan_as_of` are kept and outside the plan,
     so ordinary bakes between the dry run and the execution do not invalidate it; a pin change,
     a rollback onto a candidate, or any change to a candidate's objects does;
   - re-lists each release in full and refuses if it grew or changed;
   - **before every delete**, re-reads `releases/current.json` (stop if it names a candidate) and
     the staging pin (stop on any change);
   - deletes each release's `manifest.json` last, with a 15-minute `DeleteObject`-only credential
     minted per release (and again after 10 minutes) from the dedicated delete token, restricted
     to that one `releases/cycle-<id>/` prefix;
   - after the last delete, re-reads the pointer and re-lists every protected release (baseline,
     live current, pinned, newest 8) and fails unless each lists exactly the same
     `[key, size, etag]` rows as before the first delete with every manifest path present.

   A stopped or partial run is replayable: a new dry run plans only what remains.

There is no concurrency group. A job that holds one while it waits at an environment gate is what
`tests/lock-environment-invariant.mjs` forbids, and the group is not needed for safety: each run
deletes only keys of the plan it recomputed and the approved digest names, and a run whose re-list
sees objects another run already deleted refuses. Still, start one execution at a time.

## Resources the owner creates (names only; none exist yet)

- Environment `production-releases-retention` with required reviewers, restricted to `main`.
- Secrets, in that environment:
  - `PRODUCTION_RELEASES_GC_READ_ACCESS_KEY_ID` and `PRODUCTION_RELEASES_GC_READ_SECRET_ACCESS_KEY`:
    an R2 API token with **Object Read only** on `weatherx-data-production` and
    `weatherx-data-staging` (the staging bucket only for `shared-read/pin.json`).
  - `PRODUCTION_RELEASES_GC_DELETE_ACCESS_KEY_ID` and `PRODUCTION_RELEASES_GC_DELETE_SECRET_ACCESS_KEY`:
    a separate parent token with **Object Read & Write on `weatherx-data-production` only**.
    R2 API tokens are scoped to buckets, not prefixes, so this token cannot itself be limited to
    `releases/`. The controller never uses it directly: it only signs temporary credentials
    restricted to `DeleteObject` on one `releases/cycle-<digits>/` prefix (Cloudflare
    [temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/),
    the same construction the Wind100 and component cleanups use), and the adapter refuses any
    other prefix or `releases/current.json` before a request is made. The parent token could
    still overwrite the pointer if it leaked, so it lives only in this environment, must differ
    from the read token (the controller checks), and should be rotated or revoked once the
    backlog is cleared and `PRODUCTION_RELEASES_GC_EXECUTE_ENABLED` is turned off.
- Variables:
  - `PRODUCTION_RELEASES_GC_CALL_ENABLED=true` (repository; the job runs at all);
  - `PRODUCTION_RELEASES_GC_ENABLED=true`;
  - `PRODUCTION_RELEASES_GC_EXECUTE_ENABLED=true` (only while deletion is wanted);
  - `PRODUCTION_RELEASES_GC_CONTROLLER_SHA256`, the output of
    `node -e 'import("./tools/production-releases-retention.mjs").then(m=>console.log(m.controllerDigest()))'`
    on the merged commit. Any later change to the workflow, this document, the controller or the
    policy invalidates it;
  - `PRODUCTION_RELEASES_R2_ACCOUNT_ID=a89f9a1af485021fbc60a68b163c7c6e`;
  - `PRODUCTION_RELEASES_GC_APPROVED_PLAN_SHA256`, per approved plan.

The controller refuses to start if the job environment carries any publisher, catalog-promotion,
staging-write, Wind100, component-cleanup or Cloudflare API credential.

Before the first execution, prove that a derived credential denies an adjacent prefix and every
non-delete action, as `production-wind100-scope-preflight.yml` does for Wind100.

## Expected first dry run

No live listing has been run: R2 credentials were not available when this was written. From the
surge investigation there are about 76 release folders as of 10-21 (24 from before 10-07, about
100 GB and 0.63 M objects including the bucket's few non-release keys, plus 52 published 10-07 to
10-20 at about 51 k objects and 7.5 GB each) and about four more a day.

| `minimumAgeHours` | kept (≈) | candidates (≈) | bytes (≈) | objects (≈) | runs at 500 k |
|---|---|---|---|---|---|
| 168 (default) | 28–30 | 50 | 290 GB | 1.9 M | 4 |
| 72 | 12–13 | 66 | 410 GB | 2.7 M | 6 |

With the default the newest-8 rule is not the binding one; it binds only if bakes stall for
more than five days. Each plan lists the whole `releases/` prefix once (about 3,300 list
requests) and reads about 80 manifests; an execution plans again, re-lists its candidates and
issues two guard reads per delete. At 16 deletes in flight a 500,000-object run takes roughly 1.5
to 2.5 hours, inside the 240-minute bound.

## Steady state

About seven days of releases: 28 × 7.5–8 GB ≈ 210–225 GB and about 1.5 M objects under
`releases/`, flat instead of growing 30 GB a day. With `minimumAgeHours` lowered to 72 (after the
runbook change) it would be about 12 releases, roughly 90–100 GB; the floor set by the newest-N
rule alone is N × 8 GB = 64 GB. Retention needs one dry run and one approved execution about
every two days (eight new releases are about 400 k objects) to stay there.

## Proving the first run safe

1. Review the dry-run summary and artifact: every candidate is older than `minimumAgeCutoff`,
   none is the baseline, the pin or a newest release, and the protected releases are all
   "proven whole".
2. Execute. Its summary must say `releases/current.json` is byte-identical before and after (or
   changed only by a promotion to a release that is not a candidate), and every protected
   release's listing is unchanged with its manifest fully listed. Listing returns each key's size
   and ETag, so this is the same check as a HEAD 200 with an unchanged ETag for every path in
   the current and newest manifests.
3. Load https://weatherx.org and confirm the map draws and the data responses carry the
   `X-WeatherX-Release` of the current release.
4. Only then dispatch the next dry run.
