import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {brotliCompressSync, deflateSync, gzipSync} from 'node:zlib';
import {ACTIVE, API, CHAIN, LANE, NO_POST_STEP, POINTER, REPOSITORY, STEP, dueSlot, main, validatePointer} from '../tools/cams-chain.mjs';

const NOW = Date.parse('2026-11-07T13:00:00Z'), HEAD = 'a'.repeat(40), REPO_ID = 7;
const slot = dueSlot(NOW);
const row = (id, workflow = CHAIN, extra = {}) => ({id, path: `.github/workflows/${workflow}`,
  workflow_id: workflow === CHAIN ? 20 : workflow === LANE ? 30 : 10,
  head_branch: 'main', head_sha: HEAD, event: workflow === CHAIN ? 'workflow_run' : 'workflow_dispatch',
  repository: {id: REPO_ID}, head_repository: {id: REPO_ID}, run_attempt: 1,
  created_at: '2026-11-07T12:49:00Z', ...extra});
const pointer = {schema: 'weatherx.energy.pointer/1', family: 'cams', newest_init: '2026-11-06T12:00:00Z',
  run: '2026110612', baked_at: '2026-11-07T01:00:00Z', path: '2026110612/clusters.json',
  map: '2026110612/dust-map.json', sha256: 'b'.repeat(64), bytes: 100};
const env = (phase = 'plan') => ({CAMS_CHAIN_PHASE: phase, GH_TOKEN: 'fixture', GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_WORKFLOW_REF:
    `${REPOSITORY}/.github/workflows/${CHAIN}@refs/heads/main`, GITHUB_SHA: HEAD,
  GITHUB_RUN_ID: '200', TRIGGER_RUN_ID: '100', GITHUB_REPOSITORY_ID: String(REPO_ID), GITHUB_RUN_ATTEMPT: '1',
  CAMS_EXPECTED_SLOT: slot.startISO, CAMS_EXPECTED_RUN: slot.run});

function fixture({served = pointer, trigger = row(100, 'catalog-bake.yml'), self = row(200), active = {},
  attempts = [], prior = [], jobs = [], post = 204, override = () => undefined} = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url); calls.push({url, method: init.method ?? 'GET', headers: init.headers,
      ...(init.body ? {body: JSON.parse(init.body)} : {})});
    const changed = override(u, init, calls); if (changed !== undefined) return changed;
    const json = value => Response.json(value);
    if (url === POINTER) { assert.equal(new Headers(init.headers).has('authorization'), false); return json(served); }
    assert.ok(url.startsWith(`${API}/`), 'fixed API destination');
    const p = u.pathname.replace(`/repos/${REPOSITORY}`, '');
    if (p === '/git/ref/heads/main') return json({object: {sha: HEAD}});
    if (p === '/actions/workflows/catalog-bake.yml') return json({id: 10, state: 'active', path: '.github/workflows/catalog-bake.yml'});
    if (p === `/actions/workflows/${CHAIN}`) return json({id: 20, state: 'active', path: `.github/workflows/${CHAIN}`});
    if (p === '/actions/runs/100') return json(trigger);
    if (p === '/actions/runs/200') return json(self);
    if (p === `/actions/workflows/${LANE}/runs`) {
      const values = u.searchParams.has('status') ? active[u.searchParams.get('status')] ?? [] : attempts;
      return json({total_count: values.length, workflow_runs: values});
    }
    if (p === `/actions/workflows/${CHAIN}/runs`) return json({total_count: prior.length, workflow_runs: prior});
    if (/^\/actions\/runs\/\d+\/jobs$/.test(p)) return json({total_count: jobs.length, jobs});
    if (p === `/actions/workflows/${LANE}/dispatches`) {
      if (post === 'lost') throw new Error('private response must not escape');
      return new Response(null, {status: post});
    }
    throw new Error(`unexpected fixture destination ${p}`);
  };
  return {fetcher, calls, posts: () => calls.filter(c => c.method === 'POST')};
}

test('the four existing UTC slots retain the ten-hour eligible run rule, including midnight', () => {
  const cases = [
    ['2026-11-07T00:39:59Z', '2026-11-06T22:40:00Z', '2026110612'],
    ['2026-11-07T00:40:00Z', '2026-11-07T00:40:00Z', '2026110612'],
    ['2026-11-07T10:40:00Z', '2026-11-07T10:40:00Z', '2026110700'],
    ['2026-11-07T12:40:00Z', '2026-11-07T12:40:00Z', '2026110700'],
    ['2026-11-07T22:39:59Z', '2026-11-07T12:40:00Z', '2026110700'],
    ['2026-11-07T22:40:00Z', '2026-11-07T22:40:00Z', '2026110712'],
  ];
  for (const [at, start, run] of cases) assert.deepEqual([dueSlot(Date.parse(at)).startISO, dueSlot(Date.parse(at)).run], [start, run]);
});

