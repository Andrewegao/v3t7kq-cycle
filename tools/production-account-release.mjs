// Pure release-transaction framework. It has no Cloudflare, GitHub, Wrangler, Stripe,
// filesystem, or network client. Callers must inject a reviewed adapter and the default
// validation path refuses the provisional Lane B contract.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

import {
  LANE_B_CONTRACT,
  LANE_B_CONTRACT_DIGEST,
  assertLaneBContractReady,
  assertProductionIdentifiers,
  productionContractCanonical,
  validateProductionPagesConfiguration,
} from './production-account-contract.mjs';
import {validateCandidate} from './ui-candidate.mjs';
import {PRODUCTION_ACCOUNT_PROFILE, profileDigest, requireProductionProfile} from './ui-staging-models.mjs';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,159}$/;
const RELEASE_FAILURE_CODES = new Set([
  'worker-verification-failed','worker-rollback-outcome-unknown',
  'pages-verification-failed','pages-restore-outcome-unknown',
]);

const digest = value => createHash('sha256').update(value).digest('hex');

function record(value, message) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), message);
  return value;
}

function exactKeys(value, names, message) {
  record(value, message);
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), message);
  return value;
}

function exactRoutes(routes) {
  assert.ok(Array.isArray(routes), 'production route inventory is required');
  assert.deepEqual(routes, LANE_B_CONTRACT.target.routes, 'production route inventory differs from the frozen contract');
  assert.ok(routes.every(route => !/^weatherx\.org\/(?:data|data-atmos)(?:\/|\*)/.test(route)),
    'public data routes must remain on the isolated data Worker');
}

function validateIdentity(value, name, expression = DIGEST) {
  assert.match(value ?? '', expression, `${name} is invalid`);
  return value;
}

