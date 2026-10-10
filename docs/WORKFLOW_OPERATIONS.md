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

The exact YAML parser dependency lives in `tools/inventory/`, outside the deployed `scheduler/` tree. Do not move tooling dependencies into the scheduler package: everything under `scheduler/` is bundled or checked by the scheduler release. Inventory CI installs the isolated package.

## Model freshness and whole maintenance

The [main bake](../.github/workflows/bake.yml) has eleven independent collectors and each model's own publisher dependency. Four core models and seven regional models can progress independently. Whole maintenance joins those inputs, maintains observations and history, runs its release gates, and publishes an immutable whole-data fallback. Investigate a maintenance failure separately from each model's publication result. Served observations and fires are not refreshed by whole maintenance: the [observation lane](observation-refresh.md) refreshes the five `obs-*` components every 30 minutes without any model dependency, and the whole release's observation copies are only the legacy fallback beneath them. Every bake run ends with a run summary that names what it refreshed, skipped (for example whole-data maintenance in a staging-Wind100-only run) or failed. Every ordinary producer runs the one Atmos commit in `ops/atmos-production-source.json`; move it with `node tools/atmos-source-pin.mjs --set <sha>` and the protected values listed in that runbook.

The [catalog bake](../.github/workflows/catalog-bake.yml) provides independent core-model freshness updates. Its matrix and the main bake's per-model publishers already allow parallel work. Preserve the existing shared environment/model writer groups; using a new lock for manual work would permit it to race scheduled work on the same target. Whole maintenance has its own shared writer group and must rebase current model data before final nonregression checks. GitHub keeps one pending job per group and a newer pending job cancels the older one, even with cancel-in-progress false; on 2026-10-07 routine component dispatches cancelled the whole bake's queued hrrr, ecmwf and gfs publishers (run 37679425040). The component bake's `plan` job therefore leaves out of that run any model whose `bake.yml` `publish-<model> / publisher` (or `resume-model-publication.yml` `resume (<model>) / publisher`) job is queued, pending or waiting on the production lock, or whose whole-bake collector is still running or has just succeeded with no publisher listed yet; component publishes for that model pause until the publisher holds the lock. It keeps every requested model when the Actions API is unreadable, and the component summary lists each model it left out.

The hourly production ECMWF and GFS model jobs stand aside when production already serves the newest upstream run. Before hydrate, the step *Stand aside when production already serves the newest upstream run* runs [`tools/component-upstream-probe.py`](../tools/component-upstream-probe.py), which calls the pinned collector's own selector with the bake's arguments (`fetch_ecmwf.latest_run(336)`: step 0 and step 336 `.index` published; `fetch.pick_init(zarr, 72)`), and reads the production catalog for `<model>` and `point-<model>` through `hydrate-r2-component.sh PRECONDITION_ONLY=1`, the same precondition the publisher reads. [`tools/component-bake-stand-aside.mjs`](../tools/component-bake-stand-aside.mjs) stands aside only when both served components are at that run, the served map `component.json` matches the catalog hash and carries `native_viewport`, and it was completed after the newest commit touching `catalog-bake.yml` or the two check files (so a re-pin re-bakes the served run once). Then hydrate, collection, upload and promotion are skipped, the job summary says why, and the component summary reports the model as `unchanged`. Any error, timeout, missing evidence or changed collector invocation leaves the job running exactly as before (`continue-on-error`, `stand_aside` unset). HRRR, AIFS, staging targets and `bootstrap_missing` are never affected. To re-bake a served run on purpose, dispatch with `rebake_served_run: true`. Measured from the job logs of 2026-10-03 → 10-09 (seven days): 134 of 152 production ECMWF jobs (53 min each on average) and 102 of 156 production GFS jobs (7.5 min) would have stood aside, about 7.4 k billed minutes net. Since 2026-10-09 every same-run ECMWF job uploaded a new 10,535-object map component whose bundles were identical and whose only change was the manifest's `generated_at`; GFS same-run jobs already ended `unchanged` without upload.

Do not put required reviewers on an environment that a recurring job enters while it holds a shared writer group. A job waiting at an approval gate keeps its concurrency group, so every later dispatch for that group queues behind it and replaces the previous pending one: from 2026-10-01 to 10-06 one HRRR component job waited at the `production` reviewer gate and 144–151 catalog-bake dispatches a day were cancelled with no HRRR component published. Keep human approval on separate, manually dispatched workflows (as `production-wind100-retention.yml` does with `data-production-wind100-cleanup`).

Do not rename workflow paths, job names, collector step names, artifact names, or local reusable callers as cosmetic cleanup. [Current-model admission](../tools/current-model-artifact.py) authenticates the existing closure and original producer evidence. Atmos source pins must be qualified and changed through their existing coordinated review, not copied into this registry.

## Scheduling

