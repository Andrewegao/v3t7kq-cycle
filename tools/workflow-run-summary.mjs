#!/usr/bin/env node
// Run summary for the data workflows: what this run refreshed, skipped or failed, and how long ago
// each refreshed part finished. It reads `needs` results and this repository's public Actions
// metadata. It never publishes, dispatches or approves anything. Its only write is the stuck-lock
// reaper below, run from the secret-free plan jobs: it cancels a writer-lock holder orphaned at an
// environment gate under the narrow rules documented at reapStuckHolders.
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
// A write (cancel or force-cancel). Returns the status instead of throwing: 409 means the run is
// already completing, and the caller re-reads the run either way.
async function githubPost(path, token, fetcher) {
  const response = await fetcher(`${API}${path}`, {method: 'POST', headers: {accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28'}, signal: AbortSignal.timeout(15000)});
  await response.body?.cancel?.().catch(() => {});
  return response.status;
}
const defaultSleep = ms => new Promise(done => setTimeout(done, ms));
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
  // bake.yml `publish-<model> / publisher` and resume-model-publication.yml `resume (<model>) / publisher`.
  const publisher = /^(?:publish-([a-z-]+)|resume \(([a-z-]+)\)) \/ publisher$/.exec(name);
  const model = publisher?.[1] ?? publisher?.[2];
  return model && MODELS.includes(model) ? model : null;
}
export const lockName = model => model === 'observations' ? OBSERVATION_LOCK : `weatherx-component-production-${model}`;
// bake.yml's whole-maintenance `bake` job holds weatherx-data-maintenance at the same production gate
// and reaches it together with the last publishers (run 39136712828: bake and publish-gfs both started
// 15:08:47Z). It is not a component lock holder (nothing above lists or stands aside for it), but when a
// whole bake is judged for cancel it is a member like a publisher, under exactly the same rules.
export const MAINTENANCE_LOCK = 'weatherx-data-maintenance';
export function runMember(name, workflow) {
  const model = holderJobName(name, workflow);
  if (model) return {model, lock: lockName(model)};
  return workflow === 'bake.yml' && name === 'bake' ? {model: 'maintenance', lock: MAINTENANCE_LOCK} : null;
}

// A job that queued behind its lock reaches the environment gate only when the lock frees, so its
// age at the gate is measured from that deployment's `waiting` status, never from job.started_at
// (which includes the normal time spent queued behind the lock). Actions creates the job's
// deployment (task `deploy`, ref = the run's branch, sha = the run's head) when the job starts, so the
// lookup pages that environment's deployments newest first until it passes the job's start, and
// matches the deployment by a status whose URL names this job. Every production run shares one SHA
// for as long as main does not move, so the newest 100 alone (the old lookup) lost a holder within a
// day (2026-10-12: about 150 production deployments a day; the stuck HRRR job's deployment was on
// page 12 by 10-18). Returns {since, environment, deploymentId} only when the job's newest status is
// `waiting`; otherwise null (unknown), and an unknown gate is never a reason to cancel.
export const GATE_PAGES = 20;
// Every deployment page or status read counts against one budget per plan invocation (one process),
// so a burst of waiting holders cannot spend the GITHUB_TOKEN's 1,000 requests an hour on lookups.
// A spent budget leaves the gate unknown, which never cancels anything.
export const GATE_CALL_BUDGET = 60;
export const gateBudget = (calls = GATE_CALL_BUDGET) => ({calls, exhausted: false});
const GATE_MATCH_MS = 120000;
export async function gateWaitingSince({run, job, token, fetcher, environment = 'production', pages = GATE_PAGES, budget = gateBudget()}) {
  const started = Date.parse(job.started_at ?? '');
  if (!/^[a-f0-9]{40}$/.test(run.head_sha ?? '') || !Number.isFinite(started) || !/^[1-9]\d{0,19}$/.test(String(job.id ?? ''))) return null;
  const query = new URLSearchParams({environment, task: 'deploy', sha: run.head_sha});
  if (/^[A-Za-z0-9._/-]{1,200}$/.test(run.head_branch ?? '')) query.set('ref', run.head_branch);
  const ownJob = row => [row.target_url, row.log_url].some(url => String(url ?? '').endsWith(`/job/${job.id}`));
  // lastExhausted tells the caller whether THIS lookup ran out (budget.exhausted stays set once spent).
  budget.lastExhausted = false;
  const spend = () => { if (budget.calls <= 0) { budget.exhausted = budget.lastExhausted = true; return false; } budget.calls -= 1; return true; };
  for (let page = 1; page <= pages; page += 1) {
    if (!spend()) return null;
    const body = await github(`/deployments?${query}&per_page=100&page=${page}`, token, fetcher);
    const rows = Array.isArray(body) ? body : [];
    for (const deployment of rows.filter(row => Math.abs(Date.parse(row.created_at ?? '') - started) <= GATE_MATCH_MS)) {
      if (!spend()) return null;
      const statuses = await github(`/deployments/${deployment.id}/statuses?per_page=30`, token, fetcher);
      const own = (Array.isArray(statuses) ? statuses : []).filter(ownJob)
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
      if (!own.length) continue;
      return own[0].state === 'waiting' && Number.isFinite(Date.parse(own[0].created_at ?? ''))
        ? {since: own[0].created_at, environment: String(deployment.environment ?? environment), deploymentId: deployment.id} : null;
    }
    // Newest first: once a page reaches deployments older than the job's start, no later page can match.
    const oldest = Date.parse(rows.at(-1)?.created_at ?? '');
    if (rows.length < 100 || !(oldest >= started - GATE_MATCH_MS)) return null;
  }
  return null;
}

// Jobs elsewhere in this repository that hold, or wait at the production gate holding, a writer lock.
// gatePages: how deep the gate lookup may page (the report-only summary uses 1); budget: shared with the reaper.
export async function lockHolders({runId, token, fetcher = fetch, now, only = null, gatePages = GATE_PAGES, budget = gateBudget()}) {
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
          const gate = job.status === 'waiting' ? await gateWaitingSince({run, job, token, fetcher, pages: gatePages, budget}) : null;
          // A holder whose gate status is not found is reported from its own start (an upper bound), so a
          // waiting holder is never reported as not stuck merely because its deployment is unknown. That
          // estimate is for reporting only: the reaper acts on a known gate time alone.
          const gateUnknown = job.status === 'waiting' && !gate;
          const since = job.status === 'waiting' ? gate?.since ?? job.started_at ?? job.created_at ?? run.run_started_at : job.started_at;
          const minutes = minutesSince(since, now);
          holders.push({model, lock: lockName(model), runId: run.id, workflow, job: job.name, jobId: job.id, status: job.status, minutes, gateUnknown,
            gateLookup: job.status !== 'waiting' ? 'none' : gate ? 'found' : budget.lastExhausted ? 'budget' : 'not-found',
            gateSince: gate?.since ?? null, environment: gate?.environment ?? null,
            stuck: job.status === 'waiting' && minutes !== null && minutes > STUCK_WAITING_MINUTES});
        }
      }
    }
  } catch { return null; }
  return holders;
}

