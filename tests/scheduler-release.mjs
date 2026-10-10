import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCOUNT, WORKER, admit, confirmation, cronDiff, declaration, declarationSha256, liveBindings, main, planReport,
  readLive, recoveryAction, releaseCommand, summaryLines, varDiff, verifyLive, writeCrons,
} from '../tools/scheduler-release.mjs';
import { loadSchedulerConfig } from '../scheduler/scripts/live-schedules.mjs';

const config = await loadSchedulerConfig(new URL('../scheduler/wrangler.jsonc', import.meta.url));
const decl = declaration(config);
const digest = declarationSha256(decl);
const V1 = '11111111-2222-4333-8444-555555555555', V2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';
// The trigger set the live Worker has carried since the 2026-09-12 deploy (run 34674247439).
const LIVE_0912 = ['8-59/10 * * * *', '7 * * * *', '23 * * * *', '35 2,8,14,20 * * *'];
const liveVars = { ...decl.vars, WIND100_GITHUB_WORKFLOW: 'bake.yml' };
delete liveVars.BAKE_GITHUB_WORKFLOW;
const bindingsOf = (vars, secrets = ['GITHUB_DISPATCH_TOKEN']) => [
  ...Object.entries(vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
  ...secrets.map(name => ({ name, type: 'secret_text' })),
];
const deploymentsOf = id => ({ deployments: [{ created_on: '2026-09-12T04:55:49Z', versions: [{ version_id: id, percentage: 100 }] }] });

function fakeCloudflare(state) {
  const calls = [];
  const request = async (url, token, init = {}) => {
    calls.push({ url, token, method: init.method ?? 'GET', body: init.body });
    assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/`));
    const path = url.slice(url.lastIndexOf('/') + 1);
    if (init.method === 'PUT') {
      assert.equal(path, 'schedules');
      state.crons = JSON.parse(init.body).map(row => row.cron);
      return { success: true, result: { schedules: state.crons.map(cron => ({ cron })) } };
    }
    if (path === 'deployments') return { success: true, result: deploymentsOf(state.active) };
    if (path === 'schedules') return { success: true, result: { schedules: state.crons.map(cron => ({ cron })) } };
    if (path === 'settings') return { success: true, result: { bindings: bindingsOf(state.vars, state.secrets) } };
    throw Error(`unexpected ${url}`);
  };
  return { request, calls };
}

test('the declaration is the reviewed Worker, its sorted triggers, vars and secret name', () => {
  assert.equal(decl.worker, 'weatherx-model-scheduler');
  assert.equal(decl.account, ACCOUNT);
  assert.deepEqual(decl.crons, [...config.expectedCrons].sort());
  assert.equal(decl.crons.length, 10);
  assert.equal(decl.vars.BAKE_GITHUB_WORKFLOW, 'bake.yml');
  assert.equal(decl.vars.CATALOG_TARGET, 'production');
  assert.deepEqual(decl.secrets, ['GITHUB_DISPATCH_TOKEN']);
  assert.match(digest, /^[a-f0-9]{64}$/);
  // The digest moves with any trigger, var or secret-name change.
  assert.notEqual(declarationSha256({ ...decl, crons: decl.crons.slice(1) }), digest);
  assert.notEqual(declarationSha256({ ...decl, vars: { ...decl.vars, GITHUB_REF: 'other' } }), digest);
  assert.throws(() => declaration({ ...config, workerName: 'other' }), /Worker name changed/);
  assert.throws(() => declaration({ ...config, accountId: '0'.repeat(32) }), /account changed/);
});

test('plan and release admission bind the mode, the planned version and the planned declaration', () => {
  assert.deepEqual(admit({ RELEASE_MODE: 'plan', CONFIRM: 'PLAN-SCHEDULER' }, digest), { mode: 'plan', expected: null });
  assert.throws(() => admit({ RELEASE_MODE: 'plan', CONFIRM: 'PLAN-SCHEDULER', EXPECTED_ACTIVE_VERSION_ID: V1 }, digest));
  assert.throws(() => admit({ RELEASE_MODE: 'plan', CONFIRM: 'yes' }, digest));
  const release = { RELEASE_MODE: 'release', CONFIRM: confirmation('release', digest), EXPECTED_ACTIVE_VERSION_ID: V1 };
  assert.deepEqual(admit(release, digest), { mode: 'release', expected: V1 });
  assert.throws(() => admit(release, 'f'.repeat(64)), /run plan again/, 'a declaration changed after the plan is refused');
  assert.throws(() => admit({ ...release, EXPECTED_ACTIVE_VERSION_ID: '' }, digest), /active version/);
  assert.throws(() => admit({ ...release, CONFIRM: 'RELEASE-SCHEDULER' }, digest));
  assert.throws(() => admit({ ...release, RELEASE_MODE: 'deploy' }, digest), /unknown release mode/);
});

test('plan reports declared vs live crons and vars and refuses a Worker without its dispatch secret', () => {
  const live = { active: V1, crons: LIVE_0912, bindings: bindingsOf(liveVars) };
  const report = planReport(decl, live);
  assert.equal(report.activeVersionId, V1);
  assert.deepEqual(report.crons.remove, []);
  assert.deepEqual(report.crons.add, ['15 11,13 * * *', '17 */6 * * *', '23 */6 * * *', '37 1,7,13,19 * * *',
    '40 0,10,12,22 * * *', '47 5,17 * * *']);
  assert.deepEqual(report.crons.keep, [...LIVE_0912].sort());
  assert.deepEqual(report.vars, [
    { name: 'BAKE_GITHUB_WORKFLOW', live: null, declared: 'bake.yml' },
    { name: 'WIND100_GITHUB_WORKFLOW', live: 'bake.yml', declared: null },
  ]);
  assert.throws(() => planReport(decl, { ...live, bindings: bindingsOf(liveVars, []) }), /lacks required secret/);
  const lines = summaryLines(report, digest, 'plan').join('\n');
  assert.match(lines, /\| `47 5,17 \* \* \*` \| no \| yes \|/);
  assert.match(lines, /\| `35 2,8,14,20 \* \* \*` \| yes \| yes \|/);
  assert.ok(lines.includes(releaseCommand(V1, digest)));
  assert.equal(releaseCommand(V1, digest), 'gh workflow run scheduler-deploy.yml -R Andrewegao/v3t7kq-cycle --ref main '
    + `-f mode=release -f expected_active_version_id=${V1} -f confirm=RELEASE-SCHEDULER:${digest}`);
});

test('diff helpers', () => {
  assert.deepEqual(cronDiff(['a', 'b'], ['b', 'c']), { keep: ['b'], add: ['a'], remove: ['c'] });
  assert.deepEqual(varDiff({ A: '1', B: '2' }, { A: '1', B: '3', C: '4' }),
    [{ name: 'B', live: '3', declared: '2' }, { name: 'C', live: '4', declared: null }]);
  assert.deepEqual(liveBindings(bindingsOf({ A: '1' }, ['S'])), { vars: { A: '1' }, secrets: ['S'] });
});

test('live readback must equal the declaration: active candidate, exact crons, exact vars and secret', async () => {
  const state = { active: V2, crons: [...decl.crons].reverse(), vars: decl.vars };
  const { request } = fakeCloudflare(state);
  assert.deepEqual(await verifyLive('t', decl, V2, 'production', { request, attempts: 1, delay: 0 }),
    { active: V2, crons: decl.crons });
  for (const drift of [{ active: V1 }, { crons: LIVE_0912 }, { vars: liveVars }, { secrets: [] },
    { vars: { ...decl.vars, CATALOG_TARGET: 'staging' } }]) {
    const fake = fakeCloudflare({ ...state, ...drift });
    await assert.rejects(verifyLive('t', decl, V2, 'production', { request: fake.request, attempts: 2, delay: 0 }),
      /did not match the declaration/);
  }
});

test('triggers are written and read back through the schedules API; reads never write', async () => {
  const state = { active: V1, crons: LIVE_0912, vars: liveVars };
  const { request, calls } = fakeCloudflare(state);
  const live = await readLive('token', request);
  assert.equal(live.active, V1);
  assert.deepEqual(live.crons, LIVE_0912);
  assert.ok(calls.every(call => call.method === 'GET' && call.token === 'token'));
  await writeCrons('token', decl.crons, request);
  assert.deepEqual(state.crons, decl.crons);
  assert.equal(calls.at(-1).method, 'PUT');
  assert.deepEqual(JSON.parse(calls.at(-1).body), decl.crons.map(cron => ({ cron })));
  await assert.rejects(readLive('token', async () => ({ success: true, result: { deployments: [
    { created_on: '2026-10-10T00:00:00Z', versions: [{ version_id: V1, percentage: 50 }, { version_id: V2, percentage: 50 }] }] } })),
  /mixed or missing deployment/);
});

test('recovery restores only this run\'s candidate', () => {
  const receipt = { previous: V1, candidate: V2 };
  assert.equal(recoveryAction(V2, receipt), 'restore-owned-candidate');
  assert.equal(recoveryAction(V1, receipt), 'restore-triggers-only');
  assert.throws(() => recoveryAction('99999999-2222-4333-8444-555555555555', receipt), /different publisher/);
});

test('the controller refuses outside the exact manual main workflow and without its dedicated token', async () => {
  const base = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'release', WORKER_RELEASE_ENVIRONMENT: 'production',
    GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/scheduler-deploy.yml@refs/heads/main',
    SCHEDULER_WORKER_TOKEN: 'x', RELEASE_DIR: '/nonexistent/scheduler-release', RELEASE_MODE: 'plan', CONFIRM: 'PLAN-SCHEDULER' };
  for (const change of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/feature' }, { SCHEDULER_WORKER_TOKEN: '' },
    { CLOUDFLARE_API_TOKEN: 'pages' }, { GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/other.yml@refs/heads/main' },
    { RELEASE_DIR: 'relative' }]) {
    await assert.rejects(main('plan', { ...base, ...change }));
  }
  await assert.rejects(main('deploy', base), /unknown command/);
  await assert.rejects(main('release', base), /does not match the admitted mode/);
});

test('the deploy workflow is manual-only, plan-first, uses the dedicated Workers token and restores on failure', () => {
  const workflow = readFileSync(new URL('../.github/workflows/scheduler-deploy.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /^\s+(?:push|pull_request|schedule|workflow_run):/m, 'nothing deploys the scheduler automatically');
  assert.match(workflow, /default: plan\n\s+type: choice\n\s+options: \[plan, release\]/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /group: weatherx-model-scheduler-production\n\s+cancel-in-progress: false/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /npm run check --prefix scheduler\n\s+node --test tests\/scheduler-release\.mjs\n\s+git diff --exit-code HEAD/);
  assert.equal((workflow.match(/SCHEDULER_WORKER_TOKEN: \$\{\{ secrets\.CLOUDFLARE_WORKERS_API_TOKEN \}\}/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN|CLOUDFLARE_DATA_EDGE_API_TOKEN|wrangler deploy\b/);
  assert.match(workflow, /run: node tools\/scheduler-release\.mjs "\$RELEASE_MODE"/);
  assert.match(workflow, /if: \$\{\{ always\(\) && inputs\.mode == 'release' && \(steps\.release_worker\.outcome == 'failure' \|\| steps\.release_worker\.outcome == 'cancelled'\) \}\}\n[\s\S]*?run: node tools\/scheduler-release\.mjs recover/);
  const gates = workflow.indexOf('npm run check --prefix scheduler');
  assert.ok(gates > 0 && gates < workflow.indexOf('SCHEDULER_WORKER_TOKEN'), 'release gates run before any credential');
  const ci = readFileSync(new URL('../.github/workflows/scheduler-ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /node --test tests\/scheduler-release\.mjs/);
});
