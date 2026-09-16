import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

import {
  ATMOS_INTEGRATION_CANDIDATE_SHA,
  LANE_B_CONTRACT,
  LANE_B_CONTRACT_DIGEST,
  PRODUCTION_ACCOUNT_APPROVAL,
  PRODUCTION_ACCOUNT_REQUEST,
  validateProductionPagesConfiguration,
} from '../tools/production-account-contract.mjs';
import {
  BASELINE_PROFILE,
  PRODUCTION_ACCOUNT_PROFILE,
  profileDigest,
  profileFor,
  requireProductionProfile,
  resolveSelectionRequest,
  validateProfile,
} from '../tools/ui-staging-models.mjs';
import {
  activatePreparedWorker,
  applyPagesConfiguration,
  preparePagesConfiguration,
  prepareWorkerVersion,
  productionCandidateBinding,
  recoverPagesConfiguration,
  recoverWorkerActivation,
  recoverWorkerRollback,
  validateProductionCandidateBinding,
  validateProductionReleasePlan,
} from '../tools/production-account-release.mjs';
import {POLICY_FILES, pipelineDigest, publicBuildEnvironment, validatePublicModes} from '../tools/ui-release.mjs';
import {controlShaFor, hash, validateCandidate, validateFiles} from '../tools/ui-candidate.mjs';

const H = character => character.repeat(64);
const S = character => character.repeat(40);

function pagesPayload(failOpen) {
  const context = name => ({
    compatibility_date: '2026-06-23',
    compatibility_flags: [],
    fail_open: failOpen,
    ...structuredClone(LANE_B_CONTRACT.pagesBindings[name]),
  });
  return {deployment_configs: {production: context('production'), preview: context('preview')}};
}

