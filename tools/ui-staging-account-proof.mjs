import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hash } from './ui-candidate.mjs';
import { ACCOUNT_APPROVAL, browserEnvironment } from './ui-staging-models.mjs';

export const ACCOUNT_PROOF_FILE = 'ui-staging-account-proof.json';
export const ACCOUNT_PROOF_MAX_BYTES = 1024 * 1024;
export const ACCOUNT_PROOF_MAX_AGE_MS = 10 * 60 * 1000;
export const ACCOUNT_PROOF_MAX_DURATION_MS = 16 * 60 * 1000;
export const ACCOUNT_QUALIFICATION_TIMEOUT_MS = 15 * 60 * 1000;
const HARNESS_RELATIVE = 'app/e2e/staging-account-qualification.mjs';
const STAGING_ORIGIN = 'https://staging.weatherx.org';

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

function instant(value, label) {
  assert.ok(typeof value === 'string', `${label} is missing`);
  const milliseconds = Date.parse(value);
  assert.ok(Number.isFinite(milliseconds), `${label} is invalid`);
  return milliseconds;
}

export function accountQualificationRequired(stage, phase, profile) {
  assert.ok(stage === 'staging' || stage === 'production', 'unknown UI target');
  assert.ok(phase === 'candidate' || phase === 'rollback', 'unknown UI verification phase');
  return stage === 'staging' && phase === 'candidate' && profile?.account === true;
}

export function accountProofPath(runnerTemp) {
  assert.ok(typeof runnerTemp === 'string' && resolve(runnerTemp) === runnerTemp,
    'account qualification requires an absolute runner temp');
  return resolve(runnerTemp, ACCOUNT_PROOF_FILE);
}

export function readAccountProofBytes(path) {
  return boundedRegularFile(path, ACCOUNT_PROOF_MAX_BYTES, 'account qualification proof');
}

export function accountQualificationEnvironment(env, { sourceSha, releaseId, outputPath }) {
  assert.match(sourceSha ?? '', /^[a-f0-9]{40}$/, 'account qualification source SHA is invalid');
  assert.match(releaseId ?? '', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/,
    'account qualification release ID is invalid');
  assert.equal(resolve(outputPath), outputPath, 'account qualification output must be absolute');
  return browserEnvironment(env, {
    BASE: STAGING_ORIGIN,
    EXPECTED_SOURCE_SHA: sourceSha,
    EXPECTED_RELEASE_ID: releaseId,
    OUT: outputPath,
    QUALIFICATION_PROFILES: 'normal,slow',
    REPEATS: '2',
    LIFECYCLE_CYCLES: '30',
    WEATHER_TIMEOUT_MS: '90000',
    MAX_WEATHER_ABORTS: '20',
    WEATHER_EVIDENCE: 'live staging read-only transport',
  });
}

function expectedContext({ sourceSha, releaseId, harnessSha256 }) {
  return {
    candidateSourceSha: sourceSha,
    candidateReleaseId: releaseId,
    candidateOrigin: STAGING_ORIGIN,
    harnessSha256,
    profiles: ['normal', 'slow'],
    repeats: 2,
    minLifecycleCycles: 30,
    maxWeatherAborts: 20,
  };
}

function sanitizedReceipt(receipt) {
  // The pinned harness and validator define the nested metadata contract. Project its documented
  // top-level evidence fields so known browser and any future top-level diagnostics are not retained.
  const safe = {
    schemaVersion: receipt.schemaVersion,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    ok: receipt.ok,
    harnessSha256: receipt.harnessSha256,
    safety: receipt.safety,
    configuration: receipt.configuration,
    evidenceLabels: receipt.evidenceLabels,
    releaseProfiles: receipt.releaseProfiles,
    accountCases: receipt.accountCases,
    lifecycle: receipt.lifecycle,
    timings: receipt.timings,
    timingSummary: receipt.timingSummary,
    timingComparisons: receipt.timingComparisons,
    comparisonLimitation: receipt.comparisonLimitation,
    failures: receipt.failures,
  };
  return Buffer.from(`${JSON.stringify(safe, null, 2)}\n`);
}