test('plan is read-only and actual dispatch repeats admission then sends one exact slot run', async () => {
  const plan = fixture(); assert.equal((await main(env(), NOW, plan.fetcher)).eligible, true); assert.equal(plan.posts().length, 0);
  const actual = fixture(); assert.equal((await main(env('dispatch'), NOW, actual.fetcher)).dispatch, true);
  assert.deepEqual(actual.posts().map(c => c.body), [{ref: 'main', inputs: {caller: 'component-bake-chain', run: '2026110700'}}]);
  for (const status of ACTIVE) assert.equal(actual.calls.filter(c => c.url.includes(`status=${status}&`)).length, 2);
  assert.equal(actual.calls.filter(c => c.url.endsWith('/git/ref/heads/main')).length, 2);
  assert.equal(actual.calls.filter(c => c.url === POINTER).length, 2);
});

test('a current or newer valid pointer does not dispatch; malformed, missing, future and unauthorized pointers refuse', async () => {
  const fresh = {...pointer, run: slot.run, newest_init: slot.expectedInit, path: `${slot.run}/clusters.json`, map: `${slot.run}/dust-map.json`};
  assert.equal((await main(env(), NOW, fixture({served: fresh}).fetcher)).reason, 'expected-init-already-served');
  for (const change of [{fixture: true}, {schema: 'wrong'}, {family: 'glofas'}, {sha256: 'bad'}, {bytes: 0},
    {run: '2026130700'}, {map: 'elsewhere.json'}, {baked_at: '2099-01-01T00:00:00Z'}])
    assert.throws(() => validatePointer({...pointer, ...change}, NOW));
  for (const status of [401, 403, 404, 503]) {
    const f = fixture({override: u => u.href === POINTER ? new Response(null, {status}) : undefined});
    await assert.rejects(main(env(), NOW, f.fetcher)); assert.equal(f.posts().length, 0);
  }
});

test('all five active statuses suppress a plan, including an old-init or dry-run job', async () => {
  for (const status of ACTIVE) {
    const f = fixture({active: {[status]: [row(90, LANE, {status, display_title: 'energy cams: dry run on the synthetic fixture'})]}});
    assert.equal((await main(env(), NOW, f.fetcher)).reason, 'cams-active'); assert.equal(f.posts().length, 0);
  }
});

test('eligible attempts consume only their own nominal window, not dry-run or older explicit runs', async () => {
  for (const extra of [{event: 'schedule'}, {display_title: 'energy cams: dispatched (newest published run)'},
    {display_title: 'energy cams: dispatched (2026110700)'}]) {
    const f = fixture({attempts: [row(90, LANE, {status: 'completed', conclusion: 'failure', ...extra})]});
    assert.equal((await main(env(), NOW, f.fetcher)).reason, 'nominal-slot-already-attempted');
  }
  for (const extra of [{display_title: 'energy cams: dry run on the synthetic fixture'},
    {display_title: 'energy cams: dispatched (2026110612)'}, {event: 'schedule', created_at: '2026-11-07T10:40:00Z'}]) {
    assert.equal((await main(env(), NOW, fixture({attempts: [row(90, LANE, extra)]}).fetcher)).eligible, true);
  }
});

test('a prior no-op planning step does not consume a slot; a started POST step does, including uncertain outcomes', async () => {
  const prior = [row(150)], job = steps => [{id: 99, name: 'dispatch', steps}];
  const planned = fixture({prior, jobs: job([{name: 'Plan the due CAMS slot', started_at: '2026-11-07T12:50:00Z', conclusion: 'success'}])});
  assert.equal((await main(env(), NOW, planned.fetcher)).eligible, true);
  const started = {name: STEP, started_at: '2026-11-07T12:50:00Z', conclusion: 'failure'};
  const uncertain = fixture({prior, jobs: job([started])});
  assert.equal((await main(env(), NOW, uncertain.fetcher)).reason, 'chain-slot-decision-already-started');
  assert.equal(uncertain.posts().length, 0);
  // Positive completed marker is emitted only after successful admission returned without a POST.
  const confirmedNoPost = fixture({prior, jobs: job([{...started, conclusion: 'success'}, {name: NO_POST_STEP, conclusion: 'success'}])});
  assert.equal((await main(env(), NOW, confirmedNoPost.fetcher)).eligible, true);
  const skippedMarker = fixture({prior, jobs: job([started, {name: NO_POST_STEP, conclusion: 'skipped'}])});
  assert.equal((await main(env(), NOW, skippedMarker.fetcher)).eligible, undefined);
});

