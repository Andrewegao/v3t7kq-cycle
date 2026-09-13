# Workflow ownership and recovery

Start with the [generated workflow inventory](WORKFLOWS.md). It describes checked-in configuration, not current GitHub variables, deployed schedulers, or published data. A green collector, successful workflow, and fresh published component are different observations.

## Ownership

Cycle owns operational workflow entrypoints, scheduling, source checkout declarations, and guarded deployment controllers. Atmos owns the data algorithms, scientific validation, and evidence graph. The [metadata registry](../ops/workflows.json) supplies human navigation only; it cannot select a source, approve a candidate, change a target, or dispatch a job.

The registry contains one record per workflow: stable ID, path, family, purpose, responsible subsystem, support lifecycle, and runbook. Lifecycle expresses intended use, not observed activation. `recurring` includes reusable lanes called by recurring workflows; `manual-supported` still requires the workflow's current guards and owner authorization. `diagnostic` does not mean harmless: safety drills may write temporary state and must follow their own controls. `legacy-needs-review` is not a recommended recovery route.

Declared triggers, dependency edges, matrices, environments, timeouts, permissions, concurrency, source references, and variable references are generated from YAML. Additional script and step checks remain authoritative; the inventory does not evaluate expressions or prove script behavior. Secret values, protected-variable values, runtime health, and private Atmos implementation details are not collected.

From the repository root, with Node 22:

```sh
npm ci --ignore-scripts --prefix tools/inventory
node tools/workflow-inventory.mjs --write
node --test tests/workflow-inventory.mjs
node tools/workflow-inventory.mjs --check
```

`--write` changes only the generated Markdown. `--check` is read-only and fails for missing/duplicate/stale metadata, invalid YAML, missing runbooks, or generated-output drift. No API or scheduler credentials are required. The index omits timestamps so an unchanged configuration has identical output. Its content digest binds the registry and workflow bytes, rather than claiming to identify a deployed revision.

The exact YAML parser dependency lives in `tools/inventory/`, outside the deployed `scheduler/` tree. Do not move tooling dependencies into the scheduler package: its existing push trigger and full-tree deployment classifier treat scheduler manifest changes as runtime changes. Inventory CI installs the isolated package; scheduler deployment policy is unchanged.

## Model freshness and whole maintenance

The [main bake](../.github/workflows/bake.yml) has eleven independent collectors and each model's own publisher dependency. Four core models and seven regional models can progress independently. Whole maintenance joins those inputs, maintains observations and history, runs its release gates, and publishes an immutable whole-data fallback. Investigate a maintenance failure separately from each model's publication result.

The [catalog bake](../.github/workflows/catalog-bake.yml) provides independent core-model freshness updates. Its matrix and the main bake's per-model publishers already allow parallel work. Preserve the existing shared environment/model writer groups; using a new lock for manual work would permit it to race scheduled work on the same target. Whole maintenance has its own shared writer group and must rebase current model data before final nonregression checks.

Do not rename workflow paths, job names, collector step names, artifact names, or local reusable callers as cosmetic cleanup. [Current-model admission](../tools/current-model-artifact.py) authenticates the existing closure and original producer evidence. Atmos source pins must be qualified and changed through their existing coordinated review, not copied into this registry.

## Scheduling

The external scheduler's declared dispatches live in [its runtime](../scheduler/src/index.ts), [schedule definitions](../scheduler/src/schedules.ts), and [Wrangler configuration](../scheduler/wrangler.jsonc). GitHub-native catalog and archive schedules are fallback surfaces with existing [parity contracts](../scheduler/test-schedule-contract.mjs). The scheduler also declares the independent Wind100 dispatch at this revision; inspect the current runtime and workflow for its exact selection and guard.

Repository configuration alone cannot establish which scheduler is deployed or which fallback is enabled. Before changing ownership, inspect current protected settings and use the existing [live schedule verification](../scheduler/scripts/verify-live-schedules.mjs) with authorized read access. Its use is separate from this credential-free inventory. Do not enable both paths merely because both appear in the index. Ambiguous dispatch failures can duplicate requests, so idempotence and final admission checks remain necessary.

No queue setting changes are part of this inventory. Freshness work generally benefits from finishing the running transaction and coalescing replaceable pending requests. Historical batches and explicit recovery carry distinct identities and need their own reviewed retention policy. GitHub queue order is not scientific chronology; expanding a queue does not make an old forecast eligible. Keep archive catalog writers and history/ledger updates serialized under their existing controls.

## Observation-only whole-release fallback

`observation-bake.yml` is a reviewable fallback for METAR, SYNOP, buoy/ship, and OpenAQ freshness. It starts at UTC 02:10, 08:10, 14:10, and 20:10, ahead of the full-maintenance publisher's `:30` schedule, but uses the same `weatherx-data-maintenance` job lock with cancellation disabled. It hydrates the authenticated current whole release, lets each point producer atomically preserve its own last-good artifact on source failure, reads the current release identity again immediately before publication, and reuses the existing immutable upload, verification, and catalog CAS promotion scripts. It does not call the full model bake and has no Pages, staging, vault, outbound workflow-dispatch, or application-deployment credential.

