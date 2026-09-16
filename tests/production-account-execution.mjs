import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  ATMOS_INTEGRATION_CANDIDATE_SHA,
  LANE_B_CONTRACT,
  LANE_B_CONTRACT_DIGEST,
} from '../tools/production-account-contract.mjs';
import {
  createProductionReceiptStore,
  executeProductionAccountTransaction,
  planProductionAccountExecution,
  PRODUCTION_MUTATION_CONFIRMATION,
  validateProductionInputReceiptBinding,
  validateProductionExecutionRequest,
  validateProductionMutationAuthorization,
} from '../tools/production-account-execution.mjs';
import {productionCandidateBinding, productionReleasePlanDigest} from '../tools/production-account-release.mjs';
import {PRODUCTION_ACCOUNT_PROFILE, profileDigest} from '../tools/ui-staging-models.mjs';
import {controlShaFor, hash, validateFiles} from '../tools/ui-candidate.mjs';

const H = character => character.repeat(64);
const S = character => character.repeat(40);
const iso = milliseconds => new Date(milliseconds).toISOString();

function pagesPayload(failOpen) {
  const context = name => ({
    compatibility_date: '2026-06-23',
    compatibility_flags: [],
    fail_open: failOpen,
    ...structuredClone(LANE_B_CONTRACT.pagesBindings[name]),
  });
  return {deployment_configs: {production: context('production'), preview: context('preview')}};
}

function candidateFixture() {
  const sourceSha = ATMOS_INTEGRATION_CANDIDATE_SHA;
  const raw = [
    ['index.html', Buffer.from('<title>WeatherX</title>')],
    ['_worker.js', Buffer.from('export default {};')],
    ['_routes.json', Buffer.from('{"version":1,"include":["/api/*"],"exclude":[]}')],
  ];
  const shellDigest = createHash('sha256');
  for (const [path, bytes] of [...raw].sort(([left],[right]) => left.localeCompare(right))) {
    shellDigest.update(path).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0');
  }
  const receipt = {
    gitSha: sourceSha,
    workflowRunId: '123',
    releaseId: `git-${sourceSha.slice(0,12)}-run-123`,
    shellSha256: shellDigest.digest('hex'),
    shellFileCount: raw.length,
    shellBytes: raw.reduce((sum, [,bytes]) => sum + bytes.length, 0),
    indexSha256: hash(raw[0][1]),
    buildProfile: structuredClone(LANE_B_CONTRACT.provisionalBuildReceipt),
  };
  const files = [...raw, ['health/release.json', Buffer.from(JSON.stringify(receipt))]]
    .map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64')}))
    .sort((left, right) => left.path.localeCompare(right.path));
  const candidate = {
    schemaVersion: 1,
    controlSha: controlShaFor(PRODUCTION_ACCOUNT_PROFILE),
    profile: PRODUCTION_ACCOUNT_PROFILE,
    sourceSha,
    runId: '123',
    attempt: '1',
    workflowSha: S('b'),
    pipelineDigest: H('b'),
    artifactDigest: validateFiles(files, PRODUCTION_ACCOUNT_PROFILE).digest,
    files,
  };
  candidate.qualification = {
    origin: 'https://staging.weatherx.org',
    artifactDigest: candidate.artifactDigest,
    qualifiedAt: '2026-09-16T00:00:00.000Z',
    deploymentId: '12345678-1234-1234-1234-123456789abc',
    fullTests: true,
    weatherLab: true,
    builtRuntime: true,
    probes: 3,
  };
  return candidate;
}

const CANDIDATE = candidateFixture();
const OPTIONS = {candidate: CANDIDATE, qualification: CANDIDATE.qualification};

