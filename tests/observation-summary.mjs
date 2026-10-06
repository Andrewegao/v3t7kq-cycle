import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildReceipt, markdown, main, age, FAMILIES, observationReceiptV1} from '../tools/observation-summary.mjs';

const NOW = Date.parse('2026-10-06T18:00:00Z');
const at = minutes => new Date(NOW - minutes * 60000).toISOString();
const qualified = (minutes = 10) => ({rows: 100, currentRecords: 90, currentReadings: null, missingFeeds: [],
  generationTime: at(5), newestRecordTime: at(minutes)});
const fires = {...qualified(60), rows: 30, fireRecords: {legacy: {retained: 30, current24h: 20},
  detail: {retained: 30, current24h: 20}, overview: {retained: 12, current24h: 9}}, missingFeeds: ['NOAA-21']};
const baseline = {targets: Object.fromEntries(Object.keys(FAMILIES).map(f => [f, {generationTime: at(f === 'fires' ? 600 : 300)}]))};
const accepted = families => ({schemaVersion: 1, status: 'passed', runId: '7', runAttempt: 1, sourceSha: 'a'.repeat(40),
  catalogId: 'catalog-8', families});

test('all five accepted families are refreshed with newest-record and bake ages and fire counts', () => {
  const report = buildReceipt({mode: 'scheduled', runId: '7', runAttempt: 1, now: NOW, baseline,
    acceptance: accepted({metar: qualified(), synop: qualified(50), buoys: qualified(), openaq: {...qualified(), currentReadings: 40}, fires}),
    outcomes: Object.fromEntries(Object.keys(FAMILIES).map(f => [f, {status: 'passed'}])), steps: {publish: 'success'}});
  assert.equal(report.verdict, 'all-refreshed');
  assert.deepEqual(report.families.fires.fireRecords.overview, {retained: 12, current24h: 9});
  const text = markdown(report, NOW);
  assert.match(text, /all five families refreshed/);
  assert.match(text, /\| SYNOP \(ground stations\) \| refreshed \| 50 min \| 5 min \| 90 \/ 100 \|/);
  assert.match(text, /\| overview \| 12 \| 9 \|/);
  assert.match(text, /Missing satellite feeds reported by the producer: NOAA-21/);
});

test('a refused fire family is reported with the stale served bake age and makes the verdict partial', () => {
  const report = buildReceipt({mode: 'scheduled', runId: '7', runAttempt: 1, now: NOW, baseline,
    acceptance: {...accepted({metar: qualified(), synop: qualified(), buoys: qualified(), openaq: qualified()}),
      retained: {fires: {status: 'retained', servedGenerationTime: at(600)}}},
    outcomes: {metar: {status: 'passed'}, synop: {status: 'passed'}, buoys: {status: 'passed'}, openaq: {status: 'passed'},
      fires: {status: 'refused', stage: 'collect', code: 'native-process-failed'}}, steps: {}});
  assert.equal(report.verdict, 'partial');
  assert.deepEqual(report.families.fires, {status: 'refused', stage: 'collect', code: 'native-process-failed', servedGenerationTime: at(600)});
  const text = markdown(report, NOW);
  assert.match(text, /PARTIAL/);
  assert.match(text, /REFUSED at collect: native-process-failed — previous data kept \| unknown \| served bake 10\.0 h old/);
  assert.match(text, /STALE served fire bake is 10\.0 h old/);
});

test('green is impossible without acceptance; requested promotion is never called refreshed', () => {
  const receipt = {families: Object.fromEntries(Object.keys(FAMILIES).map(f => [f, {generationTime: at(5)}]))};
  for (const [acceptance, intent, status] of [[null, null, 'admitted-not-published'], [null, {status: 'requested'}, 'promotion-requested-not-accepted'],
    [{...accepted({metar: qualified()}), runAttempt: 2}, {status: 'requested'}, 'promotion-requested-not-accepted'],
    [{...accepted({metar: qualified()}), status: 'refused'}, null, 'admitted-not-published']]) {
    const report = buildReceipt({mode: 'recovery', runId: '7', runAttempt: 1, now: NOW, baseline, receipt, acceptance, intent, steps: {}});
    assert.equal(report.verdict, 'none-refreshed');
    assert.equal(report.families.metar.status, status);
  }
  const none = buildReceipt({mode: 'scheduled', runId: '7', runAttempt: 1, now: NOW, steps: {}});
  assert.ok(Object.values(none.families).every(row => row.status === 'not-collected' && row.servedGenerationTime === null));
  assert.match(markdown(none, NOW), /NOTHING refreshed/);
});

