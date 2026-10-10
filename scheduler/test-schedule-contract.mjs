import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadSchedulerConfig } from './scripts/live-schedules.mjs';

const { expectedCrons, expectedTarget, expectedVars } = await loadSchedulerConfig();
const runtime = await readFile(new URL('./src/schedules.ts', import.meta.url), 'utf8');
const catalogWorkflow = await readFile(new URL('../.github/workflows/catalog-bake.yml', import.meta.url), 'utf8');
const archiveWorkflow = await readFile(new URL('../.github/workflows/satellite-archive.yml', import.meta.url), 'utf8');
const bakeWorkflow = await readFile(new URL('../.github/workflows/bake.yml', import.meta.url), 'utf8');
const deployWorkflow = await readFile(new URL('../.github/workflows/scheduler-deploy.yml', import.meta.url), 'utf8');
const glofasWorkflow = await readFile(new URL('../.github/workflows/glofas-ingest.yml', import.meta.url), 'utf8');
const camsWorkflow = await readFile(new URL('../.github/workflows/cams-ingest.yml', import.meta.url), 'utf8');
const fusionIssueWorkflow = await readFile(new URL('../.github/workflows/fusion-issue.yml', import.meta.url), 'utf8');
const searchWorkflow = await readFile(new URL('../.github/workflows/staging-search.yml', import.meta.url), 'utf8');
const placeWorkflow = await readFile(new URL('../.github/workflows/staging-place-renewal.yml', import.meta.url), 'utf8');
const placePolicy = JSON.parse(await readFile(new URL('../tools/staging-place-renewal-policy.json', import.meta.url), 'utf8'));
const productionPlaceWorkflow = await readFile(new URL('../.github/workflows/production-place-renewal.yml', import.meta.url), 'utf8');
const productionPlacePolicy = JSON.parse(await readFile(new URL('../tools/production-place-renewal-policy.json', import.meta.url), 'utf8'));
const ENERGY_CRONS = { glofas: '15 11,13 * * *', cams: '40 0,10,12,22 * * *' };
// Every on-time lane the Worker dispatches (2026-10-10): its trigger, its GitHub-native fallback
// cron(s) in the target workflow, and why the minute is what it is.
const LANES = [
  { lane: 'whole-data bake', cron: '35 2,8,14,20 * * *', workflow: bakeWorkflow, fallback: ['30 2,8,14,20 * * *'] },
  { lane: 'fusion issuance', cron: '23 */6 * * *', workflow: fusionIssueWorkflow, fallback: ['23 */6 * * *'] },
  { lane: 'staging search renewal', cron: '17 */6 * * *', workflow: searchWorkflow, fallback: ['17 */6 * * *'] },
  { lane: 'staging surf renewal', cron: placePolicy.surfSchedule, workflow: placeWorkflow, fallback: [placePolicy.surfSchedule] },
  { lane: 'staging directory and tide renewal', cron: placePolicy.directoryTideSchedule, workflow: placeWorkflow,
    fallback: [placePolicy.directoryTideSchedule] },
  { lane: 'production tide renewal', cron: productionPlacePolicy.schedules[0], workflow: productionPlaceWorkflow,
    fallback: productionPlacePolicy.schedules },
  { lane: 'energy glofas', cron: ENERGY_CRONS.glofas, workflow: glofasWorkflow, fallback: [ENERGY_CRONS.glofas] },
  { lane: 'energy cams', cron: ENERGY_CRONS.cams, workflow: camsWorkflow, fallback: [ENERGY_CRONS.cams] },
];

const runtimeCrons = [...runtime.matchAll(/export const \w+_CRON = '([^']+)'/g)].map((match) => match[1]);
const workflowCrons = [...catalogWorkflow.matchAll(/^\s+- cron: '([^']+)'$/gm)].map((match) => match[1]);

assert.deepEqual([...runtimeCrons].sort(), [...expectedCrons].sort(), 'runtime cron mapping must match wrangler triggers');
assert.deepEqual([...workflowCrons].sort(), expectedCrons.filter((cron) => !['23 * * * *', ...LANES.map(({ cron }) => cron)].includes(cron)).sort(),
  'catalog GitHub fallback crons must match the catalog scheduler triggers');