// --- stuck writer-lock reaper -----------------------------------------------------------------
// A job that holds a concurrency group and is left `waiting` at an environment gate keeps that group
// for as long as GitHub leaves it there: timeout-minutes does not tick during an environment wait, so
// after the 2026-10-12 Actions incident catalog-bake run 38263168806 (HRRR) and observation-refresh
// run 38283354381 held their locks for six days. The secret-free plan jobs (component-plan,
// observation-plan, observation-chain) call this before they queue on the same lock.
//
// A run is cancelled only when it is nothing but orphaned gate waits: the run is not in_progress or
// completed, its job list is complete, and EVERY unfinished job in it is a writer-lock holder that
// passes every rule (waiting at the gate, gate time known and over 30 minutes, no started step, and an
// environment whose protection rules are only a branch policy). That holds regardless of which models
// the calling plan requested, so a whole bake with several stuck publishers is freed as one run, and
// one unfinished job that fails any rule keeps the whole run. Just before the cancel the run and its
// jobs are read again and the cancel is skipped if anything changed. Force-cancel follows only an
// accepted plain cancel (202, or 409: already cancelling) whose run is still listed, with every job
// still waiting, after a bounded re-check. The caller then takes the freed lock itself, or (observation
// chain) dispatches the lane again.
export const CANCEL_CHECKS = 4;
export const CANCEL_CHECK_MS = 5000;
export const MAX_REAPS = 5;
const STARTED_STEP = new Set(['in_progress', 'completed']);
const CANCEL_ACCEPTED = new Set([202, 409]);

