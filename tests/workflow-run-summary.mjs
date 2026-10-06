import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {bakeMarkdown, bakeRows, bakeMode, componentMarkdown, lockHolders, holderJobName, main, MODELS} from '../tools/workflow-run-summary.mjs';

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
    '/actions/runs?status=waiting&per_page=50': {workflow_runs: [{id: 37478458131, path: '.github/workflows/bake.yml'},
      {id: 36762426044, path: '.github/workflows/catalog-bake.yml'}, {id: 1, path: '.github/workflows/ui-release.yml'}]},
    '/actions/runs?status=in_progress&per_page=50': {workflow_runs: [{id: 99, path: '.github/workflows/catalog-bake.yml'}]},
    '/actions/runs/37478458131/jobs?per_page=100': {jobs: [{name: 'publish-ecmwf / publisher', status: 'waiting', started_at: '2026-10-06T14:46:14Z'},
      {name: 'publish-gfs', status: 'completed', started_at: at(200)}]},
    '/actions/runs/36762426044/jobs?per_page=100': {jobs: [{name: 'model (hrrr)', status: 'waiting', started_at: '2026-09-30T18:58:51Z'}]},
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
  assert.match(text, /run 36762426044 \(catalog-bake\.yml\) job "model \(hrrr\)" is waiting since 143\.0 h ago — STUCK/);
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
