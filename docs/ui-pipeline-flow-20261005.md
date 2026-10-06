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

`app-tests` first runs **verify Atmos CI evidence for the exact source** (pinned Cycle code,
before any candidate script; the read token is visible to this step only). It selects one path:

- **atmos-ci**: the newest `weatherx-hq/atmos` run of `.github/workflows/ci.yml` for exactly
  `head_sha == atmos_sha`, event `push`, branch `master`, same-repository head, is
  `completed/success`, and that run attempt has exactly one `ci-verdict` job that is
  `completed/success` for the same SHA, run and attempt. API reads are bounded (2 MiB), redirects
  are refused and the token is never logged or put in a URL. The local gate then runs
  `npm run test:certify --prefix atmos/app` and `npx playwright test` (in `atmos/app`).
- **full-local**: the unchanged complete `npm test --prefix atmos/app`. Chosen whenever
  `ATMOS_CI_READ_TOKEN` is absent, the staging profile uses the beta CI profile (the API cannot
  prove which CI profile Atmos ran), or any evidence check fails. The log prints which path ran
  and why.

The receipt (schema 2) records `evidence: {path, repository, workflow, job, runId, attempt,
commands}` or `{path: 'full-local', commands}`. `qualify` rebuilds the expected receipt from the
evidence step's job outputs (written before candidate code ran) and requires GitHub's jobs API
to report that the evidence step and the selected gate step succeeded in the same run attempt.
The sealed candidate's qualification carries `appTestEvidence`.

## Caches

Only the candidate-domain jobs (`build`, `app-tests`) use caches: `setup-node` `cache: npm`
keyed on the exact lockfiles (npm still verifies every tarball's integrity), and
`~/.cache/ms-playwright` keyed by the locked `playwright-core` version, saved right after the
browser download and before any candidate gate runs. The publisher jobs (`qualify`, `promote`)
hold Pages tokens and candidate keys and restore **no** cache: any runner that executed candidate
code could write a cache entry. They install their two locked dependency trees concurrently
instead.

## Automatic promotion (decision C)

1. Staging run *R*, attempt *A* succeeds. `resolve` (no environment, no secrets, `actions: read`)
   re-reads *R* from the API: same repository, `ui-staging.yml`, dispatch on `main`,
   `completed/success`, still attempt *A*, title `Staging <sha>`. It downloads only the public
   `ui-candidate-summary-R-A` artifact. If its `releaseProfile` differs from
   `UI_AUTO_PROMOTE_PROFILE` (including any staging-only profile), the run ends as skipped.
2. `promote` waits for the `ui-production` environment (required reviewer), then runs the same
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

Secret for decision B: `ATMOS_CI_READ_TOKEN` in the `atmos-source-read-ui` environment, a
fine-grained token with resource owner `weatherx-hq`, repository `atmos` only, permission
**Actions: read** (plus the mandatory metadata read). Remove it to return to full-local tests.

## Proven locally vs only by a real run

Local tests prove the decision functions, receipts, gates and workflow structure. Only real runs
can prove: GitHub's `workflow_run` payload and job-skip semantics, skipped-step reporting, cache
hit rates and timings, that `npx playwright test` is CI-ready, the token's scope, and the
environment approval of an automatically triggered run.