export function validateProductionReleasePlan(value, options = {}) {
  assertLaneBContractReady(options);
  const plan = exactKeys(value,
    ['schemaVersion','kind','transactionId','leaseOwner','contractDigest','candidateBinding','identities','target','modes','stripe','rollback','desired','compatibility'],
    'invalid production account release plan');
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.kind, 'weatherx-production-account-release-plan');
  assert.match(plan.transactionId ?? '', ID, 'invalid release transaction identity');
  assert.match(plan.leaseOwner ?? '', ID, 'invalid release lease owner');
  assert.equal(plan.contractDigest, LANE_B_CONTRACT_DIGEST, 'Lane B contract digest changed');
  const expectedBinding = productionCandidateBinding(options.candidate, options.qualification, options);
  assert.deepEqual(plan.candidateBinding, expectedBinding,
    'release plan is not bound to the validated qualified candidate');

  const identities = exactKeys(plan.identities,
    ['atmosSha','controllerSha','profileDigest','pipelineDigest','artifactDigest'], 'invalid release identities');
  validateIdentity(identities.atmosSha, 'Atmos SHA', SHA);
  validateIdentity(identities.controllerSha, 'controller SHA', SHA);
  validateIdentity(identities.profileDigest, 'profile digest');
  validateIdentity(identities.pipelineDigest, 'pipeline digest');
  validateIdentity(identities.artifactDigest, 'artifact digest');
  assert.equal(identities.controllerSha, LANE_B_CONTRACT.requiredAtmosControllerSha,
    'controller SHA differs from the Lane B handoff');
  assert.equal(identities.profileDigest, profileDigest(PRODUCTION_ACCOUNT_PROFILE),
    'production account profile changed');
  assert.deepEqual(identities, {
    atmosSha: expectedBinding.atmosSha,
    controllerSha: expectedBinding.controllerSha,
    profileDigest: expectedBinding.profileDigest,
    pipelineDigest: expectedBinding.pipelineDigest,
    artifactDigest: expectedBinding.artifactDigest,
  }, 'release identities differ from the validated qualified candidate');

  const target = exactKeys(plan.target,
    ['cloudflareAccountId','workerName','pagesProject','origin','databaseName','routes'], 'invalid production target');
  assert.deepEqual(target, LANE_B_CONTRACT.target, 'production target differs from the Lane B contract');
  exactRoutes(target.routes);

  const modes = exactKeys(plan.modes,
    ['authMode','billingMode','billingPurchaseMode','dataAuthMode','stripeEnvironment'],
    'invalid production modes');
  assert.deepEqual(modes, LANE_B_CONTRACT.modes, 'production modes differ from the Lane B contract');
  assert.equal(modes.authMode, 'observe', 'production account authentication must begin in observe mode');
  assert.equal(modes.billingMode, 'enabled', 'billing servicing and webhooks must be enabled');
  assert.equal(modes.billingPurchaseMode, 'closed', 'purchase creation must remain closed during preparation');
  assert.equal(modes.dataAuthMode, 'public', 'public weather must remain public');
  assert.equal(modes.stripeEnvironment, 'live', 'production Stripe environment must be live');

  const stripe = exactKeys(plan.stripe, ['environment','priceIds'], 'invalid Stripe release configuration');
  assert.equal(stripe.environment, modes.stripeEnvironment, 'production Stripe environment differs from the release mode');
  const prices = exactKeys(stripe.priceIds, ['subscription','pass'], 'invalid Stripe Price inventory');
  assert.deepEqual(prices, LANE_B_CONTRACT.approvedStripePriceIds,
    'Stripe Price inventory differs from the exact owner-approved contract');
  if (LANE_B_CONTRACT.status === 'final') {
    for (const [name, price] of Object.entries(prices)) {
      assert.match(price ?? '', /^price_[A-Za-z0-9_]{1,250}$/, `invalid ${name} Stripe Price`);
      assert.ok(!/replace|test|provisional|approval|required|unusable/i.test(price),
        `${name} Stripe Price is a placeholder or test identifier`);
    }
  }

  const rollback = exactKeys(plan.rollback, ['worker','pages'], 'invalid rollback identities');
  exactKeys(rollback.worker, ['versionId','deploymentId','configDigest'], 'invalid Worker rollback identity');
  exactKeys(rollback.pages, ['configDigest','canonicalDeploymentId','payload'], 'invalid Pages rollback identity');
  for (const [name, id] of [['Worker version',rollback.worker.versionId],['Worker deployment',rollback.worker.deploymentId],
    ['Pages deployment',rollback.pages.canonicalDeploymentId]]) assert.match(id ?? '', ID, `invalid ${name} identity`);
  validateIdentity(rollback.worker.configDigest, 'Worker rollback config digest');
  validateIdentity(rollback.pages.configDigest, 'Pages rollback config digest');
  validateProductionPagesConfiguration(rollback.pages.payload);

  const desired = exactKeys(plan.desired, ['worker','pages'], 'invalid desired release state');
  exactKeys(desired.worker, ['sourceDigest','configDigest'], 'invalid desired Worker state');
  exactKeys(desired.pages, ['configDigest','payload'], 'invalid desired Pages state');
  validateIdentity(desired.worker.sourceDigest, 'Worker source digest');
  validateIdentity(desired.worker.configDigest, 'Worker config digest');
  validateIdentity(desired.pages.configDigest, 'Pages config digest');
  assert.notEqual(desired.worker.configDigest, rollback.worker.configDigest, 'Worker configuration did not change');
  assert.notEqual(desired.pages.configDigest, rollback.pages.configDigest, 'Pages configuration did not change');
  validateProductionPagesConfiguration(desired.pages.payload);

  const compatibility = exactKeys(plan.compatibility,
    ['oldUi','oldWorkerOnAdditiveSchema','schemaStrategy','purchaseClosedDuringPreparation'],
    'invalid compatibility policy');
  assert.equal(compatibility.oldUi, true, 'old UI compatibility is required');
  assert.equal(compatibility.oldWorkerOnAdditiveSchema, true, 'old Worker must remain compatible with the additive schema');
  assert.equal(compatibility.schemaStrategy, 'retain-additive', 'schema rollback is not part of the Worker transaction');
  assert.equal(compatibility.purchaseClosedDuringPreparation, true, 'purchase creation must remain closed during preparation');
  assertProductionIdentifiers({target, stripe, desired});
  return plan;
}

function validateQualification(candidate, qualification) {
  record(qualification, 'production candidate qualification receipt is required');
  assert.deepEqual(candidate.qualification, qualification,
    'qualification receipt differs from the validated candidate');
  assert.equal(qualification.origin, 'https://staging.weatherx.org');
  assert.equal(qualification.artifactDigest, candidate.artifactDigest);
  assert.equal(qualification.fullTests, true);
  assert.equal(qualification.weatherLab, true);
  assert.equal(qualification.builtRuntime, true);
  assert.equal(qualification.probes, 3);
  assert.match(qualification.deploymentId ?? '', /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(qualification.qualifiedAt)), 'qualification timestamp is invalid');
  return qualification;
}

export function productionCandidateBinding(candidate, qualification, options = {}) {
  assertLaneBContractReady(options);
  validateCandidate(candidate);
  requireProductionProfile(candidate.profile);
  assert.deepEqual(candidate.profile, PRODUCTION_ACCOUNT_PROFILE,
    'candidate does not use the production account profile');
  validateQualification(candidate, qualification);
  const fields = {
    contractDigest: candidate.profile.accountContractSha256,
    profileDigest: profileDigest(candidate.profile),
    pipelineDigest: candidate.pipelineDigest,
    artifactDigest: candidate.artifactDigest,
    atmosSha: candidate.sourceSha,
    controllerSha: candidate.controlSha,
    qualificationDigest: digest(productionContractCanonical(qualification)),
  };
  assert.equal(fields.contractDigest, LANE_B_CONTRACT_DIGEST);
  assert.equal(fields.atmosSha, LANE_B_CONTRACT.requiredAtmosSourceSha,
    'candidate source differs from the exact reviewed Atmos integration candidate');
  assert.equal(fields.controllerSha, LANE_B_CONTRACT.requiredAtmosControllerSha,
    'candidate controller differs from the Lane B contract');
  return Object.freeze({...fields, bindingDigest: digest(productionContractCanonical(fields))});
}

