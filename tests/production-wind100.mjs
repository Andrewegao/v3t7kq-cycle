import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  COMPONENTS, COMPONENT_PREFIX, DATA, ORIGIN, POINTER_KEY, POINTER_KIND, SELECTION_KIND,
  activateCandidate, bindPointIntegrityInvocation, capacityWarning, controllerDigest, createStorage,
  RECLAIM_BUDGET_MS, findQualifiedInput, gate, hash, main, reclaimProgress, reportReclaim,
  nextPointer, pointerEntry, publishCandidate, readProductionPolicy, recurringPrefixCapacity,
  rollbackToPrior, validatePointer, validateQualification, validateSelection,
} from '../tools/production-wind100.mjs';
import { INLINE_RECLAIM, MAX_DELETES, boundedReclaimIo, createReclaimIo, createRetentionIo, executeRetention, planRetention, reclaimRetired,
  retentionNotices, scopedDeleteCredentials } from '../tools/production-wind100-retention.mjs';
import { ORPHAN_MIN_AGE_MS } from '../tools/wind100-retention.mjs';
import { planRetention as planRetention440 } from './fixtures/wind100-retention-440/planner.mjs';

const now = Date.parse('2026-09-23T18:00:00Z');
const sha = char => char.repeat(64);
const encode = value => Buffer.from(`${JSON.stringify(value)}\n`);
const env = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'schedule',
  GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/bake.yml@refs/heads/main',
  GITHUB_JOB: 'wind100', GITHUB_RUN_ID: '35834279562', GITHUB_RUN_ATTEMPT: '1',
  WIND100_PRODUCTION_ENVIRONMENT: 'data-production-wind100', PRODUCTION_WIND100_ENABLED: 'true',
  PRODUCTION_WIND100_APPROVED_SOURCE_SHA: readProductionPolicy().sourceSha,
  PRODUCTION_WIND100_CONTROLLER_SHA256: controllerDigest(),
  PRODUCTION_WIND100_GC_READY_SHA256: controllerDigest(),
  PRODUCTION_WIND100_R2_ACCOUNT_ID: 'a89f9a1af485021fbc60a68b163c7c6e',
  ATMOS_SHA: readProductionPolicy().sourceSha, CORE_ATMOS_SHA: readProductionPolicy().coreSourceSha,
  MODEL_ID: 'ecmwf' });
const request = { invocation: '35834279562-1', sourceSha: readProductionPolicy().sourceSha,
  publicationMode: 'point-only-recurring-v1' };

function fixture(runId = '2026092300', invocation = request.invocation,
  { sourceSha = request.sourceSha, objectCount = 1 } = {}) {
  const initializedAt = `${runId.slice(0, 4)}-${runId.slice(4, 6)}-${runId.slice(6, 8)}T${runId.slice(8)}:00:00Z`;
  const freshUntil = new Date(Date.parse(initializedAt) + 30 * 3_600_000).toISOString();
  const descriptor = { runId, initializedAt, freshUntil,
    source: 'ECMWF IFS 0.25 degree direct open-data GRIB',
    variables: { wind_speed: { kind: 'instantaneous', units: 'm/s' },
      wind_speed_100m: { kind: 'instantaneous', units: 'm/s' } } };
  const rows = [{ path: `v2/ecmwf/${runId}/chunks/0/0.bin.gz`, bytes: 100, sha256: sha('a') }];
  const q = { schemaVersion: 2, kind: 'weatherx-staging-native-wind100-point-candidate',
    status: 'CREDENTIAL_FREE_POINT_PACK_INTEGRITY_QUALIFIED_NOT_PUBLISHED',
    model: 'ecmwf', sourceSha, invocation, publicationMode: request.publicationMode,
    inputSha256: sha('b'), runId, initializedAt, freshUntil,
    pointPacks: { objectCount, inventory: rows, descriptor, allFieldsExactlyMatchSourceStage: true },
    native100m: { sourceFields: ['wind100_u', 'wind100_v'], valuesExactlyMatchSourceStage: true,
      valuesRepairedOrFilled: false, perLead: Array.from({ length: 81 }, () => ({ jointCoveragePermille: 1000 })) },
    credentialFreeIntegrityQualification: true, decodedProviderSemanticsVerified: true,
    dependencyClosureApproved: true, authenticatedCorePointInput: true,
    productionWritten: false, sharedReadCanaryActivated: false };
  const qualification = { schemaVersion: 1, kind: 'weatherx-production-native-wind100-qualification',
    targetOrigin: ORIGIN, invocation, sourceSha,
    coreSourceSha: readProductionPolicy().coreSourceSha, inputSha256: q.inputSha256, integrity: q };
  const artifactId = `prod-wind100-recurring-point-ecmwf-${invocation}`;
  const rootPrefix = `components/point-ecmwf/${artifactId}/`;
  const manifest = { schemaVersion: 1, artifactId,
    completedAt: new Date(Date.parse(initializedAt) + 3_600_000).toISOString(),
    componentId: 'point-ecmwf', generationTime: initializedAt,
    inventorySha256: hash(JSON.stringify(rows.map(row => ({
      path: row.path.slice('v2/ecmwf/'.length), size: row.bytes, sha256: row.sha256 })))),
    mounts: ['point-series/v2/ecmwf/'], objectCount,
    quality: { status: 'passed', checks: ['manifest', 'inventory', 'remote_bytes', 'point_series'] },
    rootPrefix, pointSeries: { schemaVersion: 1, modelId: 'ecmwf', descriptor } };
  const manifestBody = encode(manifest);
  const componentReceipt = { expectedPreviousManifestSha256: null, expectedRollbackEpoch: 0,
    manifestKey: `${rootPrefix}component.json`, manifestSha256: hash(manifestBody) };
  return { qualification, componentReceipt, manifestBody };
}

function memoryIo(f) {
  const objects = new Map([[f.componentReceipt.manifestKey, f.manifestBody]]);
  let etag = 0;
  const io = {
    async get(bucket, key) { const body = objects.get(key); return body ? { body, etag: `${etag}` } : null; },
    async immutable(bucket, key, body) {
      assert.equal(bucket, DATA);
      if (objects.has(key)) assert.ok(objects.get(key).equals(body));
      else objects.set(key, body);
    },
    async putPointer(body, previous) {
      if (previous !== (objects.has(POINTER_KEY) ? `${etag}` : null)) return false;
      objects.set(POINTER_KEY, body); etag++; return true;
    },
  };
  return { io, objects };
}

