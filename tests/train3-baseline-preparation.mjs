import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow } from '../tools/workflow-inventory.mjs';
import { ACCOUNT, BoundedReadHandler, COMPONENTS, DATA, IDS, LIMITS, bodyBytes, exportBaseline,
  exportPlan, failureDiagnostic, gate, hash, inventory, metadataAudit, preparation, producerOrder, readClient } from '../tools/train3-baseline-preparation.mjs';

const SOURCE = 'a'.repeat(40), CATALOG = '1395-fixture';
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
  GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: SOURCE, REVIEWED_SOURCE_SHA: SOURCE,
  TRAIN3_PREPARATION_ENABLED: 'true', EXPECTED_CATALOG_ID: CATALOG, PREPARATION_OPERATION: 'inventory' };
const json = value => Buffer.from(JSON.stringify(value) + '\n');
function fixture() {
  const objects = new Map(), prefixes = new Map(), components = {}, calls = [];
  for (const id of IDS) {
    const rootPrefix = `components/${id}/artifact-${id}/`, payload = new Map([
      ['A/1.txt', Buffer.from(`original ${id}\n`)], ['z.txt', Buffer.from('bytes')],
    ]);
    const rows = [...payload].map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) })).sort(producerOrder);
    const manifest = { schemaVersion: 1, componentId: id, artifactId: `artifact-${id}`, rootPrefix,
      generationTime: '2026-10-03T00:00:00Z', completedAt: '2026-10-03T01:00:00Z',
      mounts: [id.startsWith('point-') ? `point-series/v2/${id.slice(6)}/` : `data/${id}/`],
      objectCount: rows.length, inventorySha256: hash(JSON.stringify(rows)), quality: { status: 'passed', checks: [] },
      ...(id.startsWith('point-') ? { pointSeries: { modelId: id.slice(6), descriptor: {
        initializedAt: '2026-10-03T00:00:00Z', runId: '2026100300' } } } : {}) };
    const raw = json(manifest), manifestKey = `${rootPrefix}component.json`;
    components[id] = { ...manifest, manifestKey, manifestSha256: hash(raw) };
    objects.set(`${COMPONENTS}/${manifestKey}`, raw);
    for (const [path, bytes] of payload) objects.set(`${COMPONENTS}/${rootPrefix}${path}`, bytes);
    prefixes.set(rootPrefix, [{ Key: manifestKey, Size: raw.length }, ...[...payload].map(([path, bytes]) => ({ Key: rootPrefix + path, Size: bytes.length }))]);
  }
  const snapshot = json({ schemaVersion: 2, sequence: 1395, createdAt: '2026-10-03T02:00:00Z', parentCatalogId: null, components });
  const pointer = json({ schemaVersion: 2, catalogId: CATALOG, sequence: 1395, publishedAt: '2026-10-03T02:00:00Z',
    previousCatalogId: null, catalogSha256: hash(snapshot) });
  objects.set(`${DATA}/catalogs/current.json`, pointer);
  objects.set(`${DATA}/catalogs/snapshots/${CATALOG}.json`, snapshot);
  const client = {
    async get(bucket, key, cap) { calls.push(['get', bucket, key]); const bytes = objects.get(`${bucket}/${key}`);
      assert.ok(bytes && bytes.length <= cap); return bytes; },
    async list(prefix) { calls.push(['list', prefix]); return { IsTruncated: false, Contents: prefixes.get(prefix) }; },
    stats() { return { requests: calls.length, wireBytes: 0 }; }, close() {},
  };
  return { objects, prefixes, components, calls, client };
}
async function planned(f = fixture()) {
  const plan = await inventory(f.client, CATALOG, SOURCE), bytes = json(plan);
  return { f, plan, bytes, reviewed: exportPlan(bytes, hash(bytes), CATALOG) };
}