export function validateProductionCandidateBinding(binding, candidate, qualification, options = {}) {
  const expected = productionCandidateBinding(candidate, qualification, options);
  assert.deepEqual(binding, expected, 'candidate identity changed: qualify a fresh exact artifact');
  return binding;
}

export function productionReleasePlanDigest(plan) {
  return digest(productionContractCanonical(plan));
}

function validateSafetyVerification(value, receipt, {candidateUi = false} = {}) {
  const names = ['oldUi','purchase','servicing','publicData','stripe',...(candidateUi ? ['candidateUi'] : [])];
  const verification = exactKeys(value, names, 'invalid structured production verification receipt');
  const oldUi = exactKeys(verification.oldUi, ['compatible','deploymentId'], 'invalid old UI verification');
  assert.equal(oldUi.compatible, true, 'old UI compatibility was not verified');
  assert.equal(oldUi.deploymentId, receipt.plan.rollback.pages.canonicalDeploymentId,
    'old UI verification used the wrong deployment');
  if (candidateUi) {
    const candidate = exactKeys(verification.candidateUi, ['compatible','artifactDigest'],
      'invalid candidate UI verification');
    assert.equal(candidate.compatible, true, 'candidate UI compatibility was not verified');
    assert.equal(candidate.artifactDigest, receipt.identities.artifactDigest,
      'candidate UI verification used the wrong artifact');
  }
  const purchase = exactKeys(verification.purchase, ['mode','creationBlocked'], 'invalid purchase verification');
  assert.equal(purchase.mode, receipt.modes.billingPurchaseMode);
  assert.equal(purchase.creationBlocked, true, 'new purchase creation was not proven closed');
  const servicing = exactKeys(verification.servicing, ['billingMode','portalAvailable','webhooksVerified'],
    'invalid billing servicing verification');
  assert.equal(servicing.billingMode, receipt.modes.billingMode);
  assert.equal(servicing.portalAvailable, true, 'billing portal servicing was not verified');
  assert.equal(servicing.webhooksVerified, true, 'billing webhook servicing was not verified');
  const publicData = exactKeys(verification.publicData, ['authMode','readable'], 'invalid public data verification');
  assert.equal(publicData.authMode, receipt.modes.dataAuthMode);
  assert.equal(publicData.readable, true, 'public weather access was not verified');
  const stripe = exactKeys(verification.stripe, ['environment','livemode'], 'invalid Stripe live-mode verification');
  assert.equal(stripe.environment, receipt.modes.stripeEnvironment);
  assert.equal(stripe.livemode, true, 'Stripe live mode was not verified');
  return verification;
}

function assertWorkerBefore(snapshot, plan, {withEtag = true} = {}) {
  record(snapshot, 'Worker deployment snapshot is required');
  assert.equal(snapshot.workerName, plan.target.workerName, 'wrong Worker target');
  assert.equal(snapshot.versionId, plan.rollback.worker.versionId, 'Worker rollback version is no longer active');
  assert.equal(snapshot.deploymentId, plan.rollback.worker.deploymentId, 'Worker rollback deployment changed');
  assert.equal(snapshot.configDigest, plan.rollback.worker.configDigest, 'Worker rollback configuration changed');
  if (withEtag) assert.match(snapshot.etag ?? '', ID, 'Worker CAS identity is missing');
  return snapshot;
}

function assertWorkerCandidate(snapshot, receipt) {
  record(snapshot, 'Worker candidate snapshot is required');
  assert.equal(snapshot.workerName, receipt.target.workerName, 'wrong Worker target');
  assert.equal(snapshot.versionId, receipt.candidate.versionId, 'prepared Worker is not active');
  assert.equal(snapshot.configDigest, receipt.candidate.configDigest, 'active Worker configuration differs from preparation');
  assert.equal(snapshot.mutationOwner, receipt.leaseOwner, 'Worker mutation is not owned by this transaction');
  assert.match(snapshot.etag ?? '', ID, 'Worker CAS identity is missing');
  return snapshot;
}

function workerReceiptBase(plan, before, candidate) {
  return {
    schemaVersion: 1,
    kind: 'weatherx-account-worker-transaction-receipt',
    transactionId: plan.transactionId,
    leaseOwner: plan.leaseOwner,
    contractDigest: plan.contractDigest,
    planDigest: productionReleasePlanDigest(plan),
    target: structuredClone(plan.target),
    modes: structuredClone(plan.modes),
    identities: structuredClone(plan.identities),
    before: structuredClone(before),
    candidate: structuredClone(candidate),
    schema: {action: 'retain-additive', databaseRestoreAttempted: false},
    plan: structuredClone(plan),
  };
}