The external scheduler's declared dispatches live in [its runtime](../scheduler/src/index.ts), [schedule definitions](../scheduler/src/schedules.ts), and [Wrangler configuration](../scheduler/wrangler.jsonc); the [README](../scheduler/README.md) has the lane table. Since 2026-10-10 it dispatches every lane that must run on time: catalog HRRR and slow, the archive tail, the whole-data bake (`35 2,8,14,20`, which replaced the staging-Wind100-only dispatch on the same tick), fusion issuance (`23 */6`), staging search renewal (`17 */6`), staging place renewal (`37 1,7,13,19` surf, `47 5,17` all families), GloFAS and CAMS. Each GitHub-native schedule stays as a fallback at its own minute and is held to the Worker's table by the [parity contracts](../scheduler/test-schedule-contract.mjs). A scheduler dispatch takes the workflow's scheduled path (`caller: scheduler` for fusion issuance and staging search) and obeys the same enable variable. Before each new-lane dispatch the Worker reads that workflow's runs created since ten minutes before the tick and stands aside when one is queued, waiting or running; if that read fails it dispatches anyway. The catalog and archive dispatches are unchanged and never read first. In the other direction, the GitHub fallbacks of the whole bake, fusion issuance, staging search, GloFAS and CAMS start with a schedule-only, read-only `fallback-gate` job that stands the whole run aside when a successful or still active dispatched run of the same lane is inside the lane's window (330 min for the six-hourly lanes, 90 min for GloFAS and CAMS), and lets it run when the read fails ([scheduler README](../scheduler/README.md), `tests/fallback-stand-aside.mjs`).

Repository configuration alone cannot establish which scheduler is deployed or which fallback is enabled. Before changing ownership, inspect current protected settings and use the existing [live schedule verification](../scheduler/scripts/verify-live-schedules.mjs) with authorized read access. Its use is separate from this credential-free inventory. Do not enable both paths merely because both appear in the index. Ambiguous dispatch failures can duplicate requests, so idempotence and final admission checks remain necessary.

**Five crons, not eleven (2026-10-10).** The Cloudflare account is evidently on Workers Free, which allows 5 Cron Triggers per account (Workers Paid: 250). With eleven declared, the schedules API listed all eleven but invocation analytics showed only five firing, chosen by Cloudflare: HRRR, slow, the archive tail (which throws, its workflow being disabled), the whole bake and staging surf; fusion issuance, staging search, the directory renewal, production tides, GloFAS and CAMS never fired. The Worker therefore declares exactly five, in priority order: HRRR `8-59/10`, slow `:07`, whole-data bake `35 2,8,14,20`, fusion issuance `23 */6`, production tides `52 9`. The archive tail, staging search renewal, staging place renewal (surf and directory/tide), GloFAS and CAMS are fallback-only: the Worker still routes their crons, but they run only from their GitHub-native schedules (the archive not at all while its workflow is disabled). The scheduler's config loader refuses more than five triggers. This supersedes the lane list in the paragraph above; see the [scheduler README](../scheduler/README.md#five-triggers-the-workers-free-limit).

GitHub-native `schedule` is not an on-time trigger for this repository. Measured 2026-10-03 to 2026-10-10 from the Actions run history: four-a-day schedules fired 59–68% of their slots (bake 17 of 29, fusion-issue 17 of 29, staging-search 18 of 29) with a median start 3.5–4.6 h after the cron time; quarter-hour and half-hour schedules fired 4–8% of their slots (staging-follow-master 28 of 696, staging-shared-read-probe 28 of 348). Treat a GitHub schedule as a best-effort fallback only. A lane that must run near its cron time, or that refuses when it starts late, needs an external dispatcher (this scheduler Worker, or a dedicated Cloudflare cron Worker as Atmos uses for fusion reference collection).

