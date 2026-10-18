// Stuck writer-lock reaper and paginated gate lookup, on API responses recorded on 2026-10-18 for the
// two runs left waiting at the production gate by the 2026-10-12 Actions incident:
// catalog-bake run 38263168806 `model (hrrr)` and observation-refresh run 38283354381 `refresh`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CANCEL_CHECKS, CANCEL_CHECK_MS, GATE_CALL_BUDGET, GATE_PAGES, STUCK_WAITING_MINUTES, componentPlan, gateBudget, gateRefusal, gateWaitingSince,
  holderJobName, lockHolders, main as summaryMain, observationPlan, reapRefusal, reapStuckHolders} from '../tools/workflow-run-summary.mjs';
import {main as chainMain} from '../tools/observation-chain.mjs';

const RECORDED = JSON.parse(readFileSync(new URL('./fixtures/stuck-lock-20261012.json', import.meta.url), 'utf8'));
// Five minutes before the owner cancelled both runs (18:12Z).
const NOW = Date.parse('2026-10-18T18:05:00Z');
const HRRR = '38263168806', OBS = '38283354381';
const HRRR_JOB = 114858721805, OBS_JOB = 114925792643;
const clone = value => structuredClone(value);
const before = rows => rows.filter(row => Date.parse(row.created_at) <= NOW);

// The recorded state rewound to NOW: the stuck runs and their gate jobs are waiting again, and the
// cancel's `error` statuses and the summary job created by the cancel are not there yet.
function recorded({runs = [HRRR, OBS], cancel = 'completes', force = 'completes', environment = RECORDED.environments.production,
  edit = () => {}, pages = RECORDED.deploymentPages, statuses = RECORDED.statuses, onRequest = () => {}} = {}) {
  const state = {runs: {}, jobs: {}, environment: clone(environment), pages, statuses, totalCount: {}};
  for (const id of runs) {
    state.runs[id] = {...clone(RECORDED.runs[id]), status: 'waiting', conclusion: null};
    state.jobs[id] = before(clone(RECORDED.jobs[id])).map(job => job.status === 'completed' && job.conclusion === 'cancelled'
      ? {...job, status: 'waiting', conclusion: null, completed_at: null} : job);
  }
  edit(state);
  const requests = [];
  const json = (value, status = 200) => new Response(JSON.stringify(value), {status});
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url);
    const path = parsed.pathname.replace('/repos/Andrewegao/v3t7kq-cycle', '');
    const method = init.method ?? 'GET';
    requests.push({method, path, query: Object.fromEntries(parsed.searchParams)});
    onRequest(state, method, path);
    let match;
    if (method === 'GET' && path === '/actions/runs') {
      const status = parsed.searchParams.get('status');
      return json({workflow_runs: Object.values(state.runs).filter(run => run.status === status)});
    }
    if ((match = /^\/actions\/runs\/(\d+)\/jobs$/.exec(path)))
      return json({total_count: state.totalCount[match[1]] ?? state.jobs[match[1]]?.length ?? 0, jobs: state.jobs[match[1]] ?? []});
    if ((match = /^\/actions\/workflows\/([a-z0-9-]+\.yml)\/runs$/.exec(path)))
      return json({workflow_runs: Object.values(state.runs).filter(run => run.path === `.github/workflows/${match[1]}`
        && (!parsed.searchParams.get('status') || run.status === parsed.searchParams.get('status')))});
    if ((match = /^\/actions\/runs\/(\d+)$/.exec(path)) && method === 'GET') return state.runs[match[1]] ? json(state.runs[match[1]]) : json({message: 'Not Found'}, 404);
    if ((match = /^\/actions\/runs\/(\d+)\/(cancel|force-cancel)$/.exec(path)) && method === 'POST') {
      const behaviour = match[2] === 'cancel' ? cancel : force;
      if (typeof behaviour === 'number') return new Response('{"message":"refused"}', {status: behaviour});
      if (behaviour === 'network') throw new TypeError('fetch failed');
      if (behaviour === 'completes') {
        state.runs[match[1]] = {...state.runs[match[1]], status: 'completed', conclusion: 'cancelled'};
        for (const job of state.jobs[match[1]]) if (job.status !== 'completed') Object.assign(job, {status: 'completed', conclusion: 'cancelled'});
      }
      if (typeof behaviour === 'function') behaviour(state, match[1]);
      return new Response('{}', {status: 202});
    }
    if (path === '/deployments') {
      const query = parsed.searchParams;
      assert.deepEqual([query.get('environment'), query.get('task'), query.get('ref'), query.get('sha'), query.get('per_page')],
        ['production', 'deploy', 'main', RECORDED.sha, '100'], 'deployments are queried by environment, task, ref and SHA');
      const rows = state.pages[Number(query.get('page')) - 1] ?? [];
      return json(rows.map(([id, created_at]) => ({id, created_at, environment: 'production', ref: 'main', task: 'deploy', sha: RECORDED.sha})));
    }
    if ((match = /^\/deployments\/(\d+)\/statuses$/.exec(path))) return json(before(clone(state.statuses[match[1]] ?? [])));
    if (path === '/environments/production') return state.environment ? json(state.environment) : json({message: 'Not Found'}, 404);
    return json({workflow_runs: []});
  };
  const sleeps = [];
  const sleep = async ms => { sleeps.push(ms); };
  const posts = () => requests.filter(row => row.method === 'POST').map(row => row.path);
  return {state, requests, fetcher, sleep, sleeps, posts};
}
const componentEnv = {GITHUB_RUN_ID: '39152035615', CATALOG_TARGET: 'production', REQUESTED_MODELS: '["hrrr"]'};