function validatePreparedReceipt(receipt, options = {}, phases = ['prepared','prepared-after-interruption']) {
  record(receipt, 'prepared Worker receipt is required');
  assert.equal(receipt.kind, 'weatherx-account-worker-transaction-receipt');
  assert.ok(phases.includes(receipt.phase), `Worker receipt phase ${receipt.phase} is not recoverable here`);
  const plan = validateProductionReleasePlan(receipt.plan, options);
  assert.equal(receipt.planDigest, productionReleasePlanDigest(plan), 'Worker plan changed after preparation');
  assert.equal(receipt.contractDigest, plan.contractDigest);
  assert.equal(receipt.transactionId, plan.transactionId);
  assert.equal(receipt.leaseOwner, plan.leaseOwner);
  assert.deepEqual(receipt.target, plan.target);
  assert.deepEqual(receipt.modes, plan.modes);
  assert.deepEqual(receipt.identities, plan.identities);
  assertWorkerBefore(receipt.before, plan);
  assert.equal(receipt.candidate.sourceDigest, plan.desired.worker.sourceDigest);
  assert.equal(receipt.candidate.configDigest, plan.desired.worker.configDigest);
  assert.match(receipt.candidate.versionId ?? '', ID, 'prepared Worker version identity is missing');
  assert.notEqual(receipt.candidate.versionId, receipt.before.versionId, 'prepared Worker must be a new inactive version');
  assert.deepEqual(receipt.schema, {action: 'retain-additive', databaseRestoreAttempted: false});
  return plan;
}

function workerUploadTag(plan, options) {
  const authorization = exactKeys(options.preparationAuthorization,
    ['approvalId','requestDigest'], 'Worker preparation authorization identity is required');
  assert.match(authorization.approvalId ?? '', ID, 'invalid Worker preparation approval identity');
  assert.match(authorization.requestDigest ?? '', DIGEST, 'invalid Worker preparation request digest');
  return `wx-prod-${digest(productionContractCanonical({
    transactionId: plan.transactionId,
    approvalId: authorization.approvalId,
    requestDigest: authorization.requestDigest,
    workerName: plan.target.workerName,
  })).slice(0,48)}`;
}

function validateWorkerPreparationIntent(intent, options = {}) {
  exactKeys(intent, ['schemaVersion','kind','transactionId','leaseOwner','contractDigest','planDigest',
    'approvalId','requestDigest','uploadTag','before','plan'], 'invalid Worker preparation intent');
  assert.equal(intent.schemaVersion, 1);
  assert.equal(intent.kind, 'weatherx-account-worker-preparation-intent');
  const plan = validateProductionReleasePlan(intent.plan, options);
  assert.equal(intent.transactionId, plan.transactionId);
  assert.equal(intent.leaseOwner, plan.leaseOwner);
  assert.equal(intent.contractDigest, plan.contractDigest);
  assert.equal(intent.planDigest, productionReleasePlanDigest(plan));
  assertWorkerBefore(intent.before, plan);
  assert.equal(intent.uploadTag, workerUploadTag(plan, {preparationAuthorization: {
    approvalId: intent.approvalId, requestDigest: intent.requestDigest,
  }}));
  return plan;
}

export async function prepareWorkerUploadIntent(value, client, options = {}) {
  const plan = validateProductionReleasePlan(value, options);
  assert.equal(typeof client?.readDeployment, 'function', 'Worker client is missing readDeployment');
  const before = assertWorkerBefore(await client.readDeployment(), plan);
  const immediate = assertWorkerBefore(await client.readDeployment(), plan);
  assert.equal(immediate.etag, before.etag, 'Worker changed before inactive upload');
  const authorization = options.preparationAuthorization;
  const uploadTag = workerUploadTag(plan, options);
  return {
    schemaVersion: 1,
    kind: 'weatherx-account-worker-preparation-intent',
    transactionId: plan.transactionId,
    leaseOwner: plan.leaseOwner,
    contractDigest: plan.contractDigest,
    planDigest: productionReleasePlanDigest(plan),
    approvalId: authorization.approvalId,
    requestDigest: authorization.requestDigest,
    uploadTag,
    before: structuredClone(before),
    plan: structuredClone(plan),
  };
}

export async function completeWorkerPreparation(intent, client, options = {}) {
  const plan = validateWorkerPreparationIntent(intent, options);
  for (const method of ['uploadVersion','readVersion','readDeployment']) assert.equal(typeof client?.[method], 'function', `Worker client is missing ${method}`);
  const candidate = await client.uploadVersion({
    workerName: plan.target.workerName,
    sourceDigest: plan.desired.worker.sourceDigest,
    configDigest: plan.desired.worker.configDigest,
    tag: intent.uploadTag,
    activate: false,
  });
  record(candidate, 'Worker upload did not return a version identity');
  assert.match(candidate.versionId ?? '', ID, 'invalid uploaded Worker version identity');
  assert.notEqual(candidate.versionId, intent.before.versionId, 'inactive upload reused the active Worker version');
  assert.equal(candidate.sourceDigest, plan.desired.worker.sourceDigest, 'uploaded Worker source digest changed');
  assert.equal(candidate.configDigest, plan.desired.worker.configDigest, 'uploaded Worker config digest changed');
  assert.deepEqual(await client.readVersion(candidate.versionId), candidate, 'uploaded Worker version readback differs');
  const unchanged = assertWorkerBefore(await client.readDeployment(), plan);
  assert.equal(unchanged.etag, intent.before.etag, 'inactive upload changed the active Worker deployment');
  return {...workerReceiptBase(plan, intent.before, candidate), phase: 'prepared', uploadTag: intent.uploadTag,
    preparationApprovalId: intent.approvalId, preparationRequestDigest: intent.requestDigest};
}

