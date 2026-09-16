import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { authorizationExpiry, BACKEND_STAGES, prepareTransaction, validateDispatch } from '../tools/platform-staging-transaction.mjs';
import { parseWorkflow, ROOT } from '../tools/workflow-inventory.mjs';

const sha = 'a'.repeat(40);
const cycleSha = 'b'.repeat(40);
const environment = (overrides = {}) => ({
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
  GITHUB_SHA: cycleSha,
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '2',
  ATMOS_SHA: sha,
  TRANSACTION_STAGE: 'migration',
  EXACT_CONFIRMATION: `RUN-STAGING:migration:${sha}`,
  PLATFORM_STAGING_TRANSACTIONS_ENABLED: 'true',
  PLATFORM_STAGING_CLOUDFLARE_ACCOUNT_ID: 'a89f9a1af485021fbc60a68b163c7c6e',
  PLATFORM_STAGING_TOKEN_PROVISIONED: 'true',
  ATMOS_SOURCE_KEY_PROVISIONED: 'true',
  ROLLBACK_TARGET_VERSION_ID: '',
  ROLLBACK_EXPECTED_CURRENT_VERSION_ID: '',
  ...overrides,
});

test('dispatch gate binds Cycle main, exact stage, candidate, account and protected scopes', () => {
  const admitted = validateDispatch(environment());
  assert.equal(admitted.stage, 'migration');
  assert.deepEqual(BACKEND_STAGES, ['configuration', 'backup', 'migration', 'worker-deploy', 'worker-rollback']);
  for (const overrides of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_REPOSITORY: 'other/repo' },
    { GITHUB_SHA: 'main' },
    { ATMOS_SHA: 'master' },
    { TRANSACTION_STAGE: 'pages-deploy', EXACT_CONFIRMATION: `RUN-STAGING:pages-deploy:${sha}` },
    { EXACT_CONFIRMATION: `RUN-STAGING:backup:${sha}` },
    { PLATFORM_STAGING_TRANSACTIONS_ENABLED: 'false' },
    { PLATFORM_STAGING_CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) },
    { PLATFORM_STAGING_TOKEN_PROVISIONED: 'false' },
    { ATMOS_SOURCE_KEY_PROVISIONED: 'false' },
  ]) assert.throws(() => validateDispatch(environment(overrides)));
});

test('rollback requires distinct exact version IDs and other stages reject rollback arguments', () => {
  const rollback = {
    TRANSACTION_STAGE: 'worker-rollback',
    EXACT_CONFIRMATION: `RUN-STAGING:worker-rollback:${sha}`,
    ROLLBACK_TARGET_VERSION_ID: 'last-good-v1',
    ROLLBACK_EXPECTED_CURRENT_VERSION_ID: 'candidate-v2',
  };
  assert.equal(validateDispatch(environment(rollback)).rollbackTargetVersionId, 'last-good-v1');
  assert.throws(() => validateDispatch(environment({ ...rollback, ROLLBACK_EXPECTED_CURRENT_VERSION_ID: 'last-good-v1' })));
  assert.throws(() => validateDispatch(environment({ ROLLBACK_TARGET_VERSION_ID: 'unexpected' })));
});

test('preparation creates exclusive lease, arguments and non-secret manifest', async t => {
  const root = join(tmpdir(), `weatherx-platform-staging-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = new Date('2026-09-16T12:00:00.000Z');
  const result = prepareTransaction({ environment: environment({
    TRANSACTION_STAGE: 'backup', EXACT_CONFIRMATION: `RUN-STAGING:backup:${sha}`,
  }), outputDir: root, now });
  assert.equal(result.lease.expiresAt, '2026-09-16T12:30:00.000Z');
  assert.equal(result.stageArguments.outputPath, join(root, 'd1-before.sql'));
  assert.equal(result.manifest.authorizationMinutes, 10);
  assert.equal(result.manifest.stage, 'backup');
  const bytes = await Promise.all(Object.values(result.paths).map(path => readFile(path, 'utf8')));
  assert.doesNotMatch(bytes.join(''), /API_TOKEN|PRIVATE KEY|secret value/i);
  assert.throws(() => prepareTransaction({ environment: environment({
    TRANSACTION_STAGE: 'backup', EXACT_CONFIRMATION: `RUN-STAGING:backup:${sha}`,
  }), outputDir: root, now }), /already exists/);
});

test('authorization expiry is exactly ten minutes and safely below the packet maximum', () => {
  assert.equal(authorizationExpiry(new Date('2026-09-16T12:00:00.000Z')), '2026-09-16T12:10:00.000Z');
  assert.throws(() => authorizationExpiry(new Date('invalid')));
});

test('workflow is a protected manual main-only one-stage controller with scoped credentials', async () => {
  const path = '.github/workflows/platform-staging-transaction.yml';
  const source = await readFile(join(ROOT, path), 'utf8');
  const { data } = parseWorkflow(source, path);
  assert.deepEqual(Object.keys(data.on), ['workflow_dispatch']);
  assert.deepEqual(data.on.workflow_dispatch.inputs.stage.options, BACKEND_STAGES);
  assert.deepEqual(data.permissions, { contents: 'read' });
  assert.deepEqual(data.concurrency, { group: 'weatherx-platform-staging-transaction', 'cancel-in-progress': false });
  const job = data.jobs.transact;
  assert.equal(job.environment.name, 'platform-staging');
  assert.equal(job['timeout-minutes'], 30);
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(job.if, /github\.repository == 'Andrewegao\/v3t7kq-cycle'/);
  assert.equal(job.env, undefined);
  const named = Object.fromEntries(job.steps.filter(step => step.name).map(step => [step.name, step]));
  assert.equal(named['Checkout exact Atmos candidate'].with.ref, '${{ inputs.atmos_sha }}');
  assert.equal(named['Checkout exact Atmos candidate'].with['persist-credentials'], false);
  assert.match(named['Prove candidate is the current Atmos master and source is clean'].run, /origin\/master/);
  assert.match(named['Authorize the selected stage for ten minutes'].run, /authorization-expiry/);
  assert.match(named['Execute exactly one authorized backend staging stage'].run, /staging-rehearsal\.mjs run/);
  assert.equal((source.match(/staging-rehearsal\.mjs run/g) ?? []).length, 1);
  const credentialSteps = job.steps.filter(step => step.env?.CLOUDFLARE_API_TOKEN);
  assert.deepEqual(credentialSteps.map(step => step.name), [
    'Capture exact staging inventory for the plan',
    'Capture fresh expected-current staging state',
    'Execute exactly one authorized backend staging stage',
  ]);
  const upload = named['Retain append-only staging transaction evidence'];
  assert.equal(upload.if, '${{ always() }}');
  assert.match(upload.with.name, /github\.run_id.*github\.run_attempt/);
  assert.equal(upload.with.overwrite, undefined);
  assert.doesNotMatch(source, /weatherx-platform-edge-production|weatherx-platform-production|pages-deploy/);
});
