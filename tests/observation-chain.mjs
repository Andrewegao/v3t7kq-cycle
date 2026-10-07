import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chainDecision, main, LANE, MIN_GAP_MINUTES} from '../tools/observation-chain.mjs';

const NOW = Date.parse('2026-10-07T05:08:30Z');
const at = minutes => new Date(NOW - minutes * 60000).toISOString();
const lane = (minutes, status = 'completed', id = 1) => ({id, path: '.github/workflows/observation-refresh.yml', status, run_started_at: at(minutes)});
const read = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');

function fixture({lanes = [], recoveries = [], dispatch = 204} = {}) {
  const requests = [];
  const fetcher = async (url, init = {}) => {
    const path = url.replace('https://api.github.com/repos/Andrewegao/v3t7kq-cycle', '');
    requests.push({method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined});
    if (path === '/actions/workflows/observation-refresh.yml/runs?per_page=30') return new Response(JSON.stringify({workflow_runs: lanes}));
    if (path === '/actions/workflows/five-feed-recovery.yml/runs?per_page=30') return new Response(JSON.stringify({workflow_runs: recoveries}));
    if (path === '/actions/workflows/observation-refresh.yml/dispatches') return new Response(null, {status: dispatch});
    return new Response('{}', {status: 404});
  };
  return {requests, fetcher, dispatches: () => requests.filter(r => r.method === 'POST')};
}
const env = (ENABLED = 'true') => ({ENABLED, GH_TOKEN: 'fixture', GITHUB_RUN_ID: '37600000001'});

test('dispatches only when enabled, the lane is idle and its newest run started more than 25 minutes ago', async () => {
  assert.equal(MIN_GAP_MINUTES, 25);assert.equal(LANE, 'observation-refresh.yml');
  // Tonight's shape: newest lane run (a manual dispatch) finished long ago; nothing queued.
  const due = fixture({lanes: [lane(26)], recoveries: [{id: 9, path: '.github/workflows/five-feed-recovery.yml', status: 'completed'}]});
  assert.equal(await main(env(), NOW, due.fetcher), 0);
  assert.deepEqual(due.dispatches(), [{method: 'POST', path: '/actions/workflows/observation-refresh.yml/dispatches',
    body: {ref: 'main', inputs: {caller: 'component-bake-chain', chain_run_id: '37600000001'}}}]);
  // No lane run at all also dispatches.
  assert.equal(chainDecision({enabled: 'true', lane: [], recovery: [], now: NOW}).dispatch, true);
});

test('does not dispatch when the newest lane run is 10 minutes old (or exactly 25)', async () => {
  for (const minutes of [10, 25]) {
    const recent = fixture({lanes: [lane(minutes), lane(40, 'completed', 2)]});
    assert.equal(await main(env(), NOW, recent.fetcher), 0);
    assert.deepEqual(recent.dispatches(), [], `${minutes} min`);
  }
  // A run whose start time is unknown is never treated as old.
  assert.equal(chainDecision({enabled: 'true', lane: [{id: 3, status: 'completed'}], recovery: [], now: NOW}).dispatch, false);
});

test('does not dispatch when the variable is unset or not exactly true, and then reads nothing', async () => {
  for (const value of [undefined, '', 'false', 'TRUE']) {
    const off = fixture({lanes: [lane(60)]});
    assert.equal(await main({...env(), ENABLED: value}, NOW, off.fetcher), 0);
    assert.deepEqual(off.requests, [], String(value));
  }
});

test('does not dispatch while a lane or recovery run is queued, pending, waiting or in progress', async () => {
  for (const status of ['queued', 'pending', 'waiting', 'requested', 'in_progress']) {
    const busyLane = fixture({lanes: [lane(30, 'completed', 2), lane(70, status, 1)]});
    assert.equal(await main(env(), NOW, busyLane.fetcher), 0);assert.deepEqual(busyLane.dispatches(), [], `lane ${status}`);
    const busyRecovery = fixture({lanes: [lane(60)], recoveries: [{id: 7, path: '.github/workflows/five-feed-recovery.yml', status}]});
    assert.equal(await main(env(), NOW, busyRecovery.fetcher), 0);assert.deepEqual(busyRecovery.dispatches(), [], `recovery ${status}`);
  }
});

test('an unavailable Actions API or a refused dispatch turns the chain run red and never retries', async () => {
  const down = {fetcher: async () => new Response('', {status: 503})};
  await assert.rejects(main(env(), NOW, down.fetcher), /github-api-503/);
  const refused = fixture({lanes: [lane(60)], dispatch: 422});
  await assert.rejects(main(env(), NOW, refused.fetcher), /github-api-422 POST/);
  assert.equal(refused.dispatches().length, 1);
  await assert.rejects(main({...env(), GITHUB_RUN_ID: ''}, NOW, fixture().fetcher), /run id and token required/);
});

test('the chain link is a secret-free workflow that can only dispatch the lane; the component bake stays data-only', () => {
  const chain = read('observation-chain.yml'), catalog = read('catalog-bake.yml'), lane = read('observation-refresh.yml');
  const tool = readFileSync(new URL('../tools/observation-chain.mjs', import.meta.url), 'utf8');
  assert.match(catalog, /^name: WeatherX component bake$/m);
  assert.match(chain, /on:\n  workflow_run:\n    workflows: \[WeatherX component bake\]\n    types: \[requested\]\njobs:/);
  assert.match(chain, /if: \$\{\{ vars\.OBSERVATION_REFRESH_ENABLED == 'true' \}\}/);
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
  // The lane accepts the chain caller and keeps its native cron as the fallback.
  assert.match(lane, /- cron: '14,44 \* \* \* \*'/);
  assert.match(lane, /caller:\n\s+description: Leave empty[^\n]*\n\s+type: string\n\s+required: false\n\s+chain_run_id:/);
  assert.doesNotMatch(read('five-feed-recovery.yml'), /^      caller:/m, 'recovery declares no caller input, so the chain cannot reach it');
});