export async function prepareWorkerVersion(value, client, options = {}) {
  assert.equal(typeof options.storePreparationIntent, 'function', 'durable Worker preparation intent storage is required');
  const intent = await prepareWorkerUploadIntent(value, client, options);
  await options.storePreparationIntent(structuredClone(intent));
  return completeWorkerPreparation(intent, client, options);
}

export async function recoverWorkerPreparation(intent, client, options = {}) {
  const plan = validateWorkerPreparationIntent(intent, options);
  for (const method of ['listVersionsByTag','readVersion','readDeployment']) assert.equal(typeof client?.[method], 'function', `Worker client is missing ${method}`);
  const current = assertWorkerBefore(await client.readDeployment(), plan);
  assert.equal(current.etag, intent.before.etag, 'active Worker changed during preparation recovery');
  const matches = await client.listVersionsByTag(intent.uploadTag);
  assert.ok(Array.isArray(matches), 'Worker tagged-version listing is invalid');
  assert.equal(matches.length, 1, 'Worker preparation recovery requires exactly one tagged version');
  const summary = exactKeys(matches[0], ['versionId','tag'], 'Worker tagged-version summary is invalid');
  assert.equal(summary.tag, intent.uploadTag, 'Worker tagged-version listing returned a different tag');
  assert.match(summary.versionId ?? '', ID, 'Worker tagged-version identity is invalid');
  const candidate = await client.readVersion(summary.versionId);
  record(candidate, 'Worker preparation recovery readback is missing');
  assert.equal(candidate.versionId, summary.versionId, 'Worker preparation recovery version changed');
  assert.equal(candidate.sourceDigest, plan.desired.worker.sourceDigest, 'recovered Worker source digest changed');
  assert.equal(candidate.configDigest, plan.desired.worker.configDigest, 'recovered Worker config digest changed');
  return {...workerReceiptBase(plan, intent.before, candidate), phase: 'prepared-after-interruption',
    uploadTag: intent.uploadTag, preparationApprovalId: intent.approvalId,
    preparationRequestDigest: intent.requestDigest};
}

function foreignWorker(snapshot, receipt) {
  const before = snapshot.versionId === receipt.before.versionId
    && snapshot.deploymentId === receipt.before.deploymentId
    && snapshot.configDigest === receipt.before.configDigest
    && snapshot.etag === receipt.before.etag;
  const candidate = snapshot.versionId === receipt.candidate.versionId
    && snapshot.configDigest === receipt.candidate.configDigest
    && snapshot.mutationOwner === receipt.leaseOwner;
  return !before && !candidate;
}

function workerRestored(snapshot, receipt) {
  return snapshot.workerName === receipt.target.workerName
    && snapshot.versionId === receipt.before.versionId
    && snapshot.configDigest === receipt.before.configDigest
    && (snapshot.mutationOwner === receipt.leaseOwner
      || (snapshot.deploymentId === receipt.before.deploymentId && snapshot.etag === receipt.before.etag));
}

function stableFailure(code) {
  assert.ok(RELEASE_FAILURE_CODES.has(code), 'invalid-release-failure-code');
  return {code};
}

function rolledBackWorkerReceipt(receipt, after, failureCode, phase = 'rolled-back') {
  return {...receipt, phase, after: structuredClone(after),
    failure: stableFailure(failureCode)};
}

async function rollbackOwnedWorker(receipt, client, failureCode) {
  const current = await client.readDeployment();
  if (foreignWorker(current, receipt) || current.mutationOwner !== receipt.leaseOwner) {
    throw new Error('foreign writer changed the Worker; refusing rollback overwrite');
  }
  assertWorkerCandidate(current, receipt);
  let restored;
  try {
    restored = await client.rollbackVersion({
      workerName: receipt.target.workerName,
      versionId: receipt.before.versionId,
      expectedEtag: current.etag,
      owner: receipt.leaseOwner,
    });
  } catch (rollbackError) {
    const observed = await client.readDeployment();
    if (workerRestored(observed, receipt)) {
      return rolledBackWorkerReceipt(receipt, observed, failureCode, 'rolled-back-after-interruption');
    }
    if (!foreignWorker(observed, receipt)) {
      return {...receipt, phase: 'rollback-pending', after: structuredClone(observed),
        failure: stableFailure(failureCode),
        recovery: stableFailure('worker-rollback-outcome-unknown')};
    }
    throw new Error('foreign writer changed the Worker during ambiguous rollback', {cause: rollbackError});
  }
  const after = await client.readDeployment();
  assert.ok(workerRestored(after, receipt), 'Worker rollback readback did not restore the prior version and configuration');
  assert.equal(after.versionId, receipt.before.versionId, 'Worker rollback did not restore the prior version');
  assert.equal(after.configDigest, receipt.before.configDigest, 'Worker rollback did not restore the prior configuration');
  assert.equal(restored.versionId, after.versionId);
  return rolledBackWorkerReceipt(receipt, after, failureCode);
}

