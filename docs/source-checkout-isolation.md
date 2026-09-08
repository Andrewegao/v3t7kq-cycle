# Source checkout isolation — preparation only

This manual probe is the first step toward isolating the UI builder's private
source credential. It does not change `ui-staging.yml`, scheduled bakes, any
publisher, or existing secret. It does not build or execute Atmos source, upload
source artifacts, deploy a site/Worker, or publish weather data.

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

After the source-only probe succeeds, change only the two source checkouts in
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
