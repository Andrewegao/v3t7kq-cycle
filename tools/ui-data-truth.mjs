// Truth gate at production preflight (I9 rank 4, 2026-10-08). The atmos controller's feed verifier
// grew a --truth mode (ops/release/verify-weather-feeds.mjs): verification archive ≤ 48 h, tides
// ≤ 7 days, USGS ≤ 2 h, GDACS not stuck at one 100-row page, --text-3 ≥ 4.5:1 in the shipped CSS.
// Releases used to pass while the archive was 41 days old and --text-3 read 2.84:1, because every
// gate checked function, not truth.
//
// Where each check runs, before any production write:
//   - data ages describe what production serves today: run against production;
//   - GDACS and contrast describe the candidate build: run against staging, which serves the
//     qualified candidate (proved first from /health/release.json; fail closed otherwise).
// A pinned controller without --truth predates the gate: nothing runs, and the log says so.
// UI_DATA_TRUTH_WAIVE (repo variable) names checks the owner accepts failing for one release; the
// verifier prints every waived failure, so a waiver is visible in the run log, never silent.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const DATA_TRUTH_CHECKS = Object.freeze(['verify-archive-age', 'tides-age', 'usgs-age', 'gdacs-not-capped', 'text-3-contrast']);
export const PRODUCTION_DATA_CHECKS = Object.freeze(['verify-archive-age', 'tides-age', 'usgs-age']);
export const CANDIDATE_BUILD_CHECKS = Object.freeze(['gdacs-not-capped', 'text-3-contrast']);
const VERIFIER = 'ops/release/verify-weather-feeds.mjs';

/** Comma-separated check ids from UI_DATA_TRUTH_WAIVE; anything unknown refuses the release. */
export function parseDataTruthWaiver(raw = '') {
  const ids = String(raw ?? '').split(',').map((id) => id.trim()).filter(Boolean);
  for (const id of ids) assert.ok(DATA_TRUTH_CHECKS.includes(id), `UI_DATA_TRUTH_WAIVE names an unknown check: ${id}`);
  assert.equal(new Set(ids).size, ids.length, 'UI_DATA_TRUTH_WAIVE repeats a check');
  return ids;
}

/** True when the pinned controller's feed verifier has the --truth mode. */
export function controllerHasDataTruthGate(control) {
  const path = resolve(control, VERIFIER);
  return existsSync(path) && readFileSync(path, 'utf8').includes("args.includes('--truth')");
}

/** The two verifier runs, as argv for `node`. */
export function dataTruthInvocations({ control, productionOrigin, stagingOrigin, waive = [] }) {
  const verifier = resolve(control, VERIFIER);
  const waiveArgs = (only) => {
    const ids = waive.filter((id) => only.includes(id));
    return ids.length ? ['--waive', ids.join(',')] : [];
  };
  return [
    { origin: productionOrigin, only: PRODUCTION_DATA_CHECKS,
      args: [verifier, productionOrigin, '--truth', '--only', PRODUCTION_DATA_CHECKS.join(','), ...waiveArgs(PRODUCTION_DATA_CHECKS)] },
    { origin: stagingOrigin, only: CANDIDATE_BUILD_CHECKS,
      args: [verifier, stagingOrigin, '--truth', '--only', CANDIDATE_BUILD_CHECKS.join(','), ...waiveArgs(CANDIDATE_BUILD_CHECKS)] },
  ];
}

/** The candidate checks read staging: prove staging still serves this candidate. */
export async function requireStagingServesCandidate(stagingOrigin, releaseId, fetchImpl = fetch) {
  assert.match(releaseId ?? '', /^git-[a-f0-9]{12}-run-\d+$/, 'candidate release id is invalid');
  const response = await fetchImpl(`${stagingOrigin}/health/release.json?cb=${Date.now()}`,
    { redirect: 'manual', headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200, `data-truth gate: staging release receipt unreadable (HTTP ${response.status})`);
  const served = (await response.json())?.releaseId;
  assert.equal(served, releaseId,
    `data-truth gate: staging serves ${served}, not the candidate ${releaseId}; its build checks cannot be measured (re-qualify on staging)`);
}
