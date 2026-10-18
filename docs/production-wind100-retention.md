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

Run `.github/workflows/production-wind100-retention.yml` with its default
`dry_run: true` to produce a reviewable artifact and `planSha256`. The
separately approved execution recomputes the plan and requires that exact
SHA-256. It re-reads the live pointer before **every** object deletion and
stops if the pointer hash changed. It deletes at most 10,000 objects in one
run and never deletes catalog snapshots, selection receipts or the pointer.
Partial deletion is replayable: a new dry run lists only remaining objects.
An orphaned immutable component from a publication that never activated is
not proved retired and is never collected automatically; it still needs the
separately approved workflow.

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

The cleanup parent token must be dedicated to the
`weatherx-components-production` bucket. The controller derives a 15-minute
temporary S3 credential restricted to `DeleteObject` under one journal-proven
`components/point-ecmwf/prod-wind100-recurring-point-ecmwf-<invocation>/`
prefix. Cloudflare documents temporary credentials with bucket, action and
path restrictions at
https://developers.cloudflare.com/r2/api/s3/temporary-credentials/ . The
parent token remains bucket-wide inside the protected runner, so its
environment access and rotation remain important. A separate read-only token
needs access to the production data and component buckets for planning.

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