async function verifyActiveWorker(receipt, client, verify, phase) {
  const after = assertWorkerCandidate(await client.readDeployment(), receipt);
  try {
    const verification = await verify({
      target: receipt.target,
      identities: receipt.identities,
      authMode: receipt.modes.authMode,
      billingMode: receipt.modes.billingMode,
      billingPurchaseMode: receipt.modes.billingPurchaseMode,
      dataAuthMode: receipt.modes.dataAuthMode,
      stripeEnvironment: receipt.modes.stripeEnvironment,
      oldUiCompatible: receipt.plan.compatibility.oldUi,
      active: structuredClone(after),
    });
    validateSafetyVerification(verification, receipt);
    return {...receipt, phase, after: structuredClone(after), verification: structuredClone(verification)};
  } catch (error) {
    return rollbackOwnedWorker(receipt, client, 'worker-verification-failed');
  }
}

export async function recoverWorkerRollback(receipt, client, options = {}) {
  validatePreparedReceipt(receipt, options, ['rollback-pending']);
  assert.equal(typeof client?.readDeployment, 'function', 'Worker client is missing readDeployment');
  assert.equal(typeof client?.rollbackVersion, 'function', 'Worker client is missing rollbackVersion');
  const current = await client.readDeployment();
  if (workerRestored(current, receipt)) {
    return rolledBackWorkerReceipt(receipt, current, receipt.failure?.code ?? 'worker-verification-failed',
      'rolled-back-after-interruption');
  }
  if (foreignWorker(current, receipt)) {
    throw new Error('foreign writer changed the Worker; refusing rollback recovery overwrite');
  }
  return rollbackOwnedWorker(receipt, client, receipt.failure?.code ?? 'worker-verification-failed');
}

export async function recoverWorkerActivation(receipt, client, options = {}) {
  validatePreparedReceipt(receipt, options);
  assert.equal(typeof options.verify, 'function', 'Worker verification callback is required');
  assert.equal(typeof client?.readDeployment, 'function', 'Worker client is missing readDeployment');
  assert.equal(typeof client?.rollbackVersion, 'function', 'Worker client is missing rollbackVersion');
  const current = await client.readDeployment();
  if (foreignWorker(current, receipt)) throw new Error('foreign writer changed the Worker; refusing recovery overwrite');
  if (current.versionId === receipt.before.versionId) {
    assertWorkerBefore(current, receipt.plan);
    return {...receipt, phase: 'interrupted-before-activation', after: structuredClone(current)};
  }
  return verifyActiveWorker(receipt, client, options.verify, 'activated-after-interruption');
}

export async function activatePreparedWorker(receipt, client, options = {}) {
  validatePreparedReceipt(receipt, options);
  assert.equal(typeof options.verify, 'function', 'Worker verification callback is required');
  for (const method of ['readDeployment','activateVersion','rollbackVersion']) assert.equal(typeof client?.[method], 'function', `Worker client is missing ${method}`);
  const current = await client.readDeployment();
  if (foreignWorker(current, receipt)) throw new Error('foreign writer changed the Worker; refusing activation overwrite');
  assertWorkerBefore(current, receipt.plan);
  assert.equal(current.etag, receipt.before.etag, 'Worker CAS identity changed after preparation');
  try {
    await client.activateVersion({
      workerName: receipt.target.workerName,
      versionId: receipt.candidate.versionId,
      expectedEtag: current.etag,
      owner: receipt.leaseOwner,
    });
  } catch (error) {
    const observed = await client.readDeployment();
    if (foreignWorker(observed, receipt)) throw new Error('foreign writer changed the Worker during interrupted activation', {cause: error});
    if (observed.versionId === receipt.before.versionId) throw error;
    return verifyActiveWorker(receipt, client, options.verify, 'activated-after-interruption');
  }
  return verifyActiveWorker(receipt, client, options.verify, 'activated');
}

function assertPagesSnapshot(snapshot, message = 'Pages project snapshot is required') {
  record(snapshot, message);
  assert.match(snapshot.etag ?? '', ID, 'Pages CAS identity is missing');
  validateProductionPagesConfiguration(snapshot.payload);
  return snapshot;
}

