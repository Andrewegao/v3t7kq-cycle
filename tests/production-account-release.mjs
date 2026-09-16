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
import {PRODUCTION_ACCOUNT_TRUST_POLICY,PRODUCTION_ACCOUNT_TRUST_POLICY_DIGEST} from '../tools/production-account-trust-policy.mjs';
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
  prepareWorkerUploadIntent,
  productionCandidateBinding,
  recoverPagesConfiguration,
  recoverWorkerPreparation,
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
const OPTIONS = {allowProvisional: true, candidate: CANDIDATE, qualification: QUALIFICATION,
  preparationAuthorization: {approvalId: 'approval-test', requestDigest: H('7')},
  storePreparationIntent: async () => {}};

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

function mockMutationReference(operation, spec) {
  const operationDigest = createHash('sha256').update(JSON.stringify({operation,spec})).digest('hex');
  return {schemaVersion:1,kind:'weatherx-production-mutation-reference-v1',operation,target:'mock-target',
    operationDigest,idempotencyKey:`wx-${operationDigest.slice(0,48)}`,resourceNamespace:'mock-resource',
    leaseId:'mock-lease',fencingToken:1};
}
const mockAcknowledgement = reference => ({payload:{operationDigest:reference.operationDigest,
  idempotencyKey:reference.idempotencyKey},signature:'mock-signature'});
function interrupted(message, reference) { const error=new Error(message);error.mutationReference=structuredClone(reference);return error; }

class WorkerClient {
  constructor({interruptAfterActivation = false, interruptRollback = null, interruptUpload = null, missingAcknowledgement = null} = {}) {
    this.calls = [];
    this.interruptAfterActivation = interruptAfterActivation;
    this.interruptRollback = interruptRollback;
    this.interruptUpload = interruptUpload;
    this.missingAcknowledgement = missingAcknowledgement;
    this.acknowledgements = new Map();
    this.active = {
      workerName: LANE_B_CONTRACT.target.workerName,
      versionId: 'worker-old', deploymentId: 'worker-deploy-old', configDigest: H('d'),
      etag: 'worker-etag-1', mutationOwner: null,
    };
    this.versions = new Map([['worker-old', {versionId: 'worker-old', sourceDigest: H('0'), configDigest: H('d')}]]);
    this.tags = new Map();
  }
  async readDeployment() { this.calls.push('readDeployment'); return structuredClone(this.active); }
  async uploadVersion(spec) {
    this.calls.push('uploadVersion');
    const reference=mockMutationReference('worker-upload-version',spec);
    if (this.interruptUpload === 'before') throw interrupted('sk_live_CANARY_UPLOAD_BEFORE',reference);
    const uploaded = {versionId: 'worker-candidate', sourceDigest: spec.sourceDigest, configDigest: spec.configDigest};
    this.versions.set(uploaded.versionId, uploaded);
    this.tags.set(uploaded.versionId, spec.tag);
    if(this.missingAcknowledgement!=='upload')this.acknowledgements.set(reference.operationDigest,mockAcknowledgement(reference));
    if (this.interruptUpload === 'after') throw interrupted('sk_live_CANARY_UPLOAD_AFTER',reference);
    return {result:structuredClone(uploaded),acknowledgement:mockAcknowledgement(reference),mutationReference:reference};
  }
  async readVersion(versionId) { this.calls.push(`readVersion:${versionId}`); return structuredClone(this.versions.get(versionId)); }
  async listVersionsByTag(tag) { this.calls.push(`listVersionsByTag:${tag}`); return [...this.tags.entries()].filter(([,value]) => value === tag).map(([versionId]) => ({versionId,tag})); }
  async readMutationAcknowledgement(reference){this.calls.push(`readMutationAcknowledgement:${reference.operationDigest}`);const value=this.acknowledgements.get(reference.operationDigest);if(!value)throw new Error('acknowledgement unavailable');return structuredClone(value);}
  authenticateMutationAcknowledgement(evidence){assert.deepEqual(evidence.acknowledgement,mockAcknowledgement(evidence.reference));return structuredClone(evidence.acknowledgement);}
  async activateVersion({versionId, expectedEtag, owner}) {
    this.calls.push('activateVersion');
    const spec={versionId,expectedEtag,owner},reference=mockMutationReference('worker-activate-version',spec);
    assert.equal(this.active.etag, expectedEtag);
    const version = this.versions.get(versionId);
    this.active = {...this.active, versionId, deploymentId: 'worker-deploy-candidate',
      configDigest: version.configDigest, etag: 'worker-etag-2', mutationOwner: owner};
    if(this.missingAcknowledgement!=='activate')this.acknowledgements.set(reference.operationDigest,mockAcknowledgement(reference));
    if (this.interruptAfterActivation) throw interrupted('connection interrupted after activation',reference);
    return {result:structuredClone(this.active),acknowledgement:mockAcknowledgement(reference),mutationReference:reference};
  }
  async rollbackVersion({versionId, expectedEtag, owner}) {
    this.calls.push('rollbackVersion');
    const spec={versionId,expectedEtag,owner},reference=mockMutationReference('worker-rollback-version',spec);
    assert.equal(this.active.etag, expectedEtag);
    assert.equal(this.active.mutationOwner, owner);
    if (this.interruptRollback === 'before') {
      this.interruptRollback = null;
      throw interrupted('connection interrupted before rollback',reference);
    }
    const version = this.versions.get(versionId);
    this.active = {...this.active, versionId, deploymentId: 'worker-deploy-rollback',
      configDigest: version.configDigest, etag: 'worker-etag-3', mutationOwner: owner};
    if(this.missingAcknowledgement!=='rollback')this.acknowledgements.set(reference.operationDigest,mockAcknowledgement(reference));
    if (this.interruptRollback === 'after') {
      this.interruptRollback = null;
      throw interrupted('connection interrupted after rollback',reference);
    }
    return {result:structuredClone(this.active),acknowledgement:mockAcknowledgement(reference),mutationReference:reference};
  }
}

