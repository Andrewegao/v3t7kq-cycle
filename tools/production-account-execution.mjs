// Fail-closed execution boundary for the production account release transaction.
//
// This module owns authorization, lease proof, durable intent/result receipts and
// action dispatch. It deliberately does not own credentials or create a network
// client. A reviewed command/API adapter must be injected by the caller. The
// currently provisional Lane B contract can be planned, but the execute path can
// never opt into the test-only provisional override.
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import {join, resolve} from 'node:path';

import {LANE_B_CONTRACT} from './production-account-contract.mjs';
import {
  activatePreparedWorker,
  applyPagesConfiguration,
  preparePagesConfiguration,
  prepareWorkerVersion,
  productionReleasePlanDigest,
  recoverPagesConfiguration,
  recoverWorkerActivation,
  recoverWorkerRollback,
  validateProductionReleasePlan,
} from './production-account-release.mjs';

const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/;
const MAX_AUTHORIZATION_MS = 30 * 60_000;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const CONFIRMATION = 'AUTHORIZE WEATHERX PRODUCTION MUTATION';

export const PRODUCTION_ACCOUNT_ACTIONS = Object.freeze([
  'prepare-worker',
  'activate-worker',
  'recover-worker-activation',
  'recover-worker-rollback',
  'prepare-pages',
  'apply-pages',
  'recover-pages',
]);

const MUTATING_ACTIONS = new Set(PRODUCTION_ACCOUNT_ACTIONS);
const NEEDS_INPUT_RECEIPT = new Set([
  'activate-worker',
  'recover-worker-activation',
  'recover-worker-rollback',
  'apply-pages',
  'recover-pages',
]);

const digest = value => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  assert.ok(value === null || ['string','number','boolean'].includes(typeof value),
    'execution value is not canonical JSON');
  if (typeof value === 'number') assert.ok(Number.isFinite(value), 'execution value contains a non-finite number');
  return JSON.stringify(value);
}

function record(value, message) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), message);
  return value;
}

function exactKeys(value, names, message) {
  record(value, message);
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), message);
  return value;
}

function parseTimestamp(value, name) {
  assert.match(value ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, `${name} is invalid`);
  const milliseconds = Date.parse(value);
  assert.ok(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value, `${name} is invalid`);
  return milliseconds;
}

function targetDigest(plan) {
  return digest(canonical({target: plan.target, identities: plan.identities, candidateBinding: plan.candidateBinding}));
}

function requestDigest(request) {
  return digest(canonical({
    schemaVersion: request.schemaVersion,
    kind: request.kind,
    mode: request.mode,
    action: request.action,
    planDigest: productionReleasePlanDigest(request.plan),
    inputReceiptDigest: request.inputReceipt === null ? null : digest(canonical(request.inputReceipt)),
  }));
}

export function validateProductionExecutionRequest(value) {
  const request = exactKeys(value,
    ['schemaVersion','kind','mode','action','plan','inputReceipt','authorization'],
    'invalid production execution request');
  assert.equal(request.schemaVersion, 1);
  assert.equal(request.kind, 'weatherx-production-account-execution-request');
  assert.ok(request.mode === 'plan' || request.mode === 'execute', 'execution mode must be plan or execute');
  assert.ok(PRODUCTION_ACCOUNT_ACTIONS.includes(request.action), 'invalid production execution action');
  if (NEEDS_INPUT_RECEIPT.has(request.action)) record(request.inputReceipt, 'input transaction receipt is required');
  else assert.equal(request.inputReceipt, null, 'input transaction receipt is not accepted for this action');
  if (request.mode === 'plan') assert.equal(request.authorization, null, 'plan mode cannot carry mutation authorization');
  return request;
}