test('forks, non-main or stale identities, reruns and previous-window events cannot authorize dispatch', async () => {
  for (const change of [{head_repository: {id: 999}}, {repository: {id: 999}}, {workflow_id: 99},
    {path: '.github/workflows/evil.yml'}, {head_sha: 'd'.repeat(40)}, {head_branch: 'feature'}, {event: 'pull_request'}, {run_attempt: 2}]) {
    const f = fixture({trigger: row(100, 'catalog-bake.yml', change)});
    await assert.rejects(main(env(), NOW, f.fetcher)); assert.equal(f.posts().length, 0);
  }
  for (const change of [{GITHUB_RUN_ATTEMPT: '2'}, {GITHUB_EVENT_NAME: 'workflow_dispatch'}, {GITHUB_REPOSITORY_ID: ''},
    {GITHUB_SHA: 'd'.repeat(40)}, {GITHUB_WORKFLOW_REF: 'wrong'}])
    await assert.rejects(main({...env(), ...change}, NOW, fixture().fetcher));
  const late = fixture({trigger: row(100, 'catalog-bake.yml', {created_at: '2026-11-07T12:39:59Z'})});
  assert.equal((await main(env(), NOW, late.fetcher)).reason, 'previous-nominal-window');
  const crossed = fixture(); assert.equal((await main({...env('dispatch'), CAMS_EXPECTED_SLOT: '2026-11-07T10:40:00Z'}, NOW, crossed.fetcher)).reason, 'nominal-window-changed');
  assert.equal(crossed.calls.length, 0);
});

test('out-of-order higher-ID chain execution cannot bypass a started POST, while an unstarted job does not consume', async () => {
  const prior = [row(250, CHAIN, {created_at: '2026-11-07T12:50:00Z'})];
  const started = fixture({prior, jobs: [{id: 99, name: 'dispatch', steps: [
    {name: STEP, started_at: '2026-11-07T12:55:00Z', conclusion: 'failure'},
  ]}]});
  assert.equal((await main(env('dispatch'), NOW, started.fetcher)).reason, 'chain-slot-decision-already-started');
  assert.equal(started.posts().length, 0);
  const unstarted = fixture({prior, jobs: [{id: 99, name: 'dispatch', steps: [
    {name: STEP, started_at: null, status: 'queued'},
  ]}]});
  assert.equal((await main(env(), NOW, unstarted.fetcher)).eligible, true);
  assert.equal(unstarted.posts().length, 0);
});

test('GitHub skipped POST steps with real timestamps do not consume a nominal slot', async () => {
  const skipped = fixture({prior: [row(150)], jobs: [{id: 99, name: 'dispatch', steps: [
    {name: 'Plan the due CAMS slot', started_at: '2026-11-07T12:50:00Z', conclusion: 'success'},
    {name: STEP, started_at: '2026-11-07T12:50:01Z', completed_at: '2026-11-07T12:50:01Z',
      status: 'completed', conclusion: 'skipped'},
  ]}]});
  assert.equal((await main(env(), NOW, skipped.fetcher)).eligible, true);
  assert.equal(skipped.posts().length, 0);
});

test('incomplete or changed API lists and duplicate IDs refuse instead of implying an idle slot', async () => {
  for (const body of [{total_count: 1, workflow_runs: []}, {total_count: 2, workflow_runs: [row(90, LANE), row(90, LANE)]},
    {total_count: null, workflow_runs: []}]) {
    const f = fixture({override: u => u.pathname.endsWith(`/${LANE}/runs`) ? Response.json(body) : undefined});
    await assert.rejects(main(env(), NOW, f.fetcher)); assert.equal(f.posts().length, 0);
  }
  const f = fixture({override: u => u.pathname.endsWith(`/${LANE}/runs`) ? new Response(null, {status: 403}) : undefined});
  await assert.rejects(main(env(), NOW, f.fetcher)); assert.equal(f.posts().length, 0);
});

test('refused or lost POST is attempted once, without retry; late active admission returns without POST', async () => {
  for (const post of [403, 422, 503, 'lost']) {
    const f = fixture({post}); await assert.rejects(main(env('dispatch'), NOW, f.fetcher)); assert.equal(f.posts().length, 1);
  }
  let queued = 0;
  const late = fixture({override: u => u.searchParams.get('status') === 'queued' && ++queued === 2
    ? Response.json({total_count: 1, workflow_runs: [row(90, LANE)]}) : undefined});
  assert.equal((await main(env('dispatch'), NOW, late.fetcher)).reason, 'cams-active'); assert.equal(late.posts().length, 0);
  const crossed = fixture();
  assert.equal((await main(env('dispatch'), NOW, crossed.fetcher, () => Date.parse('2026-11-07T22:40:00Z'))).reason, 'nominal-window-changed');
  assert.equal(crossed.posts().length, 0);
});