test('untrusted codes and step values cannot inject markup into the public summary', () => {
  const report = buildReceipt({mode: 'scheduled', runId: '7', runAttempt: 1, now: NOW,
    outcomes: {metar: {status: 'refused', stage: '<script>', code: 'x|y\n## injected'}}, steps: {publish: '<b>'}});
  assert.equal(report.families.metar.stage, 'unspecified');assert.equal(report.families.metar.code, 'unspecified');
  assert.equal(report.steps.publish, 'not-run');
  assert.equal(age('not a time', NOW), 'unknown');assert.equal(age(at(150), NOW), '2.5 h');
});

test('main writes the public receipt and summary and exits nonzero unless all five refreshed', () => {
  const root = mkdtempSync(join(tmpdir(), 'observation-summary-'));const state = join(root, 'state'), stage = join(root, 'stage');
  mkdirSync(state);mkdirSync(stage);const summary = join(root, 'summary.md');
  writeFileSync(join(state, 'baseline.json'), JSON.stringify({catalog: {private: true}, ...baseline}));
  writeFileSync(join(stage, 'collection-outcomes.json'), JSON.stringify({fires: {status: 'refused', stage: 'admission', code: 'no-current-fire-detail'}}));
  const env = {FIVE_FEED_MODE: 'scheduled', GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1', GITHUB_STEP_SUMMARY: summary, STEP_COLLECT: 'success'};
  assert.equal(main([state, stage], env, NOW), 1);
  const receipt = JSON.parse(readFileSync(join(state, 'observation-receipt.json'), 'utf8'));
  assert.equal(receipt.families.fires.code, 'no-current-fire-detail');
  assert.doesNotMatch(JSON.stringify(receipt), /private/, 'private catalog bodies never reach the public receipt');
  assert.match(readFileSync(summary, 'utf8'), /REFUSED at admission: no-current-fire-detail/);
  writeFileSync(join(state, 'acceptance.json'), JSON.stringify(accepted({metar: qualified(), synop: qualified(), buoys: qualified(), openaq: qualified(), fires})));
  writeFileSync(join(stage, 'collection-outcomes.json'), '{}');
  assert.equal(main([state, stage], env, NOW), 0);
});

test('the shared Atmos refresh receipt mirrors the controller verdict without claiming refreshes', () => {
  const receipt = {families: {metar: {files: [{path: 'metar.json', size: 1200, sha256: 'a'.repeat(64)}]}}};
  const report = buildReceipt({mode: 'scheduled', runId: '7', runAttempt: 1, now: NOW, baseline, receipt,
    acceptance: accepted({metar: qualified(12)}), outcomes: {fires: {status: 'refused', stage: 'admission', code: 'no-current-fire-detail'},
      synop: {status: 'refused', stage: 'collect', code: 'deadline-exceeded'}}, steps: {}});
  const v1 = observationReceiptV1(report, NOW);
  assert.equal(v1.schema, 'weatherx-observation-refresh-v1');assert.equal(v1.verdict, 'incomplete');
  const feed = name => v1.feeds.find(row => row.feed === name);
  assert.deepEqual(feed('metar'), {feed: 'metar', outcome: 'ok', refreshed: true, newest_record_age_min: 12, output: {bytes: 1200}});
  assert.equal(feed('fires').outcome, 'stale');assert.equal(feed('fires').snapshot_age_min, 600);assert.equal(feed('fires').refreshed, false);
  assert.equal(feed('synop').outcome, 'failed');assert.equal(feed('buoys').outcome, 'missing');
  assert.ok(v1.feeds.every(row => ['ok', 'failed', 'stale', 'missing'].includes(row.outcome)));
});
