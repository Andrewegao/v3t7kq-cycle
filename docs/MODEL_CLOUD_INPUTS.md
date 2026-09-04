# Additional-model cloud inputs — no serving activation

`model-inputs.yml` is a separate manual, cloud-only pipeline for ICON, HRRR Alaska,
HRDPS, NAM CONUS/Hawaii/Alaska and AROME Antilles. Four provider-aware hosted runners
may run together: DWD, ECCC and Meteo-France each have one independent model runner,
while one NOAA runner acquires HRRR Alaska and the three NAM nests sequentially.
Every collector still uses at most two lead workers. Each completed NOAA acquisition
is immutably archived even when a sibling fails, in joined pairs of no more than two.
A final step without archive credentials still fails the job on any acquisition or
archive failure. Missing or partial roots are never archived. This neither duplicates the four-model production
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
The workflow caches only public package-manager downloads, pinned by the checked-out
`requirements.txt` and `package-lock.json`; model bytes, receipts, raw caches and output
directories remain outside Actions caches.

## Data and privacy contract

The original scientific validators must substantiate all 49 hourly leads (0–48),
grid identity, earth-relative paired winds, native masks, source bytes, quantitative
data and exact producer receipts. Existing source receipt holds are unchanged.
The new receipt says `COLLECTED` and `unqualified`, not browser-qualified or serving.
An incomplete or failed source does not cancel other independent model jobs or discard
completed NOAA siblings; their immutable staging archives remain independently usable.

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
transfers per model, at most two NOAA model archives at once, 45 minutes per NOAA
acquisition, 30 minutes per NOAA model archive, and 90 minutes per independent-model
job. The combined NOAA runner has a 120-minute fail-closed cap. Existing per-source resource limits still apply, including
NOAA's 20 GiB free-disk check. Actual runner capacity must be measured; no local
timing or synthetic fixture establishes cloud throughput or a completion SLA.

The successful 2026-09-01 06Z run took 55 minutes with a generic three-runner pool.
Its measured NOAA acquisitions totalled 13.89 minutes; two joined archive pairs project
22.53 minutes from the same run's archive timings. Including one shared setup gives a
37–38 minute NOAA path, while the independent HRDPS path measured 34.48 minutes. The
expected critical path is therefore about 38 minutes (roughly 17 minutes, or 31%,
shorter). Dependency-cache hits may save another measured 0.5–1.5 minutes, but are not
part of the scientific or publication acceptance contract. Disjoint append-only
per-model qualification approvals could remove a later 10–17 minute serialization;
that authority redesign is deliberately not included here.

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

## Production path (2026-09-04, feat/models: regional models in the production release)

The manual staging pipeline above is unchanged. Production collection of the same seven models
now lives inside `bake.yml`: a `regional` job matrix (icon, hrdps, arome-antilles, noaa) runs
`data/bake_regional_models.py collect` on the bake's approved Atmos commit, each family on its own
runner, and hands 150-file public display packs (never raw GRIB) to the `bake` job as one-day
Actions artifacts. The bake job's `data/bake.sh` installs verified packs as `data/<model>/`, carries
a previous release's pack forward while its run is under 24 h, and writes `data/model-roster.json`
(fresh / carried / absent with the collector's attempts). The bake job joins the families with
`needs: regional` + `if: always()`, so a late provider only makes its model abstain. Cycle policy:
newest six-hour cycle, then one older cycle inside the collectors' unchanged 12 h window; AROME
tries the older cycle first (measured 7 h lag). No R2, Pages or catalog credential reaches the
family jobs. Tests: `node --test tests/bake-regional-models.mjs`.