function assertPagesBefore(snapshot, plan) {
  assertPagesSnapshot(snapshot);
  assert.equal(snapshot.projectName, plan.target.pagesProject, 'wrong Pages target');
  assert.equal(snapshot.configDigest, plan.rollback.pages.configDigest, 'Pages rollback configuration changed');
  assert.equal(snapshot.canonicalDeploymentId, plan.rollback.pages.canonicalDeploymentId,
    'Pages rollback deployment changed');
  assert.deepEqual(snapshot.payload, plan.rollback.pages.payload,
    'Pages rollback payload differs from the exact approved preimage');
  return snapshot;
}

function pagesBefore(snapshot, receipt) {
  return snapshot.projectName === receipt.target.pagesProject
    && snapshot.configDigest === receipt.before.configDigest
    && snapshot.canonicalDeploymentId === receipt.before.canonicalDeploymentId
    && productionContractCanonical(snapshot.payload) === productionContractCanonical(receipt.before.payload);
}

function pagesDesired(snapshot, receipt) {
  return snapshot.projectName === receipt.target.pagesProject
    && snapshot.configDigest === receipt.plan.desired.pages.configDigest
    && snapshot.canonicalDeploymentId === receipt.before.canonicalDeploymentId
    && snapshot.mutationOwner === receipt.leaseOwner
    && productionContractCanonical(snapshot.payload)
      === productionContractCanonical(receipt.plan.desired.pages.payload);
}

function pagesState(snapshot, receipt) {
  assertPagesSnapshot(snapshot);
  if (pagesBefore(snapshot, receipt)) return 'before';
  if (pagesDesired(snapshot, receipt)) return 'desired';
  return 'foreign';
}

function validatePagesReceipt(receipt, options = {}, phases = ['prepared']) {
  record(receipt, 'Pages configuration receipt is required');
  assert.equal(receipt.kind, 'weatherx-pages-configuration-transaction-receipt');
  assert.ok(phases.includes(receipt.phase), `Pages receipt phase ${receipt.phase} is not recoverable here`);
  const plan = validateProductionReleasePlan(receipt.plan, options);
  assert.equal(receipt.planDigest, productionReleasePlanDigest(plan), 'Pages plan changed after pre-mutation receipt');
  assert.equal(receipt.contractDigest, plan.contractDigest);
  assert.equal(receipt.transactionId, plan.transactionId);
  assert.equal(receipt.leaseOwner, plan.leaseOwner);
  assert.deepEqual(receipt.target, {pagesProject: plan.target.pagesProject, origin: plan.target.origin});
  assert.deepEqual(receipt.candidateBinding, plan.candidateBinding);
  assert.deepEqual(receipt.identities, plan.identities);
  assert.deepEqual(receipt.modes, plan.modes);
  assertPagesBefore(receipt.before, plan);
  return plan;
}

async function requireStoredPagesPreimage(receipt, options) {
  assert.equal(typeof options.readStoredReceipt, 'function', 'durable pre-mutation receipt readback is required');
  const stored = await options.readStoredReceipt(receipt.transactionId);
  validatePagesReceipt(stored, options, ['prepared']);
  for (const field of ['schemaVersion','kind','transactionId','leaseOwner','contractDigest','planDigest',
    'target','identities','modes','before','candidateBinding','plan']) {
    assert.deepEqual(receipt[field], stored[field], `Pages receipt ${field} differs from durable preimage`);
  }
  return stored;
}

export async function preparePagesConfiguration(value, client, options = {}) {
  const plan = validateProductionReleasePlan(value, options);
  assert.equal(typeof options.storeReceipt, 'function', 'durable pre-mutation receipt storage is required');
  assert.equal(typeof client?.readProject, 'function', 'Pages client is missing readProject');
  const before = assertPagesBefore(await client.readProject(), plan);
  const immediate = assertPagesBefore(await client.readProject(), plan);
  assert.equal(immediate.etag, before.etag, 'Pages configuration changed before receipt persistence');
  assert.deepEqual(immediate, before, 'Pages preimage changed before receipt persistence');
  const receipt = {
    schemaVersion: 1,
    kind: 'weatherx-pages-configuration-transaction-receipt',
    phase: 'prepared',
    transactionId: plan.transactionId,
    leaseOwner: plan.leaseOwner,
    contractDigest: plan.contractDigest,
    planDigest: productionReleasePlanDigest(plan),
    target: {pagesProject: plan.target.pagesProject, origin: plan.target.origin},
    identities: structuredClone(plan.identities),
    modes: structuredClone(plan.modes),
    before: structuredClone(before),
    candidateBinding: structuredClone(plan.candidateBinding),
    plan: structuredClone(plan),
  };
  await options.storeReceipt(structuredClone(receipt));
  return receipt;
}