test('the gate lookup pages the environment\'s deployments to the stuck HRRR job (page 12 of the recorded list) and stops there', async () => {
  const fixture = recorded({runs: [HRRR]});
  const gate = await gateWaitingSince({run: fixture.state.runs[HRRR], job: fixture.state.jobs[HRRR].find(job => job.id === HRRR_JOB), token: 't', fetcher: fixture.fetcher});
  assert.deepEqual(gate, {since: '2026-10-12T14:28:46Z', environment: 'production', deploymentId: 7016457902});
  const pages = fixture.requests.filter(row => row.path === '/deployments').map(row => Number(row.query.page));
  assert.deepEqual(pages, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'the old lookup read page 1 only and reported "gate status not found"');
  // Only deployments created within two minutes of the job start have their statuses read.
  const read = fixture.requests.filter(row => row.path.endsWith('/statuses')).map(row => row.path);
  assert.ok(read.includes('/deployments/7016457902/statuses'));
  assert.ok(read.length <= 5, `read ${read.length} status lists`);
});

test('the gate lookup gives up as unknown past the page cap, past the job start, or when the job\'s newest status is not waiting', async () => {
  const run = {...RECORDED.runs[HRRR], status: 'waiting'};
  const job = {id: HRRR_JOB, started_at: '2026-10-12T14:28:45Z'};
  // Deployment beyond GATE_PAGES full pages: unknown, never measured from the job start here.
  const filler = Array.from({length: GATE_PAGES}, (_, page) => Array.from({length: 100}, (_, i) =>
    [9e9 - page * 100 - i, new Date(Date.parse('2026-10-18T18:00:00Z') - (page * 100 + i) * 60000).toISOString()]));
  const deep = recorded({runs: [HRRR], pages: [...filler, ...RECORDED.deploymentPages]});
  assert.equal(await gateWaitingSince({run, job, token: 't', fetcher: deep.fetcher}), null);
  assert.equal(deep.requests.filter(row => row.path === '/deployments').length, GATE_PAGES);
  // A job that started after the newest page's oldest row: one page is read and nothing matches.
  const early = recorded({runs: [HRRR]});
  assert.equal(await gateWaitingSince({run, job: {id: 1, started_at: '2026-10-18T12:00:00Z'}, token: 't', fetcher: early.fetcher}), null);
  assert.equal(early.requests.filter(row => row.path === '/deployments').length, 1);
  // The deployment in the time window belongs to another job: not this job's gate.
  const other = recorded({runs: [HRRR]});
  assert.equal(await gateWaitingSince({run, job: {id: 999, started_at: job.started_at}, token: 't', fetcher: other.fetcher}), null);
  // After the cancel the job's newest status is `error`: not waiting at the gate any more.
  const clock = Date.now;
  const after = recorded({runs: [HRRR]});
  const fetcher = async (url, init) => /\/statuses/.test(url) ? new Response(JSON.stringify(RECORDED.statuses['7016457902'])) : after.fetcher(url, init);
  try { assert.equal(await gateWaitingSince({run, job, token: 't', fetcher}), null); } finally { Date.now = clock; }
});

