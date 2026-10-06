# UI staging → production flow (pipeline speed, 2026-10-05)

This page describes the flow after owner decisions **B** (accept Atmos CI's own test evidence,
keep a shorter local gate) and **C** (promotion may follow a green staging run, behind the
existing activation gate, environment protection, rollback and fuse). Every earlier guard is
kept: same-attempt receipts, source identity checks, encrypted transport, no plaintext server
code in artifacts, the release guard's automatic rollback and fuse. The background protocol is
[UI-STAGING-PROMOTION.md](UI-STAGING-PROMOTION.md).

## Triggers

| Workflow | Triggers | Notes |
| --- | --- | --- |
| `ui-staging.yml` (WeatherX UI staging qualification) | `workflow_dispatch` on `main` only | Inputs: `atmos_sha` (required, exact 40-hex current Atmos master SHA), `model_selection_sha256` (optional, default `default`: the armed `UI_AUTO_PROMOTE_PROFILE` while `UI_AUTO_PROMOTE_ENABLED == 'true'`, otherwise `approved`; an armed but unrecognised profile fails the run). Dispatched by hand, by `staging-follow-master.yml`, or by Atmos CI's `ci-verdict` step, which send only `atmos_sha`. |
| `ui-release.yml` (WeatherX UI production promotion) | `workflow_dispatch` (unchanged inputs) **and** `workflow_run` on the staging workflow, `types: [completed]`, `branches: [main]` | The `resolve` job runs only when the staging run concluded `success`, was itself a `main` dispatch, and `UI_AUTO_PROMOTE_ENABLED == 'true'`. |

Staging dispatchers must follow the follower's rule (`tools/staging-follow-master.mjs`): one
attempt per source SHA, never while another staging run is active, never retry a failed source
automatically. The build still refuses a SHA that is no longer `origin/master` when it runs.

## App-test evidence (decision B)

A separate `atmos-evidence` job (environment `atmos-ci-evidence`) checks out only Cycle, never the
candidate, runs no candidate code, and is the only job that references the read token; candidate
code in `app-tests` could otherwise read every secret its runner holds. Its step **verify Atmos CI
evidence for the exact source** selects one path and publishes it as job outputs:

- **atmos-ci**: the newest `weatherx-hq/atmos` run of `.github/workflows/ci.yml` for exactly
  `head_sha == atmos_sha`, event `push`, branch `master`, same-repository head, is
  `completed/success`, and that run attempt has exactly one `ci-verdict` job that is
  `completed/success` for the same SHA, run and attempt. API reads are bounded (2 MiB), redirects
  are refused and the token is never logged or put in a URL. `app-tests` then runs the local
  gate: it checks that `ops/release/public-beta-ci-manifest.json` is tracked at the candidate,
  runs `WX_CI_PROFILE=public-beta-ci-lab-road-security-v1 npm run gates --prefix atmos/app`,
  then `npm run test:certify --prefix atmos/app` and `npx playwright test` (in `atmos/app`).
  The accepted evidence covers Atmos's own CI environment, not this staging environment: Atmos
  master CI selects its public-beta CI profile whenever that manifest is tracked
  (`tools/ci-fast-evidence.mjs`), which swaps `check-i18n` for `check-public-beta-i18n` and runs
  Vitest without the staging build flags. The local static gates therefore run under that same
  public-beta profile (recorded as `gatesCiProfile` in the receipt), and the complete Vitest
  suite is not re-run with the staging flags on this path.
  **The full-profile `check-i18n` gate is currently red on Atmos master** (about 3 940 fuzzy draft
  entries in `app/src/locales/zh/messages.po`, pre-existing). Neither Atmos CI nor this gate runs
  it, and the full-local fallback (`npm test`, full profile for non-beta selections) would fail
  on it. Whether that gate must be green before release is an Atmos owner decision; the
  controller does not hide it, it records which profile ran.
- **full-local**: the unchanged complete `npm test --prefix atmos/app`. Chosen whenever
  `ATMOS_CI_READ_TOKEN` is absent, the staging profile uses the beta CI profile (the API cannot
  prove which CI profile Atmos ran), or any evidence check fails. The log prints which path ran
  and why.

The receipt (schema 2) records `evidence: {path, repository, workflow, job, runId, attempt,
commands}` or `{path: 'full-local', commands}`. `app-tests` and `qualify` read the path, run id
and attempt from the `atmos-evidence` job outputs; `qualify` rebuilds the expected receipt from
them and requires GitHub's jobs API to report that the `atmos-evidence` job (and its evidence
step) and the selected `app-tests` gate step succeeded in the same run attempt.
The sealed candidate's qualification carries `appTestEvidence`.

## Caches

Only the candidate-domain jobs (`build`, `app-tests`) use a cache: an explicit `actions/cache`
of `~/.npm` with key `ui-candidate-npm-<os>-<hash of atmos/app and control/platform/edge
lockfiles>` and restore prefix `ui-candidate-npm-<os>-` (in `app-tests` only the Atmos lockfile
exists, so its key hashes that file). No other workflow uses this prefix, so publisher workflows
never restore it, and setup-node's generic `cache: npm` key (shared with publisher workflows) is
not used. npm ci still verifies every tarball against the lockfile integrity. There is no browser
cache: Playwright is installed fresh in every job, because a cached browser written after
candidate code ran would outlive its candidate. The publisher jobs (`qualify`, `promote`) hold
Pages tokens and candidate keys and restore **no** cache; they install their two locked
dependency trees concurrently instead.

