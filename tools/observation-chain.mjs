#!/usr/bin/env node
// Dispatches observation-refresh.yml from the component-bake chain (observation-chain.yml) when the
// lane is enabled, has not started a run in the last 25 minutes and has no lane or recovery run
// queued, pending, waiting or in progress. It can dispatch only observation-refresh.yml, only in its
// scheduled mode (caller component-bake-chain); it never dispatches five-feed-recovery.yml.
import {appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CHAIN_CALLER, minutesSince} from './workflow-run-summary.mjs';

const API = 'https://api.github.com/repos/Andrewegao/v3t7kq-cycle';
export const LANE = 'observation-refresh.yml';
export const RECOVERY = 'five-feed-recovery.yml';
export const MIN_GAP_MINUTES = 25;

// runs: newest-first workflow_runs of the lane and of the recovery. Returns {dispatch, reason}.
export function chainDecision({enabled, lane, recovery, now}) {
  if (enabled !== 'true') return {dispatch: false, reason: 'OBSERVATION_REFRESH_ENABLED is not `true`'};
  const active = [...lane, ...recovery].find(run => run.status !== 'completed');
  if (active) return {dispatch: false, reason: `run ${active.id} (${active.path?.split('/').pop()}) is ${active.status}`};
  const newest = lane[0];
  const minutes = newest ? minutesSince(newest.run_started_at ?? newest.created_at, now) : null;
  if (newest && (minutes === null || minutes <= MIN_GAP_MINUTES))
    return {dispatch: false, reason: `the lane's newest run ${newest.id} started ${minutes ?? 'at an unknown time'} min ago (needs more than ${MIN_GAP_MINUTES})`};
  return {dispatch: true, reason: newest ? `the lane's newest run ${newest.id} started ${minutes} min ago` : 'the lane has no run'};
}

async function github(method, path, token, fetcher, body) {
  const response = await fetcher(`${API}${path}`, {method, headers: {accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28', ...(body ? {'content-type': 'application/json'} : {})},
  ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw new Error(`github-api-${response.status} ${method} ${path.split('?')[0]}`);
  return response.status === 204 ? null : response.json().catch(() => null);
}

export async function main(env = process.env, now = Date.now(), fetcher = fetch) {
  const report = text => { console.log(text); if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`); };
  if (!/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? '') || !env.GH_TOKEN) throw new Error('run id and token required');
  let decision = chainDecision({enabled: env.ENABLED, lane: [], recovery: [], now});
  if (env.ENABLED === 'true') {
    const runs = async workflow => (await github('GET', `/actions/workflows/${workflow}/runs?per_page=30`, env.GH_TOKEN, fetcher))?.workflow_runs ?? [];
    decision = chainDecision({enabled: env.ENABLED, lane: await runs(LANE), recovery: await runs(RECOVERY), now});
  }
  if (!decision.dispatch) { report(`## Observation chain: not dispatched\n\n${decision.reason}.`); return 0; }
  await github('POST', `/actions/workflows/${LANE}/dispatches`, env.GH_TOKEN, fetcher,
    {ref: 'main', inputs: {caller: CHAIN_CALLER, chain_run_id: env.GITHUB_RUN_ID}});
  report(`## Observation chain: dispatched ${LANE}\n\n${decision.reason}; caller \`${CHAIN_CALLER}\`, chain run ${env.GITHUB_RUN_ID}.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
