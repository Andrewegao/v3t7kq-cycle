#!/usr/bin/env node
// Read-only run summary for the data workflows: what this run refreshed, skipped or failed, and
// how long ago each refreshed part finished. It reads only `needs` results and this repository's
// public Actions job metadata; it cannot publish, dispatch, cancel or approve anything.
import {appendFileSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const REPO = 'Andrewegao/v3t7kq-cycle';
const API = `https://api.github.com/repos/${REPO}`;
export const MODELS = Object.freeze(['ecmwf', 'gfs', 'hrrr', 'aifs', 'icon', 'hrdps', 'arome-antilles', 'hrrr-ak', 'nam', 'nam-hi', 'nam-ak']);
const CORE = MODELS.slice(0, 4);
const OPTIONAL_CORE = Object.freeze(['hrrr', 'aifs']);
// atmos 2026-10-07: HRRR at most 12 h old at the release freshness gate; AIFS at most 24 h at install.
const CARRY_LIMIT = Object.freeze({hrrr: '12 h old at the release gate', aifs: '24 h old'});
const RESULT = /^(?:success|failure|cancelled|skipped)$/;
const result = value => RESULT.test(value ?? '') ? value : 'unknown';
// An environment gate with no reviewer and no wait timer should clear in seconds. A job left in
// `waiting` longer than this keeps its job-level concurrency group and starves later writers.
export const STUCK_WAITING_MINUTES = 30;

export function minutesSince(value, now) {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) && at > Date.parse('2000-01-01') ? Math.max(0, Math.round((now - at) / 60000)) : null;
}
const ago = minutes => minutes === null ? 'time unavailable' : minutes < 120 ? `${minutes} min ago` : `${(minutes / 60).toFixed(1)} h ago`;

