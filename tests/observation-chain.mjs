import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chainDecision, main, triggerAdmitted, LANE, MIN_GAP_MINUTES, STUCK_MINUTES} from '../tools/observation-chain.mjs';

const NOW = Date.parse('2026-10-07T05:08:30Z');
const REPO_ID = 1061234567;
const at = minutes => new Date(NOW - minutes * 60000).toISOString();
const lane = (minutes, status = 'completed', id = 1, event = 'workflow_dispatch') =>
  ({id, path: '.github/workflows/observation-refresh.yml', status, event, run_started_at: at(minutes)});
const read = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const bake = {id: 37590000000, path: '.github/workflows/catalog-bake.yml', event: 'workflow_dispatch', head_branch: 'main',
  repository: {id: REPO_ID}, head_repository: {id: REPO_ID}};

// active: {status: [runs]} per workflow; created: the lane runs listed by the n-th poll after the dispatch.
function fixture({lanes = [], active = {}, recovery = {}, trigger = bake, dispatch = 204, created = () => []} = {}) {
  const requests = [];let polls = 0;
  const fetcher = async (url, init = {}) => {
    const path = url.replace('https://api.github.com/repos/Andrewegao/v3t7kq-cycle', '');
    requests.push({method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined});
    const json = value => new Response(JSON.stringify(value));
    if (path === `/actions/runs/${bake.id}`) return json(trigger);
    const status = /\/workflows\/([a-z-]+\.yml)\/runs\?status=([a-z_]+)&per_page=10$/.exec(path);
    if (status) return json({workflow_runs: (status[1] === LANE ? active : recovery)[status[2]] ?? []});
    if (path === '/actions/workflows/observation-refresh.yml/runs?per_page=30') return json({workflow_runs: lanes});
    if (path === '/actions/workflows/observation-refresh.yml/runs?event=workflow_dispatch&per_page=5') return json({workflow_runs: [...created(++polls), ...lanes]});
    if (path === '/actions/workflows/observation-refresh.yml/dispatches') return new Response(null, {status: dispatch});
    return new Response('{}', {status: 404});
  };
  return {requests, fetcher, polls: () => polls, dispatches: () => requests.filter(r => r.method === 'POST')};
}
const env = (ENABLED = 'true') => ({ENABLED, GH_TOKEN: 'fixture', GITHUB_RUN_ID: '37600000001', TRIGGER_RUN_ID: String(bake.id), GITHUB_REPOSITORY_ID: String(REPO_ID)});
const sleeps = [];const sleep = async ms => { sleeps.push(ms); };

test('dispatches only when enabled, idle and the newest non-schedule run is older than 25 minutes, then waits for the new run', async () => {
  assert.equal(MIN_GAP_MINUTES, 25);assert.equal(LANE, 'observation-refresh.yml');
  const due = fixture({lanes: [lane(26)], created: poll => poll >= 2 ? [lane(0, 'queued', 99)] : []});
  sleeps.length = 0;
  assert.equal(await main(env(), NOW, due.fetcher, sleep), 0);
  assert.deepEqual(due.dispatches(), [{method: 'POST', path: '/actions/workflows/observation-refresh.yml/dispatches',
    body: {ref: 'main', inputs: {caller: 'component-bake-chain', chain_run_id: '37600000001'}}}]);
  assert.equal(due.polls(), 2, 'polls until the new run appears (second poll), then stops');
  assert.deepEqual(sleeps, [3000, 3000]);
  // Active status queries use ?status= filters for both workflows.
  for (const workflow of ['observation-refresh.yml', 'five-feed-recovery.yml']) for (const status of ['queued', 'pending', 'waiting', 'requested', 'in_progress'])
    assert.ok(due.requests.some(r => r.path === `/actions/workflows/${workflow}/runs?status=${status}&per_page=10`), `${workflow} ${status}`);
  assert.equal(chainDecision({enabled: 'true', lane: [], active: [], now: NOW}).dispatch, true);
});

test('a dispatch whose run never appears within 30 s is red, so the next chain run cannot silently double it', async () => {
  const lost = fixture({lanes: [lane(40)]});
  assert.equal(await main(env(), NOW, lost.fetcher, async () => {}), 1);
  assert.equal(lost.dispatches().length, 1);assert.equal(lost.polls(), 10);
});

test('does not dispatch when the newest non-schedule lane run is 10 minutes old (or exactly 25); a cron run does not reset the gap', async () => {
  for (const minutes of [10, 25]) {
    const recent = fixture({lanes: [lane(minutes), lane(40, 'completed', 2)]});
    assert.equal(await main(env(), NOW, recent.fetcher, sleep), 0);
    assert.deepEqual(recent.dispatches(), [], `${minutes} min`);
  }
  // A schedule run 5 minutes ago (often one the plan skipped) does not hold the chain back.
  assert.equal(chainDecision({enabled: 'true', lane: [lane(5, 'completed', 3, 'schedule'), lane(31)], active: [], now: NOW}).dispatch, true);
  assert.equal(chainDecision({enabled: 'true', lane: [{id: 3, event: 'workflow_dispatch', status: 'completed'}], active: [], now: NOW}).dispatch, false);
});

test('does not dispatch when the variable is unset or not exactly true, and then reads nothing', async () => {
  for (const value of [undefined, '', 'false', 'TRUE']) {
    const off = fixture({lanes: [lane(60)]});
    assert.equal(await main({...env(), ENABLED: value}, NOW, off.fetcher, sleep), 0);
    assert.deepEqual(off.requests, [], String(value));
  }
});

