import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { hash } from './ui-candidate.mjs';
import { browserEnvironment } from './ui-staging-models.mjs';

export const PUBLIC_JOURNEY_PROOF_MAX_BYTES = 512 * 1024;
export const PUBLIC_JOURNEY_HARNESS = 'app/e2e/public-release-journeys.mjs';
export const PUBLIC_JOURNEY_AUTH_EVIDENCE = 'browser-only fixtures; no emails or live sessions created';
export const PUBLIC_JOURNEY_REQUIRED_STEPS = Object.freeze([
  'weather-first-paint',
  'welcome-visible',
  'welcome-existing-login',
  'onboarding-place',
  'welcome-to-place',
  'onboarding-purpose',
  'onboarding-place',
  'onboarding-purpose',
  'onboarding-purpose',
  'back-skip-resume',
  'onboarding-see',
  'onboarding-check',
  'onboarding-windows',
  'onboarding-watch',
  'onboarding-complete',
  'onboarding-completed',
  'existing-account-fixture-sign-in',
  'real-native100m-chart',
  'wind-energy-reference-output-chart',
]);
const ORIGINS = Object.freeze({
  staging: 'https://staging.weatherx.org',
  production: 'https://weatherx.org',
});
const VIEWPORTS = Object.freeze(['desktop', 'mobile']);
const SHA256 = /^[a-f0-9]{64}$/;

