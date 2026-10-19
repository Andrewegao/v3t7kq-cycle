# Production native Wind100 retention

The reviewed code policy is `verified-pointer-ancestry-gc-v1`, but the
recurring publisher remains disabled by protected resources. Its gate requires
both `PRODUCTION_WIND100_CONTROLLER_SHA256` and the separate
`PRODUCTION_WIND100_GC_READY_SHA256` to equal the digest of the exact Cycle
controller, including the cleanup workflow, implementation, and this policy.
The latter is an owner attestation after the real dry run and credential-scope
review below, not a test for the presence of another environment's secrets.
The cleanup workflow is separately default-disabled.

Every successful pointer transition now writes an immutable journal record
*before* compare-and-swap. The record is named by the SHA-256 of the proposed
pointer body and contains the previous pointer body and hash. A failed CAS
leaves an unreachable record; the cleanup planner starts at the live pointer
hash and follows only its contiguous, verified journal chain. It rejects a
missing, malformed, altered or cyclic link. It derives retired entries from
those transitions, verifies each selection and catalog by their recorded
hashes, and excludes both current pointer entries. It considers the oldest
retirement first, only after 18 hours beyond `freshUntil`. A retired prefix
that already lists empty (an earlier run finished it) is recorded in
`skippedEmptyCatalogIds` and skipped, so planning moves on to the next retired
prefix instead of re-selecting the emptied one forever. One plan holds up to
two candidates by default (at most eight) and never more than the 10,000-object
delete bound, which fits two full 4,141-object prefixes; a prefix that would
overrun the bound waits for the next run. The plan records its candidate and
object limits, and execution recomputes the plan with exactly those limits.

Pointer and journal-chain integrity failures abort the whole plan. A single
retired entry whose own evidence fails (missing or altered selection or
catalog, a catalog the pinned reader rejects, a component that does not match,
or an inventory over its declared object count) is instead listed in
`refusedCatalogIds` with a stable reason code in `refusalReasons`, is never
deleted, and does not stop planning of the next entry. Each refusal produces a
`::warning::` and appears in the step summary; refused prefixes stay in the
bucket until someone inspects them.

Run `.github/workflows/production-wind100-retention.yml` with its default
`dry_run: true` to produce a reviewable artifact and `planSha256`. The
separately approved execution recomputes the plan and requires that exact
SHA-256. It re-reads the live pointer before **every** object deletion and
stops if the pointer hash changed. It deletes at most 10,000 objects in one
run and never deletes catalog snapshots, selection receipts or the pointer.
Partial deletion is replayable: a new dry run lists only remaining objects.
A reviewed dry-run plan goes stale if the recurring publisher's inline reclaim
(or any activation) runs before it is executed: execution then refuses with
"plan changed since approval" and deletes nothing. Run a fresh dry run and
approve its new hash.

An immutable component uploaded by a publication that never activated is not
journal-proven retired. The approved workflow never collects it (its execution
refuses any plan that carries never-activated candidates); inline reclaim does,
under the rules in "Never-activated uploads" below. The planner and executor
are target-generic (`tools/wind100-retention.mjs`) and shared with staging; the
manual plan has exactly the fields and bytes it had in #440, so a plan approved
before this change keeps its `planSha256` (the test suite compares the two
planners on the same bucket state).

## Inline reclaim in the recurring publisher

Each new-input production run reclaims journal-retired prefixes past grace,
then never-activated uploads, before its capacity check
(`production-wind100.mjs reclaim`, the step "Reclaim retired and
never-activated production point prefixes" before "Upload one immutable
production point component"). It uses the same planner
and the same executor as the approved workflow: protected current and rollback
entries are excluded and the plan is recomputed and must match. Inline reclaim
deletes in batches of at most 250 keys, the same window as one scoped delete
credential: before each batch the live pointer is re-read and must still hash
to the plan's pointer, exclude the candidate and leave it past grace, and the
batch's deletes then run eight at a time. (The approved workflow keeps a
pointer check before every key and one delete at a time.) Two serial round
trips per key took about 0.3 s per object, so a two-prefix plan of 8,282 keys
needed about 41 minutes and bake run 39181515197 was killed at the step bound
with no count; batched, the same plan takes about three minutes at that
latency. Because the planner can only
propose journal-proven retirements, this class needs no human plan hash. The
step uses only the job's existing dedicated writer token; each deletion goes
through a 15-minute `DeleteObject` credential minted from it for one prefix.
It refuses cleanup-environment and broad credentials. The step is
`continue-on-error` with a 30-minute bound: if reclaim fails, the capacity
check in the upload step still decides and nothing is published past the cap.