export function validateProductionMutationAuthorization(value, request, plan, now = Date.now()) {
  assert.ok(MUTATING_ACTIONS.has(request.action), 'action is not a production mutation');
  const authorization = exactKeys(value,
    ['schemaVersion','kind','confirmation','action','transactionId','leaseOwner','contractDigest','planDigest','targetDigest','issuedAt','expiresAt'],
    'invalid production mutation authorization');
  assert.equal(authorization.schemaVersion, 1);
  assert.equal(authorization.kind, 'weatherx-production-mutation-authorization');
  assert.equal(authorization.confirmation, CONFIRMATION, 'explicit production mutation confirmation is required');
  assert.equal(authorization.action, request.action, 'authorization action differs');
  assert.equal(authorization.transactionId, plan.transactionId, 'authorization transaction differs');
  assert.equal(authorization.leaseOwner, plan.leaseOwner, 'authorization lease owner differs');
  assert.equal(authorization.contractDigest, plan.contractDigest, 'authorization contract differs');
  assert.equal(authorization.planDigest, productionReleasePlanDigest(plan), 'authorization plan differs');
  assert.equal(authorization.targetDigest, targetDigest(plan), 'authorization target or artifact differs');
  const issuedAt = parseTimestamp(authorization.issuedAt, 'authorization issuedAt');
  const expiresAt = parseTimestamp(authorization.expiresAt, 'authorization expiresAt');
  assert.ok(Number.isSafeInteger(now), 'execution clock is invalid');
  assert.ok(issuedAt <= now && expiresAt > now, 'production mutation authorization is not currently valid');
  assert.ok(expiresAt - issuedAt > 0 && expiresAt - issuedAt <= MAX_AUTHORIZATION_MS,
    'production mutation authorization lifetime is too long');
  return authorization;
}

function validateLeaseProof(value, plan, action, now) {
  const proof = exactKeys(value,
    ['schemaVersion','kind','held','leaseId','leaseOwner','transactionId','action','planDigest','targetDigest','expiresAt'],
    'invalid exclusive lease proof');
  assert.equal(proof.schemaVersion, 1);
  assert.equal(proof.kind, 'weatherx-production-exclusive-lease-proof');
  assert.equal(proof.held, true, 'exclusive production lease is not held');
  assert.match(proof.leaseId ?? '', ID, 'exclusive production lease identity is invalid');
  assert.equal(proof.leaseOwner, plan.leaseOwner, 'exclusive production lease owner differs');
  assert.equal(proof.transactionId, plan.transactionId, 'exclusive production lease transaction differs');
  assert.equal(proof.action, action, 'exclusive production lease action differs');
  assert.equal(proof.planDigest, productionReleasePlanDigest(plan), 'exclusive production lease plan differs');
  assert.equal(proof.targetDigest, targetDigest(plan), 'exclusive production lease target differs');
  assert.ok(parseTimestamp(proof.expiresAt, 'exclusive production lease expiry') > now,
    'exclusive production lease expired');
  return proof;
}

function blockedReasons(plan) {
  const reasons = [];
  if (LANE_B_CONTRACT.status !== 'final') reasons.push('lane-b-contract-provisional');
  const prices = Object.values(plan.stripe?.priceIds ?? {});
  if (prices.length !== 2 || prices.some(value => !/^price_[A-Za-z0-9_]{1,250}$/.test(value ?? '') ||
      /replace|test|provisional|approval|required|unusable/i.test(value))) {
    reasons.push('owner-approved-live-stripe-prices-required');
  }
  return reasons;
}

export function validateProductionInputReceiptBinding(request, plan) {
  if (!NEEDS_INPUT_RECEIPT.has(request.action)) return;
  const receipt = record(request.inputReceipt, 'input transaction receipt is required');
  assert.equal(receipt.transactionId, plan.transactionId, 'input receipt transaction differs from the authorized plan');
  assert.equal(receipt.leaseOwner, plan.leaseOwner, 'input receipt lease owner differs from the authorized plan');
  assert.equal(receipt.contractDigest, plan.contractDigest, 'input receipt contract differs from the authorized plan');
  assert.equal(receipt.planDigest, productionReleasePlanDigest(plan),
    'input receipt plan digest differs from the authorized plan');
  assert.deepEqual(receipt.plan, plan, 'input receipt plan differs from the authorized plan');
}