test('protected production gate requires dedicated approval and never accepts staging or broad credentials', () => {
  const approved = env();
  const readyPolicy = readProductionPolicy();
  assert.equal(readyPolicy.retentionProfileStatus, 'verified-pointer-ancestry-gc-v1');
  assert.equal(gate(approved, 'none', readyPolicy).invocation, request.invocation);
  assert.throws(() => gate(approved, 'none',
    { ...readyPolicy, retentionProfileStatus: 'unavailable-until-pointer-ancestry-gc' }),
  /requires reviewed pointer-ancestry GC/);
  for (const change of [
    { PRODUCTION_WIND100_ENABLED: '' }, { WIND100_PRODUCTION_ENVIRONMENT: 'production' },
    { PRODUCTION_WIND100_GC_READY_SHA256: '' },
    { PRODUCTION_WIND100_GC_READY_SHA256: sha('f') },
    { GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-wind100.yml@refs/heads/main' },
    { PRODUCTION_WIND100_CONTROLLER_SHA256: sha('f') },
    { R2_PRODUCTION_ACCESS_KEY_ID: 'broad' }, { STAGING_R2_WRITE_ACCESS_KEY_ID: 'staging' },
    { PRODUCTION_WIND100_R2_ACCESS_KEY_ID: 'premature' },
  ]) assert.throws(() => gate({ ...approved, ...change }, 'none', readyPolicy));
  const metadata = { ...approved, PRODUCTION_WIND100_R2_ACCESS_KEY_ID: 'dedicated-id',
    PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY: 'dedicated-secret' };
  assert.equal(gate(metadata, 'metadata', readyPolicy).sourceSha, request.sourceSha);
  const component = { ...metadata, RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID: 'dedicated-id',
    RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY: 'dedicated-secret',
    RCLONE_CONFIG_WEATHERX_ENDPOINT: 'https://a89f9a1af485021fbc60a68b163c7c6e.r2.cloudflarestorage.com',
    COMPONENT_R2_REMOTE: `weatherx:${COMPONENTS}`, PROMOTE: '0',
    CATALOG_ENDPOINT: 'https://invalid.invalid', CATALOG_PROMOTION_KEY: 'unused-promote-zero' };
  assert.equal(gate(component, 'component', readyPolicy).sourceSha, request.sourceSha);
  assert.throws(() => gate({ ...component, COMPONENT_R2_REMOTE: 'weatherx:weatherx-components-staging' }, 'component', readyPolicy));
  assert.throws(() => gate({ ...component, PROMOTE: '1' }, 'component', readyPolicy));
});

test('production provenance and lease reject staging receipts, expired runs, and false publication facts', () => {
  const f = fixture();
  assert.equal(validateQualification(f.qualification, request, now).runId, '2026092300');
  for (const mutate of [
    value => { value.targetOrigin = 'https://staging.weatherx.org'; },
    value => { value.integrity.inputSha256 = sha('c'); },
    value => { value.integrity.native100m.perLead[0].jointCoveragePermille = 999; },
    value => { value.integrity.freshUntil = '2026-09-23T23:00:00Z'; },
  ]) { const q = structuredClone(f.qualification); mutate(q); assert.throws(() => validateQualification(q, request, now)); }
  assert.throws(() => validateQualification(f.qualification, request, Date.parse('2026-09-24T01:00:00Z')));
});

test('binds shared point integrity to this protected production invocation', () => {
  const f = fixture();
  const unbound = structuredClone(f.qualification.integrity);
  delete unbound.invocation;
  assert.throws(() => validateQualification({ ...f.qualification, integrity: unbound }, request, now));
  const integrity = bindPointIntegrityInvocation(unbound, request.invocation);
  assert.equal(validateQualification({ ...f.qualification, integrity }, request, now).invocation,
    request.invocation);
  assert.throws(() => bindPointIntegrityInvocation(unbound, 'untrusted-invocation'));
  assert.throws(() => bindPointIntegrityInvocation(f.qualification.integrity, request.invocation));
});

test('immutable production metadata is verified before bounded CAS activation and safe prior rollback', async () => {
  const f = fixture(), { io, objects } = memoryIo(f);
  const selection = await publishCandidate({ request, qualification: f.qualification,
    componentReceipt: f.componentReceipt, io, now: () => now, catalogValidator: () => true });
  assert.equal(selection.productionWritten, true);
  assert.equal(selection.isolatedProductionCandidate, true);
  assert.equal(selection.sharedReadPinChanged, false);
  assert.equal(selection.activated, false);
  const digest = hash(objects.get(`production-candidates/wind100/${selection.catalogId}/selection.json`));
  const pointer = await activateCandidate({ selection, selectionSha256: digest, io,
    now: () => now, catalogValidator: () => true });
  assert.equal(pointer.entries[0].catalogId, selection.catalogId);
  assert.equal((await findQualifiedInput({ runId: selection.runId, inputSha256: selection.inputSha256,
    io, now: () => now, catalogValidator: () => true })).status, 'unchanged');
  assert.equal(objects.has('catalogs/current.json'), false);
  const nextRequest = { ...request, invocation: '35834279563-1' };
  const next = fixture('2026092312', nextRequest.invocation);
  objects.set(next.componentReceipt.manifestKey, next.manifestBody);
  const second = await publishCandidate({ request: nextRequest, qualification: next.qualification,
    componentReceipt: next.componentReceipt, io, now: () => now, catalogValidator: () => true });
  const secondSha = hash(objects.get(`production-candidates/wind100/${second.catalogId}/selection.json`));
  await activateCandidate({ selection: second, selectionSha256: secondSha, io,
    now: () => now + 1_000, catalogValidator: () => true });
  const restored = await rollbackToPrior({ io, now: () => now + 2_000, catalogValidator: () => true });
  assert.deepEqual(restored.entries.map(row => row.runId), ['2026092300']);
  assert.throws(() => nextPointer(restored, pointer.entries[0], Date.parse('2026-09-24T08:00:00Z')));
});

test('activation refuses missing or altered immutable objects and exhausted lease', async () => {
  const f = fixture(), { io, objects } = memoryIo(f);
  const selection = await publishCandidate({ request, qualification: f.qualification,
    componentReceipt: f.componentReceipt, io, now: () => now, catalogValidator: () => true });
  const key = `production-candidates/wind100/${selection.catalogId}/selection.json`;
  const body = objects.get(key), digest = hash(body);
  objects.delete(key);
  await assert.rejects(activateCandidate({ selection, selectionSha256: digest, io,
    now: () => now, catalogValidator: () => true }));
  objects.set(key, Buffer.from(body.toString().replace('productionWritten":true', 'productionWritten":false')));
  await assert.rejects(activateCandidate({ selection, selectionSha256: digest, io,
    now: () => now, catalogValidator: () => true }));
  objects.set(key, body);
  await assert.rejects(activateCandidate({ selection, selectionSha256: digest, io,
    now: () => Date.parse('2026-09-24T01:00:00Z'), catalogValidator: () => true }));
});

test('publication refuses altered component readback and metadata before metadata writes', async () => {
  const f = fixture();
  for (const altered of [
    { metadata: { unknown: 'x' } },
    { metadata: { mtime: 'bad' } },
    { contentType: 'text/plain' },
    { contentEncoding: 'gzip' },
    { body: Buffer.from('{}') },
  ]) {
    const { io, objects } = memoryIo(f);
    const baseGet = io.get;
    io.get = async (bucket, key) => ({ ...await baseGet(bucket, key), ...altered });
    await assert.rejects(publishCandidate({ request, qualification: f.qualification,
      componentReceipt: f.componentReceipt, io, now: () => now, catalogValidator: () => true }));
    assert.equal(objects.size, 1);
  }
});

test('CAS collisions and pointer readback faults do not claim activation', async () => {
  const f = fixture(), { io } = memoryIo(f);
  const selection = await publishCandidate({ request, qualification: f.qualification,
    componentReceipt: f.componentReceipt, io, now: () => now, catalogValidator: () => true });
  const digest = hash(encode(selection));
  let calls = 0;
  io.putPointer = async () => { calls++; return false; };
  await assert.rejects(activateCandidate({ selection, selectionSha256: digest, io,
    now: () => now, catalogValidator: () => true }), /bounded CAS/);
  assert.equal(calls, 4);
  io.putPointer = async () => true;
  await assert.rejects(activateCandidate({ selection, selectionSha256: digest, io,
    now: () => now, catalogValidator: () => true }), /readback differs/);
});

test('writer adapter cannot address staging, active catalog, or another component', async () => {
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class PutObjectCommand { constructor(input) { this.input = input; } }
  class ListObjectsV2Command { constructor(input) { this.input = input; } }
  const calls = [];
  const configurations = [];
  const client = { async send(command) { calls.push(command.input); const error = new Error('missing');
    error.$metadata = { httpStatusCode: 404 }; throw error; }, destroy() {} };
  class S3Client { constructor(options) { configurations.push(options); return client; } }
  const e = { PRODUCTION_WIND100_R2_ACCOUNT_ID: env().PRODUCTION_WIND100_R2_ACCOUNT_ID,
    PRODUCTION_WIND100_R2_ACCESS_KEY_ID: 'id', PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY: 'secret' };
  const io = await createStorage(e, request.invocation, undefined,
    { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command });
  assert.deepEqual(configurations[0].credentials, { accessKeyId: 'id', secretAccessKey: 'secret' });
  assert.equal(configurations[0].endpoint,
    'https://a89f9a1af485021fbc60a68b163c7c6e.r2.cloudflarestorage.com');
  assert.equal(await io.get(DATA, POINTER_KEY), null);
  const prior = calls.length;
  for (const [bucket, key] of [[DATA, 'catalogs/current.json'],
    [DATA, 'staging-candidates/wind100/current-v1.json'],
    [COMPONENTS, `${COMPONENT_PREFIX}99-1/component.json`]]) {
    await assert.rejects(io.get(bucket, key));
    await assert.rejects(io.immutable(bucket, key, Buffer.from('x'), { sha256: hash('x') }));
  }
  assert.equal(calls.length, prior, 'refused keys must not reach S3');
  assert.throws(() => recurringPrefixCapacity(50_000, fixture().qualification, now),
    /lacks capacity: existing 50000 \+ planned 2 = 50002 > maximum 50000/);
});

test('workflow stays disabled until two independent production approvals and has no active-catalog promotion', () => {
  const bake = readFileSync(new URL('../.github/workflows/bake.yml', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/production-wind100-recurring.yml', import.meta.url), 'utf8');
  assert.match(bake, /PRODUCTION_WIND100_CALL_ENABLED == 'true'/);
  assert.match(workflow, /name: data-production-wind100/);
  assert.match(workflow, /PRODUCTION_WIND100_APPROVED_SOURCE_SHA/);
  assert.match(workflow, /PRODUCTION_WIND100_CONTROLLER_SHA256/);
  assert.match(workflow, /PRODUCTION_WIND100_R2_ACCESS_KEY_ID/);
  assert.match(workflow, /PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY/);
  assert.match(workflow, /PROMOTE: '0'/);
  const executableWorkflow = workflow.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(executableWorkflow, /catalogs\/current\.json|weatherx-data-staging|weatherx-components-staging/);
  assert.doesNotMatch(workflow, /^\s+R2_PRODUCTION_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY):/m);
  assert.equal(validatePointer({ schemaVersion: 1, kind: POINTER_KIND, targetOrigin: ORIGIN,
    updatedAt: '2026-09-23T18:00:00Z', entries: [pointerEntry({
      schemaVersion: 1, kind: SELECTION_KIND, status: 'DATA_QUALIFIED_NOT_ACTIVATED',
      targetOrigin: ORIGIN, model: 'ecmwf', runId: '2026092300',
      catalogId: `prod-wind100-recurring-${request.invocation}`, catalogSha256: sha('a'),
      sourceSha: request.sourceSha, inputSha256: sha('b'), invocation: request.invocation,
      qualificationCanonicalSha256: sha('c'), initializedAt: '2026-09-23T00:00:00Z',
      freshUntil: '2026-09-24T06:00:00Z', createdAt: '2026-09-23T18:00:00Z',
      publicationMode: request.publicationMode, isolatedProductionCandidate: true,
      sharedReadPinChanged: false, productionWritten: true, activated: false }, sha('d'), now)] }, now).entries.length, 1);
});

test('journal ancestry permits only an expired retired prefix after grace and preserves live entries', async () => {
  const first = fixture(), { io, objects } = memoryIo(first);
  io.listPrefix = async prefix => [...objects.keys()].filter(key => key.startsWith(prefix));
  const selections = [];
  for (const [runId, invocation, tick] of [
    ['2026092300', request.invocation, now],
    ['2026092312', '35834279563-1', now + 1_000],
    ['2026092400', '35834279564-1', Date.parse('2026-09-24T06:00:00Z')],
  ]) {
    const f = fixture(runId, invocation);
    objects.set(f.componentReceipt.manifestKey, f.manifestBody);
    const selection = await publishCandidate({ request: { ...request, invocation },
      qualification: f.qualification, componentReceipt: f.componentReceipt,
      io, now: () => tick, catalogValidator: () => true });
    selections.push(selection);
    await activateCandidate({ selection, selectionSha256: hash(encode(selection)), io,
      now: () => tick, catalogValidator: () => true });
  }
  const retiredPrefix = `${COMPONENT_PREFIX}${request.invocation}/`;
  objects.set(`${retiredPrefix}chunk.bin.gz`, Buffer.from('sample payload'));
  const planningTime = Date.parse('2026-09-25T01:00:00Z');
  const plan = await planRetention({ io, now: () => planningTime,
    catalogValidator: () => true });
  assert.deepEqual(plan.protectedCatalogIds,
    [selections[1].catalogId, selections[2].catalogId].sort());
  assert.deepEqual(plan.candidates.map(x => x.catalogId), [selections[0].catalogId]);
  assert.equal(plan.totalObjects, 2);
  const originalPointer = objects.get(POINTER_KEY);
  let deleted = 0;
  await assert.rejects(executeRetention({ plan, io, now: () => planningTime,
    catalogValidator: () => true,
    approvedPlanSha256: plan.planSha256,
    deleteForPrefix: async prefix => ({ async delete(key) {
      assert.ok(key.startsWith(prefix)); objects.delete(key); deleted++;
      objects.set(POINTER_KEY, Buffer.from(originalPointer.toString()
        .replace('2026-09-24T06:00:00.000Z', '2026-09-24T06:00:01.000Z')));
    } }) }), /pointer changed/);
  assert.equal(deleted, 1);
  objects.set(POINTER_KEY, originalPointer);
  const replay = await planRetention({ io, now: () => planningTime,
    catalogValidator: () => true });
  assert.equal(replay.totalObjects, 1);
  assert.notEqual(replay.planSha256, plan.planSha256);
  const result = await executeRetention({ plan: replay, io, now: () => planningTime,
    catalogValidator: () => true, approvedPlanSha256: replay.planSha256,
    deleteForPrefix: async prefix => ({ async delete(key) {
      assert.ok(key.startsWith(prefix)); objects.delete(key); deleted++;
    } }) });
  assert.equal(result.deleted, 1); assert.equal(deleted, 2);
  assert.ok(objects.has(fixture('2026092312', '35834279563-1').componentReceipt.manifestKey));
  assert.ok(objects.has(fixture('2026092400', '35834279564-1').componentReceipt.manifestKey));
});

test('retention fails closed for missing ancestry, stale approval, and pointer changes', async () => {
  const f = fixture(), { io, objects } = memoryIo(f);
  io.listPrefix = async prefix => [...objects.keys()].filter(key => key.startsWith(prefix));
  const selection = await publishCandidate({ request, qualification: f.qualification,
    componentReceipt: f.componentReceipt, io, now: () => now, catalogValidator: () => true });
  await activateCandidate({ selection, selectionSha256: hash(encode(selection)), io,
    now: () => now, catalogValidator: () => true });
  const plan = await planRetention({ io, now: () => now, catalogValidator: () => true });
  assert.equal(plan.totalObjects, 0);
  await assert.rejects(executeRetention({ plan, io, catalogValidator: () => true,
    approvedPlanSha256: sha('f') }), /approved/);
  const pointer = objects.get(POINTER_KEY);
  objects.set(POINTER_KEY, Buffer.from(pointer.toString().replace('2026-09-23T18:00:00.000Z',
    '2026-09-23T18:00:01.000Z')));
  await assert.rejects(planRetention({ io, now: () => now + 1_000,
    catalogValidator: () => true }));
});

test('cleanup mints a 15-minute DeleteObject-only credential for one exact component prefix', () => {
  const prefix = `${COMPONENT_PREFIX}35834279562-1/`;
  const credential = scopedDeleteCredentials({ accessKeyId: 'abcdefghij',
    secretAccessKey: 's'.repeat(64) }, prefix, 1_800_000_000);
  const jwt = Buffer.from(credential.sessionToken, 'base64').toString().slice(4);
  const parts = jwt.split('.');
  assert.equal(parts[2], createHmac('sha256', 's'.repeat(64))
    .update(`${parts[0]}.${parts[1]}`).digest('base64url'));
  assert.equal(credential.secretAccessKey, hash(jwt));
  const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
  assert.equal(claims.bucket, COMPONENTS);
  assert.equal(Object.hasOwn(claims, 'scope'), false);
  assert.deepEqual(claims.actions, ['DeleteObject']);
  assert.deepEqual(claims.paths.prefixPaths, [prefix]);
  assert.equal(claims.exp - claims.iat, 900);
  assert.throws(() => scopedDeleteCredentials({ accessKeyId: 'abcdefghij',
    secretAccessKey: 's'.repeat(64) }, 'components/point-ecmwf/other/'));
});

test('cleanup adapter refuses broad secrets and routes deletion through scoped session credentials', async () => {
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class ListObjectsV2Command { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; } }
  const sdk = { GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand };
  const calls = [];
  const readClient = { async send(command) { calls.push(command.input); return {
    ContentLength: 2, Body: [Buffer.from('{}')], ETag: 'etag', Contents: [], IsTruncated: false,
  }; }, destroy() {} };
  const settings = { PRODUCTION_WIND100_R2_ACCOUNT_ID: env().PRODUCTION_WIND100_R2_ACCOUNT_ID,
    PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID: 'read-id',
    PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY: 'r'.repeat(64),
    PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID: 'deletekeyid',
    PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY: 'd'.repeat(64) };
  await assert.rejects(createRetentionIo({ ...settings, R2_PRODUCTION_ACCESS_KEY_ID: 'broad' },
    sdk, readClient));
  const sessions = [], deletes = [];
  const io = await createRetentionIo(settings, sdk, readClient, credentials => {
    sessions.push(credentials);
    return { async send(command) { deletes.push(command.input); }, destroy() {} };
  });
  await io.get(DATA, POINTER_KEY);
  await io.listPrefix(`${COMPONENT_PREFIX}35834279562-1/`, 10);
  const prior = calls.length;
  await assert.rejects(io.get(DATA, 'catalogs/current.json'));
  await assert.rejects(io.listPrefix('components/point-ecmwf/other/', 10));
  assert.equal(calls.length, prior);
  const client = await io.deleteForPrefix(`${COMPONENT_PREFIX}35834279562-1/`);
  await client.delete(`${COMPONENT_PREFIX}35834279562-1/component.json`);
  assert.deepEqual(deletes, [{ Bucket: COMPONENTS,
    Key: `${COMPONENT_PREFIX}35834279562-1/component.json` }]);
  const claims = JSON.parse(Buffer.from(Buffer.from(sessions[0].sessionToken, 'base64')
    .toString().slice(4).split('.')[1], 'base64url'));
  assert.deepEqual(claims.paths.prefixPaths, [`${COMPONENT_PREFIX}35834279562-1/`]);
  assert.equal(Object.hasOwn(claims, 'scope'), false);
  assert.deepEqual(claims.actions, ['DeleteObject']);
  await assert.rejects(client.delete('components/point-ecmwf/unrelated/component.json'));
  assert.equal(deletes.length, 1);
});

test('retention workflow defaults to reviewed dry-run and uses separate cleanup credentials', () => {
  const workflow = readFileSync(new URL('../.github/workflows/production-wind100-retention.yml', import.meta.url), 'utf8');
  assert.match(workflow, /dry_run:\n\s+description:[^\n]+\n\s+type: boolean\n\s+required: true\n\s+default: true/);
  assert.match(workflow, /PRODUCTION_WIND100_GC_CALL_ENABLED == 'true'/);
  assert.match(workflow, /name: data-production-wind100-cleanup/);
  assert.match(workflow, /if: \$\{\{ inputs\.dry_run == true \}\}/);
  assert.match(workflow, /if: \$\{\{ inputs\.dry_run == false \}\}/);
  assert.match(workflow, /PRODUCTION_WIND100_GC_APPROVED_PLAN_SHA256/);
  assert.match(workflow, /PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID/);
  assert.match(workflow, /PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID/);
  assert.doesNotMatch(workflow, /R2_PRODUCTION_ACCESS_KEY_ID|STAGING_R2_WRITE_ACCESS_KEY_ID|catalogs\/current\.json/);
});

// ---- Capacity self-reclaim (inline retention), emptied-prefix progress and source re-pins ----

const HOUR = 3_600_000;
const POINT_OBJECTS = 4_140; // measured objects per recurring point component, plus component.json
const runIdAt = time => new Date(time).toISOString().replace(/[-:T]/g, '').slice(0, 10);
const invocationFor = k => `${35834279562 + k}-1`;
const prefixForInvocation = invocation => `${COMPONENT_PREFIX}${invocation}/`;

// Object store with per-prefix component keys so 100 publications of 4,141 objects stay fast.
function storeIo() {
  const data = new Map(), components = new Map(), stats = { deleted: 0, deletedKeys: new Set() };
  const modified = new Map(); // prefix -> ISO LastModified of its newest object
  let etag = 0;
  const prefixOf = key => key.slice(0, key.indexOf('/', COMPONENT_PREFIX.length) + 1);
  const io = {
    async get(bucket, key) {
      if (bucket === COMPONENTS) {
        const body = components.get(prefixOf(key))?.get(key);
        return body ? { body } : null;
      }
      const body = data.get(key);
      return body ? { body, etag: key === POINTER_KEY ? `${etag}` : 'immutable' } : null;
    },
    async immutable(bucket, key, body) {
      assert.equal(bucket, DATA);
      if (data.has(key)) assert.ok(data.get(key).equals(body)); else data.set(key, body);
    },
    async putPointer(body, previous) {
      if (previous !== (data.has(POINTER_KEY) ? `${etag}` : null)) return false;
      data.set(POINTER_KEY, body); etag++; return true;
    },
    async getIfPresent(bucket, key, maximum) { return io.get(bucket, key, maximum); },
    async listPrefix(prefix) { return [...(components.get(prefix)?.keys() ?? [])]; },
    async listNamespace() {
      const rows = [];
      for (const [prefix, keys] of components) for (const key of keys.keys()) rows.push({ key, lastModified: modified.get(prefix) });
      return rows;
    },
    async prefixCount() { let count = 0; for (const keys of components.values()) count += keys.size; return count; },
  };
  const deleteForPrefix = async prefix => ({ async delete(key) {
    assert.ok(key.startsWith(prefix));
    assert.ok(components.get(prefix)?.delete(key));
    stats.deleted++; stats.deletedKeys.add(key);
  } });
  // `at` is the upload time R2 records as each object's LastModified; `count` < the qualified
  // object count models an upload that stopped part way (no component.json yet).
  const upload = (f, at = 0, count = f.qualification.integrity.pointPacks.objectCount) => {
    const prefix = f.componentReceipt.manifestKey.slice(0, -'component.json'.length);
    const keys = new Map();
    for (let index = 0; index < count; index++) keys.set(`${prefix}v2/chunk-${index}.bin.gz`, Buffer.from('x'));
    if (count === f.qualification.integrity.pointPacks.objectCount) keys.set(f.componentReceipt.manifestKey, f.manifestBody);
    components.set(prefix, keys);
    modified.set(prefix, new Date(at).toISOString());
  };
  const pointer = () => JSON.parse(data.get(POINTER_KEY));
  return { io, data, components, modified, stats, deleteForPrefix, upload, pointer };
}

// Mirrors the recurring job order: inline reclaim, capacity check, upload, publish, activate.
// `fail` stops the run after a successful upload: 'upload' part way through the upload,
// 'publish' before the catalog and selection, 'activate' after them but before the pointer swap.
async function publishRun(store, { k, at, init, policy = readProductionPolicy(), reclaim = true,
  orphans = false, fail = null }) {
  const invocation = invocationFor(k);
  const f = fixture(runIdAt(init), invocation, { sourceSha: policy.sourceSha, objectCount: POINT_OBJECTS });
  const reclaimed = reclaim && store.data.has(POINTER_KEY)
    ? await reclaimRetired({ io: store.io, deleteForPrefix: store.deleteForPrefix,
      catalogValidator: () => true, now: () => at, policy, orphans,
      ...(orphans ? INLINE_RECLAIM : {}) }) : null;
  const capacity = recurringPrefixCapacity(await store.io.prefixCount(), f.qualification, at, policy);
  store.upload(f, at - 30 * 60_000, fail === 'upload' ? 1_000 : undefined);
  if (fail === 'upload' || fail === 'publish') return { capacity, reclaimed, f, invocation };
  const selection = await publishCandidate({ request: { ...request, invocation, sourceSha: policy.sourceSha },
    qualification: f.qualification, componentReceipt: f.componentReceipt, io: store.io,
    now: () => at, catalogValidator: () => true, policy });
  if (fail === 'activate') return { selection, capacity, reclaimed, f, invocation };
  await activateCandidate({ selection, selectionSha256: hash(encode(selection)), io: store.io,
    now: () => at, catalogValidator: () => true, policy });
  return { selection, capacity, reclaimed, f, invocation };
}

const BASE = Date.parse('2026-10-01T00:00:00Z');
const cadence = k => ({ k, init: BASE + k * 6 * HOUR, at: BASE + k * 6 * HOUR + 9 * HOUR });

// Twelve 4,141-object publications fill 49,692 of 50,000 objects, as production did on 10-13.
async function backlog() {
  const store = storeIo();
  for (let k = 0; k < 12; k++) await publishRun(store, { ...cadence(k), reclaim: false });
  assert.equal(await store.io.prefixCount(), 49_692);
  return store;
}

function assertProtectedIntact(store) {
  for (const entry of store.pointer().entries) {
    const prefix = prefixForInvocation(entry.catalogId.slice('prod-wind100-recurring-'.length));
    assert.equal(store.components.get(prefix)?.size, POINT_OBJECTS + 1, `${entry.catalogId} lost objects`);
  }
}

test('capacity refusal and headroom warning print existing, planned and maximum counts', async () => {
  const store = await backlog();
  const next = fixture(runIdAt(cadence(12).init), invocationFor(12), { objectCount: POINT_OBJECTS });
  assert.throws(() => recurringPrefixCapacity(49_692, next.qualification, cadence(12).at),
    /lacks capacity: existing 49692 \+ planned 4141 = 53833 > maximum 50000/);
  const roomy = recurringPrefixCapacity(37_577, next.qualification, cadence(12).at);
  assert.deepEqual(roomy, { existingObjects: 37_577, plannedObjects: 4_141, maximumObjects: 50_000,
    headroomPublications: 3 });
  assert.equal(capacityWarning(roomy), null);
  const tight = recurringPrefixCapacity(37_578, next.qualification, cadence(12).at);
  assert.equal(tight.headroomPublications, 2);
  assert.match(capacityWarning(tight),
    /headroom is 2 publication\(s\) including this one \(existing 37578, planned 4141, maximum 50000\)/);
  const code = readFileSync(new URL('../tools/production-wind100.mjs', import.meta.url), 'utf8');
  assert.match(code, /if \(warning\) log\(`::warning title=Production Wind100 capacity::\$\{warning\}`\)/);
  assert.equal(store.stats.deleted, 0);
});

test('an emptied retired prefix is skipped so planning progresses to older retired prefixes', async () => {
  const store = await backlog();
  const at = cadence(12).at;
  // An earlier run (the 10-10 manual cleanup) emptied the oldest retired prefix.
  const emptied = prefixForInvocation(invocationFor(0));
  store.components.set(emptied, new Map());
  const plan = await planRetention({ io: store.io, now: () => at, catalogValidator: () => true });
  assert.deepEqual(plan.skippedEmptyCatalogIds, [`prod-wind100-recurring-${invocationFor(0)}`]);
  assert.deepEqual(plan.candidates.map(row => row.prefix),
    [prefixForInvocation(invocationFor(1)), prefixForInvocation(invocationFor(2))]);
  assert.ok(plan.candidates.every(row => row.keys.length === POINT_OBJECTS + 1));
  await executeRetention({ plan, io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: () => true, approvedPlanSha256: plan.planSha256, now: () => at });
  // The next dry run moves on instead of re-selecting the prefixes it already emptied.
  const replan = await planRetention({ io: store.io, now: () => at, catalogValidator: () => true });
  assert.deepEqual(replan.skippedEmptyCatalogIds, [0, 1, 2].map(k => `prod-wind100-recurring-${invocationFor(k)}`));
  assert.deepEqual(replan.candidates.map(row => row.prefix),
    [prefixForInvocation(invocationFor(3)), prefixForInvocation(invocationFor(4))]);
  // Once every eligible retired prefix (runs 0-5 here) is empty the plan is empty, not stuck on
  // an empty candidate.
  for (const k of [3, 4, 5]) store.components.set(prefixForInvocation(invocationFor(k)), new Map());
  const drained = await planRetention({ io: store.io, now: () => at, catalogValidator: () => true });
  assert.deepEqual(drained.candidates, []);
  assert.equal(drained.totalObjects, 0);
  assert.equal(drained.skippedEmptyCatalogIds.length, 6);
  assert.equal((await reclaimRetired({ io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: () => true, now: () => at })).status, 'nothing-to-reclaim');
});

test('one plan carries several candidates inside a hard delete bound that fits two full prefixes', async () => {
  const store = await backlog();
  const at = cadence(12).at;
  const plan = await planRetention({ io: store.io, now: () => at, catalogValidator: () => true });
  assert.equal(plan.maximumCandidates, 2);
  assert.equal(plan.maximumObjects, MAX_DELETES);
  assert.equal(plan.candidates.length, 2);
  assert.equal(plan.totalObjects, 2 * (POINT_OBJECTS + 1));
  assert.ok(MAX_DELETES >= 2 * (POINT_OBJECTS + 1) && MAX_DELETES <= 10_000);
  // Asking for more candidates still stops at the delete budget rather than exceeding it.
  const wide = await planRetention({ io: store.io, now: () => at + 4 * 24 * HOUR,
    catalogValidator: () => true, maximumCandidates: 8 });
  assert.equal(wide.candidates.length, 2);
  assert.ok(wide.totalObjects <= MAX_DELETES);
  await assert.rejects(planRetention({ io: store.io, now: () => at, catalogValidator: () => true,
    maximumObjects: MAX_DELETES + 1 }));
  await assert.rejects(executeRetention({ plan, io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: () => true, approvedPlanSha256: plan.planSha256, now: () => at,
    maximumDeletes: MAX_DELETES + 1 }));
  await assert.rejects(executeRetention({ plan, io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: () => true, approvedPlanSha256: plan.planSha256, now: () => at,
    maximumDeletes: POINT_OBJECTS }), /delete budget/);
  assert.equal(store.stats.deleted, 0);
  const result = await executeRetention({ plan, io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: () => true, approvedPlanSha256: plan.planSha256, now: () => at });
  assert.equal(result.deleted, 2 * (POINT_OBJECTS + 1));
  assert.equal(await store.io.prefixCount(), 49_692 - 2 * (POINT_OBJECTS + 1));
});

test('protected current and rollback entries are never selected, even long past their grace', async () => {
  const store = await backlog();
  const later = cadence(12).at + 10 * 24 * HOUR; // stale pointer: both live entries expired long ago
  const protectedIds = store.pointer().entries.map(row => row.catalogId).sort();
  let rounds = 0;
  for (;;) {
    const result = await reclaimRetired({ io: store.io, deleteForPrefix: store.deleteForPrefix,
      catalogValidator: () => true, now: () => later });
    for (const id of result.candidates) assert.ok(!protectedIds.includes(id));
    if (result.status === 'nothing-to-reclaim') break;
    assert.ok(++rounds <= 10);
  }
  assertProtectedIntact(store);
  assert.equal(await store.io.prefixCount(), 2 * (POINT_OBJECTS + 1));
  for (const key of store.stats.deletedKeys)
    assert.ok(!protectedIds.some(id => key.startsWith(prefixForInvocation(id.slice('prod-wind100-recurring-'.length)))));
  // A tampered plan naming a protected entry is refused before any deletion.
  const plan = await planRetention({ io: store.io, now: () => later, catalogValidator: () => true });
  const protectedEntry = store.pointer().entries[0];
  const prefix = prefixForInvocation(protectedEntry.catalogId.slice('prod-wind100-recurring-'.length));
  const { planSha256: _, ...content } = plan;
  const forged = { ...content, candidates: [{ catalogId: protectedEntry.catalogId, runId: protectedEntry.runId,
    freshUntil: protectedEntry.freshUntil, prefix, keys: [...store.components.get(prefix).keys()].sort() }] };
  forged.totalObjects = forged.candidates[0].keys.length;
  const signed = { ...forged, planSha256: hash(JSON.stringify(forged)) };
  const before = store.stats.deleted;
  await assert.rejects(executeRetention({ plan: signed, io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: () => true, approvedPlanSha256: signed.planSha256, now: () => later }), /plan changed/);
  assert.equal(store.stats.deleted, before);
  assertProtectedIntact(store);
});

test('inline reclaim keeps 100 successive publications under the cap, including missed reclaims', async () => {
  const store = storeIo();
  let peak = 0, warnings = 0, reclaimedRuns = 0;
  for (let k = 0; k < 100; k++) {
    // Every ninth reclaim fails (transport or credential fault); the next run catches up.
    const run = await publishRun(store, { ...cadence(k), reclaim: k % 9 !== 4 });
    peak = Math.max(peak, run.capacity.existingObjects + run.capacity.plannedObjects);
    if (capacityWarning(run.capacity)) warnings++;
    if (run.reclaimed?.deleted) reclaimedRuns++;
    assertProtectedIntact(store);
  }
  assert.ok(peak <= 50_000, `peak ${peak}`);
  assert.ok(peak <= 8 * (POINT_OBJECTS + 1), `steady state should stay well under the cap, peak ${peak}`);
  assert.equal(warnings, 0);
  assert.ok(reclaimedRuns >= 80);
});

test('inline reclaim recovers the at-cap backlog on the first publication after deployment', async () => {
  const store = await backlog();
  // Without reclaim the 13th publication is refused (production since 10-14).
  const blocked = fixture(runIdAt(cadence(12).init), invocationFor(12), { objectCount: POINT_OBJECTS });
  assert.throws(() => recurringPrefixCapacity(49_692, blocked.qualification, cadence(12).at), /lacks capacity/);
  store.components.set(prefixForInvocation(invocationFor(0)), new Map()); // the 10-10 manual deletion
  // Four days later the pointer is stale; the first publication reclaims and succeeds.
  const late = { k: 30, init: cadence(30).init, at: cadence(30).at };
  const run = await publishRun(store, late);
  assert.equal(run.reclaimed.status, 'reclaimed-retired-production-wind100-objects');
  assert.equal(run.reclaimed.candidates.length, 2);
  assert.ok(run.capacity.existingObjects + run.capacity.plannedObjects <= 50_000);
  assert.equal(store.pointer().entries[0].catalogId, run.selection.catalogId);
  for (let k = 31; k < 40; k++) {
    const next = await publishRun(store, cadence(k));
    assert.ok(next.capacity.existingObjects + next.capacity.plannedObjects <= 50_000);
  }
  assertProtectedIntact(store);
});

test('a Wind100 source re-pin keeps activation, rollback and retention working on prior entries', async () => {
  const oldPolicy = readProductionPolicy();
  const newPin = 'e'.repeat(40);
  const newPolicy = { ...oldPolicy, sourceSha: newPin, previousSourceShas: [oldPolicy.sourceSha] };
  const strictPolicy = { ...newPolicy, previousSourceShas: [] };
  const store = storeIo();
  for (let k = 0; k < 4; k++) await publishRun(store, { ...cadence(k), policy: oldPolicy });
  const oldPointer = store.pointer();
  // Without the allowlist the next pin cannot even read the live pointer (the pre-fix failure).
  assert.throws(() => validatePointer(oldPointer, cadence(4).at, strictPolicy), /allowlisted previous pin/);
  assert.equal(validatePointer(oldPointer, cadence(4).at, newPolicy), oldPointer);
  // The same model input selected under the old pin is republished under the new one.
  const oldHead = oldPointer.entries[0];
  assert.equal((await findQualifiedInput({ runId: oldHead.runId, inputSha256: oldHead.inputSha256,
    io: store.io, now: () => cadence(4).at, catalogValidator: () => true, policy: newPolicy })).status, 'new-input');
  // New entries must carry the current pin.
  const stale = fixture(runIdAt(cadence(4).init), invocationFor(4), { sourceSha: oldPolicy.sourceSha });
  await assert.rejects(publishCandidate({ request: { ...request, invocation: invocationFor(4) },
    qualification: stale.qualification, componentReceipt: stale.componentReceipt, io: store.io,
    now: () => cadence(4).at, catalogValidator: () => true, policy: newPolicy }));
  const forgedSelection = { ...JSON.parse(store.data.get(oldHead.selectionKey)) };
  await assert.rejects(activateCandidate({ selection: forgedSelection,
    selectionSha256: oldHead.selectionSha256, io: store.io, now: () => cadence(4).at,
    catalogValidator: () => true, policy: newPolicy }), /current pin/);
  // Activation under the new pin keeps the old-pin prior entry as the rollback target.
  const first = await publishRun(store, { ...cadence(4), policy: newPolicy });
  assert.deepEqual(store.pointer().entries.map(row => row.sourceSha), [newPin, oldPolicy.sourceSha]);
  assert.equal(first.selection.sourceSha, newPin);
  // Rollback may restore the allowlisted prior entry; it is not a new selection.
  const restored = await rollbackToPrior({ io: store.io, now: () => cadence(4).at + 60_000,
    catalogValidator: () => true, policy: newPolicy });
  assert.equal(restored.entries[0].sourceSha, oldPolicy.sourceSha);
  // Publishing continues and retention walks journal records written under both pins.
  for (let k = 5; k < 14; k++) await publishRun(store, { ...cadence(k), policy: newPolicy });
  assertProtectedIntact(store);
  const removedOld = [0, 1, 2, 3].filter(k => (store.components.get(prefixForInvocation(invocationFor(k)))?.size ?? 0) === 0);
  assert.ok(removedOld.length >= 3, `old-pin prefixes reclaimed: ${removedOld}`);
  const plan = await planRetention({ io: store.io, now: () => cadence(14).at, catalogValidator: () => true,
    policy: newPolicy });
  assert.ok(plan.ancestryRecordsChecked > 10);
  await assert.rejects(planRetention({ io: store.io, now: () => cadence(14).at, catalogValidator: () => true,
    policy: strictPolicy }));
});

test('inline reclaim adapter uses only the dedicated writer token and per-prefix DeleteObject credentials', async () => {
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class ListObjectsV2Command { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; } }
  const sdk = { GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand };
  const readClient = { async send() { return { ContentLength: 2, Body: [Buffer.from('{}')], ETag: 'e',
    Contents: [], IsTruncated: false }; }, destroy() {} };
  const writer = { PRODUCTION_WIND100_R2_ACCOUNT_ID: env().PRODUCTION_WIND100_R2_ACCOUNT_ID,
    PRODUCTION_WIND100_R2_ACCESS_KEY_ID: 'writerkeyid', PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY: 'w'.repeat(64) };
  await assert.rejects(createReclaimIo({ ...writer, PRODUCTION_WIND100_R2_ACCESS_KEY_ID: '' }, sdk, readClient));
  for (const extra of ['PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID',
    'PRODUCTION_WIND100_GC_APPROVED_PLAN_SHA256', 'R2_PRODUCTION_ACCESS_KEY_ID', 'STAGING_R2_WRITE_ACCESS_KEY_ID'])
    await assert.rejects(createReclaimIo({ ...writer, [extra]: 'x' }, sdk, readClient), new RegExp(extra));
  // The manual cleanup adapter still refuses the writer token.
  await assert.rejects(createRetentionIo({ ...writer, PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID: 'r',
    PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY: 'r' }, sdk, readClient), /refuses PRODUCTION_WIND100_R2/);
  const sessions = [], deletes = [];
  const io = await createReclaimIo(writer, sdk, readClient, credentials => {
    sessions.push(credentials);
    return { async send(command) { deletes.push(command.input); }, destroy() {} };
  });
  await assert.rejects(io.get(DATA, 'catalogs/current.json'));
  await assert.rejects(io.listPrefix('components/point-ecmwf/other/', 10));
  const prefix = `${COMPONENT_PREFIX}35834279562-1/`;
  const client = await io.deleteForPrefix(prefix);
  await client.delete(`${prefix}component.json`);
  await assert.rejects(client.delete('components/point-ecmwf/unrelated/component.json'));
  assert.deepEqual(deletes, [{ Bucket: COMPONENTS, Key: `${prefix}component.json` }]);
  const claims = JSON.parse(Buffer.from(Buffer.from(sessions[0].sessionToken, 'base64')
    .toString().slice(4).split('.')[1], 'base64url'));
  assert.equal(claims.iss, 'writerkeyid');
  assert.deepEqual(claims.actions, ['DeleteObject']);
  assert.deepEqual(claims.paths.prefixPaths, [prefix]);
  assert.equal(claims.exp - claims.iat, 900);
  assert.notEqual(sessions[0].secretAccessKey, writer.PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY);
});

