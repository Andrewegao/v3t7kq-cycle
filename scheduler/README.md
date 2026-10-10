# WeatherX model scheduler

This scheduled-only Cloudflare Worker (`weatherx-model-scheduler`) dispatches GitHub Actions workflows on time. It is a delivery bridge: model discovery, quality gates, publishing and promotion stay in the dispatched workflows.

GitHub's own `schedule` is a fallback, not a clock: from 2026-10-03 to 10-10 the four-a-day schedules fired 59–68 % of their slots, a median 3.5–4.6 h late, and the 02:30Z whole bake never started on time. The account fires at most five Worker crons (below), so the five lanes that most need to run on time are dispatched from here; the rest run from their GitHub fallback only.

## Five triggers: the Workers Free limit

Cloudflare allows **5 Cron Triggers per account on Workers Free** (250 on Workers Paid), and this account is evidently on Free: the observed five-of-eleven matches that limit. Past the limit nothing is refused: the schedules API lists every declared trigger, but only an arbitrary five ever fire. From the 2026-10-10 07:11Z release eleven were declared; Cloudflare's invocation analytics (`workersInvocationsAdaptive`, 07:00–21:20Z) show only `8-59/10`, `7`, `23 * * * *`, `35 2,8,14,20` and `37 1,7,13,19` invoking, and fusion, search, directory, production tides, GloFAS and CAMS never invoking.

So the Worker declares exactly five, chosen in this priority order: HRRR, slow, whole-data bake, Fusion issuance, production tides. `scripts/live-schedules.mjs` refuses a `wrangler.jsonc` with more than five (`MAX_CRON_TRIGGERS`), which stops plan, release, `verify:live` and every contract. Moving the account to Workers Paid is the owner's call; after that, re-adding a lane is one line in `SCHEDULER_CRONS` (`src/schedules.ts`) and one in `wrangler.jsonc` `triggers.crons`, plus raising `MAX_CRON_TRIGGERS` in both files: the Worker still routes every lane below.

**Fallback-only lanes** (still routed by the Worker, not declared; `UNDECLARED_CRONS`):

| Worker cron (not declared) | Lane | Runs from |
|---|---|---|
| `23 * * * *` | satellite/radar tail (`satellite-archive.yml`) | nothing: the workflow has been disabled since 09-19, and its trigger threw every hour |
| `17 */6 * * *` | staging search renewal (`staging-search.yml`) | GitHub cron `17 */6` |
| `37 1,7,13,19 * * *` | staging surf renewal (`staging-place-renewal.yml`) | GitHub cron `37 1,7,13,19` |
| `47 5,17 * * *` | staging directory and tide renewal (`staging-place-renewal.yml`) | GitHub cron `47 5,17` |
| `15 11,13 * * *` | Energy Desk GloFAS (`glofas-ingest.yml`) | GitHub cron `15 11,13` |
| `40 0,10,12,22 * * *` | Energy Desk CAMS (`cams-ingest.yml`) | GitHub cron `40 0,10,12,22` |

These keep running, hours late on many slots. `test-schedule-contract.mjs` requires each to keep its GitHub schedule and forbids it from taking one of the five triggers.

## Schedule (UTC)

| Cron | Lane | Workflow and inputs | Why this minute |
|---|---|---|---|
| `8-59/10 * * * *` | HRRR components | `catalog-bake.yml` `model=hrrr target=production` | HRRR hourly runs; provider poll every 10 min |
| `7 * * * *` | slow components | `catalog-bake.yml` `model=slow` (ECMWF, GFS, AIFS) | hourly poll |
| `35 2,8,14,20 * * *` | whole-data bake | `bake.yml` `model=all recovery_run_id='' staging_wind100_only=false` | ECMWF open data lands ~:10; the GitHub fallback is `:30`; five minutes later the dedupe sees an on-time fallback. Runs every collector, whole maintenance, and the staging and production 100 m wind publishers (this tick sent `staging_wind100_only=true` until 2026-10-10) |
| `23 */6 * * *` | Fusion issuance | `fusion-issue.yml` `scope=full caller=scheduler` | the fallback's minute; scheduled path: `FUSION_ISSUANCE_ENABLED`, 64 stations |
| `52 9 * * *` | production tide renewal | `production-place-renewal.yml` `family=tides caller=scheduler` | the first of the policy's two daily fallback slots (`52 9,21`); scheduled path: `PRODUCTION_PLACES_RENEWAL_ENABLED`, and it stands aside when production already serves a dataset under 20 h old ([runbook](../docs/production-place-renewal.md)) |

