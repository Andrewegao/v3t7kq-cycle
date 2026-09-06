# Staging latency qualification controller

The owner requested the merged latency implementation and other merged changes
on staging, without a production UI deployment. Staging run 34002968537 rolled
back its candidate after the browser tint gate expected a fractional Deck fade
from an independently native Temperature preview. That preview legitimately
hands off atomically. A subsequent throttled reproduction also showed the gate
rejecting a legitimate exact-native Wind to complete-grid Deck handoff.

The staging controller update is limited to the causally validated tint harness
and deterministic contracts. It retains a real Cloud Deck fractional-fade and
texture-eviction exercise, independently requires Temperature paint, and requires
actual rendered-field proof before accepting the specific Wind handoff. Source,
run, bracket, camera, opacity, pixel/tint and error safeguards remain required.
The controller is a minimal backport onto reviewed `18a298cdf4896e1f2c2116dbecd1cecf8434a609`,
not a blanket upgrade to the latest application's unrelated health-verifier rules.

Update both staging controller checkouts and `STAGING_CONTROL_SHA` together.
Production `CONTROL_SHA` and `ui-release.yml` remain unchanged. The policy digest
changes deliberately: older retained UI artifacts are not implicitly reapproved.
Use the already reviewed `release-roster-core-v1` profile; `none` intentionally
selects the unchanged baseline controller and does not exercise this repair.

No Pages configuration, platform Worker, credentials, data pointer, freshness
policy or production UI changes belong to this staging-controller patch. The
existing guarded deploy, real-site qualification, automatic rollback, release
fuse and encrypted artifact retention remain the required deployment path.

## Verification

Reviewed controller: `f96a94370fd536f700f5a756bdc4075d14716d78`. Its four
executable/contract files are byte-identical to Atmos PR #165 commit
`1d6e5cb4a354e02e214d5a5ce1f65259a302bc36`. The remaining diff from `18a298`
is an evidence task document. The nine required controller suites pass, including
59 direct proof/negative tests, 10 release-gate contracts and the app fast suite.
Strict test inventory passes. Root independently passed the exact controller's
full tint gate against immutable latency UI plus a staging-data Range relay under
CPU4 SwiftShader, with no page/WebGL errors. Upstream normal, throttled and
controlled natural-takeover gates passed; the latter verifies actual Deck frame
hashes and a new completed draw with zero changed-pixel ratio.

All 85 Cycle UI architecture, approval-boundary, job-isolation, candidate,
transport, preflight and workflow tests pass. `actionlint` and diff whitespace
checks pass; production workflow has no diff.

Cycle issue #167 was closed after the reviewed source and controller activation
checks passed. Closing the diagnosed fuse authorizes only a fresh guarded staging
attempt, not a production promotion or a bypass of final live qualification.

## Temperature paint-readiness follow-up

Run 34005832567 then stopped before deployment because its source gate sampled
Temperature after 180 ms, before the real render had completed. A controlled
800 ms scheduling delay reproduced that false failure, followed by correct paint
with unchanged source and forecast cursor.

The new staging-only controller is `b64f31a1388e8104c18a65a445d156070de5087b`.
Its four harness/contract files exactly match Atmos PR #166 source
`cdf6e2b7a203aaa6cb50e8772a97f4e621a20f07`. It waits at most 30 seconds for a
new exact Temperature post-draw receipt, retaining source, time, intent and swap
checks. Native proof survives a legitimate preview retirement; Deck proof needs
a completed draw and accepted matching flush, not merely scheduled opacity.

All 89 direct cases and independent review pass, including stale/wrong receipts,
missing draws and retired previews. Live CPU4 software-rendering, controlled
delay and actual native-Temperature controls pass without final pixel drift or
page/WebGL errors. Controller ready receipt `d325db52ed53` passes all nine suites.
Production controller and workflow, Worker code, credentials and data are unchanged.
The full source release gate and final live staging transaction remain required.
