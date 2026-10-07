#!/usr/bin/env node
// Public, read-only verdict for the observation lane. It reads only local controller outputs,
// writes the step summary and a small public receipt, and fails unless all five families
// were refreshed and accepted. It never publishes, retries, or reads private catalog bodies
// beyond the served bake time of each target component.
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const FAMILIES = Object.freeze({metar: 'METAR (airports)', synop: 'SYNOP (ground stations)',
  buoys: 'Buoys', openaq: 'OpenAQ (air quality)', fires: 'Fires (FIRMS)'});
const CODE = /^[a-z0-9][a-z0-9:,._-]{0,95}$/;
const OUTCOME = /^(?:success|failure|cancelled|skipped)$/;
const safe = value => typeof value === 'string' && CODE.test(value) ? value : 'unspecified';
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
function read(path) {
  try { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null; } catch { return null; }
}
export function age(value, now) {
  const at = time(value);
  if (!at) return 'unknown';
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60000));
  return minutes < 120 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}
function fireRecords(value) {
  const out = {};
  for (const view of ['legacy', 'detail', 'overview']) {
    const row = value?.[view];
    if (!row) return null;
    out[view] = {retained: count(row.retained), current24h: count(row.current24h)};
  }
  return out;
}

// Build the receipt from local files only. Every family is exactly one of: refreshed, refused,
// admitted-not-accepted, or not-collected. Only `refreshed` counts as a success.
export function buildReceipt({mode, runId, runAttempt, now, outcomes, receipt, acceptance, baseline, intent, steps}) {
  const accepted = acceptance?.status === 'passed' && acceptance.runId === runId && acceptance.runAttempt === runAttempt;
  const families = {};
  for (const family of Object.keys(FAMILIES)) {
    const served = time(baseline?.targets?.[family]?.generationTime ?? acceptance?.retained?.[family]?.servedGenerationTime);
    const qualified = accepted ? acceptance.families?.[family] : undefined;
    const outcome = outcomes?.[family];
    let row;
    if (qualified) {
      row = {status: 'refreshed', generationTime: time(qualified.generationTime ?? receipt?.families?.[family]?.generationTime),
        newestRecordTime: time(qualified.newestRecordTime), rows: count(qualified.rows), currentRecords: count(qualified.currentRecords),
        bytes: count((receipt?.families?.[family]?.files ?? []).reduce((total, file) => total + (count(file?.size) ?? 0), 0)) || null};
      if (family === 'openaq') row.currentReadings = count(qualified.currentReadings);
      if (family === 'fires') {
        row.fireRecords = fireRecords(qualified.fireRecords);
        row.missingFeeds = Array.isArray(qualified.missingFeeds) ? qualified.missingFeeds.filter(v => typeof v === 'string').slice(0, 8) : [];
      }
    } else if (outcome?.status === 'refused') {
      row = {status: 'refused', stage: safe(outcome.stage), code: safe(outcome.code), servedGenerationTime: served};
    } else if (receipt?.families?.[family]) {
      row = {status: intent ? 'promotion-requested-not-accepted' : 'admitted-not-published',
        collectedGenerationTime: time(receipt.families[family].generationTime), servedGenerationTime: served};
    } else {
      row = {status: 'not-collected', servedGenerationTime: served};
    }
    families[family] = row;
  }
  const refreshed = Object.values(families).filter(row => row.status === 'refreshed').length;
  const verdict = refreshed === Object.keys(FAMILIES).length ? 'all-refreshed' : refreshed > 0 ? 'partial' : 'none-refreshed';
  const stepOutcomes = Object.fromEntries(Object.entries(steps ?? {}).map(([k, v]) => [k, OUTCOME.test(v ?? '') ? v : 'not-run']));
  return {schemaVersion: 1, mode, runId, runAttempt, generatedAt: new Date(now).toISOString(),
    sourceSha: typeof acceptance?.sourceSha === 'string' ? acceptance.sourceSha : null,
    catalogId: accepted ? safe(acceptance.catalogId) : null, verdict, steps: stepOutcomes, families};
}

// The Atmos refresh table (ops/report-refresh.py, schema weatherx-observation-refresh-v1) is
// rendered from this receipt once the pinned Atmos source provides that reporter. The five-feed
// controller's exact admission stays authoritative; this is the same verdict in the shared table.
export function observationReceiptV1(report, now) {
  const minutes = value => { const at = time(value); return at ? Math.max(0, Math.round((now - Date.parse(at)) / 60000)) : null; };
  const feeds = Object.entries(report.families).map(([feed, row]) => {
    if (row.status === 'refreshed') return {feed, outcome: 'ok', refreshed: true, newest_record_age_min: minutes(row.newestRecordTime),
      output: {bytes: row.bytes ?? null}, ...(feed === 'fires' ? {missing_feeds: row.missingFeeds ?? []} : {})};
    const stale = row.status === 'refused' && /^no-current/.test(row.code);
    const detail = row.status === 'refused' ? `refused at ${row.stage}: ${row.code}` : row.status.replaceAll('-', ' ');
    return {feed, outcome: row.status === 'not-collected' ? 'missing' : stale ? 'stale' : 'failed', refreshed: false,
      newest_record_age_min: null, output: {}, reused_previous_snapshot: true, snapshot_age_min: minutes(row.servedGenerationTime), detail};
  });
  return {schema: 'weatherx-observation-refresh-v1', source: 'five-feed-controller', mode: report.mode,
    verdict: report.verdict === 'all-refreshed' ? 'green' : 'incomplete', exit_status: report.verdict === 'all-refreshed' ? 0 : 1,
    started_at: null, finished_at: report.generatedAt, feeds};
}

