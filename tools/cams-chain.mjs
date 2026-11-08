// A delivery bridge for the existing CAMS nominal slots, never a new data publisher.
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
export const API = `https://api.github.com/repos/${REPOSITORY}`;
export const POINTER = 'https://weatherx.org/data-atmos/energy/cams/current.json';
export const LANE = 'cams-ingest.yml';
export const CHAIN = 'cams-chain.yml';
export const STEP = 'Dispatch the planned CAMS slot once';
export const NO_POST_STEP = 'Confirm no CAMS dispatch was attempted';
export const ACTIVE = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
const SHA = /^[a-f0-9]{40}$/, ID = /^[1-9]\d{0,19}$/, ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const initISO = run => `${run.slice(0, 4)}-${run.slice(4, 6)}-${run.slice(6, 8)}T${run.slice(8)}:00:00Z`;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const requireState = (ok, code) => assert.ok(ok, code);

export function dueSlot(now) {
  requireState(Number.isFinite(now), 'invalid-clock');
  const midnight = Math.floor(now / 86_400_000) * 86_400_000;
  const starts = [-1, 0].flatMap(day => [0, 10, 12, 22].map(hour => midnight + day * 86_400_000 + (hour * 60 + 40) * 60_000));
  const start = Math.max(...starts.filter(value => value <= now));
  // Exactly fetch_cams.py newest_run's existing ten-hour publication lag, evaluated at the slot.
  const ready = new Date(start - 10 * 3_600_000);
  ready.setUTCHours(ready.getUTCHours() < 12 ? 0 : 12, 0, 0, 0);
  const expectedInit = ready.toISOString().replace('.000Z', 'Z');
  return {start, startISO: new Date(start).toISOString().replace('.000Z', 'Z'), expectedInit,
    run: expectedInit.replace(/[-:]/g, '').replace(/T(\d{2})0000Z$/, '$1')};
}

export function validatePointer(value, now) {
  requireState(value?.schema === 'weatherx.energy.pointer/1' && value.family === 'cams' && value.fixture !== true,
    'invalid-public-pointer');
  requireState(/^\d{8}(00|12)$/.test(value.run ?? '') && value.newest_init === initISO(value.run) &&
    ISO.test(value.newest_init) && new Date(timestamp(value.newest_init)).toISOString().replace('.000Z', 'Z') === value.newest_init &&
    timestamp(value.newest_init) <= now && ISO.test(value.baked_at ?? '') && timestamp(value.baked_at) <= now &&
    value.path === `${value.run}/clusters.json` && value.map === `${value.run}/dust-map.json` &&
    /^[a-f0-9]{64}$/.test(value.sha256 ?? '') && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= 4 * 1024 * 1024,
  'invalid-public-pointer');
  return value.newest_init;
}

export function trustedRun(run, {repositoryId, workflow, workflowId, main, event}) {
  return ID.test(String(run?.id ?? '')) && run.path === `.github/workflows/${workflow}` && run.workflow_id === workflowId &&
    run.head_branch === 'main' && run.head_sha === main && run.event === event &&
    String(run.repository?.id) === String(repositoryId) && String(run.head_repository?.id) === String(repositoryId);
}

export function eligibleAttempt(run, slot) {
  if (timestamp(run.created_at) < slot.start) return false;
  if (run.event === 'schedule') return true;
  if (run.event !== 'workflow_dispatch') return false;
  if (run.display_title === 'energy cams: dispatched (newest published run)') return true;
  const explicit = /^energy cams: dispatched \((\d{8}(?:00|12))\)$/.exec(run.display_title ?? '');
  return !!explicit && explicit[1] >= slot.run;
}

async function jsonResponse(response, maxBytes) {
  requireState(response.status === 200, 'read-http-refused');
  const encoding = (response.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
  requireState(['identity', 'gzip', 'br', 'deflate'].includes(encoding), 'unsupported-response-encoding');
  const length = response.headers.get('content-length');
  requireState(length === null || (/^\d+$/.test(length) && Number.isSafeInteger(Number(length)) &&
    (encoding !== 'identity' || Number(length) <= maxBytes)), 'response-too-large');
  requireState(response.body, 'missing-response-body');
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.byteLength; requireState(size <= maxBytes, 'response-too-large'); parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  // Fetch exposes decoded bytes but retains the encoded Content-Length. The streamed decoded
  // budget always applies; only identity bytes can be compared with that transport length.
  requireState(size > 0 && (encoding !== 'identity' || length === null || Number(length) === size), 'incomplete-response');
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(parts)));
}

