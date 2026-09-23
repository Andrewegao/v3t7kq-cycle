import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  COMPONENTS, COMPONENT_PREFIX, DATA, ORIGIN, POINTER_KEY, POINTER_KIND, SELECTION_KIND,
  activateCandidate, bindPointIntegrityInvocation, controllerDigest, createStorage, findQualifiedInput, gate, hash,
  nextPointer, pointerEntry, publishCandidate, readProductionPolicy, recurringPrefixCapacity,
  rollbackToPrior, validatePointer, validateQualification, validateSelection,
} from '../tools/production-wind100.mjs';
import { createRetentionIo, executeRetention, planRetention, scopedDeleteCredentials }
  from '../tools/production-wind100-retention.mjs';

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

function fixture(runId = '2026092300', invocation = request.invocation) {
  const initializedAt = `${runId.slice(0, 4)}-${runId.slice(4, 6)}-${runId.slice(6, 8)}T${runId.slice(8)}:00:00Z`;
  const freshUntil = new Date(Date.parse(initializedAt) + 30 * 3_600_000).toISOString();
  const descriptor = { runId, initializedAt, freshUntil,
    source: 'ECMWF IFS 0.25 degree direct open-data GRIB',
    variables: { wind_speed: { kind: 'instantaneous', units: 'm/s' },
      wind_speed_100m: { kind: 'instantaneous', units: 'm/s' } } };
  const rows = [{ path: `v2/ecmwf/${runId}/chunks/0/0.bin.gz`, bytes: 100, sha256: sha('a') }];
  const q = { schemaVersion: 2, kind: 'weatherx-staging-native-wind100-point-candidate',
    status: 'CREDENTIAL_FREE_POINT_PACK_INTEGRITY_QUALIFIED_NOT_PUBLISHED',
    model: 'ecmwf', sourceSha: request.sourceSha, invocation, publicationMode: request.publicationMode,
    inputSha256: sha('b'), runId, initializedAt, freshUntil,
    pointPacks: { objectCount: 1, inventory: rows, descriptor, allFieldsExactlyMatchSourceStage: true },
    native100m: { sourceFields: ['wind100_u', 'wind100_v'], valuesExactlyMatchSourceStage: true,
      valuesRepairedOrFilled: false, perLead: Array.from({ length: 81 }, () => ({ jointCoveragePermille: 1000 })) },
    credentialFreeIntegrityQualification: true, decodedProviderSemanticsVerified: true,
    dependencyClosureApproved: true, authenticatedCorePointInput: true,
    productionWritten: false, sharedReadCanaryActivated: false };
  const qualification = { schemaVersion: 1, kind: 'weatherx-production-native-wind100-qualification',
    targetOrigin: ORIGIN, invocation, sourceSha: request.sourceSha,
    coreSourceSha: readProductionPolicy().coreSourceSha, inputSha256: q.inputSha256, integrity: q };
  const artifactId = `prod-wind100-recurring-point-ecmwf-${invocation}`;
  const rootPrefix = `components/point-ecmwf/${artifactId}/`;
  const manifest = { schemaVersion: 1, artifactId,
    completedAt: new Date(Date.parse(initializedAt) + 3_600_000).toISOString(),
    componentId: 'point-ecmwf', generationTime: initializedAt,
    inventorySha256: hash(JSON.stringify(rows.map(row => ({
      path: row.path.slice('v2/ecmwf/'.length), size: row.bytes, sha256: row.sha256 })))),
    mounts: ['point-series/v2/ecmwf/'], objectCount: 1,
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
  assert.throws(() => recurringPrefixCapacity(50_000, fixture().qualification));
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