async function rollbackPagesConfiguration(receipt, client, failureCode) {
  const current = await client.readProject();
  const state = pagesState(current, receipt);
  if (state === 'before') {
    return {...receipt, phase: 'rolled-back-after-interruption', after: structuredClone(current),
      failure: stableFailure(failureCode)};
  }
  if (state === 'foreign') {
    throw new Error('foreign writer changed Pages configuration; refusing rollback overwrite');
  }
  try {
    await client.restoreProject({
      projectName: receipt.target.pagesProject,
      payload: structuredClone(receipt.before.payload),
      configDigest: receipt.before.configDigest,
      expectedEtag: current.etag,
      owner: receipt.leaseOwner,
    });
  } catch (restoreError) {
    const observed = await client.readProject();
    const observedState = pagesState(observed, receipt);
    if (observedState === 'before') {
      return {...receipt, phase: 'rolled-back-after-interruption', after: structuredClone(observed),
        failure: stableFailure(failureCode)};
    }
    if (observedState === 'desired') {
      return {...receipt, phase: 'rollback-pending', after: structuredClone(observed),
        failure: stableFailure(failureCode),
        recovery: stableFailure('pages-restore-outcome-unknown')};
    }
    throw new Error('foreign writer changed Pages configuration during ambiguous restore', {cause: restoreError});
  }
  const restored = await client.readProject();
  assert.equal(pagesState(restored, receipt), 'before',
    'Pages rollback full readback differs from the persisted preimage');
  assert.deepEqual(restored.payload, receipt.before.payload,
    'Pages rollback did not restore the exact persisted preimage payload');
  return {...receipt, phase: 'rolled-back', after: structuredClone(restored),
    failure: stableFailure(failureCode)};
}

async function verifyPagesConfiguration(receipt, client, options, phase) {
  const after = await client.readProject();
  assert.equal(pagesState(after, receipt), 'desired',
    'Pages desired configuration full readback differs from the approved payload');
  try {
    const verification = await options.verify({
      oldUiDeploymentId: receipt.before.canonicalDeploymentId,
      candidateArtifactDigest: receipt.identities.artifactDigest,
      before: structuredClone(receipt.before),
      after: structuredClone(after),
    });
    validateSafetyVerification(verification, receipt, {candidateUi: true});
    return {...receipt, phase, applied: structuredClone(after), after: structuredClone(after),
      verification: structuredClone(verification)};
  } catch (error) {
    return rollbackPagesConfiguration(receipt, client, 'pages-verification-failed');
  }
}

export async function applyPagesConfiguration(receipt, client, options = {}) {
  const plan = validatePagesReceipt(receipt, options);
  await requireStoredPagesPreimage(receipt, options);
  assert.equal(typeof options.verify, 'function', 'Pages compatibility verification callback is required');
  for (const method of ['readProject','updateProject','restoreProject']) {
    assert.equal(typeof client?.[method], 'function', `Pages client is missing ${method}`);
  }
  const current = await client.readProject();
  const state = pagesState(current, receipt);
  if (state === 'foreign') throw new Error('foreign writer changed Pages configuration; refusing mutation');
  if (state === 'desired') return verifyPagesConfiguration(receipt, client, options, 'applied-after-interruption');
  assert.equal(current.etag, receipt.before.etag, 'Pages CAS identity changed after receipt persistence');
  try {
    await client.updateProject({
      projectName: plan.target.pagesProject,
      payload: structuredClone(plan.desired.pages.payload),
      configDigest: plan.desired.pages.configDigest,
      expectedEtag: current.etag,
      owner: plan.leaseOwner,
    });
  } catch (error) {
    const observed = await client.readProject();
    const observedState = pagesState(observed, receipt);
    if (observedState === 'foreign') {
      throw new Error('foreign writer changed Pages configuration during interrupted mutation', {cause: error});
    }
    if (observedState === 'before') throw error;
    return verifyPagesConfiguration(receipt, client, options, 'applied-after-interruption');
  }
  return verifyPagesConfiguration(receipt, client, options, 'applied');
}

export async function recoverPagesConfiguration(receipt, client, options = {}) {
  validatePagesReceipt(receipt, options, ['prepared','rollback-pending']);
  await requireStoredPagesPreimage(receipt, options);
  assert.equal(typeof client?.readProject, 'function', 'Pages client is missing readProject');
  assert.equal(typeof client?.restoreProject, 'function', 'Pages client is missing restoreProject');
  const current = await client.readProject();
  const state = pagesState(current, receipt);
  if (state === 'foreign') throw new Error('foreign writer changed Pages configuration; refusing recovery overwrite');
  if (receipt.phase === 'rollback-pending') {
    if (state === 'before') {
      return {...receipt, phase: 'rolled-back-after-interruption', after: structuredClone(current)};
    }
    return rollbackPagesConfiguration(receipt, client, receipt.failure?.code ?? 'pages-verification-failed');
  }
  if (state === 'before') {
    return {...receipt, phase: 'interrupted-before-mutation', after: structuredClone(current)};
  }
  assert.equal(typeof options.verify, 'function', 'Pages compatibility verification callback is required');
  return verifyPagesConfiguration(receipt, client, options, 'applied-after-interruption');
}