test('known gate time over 30 min: the component plan cancels the recorded HRRR holder with a normal cancel and publishes HRRR itself', async () => {
  const fixture = recorded({runs: [HRRR]});
  const plan = await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.posts(), [`/actions/runs/${HRRR}/cancel`]);
  assert.deepEqual(plan.models, ['hrrr']);
  assert.match(plan.text, /### Stuck writer locks/);
  assert.match(plan.text, /- CANCELLED run 38263168806 \(catalog-bake\.yml\) job "model \(hrrr\)": it has been waiting at the production environment gate since 147\.6 h ago \(deployment status `waiting` at 2026-10-12T14:28:46Z\), holding weatherx-component-production-hrrr; only a branch-policy environment, no started step, every unfinished job of its run an orphaned gate wait\. A normal cancel completed; the lock is free\./);
  assert.deepEqual(fixture.sleeps, [CANCEL_CHECK_MS]);
  // The environment is read before any write.
  const order = fixture.requests.map(row => `${row.method} ${row.path}`);
  assert.ok(order.indexOf('GET /environments/production') < order.indexOf(`POST /actions/runs/${HRRR}/cancel`));
});

test('a normal cancel that leaves the run waiting (the incident shape) is followed by one force-cancel after the bounded re-check', async () => {
  const fixture = recorded({runs: [HRRR], cancel: 'ignored'});
  const plan = await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.posts(), [`/actions/runs/${HRRR}/cancel`, `/actions/runs/${HRRR}/force-cancel`]);
  assert.deepEqual(fixture.sleeps, [...Array(CANCEL_CHECKS).fill(CANCEL_CHECK_MS), CANCEL_CHECK_MS]);
  assert.match(plan.text, /- FORCE-CANCELLED run 38263168806 \(catalog-bake\.yml\) job "model \(hrrr\)": .* A normal cancel was accepted but did not complete within 20 s, so the run was force-cancelled and completed; the lock is free\./);
});

test('force-cancel is withheld when the job started after the normal cancel, and an unfinished force-cancel is reported, not hidden', async () => {
  const started = recorded({runs: [HRRR], cancel: (state, id) => {
    const job = state.jobs[id].find(row => row.id === HRRR_JOB);
    Object.assign(job, {status: 'in_progress', steps: [{name: 'Set up job', status: 'in_progress'}]});
    state.runs[id].status = 'in_progress';
  }});
  const plan = await componentPlan({env: componentEnv, token: 't', fetcher: started.fetcher, now: NOW, sleep: started.sleep});
  assert.deepEqual(started.posts(), [`/actions/runs/${HRRR}/cancel`]);
  assert.match(plan.text, /- NOT FORCE-CANCELLED run 38263168806 .* so it was not force-cancelled\. The next plan run checks again\./);
  const stubborn = recorded({runs: [HRRR], cancel: 'ignored', force: 'ignored'});
  const text = (await componentPlan({env: componentEnv, token: 't', fetcher: stubborn.fetcher, now: NOW, sleep: stubborn.sleep})).text;
  assert.deepEqual(stubborn.posts(), [`/actions/runs/${HRRR}/cancel`, `/actions/runs/${HRRR}/force-cancel`]);
  assert.match(text, /- STILL LISTED run 38263168806 .* Cancel \(HTTP 202\) and force-cancel \(HTTP 202\) were requested, but the run was not completed after 20 s each/);
});

test('unknown gate time: a holder whose deployment status is not found is reported stuck from its start but never cancelled', async () => {
  const fixture = recorded({runs: [HRRR], pages: RECORDED.deploymentPages.slice(0, 11)});
  const holders = await lockHolders({runId: '1', token: 't', fetcher: fixture.fetcher, now: NOW, only: ['hrrr']});
  assert.deepEqual(holders.map(row => [row.model, row.gateUnknown, row.stuck, row.gateSince]), [['hrrr', true, true, null]]);
  const plan = await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.posts(), []);
  assert.match(plan.text, /- NOT CANCELLED run 38263168806 \(catalog-bake\.yml\) job "model \(hrrr\)": it has been waiting at the environment gate since 147\.6 h ago \(gate status not found; measured from job start\), holding weatherx-component-production-hrrr; not cancelled automatically because its gate waiting time is unknown/);
  assert.match(gateRefusal({status: 'waiting', gateUnknown: true, gateSince: null}, NOW), /never cancelled on its start time/);
});

