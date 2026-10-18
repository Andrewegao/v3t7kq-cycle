// Stuck writer-lock reaper and paginated gate lookup, on API responses recorded on 2026-10-18 for the
// two runs left waiting at the production gate by the 2026-10-12 Actions incident:
// catalog-bake run 38263168806 `model (hrrr)` and observation-refresh run 38283354381 `refresh`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {CANCEL_CHECKS, CANCEL_CHECK_MS, GATE_PAGES, STUCK_WAITING_MINUTES, componentPlan, gateRefusal, gateWaitingSince, lockHolders,
  observationPlan, reapRefusal, reapStuckHolders} from '../tools/workflow-run-summary.mjs';
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
  edit = () => {}, pages = RECORDED.deploymentPages} = {}) {
  const state = {runs: {}, jobs: {}, environment: clone(environment), pages};
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
    let match;
    if (method === 'GET' && path === '/actions/runs') {
      const status = parsed.searchParams.get('status');
      return json({workflow_runs: Object.values(state.runs).filter(run => run.status === status)});
    }
    if ((match = /^\/actions\/runs\/(\d+)\/jobs$/.exec(path))) return json({total_count: state.jobs[match[1]]?.length ?? 0, jobs: state.jobs[match[1]] ?? []});
    if ((match = /^\/actions\/runs\/(\d+)$/.exec(path)) && method === 'GET') return state.runs[match[1]] ? json(state.runs[match[1]]) : json({message: 'Not Found'}, 404);
    if ((match = /^\/actions\/runs\/(\d+)\/(cancel|force-cancel)$/.exec(path)) && method === 'POST') {
      const behaviour = match[2] === 'cancel' ? cancel : force;
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
    if ((match = /^\/deployments\/(\d+)\/statuses$/.exec(path))) return json(before(clone(RECORDED.statuses[match[1]] ?? [])));
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
  assert.match(plan.text, /- CANCELLED run 38263168806 \(catalog-bake\.yml\) job "model \(hrrr\)": it has been waiting at the production environment gate since 147\.6 h ago \(deployment status `waiting` at 2026-10-12T14:28:46Z\), holding weatherx-component-production-hrrr; no required reviewers, no started step, nothing in its run in_progress\. A normal cancel completed; the lock is free\./);
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
  assert.match(plan.text, /- FORCE-CANCELLED run 38263168806 \(catalog-bake\.yml\) job "model \(hrrr\)": .* A normal cancel did not complete within 20 s, so the run was force-cancelled and completed; the lock is free\./);
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
    ['the job has a started step', state => { state.jobs[HRRR].find(job => job.id === HRRR_JOB).steps = [{name: 'Set up job', status: 'in_progress'}]; }],
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
    [{name: 'production', protection_rules: [{type: 'wait_timer', wait_timer: 60}]}, 'environment production has a wait timer'],
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
  assert.deepEqual(result.results.map(row => [String(row.runId), row.outcome, row.holders.length]), [[HRRR, 'cancelled', 2]]);
  const broken = await reapStuckHolders({holders, token: 't', fetcher: async () => { throw new Error('network'); }, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(broken.results, []);assert.match(broken.lines.join('\n'), /could not be read \(Actions API\)/);
});

test('a run is not cancelled while another lock holder in it has just reached its gate (not cleared)', async () => {
  const fixture = recorded({runs: [HRRR]});
  const [hrrr] = await lockHolders({runId: '1', token: 't', fetcher: fixture.fetcher, now: NOW, only: ['hrrr']});
  // Same run, another model's job waiting at the gate for one minute: not stuck, so not cleared.
  const fresh = {...hrrr, model: 'ecmwf', lock: 'weatherx-component-production-ecmwf', job: 'model (ecmwf)', jobId: 1, minutes: 1,
    gateSince: new Date(NOW - 60000).toISOString(), stuck: false};
  const result = await reapStuckHolders({holders: [hrrr, fresh], token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep});
  assert.deepEqual(fixture.posts(), []);
  assert.deepEqual(result.results, []);
  assert.match(result.lines.join('\n'), /NOT CANCELLED run 38263168806 \(catalog-bake\.yml\) job "model \(hrrr\)": .*because job "model \(ecmwf\)" of the same run also holds a lock and is not cleared for cancel/);
});

test('a run is not cancelled while any other job in it is unfinished', async () => {
  const fixture = recorded({runs: [HRRR], edit: state => {
    state.jobs[HRRR].push({id: 2, name: 'summary', status: 'queued', conclusion: null, created_at: '2026-10-12T14:28:46Z', steps: []});
  }});
  const text = (await componentPlan({env: componentEnv, token: 't', fetcher: fixture.fetcher, now: NOW, sleep: fixture.sleep})).text;
  assert.deepEqual(fixture.posts(), []);
  assert.match(text, /because job "summary" of the same run is queued, so the run is not only an orphaned gate wait\./);
});