Inline reclaim has its own 20-minute wall-clock budget from the start of the
command. No delete is dispatched after it; in-flight deletes settle and the
command exits 0 with status `reclaim-budget-exhausted`, `deleted`,
`plannedObjects` and `remainingObjects`, plus a `::warning::`. The next run's
plan picks up the remainder. The step prints `reclaim progress: deleted N of M`
before the first batch and after every batch, so even a killed step leaves a
count in its log.

Every awaited reclaim step (module load, IO setup, catalog validator, and each
get, list, delete-credential mint and delete) must settle within 150 seconds,
above the SDK's own 120-second request abort. Otherwise the command exits 1
with `inline reclaim failed (stage …; completed gets …, lists …, delete
credentials …, deletes …)` naming the call that hung; nothing is retried.
A failed or hung delete stops dispatch at once: deletes already in flight in
that batch settle, no later batch starts, and the last progress line gives the
count. The CLI entry uses no top-level await: the
retention module imports `production-wind100.mjs`, and a top-level await there
deadlocked the reclaim module import (bake run 39176755083 exited 13 after
about 50 ms with no IO, so the cap was never relieved).

The capacity check prints existing, planned and maximum object counts when it
refuses, and emits a `::warning::` when fewer than three publications of the
planned size still fit (counting the current one). At four runs a day the
steady state holds about six prefixes (about 25,000 objects); a missed reclaim
is caught up by the next run's two-candidate budget.

## Never-activated uploads (orphans)

An upload whose publication or activation failed leaves a full (or, if the
upload itself stopped, partial) component prefix that no pointer ever names.
About eleven of them fill the 50,000-object prefix cap, and before W15 nothing
collected them. Inline reclaim now plans them after the retired candidates,
oldest upload first, at most two per run and inside the same 10,000-object
budget (retired prefixes go first, so a retired backlog delays orphans; the
steady state of about one retired prefix per run leaves room for one).

A prefix `components/point-ecmwf/<namespace>-<invocation>/` is an orphan
candidate only when all of these hold at planning time, and the executor
repeats the pointer, protection and age checks before every batch:

1. **Unreferenced by the pointer and the journal window.** Its catalog ID is
   not an entry of the live pointer, and not an entry of any previous pointer
   body in the verified journal chain (up to 64 records, back to genesis or,
   on staging, to the journal start). That set includes protected current and
   rollback entries, retired entries still inside their grace, and retired
   entries that were refused for their evidence, so a refused prefix is never
   reclassified as an orphan while it is inside the window.
2. **Unreferenced by any catalog an in-grace entry names.** For every
   referenced entry whose `freshUntil` + 18 hours has not passed (a reader may
   still hold a pointer naming it), its catalog is read and checked against
   the entry's `catalogSha256`, and every component `rootPrefix` in it is
   referenced, whatever its name. If any such catalog cannot be read or fails
   its hash, the whole orphan pass is skipped (`orphanInventory:
   referenced-catalog-unavailable`). Retired reclaim is unaffected.
3. **At least 48 hours old.** The newest object in the prefix, by R2's own
   `LastModified` from a bounded listing of the whole namespace (at most
   50,000 objects, the cap; a listing over the bound or with an unexpected key
   skips the orphan pass), is at least 48 hours (the 30-hour forecast lease
   plus 18 hours of grace) before `now`.
4. **Any selection for it is provably expired.** If
   `<candidates>/wind100/<catalogId>/selection.json` exists, it must be the
   target's selection kind, name this catalog, say `activated: false`, have a
   lease of at most 30 hours, and have `freshUntil` + 18 hours before `now`.
   Otherwise the prefix is refused (`orphan-selection-mismatch`), kept and
   warned about. An absent selection (publication failed first) is allowed.

Why this cannot delete anything a reader or writer still needs:

- *Readers.* Readers find components only through the pointer. Rule 1 excludes
  every entry of the live pointer and of every pointer in the window; rule 2
  excludes every prefix any still-in-grace entry's verified catalog names. A
  pointer older than the window can only name entries whose grace has passed,
  which is exactly the retired class's deletion standard (the retired class
  already deletes such prefixes).