test('the gate must be older than 30 minutes: a fresh or borderline gate wait is left alone', () => {
  const holder = {status: 'waiting', gateUnknown: false, environment: 'production', gateSince: new Date(NOW - STUCK_WAITING_MINUTES * 60000).toISOString()};
  assert.match(gateRefusal(holder, NOW), /waited at the gate for 30 min, not more than 30/);
  assert.equal(gateRefusal({...holder, gateSince: new Date(NOW - 31 * 60000).toISOString()}, NOW), null);
  assert.match(gateRefusal({...holder, status: 'in_progress'}, NOW), /not waiting at an environment gate/);
});

test('in_progress: a run, a sibling job or a started step anywhere in the holder blocks the cancel', async () => {
  const cases = [
    ['its run is in_progress', state => { state.runs[HRRR].status = 'in_progress'; }],
    ['job "plan" of that run is in_progress', state => { state.jobs[HRRR][0].status = 'in_progress'; }],
    ['job "model (hrrr)" has a started step', state => { state.jobs[HRRR].find(job => job.id === HRRR_JOB).steps = [{name: 'Set up job', status: 'in_progress'}]; }],
  ];
  for (const [reason, edit] of cases) {
    const fixture = recorded({runs: [HRRR], edit});
    // lockHolders lists in_progress runs too, so the holder is still found.
    const text = (await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep})).text;
    assert.deepEqual(fixture.posts(), [], reason);
    assert.ok(text.includes(`not cancelled automatically because ${reason}. The owner must cancel that run.`), `${reason}\n${text}`);
  }
});

test('reviewers: an environment with required reviewers, a wait timer, or an unreadable environment is never reaped', async () => {
  const reviewers = {...RECORDED.environments['ui-production'], name: 'production'};
  assert.ok(reviewers.protection_rules.some(rule => rule.type === 'required_reviewers'), 'recorded ui-production rules');
  for (const [environment, reason] of [[reviewers, 'environment production has required reviewers'],
    [{name: 'production', protection_rules: [{type: 'wait_timer', wait_timer: 60}]}, 'environment production has a wait_timer protection rule (only branch_policy is reapable)'],
    [{name: 'production', protection_rules: [{type: 'branch_policy'}, {type: 'custom_gate'}]}, 'environment production has a custom_gate protection rule (only branch_policy is reapable)'],
    [null, 'environment production could not be read']]) {
    const fixture = recorded({runs: [HRRR], environment});
    const text = (await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep})).text;
    assert.deepEqual(fixture.posts(), [], reason);
    assert.ok(text.includes(`because ${reason}.`), text);
  }
  // The recorded production environment (branch policy only) is reapable.
  const holder = {status: 'waiting', gateUnknown: false, environment: 'production', gateSince: '2026-10-12T14:28:46Z', workflow: 'catalog-bake.yml', jobId: HRRR_JOB};
  assert.equal(reapRefusal({holder, now: NOW, environment: RECORDED.environments.production,
    run: {...RECORDED.runs[HRRR], status: 'waiting'}, jobs: [{id: HRRR_JOB, status: 'waiting', steps: []}]}), null);
  assert.match(reapRefusal({holder, now: NOW, environment: RECORDED.environments.production,
    run: {...RECORDED.runs[HRRR], status: 'waiting', head_branch: 'feature'}, jobs: [{id: HRRR_JOB, status: 'waiting'}]}), /writer workflow on main/);
});

