# Cloud-only staging: staged implementation and activation blockers

## Observed 2026-08-31, before any changes

`staging.weatherx.org` serves HTML but has no `health/release.json` receipt. Its platform
health reports `authMode=enforce,billingMode=enabled`; anonymous model/data reads return
401 `claim_missing`. The current Atmos configuration and its verifier explicitly enforce
that obsolete paid staging setup. An app-shell update alone cannot fix it.

The separate Atmos repair changes only staging to public, cacheable weather reads with
billing disabled, adds staging's missing data-health route, and tests anonymous admission,
disabled checkout and unchanged catalog-write authentication. Production configuration,
its separate data Worker, all routes/bindings and active deployments remain unchanged.
This code repair is **not a deployment receipt**. Existing Stripe secrets are neither
read nor revoked by this change; their later retirement is a separate scoped operation.

## Lanes

| Lane | Source | Trigger | Authority |
| --- | --- | --- | --- |
| Staging components (`staging-data.yml`) | Exact SHA matching an independently reviewed environment pin | Manual initially | Staging R2 objects + staging catalog only |
| Staging UI (`ui-staging.yml`, existing) | Exact current master | Manual | Isolated staging Pages only |
| Production UI (`ui-release.yml`, existing) | Exact previously qualified encrypted staging artifact; no rebuild | Owner's manual trigger and environment approval | Protected production Pages only |
| Production weather maintenance/components (existing) | Existing policy unchanged during this setup | Existing schedules | Existing production data authority; no UI authority |

Staging components run on separate GitHub-hosted runners, at most two concurrently, using
the existing validated ECMWF/GFS/HRRR/AIFS component pipeline. The job has no production
target input, Pages/Workers deploy token, UI dispatch or local execution fallback. Existing
staging publishers share the per-model concurrency key. Quality, referenced-byte, horizon,
live-superset, immutable-upload and compare-and-swap promotion gates are not bypassed.
Ordinary provider no-change runs remain successful. A successful no-change run does not
claim the prior component was reprocessed with the newly selected source SHA.

This is the **first guarded lane**, not completion of the full shared-archive architecture:

- Existing regional-model local previews are not cloud-qualified or admitted here.
- Trusted immutable raw snapshots shared read-only between processors still need an explicit
  ingestion/manifest contract. This workflow does not pretend it has eliminated all duplicate
  upstream downloads or convert a previous verification cache into a finished candidate.
- Cross-version processed reuse must bind input hashes, producer/dependency/config identity,
  schema and full inventory, then rerun freshness/compatibility gates. Do not reuse by date alone.
- Production's current default-source selection is **not yet changed to an approved pin**.
  Changing a running production collector's version needs a separate reviewed migration.
- Observation/truth, ledger accuracy and vault maintenance remain in the existing whole-release
  lane. Never disable it as a substitute for model component jobs.
- Staging collection is manual until one actual end-to-end cloud qualification and resource
  audit succeeds. This change does not enable a schedule or resume the paused local sprint.

## Activation is blocked, not silently waived

1. Provide audited **staging-only** backend deployment authority, then deploy the reviewed
   Atmos staging repair through a guarded staging workflow with snapshot/rollback. Current
   credentials must not be reused merely because a secret is named “staging”. No production
   Worker, bucket, route, DNS or billing mutation is allowed. A guarded staging backend
   release workflow is still required; do not use a direct local deployment to bridge this gap.
2. Create/protect `data-staging` (main-only, administrator bypass off). Configure:
   - `STAGING_DATA_ENABLED=false` and `STAGING_DATA_ISOLATION_APPROVED=false` until audited;
   - `STAGING_DATA_APPROVED_SHA`: exact reviewed producer SHA;
   - `STAGING_R2_ACCOUNT_ID`: reviewed account containing staging storage;
   - `STAGING_R2_OBJECT_TOKEN`: API credential limited to the two staging buckets;
   - `STAGING_CATALOG_PROMOTION_KEY`: staging-only signing key. Its target binding must be audited.
   Existing `ATMOS_DEPLOY_KEY` remains read-only source access. Verify actual object-API
   permissions read-only before enabling collection; do not broaden a failing token.
3. Verify staging public health, current catalog + all referenced bytes, whole-release ledger
   and actual point API. The first job intentionally refuses the current 401 setup before
   costly collection. Review both activation flags before setting true.
4. Provision isolated `ui-staging` Pages authority/account/config digest as documented in
   `UI-STAGING-PROMOTION.md`. Current environment has only the candidate encryption key;
   `UI_STAGING_PAGES_TOKEN`, account and reviewed digest are missing. Do not use an
   account-wide credential that can deploy production. Keep production UI disabled.
5. Run exact-master staging UI qualification once, inspect source-bound receipt and real
   browser gates. Only the owner's later manual promotion may touch production.

Changing the staging mode check changes the release-policy fingerprint: older encrypted
UI candidates must be staged again, not grandfathered into a different policy.

References: [Cloudflare environment variables](https://developers.cloudflare.com/workers/configuration/environment-variables/),
[R2 token scoping](https://developers.cloudflare.com/r2/api/tokens/).
