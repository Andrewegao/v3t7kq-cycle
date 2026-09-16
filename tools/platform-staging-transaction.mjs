#!/usr/bin/env node
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA40 = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_NUMBER = /^[1-9][0-9]{0,19}$/;
const ACCOUNT_ID = 'a89f9a1af485021fbc60a68b163c7c6e';
const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
const AUTHORIZATION_MINUTES = 10;
const LEASE_MINUTES = 30;

export const BACKEND_STAGES = Object.freeze([
  'configuration',
  'backup',
  'migration',
  'worker-deploy',
  'worker-rollback',
]);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    fail(`${name} has unexpected fields`);
  }
}

function required(value, pattern, name) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(`invalid ${name}`);
  return value;
}

function instant(value, name) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(`invalid ${name}`);
  return value;
}

function writeJsonExclusive(path, value) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  let descriptor;
  try {
    descriptor = openSync(target, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } catch (error) {
    if (error?.code === 'EEXIST') fail(`transaction file already exists: ${target}`);
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const directory = openSync(dirname(target), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  return target;
}

export function validateDispatch(environment) {
  const value = {
    eventName: environment.GITHUB_EVENT_NAME,
    ref: environment.GITHUB_REF,
    repository: environment.GITHUB_REPOSITORY,
    cycleSha: environment.GITHUB_SHA,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    atmosphereSha: environment.ATMOS_SHA,
    stage: environment.TRANSACTION_STAGE,
    confirmation: environment.EXACT_CONFIRMATION,
    enabled: environment.PLATFORM_STAGING_TRANSACTIONS_ENABLED,
    accountId: environment.PLATFORM_STAGING_CLOUDFLARE_ACCOUNT_ID,
    tokenProvisioned: environment.PLATFORM_STAGING_TOKEN_PROVISIONED,
    sourceKeyProvisioned: environment.ATMOS_SOURCE_KEY_PROVISIONED,
    rollbackTargetVersionId: environment.ROLLBACK_TARGET_VERSION_ID ?? '',
    rollbackExpectedCurrentVersionId: environment.ROLLBACK_EXPECTED_CURRENT_VERSION_ID ?? '',
  };
  exactKeys(value, [
    'eventName', 'ref', 'repository', 'cycleSha', 'runId', 'runAttempt', 'atmosphereSha', 'stage',
    'confirmation', 'enabled', 'accountId', 'tokenProvisioned', 'sourceKeyProvisioned',
    'rollbackTargetVersionId', 'rollbackExpectedCurrentVersionId',
  ], 'dispatch');
  if (value.eventName !== 'workflow_dispatch' || value.ref !== 'refs/heads/main'
    || value.repository !== REPOSITORY) fail('transaction must be manually dispatched from Cycle main');
  required(value.cycleSha, SHA40, 'Cycle control SHA');
  required(value.atmosphereSha, SHA40, 'Atmos candidate SHA');
  required(value.runId, RUN_NUMBER, 'GitHub run ID');
  required(value.runAttempt, RUN_NUMBER, 'GitHub run attempt');
  if (!BACKEND_STAGES.includes(value.stage)) fail('stage is not an allowed backend transaction stage');
  if (value.confirmation !== `RUN-STAGING:${value.stage}:${value.atmosphereSha}`) {
    fail('exact dispatch confirmation does not bind the selected stage and Atmos SHA');
  }
  if (value.enabled !== 'true') fail('platform staging transactions are not enabled');
  if (value.accountId !== ACCOUNT_ID) fail('Cloudflare account is not the reviewed staging account');
  if (value.tokenProvisioned !== 'true') fail('dedicated platform staging token is not provisioned');
  if (value.sourceKeyProvisioned !== 'true') fail('read-only Atmos source key is not provisioned');
  if (value.stage === 'worker-rollback') {
    required(value.rollbackTargetVersionId, ID, 'rollback target version ID');
    required(value.rollbackExpectedCurrentVersionId, ID, 'rollback expected-current version ID');
    if (value.rollbackTargetVersionId === value.rollbackExpectedCurrentVersionId) {
      fail('rollback target must differ from the expected-current version');
    }
  } else if (value.rollbackTargetVersionId !== '' || value.rollbackExpectedCurrentVersionId !== '') {
    fail('rollback version IDs are accepted only for worker-rollback');
  }
  return value;
}

export function prepareTransaction({ environment, outputDir, now = new Date() }) {
  const dispatch = validateDispatch(environment);
  const issued = instant(now, 'transaction time');
  const root = resolve(outputDir);
  const leaseId = `gh-${dispatch.runId}-${dispatch.runAttempt}-${dispatch.stage}`;
  required(leaseId, ID, 'lease ID');
  const lease = {
    schemaVersion: 1,
    environment: 'staging',
    candidateGitSha: dispatch.atmosphereSha,
    leaseId,
    holder: `github:${dispatch.repository}/actions/runs/${dispatch.runId}/attempts/${dispatch.runAttempt}`,
    issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + LEASE_MINUTES * 60_000).toISOString(),
  };
  let stageArguments = {};
  if (dispatch.stage === 'backup') stageArguments = { outputPath: resolve(root, 'd1-before.sql') };
  if (dispatch.stage === 'worker-rollback') stageArguments = {
    targetVersionId: dispatch.rollbackTargetVersionId,
    expectedCurrentVersionId: dispatch.rollbackExpectedCurrentVersionId,
  };
  const manifest = {
    schemaVersion: 1,
    environment: 'staging',
    cycleControlSha: dispatch.cycleSha,
    candidateGitSha: dispatch.atmosphereSha,
    stage: dispatch.stage,
    authorizationId: leaseId,
    cloudflareAccountId: ACCOUNT_ID,
    leaseMinutes: LEASE_MINUTES,
    authorizationMinutes: AUTHORIZATION_MINUTES,
  };
  const paths = {
    lease: writeJsonExclusive(resolve(root, 'lease.json'), lease),
    arguments: writeJsonExclusive(resolve(root, 'stage-arguments.json'), stageArguments),
    manifest: writeJsonExclusive(resolve(root, 'dispatch.json'), manifest),
  };
  return { dispatch, lease, stageArguments, manifest, paths };
}

export function authorizationExpiry(now = new Date()) {
  const issued = instant(now, 'authorization time');
  return new Date(issued.getTime() + AUTHORIZATION_MINUTES * 60_000).toISOString();
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined || key.length <= 2) fail(`invalid argument near ${key ?? '<end>'}`);
    if (key.slice(2) in options) fail(`duplicate argument ${key}`);
    options[key.slice(2)] = value;
  }
  return { command, options };
}

function main(argv) {
  const { command, options } = parseArgs(argv);
  if (command === 'prepare') {
    exactKeys(options, ['output-dir'], 'prepare options');
    const result = prepareTransaction({ environment: process.env, outputDir: options['output-dir'] });
    console.log(JSON.stringify({ ...result.paths, authorizationId: result.manifest.authorizationId }));
    return;
  }
  if (command === 'authorization-expiry') {
    exactKeys(options, [], 'authorization-expiry options');
    console.log(authorizationExpiry());
    return;
  }
  fail('usage: platform-staging-transaction.mjs prepare --output-dir PATH | authorization-expiry');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
