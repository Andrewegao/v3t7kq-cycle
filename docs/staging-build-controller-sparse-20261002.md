# Staging build controller sparse checkout

Task: `WX-CYCLE-STAGING-BUILD-CONTROLLER-SPARSE-S6-20261002`.
Base: actual merged Cycle PR #356, `b65c4de785e8c467598a402332d0e4c246866eb9`.
Status: implemented and independently reviewed; required local contracts and the regenerated
workflow inventory check passed. Preparing an isolated draft PR; no merge or deployment.

The combined-Wind staging build previously materialized the complete reviewed Atmos controller.
Historical run `37082966026` spent 123 seconds checking out that controller, and 100 seconds
checking out the qualification controller. These observations predate PR #356; they do not
measure this sparse change or establish a saving. Build's Weather Lab gate remains the largest
measured stage. This task reduces only the unnecessary build-controller source materialization.

The existing pinned checkout action receives four anchored noncone patterns only when the
resolved selector is `production-account-ru-kk-wind100-onboarding-v2`:

- `/.gitignore`
- `/platform/edge/package.json`
- `/platform/edge/package-lock.json`
- `/ops/release/build-release-receipt.mjs`

The unchanged five-arm ref mapping selects literal Atmos S5
`ee6c16fa59b35204e999ae2ffccb66b75578bf83` for that selector. The existing controller guard
still verifies actual HEAD and a clean tracked diff. Empty interpolated lines leave the pinned
action's sparse input unset for every other selector, preserving its full checkout. No explicit
filter or depth change is introduced. At action `11d5960a326750d5838078e36cf38b85af677262`,
nonempty sparse input selects `blob:none` and these patterns use noncone mode.

Qualification, candidate Atmos, app-test and Cycle source checkouts are unchanged. Build keeps
its original candidate app install, controller edge install, Chromium install, Weather Lab,
Functions build, profile receipt, encryption and artifact gates. Qualification keeps its full
controller source, app/edge installs, actual account/public probes, platform verifiers, guarded
deployment and rollback. No source pin, authority, protected variable, deadline or quality
predicate changes. The workflow is a policy-digest input; old policy-bound evidence does not
qualify a successor run.

## Local closure evidence

An isolated local object-backed clone at exact S5 used actual Git noncone sparse checkout.
It materialized exactly four tracked files, totaling 137,945 source bytes. Every file matched
its pinned blob, HEAD/tree matched S5, and the tracked diff was clean. This local full-history
object reuse establishes layout and identity, not hosted depth-one partial-fetch behavior or
transferred pack bytes.

The unchanged S5 receipt fixture passed against the actual sparse builder. Its test-only
`app/src/build/publicReleaseGuard.ts` comparison input and test script lived in a separate
explicit harness; they are not added to the production closure. The original edge lock installed
89 packages with `npm ci --offline`, and its real Wrangler binary returned `4.123.0`, matching
the lock. That binary also compiled an inert local Functions fixture with the unchanged
Cycle build flags and generated its route file; this is not real candidate qualification.
The combined profile's original preflight returned `required-after-build`; removing
the receipt builder refused before build and restoration returned the clone to a clean diff.
A synthetic preflight is not combined production artifact qualification.

The existing production dependency fixture and broad production sparse assertions remain
intact; the new `stagingBuild` inventory is a separate closure. Existing historical production
fixture executions cannot qualify this S5 four-file layout. New contracts reject a missing
runtime input, a changed literal controller pin, or a different sparse profile, and preserve
other profiles' full input plus the original source/dependency/gate boundaries.

Final local checks: 272 UI contracts passed, with one existing macOS process-group test
skipped; the scheduler UI contract and all ten inventory contracts passed. The first UI run
retained a sandbox-only loopback listener refusal, resolved by the existing inert local-test
permission. The initial new contract mistakenly expected three full-history Cycle checkouts;
base inspection confirmed two, and the corrected assertion preserves that actual baseline.
The first generated inventory `--check` ran and failed with STALE. After the Train3 writer
sealed its branch and root explicitly handed off the generated-file scope, this isolated branch
ran the unchanged generator and its final `--check` passed. External expected inventory bytes
were diagnostic only; generation used the actual candidate source.

## Sequential integration

Cycle PR #357 is sealed at `248decd139c50c076ceaae043b55a936c5bfc06b` and also changes
`docs/WORKFLOWS.md`. Root owns its admission and merge order. This branch stays on actual
merged main `b65c4de785e8c467598a402332d0e4c246866eb9`; it neither imports Train3 changes
nor edits that checkout. Serialize both integrations and regenerate the inventory from their
combined source instead of choosing one generated snapshot. Recheck the actual combined head
and current base with the required contracts and hosted CI before either dependent handoff.
The overlap is not considered resolved merely because each draft has its own green checks.

Run with Node 22 from Cycle root:

```sh
node --test tests/ui-controller-checkout.mjs
node --test tests/ui-*.mjs
node scheduler/test-ui-release-contract.mjs
node --test tests/workflow-inventory.mjs
node tools/workflow-inventory.mjs --check
```

The source implementation and local evidence do not qualify a real candidate Functions build,
combined artifact, protected staging release, or hosted speed improvement. Keep all normal
required hosted gates. No workflow dispatch, provider capture, browser/performance campaign,
merge or deployment is authorized by this task record.
