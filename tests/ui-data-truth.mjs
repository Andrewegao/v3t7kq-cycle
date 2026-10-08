import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CANDIDATE_BUILD_CHECKS, DATA_TRUTH_CHECKS, PRODUCTION_DATA_CHECKS, controllerHasDataTruthGate,
  dataTruthInvocations, parseDataTruthWaiver, requireStagingServesCandidate,
} from '../tools/ui-data-truth.mjs';
import { POLICY_FILES } from '../tools/ui-release.mjs';

const controller = (verifierSource) => {
  const root = mkdtempSync(join(tmpdir(), 'ui-data-truth-'));
  if (verifierSource !== null) {
    mkdirSync(join(root, 'ops/release'), { recursive: true });
    writeFileSync(join(root, 'ops/release/verify-weather-feeds.mjs'), verifierSource);
  }
  return root;
};

test('every check runs exactly once, data ages on production and build checks on staging', () => {
  assert.deepEqual([...PRODUCTION_DATA_CHECKS, ...CANDIDATE_BUILD_CHECKS].sort(), [...DATA_TRUTH_CHECKS].sort());
  const [prod, staging] = dataTruthInvocations({ control: '/c', productionOrigin: 'https://weatherx.org', stagingOrigin: 'https://staging.weatherx.org' });
  assert.deepEqual(prod.args, ['/c/ops/release/verify-weather-feeds.mjs', 'https://weatherx.org', '--truth', '--only', 'verify-archive-age,tides-age,usgs-age']);
  assert.deepEqual(staging.args, ['/c/ops/release/verify-weather-feeds.mjs', 'https://staging.weatherx.org', '--truth', '--only', 'gdacs-not-capped,text-3-contrast']);
});

test('a waiver reaches only the run that measures the waived check', () => {
  const [prod, staging] = dataTruthInvocations({ control: '/c', productionOrigin: 'https://weatherx.org',
    stagingOrigin: 'https://staging.weatherx.org', waive: parseDataTruthWaiver(' verify-archive-age , tides-age ') });
  assert.deepEqual(prod.args.slice(-2), ['--waive', 'verify-archive-age,tides-age']);
  assert.equal(staging.args.includes('--waive'), false);
  assert.deepEqual(parseDataTruthWaiver(''), []);
  assert.deepEqual(parseDataTruthWaiver(undefined), []);
  assert.throws(() => parseDataTruthWaiver('verify-age'), /unknown check: verify-age/);
  assert.throws(() => parseDataTruthWaiver('tides-age,tides-age'), /repeats/);
});

test('a pinned controller without --truth runs nothing; one with it runs the gate', () => {
  assert.equal(controllerHasDataTruthGate(controller(null)), false);
  assert.equal(controllerHasDataTruthGate(controller("const edgeOnly = process.argv.includes('--edge-only');")), false);
  assert.equal(controllerHasDataTruthGate(controller("if (args.includes('--truth')) {}")), true);
});

test('build checks are measured on staging only while staging serves the candidate', async () => {
  const receipt = (releaseId, status = 200) => async () => new Response(JSON.stringify({ releaseId }), { status });
  await requireStagingServesCandidate('https://staging.weatherx.org', 'git-4ca4efd69bdd-run-37711295450', receipt('git-4ca4efd69bdd-run-37711295450'));
  await assert.rejects(requireStagingServesCandidate('https://staging.weatherx.org', 'git-4ca4efd69bdd-run-37711295450', receipt('git-b3f63183dbcd-run-37425194216')),
    /staging serves git-b3f63183dbcd-run-37425194216, not the candidate git-4ca4efd69bdd-run-37711295450/);
  await assert.rejects(requireStagingServesCandidate('https://staging.weatherx.org', 'git-4ca4efd69bdd-run-1', receipt('x', 503)), /HTTP 503/);
  await assert.rejects(requireStagingServesCandidate('https://staging.weatherx.org', 'nope', receipt('nope')), /release id is invalid/);
});

test('the gate is bound into the release: policy digest, production preflight, workflow variable', () => {
  assert.ok(POLICY_FILES.includes('tools/ui-data-truth.mjs'));
  const release = readFileSync(new URL('../tools/ui-release.mjs', import.meta.url), 'utf8');
  const preflight = release.slice(release.indexOf('async function preflight('), release.indexOf('export function requiredSourceGuard'));
  assert.match(preflight, /if \(stage === 'production'\) await verifyDataTruth\(c\);/);
  const workflow = readFileSync(new URL('../.github/workflows/ui-release.yml', import.meta.url), 'utf8');
  assert.match(workflow, /UI_DATA_TRUTH_WAIVE: \$\{\{ vars\.UI_DATA_TRUTH_WAIVE \}\}/);
});