test('recurring workflow reclaims before the capacity check with its existing writer credentials only', () => {
  const workflow = readFileSync(new URL('../.github/workflows/production-wind100-recurring.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/\n      - /);
  const reclaimIndex = steps.findIndex(step => step.startsWith('name: Reclaim retired and never-activated production point prefixes'));
  const uploadIndex = steps.findIndex(step => step.startsWith('name: Upload one immutable production point component'));
  assert.ok(reclaimIndex > 0 && uploadIndex === reclaimIndex + 1);
  const reclaim = steps[reclaimIndex], upload = steps[uploadIndex];
  assert.match(reclaim, /continue-on-error: true/);
  assert.match(reclaim, /timeout-minutes: 30/);
  assert.match(reclaim, /if: \$\{\{ steps\.preflight\.outputs\.status == 'new-input' \}\}/);
  assert.match(reclaim, /node cycle\/tools\/production-wind100\.mjs reclaim "\$GITHUB_WORKSPACE\/atmos"/);
  const secrets = name => [...name.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]).sort();
  assert.deepEqual(secrets(reclaim), ['PRODUCTION_WIND100_R2_ACCESS_KEY_ID', 'PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY']);
  assert.ok(secrets(reclaim).every(name => secrets(upload).includes(name)));
  assert.doesNotMatch(reclaim, /RCLONE_CONFIG|GC_|APPROVED_PLAN/);
  assert.match(upload, /retention-gate production-wind100\/qualification\.json/);
  assert.doesNotMatch(workflow, /PRODUCTION_WIND100_GC_(?:READ|DELETE)_|data-production-wind100-cleanup/);
  assert.deepEqual([...workflow.matchAll(/^\s+name: (data-production[\w-]*)$/gm)].map(match => match[1]),
    ['data-production-wind100']);
  assert.deepEqual([...workflow.matchAll(/^\s{6}([A-Z0-9_]+):\n\s{8}required:/gm)].map(match => match[1]),
    ['ATMOS_DEPLOY_KEY', 'PRODUCTION_WIND100_R2_ACCESS_KEY_ID', 'PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY']);
});

test('reclaim command runs behind the publisher gate and refuses cleanup or broad credentials before I/O', async () => {
  await assert.rejects(main('reclaim', env(), ['/nonexistent']), /writer credentials are required/);
  const writer = { ...env(), PRODUCTION_WIND100_R2_ACCESS_KEY_ID: 'writerkeyid',
    PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY: 'w'.repeat(64) };
  await assert.rejects(main('reclaim', { ...writer, GITHUB_JOB: 'retention' }, ['/nonexistent']));
  await assert.rejects(main('reclaim', { ...writer, RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID: 'writerkeyid' },
    ['/nonexistent']));
  await assert.rejects(main('reclaim', { ...writer, PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID: 'cleanup' },
    ['/nonexistent']), /inline reclaim refuses PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID/);
});

test('a retired entry the pinned reader now rejects is refused and kept while younger ones are reclaimed', async () => {
  const store = await backlog();
  const at = cadence(12).at;
  const oldest = prefixForInvocation(invocationFor(0));
  // A stricter catalog validator, as after an Atmos reader re-pin, rejects only the oldest catalog.
  const stricter = catalog => catalog.components['point-ecmwf'].rootPrefix !== oldest;
  const plan = await planRetention({ io: store.io, now: () => at, catalogValidator: stricter });
  const oldestId = `prod-wind100-recurring-${invocationFor(0)}`;
  assert.deepEqual(plan.refusedCatalogIds, [oldestId]);
  assert.deepEqual(plan.refusalReasons, { [oldestId]: 'catalog-rejected' });
  assert.deepEqual(plan.candidates.map(row => row.prefix),
    [prefixForInvocation(invocationFor(1)), prefixForInvocation(invocationFor(2))]);
  // The dry-run hash is reproduced by the recomputation inside execution.
  const replay = await planRetention({ io: store.io, now: () => at, catalogValidator: stricter });
  assert.equal(replay.planSha256, plan.planSha256);
  const executed = await executeRetention({ plan, io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: stricter, approvedPlanSha256: plan.planSha256, now: () => at });
  assert.equal(executed.deleted, 2 * (POINT_OBJECTS + 1));
  // Inline reclaim keeps progressing past the refused entry on later runs.
  const result = await reclaimRetired({ io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: stricter, now: () => at });
  assert.equal(result.status, 'reclaimed-retired-production-wind100-objects');
  assert.deepEqual(result.refusedCatalogIds, [oldestId]);
  assert.deepEqual(result.candidates, [3, 4].map(k => `prod-wind100-recurring-${invocationFor(k)}`));
  assert.equal(store.components.get(oldest).size, POINT_OBJECTS + 1, 'a refused prefix is never deleted');
  assertProtectedIntact(store);
  const { warnings, summary } = retentionNotices(result);
  assert.deepEqual(warnings, [`retired ${oldestId} was refused (catalog-rejected) and kept; inspect its selection, catalog and prefix`]);
  assert.match(summary, new RegExp(`refused ${oldestId} \\(catalog-rejected\\)`));
  assert.match(summary, /deleted 8282/);
});

test('missing or altered per-entry evidence is refused with a stable reason; chain damage still aborts', async () => {
  const store = await backlog();
  const at = cadence(12).at;
  const id = k => `prod-wind100-recurring-${invocationFor(k)}`;
  store.data.delete(`production-candidates/wind100/${id(0)}/selection.json`);
  const catalogKey = `catalogs/snapshots/${id(1)}.json`;
  store.data.set(catalogKey, Buffer.from(store.data.get(catalogKey).toString().replace('"sequence":1', '"sequence":2')));
  store.components.get(prefixForInvocation(invocationFor(2))).set(
    `${prefixForInvocation(invocationFor(2))}v2/extra.bin.gz`, Buffer.from('x'));
  const plan = await planRetention({ io: store.io, now: () => at, catalogValidator: () => true });
  assert.deepEqual(plan.refusalReasons, { [id(0)]: 'selection-unavailable', [id(1)]: 'catalog-mismatch',
    [id(2)]: 'inventory-mismatch' });
  assert.deepEqual(plan.candidates.map(row => row.catalogId), [id(3), id(4)]);
  const throwingValidator = () => { throw Error('reader refused'); };
  const rejected = await planRetention({ io: store.io, now: () => at, catalogValidator: throwingValidator });
  assert.deepEqual(rejected.candidates, []);
  assert.equal(rejected.refusalReasons[id(3)], 'catalog-rejected');
  // Pointer or journal-chain integrity damage is not an entry refusal: the whole plan aborts.
  const journalKey = [...store.data.keys()].filter(key => key.includes('/journal/'))[3];
  store.data.set(journalKey, Buffer.from('{"schemaVersion":1}'));
  await assert.rejects(planRetention({ io: store.io, now: () => at, catalogValidator: () => true }));
});

test('reclaim notices become workflow warnings and a step-summary line', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wind100-summary-'));
  try {
    const summaryPath = join(directory, 'summary.md');
    const lines = [];
    const result = { status: 'reclaimed-retired-production-wind100-objects', candidates: ['prod-wind100-recurring-2-1'],
      deleted: 4141, skippedEmptyCatalogIds: ['prod-wind100-recurring-1-1'],
      refusedCatalogIds: ['prod-wind100-recurring-3-1'], refusalReasons: { 'prod-wind100-recurring-3-1': 'catalog-rejected' } };
    reportReclaim(result, retentionNotices, { GITHUB_STEP_SUMMARY: summaryPath }, line => lines.push(line));
    assert.deepEqual(lines, ['::warning title=Production Wind100 reclaim::retired prod-wind100-recurring-3-1 was refused'
      + ' (catalog-rejected) and kept; inspect its selection, catalog and prefix']);
    assert.equal(readFileSync(summaryPath, 'utf8'), 'Production Wind100 retention: reclaimed-retired-production-wind100-objects;'
      + ' candidates prod-wind100-recurring-2-1; deleted 4141; skipped empty 1; refused prod-wind100-recurring-3-1 (catalog-rejected)\n');
    const quiet = [];
    reportReclaim({ ...result, refusedCatalogIds: [], refusalReasons: {} }, retentionNotices, {}, line => quiet.push(line));
    assert.deepEqual(quiet, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  const workflow = readFileSync(new URL('../.github/workflows/production-wind100-retention.yml', import.meta.url), 'utf8');
  assert.match(workflow, /retentionNotices\(JSON\.parse\(readFileSync\(process\.argv\[1\]\)\)\)/);
  assert.match(workflow, /::warning title=Production Wind100 retention::/);
  assert.match(workflow, /GITHUB_STEP_SUMMARY/);
  const code = readFileSync(new URL('../tools/production-wind100.mjs', import.meta.url), 'utf8');
  assert.match(code, /reportReclaim\(result, retentionNotices, env, log\)/);
});

// ---- Real CLI entry: the reclaim command settles or fails loudly, never exit 13 ----
// Bake run 39176755083 (2026-10-18): `production-wind100.mjs reclaim` exited 13 ("unsettled
// top-level await") ~50 ms after start with no IO. The CLI's top-level await held this module's
// evaluation open while main('reclaim') dynamically imported the retention module, which
// statically imports this module back. In-process tests import both modules as dependencies,
// so only a real CLI process reproduces it.

const TOOL = fileURLToPath(new URL('../tools/production-wind100.mjs', import.meta.url));
const writerEnv = () => ({ ...env(), PRODUCTION_WIND100_R2_ACCESS_KEY_ID: 'writerkeyid',
  PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY: 'w'.repeat(64) });
// Runs a fresh Node process with only the given environment (no inherited credentials).
const node = (args, extraEnv = {}) => spawnSync(process.execPath, args,
  { env: { PATH: process.env.PATH, ...extraEnv }, encoding: 'utf8', timeout: 60_000 });

test('the reclaim CLI loads its retention module and fails with context instead of exiting 13', () => {
  // A nonexistent source root and fake writer credentials: it must fail before any network IO.
  const run = node([TOOL, 'reclaim', '/nonexistent'], writerEnv());
  assert.doesNotMatch(run.stderr, /unsettled top-level await/);
  assert.equal(run.status, 1, run.stderr);
  // Past the module import: the failing stage is creating the IO (SDK absent) or loading the
  // catalog validator from the nonexistent source root.
  assert.match(run.stderr, /^Production Wind100 refused: inline reclaim failed \(stage (?:create-io|load-catalog-validator); completed gets 0, lists 0, delete credentials 0, deletes 0\): /);
  // The import cycle remains, so the CLI entry must never use top-level await.
  const retention = readFileSync(new URL('../tools/production-wind100-retention.mjs', import.meta.url), 'utf8');
  assert.match(retention, /from '\.\/production-wind100\.mjs'/);
  const code = readFileSync(TOOL, 'utf8');
  const entry = code.slice(code.lastIndexOf('if (process.argv[1] && import.meta.url'));
  assert.doesNotMatch(entry, /\bawait\b/);
});

const neverSettles = () => new Promise(() => {});
const stubValidator = closed => async () => ({ validate: () => true, close: () => closed.push('validator') });

test('main reclaim times out a never-settling IO call and reports the stage and counts', async () => {
  const closed = [];
  const io = { get: neverSettles, listPrefix: neverSettles, deleteForPrefix: neverSettles,
    close: () => closed.push('io') };
  const started = Date.now();
  await assert.rejects(main('reclaim', writerEnv(), ['/source'], () => {}, {
    createReclaimIo: async () => io, loadCatalogValidator: stubValidator(closed), ioTimeoutMs: 50 }),
  /^Error: inline reclaim failed \(stage plan-and-delete; completed gets 0, lists 0, delete credentials 0, deletes 0\): get production-candidates\/wind100\/current-v1\.json did not settle within 50 ms; no further deletion was attempted$/);
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(closed.sort(), ['io', 'validator']);
  // Setup steps are bounded too.
  await assert.rejects(main('reclaim', writerEnv(), ['/source'], () => {}, {
    createReclaimIo: neverSettles, loadCatalogValidator: stubValidator([]), ioTimeoutMs: 50 }),
  /stage create-io; .*\): create-io did not settle within 50 ms/);
  await assert.rejects(main('reclaim', writerEnv(), ['/source'], () => {}, {
    createReclaimIo: async () => io, loadCatalogValidator: neverSettles, ioTimeoutMs: 50 }),
  /stage load-catalog-validator; .*\): load-catalog-validator did not settle within 50 ms/);
});