export function planProductionAccountExecution(value, dependencies) {
  const request = validateProductionExecutionRequest(value);
  assert.equal(request.mode, 'plan', 'planProductionAccountExecution accepts plan mode only');
  const options = {
    candidate: dependencies?.candidate,
    qualification: dependencies?.qualification,
    // The override exists only here, where authorization is forbidden and no adapter
    // is accepted or called. It provides a useful blocked preview for the provisional contract.
    allowProvisional: true,
  };
  const plan = validateProductionReleasePlan(request.plan, options);
  validateProductionInputReceiptBinding(request, plan);
  const blockers = blockedReasons(plan);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'weatherx-production-account-execution-preview',
    mode: 'plan',
    action: request.action,
    executable: blockers.length === 0,
    transactionId: plan.transactionId,
    leaseOwner: plan.leaseOwner,
    contractDigest: plan.contractDigest,
    planDigest: productionReleasePlanDigest(plan),
    targetDigest: targetDigest(plan),
    requestDigest: requestDigest(request),
    target: structuredClone(plan.target),
    identities: structuredClone(plan.identities),
    modes: structuredClone(plan.modes),
    stripePriceIds: structuredClone(plan.stripe.priceIds),
    blockers,
  });
}

function safeFailureReceipt(intent) {
  return {...intent, phase: 'failed', failure: {code: 'production-operation-failed'}};
}

async function writeAndRead(receipts, id, value) {
  assert.equal(typeof receipts?.write, 'function', 'durable receipt writer is required');
  assert.equal(typeof receipts?.read, 'function', 'durable receipt readback is required');
  await receipts.write(id, structuredClone(value));
  const stored = await receipts.read(id);
  assert.deepEqual(stored, value, `durable receipt ${id} readback differs`);
  return stored;
}

async function dispatch(action, request, dependencies, strictOptions) {
  const input = request.inputReceipt;
  switch (action) {
    case 'prepare-worker':
      return prepareWorkerVersion(request.plan, dependencies.workerClient, strictOptions);
    case 'activate-worker':
      return activatePreparedWorker(input, dependencies.workerClient, {...strictOptions, verify: dependencies.verifyWorker});
    case 'recover-worker-activation':
      return recoverWorkerActivation(input, dependencies.workerClient, {...strictOptions, verify: dependencies.verifyWorker});
    case 'recover-worker-rollback':
      return recoverWorkerRollback(input, dependencies.workerClient, strictOptions);
    case 'prepare-pages':
      return preparePagesConfiguration(request.plan, dependencies.pagesClient, {
        ...strictOptions,
        storeReceipt: receipt => writeAndRead(dependencies.receipts,
          `${request.plan.transactionId}:pages-preimage`, receipt),
      });
    case 'apply-pages':
      return applyPagesConfiguration(input, dependencies.pagesClient, {
        ...strictOptions,
        verify: dependencies.verifyPages,
        readStoredReceipt: () => dependencies.receipts.read(`${request.plan.transactionId}:pages-preimage`),
      });
    case 'recover-pages':
      return recoverPagesConfiguration(input, dependencies.pagesClient, {
        ...strictOptions,
        verify: dependencies.verifyPages,
        readStoredReceipt: () => dependencies.receipts.read(`${request.plan.transactionId}:pages-preimage`),
      });
    default:
      assert.fail('unreachable production execution action');
  }
}

