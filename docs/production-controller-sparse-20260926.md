# Production controller sparse checkout — bounded task

Task: reduce unnecessary production controller checkout work without changing the artifact,
controller pins, dependency installation, release authority, probes or rollback. This change
is isolated from staging-test overlap and modifies only the production workflow's Atmos
controller checkout. No staging checkout is changed.

## Evidence and decision

Production run 36233095917 spent 90 seconds checking out reviewed Atmos controller 9da64b54:
about 77.97 seconds fetching and 11.11 seconds checking out 28,847 files. Cycle's own checkout
took 1 second. Run 35964035188 spent 63 seconds on Atmos and 2 seconds on Cycle. These are
historical observations; no sparse cloud run or time improvement is claimed.

Retain the full `app`, `ops`, `platform`, `data`, `tools`, `testing`, `scripts`, `docs/admin`
and `docs/engineering` directories plus root/intermediate-directory files included by Git cone
mode. This conservative selection preserves probes, dynamically spawned release helpers,
local assets and test data without maintaining a minimal executable-only checkout. The
large omitted trees are design/audit screenshots and `windy-run2`. The pinned checkout action
selects `blob:none` for sparse checkout; its existing depth-one literal controller ref and
credential removal remain unchanged.

Cycle's separate `fetch-depth: 0` stays intact: `auditRun()` fetches Cycle origin/main and
checks the staging workflow revision is its ancestor. No ancestry proof uses the sparse Atmos
history. `controller()` still checks exact Atmos HEAD and a clean tracked diff. No cache is
introduced. Both locked dependency installations, Chromium setup, current-staging proof,
three consecutive production probes, exact-byte upload and automatic rollback remain.

## Four-pin proof

Local temporary object-backed clones used actual Git sparse checkout at every production
controller pin. The runtime dependency inventory covers the guard, receipt builder, Pages
client, fuse, platform/weather/point verifiers, browser probes and relative imports. Combined
profile additionally retains `public-release-journeys.mjs`; newer pins retain locked Wrangler.
Browser external packages remain installed from the unchanged app lockfile; Wrangler remains
installed from the unchanged edge lockfile.

Each sparse tree passed all five existing fixture suites:

- `ops/release/test-build-release-receipt.mjs`
- `ops/release/test-pages-client.mjs`
- `ops/release/test-release-fuse.mjs`
- `ops/release/test-production-verifiers.mjs`
- `ops/release/test-guard-pages-deploy.mjs`

That is 20 successful fixture executions across four pins. Each tree's dependency bytes matched
its pinned Git blobs. Removing the real dynamically invoked `verify-point-series.mjs` caused
the dependency check to reject; restoring it returned the tree to a clean tracked diff.
No real site was deployed or browser-tested by these local fixture suites.

`tests/fixtures/ui-controller-dependencies.json` records the reviewed per-pin dependency paths.
`tests/ui-controller-checkout.mjs` holds the selected directories, exact pin inventory, unchanged
Cycle ancestry, dependency/gate installation and no-cache constraints. It rejects omission of
app, ops or platform, including a mutation that retains ops/platform but loses ops/release.
A later controller-pin change must recheck the actual sparse tree and update this inventory.

Reproduce the local path/fixture proof with a temporary local clone of an existing Atmos
repository: `git clone --shared --no-checkout <atmos-repository> <temporary-directory>`;
set the sparse directories above, `git checkout --detach <pin>`, compare dependency bytes
against that pin, then run each fixture with Node 22 from the temporary clone. These clones
reuse local Git objects solely for correctness validation; they do not measure network speed.

Detailed logs and exact materialized tracked-byte measurements are in the task evidence
`ci-deploy-audit-20260926/controller-sparse/{matrix.json,dependency-closure.json,*.log}`.
Tracked bytes are uncompressed source content, not transferred packfile sizes.

## Acceptance boundary

Run all Cycle UI contracts, workflow inventory tests/check and `git diff --check` before handoff.
The first separately authorized staging/production release must still qualify the same artifact
under the new policy digest; this workflow change does not make older policy-bound artifacts
promotable. Compare a real cloud checkout with the historical samples before claiming a speedup.
Commit, branch push and PR creation are authorized after review. No source-pin update, merge
or deployment is part of this task's current authorization.

## Local handoff result

Base: `2006691d7a50170f1a148aee674a8322dc818c76` (merged PR #326). Node 22.21.1 UI
contracts: 214 passed, 0 failed, 1 existing GNU-timeout/Linux process-group check skipped
on macOS. Inventory tests 10/10, generated inventory check and diff whitespace check passed.
The actual four-pin sparse fixture matrix passed 20/20. No application dependencies or
browser binaries were substituted for these fixture checks.

| Controller pin | Full tracked bytes | Actual sparse tracked bytes | Sparse tracked files |
| --- | ---: | ---: | ---: |
| `25c402db` | 329,153,959 | 178,153,772 | 8,547 |
| `6fcec226` | 3,136,521,053 | 206,637,382 | 10,237 |
| `b9db38dd` | 3,246,425,793 | 221,073,300 | 10,792 |
| `c257ef90` | 3,254,032,574 | 224,969,133 | 11,643 |
