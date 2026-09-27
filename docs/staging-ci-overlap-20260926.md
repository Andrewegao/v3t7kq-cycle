# Staging full-app gate overlap — bounded implementation

Task: improve staging elapsed time without removing validation, weakening locale approval,
executing candidate code on a publisher, or changing same-artifact production promotion.
Baseline Cycle revision: `fdcbdb439f46ebc00fd55529d51876a76b8c310b`.

## Evidence and intended effect

Three successful staging runs serialized complete app tests before the Weather Lab gate:

| GitHub run | Build job | Full app step | Weather Lab step | Qualifier job |
| --- | ---: | ---: | ---: | ---: |
| 36274751260 | 1280 s | 408 s | 565 s | 500 s |
| 36270051828 | 1317 s | 410 s | 565 s | 642 s |
| 36228669620 | 1304 s | 385 s | 513 s | 508 s |

The new dependency graph is `profile → [build, app-tests] → qualify`. The full test
command, dependencies and selected CI profile are unchanged. If the new test job finishes
before the shortened build job, the possible reduction is the former 385–410 seconds of
serial tests. Additional checkout/install/runner queue time can reduce that benefit. This
is a projection, not a measured cloud improvement. Runner minutes can increase. Tests can
run even when a sibling build preflight rejects; the build's preflights still precede all
its expensive work and no qualification occurs on either failure.

## Receipt and isolation contract

The source-read test job emits a small public-metadata receipt only after the full test step
succeeds. It binds the exact Atmos SHA, Cycle workflow SHA, resolved release profile,
corresponding CI profile, run ID, attempt and complete command. It checks its actual checkouts
and trusted workflow environment before emitting. The publisher compares every field to its
own expected context and independently requires GitHub's one successful `app-tests` job and
successful `full application test gate` step for that same workflow/run/attempt. A missing,
malformed, extra-field, skipped, failed or stale-attempt receipt rejects before download
unpacking or restoration. Job output is evidence, never publication authority.

The existing successful-build/artifact/profile/policy checks still run, as do exact candidate
qualification, encrypted retention, staging-currentness verification, protected production
approval, same-file promotion and automatic rollback. The new helper is in the pipeline
policy digest. No candidate source, dependency cache or executable test output is transferred
to the publisher. No production or TC workflow is changed. Partial reruns must retain the
existing exact-attempt discipline: an old test output cannot substitute for this attempt.

## Validation and acceptance

Run `node --test tests/ui-*.mjs`, install the locked inventory tool dependency, then run
`node --test tests/workflow-inventory.mjs`, `node tools/workflow-inventory.mjs --check`, and
`git diff --check` with Node 22. Negative tests cover wrong source/profile/controller/run/attempt,
missing or malformed receipts, incomplete gates, skipped/failed jobs, and producer identity.

Before claiming a speedup, perform an owner-authorized cloud staging run on the reviewed
source/profile. Confirm both jobs actually overlap, the publisher accepts only their current
attempt, the complete test count is unchanged, and staging qualification passes. Compare
job/step timings and queue time to the samples above. No dispatch, deployment or production
promotion is authorized by this document. Revert the isolated overlap change if the new
critical path or resource cost is unacceptable; do not remove necessary gates to force a win.

Local result (Node 22.21.1, macOS): UI contracts 210 passed, 0 failed, 1 existing
GNU-timeout/Linux process-group test skipped because GNU timeout is unavailable here.
Workflow inventory tests 10/10 passed; regenerated inventory check and diff whitespace check
passed. The real Linux process-group test remains a cloud requirement. No cloud run performed.


The receipt metadata fixture is an unmodified successful historical GitHub `build` job
from run 36274751260, fetched again through the attempt-specific API before commit. It
confirms numeric `run_id`/`run_attempt`, the Cycle `head_sha`, and the complete app gate's
status, conclusion and 408-second duration. The test rejects that old job as sibling
proof; a clearly labeled name-only adaptation tests API compatibility. It is not evidence
of a deployed or cloud-executed `app-tests` job.
