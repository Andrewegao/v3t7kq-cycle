# Staging place data completion — 2026-09-10

## Scope and acceptance

Owner approved staging-only implementation and deployment. Production UI, Worker,
configuration, pointers and data are excluded. Never dispatch the shared weather bake.

1. Search: schedule bounded renewal of the current approved immutable directory.
   Revalidate both files and their receipt before a CAS lease extension. Preserve
   original `baked_at`: availability renewal is not a fresh source collection.
   Missing, revoked, expired, foreign or corrupt candidates must not be revived.
2. Surf: qualify current complete NOAA wave/wind inputs, exact 49-spot inventory,
   full product horizon and per-object integrity, then publish staging only.
3. Paragliding: paced/resumable collection with attribution and source terms;
   maintainer notice is a separately tracked external prerequisite.
4. Tide: paced/resumable full catalog collection, qualified six-minute reference
   grids and events, all-station completeness before staging activation.

## Implementation order

Search renewal first (temporary pointer expires 2026-09-11T07:03:32.889Z).
Collectors are independently reviewed in parallel. Each place family receives its
own immutable completion receipt and activation boundary; one unavailable family
cannot disable other families. No unrestricted paths or shared production writer.

## Verification

Negative tests cover revoked/expired/corrupt search receipts, schedule escalation,
CAS races and unrelated credentials. Run workflow lint and all affected controller
tests before review/merge. Validate actual staging responses after cloud activation.
Production baseline: `git-ee0e95bd6d24-run-34134280748`, index SHA-256
`9d3a322159b59efac25ad5e8a73e1b6844820d496b56d8579bb2793c4a931cf7`.
Read-only production health and identity checks precede and follow staging changes.

## Current status

In progress. No new publication, schedule activation or Worker deployment yet.
Search renewal intentionally changes the original manual-only search policy;
prepare/activate/revoke remain manual and schedules can only extend an existing
approved live candidate. Original metadata provenance remains unchanged.

Schedule admission uses repository `STAGING_SEARCH_SCHEDULE_ENABLED`; the credentialed
job separately requires environment `STAGING_SEARCH_RENEWAL_ENABLED`. Both default
off. Do not create same-name overrides in another variable scope. Disabling either
stops unattended writes. Every six hours at minute17 the job validates the same
approved pair and renews a24-hour lease; scheduler delays are not guaranteed away.
Manual `renew` exercises the same validation and environment approval. Existing
revocation/manual activation remain separate. No live weather freshness is claimed.