class PagesClient {
  constructor({interruptUpdate = null, interruptRestore = null, missingAcknowledgement = null} = {}) {
    this.calls = [];
    this.interruptUpdate = interruptUpdate;
    this.interruptRestore = interruptRestore;
    this.missingAcknowledgement = missingAcknowledgement;
    this.acknowledgements = new Map();
    this.current = {
      projectName: LANE_B_CONTRACT.target.pagesProject,
      configDigest: H('e'), canonicalDeploymentId: 'pages-deploy-old',
      etag: 'pages-etag-1', mutationOwner: null, payload: pagesPayload(true),
    };
  }
  async readProject() { this.calls.push('readProject'); return structuredClone(this.current); }
  async updateProject({configDigest, payload, expectedEtag, owner}) {
    this.calls.push('updateProject'); assert.equal(this.current.etag, expectedEtag);
    const spec={configDigest,payload,expectedEtag,owner},reference=mockMutationReference('pages-update-project',spec);
    if (this.interruptUpdate === 'before') throw interrupted('connection interrupted before Pages update',reference);
    this.current = {...this.current, configDigest, payload: structuredClone(payload), etag: 'pages-etag-2', mutationOwner: owner};
    if(this.missingAcknowledgement!=='update')this.acknowledgements.set(reference.operationDigest,mockAcknowledgement(reference));
    if (this.interruptUpdate === 'after') throw interrupted('connection interrupted after Pages update',reference);
    return {result:structuredClone(this.current),acknowledgement:mockAcknowledgement(reference),mutationReference:reference};
  }
  async restoreProject({configDigest, payload, expectedEtag, owner}) {
    this.calls.push('restoreProject'); assert.equal(this.current.etag, expectedEtag);
    assert.equal(this.current.mutationOwner, owner);
    const spec={configDigest,payload,expectedEtag,owner},reference=mockMutationReference('pages-restore-project',spec);
    if (this.interruptRestore === 'before') {
      this.interruptRestore = null;
      throw interrupted('connection interrupted before Pages restore',reference);
    }
    this.current = {...this.current, configDigest, payload: structuredClone(payload), etag: 'pages-etag-3', mutationOwner: owner};
    if(this.missingAcknowledgement!=='restore')this.acknowledgements.set(reference.operationDigest,mockAcknowledgement(reference));
    if (this.interruptRestore === 'after') {
      this.interruptRestore = null;
      throw interrupted('connection interrupted after Pages restore',reference);
    }
    return {result:structuredClone(this.current),acknowledgement:mockAcknowledgement(reference),mutationReference:reference};
  }
  async readMutationAcknowledgement(reference){this.calls.push(`readMutationAcknowledgement:${reference.operationDigest}`);const value=this.acknowledgements.get(reference.operationDigest);if(!value)throw new Error('acknowledgement unavailable');return structuredClone(value);}
  authenticateMutationAcknowledgement(evidence){assert.deepEqual(evidence.acknowledgement,mockAcknowledgement(evidence.reference));return structuredClone(evidence.acknowledgement);}
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
  assert.equal(PRODUCTION_ACCOUNT_TRUST_POLICY.status, 'provisional');
  assert.match(PRODUCTION_ACCOUNT_TRUST_POLICY_DIGEST, /^[a-f0-9]{64}$/);
  assert.equal(PRODUCTION_ACCOUNT_TRUST_POLICY.cloudflare.resourceNamespaces.worker,
    `cloudflare:${LANE_B_CONTRACT.target.cloudflareAccountId}:workers:${LANE_B_CONTRACT.target.workerName}`);
  assert.equal(PRODUCTION_ACCOUNT_TRUST_POLICY.cloudflare.resourceNamespaces.pages,
    `cloudflare:${LANE_B_CONTRACT.target.cloudflareAccountId}:pages:${LANE_B_CONTRACT.target.pagesProject}`);
  assert.ok(POLICY_FILES.includes('tools/production-account-trust-policy.mjs'));
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
    value => { value.deployment_configs.production.placement = {credential: 'sk_live_CANARY'}; },
    value => { value.deployment_configs.production.services = {UNKNOWN: {service: 'weatherx-platform-edge-production'}}; },
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
  assert.equal(ATMOS_INTEGRATION_CANDIDATE_SHA, '6c29c7f74731059fdd433b40d7bc21427a605ab9');
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
  assert.equal(receipt.mutationEvidence.acknowledgement.signature,'mock-signature');
  assert.equal(client.active.versionId, 'worker-old');
  assert.ok(client.calls.includes('uploadVersion'));
  assert.equal(client.calls.includes('activateVersion'), false);
});