## Automatic promotion (decision C)

1. Staging run *R*, attempt *A* succeeds. `resolve` (no environment, no secrets, `actions: read`)
   re-reads *R* from the API: same repository, `ui-staging.yml`, dispatch on `main`, still
   attempt *A* (a newer attempt, even one still running, skips), `completed/success`, title
   `Staging <sha>`. It downloads only the public
   `ui-candidate-summary-R-A` artifact. If its `releaseProfile` differs from
   `UI_AUTO_PROMOTE_PROFILE` (including any staging-only profile), the run ends as skipped.
2. The run name shows the source, profile and staging run/attempt to the approver.
   `promote` waits for the `ui-production` environment (required reviewer), then runs the same
   `ui-release.mjs gate`: the automatic event is admitted only when armed for the exact routed
   profile and attempt; everything else is the unchanged manual gate (activation, isolation,
   hold, freeze, repository, protected ref).
3. `download` and `deploy production` re-audit everything from the authenticated candidate
   (profile binding, exact attempt *A*, source, digest, pipeline digest, staging still serving it)
   and keep three consecutive healthy production probes 15 s apart inside the rollback guard. A
   failure rolls back and opens the fuse; an open fuse blocks every later promotion.

## What still requires a human

- Approving the `ui-production` environment deployment (Andrew as required reviewer). Automatic
  promotion only removes typing the three values; it does not remove the approval.
- Arming and disarming, activation variables, freeze dates, and clearing a fuse after diagnosis.
- Choosing and reviewing the production profile: while disarmed, staging dispatched with only
  `atmos_sha` resolves `approved` to a hash-pinned staging-only profile, which is never promotable.

## The combined profile's single reviewed SHA and the release ritual

`production-account-ru-kk-wind100-onboarding-v2` is pinned to one reviewed Atmos commit.
`tools/ui-combined-source-guard.mjs` (`UI_SOURCE`, `assertCombinedSource`) and `sourceIdentity`
in `tools/ui-release.mjs` (with `PUBLIC_COMBINED_ATMOS_SHA` in `tools/ui-public-combined.mjs`)
require the candidate to be exactly that SHA **and** Atmos `origin/master` to equal it with no
intervening diff; the three literal controller refs in both workflows name it too. Any later
master push therefore cannot qualify this profile until the new source is reviewed and re-pinned.
The release ritual with this profile armed is:

1. Review the new Atmos source.
2. Land the re-pin PR in this repository (source guard, combined SHA, controller refs, docs).
3. The Atmos master push's `ci-verdict` step dispatches staging with only `atmos_sha`.
4. Staging resolves `default` to the armed profile and qualifies it.
5. Promotion is routed automatically and waits for the `ui-production` approval.

Side effects while armed: dispatches that omit the selection stop qualifying the hash-pinned
staging model-selection experiment (dispatch it explicitly with `approved` to keep it), and with
the combined profile armed only the pinned SHA can pass; every other master push fails at the
source guard before any deployment and uses up that SHA's single follower attempt. Arming
`none` or `production-account-billing-v1` would qualify any current master automatically, but
promoting either removes features the combined profile serves.

## Arm / disarm

Arming also changes what staging qualifies for dispatches that omit the selection (above).
Arm (repository variables, Settings → Secrets and variables → Actions → Variables):
`UI_AUTO_PROMOTE_ENABLED=true` and `UI_AUTO_PROMOTE_PROFILE=<none | production-account-billing-v1 |
production-account-ru-kk-beta-v1 | production-account-ru-kk-wind100-onboarding-v2>`. The
`ui-production` gate variables (`UI_RELEASES_ENABLED`, `UI_ISOLATION_APPROVED`,
`UI_DEPLOYMENT_HOLD_UNTIL`) must also allow a release.

Disarm: set `UI_AUTO_PROMOTE_ENABLED` to anything other than `true` (or delete it). A future
`UI_DEPLOYMENT_HOLD_UNTIL` or `UI_RELEASES_ENABLED=false` stops manual and automatic promotion.
Rejecting the pending environment approval stops one run.

Secret for decision B: `ATMOS_CI_READ_TOKEN` in the `atmos-ci-evidence` environment (protected
branch `main`; it holds nothing else), a
fine-grained token with resource owner `weatherx-hq`, repository `atmos` only, permission
**Actions: read** (plus the mandatory metadata read). Remove it to return to full-local tests.

## Proven locally vs only by a real run

Local tests prove the decision functions, receipts, gates and workflow structure. Only real runs
can prove: GitHub's `workflow_run` payload and job-skip semantics, skipped-step reporting, cache
hit rates and timings, that `npx playwright test` is CI-ready, the token's scope, and the
environment approval of an automatically triggered run.