test('workflow is manual, disabled by default, pinned, read-only, and retains success for one day', async () => {
  const path = '.github/workflows/train3-baseline-preparation.yml';
  const source = await readFile(new URL('../' + path, import.meta.url), 'utf8'), workflow = parseWorkflow(source, path).data;
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.enable_preparation.default, false);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const job = workflow.jobs.prepare; assert.deepEqual(job.environment, { name: 'data-staging' }); assert.equal(job['timeout-minutes'], 45);
  assert.match(job.if, /inputs\.enable_preparation/); assert.match(job.if, /refs\/heads\/main/);
  assert.match(job.if, /inputs\.reviewed_source_sha == github\.sha/);
  assert.deepEqual([...source.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]).sort(),
    ['SHARED_R2_READ_ACCESS_KEY_ID', 'SHARED_R2_READ_SECRET_ACCESS_KEY']);
  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false); assert.equal(checkout.with.ref, '${{ github.sha }}');
  const reader = job.steps.findIndex(step => step.run === 'node tools/train3-baseline-preparation.mjs');
  assert.ok(reader > job.steps.findIndex(step => step.run === 'node --test tests/train3-baseline-preparation.mjs'));
  const upload = job.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.if, undefined); assert.equal(upload.with['retention-days'], 1); assert.equal(upload.with['compression-level'], 0);
  assert.ok(job.steps.filter(step => step.uses).every(step => /@[a-f0-9]{40}$/.test(step.uses)));
  assert.doesNotMatch(job.steps.at(-1).run, /find|prune/);
  const ci = await readFile(new URL('../.github/workflows/scheduler-ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /node --test tests\/train3-baseline-preparation\.mjs/);
});