const BUDGET_REASON = `its gate waiting time is unknown (gate lookup budget exhausted: this plan run's ${GATE_CALL_BUDGET} deployment reads were spent), and a job is never cancelled on its start time`;
// (a) the time at the gate must be known from the deployment's own `waiting` status. Needs no API read.
export function gateRefusal(holder, now) {
  if (holder.status !== 'waiting') return 'it is not waiting at an environment gate';
  if (holder.gateLookup === 'budget') return BUDGET_REASON;
  if (holder.gateUnknown || !holder.gateSince || !holder.environment)
    return 'its gate waiting time is unknown (no `waiting` deployment status found for the job), and a job is never cancelled on its start time';
  const minutes = minutesSince(holder.gateSince, now);
  if (minutes === null || minutes <= STUCK_WAITING_MINUTES) return `it has waited at the gate for ${minutes ?? 'an unknown number of'} min, not more than ${STUCK_WAITING_MINUTES}`;
  return null;
}
// (c) only an environment whose every protection rule is a branch policy: required reviewers, a wait
// timer or any rule type this code does not know is a bounded or deliberate wait, never an orphan.
export function environmentRefusal(environment, name) {
  if (!environment || environment.name !== name || !Array.isArray(environment.protection_rules)) return `environment ${name} could not be read`;
  const other = environment.protection_rules.find(rule => rule?.type !== 'branch_policy');
  if (other) return other.type === 'required_reviewers' ? `environment ${name} has required reviewers`
    : `environment ${name} has a ${String(other?.type ?? 'unknown').replace(/[^a-z_]/g, '') || 'unknown'} protection rule (only branch_policy is reapable)`;
  return null;
}
// (b) the run itself: this repository's writer workflow on main, neither completed nor in_progress.
function runRefusal(run, workflow) {
  if (!run || run.path !== `.github/workflows/${workflow}` || !HOLDER_WORKFLOWS.includes(run.path) || run.head_branch !== 'main')
    return 'its run could not be re-read as this repository\'s writer workflow on main';
  if (run.status === 'completed') return 'its run has already completed';
  if (run.status === 'in_progress') return 'its run is in_progress';
  return null;
}
// One job of a run that is a candidate for cancel. Returns null when it is a reapable orphaned gate wait.
function jobRefusal(job, holder, now, model = holder?.model) {
  if (!holder && job.status === 'in_progress') return `job "${job.name}" of that run is in_progress`;
  if (!holder && !model) return `job "${job.name}" of that run is ${job.status} and is not a writer-lock holder`;
  if (job.status === 'in_progress') return `job "${job.name}" of that run is in_progress`;
  if (job.status !== 'waiting') return `job "${job.name}" of that run is ${job.status}, not waiting at a gate`;
  if (!holder) return `job "${job.name}" of that run is waiting with no known gate`;
  if ((job.steps ?? []).some(step => STARTED_STEP.has(step?.status))) return `job "${job.name}" has a started step`;
  return gateRefusal(holder, now);
}
// For a single holder with fresh reads (used by tests and the per-run check below).
export function reapRefusal({holder, run, jobs, environment, now}) {
  const gate = gateRefusal(holder, now);
  if (gate) return gate;
  const ran = runRefusal(run, holder.workflow);
  if (ran) return ran;
  const own = (jobs ?? []).find(job => String(job.id) === String(holder.jobId));
  if (!own || own.status !== 'waiting') return 'the job is no longer waiting';
  const job = jobRefusal(own, holder, now);
  if (job) return job === `job "${own.name}" has a started step` ? 'the job has a started step' : job;
  return environmentRefusal(environment, holder.environment);
}
const snapshot = (run, jobs) => JSON.stringify([run?.status, run?.run_attempt, run?.updated_at,
  (jobs ?? []).map(job => [job.id, job.status, job.conclusion, (job.steps ?? []).map(step => step?.status)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);

const describe = holder => `run ${holder.runId} (${holder.workflow}) job "${holder.job}"`;
// holders: lockHolders rows (any subset of models). Each run with a stuck holder is evaluated as a whole;
// holders of other models in that run are found and checked here. Returns {lines, results: [{runId,
// outcome, holders}], refused: [{holder, reason}]}; outcome is cancelled, force-cancelled, left (run
// changed or cancel not accepted, so no force-cancel) or still-active. Never throws.
export async function reapStuckHolders({holders, token, fetcher = fetch, now, sleep = defaultSleep, budget = gateBudget()}) {
  const refused = [], candidates = [];
  const environments = new Map();
  const readEnvironment = async name => {
    if (!environments.has(name)) environments.set(name, await github(`/environments/${encodeURIComponent(name)}`, token, fetcher).catch(() => null));
    return environments.get(name);
  };
  const listed = holders ?? [];
  const runIds = [...new Set(listed.filter(row => row.stuck).map(row => String(row.runId)))];
  for (const runId of runIds) {
    const stuck = listed.filter(row => row.stuck && String(row.runId) === runId);
    const refuse = (rows, reason) => { for (const holder of rows) refused.push({holder, reason}); };
    const cheap = stuck.map(holder => gateRefusal(holder, now)).find(Boolean);
    if (cheap) { refuse(stuck, cheap); continue; }
    if (candidates.length >= MAX_REAPS) { refuse(stuck, `this run already cancels ${MAX_REAPS} runs; the next plan run takes the rest`); continue; }
    let run, jobs;
    try { run = await github(`/actions/runs/${runId}`, token, fetcher); jobs = await allJobs(runId, token, fetcher, {strict: true}); }
    catch { refuse(stuck, 'its run or its complete job list could not be read (Actions API)'); continue; }
    const workflow = stuck[0].workflow;
    let reason = runRefusal(run, workflow);
    const rows = [];
    for (const job of reason ? [] : jobs.filter(item => item.status !== 'completed')) {
      const member = runMember(job.name, workflow);
      const model = member?.model;
      let holder = listed.find(row => String(row.jobId) === String(job.id));
      if (!holder && model && job.status === 'waiting') {
        // A member the calling plan did not list (another model's publisher, or the whole bake's
        // maintenance job): look up its own gate under the same budget.
        const gate = await gateWaitingSince({run, job, token, fetcher, budget}).catch(() => null);
        const minutes = minutesSince(gate?.since, now);
        holder = {model, lock: member.lock, runId: run.id, workflow, job: job.name, jobId: job.id, status: job.status,
          minutes, gateUnknown: !gate, gateLookup: gate ? 'found' : budget.lastExhausted ? 'budget' : 'not-found',
          gateSince: gate?.since ?? null, environment: gate?.environment ?? null, stuck: minutes !== null && minutes > STUCK_WAITING_MINUTES};
      } else if (holder && !model) holder = null;
      reason = jobRefusal(job, holder, now, model);
      // Name the other member whose own gate check failed (for example the maintenance job).
      if (reason && /^it[s ]/.test(reason) && !stuck.some(row => String(row.jobId) === String(job.id))) reason = `job "${job.name}" of that run: ${reason}`;
      if (reason) break;
      reason = environmentRefusal(await readEnvironment(holder.environment), holder.environment);
      if (reason) break;
      rows.push(holder);
    }
    if (!reason && !rows.length) reason = 'its run has no unfinished job left';
    if (reason) { refuse(stuck, reason); continue; }
    candidates.push({runId, holders: rows, outcome: 'still-active', seen: snapshot(run, jobs)});
  }
  const runState = async row => { try { return await github(`/actions/runs/${row.runId}`, token, fetcher); } catch { return null; } };
  const settle = async rows => {
    for (let check = 0; check < CANCEL_CHECKS && rows.some(row => row.outcome === 'still-active'); check += 1) {
      await sleep(CANCEL_CHECK_MS);
      for (const row of rows.filter(item => item.outcome === 'still-active'))
        if ((await runState(row))?.status === 'completed') row.outcome = row.forced ? 'force-cancelled' : 'cancelled';
    }
  };
  for (const row of candidates) {
    // Re-read immediately before the write; anything changed since the checks means no cancel this time.
    let fresh = null;
    try { fresh = snapshot(await github(`/actions/runs/${row.runId}`, token, fetcher), await allJobs(row.runId, token, fetcher, {strict: true})); } catch { fresh = null; }
    if (fresh !== row.seen) { row.outcome = 'changed'; continue; }
    row.cancel = await githubPost(`/actions/runs/${row.runId}/cancel`, token, fetcher).catch(() => 0);
    if (!CANCEL_ACCEPTED.has(row.cancel)) row.outcome = 'refused';
  }
  await settle(candidates);
  for (const row of candidates.filter(item => item.outcome === 'still-active')) {
    // (d) force-cancel only after an accepted plain cancel, and only a run still listed with every one of
    // its unfinished jobs still a waiting, unstarted holder from the checked set.
    let jobs = null;
    try { jobs = await allJobs(row.runId, token, fetcher, {strict: true}); } catch { jobs = null; }
    const run = await runState(row);
    if (run?.status === 'completed') { row.outcome = 'cancelled'; continue; }
    const ids = row.holders.map(holder => String(holder.jobId));
    const stillWaiting = run && run.status !== 'in_progress' && jobs && jobs.filter(job => job.status !== 'completed')
      .every(job => ids.includes(String(job.id)) && job.status === 'waiting' && !(job.steps ?? []).some(step => STARTED_STEP.has(step?.status)));
    if (!stillWaiting) { row.outcome = 'left'; continue; }
    row.forced = true;
    row.force = await githubPost(`/actions/runs/${row.runId}/force-cancel`, token, fetcher).catch(() => 0);
  }
  await settle(candidates.filter(row => row.forced));
  const window = CANCEL_CHECKS * CANCEL_CHECK_MS / 1000;
  const lines = [];
  for (const row of candidates) for (const holder of row.holders) {
    const waited = `has been waiting at the ${holder.environment} environment gate since ${ago(minutesSince(holder.gateSince, now))} (deployment status \`waiting\` at ${holder.gateSince}), holding ${holder.lock}`;
    const checked = 'only a branch-policy environment, no started step, every unfinished job of its run an orphaned gate wait';
    if (row.outcome === 'cancelled') lines.push(`- CANCELLED ${describe(holder)}: it ${waited}; ${checked}. A normal cancel completed; the lock is free.`);
    else if (row.outcome === 'force-cancelled') lines.push(`- FORCE-CANCELLED ${describe(holder)}: it ${waited}; ${checked}. A normal cancel was accepted but did not complete within ${window} s, so the run was force-cancelled and completed; the lock is free.`);
    else if (row.outcome === 'changed') lines.push(`- NOT CANCELLED ${describe(holder)}: it ${waited}, but its run or jobs changed (or could not be re-read) between the checks and the cancel, so nothing was cancelled. The next plan run checks again.`);
    else if (row.outcome === 'refused') lines.push(`- NOT CANCELLED ${describe(holder)}: it ${waited}. The cancel request was not accepted (HTTP ${row.cancel || 'none: request failed'}), so it was not force-cancelled either. The next plan run checks again; if this repeats, the owner must cancel that run.`);
    else if (row.outcome === 'left') lines.push(`- NOT FORCE-CANCELLED ${describe(holder)}: it ${waited}. A normal cancel was accepted (HTTP ${row.cancel}), but after ${window} s the run had changed (a job started, or it could not be re-read), so it was not force-cancelled. The next plan run checks again.`);
    else lines.push(`- STILL LISTED ${describe(holder)}: it ${waited}. Cancel (HTTP ${row.cancel}) and force-cancel (HTTP ${row.force}) were requested, but the run was not completed after ${window} s each; it may still hold the lock. The next plan run checks again.`);
  }
  // A spent lookup budget changes nothing, but it is named so a run left waiting for that reason is visible.
  for (const runId of [...new Set(refused.filter(row => row.reason.endsWith(BUDGET_REASON)).map(row => String(row.holder.runId)))]) {
    const {holder} = refused.find(row => String(row.holder.runId) === runId);
    lines.push(`- LOOKUP BUDGET EXHAUSTED: run ${runId} (${holder.workflow}) was not cancelled: the gate lookup budget of ${GATE_CALL_BUDGET} deployment reads for this plan run was spent before its gate time was known. Nothing was changed; the next plan run checks again.`);
  }
  for (const {holder, reason} of refused)
    lines.push(`- NOT CANCELLED ${describe(holder)}: it has been ${holder.status} at the environment gate since ${ago(holder.minutes)}${holder.gateUnknown ? ' (gate status not found; measured from job start)' : ''}, holding ${holder.lock}; not cancelled automatically because ${reason}. The owner must cancel that run.`);
  return {lines, refused, results: candidates.map(({runId, outcome, holders: rows}) => ({runId, outcome, holders: rows}))};
}
export const lockFreed = result => ['cancelled', 'force-cancelled'].includes(result.outcome);

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
// The observation lane's secret-free plan: refuse an unconfirmed manual dispatch, cancel a holder of
// the observation lock orphaned at the environment gate (reapStuckHolders) and stay red when a stuck
// holder cannot be cancelled, and stand aside while a manual recovery is queued or running so the
// schedule never cancels it (GitHub keeps one pending job per concurrency group). A verified
// component-bake chain dispatch is planned exactly like the schedule.
export async function observationPlan({env, event, token, fetcher = fetch, now, sleep = defaultSleep}) {
  const lines = [];
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && event?.inputs?.caller === CHAIN_CALLER) {
    if (!await chainCallerVerified({runId: event?.inputs?.chain_run_id, token, fetcher, now}))
      return {run: false, code: 1, text: `## Observation refresh: REFUSED\n\nThe \`${CHAIN_CALLER}\` caller must name an observation-chain.yml run on main from the last ${CHAIN_MAX_AGE_MINUTES} minutes. Nothing was refreshed.\n`};
  } else if (env.GITHUB_EVENT_NAME === 'workflow_dispatch' && event?.inputs?.confirmation !== CONFIRMATION)
    return {run: false, code: 1, text: `## Observation refresh: REFUSED\n\nA manual dispatch must enter \`${CONFIRMATION}\`. Nothing was refreshed.\n`};
  const budget = gateBudget();
  const holders = await lockHolders({runId: env.GITHUB_RUN_ID, token, fetcher, now, only: ['observations'], budget});
  const stuck = (holders ?? []).filter(holder => holder.stuck);
  if (stuck.length) {
    const reap = await reapStuckHolders({holders, token, fetcher, now, sleep, budget});
    lines.push(...reap.lines);
    if (reap.refused.length || !reap.results.every(lockFreed))
      return {run: false, code: 1, text: ['## Observation refresh: BLOCKED (stuck writer lock)', '', ...lines, ''].join('\n')};
  }
  const reaped = text => lines.length ? `${text || '## Observation refresh plan\n'}\n### Stuck writer lock\n\n${lines.join('\n')}\n\nThis run proceeds and takes the freed ${OBSERVATION_LOCK}.\n` : text;
  const planned = result => ({...result, text: reaped(result.text)});
  let recovery = null;
  try {
    for (const status of ACTIVE_STATUSES) {
      const runs = (await github(`/actions/workflows/five-feed-recovery.yml/runs?status=${status}&per_page=10`, token, fetcher)).workflow_runs ?? [];
      if (runs.length) { recovery = {id: runs[0].id, status}; break; }
    }
  } catch { recovery = undefined; }
  if (env.ENABLED !== 'true')
    return planned({run: false, code: 0, text: '## Observation refresh: SKIPPED\n\nNothing was refreshed. The repository variable OBSERVATION_REFRESH_ENABLED is not `true`; METAR, SYNOP, buoys, OpenAQ and fires keep their previously published data.\n'});
  if (recovery) return planned({run: false, code: 0, text: `## Observation refresh: SKIPPED\n\nManual recovery run ${recovery.id} is ${recovery.status}; this run stands aside so it cannot cancel that recovery. Nothing was refreshed by this run.\n`});
  // The cron is the fallback behind the component-bake chain: it stands aside for any other lane run
  // that is still active or started within the chain's 25-minute gap.
  let overlap = null;
  if (env.GITHUB_EVENT_NAME === 'schedule') {
    try { overlap = await otherLaneRun({runId: env.GITHUB_RUN_ID, token, fetcher, now}); } catch { overlap = undefined; }
    if (overlap) return planned({run: false, code: 0, text: `## Observation refresh: SKIPPED\n\nLane run ${overlap.id} ${overlap.why}; this scheduled run stands aside. Nothing was refreshed by this run.\n`});
  }
  const notes = [holders === null || recovery === undefined || overlap === undefined ? 'Lock, recovery or overlap checks were unavailable (Actions API); refreshing anyway.' : null].filter(Boolean);
  return planned({run: true, code: 0, text: notes.length ? `## Observation refresh plan\n\n${notes.join('\n')}\n` : ''});
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
// strict (the reaper, which decides on the whole run): the list must declare total_count, and a list
// shorter than it is unknown, never a complete run. The stand-aside listing keeps its old behaviour.
async function allJobs(runId, token, fetcher, {strict = false} = {}) {
  const jobs = [];
  for (let page = 1; page <= JOB_PAGES; page += 1) {
    const body = await github(`/actions/runs/${runId}/jobs?per_page=100&page=${page}`, token, fetcher);
    const rows = body.jobs ?? [];
    jobs.push(...rows);
    if (strict && !Number.isSafeInteger(body.total_count)) throw new Error('job list without total_count');
    if (!(body.total_count > jobs.length)) return jobs;
    if (!rows.length) { if (strict) throw new Error('job list shorter than its total_count'); return jobs; }
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
export async function componentPlan({env, token, fetcher = fetch, now = Date.now(), sleep = defaultSleep}) {
  let requested = null;
  try { requested = JSON.parse(env.REQUESTED_MODELS ?? ''); } catch { requested = null; }
  if (!Array.isArray(requested) || !requested.length || !requested.every(model => MODELS.includes(model)))
    return {models: null, aside: [], text: '## Component bake plan\n\nRequested model list unreadable; the model job falls back to its own matrix.\n'};
  if (env.CATALOG_TARGET !== 'production') return {models: requested, aside: [], text: ''};
  // First free a requested model's lock from a holder orphaned at the environment gate, so this run's
  // model job can take it. A cancelled whole-bake publisher is then no longer listed below, so this run
  // publishes that model in its place. Fails open: an unreadable API cancels nothing.
  let reapLines = [];
  if (token) {
    const budget = gateBudget();
    const holders = await lockHolders({runId: env.GITHUB_RUN_ID, token, fetcher, now, only: requested, budget});
    if (holders?.some(holder => holder.stuck)) reapLines = (await reapStuckHolders({holders, token, fetcher, now, sleep, budget})).lines;
  }
  const reaped = text => reapLines.length ? `${text || '## Component bake plan\n'}\n### Stuck writer locks\n\n${reapLines.join('\n')}\n` : text;
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
    return {models: requested, aside: [], text: reaped('## Component bake plan\n\nWhole-bake publishers could not be listed (Actions API); publishing every requested model.\n')};
  }
  const models = requested.filter(model => !aside.some(row => row.model === model));
  if (!aside.length) return {models, aside, text: reaped('')};
  return {models, aside, text: reaped(['## Component bake plan', '',
    ...aside.map(row => `- ${row.model}: stood aside. Whole-bake run ${row.runId} job "${row.job}" is ${row.status}; ${row.why} ${lockName(row.model)}, and queuing here would cancel it. Component publishes for ${row.model} pause until that publisher has the lock; the previous component stays served.`),
    models.length ? `\nPublishing: ${models.join(', ')}.` : '\nNo model is published by this run.', ''].join('\n'))};
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
    (holder.stuck ? ' — STUCK at the production environment gate; it holds the lock and every later run for this model is cancelled while queued. The next component plan cancels it when its gate time is known and the environment has no required reviewers (see that plan job); otherwise the owner must cancel that run.' : ''));
  return {text: [...lines, ''].join('\n'), stuck};
}

export async function main(argv, env = process.env, now = Date.now(), fetcher = fetch, sleep = defaultSleep) {
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
    // Staging-target bakes hold staging locks; production lock reporting does not apply to them. The
    // summary only reports (the plan job reaps), so its gate lookup reads the newest deployment page only.
    const holders = env.CATALOG_TARGET === 'production'
      ? await lockHolders({runId: env.GITHUB_RUN_ID, token: env.GH_TOKEN, fetcher, now, gatePages: 1}) : [];
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
    const plan = await observationPlan({env, event, token: env.GH_TOKEN, fetcher, now, sleep});
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `run=${plan.run}\n`);
    if (env.GITHUB_STEP_SUMMARY && plan.text) appendFileSync(env.GITHUB_STEP_SUMMARY, plan.text);
    console.log(plan.text || 'observation refresh planned');
    return plan.code;
  }
  if (kind === 'component-plan') {
    const plan = await componentPlan({env, token: env.GH_TOKEN, fetcher, now, sleep});
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