test('ambiguous inactive upload is recovered by its approval-bound exact tag without re-upload', async () => {
  const client = new WorkerClient({interruptUpload: 'after',missingAcknowledgement:'upload'});
  const stored = [];
  const pending = await prepareWorkerVersion(plan(), client, {...OPTIONS,
    storePreparationIntent: async value => stored.push(structuredClone(value)),
  });
  assert.equal(pending.phase,'preparation-ack-pending');
  assert.equal((await recoverWorkerPreparation(pending,client,OPTIONS)).phase,'preparation-ack-pending');
  client.acknowledgements.set(pending.pendingMutation.operationDigest,mockAcknowledgement(pending.pendingMutation));
  const taggedVersion=client.versions.get('worker-candidate');client.versions.set('worker-candidate',{...taggedVersion,sourceDigest:H('9')});
  await assert.rejects(recoverWorkerPreparation({...stored.at(-1),pendingMutation:pending.pendingMutation},client,OPTIONS),/uploaded Worker source digest changed/);
  client.versions.set('worker-candidate',taggedVersion);
  const recovered = await recoverWorkerPreparation(pending, client, OPTIONS);
  assert.equal(recovered.phase, 'prepared-after-interruption');
  assert.equal(recovered.uploadTag, stored.at(-1).uploadTag);
  assert.equal(client.calls.filter(call => call === 'uploadVersion').length, 1);
  client.tags.set('duplicate-version', stored.at(-1).uploadTag);
  client.versions.set('duplicate-version', {versionId:'duplicate-version',sourceDigest:H('f'),configDigest:H('1')});
  const ambiguous={...stored.at(-1),pendingMutation:pending.pendingMutation};
  await assert.rejects(recoverWorkerPreparation(ambiguous, client, OPTIONS), /exactly one tagged version/);
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
  assert.equal(receipt.mutationEvidence.acknowledgement.signature,'mock-signature');
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
  assert.equal(receipt.failure.code, 'worker-verification-failed');
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
  assert.equal(receipt.rollbackEvidence.acknowledgement.signature,'mock-signature');
  assert.ok(client.calls.includes('rollbackVersion'));
});