test('disabled, non-main, non-hosted, and unreviewed sources cannot create a reader', async () => {
  for (const change of [{ TRAIN3_PREPARATION_ENABLED: 'false' }, { GITHUB_REF: 'refs/heads/other' },
    { RUNNER_ENVIRONMENT: 'self-hosted' }, { REVIEWED_SOURCE_SHA: 'b'.repeat(40) }, { PREPARATION_OPERATION: 'publish' }]) {
    let called = false;
    await assert.rejects(preparation({ env: { ...env, ...change }, clientFactory: () => { called = true; } }));
    assert.equal(called, false);
  }
  assert.throws(() => gate({ ...env, PREPARATION_OPERATION: 'export' }), /plan-pin/);
});
test('inventory preserves original metadata and lists only the exact 22 selected prefixes', async () => {
  const f = fixture(), plan = await inventory(f.client, CATALOG, SOURCE);
  assert.equal(plan.payloadsRead, false); assert.deepEqual(plan.missing, []); assert.equal(plan.components.length, 22);
  assert.deepEqual(Buffer.from(plan.pointerBase64, 'base64'), f.objects.get(`${DATA}/catalogs/current.json`));
  assert.equal(f.calls.filter(c => c[0] === 'list').length, 22);
  assert.equal(f.calls.filter(c => c[0] === 'get' && c[1] === COMPONENTS && !c[2].endsWith('/component.json')).length, 0);
});
test('metadata audit reads 25 original objects without listing or payload, and cannot authorize export', async () => {
  const f = fixture(), audit = await metadataAudit(f.client, CATALOG, SOURCE), bytes = json(audit);
  assert.equal(f.calls.length, 25); assert.ok(f.calls.every(c => c[0] === 'get'));
  assert.equal(audit.components.length, 22); assert.deepEqual(audit.missing, []);
  assert.equal(audit.components.filter(c => c.consumerScope === 'core-catalog-and-eleven-model-gates').length, 8);
  assert.equal(audit.payloadBytes, null); assert.equal(audit.physicalObjectCount, null);
  assert.equal(audit.exportPlanEligible, false); assert.equal(audit.scientificValidationPerformed, false);
  for (const row of audit.components) assert.deepEqual(Buffer.from(row.manifestBase64, 'base64'),
    f.objects.get(`${COMPONENTS}/components/${row.id}/artifact-${row.id}/component.json`));
  assert.throws(() => exportPlan(bytes, hash(bytes), CATALOG), /incomplete-plan/);
});
test('metadata audit reports schema-two logical layouts and counts without assuming physical closure', async () => {
  for (const kind of ['packed-v1', 'references-v1', 'direct-auth-v1']) {
    const f = fixture(), key = `${COMPONENTS}/components/ecmwf/artifact-ecmwf/component.json`;
    const manifest = JSON.parse(f.objects.get(key)); manifest.schemaVersion = 2;
    manifest.objectLayout = { kind }; manifest.objectCount = LIMITS.objects + 1;
    const raw = json(manifest); f.objects.set(key, raw);
    changeCatalogDescriptor(f, entry => Object.assign(entry, manifest, { manifestSha256: hash(raw) }));
    const audit = await metadataAudit(f.client, CATALOG, SOURCE);
    assert.equal(audit.components[0].layout, kind); assert.equal(audit.components[0].logicalObjectCount, LIMITS.objects + 1);
    assert.equal(audit.objectsListed, false); assert.equal(audit.payloadsRead, false);
  }
});
test('metadata audit rejects descriptor-only object layout identity or closure changes', async () => {
  for (const change of [layout => { layout.kind = 'packed-v1'; }, layout => { layout.indexSha256 = 'b'.repeat(64); },
    layout => { layout.sourceRootPrefix = 'components/gfs/other/'; }, layout => { layout.objectCount++; }]) {
    const f = fixture(), key = `${COMPONENTS}/components/ecmwf/artifact-ecmwf/component.json`;
    const manifest = JSON.parse(f.objects.get(key)); manifest.schemaVersion = 2;
    manifest.objectLayout = { kind: 'references-v1', indexSha256: 'a'.repeat(64), sourceRootPrefix: manifest.rootPrefix, objectCount: 2 };
    const raw = json(manifest); f.objects.set(key, raw);
    changeCatalogDescriptor(f, entry => { Object.assign(entry, manifest, { manifestSha256: hash(raw) }); change(entry.objectLayout); });
    await assert.rejects(metadataAudit(f.client, CATALOG, SOURCE), /manifest-descriptor/);
  }
});
test('metadata audit preserves missing roster and refuses changed pointer or original manifest bytes', async () => {
  const f = fixture(), key = `${DATA}/catalogs/snapshots/${CATALOG}.json`;
  const snapshot = JSON.parse(f.objects.get(key)); delete snapshot.components['point-icon'];
  const raw = json(snapshot), pointer = JSON.parse(f.objects.get(`${DATA}/catalogs/current.json`)); pointer.catalogSha256 = hash(raw);
  f.objects.set(key, raw); f.objects.set(`${DATA}/catalogs/current.json`, json(pointer));
  assert.deepEqual((await metadataAudit(f.client, CATALOG, SOURCE)).missing, ['point-icon']);
  const g = fixture(), original = g.client.get; let reads = 0;
  g.client.get = async (...args) => { const bytes = await original(...args);
    return args[1] === 'catalogs/current.json' && ++reads > 1 ? Buffer.concat([bytes, Buffer.from(' ')]) : bytes; };
  await assert.rejects(metadataAudit(g.client, CATALOG, SOURCE), /catalog-rotated/);
  const h = fixture(); h.objects.set(`${COMPONENTS}/components/ecmwf/artifact-ecmwf/component.json`, Buffer.from('{}'));
  await assert.rejects(metadataAudit(h.client, CATALOG, SOURCE), /manifest-hash/);
});
test('metadata operation produces only its distinct audit and receipt in the private output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'train3-metadata-test-')), f = fixture();
  try {
    await preparation({ env: { ...env, RUNNER_TEMP: root, PREPARATION_OPERATION: 'metadata' }, clientFactory: () => f.client });
    assert.deepEqual((await readdir(join(root, 'train3-baseline-preparation'))).sort(), ['acquisition-receipt.json', 'metadata-audit.json']);
    assert.equal(f.calls.length, LIMITS.metadataRequests);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('metadata transport forbids listing and payload and stops before request 26', async () => {
  let calls = 0;
  const inner = { metadata: {}, async handle() { calls++; return { response: { body: Readable.from(['{}']) } }; } };
  const handler = new BoundedReadHandler(inner, { operation: 'metadata' });
  const request = { protocol: 'https:', hostname: `${ACCOUNT}.r2.cloudflarestorage.com`, method: 'GET', path: `/${DATA}/catalogs/current.json`, query: {} };
  for (const change of [{ path: `/${COMPONENTS}/`, query: { 'list-type': '2', 'max-keys': '1000', prefix: 'components/ecmwf/a/' } },
    { path: `/${COMPONENTS}/components/ecmwf/a/payload.bin` }, { path: `/${COMPONENTS}/components/ecmwf/a/nested/component.json` },
    { path: `/${COMPONENTS}/components/unselected/a/component.json` }]) await assert.rejects(handler.handle({ ...request, ...change }, {}));
  assert.equal(calls, 0);
  for (let i = 0; i < LIMITS.metadataRequests; i++) {
    const result = await handler.handle(request, {}); await bodyBytes(result.response.body, LIMITS.pointer);
  }
  await assert.rejects(handler.handle(request, {}), /request-or-time-budget/); assert.equal(calls, 25);
});
test('catalog rotation fails instead of silently following the new pointer', async () => {
  const f = fixture(), original = f.client.get; let reads = 0;
  f.client.get = async (...args) => { const bytes = await original(...args);
    return args[1] === 'catalogs/current.json' && ++reads > 1 ? Buffer.from(bytes.toString() + ' ') : bytes; };
  await assert.rejects(inventory(f.client, CATALOG, SOURCE), /catalog-rotated/);
});
test('listing rejects traversal, duplicate keys, out-of-prefix keys and file/directory collisions', async () => {
  for (const mutate of [rows => rows.push({ Key: 'components/ecmwf/artifact-ecmwf/../escape', Size: 1 }),
    rows => rows.push({ ...rows[1] }), rows => rows.push({ Key: 'other/root/key', Size: 1 }),
    rows => rows.push({ Key: 'components/ecmwf/artifact-ecmwf/A', Size: 1 })]) {
    const f = fixture(); mutate(f.prefixes.get('components/ecmwf/artifact-ecmwf/'));
    await assert.rejects(inventory(f.client, CATALOG, SOURCE));
  }
});
test('repeated continuation tokens fail rather than loop', async () => {
  const f = fixture(); f.client.list = async () => ({ IsTruncated: true, NextContinuationToken: 'same', Contents: [] });
  await assert.rejects(inventory(f.client, CATALOG, SOURCE), /listing-token/);
});
test('missing components remain honest inventory results and cannot be exported', async () => {
  const f = fixture(), snapshotKey = `${DATA}/catalogs/snapshots/${CATALOG}.json`;
  const snapshot = JSON.parse(f.objects.get(snapshotKey)); delete snapshot.components['point-icon'];
  const raw = json(snapshot), pointer = JSON.parse(f.objects.get(`${DATA}/catalogs/current.json`)); pointer.catalogSha256 = hash(raw);
  f.objects.set(snapshotKey, raw); f.objects.set(`${DATA}/catalogs/current.json`, json(pointer));
  const plan = await inventory(f.client, CATALOG, SOURCE), bytes = json(plan);
  assert.deepEqual(plan.missing, ['point-icon']); assert.throws(() => exportPlan(bytes, hash(bytes), CATALOG), /incomplete-plan/);
});
test('schema-two physical listings are reported but cannot be mistaken for logical export closure', async () => {
  const { plan } = await planned(); plan.components[0].layout = 'references-v1';
  const bytes = json(plan); assert.throws(() => exportPlan(bytes, hash(bytes), CATALOG), /unsupported-layout/);
});
test('export admission binds exact bytes, sizes, inventory counts, and map/point generations', async () => {
  const { plan, bytes } = await planned(); assert.throws(() => exportPlan(bytes, 'b'.repeat(64), CATALOG), /reviewed-plan-hash/);
  for (const mutate of [p => p.payloadBytes++, p => p.components[0].objects[0].bytes = LIMITS.object + 1,
    p => p.components[0].objects.pop()]) {
    const copy = structuredClone(plan); mutate(copy); const raw = json(copy); assert.throws(() => exportPlan(raw, hash(raw), CATALOG));
  }
});
test('export keeps original bytes and emits an independently hashed eight-component core seal', async () => {
  const { f, reviewed } = await planned(), root = await mkdtemp(join(tmpdir(), 'train3-export-test-'));
  try {
    const receipt = await exportBaseline(f.client, reviewed, root), sealBytes = await readFile(join(root, 'core/seal.json'));
    assert.equal(receipt.coreSealSha256, hash(sealBytes)); assert.equal(receipt.components.length, 22);
    const seal = JSON.parse(sealBytes); assert.equal(seal.kind, 'weatherx-validation-catalog-baseline-v1');
    assert.equal(new Set(seal.files.filter(row => row.path.startsWith('components/')).map(row => row.path.split('/')[1])).size, 8);
    for (const row of seal.files) {
      const bytes = await readFile(join(root, 'core', row.path)); assert.equal(row.size, bytes.length); assert.equal(row.sha256, hash(bytes));
    }
    assert.deepEqual(await readFile(join(root, 'original/components/icon/payload/A/1.txt')), Buffer.from('original icon\n'));
    assert.equal(receipt.scientificValidationPerformed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('same-size payload mutation fails original inventory digest', async () => {
  const { f, reviewed } = await planned(), root = await mkdtemp(join(tmpdir(), 'train3-mutated-test-'));
  f.objects.set(`${COMPONENTS}/components/ecmwf/artifact-ecmwf/z.txt`, Buffer.from('other'));
  try { await assert.rejects(exportBaseline(f.client, reviewed, root), /original-inventory-hash/); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('failed acquisition removes only its private output and retains no complete artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'train3-cleanup-test-'));
  try {
    await assert.rejects(preparation({ env: { ...env, RUNNER_TEMP: root }, clientFactory: () => ({
      get() { throw new Error('fake-access-denied'); }, close() {},
    }) }), /fake-access-denied/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('reader close failure preserves the primary failure and removes its private directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'train3-close-test-'));
  try {
    await assert.rejects(preparation({ env: { ...env, RUNNER_TEMP: root }, clientFactory: () => ({
      get() { throw new Error('read-failure'); }, close() { throw new Error('close-failure'); },
    }) }), error => { assert.match(error.message, /read-failure/); assert.equal(failureDiagnostic(error).cleanup, 'failed'); return true; });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('whole-helper deadline prevents retaining output after the final response', async () => {
  const root = await mkdtemp(join(tmpdir(), 'train3-deadline-test-')), f = fixture(); let now = 0, pointers = 0;
  const original = f.client.get;
  f.client.get = async (...args) => { const bytes = await original(...args);
    if (args[1] === 'catalogs/current.json' && ++pointers === 2) now = 100; return bytes; };
  try {
    await assert.rejects(preparation({ env: { ...env, RUNNER_TEMP: root }, now: () => now,
      milliseconds: 100, clientFactory: () => f.client }), /deadline/);
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('wire guard rejects writes, whole-bucket listing and payload reads during inventory', async () => {
  let calls = 0;
  const handler = new BoundedReadHandler({ handle() { calls++; }, metadata: {} }, { operation: 'inventory' });
  const request = { protocol: 'https:', hostname: `${ACCOUNT}.r2.cloudflarestorage.com`, method: 'GET', path: `/${COMPONENTS}/`, query: {} };
  for (const change of [{ method: 'PUT' }, { query: { 'list-type': '2', 'max-keys': '1000' } },
    { path: `/${COMPONENTS}/components/ecmwf/a/payload.bin` }]) await assert.rejects(handler.handle({ ...request, ...change }, {}));
  assert.equal(calls, 0);
});
test('wire guard caps response bytes before SDK XML decoding and honors time budget', async () => {
  let now = 0;
  const inner = { metadata: {}, async handle() { return { response: { body: Readable.from([Buffer.alloc(LIMITS.pointer + 1)]) } }; } };
  const handler = new BoundedReadHandler(inner, { operation: 'inventory', now: () => now });
  const request = { protocol: 'https:', hostname: `${ACCOUNT}.r2.cloudflarestorage.com`, method: 'GET', path: `/${DATA}/catalogs/current.json`, query: {} };
  const result = await handler.handle(request, {}); await assert.rejects(bodyBytes(result.response.body, LIMITS.pointer), /wire-budget/);
  now = LIMITS.milliseconds; await assert.rejects(handler.handle(request, {}), /request-or-time-budget/);
});
test('wire-budget rejection destroys the original still-open response stream', async () => {
  const source = new Readable({ read() { this.push(Buffer.alloc(LIMITS.pointer + 1)); } });
  const inner = { metadata: {}, async handle() { return { response: { body: source } }; } };
  const handler = new BoundedReadHandler(inner, { operation: 'inventory' });
  const result = await handler.handle({ protocol: 'https:', hostname: `${ACCOUNT}.r2.cloudflarestorage.com`,
    method: 'GET', path: `/${DATA}/catalogs/current.json`, query: {} }, {});
  await assert.rejects(bodyBytes(result.response.body, LIMITS.pointer), /wire-budget/);
  assert.equal(source.destroyed, true);
});
test('empty response completion past the deadline is rejected', async () => {
  let now = 0;
  const inner = { metadata: {}, async handle() { now = LIMITS.milliseconds;
    return { response: { body: Readable.from([]) } }; } };
  const handler = new BoundedReadHandler(inner, { operation: 'inventory', now: () => now });
  const result = await handler.handle({ protocol: 'https:', hostname: `${ACCOUNT}.r2.cloudflarestorage.com`,
    method: 'GET', path: `/${DATA}/catalogs/current.json`, query: {} }, {});
  await assert.rejects(bodyBytes(result.response.body, LIMITS.pointer), /wire-deadline/);
});
test('real locked SDK serialization is admitted without making any network connection', async () => {
  const require = createRequire(new URL('../staging-controller/package.json', import.meta.url));
  const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const requests = [];
  const inner = { metadata: { handlerProtocol: 'http/1.1' }, destroy() {}, async handle(request) {
    requests.push(request);
    const list = request.query?.['list-type'];
    const body = list ? '<ListBucketResult><IsTruncated>false</IsTruncated><KeyCount>0</KeyCount></ListBucketResult>' : '{}';
    return { response: { statusCode: 200, headers: { 'content-length': String(Buffer.byteLength(body)), 'content-type': list ? 'application/xml' : 'application/json' }, body: Readable.from([Buffer.from(body)]) } };
  } };
  const client = new S3Client({ region: 'auto', endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`, forcePathStyle: true,
    maxAttempts: 1, requestHandler: new BoundedReadHandler(inner, { operation: 'inventory' }),
    credentials: { accessKeyId: 'fixture-only', secretAccessKey: 'fixture-only' } });
  try {
    const object = await client.send(new GetObjectCommand({ Bucket: DATA, Key: 'catalogs/current.json' }));
    assert.equal((await bodyBytes(object.Body, LIMITS.pointer)).toString(), '{}');
    const page = await client.send(new ListObjectsV2Command({ Bucket: COMPONENTS, Prefix: 'components/ecmwf/artifact-ecmwf/', MaxKeys: 1000 }));
    assert.equal(page.IsTruncated, false); assert.equal(requests.length, 2);
  } finally { client.destroy(); }
});

function changeCatalogDescriptor(f, change) {
  const key = `${DATA}/catalogs/snapshots/${CATALOG}.json`;
  const snapshot = JSON.parse(f.objects.get(key)); change(snapshot.components.ecmwf);
  const bytes = json(snapshot); f.objects.set(key, bytes);
  const pointerKey = `${DATA}/catalogs/current.json`, pointer = JSON.parse(f.objects.get(pointerKey));
  pointer.catalogSha256 = hash(bytes); f.objects.set(pointerKey, json(pointer));
}
test('semantically identical descriptor objects can have different property order', async () => {
  const f = fixture();
  changeCatalogDescriptor(f, entry => { entry.quality = { checks: entry.quality.checks, status: entry.quality.status }; });
  const plan = await inventory(f.client, CATALOG, SOURCE);
  assert.equal(plan.components.length, IDS.length);
  assert.deepEqual(plan.missing, []);
});
test('descriptor value or array changes still refuse inventory', async () => {
  for (const change of [entry => { entry.quality.status = 'failed'; }, entry => { entry.quality.checks = ['unexpected']; }]) {
    const f = fixture(); changeCatalogDescriptor(f, change);
    await assert.rejects(inventory(f.client, CATALOG, SOURCE), /manifest-descriptor/);
  }
});

const NO_DETAILS = 'do-not-print-provider-details';
async function failedPreparation(factory, change = {}) {
  const root = await mkdtemp(join(tmpdir(), 'train3-diagnostic-'));
  try {
    let failure;
    await assert.rejects(preparation({ env: { ...env, RUNNER_TEMP: root, ...change }, clientFactory: factory }), error => {
      failure = error; return true;
    });
    assert.deepEqual(await readdir(root), []);
    const record = failureDiagnostic(failure), encoded = JSON.stringify(record);
    assert.ok(Buffer.byteLength(encoded) < 1024); assert.ok(!encoded.includes(NO_DETAILS));
    assert.equal(record.completeOutputEligible, false); return record;
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('SDK access-denied XML emits only bounded categories, phase and numeric counts', async () => {
  const body = Buffer.from(`<Error><Code>AccessDenied</Code><Message>${NO_DETAILS}</Message><Key>${NO_DETAILS}</Key><RequestId>${NO_DETAILS}</RequestId></Error>`);
  const inner = { metadata: {}, destroy() {}, async handle() {
    return { response: { statusCode: 403, headers: { 'content-type': 'application/xml' }, body: Readable.from([body]) } };
  } };
  const record = await failedPreparation((e, operation, signal) => readClient({ ...e,
    SHARED_R2_READ_ACCESS_KEY_ID: 'a', SHARED_R2_READ_SECRET_ACCESS_KEY: 'b' }, operation, signal, { httpHandler: inner }));
  assert.equal(record.phase, 'pointer-before'); assert.equal(record.category, 'access-denied');
  assert.equal(record.sdkName, 'AccessDenied'); assert.equal(record.httpStatus, 403);
  assert.equal(record.requests, 1); assert.equal(record.wireBytes, body.length); assert.equal(record.cleanup, 'passed');
  assert.equal(record.localCode, null);
});
test('local validation provenance cannot be spoofed by an SDK error message', async () => {
  const local = await failedPreparation(() => { throw new Error('unreachable'); }, { REVIEWED_SOURCE_SHA: 'b'.repeat(40) });
  assert.equal(local.phase, 'gate'); assert.equal(local.localCode, 'source-pin'); assert.equal(local.category, 'validation');
  const spoof = await failedPreparation(() => ({ get() { throw new Error('source-pin'); }, stats() { return { requests: 0, wireBytes: 0 }; }, close() {} }));
  assert.equal(spoof.phase, 'pointer-before'); assert.equal(spoof.localCode, null); assert.equal(spoof.category, 'unknown');
});
test('unknown fields and malformed counters are withheld, retaining primary and cleanup outcomes', async () => {
  const record = await failedPreparation(() => ({
    get() { throw Object.assign(new Error(NO_DETAILS), { name: NO_DETAILS, code: NO_DETAILS,
      $metadata: { httpStatusCode: NO_DETAILS }, stack: NO_DETAILS, request: NO_DETAILS }); },
    stats() { return { requests: NO_DETAILS, wireBytes: Infinity }; },
    close() { throw new Error(NO_DETAILS); },
  }));
  assert.equal(record.phase, 'pointer-before'); assert.equal(record.category, 'unknown'); assert.equal(record.cleanup, 'failed');
  for (const field of ['sdkName', 'localCode', 'httpStatus', 'requests', 'wireBytes', 'transportCode', 'filesystemCode']) assert.equal(record[field], null);
});
test('failure classification refuses accessor properties instead of evaluating them', () => {
  let called = false;
  const record = failureDiagnostic(Object.defineProperties(new Error(NO_DETAILS), {
    name: { get() { called = true; throw new Error(NO_DETAILS); } },
    $metadata: { get() { called = true; throw new Error(NO_DETAILS); } },
  }));
  assert.equal(called, false); assert.equal(record.category, 'unknown'); assert.equal(record.sdkName, null);
});

test('a non-object primary failure still retains read phase across cleanup failure', async () => {
  const record = await failedPreparation(() => ({ get() { throw ''; }, stats() { return { requests: 0, wireBytes: 0 }; },
    close() { throw new Error(NO_DETAILS); } }));
  assert.equal(record.phase, 'pointer-before'); assert.equal(record.category, 'unknown'); assert.equal(record.cleanup, 'failed');
});

test('stats accessor values cannot replace a failure or enter diagnostics', async () => {
  let called = false;
  const stats = Object.defineProperty({}, 'requests', { get() { called = true; throw new Error(NO_DETAILS); } });
  const record = await failedPreparation(() => ({ get() { throw new Error(NO_DETAILS); }, stats() { return stats; }, close() {} }));
  assert.equal(called, false); assert.equal(record.requests, null); assert.equal(record.category, 'unknown');
});