- *Activation.* An entry can only enter the pointer through `activate`, which
  requires `freshUntil` more than 6 hours ahead (production) or a 6-hour lease
  (staging), and only for the selection its own job just published. A
  forecast's `freshUntil` is at most 30 hours after its initialization and
  every upload happens after initialization, so 48 hours after the newest
  object any selection for the prefix is past `freshUntil` + 18 hours and can
  never be activated, and rollback restores only the live pointer's second
  entry, which is protected. Rule 4 checks this directly instead of trusting
  the arithmetic. Every batch re-reads the pointer and stops if its hash
  changed, so no activation can race a deletion.
- *The in-flight upload.* Each prefix belongs to one invocation
  (`<run id>-<run attempt>`), which is never reused: a re-run gets a new
  attempt number and a new prefix. Only that invocation's job writes there,
  and the job is bounded by its 90-minute `timeout-minutes` (GitHub's hosted
  runner limit is 6 hours in any case). A prefix with no write for 48 hours
  therefore has no live writer, and the reclaiming job's own prefix does not
  exist yet when reclaim runs (reclaim precedes upload). Deletion is by exact
  key from the planned listing, so even an impossible late write would not be
  deleted, only left behind.
- *Credentials.* Each deletion uses the same 15-minute DeleteObject credential
  restricted to that one prefix, from the same parent token, as the retired
  class. Catalog snapshots and selection receipts are never deleted.

A retired entry refused for its evidence stays inside the window, and in the
bucket, until it leaves the 64-record window (about 16 days at four runs a
day). After that it is past grace by a wide margin and the orphan rules may
collect it; it is never served, so this is safe, but inspect refusal warnings
before then.

## Staging retention

Staging uses the same planner and executor through
`tools/staging-wind100-retention.mjs` (its own CLI, so the staging controller
never imports it and no import cycle exists). The recurring staging workflow
runs `staging-wind100-retention.mjs reclaim` as "Reclaim retired and
never-activated staging point prefixes", immediately before "Upload one
immutable staging point component" and its capacity check, with production's
step shape: `if` new input, `continue-on-error: true`, `timeout-minutes: 30`,
the same 20-minute budget, 150-second IO bound, progress lines, warnings and
step summary.

Every staging activation now writes an immutable journal record
(`staging-candidates/wind100/journal/<sha256 of the proposed pointer>.json`)
before its compare-and-swap; a failed journal write stops activation before
the pointer. Staging pointers predate journals, so a record's `ancestry` is
`genesis` (first pointer), `journaled` (previous pointer has a record) or
`pre-journal` (previous pointer predates journals, only the first journaled
transition). The planner stops at a `pre-journal` record
(`reachedJournalStart`); a missing record anywhere after it still aborts the
plan. Until the first journaled activation the live staging pointer has no
record at all: the planner then also reports `reachedJournalStart` with
`ancestryRecordsChecked: 0`, protects the live entries and applies only the
orphan rules. Those rules do not depend on the journal: an entry still inside
its grace is both younger than 48 hours (rule 3) and has an unexpired
selection (rule 4). So the first staging run after deployment can relieve a
full prefix before its capacity check instead of being refused and never
writing its first journal record. Prefixes retired before journaling began are not journal-proven: they
are collected only by the orphan rules. Staging reclaim plans and deletes with
the recurring job's existing `STAGING_R2_WRITE_*` token (each deletion through
a prefix-scoped DeleteObject credential on `weatherx-components-staging`) and
refuses production, shared-read and transport credentials. Legacy manual
staging entries (`stage-wind100-<invocation>`) stay protected or referenced but
are outside the recurring namespace and are never candidates. There is no
manual staging cleanup workflow.

## Wind100 source re-pins

New selections and activations must carry the current `sourceSha`. Prior
pointer, journal and selection entries may carry the current pin or one listed
in `previousSourceShas` of `tools/production-wind100-policy.json` (at most
eight). When moving the Wind100 source pin, add the outgoing pin to
`previousSourceShas` in the same change, otherwise activation and retention
refuse the live pointer. Keep it there until no record inside the 64-record
journal window references it (about 16 days at four runs a day). An input
selected under an earlier pin is republished under the current one.

