# WeatherX model scheduler

This scheduled-only Cloudflare Worker (`weatherx-model-scheduler`) dispatches GitHub Actions workflows on time. It is a delivery bridge: model discovery, quality gates, publishing and promotion stay in the dispatched workflows.

GitHub's own `schedule` is a fallback, not a clock: from 2026-10-03 to 10-10 the four-a-day schedules fired 59–68 % of their slots, a median 3.5–4.6 h late, and the 02:30Z whole bake never started on time. Every lane that must run on time is dispatched from here.

## Schedule (UTC)

| Cron | Lane | Workflow and inputs | Why this minute |
|---|---|---|---|
| `8-59/10 * * * *` | HRRR components | `catalog-bake.yml` `model=hrrr target=production` | HRRR hourly runs; provider poll every 10 min |
| `7 * * * *` | slow components | `catalog-bake.yml` `model=slow` (ECMWF, GFS, AIFS) | hourly poll |
| `23 * * * *` | satellite/radar tail | `satellite-archive.yml` `policy=hourly-tail-v1` | hourly tail (workflow disabled since 09-19; dispatch refused until it is re-enabled or retired) |
| `35 2,8,14,20 * * *` | whole-data bake | `bake.yml` `model=all recovery_run_id='' staging_wind100_only=false` | ECMWF open data lands ~:10; the GitHub fallback is `:30`; five minutes later the dedupe sees an on-time fallback. Runs every collector, whole maintenance, and the staging and production 100 m wind publishers (this tick sent `staging_wind100_only=true` until 2026-10-10) |
| `23 */6 * * *` | Fusion issuance | `fusion-issue.yml` `scope=full caller=scheduler` | the fallback's minute; scheduled path: `FUSION_ISSUANCE_ENABLED`, 64 stations |
| `17 */6 * * *` | staging search renewal | `staging-search.yml` `action=renew caller=scheduler` | the fallback's minute; 24 h lease renewed every 6 h, behind `STAGING_SEARCH_SCHEDULE_ENABLED` and `STAGING_SEARCH_RENEWAL_ENABLED` |
| `37 1,7,13,19 * * *` | staging surf renewal | `staging-place-renewal.yml` `family=surf` | the policy's `surfSchedule` |
| `47 5,17 * * *` | staging directory and tide renewal | `staging-place-renewal.yml` `family=all` | the policy's `directoryTideSchedule`; `all` keeps it one run (a second pending run would replace the first in the shared `weatherx-staging-publication` group) and adds a ~2 min surf renewal |
| `52 9 * * *` | production tide renewal | `production-place-renewal.yml` `family=tides caller=scheduler` | the first of the policy's two daily fallback slots (`52 9,21`); scheduled path: `PRODUCTION_PLACES_RENEWAL_ENABLED`, and it stands aside when production already serves a dataset under 20 h old ([runbook](../docs/production-place-renewal.md)) |
| `15 11,13 * * *` | Energy Desk GloFAS | `glofas-ingest.yml` `caller=scheduler` | daily forecast from ~10:45; 13:15 is the retry |
| `40 0,10,12,22 * * *` | Energy Desk CAMS | `cams-ingest.yml` `caller=scheduler` | each 00/12 UTC run asked 10 h 40 min after init and again 2 h later |

The staging place renewal controller hashes its own workflow file (`STAGING_PLACES_RENEWAL_CONTROLLER_SHA256`), so that workflow is dispatched through its existing `family` input and its controller still requires `STAGING_PLACES_RENEWAL_ENABLED`. Fusion issuance and staging search gained a `caller` input: `caller=scheduler` takes the scheduled path and obeys the same enable variable as the GitHub schedule; a person still types the confirmation or picks the action.

**Dedupe.** Before dispatching any lane except the catalog and archive ones, the Worker lists that workflow's runs on `main` created since ten minutes before the tick. If one is `queued`, `in_progress`, `waiting`, `pending` or `requested`, it logs `github_workflow_dispatch_skipped` with that run id and does not dispatch. If the list cannot be read it dispatches anyway (`dedupe: unreadable`): every lane is concurrency-guarded and idempotent, so a duplicate costs minutes and a missed slot costs data. The catalog and archive dispatches are byte-identical to the 2026-09-12 Worker and never read first.

Each GitHub-native schedule stays as an independent fallback at its own minute (`scheduler/test-schedule-contract.mjs` holds them to this table). For the catalog lanes, `CATALOG_GITHUB_FALLBACK_DISABLED=true` turns the fallback off.

**Fallback stand-aside.** GitHub delivers these schedules hours late, so a late fallback used to repeat a slot the Worker had already served (2026-10-10: the bake cron run 38077160747 started at 18:46Z, four hours after the Worker's 14:35Z whole bake 38060223583, and repeated the whole three-hour bake). Each workflow below now starts with one `fallback-gate` job that runs only on `schedule`: with the workflow token (`actions: read`, no checkout, no secret) it lists this workflow's `workflow_dispatch` runs on `main` created inside the lane's window, and when one succeeded or is still queued, waiting or running it outputs `run=false` and every other job skips. A dispatched run skips the gate, and the condition appended to its first jobs is then true, so dispatched runs are unchanged. The gate is fail-open: an API or parse error, a timeout or a failed gate job leaves the fallback running, so the fallback still covers a Worker outage.

| Workflow | Window | Counts as already run |
| --- | --- | --- |
| `bake.yml` | 330 min | a dispatched `bake: all models + whole-data maintenance` (not a single-model, recovery or staging-Wind100-only run) |
| `fusion-issue.yml` | 330 min | any dispatched run (no run-name) |
| `staging-search.yml` | 330 min | any dispatched run (no run-name) |
| `glofas-ingest.yml` | 90 min | a dispatched `energy glofas: dispatched (today)` |
| `cams-ingest.yml` | 90 min | a dispatched `energy cams: dispatched (newest published run)` |

Each window is 30 min shorter than the lane's shortest gap between slots, so an on-time fallback never sees the previous slot's dispatch: it runs, and the Worker's own dedupe then stands aside. Not gated: `catalog-bake.yml` (its switch above already turns the fallback off, and the file is a component-bake definition path), `satellite-archive.yml` (disabled), `staging-place-renewal.yml` (its controller digest covers the workflow file, and a surf dispatch cannot be told from an all-families one in the run list) and `production-place-renewal.yml` (a scheduled run already stands aside when production serves tides under 20 h old). `tests/fallback-stand-aside.mjs` holds every Worker-dispatched workflow with a schedule to this split.

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

After a release, `npm run verify:live` (with a read token in `CLOUDFLARE_API_TOKEN`) re-checks the live trigger set and bindings, and the Actions list should show `workflow_dispatch` runs at the table's minutes: `bake` "all models + whole-data maintenance" at 02:35/08:35/14:35/20:35, `WeatherX fusion issuance` at :23 every 6 h, `WeatherX staging search candidate` at :17 every 6 h, `WeatherX staging place renewal` at :37 and :47, GloFAS at 11:15/13:15, CAMS at :40.

Local validation is read-only:

```sh
npm ci
npm run check
```