function candidateFixture(sourceSha = ATMOS_INTEGRATION_CANDIDATE_SHA) {
  const runId = '123';
  const raw = [
    ['index.html', Buffer.from('<title>WeatherX</title>')],
    ['_worker.js', Buffer.from('export default {};')],
    ['_routes.json', Buffer.from('{"version":1,"include":["/api/*"],"exclude":[]}')],
  ];
  const shellDigest = createHash('sha256');
  for (const [path, bytes] of [...raw].sort(([a],[b]) => a.localeCompare(b))) {
    shellDigest.update(path).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0');
  }
  const receipt = {
    gitSha: sourceSha,
    workflowRunId: runId,
    releaseId: `git-${sourceSha.slice(0,12)}-run-${runId}`,
    shellSha256: shellDigest.digest('hex'),
    shellFileCount: raw.length,
    shellBytes: raw.reduce((sum, [,bytes]) => sum + bytes.length, 0),
    indexSha256: hash(raw[0][1]),
    buildProfile: structuredClone(LANE_B_CONTRACT.provisionalBuildReceipt),
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const files = [...raw, ['health/release.json', receiptBytes]]
    .map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64')}))
    .sort((a,b) => a.path.localeCompare(b.path));
  const candidate = {
    schemaVersion:1, controlSha:controlShaFor(PRODUCTION_ACCOUNT_PROFILE), profile:PRODUCTION_ACCOUNT_PROFILE,
    sourceSha, runId, attempt:'1', workflowSha:S('b'), pipelineDigest:H('b'),
    artifactDigest:validateFiles(files,PRODUCTION_ACCOUNT_PROFILE).digest, files,
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
const QUALIFICATION = structuredClone(CANDIDATE.qualification);
const OPTIONS = {allowProvisional: true, candidate: CANDIDATE, qualification: QUALIFICATION};

function plan(overrides = {}, candidate = CANDIDATE) {
  const value = {
    schemaVersion: 1,
    kind: 'weatherx-production-account-release-plan',
    transactionId: 'prod-account-20260916-001',
    leaseOwner: 'release-commander-andrew',
    contractDigest: LANE_B_CONTRACT_DIGEST,
    candidateBinding: productionCandidateBinding(candidate, candidate.qualification, {allowProvisional: true}),
    identities: {
      atmosSha: candidate.sourceSha,
      controllerSha: candidate.controlSha,
      profileDigest: profileDigest(candidate.profile),
      pipelineDigest: candidate.pipelineDigest,
      artifactDigest: candidate.artifactDigest,
    },
    target: structuredClone(LANE_B_CONTRACT.target),
    modes: structuredClone(LANE_B_CONTRACT.modes),
    stripe: {
      environment: 'live',
      priceIds: structuredClone(LANE_B_CONTRACT.approvedStripePriceIds),
    },
    rollback: {
      worker: {versionId: 'worker-old', deploymentId: 'worker-deploy-old', configDigest: H('d')},
      pages: {configDigest: H('e'), canonicalDeploymentId: 'pages-deploy-old', payload: pagesPayload(true)},
    },
    desired: {
      worker: {sourceDigest: H('f'), configDigest: H('1')},
      pages: {
        configDigest: H('2'),
        payload: pagesPayload(false),
      },
    },
    compatibility: {
      oldUi: true,
      oldWorkerOnAdditiveSchema: true,
      schemaStrategy: 'retain-additive',
      purchaseClosedDuringPreparation: true,
    },
  };
  return merge(value, overrides);
}

function merge(value, overrides) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return overrides;
  const result = structuredClone(value);
  for (const [key, item] of Object.entries(overrides)) {
    result[key] = item && typeof item === 'object' && !Array.isArray(item)
      ? merge(result[key] ?? {}, item)
      : item;
  }
  return result;
}

class WorkerClient {
  constructor({interruptAfterActivation = false, interruptRollback = null} = {}) {
    this.calls = [];
    this.interruptAfterActivation = interruptAfterActivation;
    this.interruptRollback = interruptRollback;
    this.active = {
      workerName: LANE_B_CONTRACT.target.workerName,
      versionId: 'worker-old', deploymentId: 'worker-deploy-old', configDigest: H('d'),
      etag: 'worker-etag-1', mutationOwner: null,
    };
    this.versions = new Map([['worker-old', {versionId: 'worker-old', sourceDigest: H('0'), configDigest: H('d')}]]);
  }
  async readDeployment() { this.calls.push('readDeployment'); return structuredClone(this.active); }
  async uploadVersion(spec) {
    this.calls.push('uploadVersion');
    const uploaded = {versionId: 'worker-candidate', sourceDigest: spec.sourceDigest, configDigest: spec.configDigest};
    this.versions.set(uploaded.versionId, uploaded);
    return structuredClone(uploaded);
  }
  async readVersion(versionId) { this.calls.push(`readVersion:${versionId}`); return structuredClone(this.versions.get(versionId)); }
  async activateVersion({versionId, expectedEtag, owner}) {
    this.calls.push('activateVersion');
    assert.equal(this.active.etag, expectedEtag);
    const version = this.versions.get(versionId);
    this.active = {...this.active, versionId, deploymentId: 'worker-deploy-candidate',
      configDigest: version.configDigest, etag: 'worker-etag-2', mutationOwner: owner};
    if (this.interruptAfterActivation) throw new Error('connection interrupted after activation');
    return structuredClone(this.active);
  }
  async rollbackVersion({versionId, expectedEtag, owner}) {
    this.calls.push('rollbackVersion');
    assert.equal(this.active.etag, expectedEtag);
    assert.equal(this.active.mutationOwner, owner);
    if (this.interruptRollback === 'before') {
      this.interruptRollback = null;
      throw new Error('connection interrupted before rollback');
    }
    const version = this.versions.get(versionId);
    this.active = {...this.active, versionId, deploymentId: 'worker-deploy-rollback',
      configDigest: version.configDigest, etag: 'worker-etag-3', mutationOwner: owner};
    if (this.interruptRollback === 'after') {
      this.interruptRollback = null;
      throw new Error('connection interrupted after rollback');
    }
    return structuredClone(this.active);
  }
}

class PagesClient {
  constructor({interruptUpdate = null, interruptRestore = null} = {}) {
    this.calls = [];
    this.interruptUpdate = interruptUpdate;
    this.interruptRestore = interruptRestore;
    this.current = {
      projectName: LANE_B_CONTRACT.target.pagesProject,
      configDigest: H('e'), canonicalDeploymentId: 'pages-deploy-old',
      etag: 'pages-etag-1', mutationOwner: null, payload: pagesPayload(true),
    };
  }
  async readProject() { this.calls.push('readProject'); return structuredClone(this.current); }
  async updateProject({configDigest, payload, expectedEtag, owner}) {
    this.calls.push('updateProject'); assert.equal(this.current.etag, expectedEtag);
    if (this.interruptUpdate === 'before') throw new Error('connection interrupted before Pages update');
    this.current = {...this.current, configDigest, payload: structuredClone(payload), etag: 'pages-etag-2', mutationOwner: owner};
    if (this.interruptUpdate === 'after') throw new Error('connection interrupted after Pages update');
    return structuredClone(this.current);
  }
  async restoreProject({configDigest, payload, expectedEtag, owner}) {
    this.calls.push('restoreProject'); assert.equal(this.current.etag, expectedEtag);
    assert.equal(this.current.mutationOwner, owner);
    if (this.interruptRestore === 'before') {
      this.interruptRestore = null;
      throw new Error('connection interrupted before Pages restore');
    }
    this.current = {...this.current, configDigest, payload: structuredClone(payload), etag: 'pages-etag-3', mutationOwner: owner};
    if (this.interruptRestore === 'after') {
      this.interruptRestore = null;
      throw new Error('connection interrupted after Pages restore');
    }
    return structuredClone(this.current);
  }
}

function safetyVerification({candidateUi = false} = {}) {
  return {
    oldUi: {compatible: true, deploymentId: 'pages-deploy-old'},
    ...(candidateUi ? {candidateUi: {compatible: true, artifactDigest: CANDIDATE.artifactDigest}} : {}),
    purchase: {mode: 'closed', creationBlocked: true},
    servicing: {billingMode: 'enabled', portalAvailable: true, webhooksVerified: true},
    publicData: {authMode: 'public', readable: true},
    stripe: {environment: 'live', livemode: true},
  };
}

async function preparePages(client, stored = []) {
  return preparePagesConfiguration(plan(), client, {
    ...OPTIONS,
    storeReceipt: async receipt => {
      client.storedReceipt = structuredClone(receipt);
      stored.push(structuredClone(receipt));
    },
  });
}

function pagesOptions(client, extra = {}) {
  return {
    ...OPTIONS,
    readStoredReceipt: async () => structuredClone(client.storedReceipt),
    ...extra,
  };
}

test('production account profile is explicit while the historical baseline stays the default', () => {
  assert.equal(profileFor(), BASELINE_PROFILE);
  assert.equal(profileFor('none'), BASELINE_PROFILE);
  assert.equal(profileFor(PRODUCTION_ACCOUNT_REQUEST), PRODUCTION_ACCOUNT_PROFILE);
  validateProfile(PRODUCTION_ACCOUNT_PROFILE);
  requireProductionProfile(BASELINE_PROFILE);
  requireProductionProfile(PRODUCTION_ACCOUNT_PROFILE);
  assert.equal(PRODUCTION_ACCOUNT_PROFILE.account, true);
  assert.equal(PRODUCTION_ACCOUNT_PROFILE.productionAccount, PRODUCTION_ACCOUNT_APPROVAL);
  assert.equal(PRODUCTION_ACCOUNT_PROFILE.accountContractSha256, LANE_B_CONTRACT_DIGEST);
  assert.throws(() => resolveSelectionRequest(PRODUCTION_ACCOUNT_REQUEST, undefined, undefined,
    undefined, undefined, undefined, PRODUCTION_ACCOUNT_APPROVAL), /Lane B contract remains provisional/);
  assert.equal(resolveSelectionRequest(PRODUCTION_ACCOUNT_REQUEST, undefined, undefined,
    undefined, undefined, undefined, PRODUCTION_ACCOUNT_APPROVAL, OPTIONS), PRODUCTION_ACCOUNT_REQUEST);
});

test('production account candidate is contract-bound and cannot inherit staging build controls', () => {
  assert.equal(controlShaFor(PRODUCTION_ACCOUNT_PROFILE), LANE_B_CONTRACT.requiredAtmosControllerSha);
  assert.ok(POLICY_FILES.includes('tools/production-account-contract.mjs'));
  assert.ok(POLICY_FILES.includes('tools/production-account-release.mjs'));
  assert.ok(POLICY_FILES.includes('tools/production-account-execution.mjs'));
  const env = publicBuildEnvironment(PRODUCTION_ACCOUNT_PROFILE, null, {
    ATMOS_STAGING_ACCOUNT_PROFILE: 'staging-account-v1',
    ATMOS_PRODUCTION_ACCOUNT_PROFILE: 'ambient-wrong',
  });
  assert.equal(env.ATMOS_PUBLIC_RELEASE, '1');
  assert.equal(env.ATMOS_STAGING_EXPERIMENT_RELEASE, '0');
  assert.equal(env.ATMOS_STAGING_ACCOUNT_PROFILE, '');
  assert.equal(env.ATMOS_PRODUCTION_ACCOUNT_PROFILE, PRODUCTION_ACCOUNT_APPROVAL);
  assert.equal(env.VITE_PLATFORM_ACCOUNT, '1');
  assert.equal(env.VITE_PLATFORM_DATA_AUTH, 'public');

  validatePublicModes('https://weatherx.org',
    {ok:true,authMode:'observe',billingMode:'enabled',billingPurchaseMode:'closed'},
    {ok:true,authMode:'public',catalogMode:'serve'}, PRODUCTION_ACCOUNT_PROFILE);
  assert.throws(() => validatePublicModes('https://weatherx.org',
    {ok:true,authMode:'observe',billingMode:'enabled',billingPurchaseMode:'public'},
    {ok:true,authMode:'public',catalogMode:'serve'}, PRODUCTION_ACCOUNT_PROFILE), /purchase creation closed/);
  assert.throws(() => validatePublicModes('https://weatherx.org',
    {ok:true,authMode:'observe',billingMode:'enabled',purchaseMode:'closed'},
    {ok:true,authMode:'public',catalogMode:'serve'}, PRODUCTION_ACCOUNT_PROFILE), /purchase creation closed/);
});

test('encrypted candidate validation binds the owner-blocked Lane B build receipt exactly', () => {
  const sourceSha = ATMOS_INTEGRATION_CANDIDATE_SHA, runId = '123';
  const raw = [
    ['index.html', Buffer.from('<title>WeatherX</title>')],
    ['_worker.js', Buffer.from('export default {};')],
    ['_routes.json', Buffer.from('{"version":1,"include":["/api/*"],"exclude":[]}')],
  ];
  const shellDigest = createHash('sha256');
  for (const [path, bytes] of [...raw].sort(([a],[b]) => a.localeCompare(b)))
    shellDigest.update(path).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0');
  const receipt = {
    gitSha: sourceSha,
    workflowRunId: runId,
    releaseId: `git-${sourceSha.slice(0,12)}-run-${runId}`,
    shellSha256: shellDigest.digest('hex'),
    shellFileCount: raw.length,
    shellBytes: raw.reduce((sum, [,bytes]) => sum + bytes.length, 0),
    indexSha256: hash(raw[0][1]),
    buildProfile: structuredClone(LANE_B_CONTRACT.provisionalBuildReceipt),
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const files = [...raw, ['health/release.json', receiptBytes]]
    .map(([path, bytes]) => ({path, bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64')}))
    .sort((a,b) => a.path.localeCompare(b.path));
  const candidate = {
    schemaVersion:1, controlSha:controlShaFor(PRODUCTION_ACCOUNT_PROFILE), profile:PRODUCTION_ACCOUNT_PROFILE,
    sourceSha, runId, attempt:'1', workflowSha:S('b'), pipelineDigest:H('c'),
    artifactDigest:validateFiles(files,PRODUCTION_ACCOUNT_PROFILE).digest, files,
  };
  assert.equal(validateCandidate(candidate).releaseId, receipt.releaseId);
  candidate.files.find(file => file.path === 'health/release.json').base64 = Buffer.from(JSON.stringify({
    ...receipt, buildProfile:{...receipt.buildProfile, accountRelease:'staging-account-v1'},
  })).toString('base64');
  assert.throws(() => validateCandidate(candidate));
});

test('preflight binds all identities, targets, modes, routes and rollback identities', () => {
  const accepted = validateProductionReleasePlan(plan(), OPTIONS);
  assert.equal(accepted.contractDigest, LANE_B_CONTRACT_DIGEST);
  const bad = [
    {contractDigest: H('9')},
    {identities: {atmosSha: S('z')}},
    {identities: {controllerSha: S('9')}},
    {identities: {profileDigest: H('9')}},
    {identities: {pipelineDigest: 'not-a-digest'}},
    {target: {workerName: 'weatherx-platform-edge-staging'}},
    {target: {origin: 'https://staging.weatherx.org'}},
    {target: {routes: [...LANE_B_CONTRACT.target.routes, 'weatherx.org/data/*']}},
    {modes: {authMode: 'enforce'}},
    {modes: {billingMode: 'disabled'}},
    {modes: {billingPurchaseMode: 'public'}},
    {modes: {dataAuthMode: 'enforce'}},
    {modes: {stripeEnvironment: 'test'}},
    {stripe: {environment: 'test'}},
    {stripe: {priceIds: {subscription: LANE_B_CONTRACT.forbiddenStripePriceIds[0]}}},
    {rollback: {worker: {versionId: ''}}},
    {rollback: {pages: {configDigest: 'wrong'}}},
    {compatibility: {oldUi: false}},
    {compatibility: {schemaStrategy: 'restore-database'}},
  ];
  for (const change of bad) assert.throws(() => validateProductionReleasePlan(plan(change), OPTIONS));
});

test('production Pages configuration rejects staging bindings, URLs and known test identifiers', () => {
  validateProductionPagesConfiguration(plan().desired.pages.payload);
  const mutations = [
    value => { value.deployment_configs.production.services.WX_AI_ADMISSION = {service: 'weatherx-platform-edge-staging'}; },
    value => { value.deployment_configs.production.env_vars.ORIGIN = {type: 'plain_text', value: 'https://staging.weatherx.org'}; },
    value => { value.deployment_configs.production.env_vars.PRICE = {type: 'plain_text', value: LANE_B_CONTRACT.forbiddenStripePriceIds[0]}; },
    value => { value.deployment_configs.production.d1_databases.WX_ANALYTICS.id = '9501827a-7e4c-4249-806b-d45d5857d9e5'; },
    value => { value.deployment_configs.preview.d1_databases.WX_ANALYTICS.id = '9501827a-7e4c-4249-806b-d45d5857d9e5'; },
    value => { value.deployment_configs.preview.env_vars.AI_API_KEY = {type: 'secret_text'}; },
    value => { value.deployment_configs.production.r2_buckets = {DATA: {bucket_name: 'weatherx-data-production'}}; },
  ];
  for (const mutate of mutations) {
    const payload = pagesPayload(false);
    mutate(payload);
    assert.throws(() => validateProductionPagesConfiguration(payload));
  }
});

test('candidate binding comes only from a validated candidate and its exact qualification receipt', () => {
  assert.throws(() => productionCandidateBinding(CANDIDATE, QUALIFICATION), /remains provisional/);
  const binding = productionCandidateBinding(CANDIDATE, QUALIFICATION, {allowProvisional: true});
  validateProductionCandidateBinding(binding, CANDIDATE, QUALIFICATION, {allowProvisional: true});

  const changedPolicy = structuredClone(CANDIDATE);
  changedPolicy.pipelineDigest = H('4');
  assert.throws(() => validateProductionCandidateBinding(binding, changedPolicy,
    changedPolicy.qualification, {allowProvisional: true}), /candidate identity changed/);
  const changedQualification = structuredClone(QUALIFICATION);
  changedQualification.deploymentId = '22345678-1234-1234-1234-123456789abc';
  assert.throws(() => validateProductionCandidateBinding(binding, CANDIDATE,
    changedQualification, {allowProvisional: true}), /qualification receipt differs/);
  assert.throws(() => validateProductionReleasePlan(plan({candidateBinding: {...binding, bindingDigest: H('9')}}), OPTIONS));
});

test('reviewed Atmos integration identity is exact while provisional Price placeholders remain unusable', () => {
  assert.equal(ATMOS_INTEGRATION_CANDIDATE_SHA, '29ff8f58b36d31059b2cd5fb80b3b90224130282');
  assert.ok(Object.values(LANE_B_CONTRACT.approvedStripePriceIds).every(value => !value.startsWith('price_')));
  assert.equal(LANE_B_CONTRACT.requiredAtmosSourceSha, ATMOS_INTEGRATION_CANDIDATE_SHA);
  assert.equal(LANE_B_CONTRACT.requiredAtmosControllerSha, ATMOS_INTEGRATION_CANDIDATE_SHA);
  assert.equal(CANDIDATE.sourceSha, ATMOS_INTEGRATION_CANDIDATE_SHA);
  assert.equal(CANDIDATE.controlSha, ATMOS_INTEGRATION_CANDIDATE_SHA);
  assert.throws(() => validateProductionReleasePlan(plan({
    stripe: {priceIds: {subscription: 'price_live_unapproved', pass: 'price_live_unapproved_pass'}},
  }), OPTIONS), /owner-approved/);
  assert.throws(() => validateProductionReleasePlan(plan({
    identities: {controllerSha: S('9')},
  }), OPTIONS));
  const wrongSource = candidateFixture(S('a'));
  assert.throws(() => productionCandidateBinding(wrongSource, wrongSource.qualification, {allowProvisional: true}),
    /exact reviewed Atmos integration candidate/);
});

test('Worker preparation uploads an inactive version and leaves the old deployment active', async () => {
  const client = new WorkerClient();
  const receipt = await prepareWorkerVersion(plan(), client, OPTIONS);
  assert.equal(receipt.phase, 'prepared');
  assert.equal(receipt.before.versionId, 'worker-old');
  assert.equal(receipt.candidate.versionId, 'worker-candidate');
  assert.equal(client.active.versionId, 'worker-old');
  assert.ok(client.calls.includes('uploadVersion'));
  assert.equal(client.calls.includes('activateVersion'), false);
});

test('Worker activation uses CAS, verifies purchase-closed mode and emits before/after receipts', async () => {
  const client = new WorkerClient();
  const prepared = await prepareWorkerVersion(plan(), client, OPTIONS);
  const receipt = await activatePreparedWorker(prepared, client, {
    ...OPTIONS,
    verify: async context => {
      assert.equal(context.authMode, 'observe');
      assert.equal(context.billingMode, 'enabled');
      assert.equal(context.billingPurchaseMode, 'closed');
      assert.equal(context.dataAuthMode, 'public');
      assert.equal(context.stripeEnvironment, 'live');
      assert.equal(context.oldUiCompatible, true);
      return safetyVerification();
    },
  });
  assert.equal(receipt.phase, 'activated');
  assert.equal(receipt.before.versionId, 'worker-old');
  assert.equal(receipt.after.versionId, 'worker-candidate');
  assert.equal(receipt.verification.purchase.creationBlocked, true);
});

test('wrong Worker target or configuration digest refuses before mutation', async () => {
  for (const mutate of [
    client => { client.active.workerName = 'weatherx-platform-edge-staging'; },
    client => { client.active.configDigest = H('8'); },
    client => { client.active.versionId = 'foreign-old'; },
  ]) {
    const client = new WorkerClient(); mutate(client);
    await assert.rejects(prepareWorkerVersion(plan(), client, OPTIONS));
    assert.equal(client.calls.includes('uploadVersion'), false);
  }
});

test('foreign Worker writer is never overwritten during activation or recovery', async () => {
  const client = new WorkerClient();
  const prepared = await prepareWorkerVersion(plan(), client, OPTIONS);
  client.active = {...client.active, versionId: 'foreign-version', deploymentId: 'foreign-deploy',
    configDigest: H('8'), etag: 'foreign-etag', mutationOwner: 'another-release'};
  await assert.rejects(activatePreparedWorker(prepared, client, {...OPTIONS, verify: async () => ({ok: true})}),
    /foreign writer/);
  await assert.rejects(recoverWorkerActivation(prepared, client, {...OPTIONS, verify: async () => ({ok: true})}),
    /foreign writer/);
  assert.equal(client.calls.includes('rollbackVersion'), false);

  const sameStateNewEtag = new WorkerClient();
  const secondPrepared = await prepareWorkerVersion(plan(), sameStateNewEtag, OPTIONS);
  sameStateNewEtag.active.etag = 'foreign-etag';
  await assert.rejects(
    activatePreparedWorker(secondPrepared, sameStateNewEtag, {
      ...OPTIONS,
      verify: async () => ({ok: true}),
    }),
    /foreign writer/,
  );
  assert.equal(sameStateNewEtag.calls.includes('activateVersion'), false);
});

test('interrupted activation is recovered from observed owned state', async () => {
  const client = new WorkerClient({interruptAfterActivation: true});
  const prepared = await prepareWorkerVersion(plan(), client, OPTIONS);
  const receipt = await activatePreparedWorker(prepared, client, {
    ...OPTIONS, verify: async () => safetyVerification(),
  });
  assert.equal(receipt.phase, 'activated-after-interruption');
  assert.equal(receipt.after.versionId, 'worker-candidate');
  assert.equal(receipt.verification.stripe.livemode, true);
});

test('Worker verification requires structured old-UI, purchase, servicing, public-data and live-mode evidence', async () => {
  const client = new WorkerClient();
  const prepared = await prepareWorkerVersion(plan(), client, OPTIONS);
  const incomplete = safetyVerification();
  delete incomplete.servicing.webhooksVerified;
  const receipt = await activatePreparedWorker(prepared, client, {
    ...OPTIONS, verify: async () => incomplete,
  });
  assert.equal(receipt.phase, 'rolled-back');
  assert.match(receipt.failure.message, /billing servicing verification/);
});

test('failed Worker verification rolls code back while retaining the additive schema', async () => {
  const client = new WorkerClient();
  const prepared = await prepareWorkerVersion(plan(), client, OPTIONS);
  const receipt = await activatePreparedWorker(prepared, client, {
    ...OPTIONS, verify: async () => { throw new Error('purchase gate probe failed'); },
  });
  assert.equal(receipt.phase, 'rolled-back');
  assert.equal(receipt.after.versionId, 'worker-old');
  assert.equal(receipt.schema.action, 'retain-additive');
  assert.equal(receipt.schema.databaseRestoreAttempted, false);
  assert.ok(client.calls.includes('rollbackVersion'));
});

test('ambiguous Worker rollback is classified and safely recoverable', async () => {
  const after = new WorkerClient({interruptRollback: 'after'});
  const preparedAfter = await prepareWorkerVersion(plan(), after, OPTIONS);
  const restored = await activatePreparedWorker(preparedAfter, after, {
    ...OPTIONS, verify: async () => { throw new Error('verification failed'); },
  });
  assert.equal(restored.phase, 'rolled-back-after-interruption');
  assert.equal(restored.after.versionId, 'worker-old');

  const before = new WorkerClient({interruptRollback: 'before'});
  const preparedBefore = await prepareWorkerVersion(plan(), before, OPTIONS);
  const pending = await activatePreparedWorker(preparedBefore, before, {
    ...OPTIONS, verify: async () => { throw new Error('verification failed'); },
  });
  assert.equal(pending.phase, 'rollback-pending');
  const recovered = await recoverWorkerRollback(pending, before, OPTIONS);
  assert.equal(recovered.phase, 'rolled-back');
  assert.equal(recovered.after.versionId, 'worker-old');
});

test('Pages configuration is a separate CAS transaction and verifies old/new UI compatibility', async () => {
  const client = new PagesClient();
  const stored = [];
  const prepared = await preparePages(client, stored);
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0].before.payload, pagesPayload(true));
  await assert.rejects(applyPagesConfiguration(prepared, client, {
    ...OPTIONS, verify: async () => safetyVerification({candidateUi: true}),
  }), /durable pre-mutation receipt readback/);
  let verified = false;
  const receipt = await applyPagesConfiguration(prepared, client, pagesOptions(client, {
    verify: async context => {
      verified = true;
      assert.equal(context.oldUiDeploymentId, 'pages-deploy-old');
      assert.equal(context.candidateArtifactDigest, CANDIDATE.artifactDigest);
      return safetyVerification({candidateUi: true});
    },
  }));
  assert.equal(receipt.phase, 'applied');
  assert.equal(receipt.before.configDigest, H('e'));
  assert.equal(receipt.after.configDigest, H('2'));
  assert.deepEqual(receipt.after.payload, pagesPayload(false));
  assert.equal(verified, true);
  assert.deepEqual(client.calls.filter(call => call.includes('deploy')), []);
});

test('Pages verification failure reverses only an owned configuration mutation', async () => {
  const client = new PagesClient();
  const prepared = await preparePages(client);
  const receipt = await applyPagesConfiguration(prepared, client, pagesOptions(client, {
    verify: async () => { throw new Error('old UI incompatible'); },
  }));
  assert.equal(receipt.phase, 'rolled-back');
  assert.equal(receipt.after.configDigest, H('e'));
  assert.deepEqual(receipt.after.payload, pagesPayload(true));
  assert.ok(client.calls.includes('restoreProject'));

  const foreign = new PagesClient();
  const foreignPrepared = await preparePages(foreign);
  await assert.rejects(applyPagesConfiguration(foreignPrepared, foreign, pagesOptions(foreign, {
    verify: async () => {
      foreign.current = {...foreign.current, configDigest: H('9'), payload: pagesPayload(true),
        etag: 'foreign-pages-etag', mutationOwner: 'another-release'};
      throw new Error('probe failed after foreign write');
    },
  })), /foreign writer/);
  assert.equal(foreign.calls.includes('restoreProject'), false);
});

test('Pages recovery classifies unchanged, owned desired, foreign, and ambiguous restore outcomes', async () => {
  const unchanged = new PagesClient();
  const unchangedReceipt = await preparePages(unchanged);
  const unchangedResult = await recoverPagesConfiguration(unchangedReceipt, unchanged, pagesOptions(unchanged));
  assert.equal(unchangedResult.phase, 'interrupted-before-mutation');

  const owned = new PagesClient({interruptUpdate: 'after'});
  const ownedReceipt = await preparePages(owned);
  const applied = await applyPagesConfiguration(ownedReceipt, owned, pagesOptions(owned, {
    verify: async () => safetyVerification({candidateUi: true}),
  }));
  assert.equal(applied.phase, 'applied-after-interruption');

  const foreign = new PagesClient();
  const foreignReceipt = await preparePages(foreign);
  foreign.current = {...foreign.current, configDigest: H('9'), etag: 'foreign', payload: pagesPayload(true)};
  await assert.rejects(recoverPagesConfiguration(foreignReceipt, foreign, pagesOptions(foreign)), /foreign writer/);

  const restoreAfter = new PagesClient({interruptRestore: 'after'});
  const restoreAfterReceipt = await preparePages(restoreAfter);
  const restoredAfter = await applyPagesConfiguration(restoreAfterReceipt, restoreAfter, pagesOptions(restoreAfter, {
    verify: async () => { throw new Error('compatibility failed'); },
  }));
  assert.equal(restoredAfter.phase, 'rolled-back-after-interruption');
  assert.deepEqual(restoredAfter.after.payload, pagesPayload(true));

  const restoreBefore = new PagesClient({interruptRestore: 'before'});
  const restoreBeforeReceipt = await preparePages(restoreBefore);
  const pending = await applyPagesConfiguration(restoreBeforeReceipt, restoreBefore, pagesOptions(restoreBefore, {
    verify: async () => { throw new Error('compatibility failed'); },
  }));
  assert.equal(pending.phase, 'rollback-pending');
  const recovered = await recoverPagesConfiguration(pending, restoreBefore, pagesOptions(restoreBefore));
  assert.equal(recovered.phase, 'rolled-back');
  assert.deepEqual(recovered.after.payload, pagesPayload(true));
});

test('production promotion audit hashes the candidate profile policy', () => {
  const source = readFileSync(new URL('../tools/ui-release.mjs', import.meta.url), 'utf8');
  const audit = source.slice(source.indexOf('async function auditRun'), source.indexOf('async function download'));
  assert.match(audit, /pipelineDigest\(c\.profile\)/);
  assert.doesNotMatch(audit, /pipelineDigest\(\)/);
});

test('runbooks preserve G3/G4/G5 sequencing and workflows cannot enable the provisional contract', () => {
  const runbook = readFileSync(new URL('../docs/production-account-release-controller.md', import.meta.url), 'utf8');
  for (const phrase of ['G3 transaction separation','G3 → G4 → G5 operating order',
    'purchase creation closed','billingPurchaseMode=closed','separate explicit approval','not activation']) {
    assert.match(runbook, new RegExp(phrase));
  }
  assert.match(runbook, new RegExp(LANE_B_CONTRACT_DIGEST));
  assert.match(runbook, new RegExp(profileDigest(PRODUCTION_ACCOUNT_PROFILE)));
  assert.match(runbook, new RegExp(pipelineDigest(PRODUCTION_ACCOUNT_PROFILE)));
  const workflows = ['ui-staging.yml','ui-release.yml']
    .map(name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(workflows, /allowProvisional|production-account-billing-v1|PRODUCTION_ACCOUNT_PROFILE/);
});
