# Staging account profile proposal — not activation approval

Status: owner approved the coordinated staging-only merge/profile work. Atmos #193 merged as `edaf42ed5832eb1cacd5637a6c87bc1aa17c6891` after all nine final-head CI checks passed. Staging-only controller pins now use that reviewed merge; this Cycle change still requires final CI and merge before activation.

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
- The pinned controller runs the account browser qualification inside the rollback
  transaction: anonymous session, 401/503/real client timeout, weather isolation,
  30 account-panel cycles and normal/slow cold/warm navigation. It receives no
  publishing or provider credentials. Only a bounded successful receipt matching
  the candidate source/release and controller harness hash can be retained.
  Retention binds the sanitized metadata digest into the encrypted candidate;
  elapsed retention time alone does not invalidate that already-bound proof.
- This UI lane does not change backend modes. A mode mismatch rejects before upload,
  including account candidate over disabled backend or baseline over enabled backend.
  Rollback checks the same already-verified external backend mode; do not run this
  lane concurrently with backend/controller settings changes. If future work adds
  mode transitions, it needs separately authenticated prior-mode rollback evidence.

## Additional blockers discovered during implementation

1. The old Atmos public release **flag guard and emitted-chunk guard** prohibit
   account code in staging experiment builds. Atmos #193 implements a narrowly
   reviewed account-profile extension with old production/account-off negatives retained.
   Merely changing Cycle without that merged source still fails. Do not disable the guards.
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
4. Owner has approved the coordinated source/profile merges, but exact final-head
   CI and browser evidence remain required. The protected account approval must not
   be set before the coordinated contract is reviewed. No such variable was set yet.
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

## Continuation evidence

The new account-proof contract tests pass (9/9, independently rerun). They reject
missing/stale/oversize/non-regular/linked proof files, wrong source/release/harness,
invalid time bounds and modified retained evidence. Reads allocate at most the
fixed byte limit plus one byte and reject concurrent file changes. Nested retained
fields follow the pinned harness's metadata contract; top-level projection is not
a general-purpose secret redactor for arbitrary future fields.

Independent execution-path review found that another full pre-upload account browser
run would duplicate the exact-profile local evidence without proving Pages Functions.
Final artifact/profile/receipt authentication before upload plus the real deployed-site
proof inside rollback remain mandatory. The old staging controller pin lacks this
harness; both staging workflow checkouts, STAGING_CONTROL_SHA and the account source
guard must be fixed to the reviewed merged Atmos SHA before activation. Production
controller/workflow pins are unchanged.

The staging workflow selects only between two reviewed literal controller SHAs:
resolved `none` keeps the existing production-compatible controller, while every
validated staging-only profile uses STAGING_CONTROL_SHA. This mirrors
`controlShaFor(profile)` and avoids breaking the legacy staging path when the
staging pin advances. No caller-supplied SHA is interpolated into controller ref.

Latest combined local checks: 129/129 UI contracts and 21/21 shared/staging-data
isolation contracts passed. The legacy profile-propagation test counted every
mention of the selected output, including the two new checkout references; its
assertion now requires exactly two full environment-assignment lines, while the
workflow test independently requires both exact bounded controller expressions.
No deployment gate or behavior assertion was removed.

The exact account-enabled local artifact passed the final normal/slow, cold/warm,
30-cycle browser qualification using two samples per timing. Account failures
preserved weather; no positive measured lifecycle memory growth. Slow cold weather
readiness remained about 24.2 seconds versus 22.9 seconds on live staging. The
different local/live transport paths and small sample size are explicit limits;
this is not a China-network or no-regression guarantee. Fresh credential-free
staging point preflight passed four probes at two locations before deployment.
Atmos final head `3056f713de0a7525164db23895c5389bb389fd3b` passed all nine CI
checks and merged as `edaf42ed5832eb1cacd5637a6c87bc1aa17c6891` at 02:53:51Z.
Both staging-only checkout literals and STAGING_CONTROL_SHA now use that merge;
baseline/production retain `25c402db5149daa018e349a34a4beeba1f2dca45`.