test('stays green while a lane or recovery run is active, and turns red naming a run active for more than 60 minutes', async () => {
  assert.equal(STUCK_MINUTES, 60);
  for (const status of ['queued', 'pending', 'waiting', 'requested', 'in_progress']) {
    const busyLane = fixture({lanes: [lane(30)], active: {[status]: [lane(20, status, 5)]}});
    assert.equal(await main(env(), NOW, busyLane.fetcher, sleep), 0);assert.deepEqual(busyLane.dispatches(), [], `lane ${status}`);
    const busyRecovery = fixture({lanes: [lane(60)], recovery: {[status]: [{id: 7, path: '.github/workflows/five-feed-recovery.yml', status, created_at: at(30)}]}});
    assert.equal(await main(env(), NOW, busyRecovery.fetcher, sleep), 0);assert.deepEqual(busyRecovery.dispatches(), [], `recovery ${status}`);
    const stuck = fixture({lanes: [lane(90)], active: {[status]: [lane(61, status, 37561379838)]}});
    const logged = [];const log = console.log;console.log = text => logged.push(text);
    try { assert.equal(await main(env(), NOW, stuck.fetcher, sleep), 1); } finally { console.log = log; }
    assert.deepEqual(stuck.dispatches(), []);
    assert.match(logged.join('\n'), new RegExp(`BLOCKED[\\s\\S]*run 37561379838 \\(observation-refresh\\.yml\\) is ${status} since 61 min ago`));
  }
});

test('refuses a trigger that is not this repository\'s catalog-bake.yml on main (fork or renamed workflow)', async () => {
  assert.equal(triggerAdmitted(bake, String(REPO_ID)), true);
  assert.equal(triggerAdmitted({...bake, event: 'schedule'}, REPO_ID), true);
  for (const trigger of [{...bake, head_repository: {id: 999}}, {...bake, repository: {id: 999}, head_repository: {id: 999}},
    {...bake, event: 'pull_request'}, {...bake, event: 'pull_request_target'}, {...bake, path: '.github/workflows/evil.yml'},
    {...bake, head_branch: 'feature'}, {...bake, head_repository: null}]) {
    const forged = fixture({lanes: [lane(60)], trigger});
    await assert.rejects(main(env(), NOW, forged.fetcher, sleep), /refusing trigger run 37590000000/, JSON.stringify(trigger));
    assert.deepEqual(forged.dispatches(), []);
  }
  await assert.rejects(main({...env(), GITHUB_REPOSITORY_ID: ''}, NOW, fixture().fetcher, sleep), /refusing trigger run/);
  await assert.rejects(main({...env(), TRIGGER_RUN_ID: ''}, NOW, fixture().fetcher, sleep), /refusing trigger run/);
});

test('an unavailable Actions API or a refused dispatch turns the chain run red and never retries', async () => {
  await assert.rejects(main(env(), NOW, async () => new Response('', {status: 503}), sleep), /github-api-503/);
  const refused = fixture({lanes: [lane(60)], dispatch: 422});
  await assert.rejects(main(env(), NOW, refused.fetcher, sleep), /github-api-422 POST/);
  assert.equal(refused.dispatches().length, 1);
  await assert.rejects(main({...env(), GITHUB_RUN_ID: ''}, NOW, fixture().fetcher, sleep), /run id and token required/);
});

test('the chain link is a secret-free workflow that can only dispatch the lane; the component bake stays data-only', () => {
  const chain = read('observation-chain.yml'), catalog = read('catalog-bake.yml'), lane = read('observation-refresh.yml');
  const tool = readFileSync(new URL('../tools/observation-chain.mjs', import.meta.url), 'utf8');
  assert.match(catalog, /^name: WeatherX component bake$/m);
  assert.match(chain, /on:\n  workflow_run:\n    workflows: \[WeatherX component bake\]\n    types: \[requested\]\n    branches: \[main\]\njobs:/);
  const condition = chain.split('    if: >-\n')[1].split('\n    concurrency:')[0];
  for (const part of ["vars.OBSERVATION_REFRESH_ENABLED == 'true'",
    "(github.event.workflow_run.event == 'workflow_dispatch' || github.event.workflow_run.event == 'schedule')",
    'github.event.workflow_run.head_repository.full_name == github.repository', "github.event.workflow_run.head_branch == 'main'"])
    assert.ok(condition.includes(`${part}`), part);
  assert.match(chain, /TRIGGER_RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(chain, /group: weatherx-observation-chain\n\s+cancel-in-progress: false/);
  assert.match(chain, /permissions:\n      contents: read\n      actions: write\n/);
  assert.doesNotMatch(chain, /secrets\.|environment:|contents: write|write-all|ssh-key/);
  assert.match(chain, /run: node tools\/observation-chain\.mjs$/m);
  // The tool can dispatch only the lane, never the all-five recovery.
  assert.equal((tool.match(/\/dispatches/g) || []).length, 1);
  assert.match(tool, /`\/actions\/workflows\/\$\{LANE\}\/dispatches`/);
  assert.doesNotMatch(tool, /RECOVER FIVE OBSERVATION FEEDS|confirmation/);
  // The component bake itself gains no dispatch capability.
  assert.doesNotMatch(catalog, /actions: write|\/dispatches|observation/);
  // The lane accepts the chain caller, names it as a claim in its run name, and keeps its cron as the fallback.
  assert.match(lane, /- cron: '14,44 \* \* \* \*'/);
  assert.match(lane, /caller:\n\s+description: Leave empty[^\n]*\n\s+type: string\n\s+required: false\n\s+chain_run_id:/);
  assert.match(lane, /component-bake chain run \{0\} \(caller checked by plan\)/);assert.doesNotMatch(lane, /chained refresh/);
  assert.doesNotMatch(read('five-feed-recovery.yml'), /^      caller:/m, 'recovery declares no caller input, so the chain cannot reach it');
});