test('a never-settling IO call in the real CLI process exits 1 with a report, not 13', () => {
  const driver = `
    const { main, runCli } = await import(${JSON.stringify(new URL('../tools/production-wind100.mjs', import.meta.url).href)});
    const never = () => new Promise(() => {});
    const io = { get: never, listPrefix: never, deleteForPrefix: never, close() {} };
    runCli('reclaim', () => main('reclaim', JSON.parse(process.env.WIND100_TEST_ENV), ['/source'], console.log, {
      createReclaimIo: async () => io,
      loadCatalogValidator: async () => ({ validate: () => true, close() {} }), ioTimeoutMs: 200 }));`;
  const run = node(['--input-type=module', '-e', driver], { WIND100_TEST_ENV: JSON.stringify(writerEnv()) });
  assert.doesNotMatch(run.stderr, /unsettled top-level await/);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /Production Wind100 refused: inline reclaim failed \(stage plan-and-delete; completed gets 0, lists 0, delete credentials 0, deletes 0\): get production-candidates\/wind100\/current-v1\.json did not settle within 200 ms/);
  assert.equal(run.stdout, '');
});

test('a command left pending with nothing to wait for is reported and exits 1, not 13', () => {
  const driver = `
    const { runCli } = await import(${JSON.stringify(new URL('../tools/production-wind100.mjs', import.meta.url).href)});
    runCli('reclaim', () => new Promise(() => {}));`;
  const run = node(['--input-type=module', '-e', driver]);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /^Production Wind100 refused: reclaim never settled; the event loop drained with the command still pending\n$/);
  // A settled command still prints its result and exits 0.
  const ok = node(['--input-type=module', '-e', driver.replace('new Promise(() => {})', "({ status: 'ok' })")]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, '{"status":"ok"}\n');
});

