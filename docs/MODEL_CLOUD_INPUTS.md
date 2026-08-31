# Additional-model cloud inputs — no serving activation

`model-inputs.yml` is a separate manual, cloud-only pipeline for ICON, HRRR Alaska,
HRDPS, NAM CONUS/Hawaii/Alaska and AROME Antilles. Seven independent hosted runners
use a maximum of three concurrent jobs; each collects one explicit model/cycle
with at most two lead workers. This neither duplicates the four-model production
bake nor changes its source, schedules, credentials, outputs or UI release gates.

The workflow is disabled by default. Its protected `data-staging` environment must
approve `STAGING_MODEL_COLLECTION_ENABLED=true`, the exact reviewed Atmos commit in
`STAGING_MODEL_APPROVED_SOURCE_SHA`, the already-audited staging isolation flag and
account ID. The explicit `source_sha` input must match that approval. Checkout is
full-history for source ancestry validation, never mutable master during execution.
The selected commit must include the separately reviewed cloud collector wrapper.

No R2 credential or encryption secret is exposed to dependency installation or
weather acquisition. Only the final archive step receives the existing bucket-scoped
staging S3 credentials and a dedicated 32-byte hexadecimal `MODEL_INPUT_ARCHIVE_KEY`.
That key must be securely retained for future archive recovery. Completion records
include its nonsecret key fingerprint; changing the key does not migrate old inputs.
No secret or raw/private artifact is uploaded to public GitHub Actions artifacts/cache.

## Data and privacy contract

The original scientific validators must substantiate all 49 hourly leads (0–48),
grid identity, earth-relative paired winds, native masks, source bytes, quantitative
data and exact producer receipts. Existing source receipt holds are unchanged.
The new receipt says `COLLECTED` and `unqualified`, not browser-qualified or serving.
An incomplete or failed source does not cancel other independent model jobs.

All retained files, including original GRIB, quantitative arrays and private
receipts, are encrypted with AES-256-GCM. Fresh random nonces and authenticated
object-key/plaintext-digest context prevent substitution between archive objects.
Object names use hashed relative paths. The only destination is:

```
weatherx-data-staging/staging-candidates/model-inputs/SOURCE/MODEL/CYCLE/RUN-ATTEMPT/
```

This prefix is not a confidentiality boundary by itself. Encryption protects the
private contents even if bucket publicity changes. No serving catalog or pointer
references this prefix. Source bytes and inventories are checked before upload,
each immutable object is fully downloaded and decrypted for comparison, original
inputs are checked again, and an encrypted source receipt is retained. A minimal
nonsecret completion record is written last. Every write uses `If-None-Match: *`;
an existing object must decrypt to the expected bytes, never be overwritten.
Transfer failure can leave encrypted unselected objects but no success record.

Budgets: 30 GiB total retained data, 100,000 files, 512 MiB per file, two archive
transfers at a time, 45-minute acquisition step, 30-minute archive step and a
90-minute per-model job. Existing per-source resource limits still apply, including
NOAA's 20 GiB free-disk check. Actual runner capacity must be measured; no local
timing or synthetic fixture establishes cloud throughput or a completion SLA.

## What is deliberately not done here

- No whole-release or component catalog expansion or model mount.
- No staging/production UI build, deployment or model flag changes.
- No private raw inputs copied into public map directories.
- No inference that additional sources have earned fusion weight.
- No ACCESS-G3/G4 substitution or purchase. The seven additions plus the three
  original screenshot models cover ten screenshot identities, not eleven.

Fresh cloud inputs unblock separate staged layer/point/fusion qualification. They
do not by themselves remove DEV-only model gates or prove live service.

## Verification

```
npm ci --ignore-scripts --prefix staging-controller
node --test tests/model-inputs*.mjs
actionlint .github/workflows/model-inputs.yml .github/workflows/scheduler-ci.yml
```

Tests cover invocation/horizon/source binding, encryption authentication and replay,
immutable private destinations, full readback, tampered inputs and late mutations,
stale completion refusal, credential/command isolation, pagination and truncated
transport. Operational acceptance additionally requires exact-head CI, current
source availability, measured cloud output and independently reviewed receipts.
