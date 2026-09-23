# Production native Wind100 retention

The recurring publisher is still unavailable: its policy remains
`unavailable-until-pointer-ancestry-gc`, and the production gate refuses it
before credentials or writes are used. The new cleanup workflow is also
default-disabled. Neither feature can be enabled by a repository variable
alone.

Every successful pointer transition now writes an immutable journal record
*before* compare-and-swap. The record is named by the SHA-256 of the proposed
pointer body and contains the previous pointer body and hash. A failed CAS
leaves an unreachable record; the cleanup planner starts at the live pointer
hash and follows only its contiguous, verified journal chain. It rejects a
missing, malformed, altered or cyclic link. It derives retired entries from
those transitions, verifies each selection and catalog by their recorded
hashes, and excludes both current pointer entries. It selects at most one
expired candidate per plan, only after 18 hours beyond `freshUntil`.

Run `.github/workflows/production-wind100-retention.yml` with its default
`dry_run: true` to produce a reviewable artifact and `planSha256`. The
separately approved execution recomputes the plan and requires that exact
SHA-256. It re-reads the live pointer before **every** object deletion and
stops if the pointer hash changed. It deletes at most 5,000 objects in one
run and never deletes catalog snapshots, selection receipts or the pointer.
Partial deletion is replayable: a new dry run lists only remaining objects.
An orphaned immutable component from a publication that never activated is
not proved retired and is never collected automatically.

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
without cleanup. Before changing `retentionProfileStatus` to
`verified-pointer-ancestry-gc-v1`, provision the dedicated publisher and
cleanup tokens, protected `data-production-wind100` and
`data-production-wind100-cleanup` environments, enablement variables and
controller digests. Verify the real R2 temporary credential denies adjacent
prefixes and non-delete actions, then run a dry run against actual production
candidate metadata. Exercise a stalled scheduler and partial cleanup before
approving execution. A code-reviewed policy change plus new controller digest
is required to enable the recurring writer.