export async function executeProductionAccountTransaction(value, dependencies, now = Date.now()) {
  const request = validateProductionExecutionRequest(value);
  assert.equal(request.mode, 'execute', 'executeProductionAccountTransaction accepts execute mode only');
  assert.ok(Number.isSafeInteger(now), 'execution clock is invalid');

  // No caller-supplied options are spread here. In particular, the provisional
  // override used by unit tests and plan mode cannot reach a mutation path.
  const strictOptions = {candidate: dependencies?.candidate, qualification: dependencies?.qualification};
  const plan = validateProductionReleasePlan(request.plan, strictOptions);
  validateProductionInputReceiptBinding(request, plan);
  const authorization = validateProductionMutationAuthorization(request.authorization, request, plan, now);
  assert.equal(typeof dependencies?.lease?.assertHeld, 'function', 'exclusive production lease verifier is required');
  const lease = validateLeaseProof(await dependencies.lease.assertHeld({
    leaseOwner: plan.leaseOwner,
    transactionId: plan.transactionId,
    action: request.action,
    planDigest: productionReleasePlanDigest(plan),
    targetDigest: targetDigest(plan),
    target: structuredClone(plan.target),
  }), plan, request.action, now);

  const receiptId = `${plan.transactionId}:${request.action}`;
  const intent = {
    schemaVersion: 1,
    kind: 'weatherx-production-account-execution-receipt',
    receiptId,
    phase: 'authorized-pre-mutation',
    action: request.action,
    transactionId: plan.transactionId,
    leaseOwner: plan.leaseOwner,
    contractDigest: plan.contractDigest,
    planDigest: productionReleasePlanDigest(plan),
    targetDigest: targetDigest(plan),
    requestDigest: requestDigest(request),
    authorization: {
      kind: authorization.kind,
      action: authorization.action,
      issuedAt: authorization.issuedAt,
      expiresAt: authorization.expiresAt,
    },
    lease: structuredClone(lease),
  };
  await writeAndRead(dependencies.receipts, receiptId, intent);
  try {
    const transaction = await dispatch(request.action, request, dependencies, strictOptions);
    const completed = {...intent, phase: 'completed', transaction: structuredClone(transaction)};
    await writeAndRead(dependencies.receipts, receiptId, completed);
    return completed;
  } catch (error) {
    const failed = safeFailureReceipt(intent);
    await writeAndRead(dependencies.receipts, receiptId, failed);
    throw new Error('production account transaction failed; inspect the sanitized durable receipt', {cause: error});
  }
}

async function assertSafeDirectory(path) {
  await mkdir(path, {recursive: true, mode: 0o700});
  const stat = await lstat(path);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'receipt directory must be a real directory');
}

export function createProductionReceiptStore(directory) {
  const root = resolve(directory);
  const pathFor = id => {
    assert.match(id ?? '', /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,319}$/, 'invalid receipt identity');
    return join(root, `${digest(id)}.json`);
  };
  return Object.freeze({
    async write(id, value) {
      record(value, 'receipt value is required');
      const body = `${JSON.stringify({receiptId: id, value}, null, 2)}\n`;
      assert.ok(Buffer.byteLength(body) <= MAX_RECEIPT_BYTES, 'receipt exceeds size limit');
      await assertSafeDirectory(root);
      const destination = pathFor(id);
      const current = await lstat(destination).catch(() => null);
      assert.ok(!current || (current.isFile() && !current.isSymbolicLink() && current.nlink === 1),
        'receipt destination is unsafe');
      const temporary = join(root, `.${digest(id)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(body, 'utf8');
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporary, destination);
      } finally {
        await handle?.close().catch(() => {});
        await rm(temporary, {force: true}).catch(() => {});
      }
    },
    async read(id) {
      await assertSafeDirectory(root);
      const path = pathFor(id);
      const stat = await lstat(path).catch(() => null);
      assert.ok(stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 &&
        stat.size <= MAX_RECEIPT_BYTES, 'durable receipt is missing or unsafe');
      const envelope = JSON.parse(await readFile(path, 'utf8'));
      exactKeys(envelope, ['receiptId','value'], 'invalid durable receipt envelope');
      assert.equal(envelope.receiptId, id, 'durable receipt identity differs');
      return envelope.value;
    },
  });
}

export const PRODUCTION_MUTATION_CONFIRMATION = CONFIRMATION;