assert.equal(expectedCrons.length, 3 + LANES.length, 'every trigger is a catalog, archive or on-time lane trigger');
assert.equal(new Set(LANES.map(({ cron }) => cron)).size, LANES.length, 'one trigger per lane');
for (const { lane, cron, workflow, fallback } of LANES) {
  assert.ok(expectedCrons.includes(cron), `the scheduler must dispatch the ${lane}`);
  for (const slot of fallback) assert.ok(workflow.includes(`- cron: '${slot}'`), `the ${lane} must keep its GitHub-native fallback ${slot}`);
  assert.match(workflow, /workflow_dispatch:/, `the ${lane} workflow must accept a dispatch`);
}
// The whole bake follows the ECMWF landing (~:10) and its own GitHub fallback (:30) by five minutes.
assert.match(bakeWorkflow, /cron: '30 2,8,14,20 \* \* \*'   # ~20 min after each ECMWF publication lands/);
assert.equal(expectedVars.BAKE_GITHUB_WORKFLOW, 'bake.yml');
assert.equal(expectedVars.WIND100_GITHUB_WORKFLOW, undefined, 'the Wind100-only dispatch was folded into the whole bake');
// A scheduler dispatch takes each workflow's scheduled path and obeys the same switch.
assert.match(fusionIssueWorkflow, /\(github\.event_name == 'workflow_dispatch' && inputs\.caller != 'scheduler'\) \|\| vars\.FUSION_ISSUANCE_ENABLED == 'true'/);
assert.match(fusionIssueWorkflow, /if \[ "\$EVENT_NAME" = 'workflow_dispatch' \] && \[ "\$CALLER" != 'scheduler' \]; then/);
assert.match(fusionIssueWorkflow, /case "\$CALLER" in ''\|scheduler\) ;; \*\) exit 1 ;; esac/);
assert.match(searchWorkflow, /inputs\.caller == 'scheduler' && inputs\.action == 'renew'\)\) && vars\.STAGING_SEARCH_SCHEDULE_ENABLED == 'true'/);
assert.match(productionPlaceWorkflow, /if: \(github\.event_name == 'workflow_dispatch' && inputs\.caller != 'scheduler'\) \|\| vars\.PRODUCTION_PLACES_RENEWAL_ENABLED == 'true'/,
  'a scheduler dispatch of the production tide renewal obeys the same switch as its schedule');
assert.deepEqual(productionPlacePolicy.schedules, ['52 9 * * *', '52 21 * * *'], 'the production place policy owns the tide slots');
assert.deepEqual([placePolicy.surfSchedule, placePolicy.directoryTideSchedule], ['37 1,7,13,19 * * *', '47 5,17 * * *'],
  'the place renewal policy owns the surf and directory/tide slots');
assert.match(archiveWorkflow, /cron: '25 \* \* \* \*'/,
  'the archive must retain an independent GitHub-native fallback');
assert.match(archiveWorkflow, /inputs\.policy == 'hourly-tail-v1'/,
  'the external scheduler may dispatch only the constrained hourly archive path');
assert.match(bakeWorkflow,
  /\(inputs\.staging_wind100_only != true && \(inputs\.model == '' \|\| inputs\.model == 'all' \|\| inputs\.model == 'ecmwf'\)\)/,
  'a model=all dispatch must run the ECMWF collector');
assert.match(bakeWorkflow,
  /staging-wind100:\n[\s\S]*?if: \$\{\{ needs\.core-ecmwf\.result == 'success' && \(inputs\.staging_wind100_only != true/,
  'the whole bake still publishes staging Wind100 after the ECMWF collector');
for (const [family, text] of [['glofas', glofasWorkflow], ['cams', camsWorkflow]]) {
  assert.ok(expectedCrons.includes(ENERGY_CRONS[family]), `the scheduler must dispatch the energy ${family} ingest`);
  assert.ok(text.includes(`- cron: '${ENERGY_CRONS[family]}'`), `energy ${family} ingest must keep its GitHub-native fallback at the same slots`);
  assert.match(text, /test "\$APPROVED_SHA" = "\$ATMOS_SHA"/, `energy ${family} ingest must run only the approved producer source`);
  assert.match(text, /served=true/, `energy ${family} ingest must stand aside when its run is already served`);
}
assert.equal(expectedTarget, 'production', 'the reviewed scheduler release must publish guarded production components');
assert.match(catalogWorkflow,
  /github\.event_name == 'workflow_dispatch' \|\| vars\.CATALOG_GITHUB_FALLBACK_DISABLED != 'true'/,
  'GitHub fallback must fail open unless an operator explicitly disables it');
assert.doesNotMatch(catalogWorkflow, /CATALOG_SCHEDULER_ENABLED/,
  'legacy opt-in gating can silently leave the platform without a publisher');
assert.match(catalogWorkflow, /options: \[staging, production\]/,
  'manual component dispatches must select an isolated catalog target');
assert.match(catalogWorkflow, /vars\.CATALOG_DEFAULT_TARGET \|\| 'staging'/,
  'native fallback must default safely to staging until production is explicitly selected');
assert.match(catalogWorkflow, /weatherx-data-production/,
  'production dispatches must use the production catalog bucket');
assert.match(catalogWorkflow, /weatherx-components-production/,
  'production dispatches must use the production component bucket');
assert.doesNotMatch(deployWorkflow, /^\s+push:/m, 'scheduler deploys are manual: plan, then release');
assert.match(deployWorkflow, /run: node tools\/scheduler-release\.mjs "\$RELEASE_MODE"/,
  'the release must apply code and triggers through the compare-and-swap controller');
assert.match(deployWorkflow, /secrets\.CLOUDFLARE_WORKERS_API_TOKEN/,
  'scheduler deploy must use its dedicated least-privilege Workers credential');
assert.doesNotMatch(deployWorkflow, /secrets\.CLOUDFLARE_API_TOKEN/,
  'scheduler deploy must not reuse the Pages publication credential');

console.log('scheduler deployment and cron contract: ok');
