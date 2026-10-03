import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow } from '../tools/workflow-inventory.mjs';
import { ACCOUNT, BoundedReadHandler, COMPONENTS, DATA, IDS, LIMITS, bodyBytes, exportBaseline,
  exportPlan, gate, hash, inventory, preparation, producerOrder } from '../tools/train3-baseline-preparation.mjs';

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
  const job = workflow.jobs.prepare; assert.equal(job.environment, 'data-staging'); assert.equal(job['timeout-minutes'], 45);
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
test('reader close failure still removes its private directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'train3-close-test-'));
  try {
    await assert.rejects(preparation({ env: { ...env, RUNNER_TEMP: root }, clientFactory: () => ({
      get() { throw new Error('read-failure'); }, close() { throw new Error('close-failure'); },
    }) }), /close-failure/);
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