export function markdown(report, now) {
  const head = report.verdict === 'all-refreshed' ? 'all five families refreshed'
    : report.verdict === 'partial' ? 'PARTIAL — some families were NOT refreshed (run is red)'
      : 'NOTHING refreshed (run is red)';
  const lines = [`## Observation refresh (${report.mode}): ${head}`, '',
    `Run ${report.runId} attempt ${report.runAttempt}; ages measured at ${report.generatedAt}.`, '',
    '| Family | Outcome | Newest record age | Bake age | Records (current / rows) |', '| --- | --- | --- | --- | --- |'];
  for (const [family, label] of Object.entries(FAMILIES)) {
    const row = report.families[family];
    if (row.status === 'refreshed') {
      const current = `${row.currentRecords ?? '?'} / ${row.rows ?? '?'}` + (family === 'openaq' ? ` (${row.currentReadings ?? '?'} current readings)` : '');
      lines.push(`| ${label} | refreshed | ${age(row.newestRecordTime, now)} | ${age(row.generationTime, now)} | ${current} |`);
    } else {
      const why = row.status === 'refused' ? `REFUSED at ${row.stage}: ${row.code}` : row.status === 'promotion-requested-not-accepted'
        ? 'PROMOTION REQUESTED, ACCEPTANCE NOT PROVEN — inspect before any retry' : row.status === 'admitted-not-published'
          ? 'admitted, NOT published' : 'NOT collected';
      lines.push(`| ${label} | ${why} — previous data kept | unknown | served bake ${age(row.servedGenerationTime, now)} old | — |`);
    }
  }
  const fire = report.families.fires;
  lines.push('', '### Fires');
  if (fire.status === 'refreshed' && fire.fireRecords) {
    lines.push(`New fire bake ${age(fire.generationTime, now)} old (baked_at ${fire.generationTime}). Older genuine detections are retained with their real times and are not counted as current.`, '',
      '| View | Retained detections | Current (≤24 h) |', '| --- | --- | --- |');
    for (const view of ['legacy', 'detail', 'overview'])
      lines.push(`| ${view} | ${fire.fireRecords[view].retained ?? '?'} | ${fire.fireRecords[view].current24h ?? '?'} |`);
    if (fire.missingFeeds?.length) lines.push('', `Missing satellite feeds reported by the producer: ${fire.missingFeeds.map(v => v.replace(/[|`<>]/g, '')).join(', ')}.`);
  } else {
    lines.push(`Fire collection was not refreshed. The STALE served fire bake is ${age(fire.servedGenerationTime, now)} old` +
      (fire.servedGenerationTime ? ` (baked_at ${fire.servedGenerationTime}).` : ' (served bake time unknown).'));
  }
  lines.push('', `Steps: ${Object.entries(report.steps).map(([k, v]) => `${k}=${v}`).join(', ') || 'none recorded'}.`, '');
  return lines.join('\n');
}

export function main(argv, env = process.env, now = Date.now()) {
  const [stateArg, stageArg] = argv;
  if (!stateArg || !stageArg) throw new Error('usage: observation-summary.mjs STATE_DIR STAGE_DIR');
  const state = resolve(stateArg), stage = resolve(stageArg);
  const mode = ['recovery', 'scheduled'].includes(env.FIVE_FEED_MODE) ? env.FIVE_FEED_MODE : 'unknown';
  const report = buildReceipt({mode, runId: env.GITHUB_RUN_ID ?? '', runAttempt: Number(env.GITHUB_RUN_ATTEMPT ?? 0), now,
    outcomes: read(join(stage, 'collection-outcomes.json')), receipt: read(join(stage, 'receipt.json')),
    acceptance: read(join(state, 'acceptance.json')), baseline: read(join(state, 'baseline.json')),
    intent: read(join(state, 'public-promotion-intent.json')),
    steps: {source: env.STEP_SOURCE, snapshot: env.STEP_SNAPSHOT, collect: env.STEP_COLLECT, publish: env.STEP_PUBLISH}});
  if (existsSync(state)) {
    writeFileSync(join(state, 'observation-receipt.json'), JSON.stringify(report, null, 2) + '\n');
    writeFileSync(join(state, 'observation-refresh-v1.json'), JSON.stringify(observationReceiptV1(report, now), null, 2) + '\n');
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown(report, now));
  console.log(JSON.stringify({verdict: report.verdict, families: Object.fromEntries(Object.entries(report.families).map(([k, v]) => [k, v.status]))}));
  return report.verdict === 'all-refreshed' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