test('a delete that never settles stops reclaim with its count and deletes nothing further', async () => {
  const store = await backlog();
  store.components.set(prefixForInvocation(invocationFor(0)), new Map());
  const before = await store.io.prefixCount();
  let started = 0;
  const hanging = { ...store.io, deleteForPrefix: async prefix => {
    const client = await store.deleteForPrefix(prefix);
    return { delete: key => (++started === 3 ? neverSettles() : client.delete(key)) };
  } };
  const progress = reclaimProgress();
  const io = boundedReclaimIo(hanging, progress, 50);
  await assert.rejects(reclaimRetired({ io, deleteForPrefix: io.deleteForPrefix, catalogValidator: () => true,
    now: () => cadence(30).at }), /^Error: delete components\/point-ecmwf\/prod-wind100-recurring-point-ecmwf-\d+-1\/\S+ did not settle within 50 ms; no further deletion was attempted$/);
  assert.equal(progress.deletes, 2);
  assert.equal(progress.deleteCredentials, 1);
  assert.equal(started, 3);
  assert.equal(await store.io.prefixCount(), before - 2);
  assertProtectedIntact(store);
});

// ---- Inline reclaim throughput, per-batch pointer checks and its wall-clock budget ----
// Bake run 39181515197 (job 117840285830): the reclaim step was killed at its 30-minute bound
// having printed nothing, after about 6,068 of 8,282 deletes (~0.3 s per object: a serial
// pointer re-read plus a serial delete for every key). These tests run whole plans on a virtual
// clock with per-call latency, so minutes of simulated R2 time cost about a second.