test('workflow and run endpoint identity fields are mandatory, and complete multiple pages are read', async () => {
  for (const [path, body] of [['/actions/workflows/catalog-bake.yml', {state: 'active', path: '.github/workflows/catalog-bake.yml'}],
    ['/actions/runs/100', row(101, 'catalog-bake.yml')], ['/actions/runs/200', row(201)]]) {
    const f = fixture({override: u => u.pathname.endsWith(path) ? Response.json(body) : undefined});
    await assert.rejects(main(env(), NOW, f.fetcher)); assert.equal(f.posts().length, 0);
  }
  const pages = [];
  const f = fixture({override: u => {
    if (!u.pathname.endsWith(`/${LANE}/runs`) || u.searchParams.get('status') !== 'queued') return;
    const page = Number(u.searchParams.get('page')); pages.push(page);
    return Response.json({total_count: 2, workflow_runs: [row(80 + page, LANE)]});
  }});
  assert.equal((await main(env(), NOW, f.fetcher)).reason, 'cams-active'); assert.deepEqual(pages, [1, 2]);
});

test('workflow has distinct plan/POST/no-POST proof steps, least token scope and unchanged publisher/cron boundaries', () => {
  const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  const workflow = read('.github/workflows/cams-chain.yml'), lane = read('.github/workflows/cams-ingest.yml');
  assert.match(workflow, /workflow_run:\n    workflows: \[WeatherX component bake\]\n    types: \[requested\]\n    branches: \[main\]/);
  assert.match(workflow, /group: weatherx-cams-chain\n      cancel-in-progress: false/);
  assert.match(workflow, /permissions:\n      contents: read\n      actions: write/);
  assert.doesNotMatch(workflow, /secrets\.|environment:|contents: write|ssh-key|schedule:|workflow_dispatch:/);
  assert.ok(workflow.includes(`- name: ${STEP}`)); assert.ok(workflow.includes(`- name: ${NO_POST_STEP}`));
  assert.match(workflow, /if: steps.plan.outputs.eligible == 'true'/);
  assert.match(workflow, /steps.post.outcome == 'success' && steps.post.outputs.post_attempted == 'false'/);
  assert.ok(lane.includes("- cron: '40 0,10,12,22 * * *'"));
  assert.match(lane, /served=true/); assert.match(lane, /test "\$APPROVED_SHA" = "\$ATMOS_SHA"/);
  const schedules = read('scheduler/src/schedules.ts'); assert.match(schedules, /ARCHIVE_CRON, STAGING_SEARCH_CRON, PLACE_SURF_CRON, PLACE_DIRECTORY_CRON, GLOFAS_CRON, CAMS_CRON/);
});

test('actual compressed HTTP responses pass decoded-byte admission; decoded overflow and truncated transport refuse', async () => {
  async function serve(mode, body, encoding = 'gzip', phase = 'plan') {
    const backing = fixture();
    const server = createServer(async (request, response) => {
      try {
        const original = request.url.startsWith('/repos/') ? `https://api.github.com${request.url}` : `https://weatherx.org${request.url}`;
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const requestBody = Buffer.concat(chunks).toString();
        const synthetic = await backing.fetcher(original, {method: request.method, headers: request.headers,
          ...(requestBody ? {body: requestBody} : {})});
        if (synthetic.status === 204) { response.writeHead(204); response.end(); return; }
        let bytes = Buffer.from(await synthetic.arrayBuffer());
        if (original === POINTER && body) bytes = Buffer.from(body);
        const compressed = {gzip: gzipSync, br: brotliCompressSync, deflate: deflateSync}[encoding](bytes);
        response.writeHead(200, {'content-encoding': encoding, 'content-type': 'application/json',
          'content-length': String(compressed.length)});
        if (mode === 'truncated' && original === POINTER) {
          response.write(compressed.subarray(0, Math.floor(compressed.length / 2)));
          setImmediate(() => response.destroy());
        } else response.end(compressed);
      } catch { response.destroy(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const fetcher = (url, init) => { const u = new URL(url); return fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, init); };
    try { return await main(env(phase), NOW, fetcher); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
  for (const encoding of ['gzip', 'br', 'deflate']) assert.equal((await serve('compressed', undefined, encoding)).eligible, true);
  assert.equal((await serve('compressed', undefined, 'gzip', 'dispatch')).dispatch, true);
  await assert.rejects(serve('gzip', JSON.stringify({...pointer, padding: 'x'.repeat(8192)})), /response-too-large/);
  await assert.rejects(serve('truncated'));
});