The checked-in Atmos SHA is the exact head that passed the full Atmos CI and overlay gates. A second bounded checkout proves that SHA is already an ancestor of Atmos `master`; execution fails closed before hydration when the queue has not merged it. If Atmos uses a squash or rebase merge, deliberately repin this workflow to the resulting reviewed `master` commit instead of weakening the ancestry check.

This fallback is not activated merely by opening its pull request. Before merging it, the owner must add `OPENAQ_API_KEY` to the protected `production` environment without sharing the value, confirm the pinned Atmos change has merged, and review the schedule/whole-release cost. Do not manually dispatch it as an acceptance test before those conditions hold. After the first authorized run, inspect the immutable release receipt and live catalog freshness separately; repository snapshots are not production evidence.

## Choose recovery by the failed stage

1. **The provider was late or collection abstained:** use the existing [single-model refresh](single-model-refresh.md) path, after checking current request and source guards. A successful one-model run does not certify all eleven models.
2. **Collection succeeded but publication failed:** preserve the original artifacts and use the existing same-run retry or specifically reviewed [retained-run recovery](resume-model-publication.md). Run, attempt, source, receipt, and expiry checks still apply. Do not recollect every sibling model to repair one publisher.
3. **Upload succeeded but promotion failed:** identify the exact immutable receipt and applicable reviewed promotion controller. Revalidate the current target and fencing conditions before retrying. A successful upload alone does not authorize publication.
4. **Staging or a production consumer failed after activation:** use its existing ownership-aware restore transaction and retained version evidence. Reverting a configuration file alone does not restore a hostname or make an old candidate eligible.

There is no generic retry-any-run command. Missing or expired artifacts, incompatible source, stale eligibility, and malformed provenance remain refusal conditions. No recovery action should interrupt another active publication or use a second lock name to bypass its ownership.

## Legacy and historical material

[catalog-promote-existing.yml](../.github/workflows/catalog-promote-existing.yml) is explicitly `legacy-needs-review`: its staging lock differs from the recurring staging publisher, and its checkout has no explicit immutable ref. This index neither disables it nor certifies it. Review its source and writer contract before recommending use.

Some older runbooks describe a draft at the top and later record activation or fixes. Treat those sections as historical evidence; current workflow declarations and observed protected settings determine current eligibility. The inventory links sources without rewriting historical receipts. Atmos's old `ops-lab` examples are not a substitute for reading Cycle's operational workflows.

## Scope of this change

### Offline timing summaries

`tools/workflow-timing.mjs` reads existing GitHub REST jobs JSON, optionally with the matching workflow-run JSON. It makes no API request and writes only its JSON report to standard output. Inputs are capped at 8 MiB; all job pages must be present and belong to the same run, source and attempt.

For an authorized read-only export, replace `RUN_ID` and `ATTEMPT` with the exact run and attempt being inspected:

```sh
gh api --paginate --slurp repos/Andrewegao/v3t7kq-cycle/actions/runs/RUN_ID/attempts/ATTEMPT/jobs > jobs.json
gh api repos/Andrewegao/v3t7kq-cycle/actions/runs/RUN_ID/attempts/ATTEMPT > run.json
node tools/workflow-timing.mjs --jobs jobs.json --run run.json
```

Keep these exports local. The report preserves failed, skipped, and cancelled job outcomes and lists the longest completed jobs. Job creation-to-start is admission wait, including dependencies, environment, concurrency, and runner waits; it is not a measurement of runner queue alone. Setup classification is explicitly a step-name heuristic (checkout, installs, dependency/runtime provisioning, and teardown); other-work is remaining recorded step time. Unknown timestamps remain null, and known sums are marked partial through unknown counts. Summed job duration is not critical-path time or billed minutes. Run success never becomes a claim of successful publication. Compare like workloads and attempts before drawing conclusions; this utility does not generate percentiles from a single sample.

Run the offline contracts with `node --test tests/workflow-timing.mjs`. Raw logs, provider data, receipts, and credentials are not read or included by this tool.

GitHub can copy successful retained jobs into a selective rerun with new job IDs and the later attempt number, while preserving the earlier execution timestamps. A single jobs export therefore cannot establish which work was newly executed. Do not treat its summed duration as incremental retry cost; compare earlier timestamps and actual producer receipts when that distinction matters.

Only metadata, generated documentation, and CI inventory validation are introduced. Publication workflows, source pins, schedules, locks, environments, credentials, retained artifacts, and deployed services are unchanged. CI failure on stale documentation requests regeneration; it never mutates deployment configuration.
