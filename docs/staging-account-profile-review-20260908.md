# Staging account profile proposal — not activation approval

Status: local proposal, NOT deploy-ready. Owner merge/profile approval remains outstanding.

## Why a separate profile

Read-only live checks on 2026-09-08 observed staging release `git-a2234f8c2268`
with `platformAccount=1`, platform `authMode=public`, `billingMode=enabled`.
Production remained `git-ee0e95bd6d24-run-34134280748`, observe/disabled.
The existing guarded staging lane expects account-off/disabled, so it refuses
before upload. Turning off the live backend or bypassing the check is not this fix.

## Proposed contract

- Explicit request `release-roster-core-account-v1`, never selected by the existing default.
- Independent protected `UI_STAGING_ACCOUNT_PROFILE_APPROVED=staging-account-v1`
  AND existing core-roster approval are required at request resolution and again
  after authenticated artifact restoration, before deployment and retention.
- Lab, core release roster, account-on, public data, standard compression only.
  No static-br11 overlay, pinned model selection, arbitrary account boolean,
  Worker change, key change, or production eligibility.
- Candidate identity includes the profile and pipeline digest. Its release receipt
  must say Lab/account=1/public. An account-on receipt cannot be relabeled as an
  account-off profile, including after encrypted build transfer.
- Backend mode checks use this exact authenticated profile; legacy staging and
  production profiles keep their old billing-disabled expectations. No unknown
  origin, auth mode or health failure becomes acceptable.
- The existing automatic rollback, fuse, config digest, source SHA, isolated build
  and publisher, data checks, scientific/browser checks and production workflow stay.
- This UI lane does not change backend modes. A mode mismatch rejects before upload,
  including account candidate over disabled backend or baseline over enabled backend.
  Rollback checks the same already-verified external backend mode; do not run this
  lane concurrently with backend/controller settings changes. If future work adds
  mode transitions, it needs separately authenticated prior-mode rollback evidence.

## Additional blockers discovered during implementation

1. The Atmos public release **flag guard and emitted-chunk guard** both prohibit
   account code in staging experiment builds. A narrowly reviewed account-profile
   extension is needed in Atmos, with old production/account-off negatives retained.
   Merely changing Cycle will still fail the build. Do not disable the guards.
   Then bind this profile to a distinct reviewed source-guard ancestor in
   `requiredSourceGuard`; the inherited core ancestor does not attest account support.
2. The current pinned controller does not emit the required build-profile metadata.
   Qualify and pin a controller that does; never synthesize or weaken the receipt
   assertion to accept missing evidence. Both staging pin sites must agree.
3. Qualify the exact account-enabled built artifact: account surface and API failure
   isolation, weather readiness, normal/throttled cold and warm startup, repeated
   session teardown/memory, and Copilot relay behavior. Previous account-off build
   timings do not qualify this different profile. Chromium throttling is not China
   network evidence.
   Existing workflow-level prebuild checks use account=0; they are not a substitute
   for account-on qualification or an exact allowed account endpoint/chunk inventory.
4. Source PRs require explicit owner default-branch merge authorization and exact
   integration-SHA CI. The protected account approval must not be set before the
   coordinated contract is reviewed. No such variable was set in this task.
5. Re-read live modes, receipt identities, configuration digest and fuse immediately
   before the already-requested staging-only deployment. Capture exact rollback
   deployment. Verify production's release identity unchanged afterward.

## Local evidence

`node --test tests/ui-*.mjs`: 126 passed, 0 failed, 0 skipped. New controls cover
independent approvals, invalid/combined profiles, old-default preservation,
production refusal, receipt/profile mismatch, encrypted transfer and same-attempt
admission. These are contract tests, NOT successful live qualification.

Combined UI + staging-data/shared-data isolation checks: 147 passed, 0 failed,
0 skipped. Directly calling the current Atmos guards with the proposed Cycle
build environment confirms the flag guard rejects account=1; the chunk guard
independently rejects an account endpoint. This is a demonstrated activation
dependency, not a suspected flaky test. Neither guard was modified here.

Independent read-only review found no remaining bypass in the profile/approval,
production isolation or anti-relabel logic; it confirmed the source/controller/
account-on qualification blockers above. A proposed rollback-transition concern
was rechecked against the actual preflight ordering and withdrawn: both cross-mode
directions reject before upload. The no-concurrent-backend-mutation assumption remains.

No workflow dispatch, merge, protected-variable write, Cloudflare mutation,
production deployment, billing activation, or weather-data publication occurred.
The encryption/Fusion migration goal is separate from this release-profile proposal;
it is not completed by allowing a staging UI build.