const GET_MS = 150, LIST_PAGE_MS = 300, DELETE_MS = 150;
const PLANNED = 2 * (POINT_OBJECTS + 1);

// Timers resolve in virtual-time order once every microtask has drained; `clock` is virtual now.
function virtualTime() {
  let now = 0, sequence = 0;
  const timers = [];
  const sleep = ms => new Promise(resolve => timers.push({ at: now + ms, sequence: sequence++, resolve }));
  async function run(promise) {
    let done = false, value, error;
    promise.then(result => { done = true; value = result; }, failure => { done = true; error = failure; });
    for (;;) {
      await new Promise(resolve => setImmediate(resolve));
      if (done) break;
      assert.ok(timers.length > 0, 'virtual time stalled with work still pending');
      timers.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
      now = timers[0].at;
      while (timers.length && timers[0].at === now) timers.shift().resolve();
    }
    if (error) throw error;
    return value;
  }
  return { clock: () => now, sleep, run };
}

// The reclaim IO surface of `storeIo`, with R2-like latency per call and call counters.
function slowIo(store, time) {
  const calls = { pointerGets: 0, gets: 0, lists: 0, deletes: 0, credentials: 0 };
  return { calls, io: {
    async get(bucket, key, maximum) {
      calls.gets++; if (key === POINTER_KEY) calls.pointerGets++;
      await time.sleep(GET_MS);
      return store.io.get(bucket, key, maximum);
    },
    async getIfPresent(bucket, key, maximum) {
      calls.gets++;
      await time.sleep(GET_MS);
      return store.io.getIfPresent(bucket, key, maximum);
    },
    async listPrefix(prefix, maximum) {
      calls.lists++;
      const keys = await store.io.listPrefix(prefix, maximum);
      await time.sleep(LIST_PAGE_MS * Math.max(1, Math.ceil(keys.length / 1000)));
      return keys;
    },
    async listNamespace(maximum) {
      calls.lists++;
      const rows = await store.io.listNamespace(maximum);
      await time.sleep(LIST_PAGE_MS * Math.max(1, Math.ceil(rows.length / 1000)));
      return rows;
    },
    async deleteForPrefix(prefix) {
      calls.credentials++;
      const client = await store.deleteForPrefix(prefix);
      return { async delete(key) { await time.sleep(DELETE_MS); await client.delete(key); calls.deletes++; },
        close() {} };
    },
    close() {},
  } };
}

const reclaimDeps = (io, time, extra = {}) => ({ createReclaimIo: async () => io,
  loadCatalogValidator: async () => ({ validate: () => true, close() {} }),
  now: () => cadence(12).at, clock: time.clock, ...extra });
const progressLines = lines => lines.filter(line => line.startsWith('reclaim progress: '));
const progressCount = line => Number(/^reclaim progress: deleted (\d+) of /.exec(line)[1]);

test('inline reclaim deletes a two-prefix 8,282-key plan well inside its budget at R2 latency', async () => {
  const store = await backlog();
  const time = virtualTime(), { io, calls } = slowIo(store, time), lines = [];
  const result = await time.run(main('reclaim', writerEnv(), ['/source'], line => lines.push(line),
    reclaimDeps(io, time)));
  assert.equal(result.status, 'reclaimed-retired-production-wind100-objects');
  assert.equal(result.plannedObjects, PLANNED);
  assert.equal(result.deleted, PLANNED);
  assert.equal(result.remainingObjects, 0);
  assert.equal(await store.io.prefixCount(), 49_692 - PLANNED);
  assert.equal(store.stats.deleted, PLANNED);
  assertProtectedIntact(store);
  // About three simulated minutes, against a 20-minute budget and a 30-minute step bound.
  const elapsed = time.clock();
  assert.ok(elapsed < RECLAIM_BUDGET_MS / 4, `inline reclaim took ${elapsed} ms of simulated time`);
  assert.equal(RECLAIM_BUDGET_MS, 20 * 60_000);
  // One pointer re-read per 250-key batch (17 per 4,141-key prefix) plus plan and recomputation.
  const batches = 2 * Math.ceil((POINT_OBJECTS + 1) / INLINE_RECLAIM.batchSize);
  assert.equal(batches, 34);
  assert.equal(calls.pointerGets, 2 + batches);
  assert.equal(calls.credentials, batches);
  assert.equal(calls.deletes, PLANNED);
  const progress = progressLines(lines);
  assert.equal(progress.length, 1 + batches);
  assert.equal(progress[0], `reclaim progress: deleted 0 of ${PLANNED}`);
  assert.equal(progress.at(-1), `reclaim progress: deleted ${PLANNED} of ${PLANNED}`);
  assert.equal(progress[1], `reclaim progress: deleted 250 of ${PLANNED}`);

  // The same plan through the serial executor (the manual lane's defaults, and inline reclaim
  // before this change) needs more than the 30-minute step bound at the same latency.
  const serialStore = await backlog();
  const serialTime = virtualTime(), serial = slowIo(serialStore, serialTime);
  const serialResult = await serialTime.run(reclaimRetired({ io: serial.io,
    deleteForPrefix: serial.io.deleteForPrefix, catalogValidator: () => true, now: () => cadence(12).at }));
  assert.equal(serialResult.deleted, PLANNED);
  assert.equal(serial.calls.pointerGets, 2 + PLANNED);
  assert.ok(serialTime.clock() > 30 * 60_000, `serial reclaim took ${serialTime.clock()} ms`);
});

