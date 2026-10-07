#!/usr/bin/env node
// Dispatches observation-refresh.yml from the component-bake chain (observation-chain.yml) when the
// lane is enabled, its newest non-schedule run started more than 25 minutes ago and no lane or
// recovery run is queued, pending, waiting or in progress. It first re-verifies that the triggering
// run is this repository's own catalog-bake.yml on main. It can dispatch only observation-refresh.yml,
// only in its scheduled mode (caller component-bake-chain); it never dispatches five-feed-recovery.yml.
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CHAIN_CALLER, minutesSince} from './workflow-run-summary.mjs';

const API = 'https://api.github.com/repos/Andrewegao/v3t7kq-cycle';
export const LANE = 'observation-refresh.yml';
export const RECOVERY = 'five-feed-recovery.yml';
export const TRIGGER_WORKFLOW = '.github/workflows/catalog-bake.yml';
export const MIN_GAP_MINUTES = 25;
export const STUCK_MINUTES = 60;
export const ACTIVE = Object.freeze(['queued', 'pending', 'waiting', 'requested', 'in_progress']);
const POLLS = 10, POLL_MS = 3000;
const started = run => run.run_started_at ?? run.created_at;

// A workflow_run event matches by workflow name only; accept just this repository's own bake on main.
export function triggerAdmitted(run, repositoryId) {
  return run?.path === TRIGGER_WORKFLOW && ['workflow_dispatch', 'schedule'].includes(run.event) && run.head_branch === 'main'
    && /^[1-9]\d*$/.test(String(repositoryId ?? '')) && String(run.repository?.id) === String(repositoryId)
    && String(run.head_repository?.id) === String(repositoryId);
}

// lane: the lane's newest runs; active: lane and recovery runs in any ACTIVE status. Returns
// {dispatch, stuck, reason}. A cron run never resets the gap: a schedule run the plan job skipped
// would otherwise push the chain from 30 to about 40 minutes.
export function chainDecision({enabled, lane, active, now}) {
  if (enabled !== 'true') return {dispatch: false, stuck: false, reason: 'OBSERVATION_REFRESH_ENABLED is not `true`'};
  for (const run of active) {
    const minutes = minutesSince(started(run), now);
    const label = `run ${run.id} (${run.path?.split('/').pop()}) is ${run.status}`;
    if (minutes === null || minutes > STUCK_MINUTES)
      return {dispatch: false, stuck: true, reason: `${label} since ${minutes ?? 'an unknown time'} min ago (more than ${STUCK_MINUTES}); the owner must inspect or cancel it`};
  }
  if (active.length) { const run = active[0]; return {dispatch: false, stuck: false, reason: `run ${run.id} (${run.path?.split('/').pop()}) is ${run.status}`}; }
  const newest = lane.find(run => run.event !== 'schedule');
  const minutes = newest ? minutesSince(started(newest), now) : null;
  if (newest && (minutes === null || minutes <= MIN_GAP_MINUTES))
    return {dispatch: false, stuck: false, reason: `the lane's newest non-schedule run ${newest.id} started ${minutes ?? 'at an unknown time'} min ago (needs more than ${MIN_GAP_MINUTES})`};
  return {dispatch: true, stuck: false, reason: newest ? `the lane's newest non-schedule run ${newest.id} started ${minutes} min ago` : 'the lane has no non-schedule run'};
}

async function github(method, path, token, fetcher, body) {
  const response = await fetcher(`${API}${path}`, {method, headers: {accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', ...(body ? {'content-type': 'application/json'} : {})},
  ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`github-api-${response.status} ${method} ${path.split('?')[0]}`);
  return response.status === 204 ? null : response.json().catch(() => null);
}

const defaultSleep = ms => new Promise(done => setTimeout(done, ms));
export async function main(env = process.env, now = Date.now(), fetcher = fetch, sleep = defaultSleep) {
  const report = text => { console.log(text); if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`); };
  if (!/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? '') || !env.GH_TOKEN) throw new Error('run id and token required');
  if (env.ENABLED !== 'true') { report(`## Observation chain: not dispatched\n\n${chainDecision({enabled: env.ENABLED, lane: [], active: [], now}).reason}.`); return 0; }
  const get = path => github('GET', path, env.GH_TOKEN, fetcher);
  if (!/^[1-9]\d{0,19}$/.test(env.TRIGGER_RUN_ID ?? '') || !triggerAdmitted(await get(`/actions/runs/${env.TRIGGER_RUN_ID}`), env.GITHUB_REPOSITORY_ID))
    throw new Error(`refusing trigger run ${String(env.TRIGGER_RUN_ID ?? '').replace(/[^0-9]/g, '')}: not this repository's catalog-bake.yml on main (workflow_dispatch or schedule)`);
  const runs = async query => (await get(query))?.workflow_runs ?? [];
  const active = [];
  for (const workflow of [LANE, RECOVERY]) for (const status of ACTIVE) active.push(...await runs(`/actions/workflows/${workflow}/runs?status=${status}&per_page=10`));
  const lane = await runs(`/actions/workflows/${LANE}/runs?per_page=30`);
  const decision = chainDecision({enabled: env.ENABLED, lane, active, now});
  if (decision.stuck) { report(`## Observation chain: BLOCKED\n\n${decision.reason}.`); return 1; }
  if (!decision.dispatch) { report(`## Observation chain: not dispatched\n\n${decision.reason}.`); return 0; }
  const seen = new Set(lane.map(run => run.id));
  await github('POST', `/actions/workflows/${LANE}/dispatches`, env.GH_TOKEN, fetcher,
    {ref: 'main', inputs: {caller: CHAIN_CALLER, chain_run_id: env.GITHUB_RUN_ID}});
  // Hold the concurrency group until the new run is listed, so the next chain run cannot dispatch again.
  for (let poll = 0; poll < POLLS; poll += 1) {
    await sleep(POLL_MS);
    const created = (await runs(`/actions/workflows/${LANE}/runs?event=workflow_dispatch&per_page=5`)).find(run => !seen.has(run.id));
    if (created) {
      report(`## Observation chain: dispatched ${LANE} (run ${created.id})\n\n${decision.reason}; caller \`${CHAIN_CALLER}\`, chain run ${env.GITHUB_RUN_ID}.`);
      return 0;
    }
  }
  report(`## Observation chain: dispatched ${LANE}, but no new run was listed within ${POLLS * POLL_MS / 1000} s\n\nThe next chain run may not see it; check the lane's run list.`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