A merge to `scheduler/**` is live only after the **WeatherX scheduler deploy** workflow runs, and that workflow can be disabled in GitHub (it was `disabled_manually` from 2026-09-12; the live Worker then kept its 2026-09-12 trigger set). Since 2026-10-10 the deploy is manual only: a read-only `plan` run prints the declared and live crons and vars, the active version, and the declaration digest; a `release` run must carry both, refuses if the live version or the checked-out declaration changed since the plan, applies code and triggers, requires the live readback to equal the declaration, and restores the predecessor version and trigger set on failure ([runbook](../scheduler/README.md#verify-and-deploy)). Before relying on a newly merged dispatch, confirm the live trigger set with `npm run verify:live` (or the Workers schedules API) and look for matching `workflow_dispatch` runs of the target workflow.

No queue setting changes are part of this inventory. Freshness work generally benefits from finishing the running transaction and coalescing replaceable pending requests. Historical batches and explicit recovery carry distinct identities and need their own reviewed retention policy. GitHub queue order is not scientific chronology; expanding a queue does not make an old forecast eligible. Keep archive catalog writers and history/ledger updates serialized under their existing controls.

## Energy own ingest (GloFAS dams, CAMS dust)

`glofas-ingest.yml` (11:15 and 13:15 UTC) and `cams-ingest.yml` (00:40, 10:40, 12:40, 22:40 UTC) are
run from their GitHub-native schedules only: the scheduler Worker can route them but does not declare their crons (Workers Free five-trigger limit; see Scheduling). Each runs the pinned Atmos
producer (`data/fetch_glofas.py --dams`, `data/fetch_cams.py`), checks the output tree
(`tools/energy-ingest.mjs check-tree`), publishes one immutable component (`energy-glofas` at
`data-atmos/energy/glofas/`, `energy-cams` at `data-atmos/energy/cams/`) through
`ops/platform/publish-r2-component.sh` with compare-and-swap on the served manifest, and reads the public
`current.json` back. Both stand aside green until the pinned Atmos carries the producers and the
`EWDS_API_KEY` / `ADS_API_KEY` secrets (or `CDS_API_KEY`) exist, and both are no-ops when their run is
already served. A failed run publishes nothing; the previous pointer keeps serving and the app labels it
with its own init. Recovery is a manual dispatch (GloFAS `date`, CAMS `run`); `dry_run` exercises the
producer on its synthetic fixture without any key. Owner steps: Atmos
`docs/engineering/energy/own-ingest.md`.

## Choose recovery by the failed stage

1. **The provider was late or collection abstained:** use the existing [single-model refresh](single-model-refresh.md) path, after checking current request and source guards. A successful one-model run does not certify all eleven models.
2. **Collection succeeded but publication failed:** preserve the original artifacts and use the existing same-run retry or specifically reviewed [retained-run recovery](resume-model-publication.md). Run, attempt, source, receipt, and expiry checks still apply. Do not recollect every sibling model to repair one publisher.
3. **Upload succeeded but promotion failed:** identify the exact immutable receipt and applicable reviewed promotion controller. Revalidate the current target and fencing conditions before retrying. A successful upload alone does not authorize publication.
4. **Staging or a production consumer failed after activation:** use its existing ownership-aware restore transaction and retained version evidence. Reverting a configuration file alone does not restore a hostname or make an old candidate eligible.

There is no generic retry-any-run command. Missing or expired artifacts, incompatible source, stale eligibility, and malformed provenance remain refusal conditions. No recovery action should interrupt another active publication or use a second lock name to bypass its ownership.

## Production account release preparation

The local [production account release controller](production-account-release-controller.md)
defines a provisional G3 profile plus mocked Worker and Pages-configuration transactions. It is
not a workflow entrypoint and its provisional Lane B contract fails closed for normal/live use.
Do not add a dispatch, Cloudflare adapter, protected value, or approval shortcut merely to exercise
it. The profile is bound to the reviewed Atmos integration candidate, but the live Stripe offer and
Price/Product owner decisions still block finalization. Converge the final Lane B contract first,
then review and rehearse the separate Worker upload,
Worker activation, Pages configuration, and exact-artifact Pages promotion boundaries in order.

## Platform staging backend rehearsal

The protected [platform staging backend transaction](platform-staging-transaction.md) runs one
authorized stage of the Atmos rehearsal packet per manual dispatch. It accepts only the exact
current Atmos `master` SHA and exposes no Pages or production operation. Treat every stage as a
separate approval boundary and retain its append-only intent/result artifact before proceeding.

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

## Production Fusion evidence recording

`fusion-issue.yml` is append-only and independent of map publication. Manual dispatch accepts `canary` (one frozen station) or `full` (all 64 stations) only with the exact `RECORD FUSION EVIDENCE` confirmation. Manual canaries remain available while the repository Actions variable `FUSION_ISSUANCE_ENABLED` is absent or false; the six-hour schedule runs the full network only after that repository-scoped variable is explicitly enabled. The separate `FUSION_FEEDBACK_ENABLED` variable continues to govern evaluation and must remain false during issuance activation.

The workflow checks out the exact `FUSION_ENGINE_SHA`, requires a clean tree, disables runtime calibration, acquires observations directly from Aviation Weather Center, and requires every requested station to issue successfully. It then reads every issued forecast back from the production archive and compares canonical bytes with the local record. A 64-station run also publishes one immutable batch manifest only after all 64 canonical bodies pass readback; a canary never publishes a discoverable batch. Only compact collection, readback, and manifest receipts are retained in GitHub; forecast and observation bodies remain in the append-only archive.

Activation order is strict: merge both source repositories, set the exact reviewed engine SHA, deploy only the archive component, inspect its read-only smoke receipt, run the one-station canary, run the 64-station full gate in the next UTC issue hour, wait until that full run's UTC issue hour has ended, then set the repository Actions variable `FUSION_ISSUANCE_ENABLED=true`. The hour separation preserves the archive's one canonical claim per station/hour rule; retrying a different issuance inside the canary hour must fail closed, and enabling before the full hour ends could make the first scheduled run collide. A failed or cancelled stage records a bounded gap and leaves the recurring schedule disabled. Neither this workflow nor its archive-only infrastructure deployment changes map layers, customer responses, calibration, evaluation, or model publishing.

`fusion-infra.yml` defaults to the `archive` component. That scope deploys and reads only the archive Worker; it does not provision or rotate secrets and does not deploy the calibration controller. The broader `all` scope retains separate confirmation and must be used only for an explicitly reviewed complete-pair operation.
