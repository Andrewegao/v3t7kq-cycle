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
journal-proven retired. No path collects it today, neither inline reclaim nor
the approved workflow; collecting never-activated uploads is a tracked
follow-up.

## Inline reclaim in the recurring publisher

Each new-input production run reclaims journal-retired prefixes past grace
before its capacity check (`production-wind100.mjs reclaim`, the step before
"Upload one immutable production point component"). It uses the same planner
and the same executor as the approved workflow: protected current and rollback
entries are excluded, the plan is recomputed and must match, and the pointer
is re-read and hash-checked before every deletion. Because the planner can only
propose journal-proven retirements, this class needs no human plan hash. The
step uses only the job's existing dedicated writer token; each deletion goes
through a 15-minute `DeleteObject` credential minted from it for one prefix.
It refuses cleanup-environment and broad credentials. The step is
`continue-on-error` with a 30-minute bound: if reclaim fails, the capacity
check in the upload step still decides and nothing is published past the cap.

Every awaited reclaim step (module load, IO setup, catalog validator, and each
get, list, delete-credential mint and delete) must settle within 150 seconds,
above the SDK's own 120-second request abort. Otherwise the command exits 1
with `inline reclaim failed (stage …; completed gets …, lists …, delete
credentials …, deletes …)` naming the call that hung; nothing is retried and
no further deletion is attempted. The CLI entry uses no top-level await: the
retention module imports `production-wind100.mjs`, and a top-level await there
deadlocked the reclaim module import (bake run 39176755083 exited 13 after
about 50 ms with no IO, so the cap was never relieved).

The capacity check prints existing, planned and maximum object counts when it
refuses, and emits a `::warning::` when fewer than three publications of the
planned size still fit (counting the current one). At four runs a day the
steady state holds about six prefixes (about 25,000 objects); a missed reclaim
is caught up by the next run's two-candidate budget.

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

1. On the merged `main`, run `node tools/production-wind100.mjs digest` and
   `node tools/staging-wind100.mjs digest`.
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
   the upload step's capacity count drops accordingly). If the step instead
   warns that inline reclaim failed, read its log before concluding anything:
   a DeleteObject 403 means the writer token cannot delete, so fall back to the
   approved workflow and treat inline reclaim as not landed; a pointer or plan
   change between passes is transient and the next run retries.