Both paths derive a 15-minute temporary S3 credential restricted to
`DeleteObject` under one journal-proven
`components/point-ecmwf/prod-wind100-recurring-point-ecmwf-<invocation>/`
prefix. Cloudflare documents temporary credentials with bucket, action and
path restrictions at
https://developers.cloudflare.com/r2/api/s3/temporary-credentials/ . The
parent differs by path:

- The approved workflow uses the dedicated cleanup parent token
  (`PRODUCTION_WIND100_GC_DELETE_*`, dedicated to the
  `weatherx-components-production` bucket) plus a separate read-only planning
  token (`PRODUCTION_WIND100_GC_READ_*`) for the production data and component
  buckets; the two must differ.
- Inline reclaim derives its delete-only credentials from the recurring
  publisher's own writer token (`PRODUCTION_WIND100_R2_*`) and plans with that
  same token. It therefore requires that token to hold delete permission on the
  component bucket, and it refuses to run when cleanup or broad credentials are
  present.

Either parent token remains bucket-wide inside its protected runner, so its
environment access and rotation remain important.

The staging point publication measured about 4,140 objects per run. Four
ECMWF runs per day approach the 50,000-object cap within roughly three days
without cleanup. Before setting the protected
`PRODUCTION_WIND100_GC_READY_SHA256` to the reviewed current controller digest,
provision the dedicated publisher and cleanup tokens, protected `data-production-wind100` and
`data-production-wind100-cleanup` environments, enablement variables and
controller digests. Verify the real R2 temporary credential denies adjacent
prefixes and non-delete actions using a controlled disposable object; review
the fault-injection tests for scheduler stalls and partial cleanup. The first
publication creates the production pointer, so a live retention dry run is
impossible before that first run. Enable one guarded writer run, then disable
the writer and run a real R2 dry run against its journal/pointer before enabling
the recurring schedule or approving any deletion. Set the protected writer
enablement and both exact digest variables only after the pre-first-run checks;
a later code or workflow change invalidates the old attestation automatically.

## Landing checklist for this change

Any change to the controller files changes the controller digests, so the
recurring jobs stay gated off until the owner updates them.

1. Merge only after the changes this builds on, then, with no Wind100 run in
   progress, on the merged `main` run `node tools/production-wind100.mjs digest`
   and `node tools/staging-wind100.mjs digest`.
2. Set the production digest in all three production variables:
   `PRODUCTION_WIND100_CONTROLLER_SHA256` and
   `PRODUCTION_WIND100_GC_READY_SHA256` (`data-production-wind100`), and
   `PRODUCTION_WIND100_GC_CONTROLLER_SHA256` (`data-production-wind100-cleanup`).
3. Set the staging digest in `STAGING_WIND100_CONTROLLER_SHA256`.
4. Discard any earlier manual plan. Plans are now `schemaVersion: 2`; run a
   fresh dry run and set `PRODUCTION_WIND100_GC_APPROVED_PLAN_SHA256` only to
   that new `planSha256` before any manual execution.
5. Validation: the first post-merge bake must show one real inline deletion
   with the writer token (the reclaim step reports
   `reclaimed-retired-production-wind100-objects` with `deleted` above zero and
   the upload step's capacity count drops accordingly). A
   `reclaim-budget-exhausted` result is a clean partial run: read its
   `reclaim progress` lines and expect the next run to finish the remainder. If the step instead
   warns that inline reclaim failed, read its log before concluding anything:
   a DeleteObject 403 means the writer token cannot delete, so fall back to the
   approved workflow and treat inline reclaim as not landed; a pointer or plan
   change between passes is transient and the next run retries.
6. Staging (W15): no new secret or variable is needed. Before relying on it,
   confirm the existing `STAGING_R2_WRITE_*` token can delete in
   `weatherx-components-staging` through a prefix-scoped temporary credential:
   the first post-merge staging bake's reclaim step plans only
   never-activated and pre-journal prefixes (`reachedJournalStart`, no record
   yet) and should report `deleted` above zero if any are 48 hours old, with
   no DeleteObject 403; that run's activation writes the first journal
   record. Its
   step summary line starts `Staging Wind100 retention:`. If it warns that
   inline reclaim failed with a 403, the capacity check still decides and the
   token needs delete permission (an owner step).
7. Never-activated uploads (W15): the first production and staging runs after
   merge may delete existing orphan prefixes older than 48 hours. Each appears
   in the step summary as `never-activated <catalog id>`; refusals warn.
