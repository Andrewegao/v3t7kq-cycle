import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bakeMarkdown, bakeRows, bakeMode, componentMarkdown, lockHolders, holderJobName, main, MODELS, observationPlan, OBSERVATION_LOCK, CHAIN_CALLER} from '../tools/workflow-run-summary.mjs';

const NOW = Date.parse('2026-10-06T18:00:00Z');
const at = minutes => new Date(NOW - minutes * 60000).toISOString();
const skipped = {result: 'skipped', outputs: {}};
function needs(overrides = {}) {
  const value = {bake: skipped, 'staging-wind100': skipped, 'production-wind100': skipped};
  for (const model of MODELS) {
    value[`${MODELS.indexOf(model) < 4 ? 'core' : 'regional'}-${model}`] = skipped;
    value[`publish-${model}`] = skipped;
  }
  return {...value, ...overrides};
}

test('a staging-Wind100-only run says whole-data maintenance was SKIPPED, not refreshed', () => {
  // Shape of run 37480178802: only core ECMWF and staging Wind100 executed, everything else skipped.
  const jobs = [{name: 'core (ecmwf) / collector', completed_at: at(30)}, {name: 'staging native 100m wind / wind100', completed_at: at(5)}];
  const text = bakeMarkdown({needs: needs({'core-ecmwf': {result: 'success'}, 'staging-wind100': {result: 'success'}}),
    jobs, inputs: {model: 'ecmwf', recoveryRunId: '', wind100Only: 'true'}, event: 'workflow_dispatch', now: NOW});
  assert.match(text, /^## bake run summary: whole-data maintenance SKIPPED/);
  assert.match(text, /mode: staging Wind100 only — whole-data maintenance and model publication are NOT part of this run/);
  assert.match(text, /\*\*Refreshed:\*\* Staging native 100 m wind/);
  assert.match(text, /\*\*Skipped:\*\* Whole-data maintenance/);
  assert.match(text, /\| ecmwf \(core\) \| collected, publication skipped \|/);
  assert.match(text, /\| Staging native 100 m wind \| ran \| finished 5 min ago \|/);
  assert.match(text, /Observations and fires .* \| not in this workflow \|/);
  assert.doesNotMatch(text, /whole-data maintenance refreshed/);
});

test('a full run separates refreshed, unchanged, withheld, failed and skipped parts with ages', () => {
  const rows = bakeRows(needs({bake: {result: 'success'}, 'core-ecmwf': {result: 'success'}, 'publish-ecmwf': {result: 'success', outputs: {status: 'published'}},
    'core-gfs': {result: 'failure'}, 'core-hrrr': {result: 'success'}, 'publish-hrrr': {result: 'cancelled', outputs: {}},
    'regional-nam': {result: 'success'}, 'publish-nam': {result: 'success', outputs: {status: 'unchanged'}},
    'regional-icon': {result: 'success'}, 'publish-icon': {result: 'success', outputs: {status: 'withheld'}}}),
  [{name: 'bake', completed_at: at(2)}, {name: 'publish-ecmwf / publisher', completed_at: at(150)}], NOW);
  const row = part => rows.find(r => r.part.startsWith(part));
  assert.deepEqual([row('Whole-data').outcome, row('Whole-data').detail], ['refreshed', 'finished 2 min ago']);
  assert.deepEqual([row('ecmwf').outcome, row('ecmwf').detail], ['refreshed', 'published 2.5 h ago']);
  assert.equal(row('gfs').outcome, 'COLLECTION FAILURE');
  assert.equal(row('hrrr (').outcome, 'PUBLICATION CANCELLED');
  assert.equal(row('nam (').outcome, 'unchanged');assert.equal(row('icon').outcome, 'withheld');
  assert.equal(row('aifs').outcome, 'skipped');
  assert.equal(bakeMode({model: 'gfs'}), 'one model (gfs) — whole-data maintenance is NOT part of this run');
  assert.equal(bakeMode({model: 'all', recoveryRunId: '123'}), 'recovery of run 123 — all models plus whole-data maintenance');
});

test('a component job waiting at the environment gate past the bound is named as a stuck lock and fails the summary', async () => {
  // Shape of the live evidence: bake run 37478458131 publish-ecmwf waiting since 14:46 and
  // component run 36762426044 model (hrrr) waiting since 2026-09-30, while later runs were cancelled.
  const responses = {
    '/actions/runs?status=waiting&per_page=50': {workflow_runs: [{id: 37478458131, path: '.github/workflows/bake.yml', head_sha: 'a'.repeat(40)},
      {id: 36762426044, path: '.github/workflows/catalog-bake.yml', head_sha: 'b'.repeat(40)}, {id: 1, path: '.github/workflows/ui-release.yml'}]},
    '/actions/runs?status=in_progress&per_page=50': {workflow_runs: [{id: 99, path: '.github/workflows/catalog-bake.yml'}]},
    '/actions/runs/37478458131/jobs?per_page=100': {jobs: [{id: 112331348219, name: 'publish-ecmwf / publisher', status: 'waiting', started_at: '2026-10-06T14:46:14Z'},
      {name: 'publish-gfs', status: 'completed', started_at: at(200)}]},
    '/actions/runs/36762426044/jobs?per_page=100': {jobs: [{id: 110048100350, name: 'model (hrrr)', status: 'waiting', started_at: '2026-09-30T18:58:51Z'}]},
    // Live shape: the ECMWF publisher queued 14:46:14 behind its lock and reached the gate at 14:59:52.
    [`/deployments?environment=production&sha=${'a'.repeat(40)}&per_page=100`]: [{id: 6887118736, created_at: '2026-10-06T14:46:14Z'}, {id: 5, created_at: '2026-10-06T12:00:00Z'}],
    '/deployments/6887118736/statuses?per_page=30': [{state: 'waiting', created_at: '2026-10-06T14:59:52Z', target_url: 'https://github.com/x/actions/runs/37478458131/job/112331348219'}],
    [`/deployments?environment=production&sha=${'b'.repeat(40)}&per_page=100`]: [{id: 6767671012, created_at: '2026-09-30T18:58:51Z'}],
    '/deployments/6767671012/statuses?per_page=30': [{state: 'waiting', created_at: '2026-09-30T18:58:52Z', target_url: 'https://github.com/x/actions/runs/36762426044/job/110048100350'}],
    '/actions/runs/99/jobs?per_page=100': {jobs: [{name: 'model (gfs)', status: 'in_progress', started_at: at(4)}]},
  };
  const requested = [];
  const fetcher = async url => {
    const path = url.replace('https://api.github.com/repos/Andrewegao/v3t7kq-cycle', '');requested.push(path);
    return responses[path] ? new Response(JSON.stringify(responses[path])) : new Response('{}', {status: 404});
  };
  const holders = await lockHolders({runId: '500', token: 'fixture', fetcher, now: NOW});
  assert.deepEqual(holders.map(h => [h.model, h.status, h.stuck]), [['ecmwf', 'waiting', true], ['hrrr', 'waiting', true], ['gfs', 'in_progress', false]]);
  assert.ok(!requested.some(path => path.includes('/runs/1/')), 'unrelated workflows are not inspected');
  const {text, stuck} = componentMarkdown({target: 'production', event: 'workflow_dispatch', holders, now: NOW,
    jobs: [{name: 'model (hrrr)', conclusion: 'cancelled'}]});
  assert.equal(stuck.length, 2);
  assert.match(text, /\| hrrr \| CANCELLED \| never ran: superseded while queued for lock weatherx-component-production-hrrr/);
  assert.match(text, /weatherx-component-production-hrrr: run 36762426044 \(catalog-bake\.yml\) job "model \(hrrr\)" is waiting at the environment gate since 143\.0 h ago — STUCK/);
  assert.equal(holders[0].minutes, 180, 'gate age is measured from the 14:59:52 waiting status, not the 14:46 queue start');
  assert.ok(!requested.includes('/deployments/5/statuses?per_page=30'), 'unrelated deployments are not read');
  assert.match(text, /The owner must cancel that run/);
  const env = {GITHUB_RUN_ID: '500', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'fixture', CATALOG_TARGET: 'production', GITHUB_EVENT_NAME: 'workflow_dispatch'};
  responses['/actions/runs/500/attempts/1/jobs?per_page=100'] = {jobs: [{name: 'model (hrrr)', conclusion: 'cancelled'}, {name: 'summary'}]};
  assert.equal(await main(['component'], {...env, SUMMARY_JOB_NAME: 'summary'}, NOW, fetcher), 1);
  responses['/actions/runs?status=waiting&per_page=50'] = {workflow_runs: []};
  assert.equal(await main(['component'], env, NOW, fetcher), 0);
  assert.equal(holderJobName('model (unknown)'), null);assert.equal(holderJobName('publish-nam-hi / publisher'), 'nam-hi');
});

test('an unavailable Actions API is reported, never treated as a stuck lock or as a refresh', async () => {
  const fetcher = async () => new Response('', {status: 503});
  assert.equal(await lockHolders({runId: '1', token: 'fixture', fetcher, now: NOW}), null);
  const {text, stuck} = componentMarkdown({target: 'production', event: 'schedule', holders: null, now: NOW, jobs: null});
  assert.equal(stuck.length, 0);assert.match(text, /could not be listed/);assert.match(text, /job list unavailable/);
});

test('both bakes and the observation lane declare a run name and a read-only final summary', () => {
  const read = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  const bake = read('bake.yml'), catalog = read('catalog-bake.yml'), observations = read('observation-refresh.yml');
  for (const text of [bake, catalog, observations]) assert.match(text, /^run-name: /m);
  assert.match(bake, /staging Wind100 only \(whole-data maintenance skipped\)/);
  const summary = bake.split('\n  run-summary:\n')[1];
  assert.match(summary, /if: \$\{\{ always\(\) \}\}/);assert.match(summary, /NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/);
  for (const job of ['bake', 'staging-wind100', 'production-wind100', ...MODELS.map(m => `publish-${m}`)]) assert.ok(summary.includes(job), job);
  assert.doesNotMatch(summary, /secrets\.|environment:|concurrency:|: write/);
  const component = catalog.split('\n  summary:\n')[1];
  assert.match(component, /needs: model/);assert.match(component, /always\(\)/);
  assert.match(component, /actions: read/);assert.doesNotMatch(component, /secrets\.|environment:|concurrency:|: write/);
});

test('gate age ignores time queued behind the lock, so a normal waiting moment is never stuck', async () => {
  const run = {id: 7, path: '.github/workflows/catalog-bake.yml', head_sha: 'c'.repeat(40), display_title: 'component bake: ecmwf to production'};
  const responses = {
    '/actions/runs?status=waiting&per_page=50': {workflow_runs: [run, {...run, id: 8, display_title: 'component bake: ecmwf to staging'}]},
    '/actions/runs?status=in_progress&per_page=50': {workflow_runs: []},
    '/actions/runs/7/jobs?per_page=100': {jobs: [{id: 70, name: 'model (ecmwf)', status: 'waiting', started_at: at(55)}]},
    [`/deployments?environment=production&sha=${'c'.repeat(40)}&per_page=100`]: [{id: 700, created_at: at(55)}],
    '/deployments/700/statuses?per_page=30': [{state: 'waiting', created_at: new Date(NOW - 2000).toISOString(), target_url: 'https://github.com/x/runs/7/job/70'}],
  };
  const requested = [];
  const fetcher = async url => { const path = url.replace('https://api.github.com/repos/Andrewegao/v3t7kq-cycle', '');requested.push(path);
    return responses[path] ? new Response(JSON.stringify(responses[path])) : new Response('{}', {status: 404}); };
  const holders = await lockHolders({runId: '1', token: 'fixture', fetcher, now: NOW});
  assert.deepEqual(holders.map(h => [h.model, h.minutes, h.stuck]), [['ecmwf', 0, false]]);
  assert.ok(!requested.includes('/actions/runs/8/jobs?per_page=100'), 'staging-target component runs hold staging locks');
  delete responses['/deployments/700/statuses?per_page=30'];responses['/deployments/700/statuses?per_page=30'] = [];
  // No gate status found: measured from the job's own start (55 min), so it is stuck, never silently fine.
  assert.deepEqual((await lockHolders({runId: '1', token: 'fixture', fetcher, now: NOW})).map(h => [h.minutes, h.gateUnknown, h.stuck]), [[55, true, true]]);
  // A staging-target summary never reports or fails on production locks.
  const env = {GITHUB_RUN_ID: '9', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'fixture', CATALOG_TARGET: 'staging', GITHUB_EVENT_NAME: 'workflow_dispatch'};
  requested.length = 0;
  assert.equal(await main(['component'], env, NOW, fetcher), 0);
  assert.ok(!requested.some(path => path.startsWith('/actions/runs?')));
});

test('observation plan refuses unconfirmed dispatch, goes red on a stuck observation lock and stands aside for recovery', async () => {
  const responses = {'/actions/runs?status=waiting&per_page=50': {workflow_runs: []}, '/actions/runs?status=in_progress&per_page=50': {workflow_runs: []}};
  const fetcher = async url => { const path = url.replace('https://api.github.com/repos/Andrewegao/v3t7kq-cycle', '');
    return responses[path] ? new Response(JSON.stringify(responses[path])) : new Response(JSON.stringify({workflow_runs: []})); };
  const plan = (env, event = {}) => observationPlan({env: {GITHUB_RUN_ID: '1', ...env}, event, token: 'fixture', fetcher, now: NOW});
  assert.deepEqual(await plan({GITHUB_EVENT_NAME: 'schedule', ENABLED: 'true'}), {run: true, code: 0, text: ''});
  const unconfirmed = await plan({GITHUB_EVENT_NAME: 'workflow_dispatch', ENABLED: 'true'}, {inputs: {confirmation: 'yes'}});
  assert.equal(unconfirmed.run, false);assert.equal(unconfirmed.code, 1);assert.match(unconfirmed.text, /REFUSED/);
  assert.equal((await plan({GITHUB_EVENT_NAME: 'workflow_dispatch', ENABLED: 'true'}, {inputs: {confirmation: 'RECOVER FIVE OBSERVATION FEEDS'}})).run, true);
  const disabled = await plan({GITHUB_EVENT_NAME: 'schedule', ENABLED: 'false'});
  assert.equal(disabled.run, false);assert.equal(disabled.code, 0);assert.match(disabled.text, /SKIPPED/);
  responses['/actions/workflows/five-feed-recovery.yml/runs?status=queued&per_page=10'] = {workflow_runs: [{id: 42}]};
  const aside = await plan({GITHUB_EVENT_NAME: 'schedule', ENABLED: 'true'});
  assert.equal(aside.run, false);assert.equal(aside.code, 0);assert.match(aside.text, /Manual recovery run 42 is queued/);
  delete responses['/actions/workflows/five-feed-recovery.yml/runs?status=queued&per_page=10'];
  // A recover job stuck at the gate holding the observation lock turns the plan red, even when disabled.
  responses['/actions/runs?status=waiting&per_page=50'] = {workflow_runs: [{id: 50, path: '.github/workflows/five-feed-recovery.yml', head_sha: 'd'.repeat(40)}]};
  responses['/actions/runs/50/jobs?per_page=100'] = {jobs: [{id: 500, name: 'recover', status: 'waiting', started_at: at(200)}]};
  responses[`/deployments?environment=production&sha=${'d'.repeat(40)}&per_page=100`] = [{id: 5000, created_at: at(200)}];
  responses['/deployments/5000/statuses?per_page=30'] = [{state: 'waiting', created_at: at(190), target_url: 'https://github.com/x/job/500'}];
  for (const ENABLED of ['true', 'false']) {
    const blocked = await plan({GITHUB_EVENT_NAME: 'schedule', ENABLED});
    assert.equal(blocked.run, false);assert.equal(blocked.code, 1);
    assert.match(blocked.text, new RegExp(`holding ${OBSERVATION_LOCK}\\. The owner must cancel that run`));
  }
  assert.equal(holderJobName('refresh', 'observation-refresh.yml'), 'observations');assert.equal(holderJobName('refresh', 'bake.yml'), null);
});

test('a single-model recovery says whole-data maintenance is skipped', () => {
  assert.equal(bakeMode({model: 'gfs', recoveryRunId: '123'}), 'recovery of gfs from run 123 — whole-data maintenance is NOT part of this run');
  const bake = readFileSync(new URL('../.github/workflows/bake.yml', import.meta.url), 'utf8');
  assert.match(bake, /format\('bake: recovery of \{0\} from run \{1\} \(whole-data maintenance skipped\)', inputs\.model, inputs\.recovery_run_id\)/);
  assert.ok(bake.indexOf("recovery of {0} from run") < bake.indexOf("recovery of run {0} (all models"), 'the single-model case is decided first');
});

test('a holder whose deployment is older than the newest 100 is still stuck, and a stuck recovery is BLOCKED, not SKIPPED', async () => {
  // Live shape: catalog-bake run 36762426044 model (hrrr) waiting since 2026-09-30 18:58Z while its SHA
  // has >200 production deployments; page 1 (newest 100) spans only 10-01 08:28Z to 16:29Z.
  const page1 = Array.from({length: 100}, (_, i) => ({id: 9000 + i,
    created_at: new Date(Date.parse('2026-10-01T16:29:00Z') - i * (Date.parse('2026-10-01T16:29:00Z') - Date.parse('2026-10-01T08:28:00Z')) / 99).toISOString()}));
  const responses = {
    '/actions/runs?status=waiting&per_page=50': {workflow_runs: [{id: 36762426044, path: '.github/workflows/catalog-bake.yml', head_sha: 'b'.repeat(40)}]},
    '/actions/runs?status=in_progress&per_page=50': {workflow_runs: []},
    '/actions/runs/36762426044/jobs?per_page=100': {jobs: [{id: 110048100350, name: 'model (hrrr)', status: 'waiting', started_at: '2026-09-30T18:58:51Z'}]},
    [`/deployments?environment=production&sha=${'b'.repeat(40)}&per_page=100`]: page1,
  };
  const fetcher = async url => { const path = url.replace('https://api.github.com/repos/Andrewegao/v3t7kq-cycle', '');
    return responses[path] ? new Response(JSON.stringify(responses[path])) : new Response(JSON.stringify(path.includes('/statuses') ? [] : {workflow_runs: []})); };
  const [hrrr] = await lockHolders({runId: '1', token: 'fixture', fetcher, now: NOW});
  assert.deepEqual([hrrr.model, hrrr.gateUnknown, hrrr.stuck], ['hrrr', true, true]);
  assert.equal(hrrr.minutes, 8581, 'measured from the job start 2026-09-30T18:58:51Z');
  const {text, stuck} = componentMarkdown({target: 'production', event: 'schedule', holders: [hrrr], now: NOW, jobs: []});
  assert.equal(stuck.length, 1);assert.match(text, /gate status not found; measured from job start\) — STUCK/);
  // A recovery waiting at the gate past the bound with an unknown deployment: BLOCKED (red), never SKIPPED.
  responses['/actions/runs?status=waiting&per_page=50'] = {workflow_runs: [{id: 60, path: '.github/workflows/five-feed-recovery.yml', head_sha: 'e'.repeat(40), run_started_at: at(45)}]};
  responses['/actions/runs/60/jobs?per_page=100'] = {jobs: [{id: 600, name: 'recover', status: 'waiting', started_at: at(45)}]};
  responses[`/deployments?environment=production&sha=${'e'.repeat(40)}&per_page=100`] = page1;
  responses['/actions/workflows/five-feed-recovery.yml/runs?status=waiting&per_page=10'] = {workflow_runs: [{id: 60}]};
  for (const ENABLED of ['true', 'false']) {
    const plan = await observationPlan({env: {GITHUB_RUN_ID: '1', GITHUB_EVENT_NAME: 'schedule', ENABLED}, event: {}, token: 'fixture', fetcher, now: NOW});
    assert.equal(plan.run, false);assert.equal(plan.code, 1);assert.match(plan.text, /BLOCKED/);assert.doesNotMatch(plan.text, /SKIPPED/);
    assert.match(plan.text, /run 60 \(five-feed-recovery\.yml\) job "recover" has waited at the production environment gate for 45 min ago \(gate status not found/);
  }
  // Under the bound it is not stuck, and the schedule stands aside for the recovery (green SKIPPED).
  responses['/actions/runs/60/jobs?per_page=100'] = {jobs: [{id: 600, name: 'recover', status: 'waiting', started_at: at(10)}]};
  const aside = await observationPlan({env: {GITHUB_RUN_ID: '1', GITHUB_EVENT_NAME: 'schedule', ENABLED: 'true'}, event: {}, token: 'fixture', fetcher, now: NOW});
  assert.equal(aside.code, 0);assert.match(aside.text, /Manual recovery run 60 is waiting/);
});

test('a verified component-bake chain dispatch plans like the schedule; an unverified one is REFUSED', async () => {
  const chainRun = {id: 37600000001, path: '.github/workflows/observation-chain.yml', event: 'workflow_run', head_branch: 'main', created_at: at(1)};
  const responses = {'/actions/runs?status=waiting&per_page=50': {workflow_runs: []}, '/actions/runs?status=in_progress&per_page=50': {workflow_runs: []},
    '/actions/runs/37600000001': chainRun};
  const requested = [];
  const fetcher = async url => { const path = url.replace('https://api.github.com/repos/Andrewegao/v3t7kq-cycle', '');requested.push(path);
    return responses[path] ? new Response(JSON.stringify(responses[path])) : new Response(JSON.stringify(path.includes('/statuses') ? [] : {workflow_runs: []})); };
  const chained = (inputs = {}, ENABLED = 'true') => observationPlan({env: {GITHUB_RUN_ID: '1', GITHUB_EVENT_NAME: 'workflow_dispatch', ENABLED},
    event: {inputs: {caller: CHAIN_CALLER, chain_run_id: '37600000001', ...inputs}}, token: 'fixture', fetcher, now: NOW});
  assert.equal(CHAIN_CALLER, 'component-bake-chain');
  // Chain caller -> the scheduled plan (subset admission happens in the refresh job's scheduled mode).
  assert.deepEqual(await chained(), {run: true, code: 0, text: ''});
  assert.ok(requested.includes('/actions/runs/37600000001'), 'the chain run id is checked against the Actions API');
  const disabled = await chained({}, 'false');
  assert.equal(disabled.run, false);assert.equal(disabled.code, 0);assert.match(disabled.text, /SKIPPED/);
  // Chain caller while a recovery is queued -> SKIPPED (stand aside, green).
  responses['/actions/workflows/five-feed-recovery.yml/runs?status=queued&per_page=10'] = {workflow_runs: [{id: 43}]};
  const aside = await chained();
  assert.equal(aside.run, false);assert.equal(aside.code, 0);assert.match(aside.text, /SKIPPED[\s\S]*Manual recovery run 43 is queued/);
  delete responses['/actions/workflows/five-feed-recovery.yml/runs?status=queued&per_page=10'];
  // Chain caller with a stuck observation lock holder -> BLOCKED (red).
  responses['/actions/runs?status=waiting&per_page=50'] = {workflow_runs: [{id: 51, path: '.github/workflows/observation-refresh.yml', head_sha: 'f'.repeat(40)}]};
  responses['/actions/runs/51/jobs?per_page=100'] = {jobs: [{id: 510, name: 'refresh', status: 'waiting', started_at: at(90)}]};
  const blocked = await chained();
  assert.equal(blocked.run, false);assert.equal(blocked.code, 1);assert.match(blocked.text, /BLOCKED[\s\S]*run 51 \(observation-refresh\.yml\) job "refresh"/);
  responses['/actions/runs?status=waiting&per_page=50'] = {workflow_runs: []};
  // A hand-typed chain caller is refused unless it names a recent observation-chain.yml run on main.
  for (const [inputs, run] of [[{chain_run_id: ''}, null], [{chain_run_id: '12x'}, null], [{chain_run_id: '99'}, null],
    [{}, {...chainRun, path: '.github/workflows/catalog-bake.yml'}], [{}, {...chainRun, event: 'workflow_dispatch'}],
    [{}, {...chainRun, head_branch: 'feature'}], [{}, {...chainRun, created_at: at(16)}],
    [{confirmation: 'RECOVER FIVE OBSERVATION FEEDS'}, {...chainRun, created_at: at(60)}]]) {
    responses['/actions/runs/37600000001'] = run ?? chainRun;
    const refused = await chained(inputs);
    assert.equal(refused.run, false, JSON.stringify(inputs));assert.equal(refused.code, 1);assert.match(refused.text, /REFUSED/);
  }
  // A manual dispatch without the literal is still REFUSED, with or without a caller value.
  for (const inputs of [{}, {confirmation: 'yes'}, {caller: 'operator'}, {caller: '', confirmation: ''}]) {
    const refused = await observationPlan({env: {GITHUB_RUN_ID: '1', GITHUB_EVENT_NAME: 'workflow_dispatch', ENABLED: 'true'}, event: {inputs}, token: 'fixture', fetcher, now: NOW});
    assert.equal(refused.run, false);assert.equal(refused.code, 1);assert.match(refused.text, /must enter `RECOVER FIVE OBSERVATION FEEDS`/);
  }
});