export async function main(env = process.env, now = Date.now(), fetcher = fetch, clock = () => now) {
  const phase = env.CAMS_CHAIN_PHASE;
  requireState(phase === 'plan' || phase === 'dispatch', 'invalid-chain-phase');
  requireState(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/main' &&
    env.GITHUB_EVENT_NAME === 'workflow_run' && env.GITHUB_WORKFLOW_REF === `${REPOSITORY}/.github/workflows/${CHAIN}@refs/heads/main` &&
    env.GITHUB_RUN_ATTEMPT === '1' && ID.test(env.GITHUB_RUN_ID ?? '') && ID.test(env.TRIGGER_RUN_ID ?? '') &&
    ID.test(env.GITHUB_REPOSITORY_ID ?? '') && SHA.test(env.GITHUB_SHA ?? '') && env.GH_TOKEN, 'chain-authority-refused');
  const headers = {accept: 'application/vnd.github+json', authorization: `Bearer ${env.GH_TOKEN}`,
    'user-agent': 'weatherx-cams-chain', 'x-github-api-version': '2022-11-28'};
  const get = async path => jsonResponse(await fetcher(`${API}${path}`, {method: 'GET', headers,
    redirect: 'error', signal: AbortSignal.timeout(15_000)}), 1024 * 1024);
  async function list(path, key) {
    const rows = [], ids = new Set(); let total;
    for (let page = 1; page <= 100; page++) {
      const value = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      requireState(Number.isSafeInteger(value.total_count) && value.total_count >= 0 && value.total_count <= 10_000 &&
        Array.isArray(value[key]), 'incomplete-api-list');
      total ??= value.total_count; requireState(total === value.total_count, 'changed-api-list');
      for (const row of value[key]) {
        requireState(ID.test(String(row?.id ?? '')) && !ids.has(row.id), 'duplicate-api-row'); ids.add(row.id); rows.push(row);
      }
      requireState(rows.length <= total, 'incomplete-api-list');
      if (rows.length === total) return rows;
      requireState(value[key].length > 0, 'incomplete-api-list');
    }
    throw new Error('incomplete-api-list');
  }
  const slot = dueSlot(now);
  if (phase === 'dispatch' && (env.CAMS_EXPECTED_SLOT !== slot.startISO || env.CAMS_EXPECTED_RUN !== slot.run))
    return {dispatch: false, reason: 'nominal-window-changed', ...slot};
  const mainRef = await get('/git/ref/heads/main');
  requireState(mainRef.object?.sha === env.GITHUB_SHA, 'changed-main');
  const triggerWorkflow = await get('/actions/workflows/catalog-bake.yml');
  const chainWorkflow = await get(`/actions/workflows/${CHAIN}`);
  requireState(Number.isSafeInteger(triggerWorkflow.id) && triggerWorkflow.id > 0 &&
    Number.isSafeInteger(chainWorkflow.id) && chainWorkflow.id > 0 &&
    triggerWorkflow.path === '.github/workflows/catalog-bake.yml' && triggerWorkflow.state === 'active' &&
    chainWorkflow.path === `.github/workflows/${CHAIN}` && chainWorkflow.state === 'active', 'workflow-identity-refused');
  const trigger = await get(`/actions/runs/${env.TRIGGER_RUN_ID}`), self = await get(`/actions/runs/${env.GITHUB_RUN_ID}`);
  const authority = {repositoryId: env.GITHUB_REPOSITORY_ID, main: env.GITHUB_SHA};
  requireState(String(trigger.id) === env.TRIGGER_RUN_ID && String(self.id) === env.GITHUB_RUN_ID &&
    trigger.run_attempt === 1 && ['schedule', 'workflow_dispatch'].includes(trigger.event) && trustedRun(trigger, {...authority,
    workflow: 'catalog-bake.yml', workflowId: triggerWorkflow.id, event: trigger.event}) &&
    trustedRun(self, {...authority, workflow: CHAIN, workflowId: chainWorkflow.id, event: 'workflow_run'}) &&
    self.run_attempt === 1, 'trigger-authority-refused');
  requireState(Number.isFinite(timestamp(trigger.created_at)) && timestamp(trigger.created_at) <= now &&
    Number.isFinite(timestamp(self.created_at)) && timestamp(self.created_at) <= now, 'invalid-run-time');
  if (timestamp(trigger.created_at) < slot.start || timestamp(self.created_at) < slot.start)
    return {dispatch: false, reason: 'previous-nominal-window', ...slot};
  const publicPointer = async () => validatePointer(await jsonResponse(await fetcher(POINTER, {redirect: 'error',
    cache: 'no-store', credentials: 'omit', headers: {'Cache-Control': 'no-cache'}, signal: AbortSignal.timeout(20_000)}), 8192), clock());
  if (await publicPointer() >= slot.expectedInit) return {dispatch: false, reason: 'expected-init-already-served', ...slot};
  // All five statuses, across every page: an unknown/incomplete read never authorizes a dispatch.
  for (const status of ACTIVE) if ((await list(`/actions/workflows/${LANE}/runs?status=${status}&branch=main`, 'workflow_runs')).length)
    return {dispatch: false, reason: 'cams-active', ...slot};
  const since = encodeURIComponent(`>=${slot.startISO}`);
  const attempts = await list(`/actions/workflows/${LANE}/runs?branch=main&created=${since}`, 'workflow_runs');
  for (const run of attempts) {
    requireState(run.path === `.github/workflows/${LANE}` && run.head_branch === 'main' &&
      String(run.repository?.id) === env.GITHUB_REPOSITORY_ID && String(run.head_repository?.id) === env.GITHUB_REPOSITORY_ID &&
      Number.isFinite(timestamp(run.created_at)) && timestamp(run.created_at) <= now, 'invalid-cams-history');
    if (eligibleAttempt(run, slot)) return {dispatch: false, reason: 'nominal-slot-already-attempted', ...slot};
  }
  // A started prior tool step is a durable decision ledger, including a lost/refused POST. It
  // consumes only this nominal slot; no blind retry, cancellation, extra storage or new frequency.
  const prior = await list(`/actions/workflows/${CHAIN}/runs?branch=main&event=workflow_run&created=${since}`, 'workflow_runs');
  for (const run of prior) {
    requireState(run.path === `.github/workflows/${CHAIN}` && run.event === 'workflow_run' && run.head_branch === 'main' &&
      String(run.repository?.id) === env.GITHUB_REPOSITORY_ID && String(run.head_repository?.id) === env.GITHUB_REPOSITORY_ID &&
      Number.isFinite(timestamp(run.created_at)) && timestamp(run.created_at) <= now, 'invalid-chain-history');
    if (String(run.id) === env.GITHUB_RUN_ID || timestamp(run.created_at) < slot.start) continue;
    const jobs = await list(`/actions/runs/${run.id}/jobs?filter=all`, 'jobs');
    if (jobs.some(job => job.name === 'dispatch' && Array.isArray(job.steps) && job.steps.some(step =>
      step.name === STEP && step.conclusion !== 'skipped' && Number.isFinite(timestamp(step.started_at))) &&
      !(job.steps.some(step => step.name === STEP && step.conclusion === 'success') &&
        job.steps.some(step => step.name === NO_POST_STEP && step.conclusion === 'success'))))
      return {dispatch: false, reason: 'chain-slot-decision-already-started', ...slot};
  }
  if (phase === 'plan') return {dispatch: false, eligible: true, reason: 'due-existing-nominal-slot', ...slot};
  requireState((await get('/git/ref/heads/main')).object?.sha === env.GITHUB_SHA, 'changed-main');
  if (await publicPointer() >= slot.expectedInit) return {dispatch: false, reason: 'expected-init-already-served', ...slot};
  for (const status of ACTIVE) if ((await list(`/actions/workflows/${LANE}/runs?status=${status}&branch=main`, 'workflow_runs')).length)
    return {dispatch: false, reason: 'cams-active', ...slot};
  if (dueSlot(clock()).startISO !== slot.startISO) return {dispatch: false, reason: 'nominal-window-changed', ...slot};
  const response = await fetcher(`${API}/actions/workflows/${LANE}/dispatches`, {method: 'POST', redirect: 'error', headers: {
    ...headers, 'content-type': 'application/json'}, body: JSON.stringify({ref: 'main', inputs: {
      caller: 'component-bake-chain', run: slot.run}}), signal: AbortSignal.timeout(15_000)});
  await response.body?.cancel(); requireState(response.status === 204, 'dispatch-refused-or-uncertain');
  return {dispatch: true, reason: 'due-existing-nominal-slot', ...slot};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.env, Date.now(), fetch, Date.now).then(result => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,
      process.env.CAMS_CHAIN_PHASE === 'plan'
        ? `eligible=${result.eligible === true}\nslot=${result.startISO}\nrun=${result.run}\n`
        : `post_attempted=${result.dispatch === true}\n`);
    console.log(JSON.stringify(result));
  }, () => {
    console.error('CAMS chain refused or dispatch outcome uncertain; no automatic retry'); process.exitCode = 1;
  });
}