test('Worker rollback receipts never serialize canary exception messages', async () => {
  for (const interruptRollback of [null,'before']) {
    const client = new WorkerClient({interruptRollback});
    const prepared = await prepareWorkerVersion(plan(), client, OPTIONS);
    const receipt = await activatePreparedWorker(prepared, client, {
      ...OPTIONS, verify: async () => { throw new Error('sk_live_CANARY_WORKER_RECEIPT'); },
    });
    assert.ok(['rolled-back','rollback-pending'].includes(receipt.phase));
    assert.equal(receipt.failure.code, 'worker-verification-failed');
    assert.ok(!JSON.stringify(receipt).includes('sk_live_CANARY_WORKER_RECEIPT'));
    if (receipt.phase === 'rollback-pending') assert.equal(receipt.recovery.code, 'worker-rollback-outcome-unknown');
  }
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
  assert.equal(recovered.phase, 'rollback-pending');
  assert.equal(before.calls.filter(call=>call==='rollbackVersion').length,1);
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
  assert.equal(receipt.mutationEvidence.acknowledgement.signature,'mock-signature');
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
  assert.equal(receipt.restoreEvidence.acknowledgement.signature,'mock-signature');
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

test('Pages rollback receipts never serialize canary exception messages', async () => {
  for (const interruptRestore of [null,'before']) {
    const client = new PagesClient({interruptRestore});
    const prepared = await preparePages(client);
    const receipt = await applyPagesConfiguration(prepared, client, pagesOptions(client, {
      verify: async () => { throw new Error('sk_live_CANARY_PAGES_RECEIPT'); },
    }));
    assert.ok(['rolled-back','rollback-pending'].includes(receipt.phase));
    assert.equal(receipt.failure.code, 'pages-verification-failed');
    assert.ok(!JSON.stringify(receipt).includes('sk_live_CANARY_PAGES_RECEIPT'));
    if (receipt.phase === 'rollback-pending') assert.equal(receipt.recovery.code, 'pages-restore-outcome-unknown');
  }
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
  assert.equal(recovered.phase, 'rollback-pending');
  assert.equal(restoreBefore.calls.filter(call=>call==='restoreProject').length,1);
});

test('missing Worker mutation acknowledgements block state-based success until exact durable evidence exists',async()=>{
  const activation=new WorkerClient({interruptAfterActivation:true,missingAcknowledgement:'activate'});
  const prepared=await prepareWorkerVersion(plan(),activation,OPTIONS);
  const pending=await activatePreparedWorker(prepared,activation,{...OPTIONS,verify:async()=>safetyVerification()});
  assert.equal(pending.phase,'activation-ack-pending');
  assert.equal((await recoverWorkerActivation(pending,activation,{...OPTIONS,verify:async()=>safetyVerification()})).phase,'activation-ack-pending');
  activation.acknowledgements.set(pending.pendingMutation.operationDigest,mockAcknowledgement(pending.pendingMutation));
  const recovered=await recoverWorkerActivation(pending,activation,{...OPTIONS,verify:async()=>safetyVerification()});
  assert.equal(recovered.phase,'activated-after-interruption');
  assert.equal(activation.calls.filter(call=>call==='activateVersion').length,1);

  const rollback=new WorkerClient({interruptRollback:'after',missingAcknowledgement:'rollback'});
  const rollbackPrepared=await prepareWorkerVersion(plan(),rollback,OPTIONS);
  const rollbackPending=await activatePreparedWorker(rollbackPrepared,rollback,{...OPTIONS,verify:async()=>{throw new Error('verify');}});
  assert.equal(rollbackPending.phase,'rollback-ack-pending');
  assert.equal((await recoverWorkerRollback(rollbackPending,rollback,OPTIONS)).phase,'rollback-ack-pending');
  rollback.acknowledgements.set(rollbackPending.pendingMutation.operationDigest,mockAcknowledgement(rollbackPending.pendingMutation));
  assert.equal((await recoverWorkerRollback(rollbackPending,rollback,OPTIONS)).phase,'rolled-back-after-interruption');
  assert.equal(rollback.calls.filter(call=>call==='rollbackVersion').length,1);
});

test('missing Pages mutation acknowledgements block state-based success until exact durable evidence exists',async()=>{
  const update=new PagesClient({interruptUpdate:'after',missingAcknowledgement:'update'}),prepared=await preparePages(update);
  const pending=await applyPagesConfiguration(prepared,update,pagesOptions(update,{verify:async()=>safetyVerification({candidateUi:true})}));
  assert.equal(pending.phase,'pages-update-ack-pending');
  assert.equal((await recoverPagesConfiguration(pending,update,pagesOptions(update,{verify:async()=>safetyVerification({candidateUi:true})}))).phase,'pages-update-ack-pending');
  update.acknowledgements.set(pending.pendingMutation.operationDigest,mockAcknowledgement(pending.pendingMutation));
  assert.equal((await recoverPagesConfiguration(pending,update,pagesOptions(update,{verify:async()=>safetyVerification({candidateUi:true})}))).phase,'applied-after-interruption');
  assert.equal(update.calls.filter(call=>call==='updateProject').length,1);

  const restore=new PagesClient({interruptRestore:'after',missingAcknowledgement:'restore'}),restorePrepared=await preparePages(restore);
  const restorePending=await applyPagesConfiguration(restorePrepared,restore,pagesOptions(restore,{verify:async()=>{throw new Error('verify');}}));
  assert.equal(restorePending.phase,'pages-restore-ack-pending');
  assert.equal((await recoverPagesConfiguration(restorePending,restore,pagesOptions(restore))).phase,'pages-restore-ack-pending');
  restore.acknowledgements.set(restorePending.pendingMutation.operationDigest,mockAcknowledgement(restorePending.pendingMutation));
  assert.equal((await recoverPagesConfiguration(restorePending,restore,pagesOptions(restore))).phase,'rolled-back-after-interruption');
  assert.equal(restore.calls.filter(call=>call==='restoreProject').length,1);
});

test('persisted authenticated acknowledgements recover all five mutations without another mutation or broker query',async()=>{
  const withAck=receipt=>({...receipt,acknowledgedMutation:{reference:structuredClone(receipt.pendingMutation),acknowledgement:mockAcknowledgement(receipt.pendingMutation)}});

  const upload=new WorkerClient({interruptUpload:'after',missingAcknowledgement:'upload'}),uploadPending=await prepareWorkerVersion(plan(),upload,OPTIONS),uploadQueries=upload.calls.filter(call=>call.startsWith('readMutationAcknowledgement:')).length;
  assert.equal((await recoverWorkerPreparation(withAck(uploadPending),upload,OPTIONS)).phase,'prepared-after-interruption');assert.equal(upload.calls.filter(call=>call==='uploadVersion').length,1);assert.equal(upload.calls.filter(call=>call.startsWith('readMutationAcknowledgement:')).length,uploadQueries);

  const activation=new WorkerClient({interruptAfterActivation:true,missingAcknowledgement:'activate'}),activationPrepared=await prepareWorkerVersion(plan(),activation,OPTIONS),activationPending=await activatePreparedWorker(activationPrepared,activation,{...OPTIONS,verify:async()=>safetyVerification()}),activationQueries=activation.calls.filter(call=>call.startsWith('readMutationAcknowledgement:')).length;
  assert.equal((await recoverWorkerActivation(withAck(activationPending),activation,{...OPTIONS,verify:async()=>safetyVerification()})).phase,'activated-after-interruption');assert.equal(activation.calls.filter(call=>call==='activateVersion').length,1);assert.equal(activation.calls.filter(call=>call.startsWith('readMutationAcknowledgement:')).length,activationQueries);

  const rollback=new WorkerClient({interruptRollback:'after',missingAcknowledgement:'rollback'}),rollbackPrepared=await prepareWorkerVersion(plan(),rollback,OPTIONS),rollbackPending=await activatePreparedWorker(rollbackPrepared,rollback,{...OPTIONS,verify:async()=>{throw new Error('verify');}}),rollbackQueries=rollback.calls.filter(call=>call.startsWith('readMutationAcknowledgement:')).length;
  assert.equal((await recoverWorkerRollback(withAck(rollbackPending),rollback,OPTIONS)).phase,'rolled-back-after-interruption');assert.equal(rollback.calls.filter(call=>call==='rollbackVersion').length,1);assert.equal(rollback.calls.filter(call=>call.startsWith('readMutationAcknowledgement:')).length,rollbackQueries);

  const update=new PagesClient({interruptUpdate:'after',missingAcknowledgement:'update'}),updatePrepared=await preparePages(update),updatePending=await applyPagesConfiguration(updatePrepared,update,pagesOptions(update,{verify:async()=>safetyVerification({candidateUi:true})})),updateQueries=update.calls.filter(call=>call.startsWith('readMutationAcknowledgement:')).length;
  assert.equal((await recoverPagesConfiguration(withAck(updatePending),update,pagesOptions(update,{verify:async()=>safetyVerification({candidateUi:true})}))).phase,'applied-after-interruption');assert.equal(update.calls.filter(call=>call==='updateProject').length,1);assert.equal(update.calls.filter(call=>call.startsWith('readMutationAcknowledgement:')).length,updateQueries);

  const restore=new PagesClient({interruptRestore:'after',missingAcknowledgement:'restore'}),restorePrepared=await preparePages(restore),restorePending=await applyPagesConfiguration(restorePrepared,restore,pagesOptions(restore,{verify:async()=>{throw new Error('verify');}})),restoreQueries=restore.calls.filter(call=>call.startsWith('readMutationAcknowledgement:')).length;
  assert.equal((await recoverPagesConfiguration(withAck(restorePending),restore,pagesOptions(restore))).phase,'rolled-back-after-interruption');assert.equal(restore.calls.filter(call=>call==='restoreProject').length,1);assert.equal(restore.calls.filter(call=>call.startsWith('readMutationAcknowledgement:')).length,restoreQueries);
});

test('acknowledged activation and Pages update never classify stale before-state as unattempted',async()=>{
  const worker=new WorkerClient(),prepared=await prepareWorkerVersion(plan(),worker,OPTIONS),activationReference=mockMutationReference('worker-activate-version',{versionId:prepared.candidate.versionId,expectedEtag:prepared.before.etag,owner:prepared.leaseOwner}),activationPending={...prepared,phase:'activation-ack-pending',pendingMutation:activationReference,acknowledgedMutation:{reference:activationReference,acknowledgement:mockAcknowledgement(activationReference)}};
  assert.equal((await recoverWorkerActivation(prepared,worker,{...OPTIONS,verify:async()=>safetyVerification()})).phase,'interrupted-before-activation');
  const staleWorker=await recoverWorkerActivation(activationPending,worker,{...OPTIONS,verify:async()=>safetyVerification()});assert.equal(staleWorker.phase,'activation-ack-pending');assert.equal(worker.calls.filter(call=>call==='activateVersion').length,0);
  worker.active={...worker.active,versionId:prepared.candidate.versionId,deploymentId:'worker-deploy-candidate',configDigest:prepared.candidate.configDigest,etag:'worker-etag-2',mutationOwner:prepared.leaseOwner};
  assert.equal((await recoverWorkerActivation(activationPending,worker,{...OPTIONS,verify:async()=>safetyVerification()})).phase,'activated-after-interruption');assert.equal(worker.calls.filter(call=>call==='activateVersion').length,0);

  const pages=new PagesClient(),pagesPrepared=await preparePages(pages),updateSpec={configDigest:pagesPrepared.plan.desired.pages.configDigest,payload:pagesPrepared.plan.desired.pages.payload,expectedEtag:pagesPrepared.before.etag,owner:pagesPrepared.leaseOwner},updateReference=mockMutationReference('pages-update-project',updateSpec),pagesPending={...pagesPrepared,phase:'pages-update-ack-pending',pendingMutation:updateReference,acknowledgedMutation:{reference:updateReference,acknowledgement:mockAcknowledgement(updateReference)}};
  const stalePages=await recoverPagesConfiguration(pagesPending,pages,pagesOptions(pages,{verify:async()=>safetyVerification({candidateUi:true})}));assert.equal(stalePages.phase,'pages-update-ack-pending');assert.equal(pages.calls.filter(call=>call==='updateProject').length,0);
  pages.current={...pages.current,configDigest:pagesPrepared.plan.desired.pages.configDigest,payload:structuredClone(pagesPrepared.plan.desired.pages.payload),etag:'pages-etag-2',mutationOwner:pagesPrepared.leaseOwner};
  assert.equal((await recoverPagesConfiguration(pagesPending,pages,pagesOptions(pages,{verify:async()=>safetyVerification({candidateUi:true})}))).phase,'applied-after-interruption');assert.equal(pages.calls.filter(call=>call==='updateProject').length,0);
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
  assert.match(runbook, new RegExp(PRODUCTION_ACCOUNT_TRUST_POLICY_DIGEST));
  assert.match(runbook, new RegExp(profileDigest(PRODUCTION_ACCOUNT_PROFILE)));
  assert.match(runbook, new RegExp(pipelineDigest(PRODUCTION_ACCOUNT_PROFILE)));
  const workflows = ['ui-staging.yml','ui-release.yml']
    .map(name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(workflows, /allowProvisional|production-account-billing-v1|PRODUCTION_ACCOUNT_PROFILE/);
});