function plan() {
  return {
    schemaVersion: 1,
    kind: 'weatherx-production-account-release-plan',
    transactionId: 'prod-account-20260916-001',
    leaseOwner: 'release-commander-andrew',
    contractDigest: LANE_B_CONTRACT_DIGEST,
    candidateBinding: productionCandidateBinding(CANDIDATE, CANDIDATE.qualification, {allowProvisional: true}),
    identities: {
      atmosSha: CANDIDATE.sourceSha,
      controllerSha: CANDIDATE.controlSha,
      profileDigest: profileDigest(CANDIDATE.profile),
      pipelineDigest: CANDIDATE.pipelineDigest,
      artifactDigest: CANDIDATE.artifactDigest,
    },
    target: structuredClone(LANE_B_CONTRACT.target),
    modes: structuredClone(LANE_B_CONTRACT.modes),
    stripe: {environment: 'live', priceIds: structuredClone(LANE_B_CONTRACT.approvedStripePriceIds)},
    rollback: {
      worker: {versionId: 'worker-old', deploymentId: 'worker-deploy-old', configDigest: H('d')},
      pages: {configDigest: H('e'), canonicalDeploymentId: 'pages-deploy-old', payload: pagesPayload(true)},
    },
    desired: {
      worker: {sourceDigest: H('f'), configDigest: H('1')},
      pages: {configDigest: H('2'), payload: pagesPayload(false)},
    },
    compatibility: {
      oldUi: true,
      oldWorkerOnAdditiveSchema: true,
      schemaStrategy: 'retain-additive',
      purchaseClosedDuringPreparation: true,
    },
  };
}

function request(mode = 'plan', action = 'prepare-worker') {
  return {
    schemaVersion: 1,
    kind: 'weatherx-production-account-execution-request',
    mode,
    action,
    plan: plan(),
    inputReceipt: null,
    authorization: null,
  };
}

function authorization(value, action = 'prepare-worker') {
  const planDigest = productionReleasePlanDigest(value.plan);
  const preview = planProductionAccountExecution({...value, mode: 'plan', authorization: null}, OPTIONS);
  return {
    schemaVersion: 1,
    kind: 'weatherx-production-mutation-authorization',
    confirmation: PRODUCTION_MUTATION_CONFIRMATION,
    action,
    transactionId: value.plan.transactionId,
    leaseOwner: value.plan.leaseOwner,
    contractDigest: value.plan.contractDigest,
    planDigest,
    targetDigest: preview.targetDigest,
    issuedAt: '2026-09-16T06:00:00.000Z',
    expiresAt: '2026-09-16T06:15:00.000Z',
  };
}

test('plan mode emits an immutable blocked preview and cannot carry authorization or call adapters', () => {
  const calls = [];
  const preview = planProductionAccountExecution(request(), {
    ...OPTIONS,
    workerClient: new Proxy({}, {get() { calls.push('worker'); return () => {}; }}),
    pagesClient: new Proxy({}, {get() { calls.push('pages'); return () => {}; }}),
  });
  assert.equal(preview.executable, false);
  assert.deepEqual(preview.blockers, [
    'lane-b-contract-provisional',
    'owner-approved-live-stripe-prices-required',
  ]);
  assert.equal(preview.target.origin, 'https://weatherx.org');
  assert.deepEqual(calls, []);

  const authorizedPlan = request();
  authorizedPlan.authorization = {};
  assert.throws(() => validateProductionExecutionRequest(authorizedPlan), /plan mode cannot carry/);
});

test('execute mode cannot opt into the provisional contract and reaches no lease, receipt, or mutation adapter', async () => {
  const calls = [];
  const value = request('execute');
  value.authorization = authorization(value);
  await assert.rejects(executeProductionAccountTransaction(value, {
    ...OPTIONS,
    lease: {assertHeld: async () => { calls.push('lease'); }},
    receipts: {
      write: async () => { calls.push('write'); },
      read: async () => { calls.push('read'); },
    },
    workerClient: new Proxy({}, {get() { calls.push('worker'); return async () => {}; }}),
  }, Date.parse('2026-09-16T06:05:00.000Z')), /remains provisional/);
  assert.deepEqual(calls, []);
});