test('a staging-target or tokenless component plan never reads or cancels production holders', async () => {
  const fixture = recorded({runs: [HRRR]});
  await componentPlan({env: {...componentEnv, CATALOG_TARGET: 'staging'}, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  await componentPlan({env: componentEnv, token: '', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.requests, []);
  // A plan only frees the locks of the models it requests.
  await componentPlan({env: {...componentEnv, REQUESTED_MODELS: '["ecmwf","gfs","aifs"]'}, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.posts(), []);
});

test('the observation plan cancels the recorded observation holder and then proceeds; one it cannot cancel keeps it BLOCKED', async () => {
  const fixture = recorded({runs: [OBS]});
  const plan = await observationPlan({env: {GITHUB_RUN_ID: '39152000000', GITHUB_EVENT_NAME: 'schedule', ENABLED: 'true'}, event: {},
    token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.posts(), [`/actions/runs/${OBS}/cancel`]);
  assert.equal(plan.run, true);assert.equal(plan.code, 0);
  assert.match(plan.text, /- CANCELLED run 38283354381 \(observation-refresh\.yml\) job "refresh": it has been waiting at the production environment gate since 144\.8 h ago \(deployment status `waiting` at 2026-10-12T17:18:58Z\), holding weatherx-observation-components-production/);
  assert.match(plan.text, /This run proceeds and takes the freed weatherx-observation-components-production\./);
  const stubborn = recorded({runs: [OBS], cancel: 'ignored', force: 'ignored'});
  const blocked = await observationPlan({env: {GITHUB_RUN_ID: '1', GITHUB_EVENT_NAME: 'schedule', ENABLED: 'true'}, event: {},
    token: 't', fetcher: stubborn.fetcher, now: NOW, sleep: stubborn.sleep});
  assert.equal(blocked.run, false);assert.equal(blocked.code, 1);assert.match(blocked.text, /BLOCKED[\s\S]*STILL LISTED run 38283354381/);
});

test('the observation chain cancels the stuck lane run and dispatches the lane again', async () => {
  const fixture = recorded({runs: [OBS]});
  const REPO = 1061234567;
  const trigger = {id: 39152035615, path: '.github/workflows/catalog-bake.yml', event: 'workflow_dispatch', head_branch: 'main', repository: {id: REPO}, head_repository: {id: REPO}};
  let dispatched = false;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname.replace('/repos/Andrewegao/v3t7kq-cycle', '');
    const query = new URL(url).searchParams;
    if (path === `/actions/runs/${trigger.id}`) return new Response(JSON.stringify(trigger));
    const lane = /^\/actions\/workflows\/(observation-refresh|five-feed-recovery)\.yml\/runs$/.exec(path);
    if (lane) {
      fixture.requests.push({method: 'GET', path, query: Object.fromEntries(query)});
      const runs = lane[1] === 'observation-refresh' ? Object.values(fixture.state.runs) : [];
      const created = dispatched && query.get('event') === 'workflow_dispatch' ? [{id: 39153000000, path: '.github/workflows/observation-refresh.yml', status: 'queued', event: 'workflow_dispatch'}] : [];
      return new Response(JSON.stringify({workflow_runs: [...created, ...runs.filter(run => !query.get('status') || run.status === query.get('status'))]}));
    }
    if (path === '/actions/workflows/observation-refresh.yml/dispatches') { dispatched = true; fixture.requests.push({method: 'POST', path}); return new Response(null, {status: 204}); }
    return fixture.fetcher(url, init);
  };
  const logged = [];const log = console.log;console.log = line => logged.push(line);
  let code;
  try { code = await chainMain({ENABLED: 'true', GH_TOKEN: 't', GITHUB_RUN_ID: '39152040000', TRIGGER_RUN_ID: String(trigger.id), GITHUB_REPOSITORY_ID: String(REPO)},
    NOW, fetcher, fixture.sleep); } finally { console.log = log; }
  assert.equal(code, 0, logged.join('\n'));
  assert.deepEqual(fixture.posts(), [`/actions/runs/${OBS}/cancel`, '/actions/workflows/observation-refresh.yml/dispatches']);
  const text = logged.join('\n');
  assert.match(text, /## Observation chain: dispatched observation-refresh\.yml \(run 39153000000\)/);
  assert.match(text, /- CANCELLED run 38283354381 \(observation-refresh\.yml\) job "refresh"/);
});

test('reapStuckHolders never throws and cancels each holder run once', async () => {
  const fixture = recorded({runs: [HRRR]});
  const holders = await lockHolders({runId: '1', token: 't', fetcher: fixture.fetcher, now: NOW, only: ['hrrr']});
  const twice = [...holders, ...holders];
  const result = await reapStuckHolders({holders: twice, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.posts(), [`/actions/runs/${HRRR}/cancel`]);
  assert.deepEqual(result.results.map(row => [String(row.runId), row.outcome, row.holders.length]), [[HRRR, 'cancelled', 1]]);
  const broken = await reapStuckHolders({holders, token: 't', fetcher: async () => { throw new Error('network'); }, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(broken.results, []);assert.match(broken.lines.join('\n'), /could not be read \(Actions API\)/);
});

// A whole bake (shape of run 39136712828: every `publish-<model> / publisher` gates on production)
// with HRRR and ICON both stuck at the gate and every other job finished.
const BAKE = '39136712828';
function wholeBake({iconGate = '2026-10-18T16:30:01Z', iconStatus = 'waiting', bakeGate = null} = {}) {
  const job = (id, name, status, started) => ({id, run_id: Number(BAKE), name, status, conclusion: status === 'completed' ? 'success' : null,
    created_at: started, started_at: started, completed_at: status === 'completed' ? started : null, steps: status === 'completed' ? [{name: 'Set up job', status: 'completed'}] : []});
  const statuses = {
    8000000001: [{id: 1, state: 'waiting', created_at: '2026-10-18T16:00:01Z', environment: 'production', target_url: `https://github.com/Andrewegao/v3t7kq-cycle/actions/runs/${BAKE}/job/9001`}],
    8000000002: [{id: 2, state: 'waiting', created_at: iconGate, environment: 'production', target_url: `https://github.com/Andrewegao/v3t7kq-cycle/actions/runs/${BAKE}/job/9002`}],
    // The maintenance `bake` job's own deployment, created when it started with the last publisher.
    8000000005: bakeGate ? [{id: 5, state: 'waiting', created_at: bakeGate, environment: 'production', target_url: `https://github.com/Andrewegao/v3t7kq-cycle/actions/runs/${BAKE}/job/9000`}] : [],
  };
  const pages = [[[8000000003, '2026-10-18T17:59:00Z'], [8000000002, '2026-10-18T16:30:00Z'], [8000000001, '2026-10-18T16:00:00Z'],
    [8000000005, '2026-10-18T15:08:47Z']]];
  return {pages, statuses, runs: [], edit: state => {
    state.runs[BAKE] = {id: Number(BAKE), path: '.github/workflows/bake.yml', status: 'waiting', conclusion: null, event: 'workflow_dispatch', head_branch: 'main',
      head_sha: RECORDED.sha, created_at: '2026-10-18T14:35:54Z', run_started_at: '2026-10-18T14:35:54Z', updated_at: '2026-10-18T16:30:01Z',
      display_title: 'bake: all models + whole-data maintenance', run_attempt: 1};
    state.jobs[BAKE] = [job(9000, 'bake', bakeGate ? 'waiting' : 'completed', '2026-10-18T15:08:47Z'), job(9003, 'publish-ecmwf / publisher', 'completed', '2026-10-18T15:40:00Z'),
      job(9001, 'publish-hrrr / publisher', 'waiting', '2026-10-18T16:00:00Z'), job(9002, 'publish-icon / publisher', iconStatus, '2026-10-18T16:30:00Z')];
  }};
}

test('a whole bake whose only unfinished jobs are two stuck publishers is cancelled as one run, and HRRR is no longer set aside', async () => {
  const fixture = recorded(wholeBake());
  // An HRRR-only plan sees the ICON publisher too: it is checked as a holder in its own right.
  const plan = await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.posts(), [`/actions/runs/${BAKE}/cancel`]);
  assert.match(plan.text, /- CANCELLED run 39136712828 \(bake\.yml\) job "publish-hrrr \/ publisher": it has been waiting at the production environment gate since 2\.1 h ago/);
  assert.match(plan.text, /- CANCELLED run 39136712828 \(bake\.yml\) job "publish-icon \/ publisher": it has been waiting at the production environment gate since 95 min ago[^\n]*holding weatherx-component-production-icon/);
  assert.deepEqual(plan.models, ['hrrr'], 'the cancelled bake no longer queues HRRR, so this run publishes it');
  assert.deepEqual(plan.aside, []);
});

test('a whole bake is kept when any other unfinished job in it is not itself a reapable stuck holder', async () => {
  for (const [variant, reason] of [
    [{iconGate: '2026-10-18T18:00:00Z'}, 'job "publish-icon / publisher" of that run: it has waited at the gate for 5 min, not more than 30'],
    [{iconStatus: 'in_progress'}, 'job "publish-icon / publisher" of that run is in_progress'],
    [{iconStatus: 'queued'}, 'job "publish-icon / publisher" of that run is queued, not waiting at a gate'],
  ]) {
    const fixture = recorded(wholeBake(variant));
    const plan = await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
    assert.deepEqual(fixture.posts(), [], reason);
    assert.ok(plan.text.includes(`job "publish-hrrr / publisher": `) && plan.text.includes(`because ${reason}.`), `${reason}\n${plan.text}`);
  }
  // A non-holder job (here the run summary) still unfinished keeps the run too.
  const fixture = recorded({...wholeBake(), edit: state => { wholeBake().edit(state);
    state.jobs[BAKE].push({id: 9009, name: 'run-summary', status: 'queued', steps: []}); }});
  const text = (await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep})).text;
  assert.deepEqual(fixture.posts(), []);
  assert.match(text, /because job "run-summary" of that run is queued and is not a writer-lock holder\./);
});

test('a resume-model-publication publisher is a lock holder like a whole-bake publisher', () => {
  assert.equal(holderJobName('resume (hrrr) / publisher', 'resume-model-publication.yml'), 'hrrr');
  assert.equal(holderJobName('resume (nam-hi) / publisher'), 'nam-hi');
  assert.equal(holderJobName('resume (unknown) / publisher'), null);
  assert.equal(holderJobName('resume (hrrr) / collector'), null);
});

test('force-cancel never follows a cancel that was not accepted (5xx or network failure)', async () => {
  for (const cancel of [500, 'network']) {
    const fixture = recorded({runs: [HRRR], cancel});
    const plan = await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
    assert.equal(fixture.requests.filter(row => row.method === 'POST' && row.path.endsWith('/force-cancel')).length, 0, String(cancel));
    assert.match(plan.text, new RegExp(`The cancel request was not accepted \\(HTTP ${cancel === 500 ? '500' : 'none: request failed'}\\), so it was not force-cancelled either`));
  }
  // 409 (already cancelling) counts as accepted, so a still-waiting run is then force-cancelled.
  const accepted = recorded({runs: [HRRR], cancel: 409});
  await componentPlan({env: componentEnv, token: 't', fetcher: accepted.fetcher, now: NOW, sleep: accepted.sleep});
  assert.deepEqual(accepted.posts(), [`/actions/runs/${HRRR}/cancel`, `/actions/runs/${HRRR}/force-cancel`]);
});

test('the run and its jobs are re-read just before the cancel; any change aborts it', async () => {
  let checked = false;
  const fixture = recorded({runs: [HRRR], onRequest: (state, method, path) => {
    // The environment read is the last check; the run moves on right after it.
    if (path === '/environments/production') checked = true;
    else if (checked && path === `/actions/runs/${HRRR}`) state.runs[HRRR].updated_at = '2026-10-18T18:04:59Z';
  }});
  const plan = await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.posts(), []);
  assert.match(plan.text, /its run or jobs changed \(or could not be re-read\) between the checks and the cancel, so nothing was cancelled/);
});

test('a job list shorter than its total_count is unknown, so nothing is cancelled', async () => {
  const fixture = recorded({runs: [HRRR], edit: state => { state.totalCount[HRRR] = 150; }});
  const text = (await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep})).text;
  assert.deepEqual(fixture.posts(), []);
  assert.match(text, /because its run or its complete job list could not be read \(Actions API\)/);
});

test('gate lookups share one budget per invocation; a spent budget is unknown and never cancels', async () => {
  assert.equal(GATE_CALL_BUDGET, 60);
  const fixture = recorded({runs: [HRRR]});
  const budget = gateBudget(5);
  const holders = await lockHolders({runId: '1', token: 't', fetcher: fixture.fetcher, now: NOW, only: ['hrrr'], budget});
  assert.deepEqual(holders.map(row => [row.gateUnknown, row.gateLookup, row.stuck]), [[true, 'budget', true]]);
  assert.equal(fixture.requests.filter(row => row.path === '/deployments' || row.path.endsWith('/statuses')).length, 5);
  const result = await reapStuckHolders({holders, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep, budget});
  assert.deepEqual(fixture.posts(), []);
  assert.match(result.lines.join('\n'), /not cancelled automatically because its gate waiting time is unknown \(gate lookup budget exhausted: this plan run's 60 deployment reads were spent\)/);
  assert.match(result.lines.join('\n'), /^- LOOKUP BUDGET EXHAUSTED: run 38263168806 \(catalog-bake\.yml\) was not cancelled: the gate lookup budget of 60 deployment reads for this plan run was spent before its gate time was known\. Nothing was changed; the next plan run checks again\.$/m);
  // Once spent, a later lookup in the same run is also reported as budget, not as not-found.
  const later = await lockHolders({runId: '1', token: 't', fetcher: fixture.fetcher, now: NOW, only: ['hrrr'], budget});
  assert.deepEqual(later.map(row => row.gateLookup), ['budget']);
  // The whole plan stays within the default budget even for the six-day-old holder (12 pages).
  const plan = recorded({runs: [HRRR, OBS]});
  await componentPlan({env: componentEnv, token: 't', fetcher: plan.fetcher, now: NOW, sleep: plan.sleep});
  assert.ok(plan.requests.filter(row => row.path === '/deployments' || row.path.endsWith('/statuses')).length <= GATE_CALL_BUDGET);
});

test('the report-only component summary reads only the newest deployment page', async () => {
  const fixture = recorded({runs: [HRRR]});
  const log = console.log;console.log = () => {};
  let code;
  try { code = await summaryMain(['component'], {GITHUB_RUN_ID: '39152035615', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 't', CATALOG_TARGET: 'production', GITHUB_EVENT_NAME: 'workflow_dispatch'},
    NOW, fixture.fetcher, fixture.sleep); } finally { console.log = log; }
  assert.equal(code, 1, 'still red on the stuck holder (measured from job start)');
  assert.deepEqual(fixture.requests.filter(row => row.path === '/deployments').map(row => row.query.page), ['1']);
  assert.deepEqual(fixture.posts(), []);
});

test('the whole bake\'s maintenance `bake` job waiting with two stuck publishers is judged like them, and the run is cancelled once', async () => {
  // Same moment as the last publisher, then stranded at the gate with it (run 39136712828 shape).
  const fixture = recorded(wholeBake({bakeGate: '2026-10-18T15:08:48Z'}));
  const plan = await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.posts(), [`/actions/runs/${BAKE}/cancel`]);
  assert.match(plan.text, /- CANCELLED run 39136712828 \(bake\.yml\) job "bake": it has been waiting at the production environment gate since 2\.9 h ago \(deployment status `waiting` at 2026-10-18T15:08:48Z\), holding weatherx-data-maintenance;/);
  assert.match(plan.text, /- CANCELLED run 39136712828 \(bake\.yml\) job "publish-hrrr \/ publisher"/);
  assert.match(plan.text, /- CANCELLED run 39136712828 \(bake\.yml\) job "publish-icon \/ publisher"/);
  assert.deepEqual(plan.models, ['hrrr']);
  // The maintenance job is a run member only: it is never listed as a component lock holder.
  assert.equal(holderJobName('bake', 'bake.yml'), null);
});

test('a maintenance `bake` job whose gate wait is under 30 minutes keeps the whole bake, and HRRR stays set aside', async () => {
  const fixture = recorded(wholeBake({bakeGate: '2026-10-18T17:50:00Z'}));
  const plan = await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.posts(), []);
  assert.match(plan.text, /- NOT CANCELLED run 39136712828 \(bake\.yml\) job "publish-hrrr \/ publisher": .*because job "bake" of that run: it has waited at the gate for 15 min, not more than 30\./);
  assert.deepEqual(plan.models, []);
  assert.deepEqual(plan.aside.map(row => row.model), ['hrrr'], 'stand-aside semantics are unchanged');
  // Started steps and a reviewed environment refuse it exactly like a publisher.
  const started = recorded({...wholeBake({bakeGate: '2026-10-18T15:08:48Z'}), edit: state => { wholeBake({bakeGate: '2026-10-18T15:08:48Z'}).edit(state);
    state.jobs[BAKE].find(job => job.name === 'bake').steps = [{name: 'Set up job', status: 'in_progress'}]; }});
  const text = (await componentPlan({env: componentEnv, token: 't', fetcher: started.fetcher, now: NOW, sleep: started.sleep})).text;
  assert.deepEqual(started.posts(), []);
  assert.match(text, /because job "bake" has a started step\./);
});
