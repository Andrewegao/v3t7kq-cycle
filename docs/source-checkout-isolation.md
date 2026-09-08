# Source checkout isolation

The manual probe is the first step toward isolating the UI builder's private
source credential. It does not build or execute Atmos source, upload source
artifacts, deploy a site/Worker, or publish weather data. The subsequent builder
migration below changes only the staging build job, not any publisher, scheduled
bake, production UI workflow or existing secret.

## Prepared builder migration — not activated

On 2026-09-08, the owner-approved checkout-only probe passed in run
34278389312 at Cycle 393c4f1. Independent API checks confirmed the distinct key
is read-only, the environment permits only branch `main` (not tags), contains
only `ATMOS_READONLY_KEY`, and has no environment variables. The probe enable
switch was returned to false after the test; no existing consumer was migrated.

The proposed `ui-staging.yml:build` migration selects that key-only environment,
adds manual/main job admission before runner execution, refuses a missing key
before any checkout, and uses the new key for exactly two source checkouts.
Checkout credential persistence remains disabled. Profile resolution, private
candidate encryption, application/release gates, publisher isolation, and the
production workflow are unchanged. Missing access stops a new release before
qualification; it cannot change an already served site.

Do not merge/activate this candidate until the separately approved denied-ref
environment integration check is recorded. The successful source-only probe and
local mutation tests are not substitutes for that negative policy check. Never
dispatch the staging release just to test credentials.

This workflow is part of the candidate pipeline digest: after migration a new
staging qualification is required before promotion; do not relabel or reuse an
older candidate under the changed policy.

Limitations: existing repository `ATMOS_DEPLOY_KEY` still serves other consumers.
This change is one consumer migration, not complete repository-wide credential
isolation. Protected-main workflow authors remain trusted. Keep the source-only
environment free of additional secrets and variables; a variable added later
could change build configuration through environment precedence. No browser,
runtime API, weather-processing, dependency or rendering code changes here, so
this change introduces no client-side memory or network work.

## Before enabling or dispatching

An owner must provision and review the following separately:

1. A distinct, read-only Atmos deploy key. Do not rotate/revoke the existing key.
2. A new Cycle environment `atmos-source-read-ui` with a custom branch policy for
   exactly `main`, no tag admission, no review delay, and no publisher, storage,
   decryption or signing secrets. Do not reuse `ui-staging` or `ui-production`.
3. Store only the new source credential as `ATMOS_READONLY_KEY` in that environment.
   There must be no repository/organization secret with this new name: otherwise
   a missing environment secret could fall back to a broader source credential.
4. Independently inspect the environment rules and secret **names**, never dump
   secret values. Only then set the Cycle repository variable
   `SOURCE_CHECKOUT_PROBE_ENABLED=true`.

These provisioning/settings actions are NOT performed by this PR. Leave the
probe disabled until the environment exists; GitHub can create an unconfigured
environment if a workflow references a missing name.

## Probe

After review/merge and provisioning, dispatch `source-checkout-probe.yml` on
Cycle `main` with `atmos_sha` equal to the reviewed current Atmos master SHA.
Admission runs without environment secrets and rejects disabled, malformed,
non-main, non-manual or wrong-repository contexts. The credential job checks out
only README metadata at the existing controller pin and at current master; both
identities are checked. It runs no checked-out private code and retains no source
artifact. A concurrent master advance causes an honest mismatch/refusal; review
the new SHA and dispatch again, never relax the comparison.

This tests whether the supplied key can read the required references. It does
not prove key read-only status, environment branch restrictions, or denial of
untrusted callers by itself: check the deploy-key API's read-only metadata and
environment policy independently, and perform an explicitly approved denied-ref
probe before migration. Unit tests prove code admission rules, not remote policy.

GitHub may show an environment/deployment tracking record for the credential job;
that is not a Cloudflare or application deployment. The workflow has no publisher
steps, tokens, source execution, or paths to the UI qualification job.

## Subsequent migration — separate review

After the source-only and denied-ref probes succeed, change only the two source checkouts in
`ui-staging.yml:build` to the new key-only environment and distinct secret name.
Do not move the publisher/decryption credentials into the build job. Keep
repository `ATMOS_DEPLOY_KEY` for all other consumers until individually migrated
and verified. Never use a deployment run merely to test a new credential.

The current UI candidate policy remains unchanged by this probe. Future UI
promotion still requires fresh staging qualification after Cycle PR #187.

## Local checks

```
node --test tests/source-checkout-probe.mjs
actionlint .github/workflows/source-checkout-probe.yml .github/workflows/scheduler-ci.yml
```

Reference: [GitHub environment secret and branch-policy semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).