test('mutation authorization is separate, action-bound, target-bound, short-lived and mandatory', () => {
  const value = request('execute');
  const approved = authorization(value);
  assert.deepEqual(validateProductionMutationAuthorization(
    approved, value, value.plan, Date.parse('2026-09-16T06:05:00.000Z'),
  ), approved);
  for (const mutate of [
    item => { item.confirmation = 'yes'; },
    item => { item.action = 'prepare-pages'; },
    item => { item.targetDigest = H('9'); },
    item => { item.planDigest = H('8'); },
    item => { item.expiresAt = '2026-09-16T07:00:01.000Z'; },
  ]) {
    const bad = structuredClone(approved);
    mutate(bad);
    assert.throws(() => validateProductionMutationAuthorization(
      bad, value, value.plan, Date.parse('2026-09-16T06:05:00.000Z'),
    ));
  }
  assert.throws(() => validateProductionMutationAuthorization(
    null, value, value.plan, Date.parse('2026-09-16T06:05:00.000Z'),
  ), /invalid production mutation authorization/);
  assert.throws(() => validateProductionMutationAuthorization(
    approved, value, value.plan, Date.parse('2026-09-16T06:16:00.000Z'),
  ), /not currently valid/);
});

test('input receipts are accepted only by activation and recovery actions', () => {
  const prepare = request('plan', 'prepare-worker');
  prepare.inputReceipt = {};
  assert.throws(() => validateProductionExecutionRequest(prepare), /not accepted/);

  const activation = request('plan', 'activate-worker');
  assert.throws(() => validateProductionExecutionRequest(activation), /receipt is required/);
  activation.inputReceipt = {kind: 'weatherx-account-worker-transaction-receipt'};
  validateProductionExecutionRequest(activation);
});

test('an input receipt is bound to the same authorized plan, transaction, contract and lease owner', () => {
  const activation = request('execute', 'activate-worker');
  const releasePlan = activation.plan;
  activation.inputReceipt = {
    transactionId: releasePlan.transactionId,
    leaseOwner: releasePlan.leaseOwner,
    contractDigest: releasePlan.contractDigest,
    planDigest: productionReleasePlanDigest(releasePlan),
    plan: structuredClone(releasePlan),
  };
  validateProductionInputReceiptBinding(activation, releasePlan);
  for (const mutate of [
    receipt => { receipt.transactionId = 'another-transaction'; },
    receipt => { receipt.leaseOwner = 'another-owner'; },
    receipt => { receipt.planDigest = H('7'); },
    receipt => { receipt.plan.target.workerName = 'weatherx-platform-edge-staging'; },
  ]) {
    const bad = structuredClone(activation);
    mutate(bad.inputReceipt);
    assert.throws(() => validateProductionInputReceiptBinding(bad, releasePlan));
  }
});

test('durable receipt store round-trips atomically and refuses a symlink destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weatherx-production-receipts-'));
  const store = createProductionReceiptStore(root);
  const first = {phase: 'authorized-pre-mutation', value: H('a')};
  await store.write('release-1:prepare-worker', first);
  assert.deepEqual(await store.read('release-1:prepare-worker'), first);
  const second = {phase: 'completed', value: H('b')};
  await store.write('release-1:prepare-worker', second);
  assert.deepEqual(await store.read('release-1:prepare-worker'), second);

  const entries = (await import('node:fs/promises')).readdir(root);
  const [name] = await entries;
  const envelope = JSON.parse(await readFile(join(root, name), 'utf8'));
  assert.equal(envelope.receiptId, 'release-1:prepare-worker');
  await (await import('node:fs/promises')).unlink(join(root, name));
  await symlink('/dev/null', join(root, name));
  await assert.rejects(store.write('release-1:prepare-worker', second), /unsafe/);
});