export function validateAccountProofBytes(bytes, context, validateQualificationReceipt, now = Date.now()) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= ACCOUNT_PROOF_MAX_BYTES,
    'account qualification proof exceeds its byte bound');
  assert.equal(typeof validateQualificationReceipt, 'function', 'pinned account qualification validator is missing');
  assert.match(context?.sourceSha ?? '', /^[a-f0-9]{40}$/, 'account qualification source SHA is invalid');
  assert.match(context?.releaseId ?? '', /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/,
    'account qualification release ID is invalid');
  assert.match(context?.harnessSha256 ?? '', /^[a-f0-9]{64}$/,
    'account qualification harness SHA-256 is invalid');
  let receipt;
  try { receipt = JSON.parse(bytes); }
  catch { throw new Error('account qualification proof is not JSON'); }
  assert.equal(receipt?.harnessSha256, context.harnessSha256,
    'account qualification proof names a different harness');
  const startedAt = instant(receipt.startedAt, 'account qualification start');
  const completedAt = instant(receipt.completedAt, 'account qualification completion');
  assert.ok(startedAt <= completedAt && completedAt - startedAt <= ACCOUNT_PROOF_MAX_DURATION_MS,
    'account qualification proof duration is invalid');
  assert.ok(completedAt <= now + 60_000, 'account qualification proof is from the future');
  if (context.requireFresh !== false) assert.ok(now - completedAt <= ACCOUNT_PROOF_MAX_AGE_MS,
    'account qualification proof is stale');
  validateQualificationReceipt(receipt, expectedContext(context));
  const sanitized = sanitizedReceipt(receipt);
  assert.ok(sanitized.length > 0 && sanitized.length <= ACCOUNT_PROOF_MAX_BYTES,
    'sanitized account qualification proof exceeds its byte bound');
  return { bytes: sanitized, sha256: hash(sanitized), harnessSha256: context.harnessSha256, receipt };
}

async function harness(controlRoot) {
  const path = resolve(controlRoot, HARNESS_RELATIVE);
  const bytes = boundedRegularFile(path, ACCOUNT_PROOF_MAX_BYTES, 'account qualification harness');
  const harnessSha256 = hash(bytes);
  const module = await import(pathToFileURL(path).href);
  assert.equal(typeof module.validateQualificationReceipt, 'function',
    'pinned account qualification validator is missing');
  return { path, harnessSha256, validateQualificationReceipt: module.validateQualificationReceipt };
}

export async function readAccountProof({ runnerTemp, controlRoot, sourceSha, releaseId, now = Date.now(), requireFresh = true }) {
  const fixed = await harness(controlRoot);
  const bytes = readAccountProofBytes(accountProofPath(runnerTemp));
  return validateAccountProofBytes(bytes, { sourceSha, releaseId, harnessSha256: fixed.harnessSha256, requireFresh },
    fixed.validateQualificationReceipt, now);
}

export async function runAccountQualification({ candidate, releaseId, runnerTemp, controlRoot,
  env = process.env, execute = execFileSync }) {
  assert.equal(candidate?.profile?.account, true, 'account qualification requires the account profile');
  const outputPath = accountProofPath(runnerTemp);
  assert.equal(existsSync(outputPath), false, 'account qualification proof already exists');
  const fixed = await harness(controlRoot);
  execute(process.execPath, [fixed.path], {
    cwd: resolve(controlRoot, 'app'),
    env: accountQualificationEnvironment(env, { sourceSha: candidate.sourceSha, releaseId, outputPath }),
    stdio: 'inherit',
    timeout: ACCOUNT_QUALIFICATION_TIMEOUT_MS,
  });
  const bytes = readAccountProofBytes(outputPath);
  return validateAccountProofBytes(bytes, {
    sourceSha: candidate.sourceSha, releaseId, harnessSha256: fixed.harnessSha256,
  }, fixed.validateQualificationReceipt);
}

export function accountQualificationBinding(candidate, proof) {
  assert.equal(candidate?.profile?.account, true, 'account proof cannot bind to an account-off candidate');
  assert.match(proof?.sha256 ?? '', /^[a-f0-9]{64}$/, 'account qualification proof hash is invalid');
  assert.match(proof?.harnessSha256 ?? '', /^[a-f0-9]{64}$/, 'account qualification harness hash is invalid');
  return {
    accountProfile: ACCOUNT_APPROVAL,
    accountProofSha256: proof.sha256,
    accountHarnessSha256: proof.harnessSha256,
  };
}

export function requireAccountQualificationBinding(candidate, proof) {
  const binding = accountQualificationBinding(candidate, proof);
  assert.equal(candidate.qualification?.accountProfile, binding.accountProfile,
    'candidate account qualification profile differs from proof');
  assert.equal(candidate.qualification?.accountProofSha256, binding.accountProofSha256,
    'candidate account qualification proof hash differs from retained proof');
  assert.equal(candidate.qualification?.accountHarnessSha256, binding.accountHarnessSha256,
    'candidate account qualification harness differs from retained proof');
  return binding;
}