test('a pointer change between batches stops inline reclaim at the next batch boundary', async () => {
  const store = await backlog();
  const at = cadence(12).at;
  const original = store.data.get(POINTER_KEY);
  const before = await store.io.prefixCount();
  let started = 0;
  const changing = async prefix => {
    const client = await store.deleteForPrefix(prefix);
    return { async delete(key) {
      // Mid-way through the second batch the live pointer changes (same JSON, different bytes).
      if (++started === 300) store.data.set(POINTER_KEY, Buffer.concat([original, Buffer.from(' ')]));
      await client.delete(key);
    } };
  };
  const lines = [];
  await assert.rejects(reclaimRetired({ io: store.io, deleteForPrefix: changing, catalogValidator: () => true,
    now: () => at, ...INLINE_RECLAIM, onProgress: line => lines.push(line) }),
  /production pointer changed after dry-run; replan before deletion/);
  // The second batch was verified before the change and finishes; the third is refused.
  assert.equal(started, 2 * INLINE_RECLAIM.batchSize);
  assert.equal(store.stats.deleted, 500);
  assert.equal(await store.io.prefixCount(), before - 500);
  assert.deepEqual(lines, [0, 250, 500].map(n => `reclaim progress: deleted ${n} of ${PLANNED}`));
  assertProtectedIntact(store);
  // Once the pointer is back, a fresh plan resumes from the remaining keys.
  store.data.set(POINTER_KEY, original);
  const resumed = await reclaimRetired({ io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: () => true, now: () => at, ...INLINE_RECLAIM });
  assert.equal(resumed.status, 'reclaimed-retired-production-wind100-objects');
  assert.equal(resumed.plannedObjects, PLANNED - 500);
  assert.equal(resumed.deleted, PLANNED - 500);
  assert.equal(await store.io.prefixCount(), before - PLANNED);
});

test('the wall-clock budget returns a partial result with exact counts and progress lines', async () => {
  const store = await backlog();
  const before = await store.io.prefixCount();
  const time = virtualTime(), { io, calls } = slowIo(store, time), lines = [];
  const budgetMs = 60_000;
  const result = await time.run(main('reclaim', writerEnv(), ['/source'], line => lines.push(line),
    reclaimDeps(io, time, { budgetMs })));
  assert.equal(result.status, 'reclaim-budget-exhausted');
  assert.equal(result.plannedObjects, PLANNED);
  assert.ok(result.deleted > 0 && result.deleted < PLANNED);
  assert.equal(result.deleted + result.remainingObjects, PLANNED);
  assert.equal(result.deleted, before - await store.io.prefixCount());
  assert.equal(result.deleted, calls.deletes);
  // No delete is dispatched after the deadline; one in flight finishes within one call.
  assert.ok(time.clock() >= budgetMs && time.clock() <= budgetMs + Math.max(GET_MS, DELETE_MS),
    `returned at ${time.clock()} ms`);
  const progress = progressLines(lines);
  assert.equal(progress[0], `reclaim progress: deleted 0 of ${PLANNED}`);
  assert.equal(progress.at(-1), `reclaim progress: deleted ${result.deleted} of ${PLANNED};`
    + ` wall-clock budget reached; ${result.remainingObjects} left for the next run`);
  const counts = progress.map(progressCount);
  assert.ok(counts.every((n, index) => index === 0 || n >= counts[index - 1]));
  assert.ok(progress.length > 2);
  assert.ok(lines.includes('::warning title=Production Wind100 reclaim::inline reclaim reached its wall-clock'
    + ` budget after deleting ${result.deleted} of ${PLANNED} planned objects;`
    + ` ${result.remainingObjects} remain for the next run`));
  assertProtectedIntact(store);
  // The next run's plan picks up exactly the remainder.
  const nextTime = virtualTime(), next = slowIo(store, nextTime);
  const finished = await nextTime.run(main('reclaim', writerEnv(), ['/source'], () => {},
    reclaimDeps(next.io, nextTime)));
  assert.equal(finished.status, 'reclaimed-retired-production-wind100-objects');
  assert.equal(finished.plannedObjects, result.remainingObjects);
  assert.equal(finished.deleted, result.remainingObjects);
  assert.equal(await store.io.prefixCount(), before - PLANNED);

  // A deadline reached inside the final batch is still a partial result, not completion.
  const tail = await backlog();
  let started = 0;
  const counted = async prefix => {
    const client = await tail.deleteForPrefix(prefix);
    return { delete: key => { started++; return client.delete(key); } };
  };
  const tailLines = [];
  const stopped = await reclaimRetired({ io: tail.io, deleteForPrefix: counted, catalogValidator: () => true,
    now: () => cadence(12).at, ...INLINE_RECLAIM, deadline: 1, clock: () => (started >= 8_200 ? 1 : 0),
    onProgress: line => tailLines.push(line) });
  assert.equal(stopped.status, 'reclaim-budget-exhausted');
  assert.equal(stopped.deleted, 8_200);
  assert.equal(stopped.remainingObjects, PLANNED - 8_200);
  assert.equal(tail.stats.deleted, 8_200);
  assert.equal(tailLines.at(-1), `reclaim progress: deleted 8200 of ${PLANNED};`
    + ` wall-clock budget reached; ${PLANNED - 8_200} left for the next run`);
});

test('a failed delete inside a concurrent batch stops dispatch and no later batch starts', async () => {
  for (const mode of ['hang', 'reject']) {
    const store = await backlog();
    store.components.set(prefixForInvocation(invocationFor(0)), new Map());
    const before = await store.io.prefixCount();
    let started = 0;
    const failing = { ...store.io, deleteForPrefix: async prefix => {
      const client = await store.deleteForPrefix(prefix);
      return { delete: key => {
        if (++started !== 3) return client.delete(key);
        return mode === 'hang' ? neverSettles() : Promise.reject(Error('DeleteObject 403'));
      } };
    } };
    const progress = reclaimProgress(), lines = [];
    const io = boundedReclaimIo(failing, progress, 50);
    await assert.rejects(reclaimRetired({ io, deleteForPrefix: io.deleteForPrefix, catalogValidator: () => true,
      now: () => cadence(30).at, ...INLINE_RECLAIM, onProgress: line => lines.push(line) }),
    mode === 'hang' ? /^Error: delete \S+ did not settle within 50 ms; no further deletion was attempted$/
      : /^Error: DeleteObject 403$/);
    assert.equal(progress.deleteCredentials, 1, `${mode}: no later batch may start`);
    assert.equal(progress.deletes, before - await store.io.prefixCount());
    assert.equal(lines.at(-1), `reclaim progress: deleted ${progress.deletes} of ${PLANNED};`
      + ' stopped by a failed delete; no further deletion was attempted');
    if (mode === 'hang') {
      // The other workers finish the 250-key batch while the hung call runs out its bound.
      assert.equal(started, INLINE_RECLAIM.batchSize);
      assert.equal(progress.deletes, INLINE_RECLAIM.batchSize - 1);
    } else {
      // An immediate refusal stops dispatch while at most one more key per worker was in flight.
      assert.ok(started <= 2 * INLINE_RECLAIM.concurrency, `${started} deletes started`);
      assert.equal(progress.deletes, started - 1);
    }
    assertProtectedIntact(store);
  }
});

test('manual retention keeps per-key pointer checks and serial deletes; only inline reclaim batches', async () => {
  const store = await backlog();
  const at = cadence(12).at;
  const plan = await planRetention({ io: store.io, now: () => at, catalogValidator: () => true });
  let pointerReads = 0, inFlight = 0, peak = 0;
  const counting = { ...store.io, async get(bucket, key, maximum) {
    if (key === POINTER_KEY) pointerReads++;
    return store.io.get(bucket, key, maximum);
  } };
  const serialOnly = async prefix => {
    const client = await store.deleteForPrefix(prefix);
    return { async delete(key) {
      peak = Math.max(peak, ++inFlight);
      await new Promise(resolve => setImmediate(resolve));
      await client.delete(key); inFlight--;
    } };
  };
  const result = await executeRetention({ plan, io: counting, deleteForPrefix: serialOnly,
    catalogValidator: () => true, approvedPlanSha256: plan.planSha256, now: () => at });
  assert.deepEqual(Object.keys(result).sort(), ['deleted', 'planSha256', 'pointerSha256', 'status']);
  assert.equal(result.deleted, PLANNED);
  assert.equal(pointerReads, 1 + PLANNED);
  assert.equal(peak, 1);
  assert.deepEqual(INLINE_RECLAIM, { batchSize: 250, concurrency: 8 });
  const code = readFileSync(new URL('../tools/production-wind100.mjs', import.meta.url), 'utf8');
  assert.match(code, /\.\.\.INLINE_RECLAIM, deadline, clock, onProgress: log/);
});

// ---- W15: one target-generic planner; never-activated uploads (orphans) ----

const catalogIdFor = k => `prod-wind100-recurring-${invocationFor(k)}`;
const uploadedAt = k => cadence(k).at - 30 * 60_000; // publishRun's upload time for run k

test('the manual plan is byte for byte the #440 plan, so its approved planSha256 is unchanged', async () => {
  const store = await backlog();
  const at = cadence(12).at;
  const compare = async (options, label) => {
    const plan = await planRetention({ io: store.io, ...options });
    const reference = await planRetention440({ io: store.io, ...options });
    assert.deepEqual(plan, reference, label);
    assert.equal(plan.planSha256, reference.planSha256, label);
    assert.deepEqual(Object.keys(plan), ['schemaVersion', 'kind', 'pointerSha256', 'protectedCatalogIds',
      'ancestryRecordsChecked', 'reachedGenesis', 'maximumCandidates', 'maximumObjects', 'skippedEmptyCatalogIds',
      'refusedCatalogIds', 'refusalReasons', 'candidates', 'totalObjects', 'planSha256'], label);
    return plan;
  };
  assert.equal((await compare({ now: () => at, catalogValidator: () => true }, 'backlog')).candidates.length, 2);
  store.components.set(prefixForInvocation(invocationFor(0)), new Map());
  const stricter = catalog => catalog.components['point-ecmwf'].rootPrefix !== prefixForInvocation(invocationFor(1));
  const refused = await compare({ now: () => at, catalogValidator: stricter }, 'emptied and refused');
  assert.deepEqual(refused.skippedEmptyCatalogIds, [catalogIdFor(0)]);
  assert.deepEqual(refused.refusalReasons, { [catalogIdFor(1)]: 'catalog-rejected' });
  await compare({ now: () => at + 4 * 24 * HOUR, catalogValidator: () => true, maximumCandidates: 8 }, 'wide');
  store.data.delete(`production-candidates/wind100/${catalogIdFor(2)}/selection.json`);
  await compare({ now: () => at, catalogValidator: () => true, maximumObjects: POINT_OBJECTS + 1 }, 'evidence');
  // A never-activated upload in the bucket does not enter the manual plan.
  store.components.set(prefixForInvocation(invocationFor(3)), new Map());
  const orphan = fixture(runIdAt(cadence(12).init), invocationFor(12), { objectCount: POINT_OBJECTS });
  store.upload(orphan, uploadedAt(12) - 3 * 24 * HOUR);
  const manual = await compare({ now: () => at, catalogValidator: () => true }, 'with an orphan present');
  assert.ok(!JSON.stringify(manual).includes(invocationFor(12)));
});