function exact(value, keys, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields changed`);
}

function boundedRegularFile(path, limit, label) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    assert.ok(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(limit),
      `${label} must be one bounded regular file`);
    const allocation = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < allocation.length) {
      const count = readSync(descriptor, allocation, length, allocation.length - length, length);
      if (count === 0) break;
      length += count;
    }
    assert.ok(length <= limit, `${label} grew beyond its byte bound`);
    const after = fstatSync(descriptor, { bigint: true });
    assert.ok(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs,
    `${label} changed while it was read`);
    assert.equal(BigInt(length), before.size, `${label} byte count changed`);
    return Buffer.from(allocation.subarray(0, length));
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validateMockedAuth(values) {
  assert.ok(Array.isArray(values) && values.length >= 2 && values.length <= 16 && values.length % 2 === 0,
    'public journey must contain one or more bounded auth fixture pairs');
  for (let index = 0; index < values.length; index += 2) {
    assert.equal(values[index], 'request-code', 'auth fixture request must precede verification');
    assert.equal(values[index + 1], 'verify-code', 'auth fixture verification must follow its request');
  }
}

function validateWind(stage, wind, now, requireFreshWind) {
  exact(wind, ['runId', 'catalogId', 'samples', 'freshUntil', 'source', 'distinctFromSurface'], 'public Wind100 proof');
  assert.match(wind.runId ?? '', /^[0-9]{10}$/, 'Wind100 run ID must be ten digits');
  assert.match(wind.catalogId ?? '', stage === 'staging'
    ? /^stage-wind100-recurring-[0-9]+-[0-9]+$/
    : /^prod-wind100-recurring-[0-9]+-[0-9]+$/, 'Wind100 catalog is not scoped to the release environment');
  assert.ok(Number.isSafeInteger(wind.samples) && wind.samples >= 8 && wind.samples <= 10000,
    'Wind100 sample count is invalid');
  const freshUntil = typeof wind.freshUntil === 'string' ? Date.parse(wind.freshUntil) : Number.NaN;
  assert.ok(Number.isFinite(freshUntil), 'Wind100 freshness timestamp is invalid');
  if (requireFreshWind) assert.ok(now < freshUntil, 'Wind100 evidence is stale at qualification time');
  assert.ok(typeof wind.source === 'string' && wind.source.length > 0 && wind.source.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(wind.source), 'Wind100 source is invalid');
  assert.equal(wind.distinctFromSurface, true, 'Wind100 must differ from surface wind');
}

export function validatePublicJourneyProofBytes(bytes, context, now = Date.now()) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= PUBLIC_JOURNEY_PROOF_MAX_BYTES,
    'public journey proof exceeds its byte bound');
  assert.ok(Object.hasOwn(ORIGINS, context?.stage), 'unknown public journey target');
  assert.match(context?.sourceSha ?? '', /^[a-f0-9]{40}$/, 'public journey source SHA is invalid');
  assert.match(context?.releaseId ?? '', /^git-[a-f0-9]{12}-run-[1-9][0-9]*$/, 'public journey release ID is invalid');
  let report;
  try { report = JSON.parse(bytes); }
  catch { throw new Error('public journey proof is not JSON'); }
  const raw = Object.hasOwn(report, 'startedAt') || Object.hasOwn(report, 'completedAt');
  exact(report, raw ? ['startedAt', 'completedAt', 'ok', 'base', 'identity', 'journeys']
    : ['ok', 'base', 'identity', 'journeys'], 'public journey report');
  assert.ok(raw || context.requireFreshWind === false,
    'qualification-time public journey proof must include timing');
  assert.equal(report.ok, true, 'public journey report did not pass');
  assert.equal(report.base, ORIGINS[context.stage], 'public journey report used the wrong origin');
  if (raw) {
    const startedAt = Date.parse(report.startedAt), completedAt = Date.parse(report.completedAt);
    assert.ok(Number.isFinite(startedAt) && Number.isFinite(completedAt) && startedAt <= completedAt,
      'public journey timing is invalid');
    assert.ok(completedAt <= now + 60_000, 'public journey proof is from the future');
  }
  exact(report.identity, ['sourceSha', 'releaseId', 'indexSha256', 'billingUiEnabled', 'introEnabled'],
    'public journey identity');
  assert.equal(report.identity.sourceSha, context.sourceSha, 'public journey source differs from candidate');
  assert.equal(report.identity.releaseId, context.releaseId, 'public journey release differs from candidate');
  assert.match(report.identity.indexSha256 ?? '', SHA256, 'public journey index digest is invalid');
  assert.equal(report.identity.billingUiEnabled, false, 'public journey enabled billing UI');
  assert.equal(report.identity.introEnabled, true, 'public journey did not exercise onboarding');
  assert.ok(Array.isArray(report.journeys) && report.journeys.length === VIEWPORTS.length,
    'desktop and mobile public journeys are required');
  const seen = new Set();
  for (const journey of report.journeys) {
    exact(journey, ['viewport', 'authEvidence', 'mockedAuth', 'blockedWrites', 'pageErrors', 'assetErrors', 'steps', 'wind'],
      'public journey');
    assert.ok(VIEWPORTS.includes(journey.viewport) && !seen.has(journey.viewport), 'public journey viewport is invalid or duplicated');
    seen.add(journey.viewport);
    assert.equal(journey.authEvidence, PUBLIC_JOURNEY_AUTH_EVIDENCE, 'public journey auth evidence changed');
    validateMockedAuth(journey.mockedAuth);
    for (const field of ['blockedWrites', 'pageErrors', 'assetErrors']) {
      assert.deepEqual(journey[field], [], `public journey ${field} must be empty`);
    }
    assert.deepEqual(journey.steps, PUBLIC_JOURNEY_REQUIRED_STEPS,
      'public journey did not prove the exact reviewed onboarding sequence');
    validateWind(context.stage, journey.wind, now, context.requireFreshWind !== false);
  }
  assert.deepEqual([...seen].sort(), [...VIEWPORTS].sort(), 'public journey viewport coverage differs');
  const sanitized = Buffer.from(`${JSON.stringify({
    ok: report.ok,
    base: report.base,
    identity: report.identity,
    journeys: report.journeys,
  }, null, 2)}\n`);
  assert.ok(sanitized.length <= PUBLIC_JOURNEY_PROOF_MAX_BYTES, 'sanitized public journey proof exceeds its byte bound');
  return { bytes: sanitized, sha256: hash(sanitized), identity: report.identity, journeys: report.journeys };
}

export function publicJourneyProofPath(runnerTemp, stage) {
  assert.ok(Object.hasOwn(ORIGINS, stage), 'unknown public journey target');
  assert.equal(resolve(runnerTemp), runnerTemp, 'public journey runner temp must be absolute');
  return resolve(runnerTemp, 'ui-public-release-journeys', `${stage}.json`);
}

export function publicJourneyEnvironment(env, { stage, sourceSha, releaseId, outputPath }) {
  assert.ok(Object.hasOwn(ORIGINS, stage), 'unknown public journey target');
  assert.equal(resolve(outputPath), outputPath, 'public journey output must be absolute');
  return browserEnvironment(env, {
    BASE: ORIGINS[stage],
    EXPECTED_SOURCE_SHA: sourceSha,
    EXPECTED_RELEASE_ID: releaseId,
    OUT: outputPath,
  });
}

export function publicJourneyBinding(proof) {
  assert.match(proof?.sha256 ?? '', SHA256, 'public journey proof digest is invalid');
  assert.match(proof?.harnessSha256 ?? '', SHA256, 'public journey harness digest is invalid');
  return {
    publicJourneyProofSha256: proof.sha256,
    publicJourneyHarnessSha256: proof.harnessSha256,
    publicJourneyIdentity: proof.identity,
    publicJourneyViewports: proof.journeys.map(row => row.viewport).sort(),
  };
}

export function requirePublicJourneyBinding(candidate, proof) {
  const binding = publicJourneyBinding(proof);
  assert.deepEqual(candidate?.qualification?.publicJourneyIdentity, binding.publicJourneyIdentity,
    'public journey identity differs from candidate binding');
  assert.equal(candidate?.qualification?.publicJourneyProofSha256, binding.publicJourneyProofSha256,
    'public journey proof differs from candidate binding');
  assert.equal(candidate?.qualification?.publicJourneyHarnessSha256, binding.publicJourneyHarnessSha256,
    'public journey harness differs from candidate binding');
  assert.deepEqual(candidate?.qualification?.publicJourneyViewports, binding.publicJourneyViewports,
    'public journey viewport coverage differs from candidate binding');
  return binding;
}

export function readPublicJourneyProof({ runnerTemp, controlRoot, stage, sourceSha, releaseId,
  now = Date.now(), requireFreshWind = true }) {
  const outputPath = publicJourneyProofPath(runnerTemp, stage);
  const harnessPath = resolve(controlRoot, PUBLIC_JOURNEY_HARNESS);
  const harnessSha256 = hash(boundedRegularFile(harnessPath, PUBLIC_JOURNEY_PROOF_MAX_BYTES, 'public journey harness'));
  const proof = validatePublicJourneyProofBytes(
    boundedRegularFile(outputPath, PUBLIC_JOURNEY_PROOF_MAX_BYTES, 'public journey proof'),
    { stage, sourceSha, releaseId, requireFreshWind }, now);
  return { ...proof, harnessSha256, outputPath };
}

export function runPublicReleaseJourneys({ runnerTemp, controlRoot, stage, sourceSha, releaseId, env = process.env }) {
  const outputPath = publicJourneyProofPath(runnerTemp, stage);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const harnessPath = resolve(controlRoot, PUBLIC_JOURNEY_HARNESS);
  execFileSync(process.execPath, [harnessPath], {
    cwd: resolve(controlRoot, 'app'),
    env: publicJourneyEnvironment(env, { stage, sourceSha, releaseId, outputPath }),
    stdio: 'inherit',
  });
  const proof = readPublicJourneyProof({ runnerTemp, controlRoot, stage, sourceSha, releaseId });
  writeFileSync(outputPath, proof.bytes, { flag: 'w', mode: 0o600 });
  return proof;
}