The staging place renewal controller hashes its own workflow file (`STAGING_PLACES_RENEWAL_CONTROLLER_SHA256`), so that workflow is dispatched through its existing `family` input and its controller still requires `STAGING_PLACES_RENEWAL_ENABLED`. Fusion issuance and staging search gained a `caller` input: `caller=scheduler` takes the scheduled path and obeys the same enable variable as the GitHub schedule; a person still types the confirmation or picks the action.

**Dedupe.** Before dispatching any lane except the catalog and archive ones, the Worker lists that workflow's runs on `main` created since ten minutes before the tick. If one is `queued`, `in_progress`, `waiting`, `pending` or `requested`, it logs `github_workflow_dispatch_skipped` with that run id and does not dispatch. If the list cannot be read it dispatches anyway (`dedupe: unreadable`): every lane is concurrency-guarded and idempotent, so a duplicate costs minutes and a missed slot costs data. The catalog and archive dispatches are byte-identical to the 2026-09-12 Worker and never read first.

Each GitHub-native schedule stays as an independent fallback at its own minute (`scheduler/test-schedule-contract.mjs` holds them to this table). For the catalog lanes, `CATALOG_GITHUB_FALLBACK_DISABLED=true` turns the fallback off; the other fallbacks have no such switch yet, so a late fallback run can repeat a slot the Worker already served.

## Credential

`GITHUB_DISPATCH_TOKEN` (Worker secret): a fine-grained GitHub personal access token restricted to `Andrewegao/v3t7kq-cycle` with only **Actions: Read and write**. Read covers the dedupe run list; write covers the dispatch. No new scope is needed for the 2026-10-10 lanes. Never commit it or reuse the broader GitHub CLI credential.

## Verify and deploy

Nothing deploys the scheduler automatically. The **WeatherX scheduler deploy** workflow (`.github/workflows/scheduler-deploy.yml`) is manual, runs from `main` in the `production` environment, and uses the repository secret `CLOUDFLARE_WORKERS_API_TOKEN` (Workers Scripts edit on account `a89f9a1af485021fbc60a68b163c7c6e`; never the Pages `CLOUDFLARE_API_TOKEN`). The workflow was `disabled_manually` on 2026-09-12; an owner enables it once:

```sh
gh workflow enable scheduler-deploy.yml -R Andrewegao/v3t7kq-cycle
```

1. **Plan** (read-only). Runs every release gate, then reads the live Worker and prints declared vs live crons and vars, the active version and the declaration digest. It refuses a mixed deployment or a Worker without `GITHUB_DISPATCH_TOKEN`.

   ```sh
   gh workflow run scheduler-deploy.yml -R Andrewegao/v3t7kq-cycle --ref main -f mode=plan -f confirm=PLAN-SCHEDULER
   ```

2. **Release.** Copy the command the plan's summary prints:

   ```sh
   gh workflow run scheduler-deploy.yml -R Andrewegao/v3t7kq-cycle --ref main -f mode=release \
     -f expected_active_version_id=<active version from the plan> -f confirm=RELEASE-SCHEDULER:<declaration digest from the plan>
   ```

   It refuses if the active version is no longer the planned one or the checked-out declaration (crons, vars, secret names) differs from the planned digest. It uploads one inactive version (`wrangler versions upload`, secrets inherited) and checks its bindings, activates it (`wrangler versions deploy <id>@100%`), writes the declared triggers through the schedules API, and requires the live readback (active version, exact cron set, every var, the secret name) to equal the declaration.

3. **Rollback.** On any failure the run restores its own predecessor: `wrangler rollback <previous>` when its candidate is still active, then the predecessor's cron set through the schedules API (triggers are not part of a version). It refuses when another publisher changed the Worker meanwhile. The receipt artifact (`scheduler-<mode>-<run>-<attempt>`) records both versions and both cron sets. To roll back a release that passed, run plan and release from the previous `main` revision, or run `npx wrangler rollback <previous version>` and restore the previous triggers with `npx wrangler triggers deploy` from that revision.

After a release, `npm run verify:live` (with a read token in `CLOUDFLARE_API_TOKEN`) re-checks the live trigger set and bindings, and the Actions list should show `workflow_dispatch` runs at the table's minutes: `bake` "all models + whole-data maintenance" at 02:35/08:35/14:35/20:35, `WeatherX fusion issuance` at :23 every 6 h, and the production tide renewal at 09:52 (Cloudflare's `workersInvocationsAdaptive` analytics for `weatherx-model-scheduler`, grouped by `scheduledDateTime`, should show all five crons invoking). Staging search, staging place renewal, GloFAS and CAMS appear only as `schedule` runs.

Local validation is read-only:

```sh
npm ci
npm run check
```