async function github(path, token, fetcher) {
  const response = await fetcher(`${API}${path}`, {headers: {accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28'}, signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`github-api-${response.status}`);
  return response.json();
}
export async function runJobs({runId, attempt, token, fetcher = fetch}) {
  if (!/^[1-9]\d{0,19}$/.test(runId ?? '') || !/^[1-9]\d{0,5}$/.test(String(attempt ?? '')) || !token) return null;
  try { return (await github(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`, token, fetcher)).jobs ?? null; }
  catch { return null; }
}
const finished = (jobs, prefix) => jobs?.find(job => job.name === prefix || job.name.startsWith(`${prefix} /`))?.completed_at;

// --- bake.yml ---------------------------------------------------------------------------------
export function bakeMode(inputs) {
  if (inputs.wind100Only === 'true') return 'staging Wind100 only — whole-data maintenance and model publication are NOT part of this run';
  if (inputs.recoveryRunId && inputs.model && inputs.model !== 'all')
    return `recovery of ${inputs.model.replace(/[^a-z-]/g, '')} from run ${inputs.recoveryRunId.replace(/[^0-9]/g, '')} — whole-data maintenance is NOT part of this run`;
  if (inputs.recoveryRunId) return `recovery of run ${inputs.recoveryRunId.replace(/[^0-9]/g, '')} — all models plus whole-data maintenance`;
  if (inputs.model && inputs.model !== 'all') return `one model (${inputs.model.replace(/[^a-z-]/g, '')}) — whole-data maintenance is NOT part of this run`;
  return 'all eleven models plus whole-data maintenance';
}

export function bakeRows(needs, jobs, now) {
  const rows = [];
  const time = prefix => ago(minutesSince(finished(jobs, prefix), now));
  const maintenance = result(needs.bake?.result);
  // bake.yml lets a failed HRRR/AIFS collector abstain from the whole release (atmos 2026-10-07).
  const abstained = maintenance === 'success' ? OPTIONAL_CORE.filter(model => result(needs[`core-${model}`]?.result) === 'failure') : [];
  rows.push({part: 'Whole-data maintenance (immutable whole release; legacy observation fallback)',
    outcome: maintenance === 'success' ? 'refreshed' : maintenance === 'skipped' ? 'SKIPPED' : maintenance === 'unknown' ? 'unknown' : maintenance.toUpperCase(),
    detail: maintenance === 'success' ? `finished ${time('bake')}${abstained.length ? `; abstained core: ${abstained.join(', ')}` : ''}`
      : 'previous whole release kept; this run did not refresh it'});
  for (const model of MODELS) {
    const collectorKey = `${CORE.includes(model) ? 'core' : 'regional'}-${model}`;
    const collector = result(needs[collectorKey]?.result);
    const publisher = needs[`publish-${model}`];
    const published = publisher?.outputs?.status;
    const publishResult = result(publisher?.result);
    let outcome, detail;
    if (collector === 'skipped') { outcome = 'skipped'; detail = 'not requested by this run'; }
    else if (collector !== 'success') { outcome = collector === 'unknown' ? 'unknown' : `COLLECTION ${collector.toUpperCase()}`;
      detail = abstained.includes(model) ? `abstained from the whole release; its last published run (at most ${CARRY_LIMIT[model]}) is still served` : 'previous component kept'; }
    else if (publishResult === 'skipped') { outcome = 'collected, publication skipped'; detail = 'per-model publication disabled or not requested; previous component kept'; }
    else if (published === 'published') { outcome = 'refreshed'; detail = `published ${time(`publish-${model}`)}`; }
    else if (published === 'unchanged') { outcome = 'unchanged'; detail = 'collected run already published'; }
    else if (published === 'withheld') { outcome = 'withheld'; detail = 'publisher withheld the candidate; previous component kept'; }
    else { outcome = `PUBLICATION ${publishResult === 'success' ? 'FAILED' : publishResult.toUpperCase()}`; detail = 'previous component kept'; }
    rows.push({part: `${model} (${CORE.includes(model) ? 'core' : 'regional'})`, outcome, detail});
  }
  for (const [key, label] of [['staging-wind100', 'Staging native 100 m wind'], ['production-wind100', 'Production native 100 m wind']]) {
    const value = result(needs[key]?.result);
    rows.push({part: label, outcome: value === 'success' ? 'ran' : value === 'skipped' ? 'skipped' : value.toUpperCase(),
      detail: value === 'success' ? `finished ${time(key === 'staging-wind100' ? 'staging native 100m wind' : 'production native 100m wind')}` : 'not refreshed by this run'});
  }
  rows.push({part: 'Observations and fires (METAR, SYNOP, buoys, OpenAQ, FIRMS)', outcome: 'not in this workflow',
    detail: 'refreshed independently of models by observation-refresh.yml; see that run summary'});
  return rows;
}

function table(rows) {
  return ['| Part | Outcome | Detail |', '| --- | --- | --- |', ...rows.map(row => `| ${row.part} | ${row.outcome} | ${row.detail} |`)];
}
function headline(rows) {
  const pick = test => rows.filter(row => test(row.outcome)).map(row => row.part.split(' (')[0]);
  const refreshed = pick(o => o === 'refreshed' || o === 'ran');
  const skipped = pick(o => /^skipped|SKIPPED|publication skipped/.test(o));
  const failed = pick(o => /FAILED|FAILURE|CANCELLED|unknown/.test(o));
  return [`**Refreshed:** ${refreshed.join(', ') || 'nothing'}`, `**Skipped:** ${skipped.join(', ') || 'nothing'}`,
    `**Failed or cancelled:** ${failed.join(', ') || 'nothing'}`];
}

export function bakeMarkdown({needs, jobs, inputs, event, now}) {
  const rows = bakeRows(needs, jobs, now);
  const maintenance = rows[0].outcome;
  const title = maintenance === 'refreshed' ? 'whole-data maintenance refreshed' : `whole-data maintenance ${maintenance}`;
  return [`## bake run summary: ${title}`, '', `Trigger: ${event.replace(/[^a-z_]/g, '')}; mode: ${bakeMode(inputs)}.`,
    `Ages are measured when this summary ran (${new Date(now).toISOString()}).`, '', ...headline(rows).map(l => `${l}  `), '', ...table(rows), ''].join('\n');
}

// --- catalog-bake.yml -------------------------------------------------------------------------
// Production writer locks and the jobs that take them. Component writers hold
// weatherx-component-production-<model>; every obs-* writer holds the observation lock.
export const OBSERVATION_LOCK = 'weatherx-observation-components-production';
const HOLDER_WORKFLOWS = ['.github/workflows/catalog-bake.yml', '.github/workflows/bake.yml', '.github/workflows/resume-model-publication.yml',
  '.github/workflows/observation-refresh.yml', '.github/workflows/five-feed-recovery.yml'];
export function holderJobName(name, workflow = '') {
  if ((workflow === 'observation-refresh.yml' && name === 'refresh') || (workflow === 'five-feed-recovery.yml' && name === 'recover'))
    return 'observations';
  const component = /^model \(([a-z-]+)\)$/.exec(name);
  if (component && MODELS.includes(component[1])) return component[1];
  const publisher = /^publish-([a-z-]+) \/ publisher$/.exec(name);
  return publisher && MODELS.includes(publisher[1]) ? publisher[1] : null;
}
export const lockName = model => model === 'observations' ? OBSERVATION_LOCK : `weatherx-component-production-${model}`;

// A job that queued behind its lock reaches the environment gate only when the lock frees, so its
// age at the gate is measured from that deployment's `waiting` status, never from job.started_at
// (which includes the normal time spent queued behind the lock).
export async function gateWaitingSince({run, job, token, fetcher}) {
  const started = Date.parse(job.started_at ?? '');
  if (!/^[a-f0-9]{40}$/.test(run.head_sha ?? '') || !Number.isFinite(started)) return null;
  const deployments = await github(`/deployments?environment=production&sha=${run.head_sha}&per_page=100`, token, fetcher);
  const near = (Array.isArray(deployments) ? deployments : [])
    .filter(row => Math.abs(Date.parse(row.created_at ?? '') - started) <= 120000).slice(0, 10);
  for (const deployment of near) {
    const statuses = await github(`/deployments/${deployment.id}/statuses?per_page=30`, token, fetcher);
    const waiting = (Array.isArray(statuses) ? statuses : [])
      .filter(row => row.state === 'waiting' && String(row.target_url ?? '').endsWith(`/job/${job.id}`))
      .map(row => row.created_at).sort().at(-1);
    if (waiting) return waiting;
  }
  return null;
}

// Jobs elsewhere in this repository that hold, or wait at the production gate holding, a writer lock.
export async function lockHolders({runId, token, fetcher = fetch, now, only = null}) {
  const holders = [];
  if (!token) return null;
  try {
    for (const status of ['waiting', 'in_progress']) {
      const runs = (await github(`/actions/runs?status=${status}&per_page=50`, token, fetcher)).workflow_runs ?? [];
      for (const run of runs.filter(run => String(run.id) !== String(runId) && HOLDER_WORKFLOWS.includes(run.path)
        && !/ to staging$/.test(run.display_title ?? '')).slice(0, 10)) {
        const workflow = run.path.split('/').pop();
        const jobs = (await github(`/actions/runs/${run.id}/jobs?per_page=100`, token, fetcher)).jobs ?? [];
        for (const job of jobs) {
          const model = holderJobName(job.name, workflow);
          if (!model || (only && !only.includes(model)) || !['waiting', 'in_progress'].includes(job.status)) continue;
          const gate = job.status === 'waiting' ? await gateWaitingSince({run, job, token, fetcher}) : null;
          // gateWaitingSince reads only the newest 100 production deployments for the SHA; a holder
          // whose gate status is not found there is measured from its own start (an upper bound), so a
          // waiting holder is never reported as not stuck merely because its deployment is unknown.
          const gateUnknown = job.status === 'waiting' && !gate;
          const since = job.status === 'waiting' ? gate ?? job.started_at ?? job.created_at ?? run.run_started_at : job.started_at;
          const minutes = minutesSince(since, now);
          holders.push({model, lock: lockName(model), runId: run.id, workflow, job: job.name, status: job.status, minutes, gateUnknown,
            stuck: job.status === 'waiting' && minutes !== null && minutes > STUCK_WAITING_MINUTES});
        }
      }
    }
  } catch { return null; }
  return holders;
}

const CONFIRMATION = 'RECOVER FIVE OBSERVATION FEEDS';
// observation-chain.yml dispatches the lane with this caller and its own run id. The id is checked
// against the Actions API, so typing the caller by hand is not a way around the literal.
export const CHAIN_CALLER = 'component-bake-chain';
export const CHAIN_WORKFLOW = '.github/workflows/observation-chain.yml';
export const CHAIN_MAX_AGE_MINUTES = 15;
export async function chainCallerVerified({runId, token, fetcher, now}) {
  if (!/^[1-9]\d{0,19}$/.test(runId ?? '') || !token) return false;
  try {
    const run = await github(`/actions/runs/${runId}`, token, fetcher);
    const minutes = minutesSince(run.created_at, now);
    return run.path === CHAIN_WORKFLOW && run.event === 'workflow_run' && run.head_branch === 'main'
      && minutes !== null && minutes <= CHAIN_MAX_AGE_MINUTES;
  } catch { return false; }
}
export const LANE_GAP_MINUTES = 25;
const ACTIVE_STATUSES = ['queued', 'pending', 'waiting', 'requested', 'in_progress'];
async function otherLaneRun({runId, token, fetcher, now}) {
  const other = run => String(run.id) !== String(runId);
  for (const status of ACTIVE_STATUSES) {
    const run = ((await github(`/actions/workflows/observation-refresh.yml/runs?status=${status}&per_page=10`, token, fetcher)).workflow_runs ?? []).find(other);
    if (run) return {id: run.id, why: `is ${status}`};
  }
  for (const run of ((await github('/actions/workflows/observation-refresh.yml/runs?per_page=10', token, fetcher)).workflow_runs ?? []).filter(other)) {
    const minutes = minutesSince(run.run_started_at ?? run.created_at, now);
    if (minutes !== null && minutes <= LANE_GAP_MINUTES) return {id: run.id, why: `started ${minutes} min ago (${String(run.event ?? '').replace(/[^a-z_]/g, '')})`};
  }
  return null;
}
// The observation lane's secret-free plan: refuse an unconfirmed manual dispatch, name a stuck
// observation lock (red), and stand aside while a manual recovery is queued or running so the
// schedule never cancels it (GitHub keeps one pending job per concurrency group). A verified
// component-bake chain dispatch is planned exactly like the schedule.
export async function observationPlan({env, event, token, fetcher = fetch, now}) {
  const lines = [];
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && event?.inputs?.caller === CHAIN_CALLER) {
    if (!await chainCallerVerified({runId: event?.inputs?.chain_run_id, token, fetcher, now}))
      return {run: false, code: 1, text: `## Observation refresh: REFUSED\n\nThe \`${CHAIN_CALLER}\` caller must name an observation-chain.yml run on main from the last ${CHAIN_MAX_AGE_MINUTES} minutes. Nothing was refreshed.\n`};
  } else if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && event?.inputs?.confirmation !== CONFIRMATION)
    return {run: false, code: 1, text: `## Observation refresh: REFUSED\n\nA manual dispatch must enter \`${CONFIRMATION}\`. Nothing was refreshed.\n`};
  const holders = await lockHolders({runId: env.GITHUB_RUN_ID, token, fetcher, now, only: ['observations']});
  const stuck = (holders ?? []).filter(holder => holder.stuck);
  for (const holder of stuck) lines.push(`- run ${holder.runId} (${holder.workflow}) job "${holder.job}" has waited at the production environment gate for ${ago(holder.minutes)}${holder.gateUnknown ? ' (gate status not found; measured from job start)' : ''}, holding ${OBSERVATION_LOCK}. The owner must cancel that run.`);
  if (stuck.length) return {run: false, code: 1, text: ['## Observation refresh: BLOCKED (stuck writer lock)', '', ...lines, ''].join('\n')};
  let recovery = null;
  try {
    for (const status of ACTIVE_STATUSES) {
      const runs = (await github(`/actions/workflows/five-feed-recovery.yml/runs?status=${status}&per_page=10`, token, fetcher)).workflow_runs ?? [];
      if (runs.length) { recovery = {id: runs[0].id, status}; break; }
    }
  } catch { recovery = undefined; }
  if (env.ENABLED !== 'true')
    return {run: false, code: 0, text: '## Observation refresh: SKIPPED\n\nNothing was refreshed. The repository variable OBSERVATION_REFRESH_ENABLED is not `true`; METAR, SYNOP, buoys, OpenAQ and fires keep their previously published data.\n'};
  if (recovery) return {run: false, code: 0, text: `## Observation refresh: SKIPPED\n\nManual recovery run ${recovery.id} is ${recovery.status}; this run stands aside so it cannot cancel that recovery. Nothing was refreshed by this run.\n`};
  // The cron is the fallback behind the component-bake chain: it stands aside for any other lane run
  // that is still active or started within the chain's 25-minute gap.
  let overlap = null;
  if (env.GITHUB_EVENT_NAME === 'schedule') {
    try { overlap = await otherLaneRun({runId: env.GITHUB_RUN_ID, token, fetcher, now}); } catch { overlap = undefined; }
    if (overlap) return {run: false, code: 0, text: `## Observation refresh: SKIPPED\n\nLane run ${overlap.id} ${overlap.why}; this scheduled run stands aside. Nothing was refreshed by this run.\n`};
  }
  const notes = [holders === null || recovery === undefined || overlap === undefined ? 'Lock, recovery or overlap checks were unavailable (Actions API); refreshing anyway.' : null].filter(Boolean);
  return {run: true, code: 0, text: notes.length ? `## Observation refresh plan\n\n${notes.join('\n')}\n` : ''};
}

// GitHub keeps one pending job per concurrency group, and a newer pending job cancels the older one
// even with cancel-in-progress false. A whole-bake publisher (bake.yml `publish-<model> / publisher`,
// or resume-model-publication.yml `resume (<model>) / publisher`) queued behind a running component job
// shares weatherx-component-production-<model>, so a routine component dispatch for that model would
// cancel it (bake run 37679425040 lost hrrr, ecmwf and gfs this way on 2026-10-07). The plan drops a
// model from this component run while its publisher is queued, and also while the whole bake's collector
// for it is still running (or has finished and its publisher is not listed yet): the publisher follows the
// collector within seconds, and a component job that joined the group in that gap would replace it.
// Component publishes for that model therefore pause during the whole bake's collector. It never drops a
// model for any other reason, never touches staging targets, and keeps every model when the API is unreadable.
export const WHOLE_BAKE_WORKFLOWS = Object.freeze(['.github/workflows/bake.yml', '.github/workflows/resume-model-publication.yml']);
const QUEUED_JOB = ['queued', 'pending', 'waiting', 'requested'];
const JOB_PAGES = 5;
async function allJobs(runId, token, fetcher) {
  const jobs = [];
  for (let page = 1; page <= JOB_PAGES; page += 1) {
    const body = await github(`/actions/runs/${runId}/jobs?per_page=100&page=${page}`, token, fetcher);
    jobs.push(...(body.jobs ?? []));
    if (!(body.total_count > jobs.length) || !(body.jobs ?? []).length) return jobs;
  }
  throw new Error('job list too long');
}
export function wholeBakeReasons(jobs) {
  const reasons = new Map();
  const add = (model, job, why) => { if (MODELS.includes(model) && !reasons.has(model)) reasons.set(model, {job: job.name, status: job.status, why}); };
  for (const job of jobs) {
    const publisher = /^(?:publish-([a-z-]+)|resume \(([a-z-]+)\)) \/ publisher$/.exec(job.name ?? '');
    if (publisher && QUEUED_JOB.includes(job.status)) add(publisher[1] ?? publisher[2], job, 'its publisher is waiting for');
  }
  for (const job of jobs) {
    const collector = /^(?:core|regional) \(([a-z-]+)\) \/ collector$/.exec(job.name ?? '');
    if (!collector) continue;
    const model = collector[1];
    const publisherListed = jobs.some(other => other.name === `publish-${model} / publisher` || other.name === `publish-${model}`);
    if (job.status !== 'completed') add(model, job, 'its collector runs first and its publisher then waits for');
    else if (job.conclusion === 'success' && !publisherListed) add(model, job, 'its collector just finished and its publisher is about to wait for');
  }
  return reasons;
}
export async function componentPlan({env, token, fetcher = fetch}) {
  let requested = null;
  try { requested = JSON.parse(env.REQUESTED_MODELS ?? ''); } catch { requested = null; }
  if (!Array.isArray(requested) || !requested.length || !requested.every(model => MODELS.includes(model)))
    return {models: null, aside: [], text: '## Component bake plan\n\nRequested model list unreadable; the model job falls back to its own matrix.\n'};
  if (env.CATALOG_TARGET !== 'production') return {models: requested, aside: [], text: ''};
  const aside = [];
  try {
    if (!token) throw new Error('no token');
    for (const path of WHOLE_BAKE_WORKFLOWS) {
      // No server-side status filter: a run whose only live job is waiting on a lock may be listed as
      // queued, pending or waiting rather than in_progress. Completed runs are skipped here instead.
      const runs = (await github(`/actions/workflows/${path.split('/').pop()}/runs?per_page=10`, token, fetcher)).workflow_runs ?? [];
      for (const run of runs.filter(run => run.path === path && run.head_branch === 'main' && run.status !== 'completed')) {
        for (const [model, reason] of wholeBakeReasons(await allJobs(run.id, token, fetcher)))
          if (requested.includes(model) && !aside.some(row => row.model === model)) aside.push({model, runId: run.id, ...reason});
      }
    }
  } catch {
    return {models: requested, aside: [], text: '## Component bake plan\n\nWhole-bake publishers could not be listed (Actions API); publishing every requested model.\n'};
  }
  const models = requested.filter(model => !aside.some(row => row.model === model));
  if (!aside.length) return {models, aside, text: ''};
  return {models, aside, text: ['## Component bake plan', '',
    ...aside.map(row => `- ${row.model}: stood aside. Whole-bake run ${row.runId} job "${row.job}" is ${row.status}; ${row.why} ${lockName(row.model)}, and queuing here would cancel it. Component publishes for ${row.model} pause until that publisher has the lock; the previous component stays served.`),
    models.length ? `\nPublishing: ${models.join(', ')}.` : '\nNo model is published by this run.', ''].join('\n')};
}

// catalog-bake.yml model job: the stand-aside step succeeded and the production bake step was skipped.
export const STAND_ASIDE_STEP = 'Stand aside when production already serves the newest upstream run';
export const PRODUCTION_BAKE_STEP = 'Bake, validate, upload, and CAS-promote one production model';
export function stoodAsideOnServedRun(job) {
  const step = name => (job?.steps ?? []).find(row => row?.name === name);
  return job?.conclusion === 'success' && step(STAND_ASIDE_STEP)?.conclusion === 'success' && step(PRODUCTION_BAKE_STEP)?.conclusion === 'skipped';
}

export function componentMarkdown({jobs, target, event, holders, now, stoodAside = []}) {
  const lines = [`## component bake summary (target: ${target.replace(/[^a-z]/g, '')})`, '',
    `Trigger: ${event.replace(/[^a-z_]/g, '')}. Ages are measured when this summary ran (${new Date(now).toISOString()}).`, '',
    '| Model | Outcome | Detail |', '| --- | --- | --- |'];
  const ours = (jobs ?? []).filter(job => /^model \(/.test(job.name));
  for (const job of ours) {
    const model = holderJobName(job.name);
    const conclusion = result(job.conclusion);
    if (stoodAsideOnServedRun(job)) {
      lines.push(`| ${model} | unchanged | stood aside: production already serves the newest upstream run; nothing collected or uploaded (job summary has the run) |`);
      continue;
    }
    const outcome = conclusion === 'success' ? 'refreshed' : conclusion === 'cancelled' ? 'CANCELLED' : conclusion === 'skipped' ? 'skipped' : conclusion.toUpperCase();
    const detail = conclusion === 'success' ? `published ${ago(minutesSince(job.completed_at, now))}`
      : conclusion === 'cancelled' ? `never ran: superseded while queued for lock weatherx-component-${target}-${model}; previous component kept`
        : 'previous component kept';
    lines.push(`| ${model} | ${outcome} | ${detail} |`);
  }
  for (const row of stoodAside) if (MODELS.includes(row?.model))
    lines.push(`| ${row.model} | stood aside | not queued: whole-bake run ${String(row.runId).replace(/[^0-9]/g, '')} job "${String(row.job).replace(/[^a-z0-9 ()/-]/g, '')}" would have been cancelled; previous component kept |`);
  if (!ours.length && stoodAside.length) { /* every requested model is listed above */ }
  else if (!ours.length && (jobs ?? []).some(job => job.name === 'model' && job.conclusion === 'skipped'))
    lines.push('| (none) | skipped | no model job ran; see this run\'s plan job (stood aside for a queued whole-bake publisher) |');
  else if (!ours.length) lines.push('| (none) | unknown | job list unavailable |');
  const stuck = (holders ?? []).filter(holder => holder.stuck);
  lines.push('', '### Writer locks');
  if (holders === null) lines.push('Lock holders could not be listed (Actions API unavailable).');
  else if (!holders.length) lines.push('No other run currently holds or waits on a component writer lock.');
  else for (const holder of holders) lines.push(`- ${holder.lock}: run ${holder.runId} (${holder.workflow}) job "${holder.job}" is ${holder.status}${holder.status === 'waiting' ? ' at the environment gate' : ''} since ${ago(holder.minutes)}${holder.gateUnknown ? ' (gate status not found; measured from job start)' : ''}` +
    (holder.stuck ? ' — STUCK at the production environment gate; it holds the lock and every later run for this model is cancelled while queued. The owner must cancel that run.' : ''));
  return {text: [...lines, ''].join('\n'), stuck};
}

export async function main(argv, env = process.env, now = Date.now(), fetcher = fetch) {
  const kind = argv[0];
  const needs = JSON.parse(env.NEEDS_JSON || '{}');
  const jobs = await runJobs({runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, token: env.GH_TOKEN, fetcher});
  if (kind === 'bake') {
    const text = bakeMarkdown({needs, jobs, now, event: env.GITHUB_EVENT_NAME ?? '',
      inputs: {model: env.INPUT_MODEL ?? '', recoveryRunId: env.INPUT_RECOVERY_RUN_ID ?? '', wind100Only: env.INPUT_STAGING_WIND100_ONLY ?? ''}});
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    console.log(text);
    return 0;
  }
  if (kind === 'component') {
    // Staging-target bakes hold staging locks; production lock reporting does not apply to them.
    const holders = env.CATALOG_TARGET === 'production'
      ? await lockHolders({runId: env.GITHUB_RUN_ID, token: env.GH_TOKEN, fetcher, now}) : [];
    let stoodAside = [];
    try { stoodAside = JSON.parse(env.STOOD_ASIDE || '[]'); } catch { stoodAside = []; }
    const {text, stuck} = componentMarkdown({jobs: jobs?.filter(job => job.name !== env.SUMMARY_JOB_NAME && job.name !== 'plan'),
      target: env.CATALOG_TARGET ?? '', event: env.GITHUB_EVENT_NAME ?? '', holders, now, stoodAside: Array.isArray(stoodAside) ? stoodAside : []});
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    console.log(text);
    return stuck.length ? 1 : 0;
  }
  if (kind === 'observation-plan') {
    let event = null;
    try { event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : null; } catch { event = null; }
    const plan = await observationPlan({env, event, token: env.GH_TOKEN, fetcher, now});
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run=${plan.run}\n`);
    if (env.GITHUB_STEP_SUMMARY && plan.text) appendFileSync(env.GITHUB_STEP_SUMMARY, plan.text);
    console.log(plan.text || 'observation refresh planned');
    return plan.code;
  }
  if (kind === 'component-plan') {
    const plan = await componentPlan({env, token: env.GH_TOKEN, fetcher});
    if (env.GITHUB_OUTPUT && plan.models) appendFileSync(env.GITHUB_OUTPUT, `models=${JSON.stringify(plan.models)}\n`);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `stood_aside=${JSON.stringify(plan.aside.map(({model, runId, job}) => ({model, runId, job})))}\n`);
    if (env.GITHUB_STEP_SUMMARY && plan.text) appendFileSync(env.GITHUB_STEP_SUMMARY, plan.text);
    console.log(plan.text || `component bake planned: ${JSON.stringify(plan.models)}`);
    return 0;
  }
  throw new Error('usage: workflow-run-summary.mjs bake|component|observation-plan|component-plan');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