test('never-activated uploads are reclaimed only when unreferenced and at least 48 hours old', async () => {
  const store = storeIo();
  for (let k = 0; k < 4; k++) await publishRun(store, cadence(k));
  // Upload succeeded, then: publication failed before any metadata; activation failed after the
  // catalog and selection; the upload itself stopped part way (no component.json).
  await publishRun(store, { ...cadence(4), fail: 'publish' });
  await publishRun(store, { ...cadence(5), fail: 'activate' });
  await publishRun(store, { ...cadence(6), fail: 'upload' });
  const orphanIds = [4, 5, 6].map(catalogIdFor);
  for (const k of [4, 5, 6]) assert.ok(store.components.get(prefixForInvocation(invocationFor(k))).size > 0);
  assert.ok(!store.pointer().entries.some(row => orphanIds.includes(row.catalogId)));
  // The 48-hour boundary, exactly: one millisecond short is not a candidate, the boundary is.
  // (One retired candidate leaves room in the 10,000-object budget; retired prefixes go first.)
  const boundary = uploadedAt(4) + ORPHAN_MIN_AGE_MS;
  assert.equal(ORPHAN_MIN_AGE_MS, 48 * HOUR);
  const plan = now => planRetention({ io: store.io, now: () => now, catalogValidator: () => true, orphans: true,
    maximumCandidates: 1 });
  const short = await plan(boundary - 1);
  assert.deepEqual(short.orphanCandidates, []);
  assert.equal(short.orphanInventory, 'listed');
  const due = await plan(boundary);
  assert.equal(due.candidates.length, 1);
  assert.deepEqual(due.orphanCandidates.map(row => [row.catalogId, row.selection, row.keys.length]),
    [[catalogIdFor(4), 'absent', POINT_OBJECTS + 1]]);
  assert.equal(due.orphanCandidates[0].newestObjectAt, new Date(uploadedAt(4)).toISOString());
  // Inline runs: an orphan disappears only at or after its 48-hour age, and every one goes.
  const removedAt = {};
  for (let k = 7; k < 16; k++) {
    const run = await publishRun(store, { ...cadence(k), orphans: true });
    for (const id of run.reclaimed.orphanCandidates) {
      const j = Number(id.split('-').at(-2)) - 35834279562;
      assert.ok(cadence(k).at - uploadedAt(j) >= ORPHAN_MIN_AGE_MS, `${id} deleted ${cadence(k).at - uploadedAt(j)} ms after upload`);
      removedAt[id] = k;
    }
    assertProtectedIntact(store);
  }
  assert.deepEqual(Object.keys(removedAt).sort(), orphanIds);
  for (const k of [4, 5, 6]) assert.equal(store.components.get(prefixForInvocation(invocationFor(k))).size, 0);
  // Catalog snapshots and selection receipts are never deleted.
  assert.ok(store.data.has(`production-candidates/wind100/${catalogIdFor(5)}/selection.json`));
  assert.ok(store.data.has(`catalogs/snapshots/${catalogIdFor(5)}.json`));
});

test('a young, referenced or unprovable never-activated upload is never deleted', async () => {
  const store = await backlog();
  // The capacity check keeps the namespace within 50,000 objects: two retired prefixes were
  // emptied before the uploads below (a namespace over the bound is not listed at all).
  for (const k of [1, 2]) store.components.set(prefixForInvocation(invocationFor(k)), new Map());
  const at = cadence(12).at, later = at + 10 * 24 * HOUR;
  const plan = (now, options = {}) => planRetention({ io: store.io, now: () => now, catalogValidator: () => true,
    orphans: true, maximumOrphans: 8, ...options });
  // Every prefix is old by now, but live pointer and journal-window prefixes are referenced.
  const referenced = await plan(later);
  assert.deepEqual(referenced.orphanCandidates, []);
  assert.equal(referenced.orphanInventory, 'listed');
  // A retired entry refused for its evidence stays referenced and is never an orphan.
  store.data.delete(`production-candidates/wind100/${catalogIdFor(0)}/selection.json`);
  const refused = await plan(later);
  assert.deepEqual(refused.refusalReasons[catalogIdFor(0)], 'selection-unavailable');
  assert.ok(!refused.orphanCandidates.some(row => row.catalogId === catalogIdFor(0)));
  // A young orphan waits; a selection that is not provably past its lease and grace is refused
  // with a stable reason and kept.
  const young = fixture(runIdAt(cadence(12).init), invocationFor(12), { objectCount: POINT_OBJECTS });
  store.upload(young, at - 47 * HOUR);
  const forged = fixture(runIdAt(cadence(13).init), invocationFor(13), { objectCount: POINT_OBJECTS });
  store.upload(forged, at - 50 * HOUR);
  const selection = { kind: 'weatherx-production-native-wind100-selection', catalogId: catalogIdFor(13),
    activated: false, initializedAt: new Date(at).toISOString(), freshUntil: new Date(at + 30 * HOUR).toISOString() };
  store.data.set(`production-candidates/wind100/${catalogIdFor(13)}/selection.json`, encode(selection));
  const waiting = await plan(at);
  assert.deepEqual(waiting.orphanCandidates, []);
  assert.deepEqual(waiting.orphanRefusals, { [catalogIdFor(13)]: 'orphan-selection-mismatch' });
  const before = await store.io.prefixCount();
  const reclaimed = await reclaimRetired({ io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: () => true, now: () => at, orphans: true, ...INLINE_RECLAIM });
  assert.deepEqual(reclaimed.orphanCandidates, []);
  assert.deepEqual(reclaimed.orphanRefusals, { [catalogIdFor(13)]: 'orphan-selection-mismatch' });
  assert.equal(before - await store.io.prefixCount(), reclaimed.deleted);
  for (const k of [12, 13]) assert.equal(store.components.get(prefixForInvocation(invocationFor(k))).size, POINT_OBJECTS + 1);
  const notices = retentionNotices(reclaimed);
  assert.ok(notices.warnings.includes(`never-activated ${catalogIdFor(13)} was refused (orphan-selection-mismatch)`
    + ' and kept; inspect its selection and prefix'));
  assert.match(notices.summary, /; never-activated none \(inventory listed; refused prod-wind100-recurring-\d+-1 \(orphan-selection-mismatch\)\)$/);
  // Whatever cannot be proven skips the whole orphan pass; retired reclaim is unaffected.
  const unlisted = { ...store.io, listNamespace: async () => { throw Error('ListObjectsV2 503'); } };
  const skipped = await planRetention({ io: unlisted, now: () => later, catalogValidator: () => true, orphans: true });
  assert.equal(skipped.orphanInventory, 'unavailable');
  assert.ok(skipped.candidates.length > 0);
  const overCap = { ...store.io, listNamespace: async () => Array.from({ length: 50_001 },
    (_, index) => ({ key: `${prefixForInvocation(invocationFor(20))}${index}`, lastModified: '2026-01-01T00:00:00.000Z' })) };
  assert.equal((await planRetention({ io: overCap, now: () => later, catalogValidator: () => true, orphans: true }))
    .orphanInventory, 'unavailable');
  const stray = { ...store.io, listNamespace: async () => [...await store.io.listNamespace(),
    { key: `${COMPONENT_PREFIX}not-an-invocation/x`, lastModified: '2026-01-01T00:00:00.000Z' }] };
  assert.equal((await planRetention({ io: stray, now: () => later, catalogValidator: () => true, orphans: true }))
    .orphanInventory, 'invalid');
  const current = store.pointer().entries[0];
  const catalogKey = `catalogs/snapshots/${current.catalogId}.json`, catalogBody = store.data.get(catalogKey);
  store.data.delete(catalogKey);
  assert.equal((await plan(at)).orphanInventory, 'referenced-catalog-unavailable');
  store.data.set(catalogKey, catalogBody);
  // The approved manual lane never executes an orphan plan, even one carrying an approved hash.
  const withOrphans = await plan(later);
  await assert.rejects(executeRetention({ plan: withOrphans, io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: () => true, approvedPlanSha256: withOrphans.planSha256, now: () => later }),
  /the approved lane deletes only journal-retired prefixes/);
  assertProtectedIntact(store);
});

test('a referenced catalog that fails its hash check stops the whole orphan pass', async () => {
  const store = await backlog();
  store.components.set(prefixForInvocation(invocationFor(0)), new Map());
  const at = cadence(12).at;
  // An old never-activated upload, unreferenced by name.
  const orphan = fixture(runIdAt(cadence(12).init), invocationFor(12), { objectCount: POINT_OBJECTS });
  store.upload(orphan, at - 72 * HOUR);
  const plan = await planRetention({ io: store.io, now: () => at, catalogValidator: () => true, orphans: true,
    maximumCandidates: 1 });
  assert.deepEqual(plan.orphanCandidates.map(row => row.catalogId), [catalogIdFor(12)]);
  // The live entry's catalog, altered to name that prefix too, no longer matches the pointer's
  // hash: nothing it might reference can be ruled out, so no orphan is planned at all.
  const live = store.pointer().entries[0];
  const io = { ...store.io, async get(bucket, key, maximum) {
    const object = await store.io.get(bucket, key, maximum);
    if (key !== `catalogs/snapshots/${live.catalogId}.json`) return object;
    const catalog = JSON.parse(object.body);
    catalog.components.extra = { rootPrefix: prefixForInvocation(invocationFor(12)) };
    return { ...object, body: encode(catalog) };
  } };
  const altered = await planRetention({ io, now: () => at, catalogValidator: () => true, orphans: true,
    maximumCandidates: 1 });
  assert.equal(altered.orphanInventory, 'referenced-catalog-unavailable');
  assert.deepEqual(altered.orphanCandidates, []);
  assert.equal(altered.candidates.length, 1);
});

test('inline reclaim with orphans keeps 100 publications under the cap while publications fail', async () => {
  const failure = k => (k % 7 === 3 ? 'activate' : k % 11 === 5 ? 'publish' : k % 13 === 8 ? 'upload' : null);
  const store = storeIo();
  let peak = 0, orphansDeleted = 0, failures = 0;
  for (let k = 0; k < 100; k++) {
    const run = await publishRun(store, { ...cadence(k), orphans: true, reclaim: k % 9 !== 4, fail: failure(k) });
    peak = Math.max(peak, run.capacity.existingObjects + run.capacity.plannedObjects);
    orphansDeleted += run.reclaimed?.orphanCandidates?.length ?? 0;
    if (failure(k)) failures++;
    assertProtectedIntact(store);
  }
  assert.ok(failures >= 25, `${failures} failed publications`);
  assert.ok(peak <= 50_000, `peak ${peak}`);
  assert.ok(peak <= 9 * (POINT_OBJECTS + 1), `steady state should stay well under the cap, peak ${peak}`);
  // Every failed publication older than its 48 hours plus a day of catch-up is gone.
  for (let k = 0; k < 100; k++) {
    if (!failure(k) || cadence(99).at - uploadedAt(k) < ORPHAN_MIN_AGE_MS + 24 * HOUR) continue;
    assert.equal(store.components.get(prefixForInvocation(invocationFor(k)))?.size ?? 0, 0, `run ${k}`);
  }
  assert.ok(orphansDeleted >= failures - 6);
  // Without the orphan class the same sequence reaches the cap: the W15 failure mode.
  const blocked = storeIo();
  await assert.rejects((async () => {
    for (let k = 0; k < 100; k++) await publishRun(blocked, { ...cadence(k), reclaim: k % 9 !== 4, fail: failure(k) });
  })(), /lacks capacity/);
});

test('the inline reclaim command reports never-activated uploads in its result and summary', async () => {
  const store = await backlog();
  store.components.set(prefixForInvocation(invocationFor(0)), new Map());
  const orphan = fixture(runIdAt(cadence(12).init), invocationFor(12), { objectCount: POINT_OBJECTS });
  store.upload(orphan, cadence(12).at - 49 * HOUR, 1_500);
  const time = virtualTime(), { io } = slowIo(store, time), lines = [];
  const directory = mkdtempSync(join(tmpdir(), 'wind100-orphan-summary-'));
  try {
    const summaryPath = join(directory, 'summary.md');
    const result = await time.run(main('reclaim', { ...writerEnv(), GITHUB_STEP_SUMMARY: summaryPath }, ['/source'],
      line => lines.push(line), reclaimDeps(io, time)));
    assert.equal(result.status, 'reclaimed-retired-production-wind100-objects');
    // Two retired prefixes (8,282 keys) leave room in the 10,000-object budget for the partial orphan.
    assert.deepEqual(result.orphanCandidates, [catalogIdFor(12)]);
    assert.equal(result.orphanInventory, 'listed');
    assert.equal(result.plannedObjects, PLANNED + 1_500);
    assert.equal(result.deleted, PLANNED + 1_500);
    assert.equal(store.components.get(prefixForInvocation(invocationFor(12))).size, 0);
    assert.match(readFileSync(summaryPath, 'utf8'), new RegExp(`deleted ${PLANNED + 1_500}; .*; never-activated ${catalogIdFor(12)} \\(inventory listed; refused none\\)\\n$`));
    assert.ok(time.clock() < RECLAIM_BUDGET_MS / 4, `took ${time.clock()} ms`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assertProtectedIntact(store);
});
