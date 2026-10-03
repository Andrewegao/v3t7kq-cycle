import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkflow } from '../tools/workflow-inventory.mjs';
import { ACCOUNT, BATCH_LIMITS, BoundedReadHandler, COMPONENTS, DATA, IDS, LIMITS, batchPlan, bodyBytes, exportBaseline, exportBatch,
  exportPlan, failureDiagnostic, gate, hash, historicalReadKeys, inventory, metadataAudit, preparation, producerOrder, readClient } from '../tools/train3-baseline-preparation.mjs';

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
    stats() { return { requests: calls.length, wireBytes: calls.filter(c => c[0] === 'get')
      .reduce((sum, c) => sum + objects.get(`${c[1]}/${c[2]}`).length, 0) }; }, close() {},
  };
  return { objects, prefixes, components, calls, client };
}
async function planned(f = fixture()) {
  const plan = await inventory(f.client, CATALOG, SOURCE), bytes = json(plan);
  return { f, plan, bytes, reviewed: exportPlan(bytes, hash(bytes), CATALOG) };
}
function partition(plan) {
  const groups = [IDS.slice(0, 7), IDS.slice(7, 14), IDS.slice(14)];
  return { schemaVersion: 1, kind: 'weatherx-train3-baseline-batches-v1', catalogId: CATALOG,
    reviewedInventorySha256: hash(json(plan)), batches: groups.map((ids, i) => {
      const items = ids.map(id => plan.components.find(item => item.id === id));
      return { id: `batch-${i + 1}`, componentIds: ids,
        payloadObjects: items.reduce((sum, item) => sum + item.objects.length, 0),
        payloadBytes: items.reduce((sum, item) => sum + item.objects.reduce((n, row) => n + row.bytes, 0), 0) };
    }) };
}
async function batched(f = fixture()) {
  const result = await planned(f), batches = partition(result.plan), batchBytes = json(batches);
  return { ...result, batches, batchBytes,
    reviewed: batchPlan(result.bytes, hash(result.bytes), batchBytes, hash(batchBytes), 'batch-1', CATALOG) };
}
function morePayloads() {
  const f = fixture(), prefix = 'components/ecmwf/artifact-ecmwf/';
  const rows = Array.from({ length: 20 }, (_, i) => {
    const path = `part-${i}.txt`, bytes = Buffer.from(`fixture ${i}`);
    f.objects.set(`${COMPONENTS}/${prefix}${path}`, bytes);
    return { path, size: bytes.length, sha256: hash(bytes) };
  }).sort(producerOrder);
  const manifest = JSON.parse(f.objects.get(`${COMPONENTS}/${prefix}component.json`));
  manifest.objectCount = rows.length; manifest.inventorySha256 = hash(JSON.stringify(rows));
  const raw = json(manifest); f.objects.set(`${COMPONENTS}/${prefix}component.json`, raw);
  changeCatalogDescriptor(f, entry => Object.assign(entry, manifest, { manifestSha256: hash(raw) }));
  f.prefixes.set(prefix, [{ Key: prefix + 'component.json', Size: raw.length },
    ...rows.map(row => ({ Key: prefix + row.path, Size: row.size }))]);
  return f;
}
const invocation = { sourceSha: SOURCE, runId: '1', runAttempt: '1' };
function largeInventory(payloadCount) {
  const f = fixture(), prefix = 'components/ecmwf/artifact-ecmwf/', key = `${COMPONENTS}/${prefix}component.json`;
  const manifest = JSON.parse(f.objects.get(key)); manifest.objectCount = payloadCount;
  const raw = json(manifest); f.objects.set(key, raw);
  changeCatalogDescriptor(f, entry => Object.assign(entry, manifest, { manifestSha256: hash(raw) }));
  f.prefixes.set(prefix, [{ Key: prefix + 'component.json', Size: raw.length }, ...Array.from({ length: payloadCount },
    (_, i) => ({ Key: prefix + `payload-${i}.bin`, Size: 1 }))]);
  f.client.list = async (prefix, token) => {
    f.calls.push(['list', prefix]); const rows = f.prefixes.get(prefix), start = token ? Number(token) : 0, end = start + 1000;
    return { Contents: rows.slice(start, end), IsTruncated: end < rows.length,
      ...(end < rows.length ? { NextContinuationToken: String(end) } : {}) };
  };
  return f;
}

test('workflow is manual, disabled by default, pinned, read-only, and retains success for one day', async () => {
  const path = '.github/workflows/train3-baseline-preparation.yml';
  const source = await readFile(new URL('../' + path, import.meta.url), 'utf8'), workflow = parseWorkflow(source, path).data;
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.on.workflow_dispatch.inputs.enable_preparation.default, false);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, ['metadata', 'inventory', 'batch-export', 'historical-batch-export']);
  assert.equal(workflow.on.workflow_dispatch.inputs.historical_baseline_confirmed.default, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.reviewed_plan_sha256.type, 'string');
  assert.equal(workflow.on.workflow_dispatch.inputs.reviewed_batch_plan_sha256.type, 'string');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.batch_id.options, ['', 'batch-1', 'batch-2', 'batch-3']);
  assert.equal(workflow.on.workflow_dispatch.inputs.batch_id.default, '');
  assert.equal(workflow.on.workflow_dispatch.inputs.owner_recipient_confirmed.default, false);
  for (const input of ['reviewed_recipient_id', 'reviewed_age_recipient', 'reviewed_age_recipient_sha256'])
    assert.equal(workflow.on.workflow_dispatch.inputs[input].default, '');
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
  const fixtureIndex = job.steps.findIndex(step => step.run === 'node --test tests/train3-baseline-preparation.mjs tests/train3-baseline-join.mjs tests/train3-baseline-encrypt.mjs tests/train3-baseline-decrypt.mjs');
  assert.ok(fixtureIndex >= 0); assert.ok(reader > fixtureIndex);
  const toolIndex = job.steps.findIndex(step => step.run?.startsWith('node tools/train3-baseline-encrypt.mjs prepare-toolchain'));
  assert.ok(toolIndex >= 0 && toolIndex < fixtureIndex);
  const readEnv = job.steps[reader].env;
  assert.equal(readEnv.OWNER_RECIPIENT_CONFIRMED, '${{ inputs.owner_recipient_confirmed }}');
  assert.equal(readEnv.HISTORICAL_BASELINE_CONFIRMED, '${{ inputs.historical_baseline_confirmed }}');
  assert.equal(readEnv.REVIEWED_AGE_RECIPIENT_SHA256, '${{ inputs.reviewed_age_recipient_sha256 }}');
  assert.equal(readEnv.AGE_RECIPIENT, readEnv.REVIEWED_AGE_RECIPIENT);
  assert.equal(readEnv.RECIPIENT_ID, readEnv.REVIEWED_RECIPIENT_ID);
  assert.equal(job.steps[reader].env.PREPARATION_OPERATION, '${{ inputs.operation }}');
  assert.equal(job.steps[reader].env.REVIEWED_PLAN_SHA256, '${{ inputs.reviewed_plan_sha256 }}');
  assert.equal(job.steps[reader].env.REVIEWED_BATCH_PLAN_SHA256, '${{ inputs.reviewed_batch_plan_sha256 }}');
  assert.equal(job.steps[reader].env.BATCH_ID, '${{ inputs.batch_id }}');
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
test('measured inventory allowance can cross the old cap without widening export admission', async () => {
  assert.equal(LIMITS.inventoryObjects, 50_000); assert.equal(LIMITS.objects, 25_000);
  assert.equal(LIMITS.inventoryRequests, 200); assert.equal(LIMITS.metadata, 32 * 1024 ** 2);
  const f = largeInventory(25_000), plan = await inventory(f.client, CATALOG, SOURCE), bytes = json(plan);
  assert.equal(plan.objectCount, 25_064); assert.equal(plan.components.length, 22);
  assert.equal(plan.payloadsRead, false); assert.ok(plan.payloadBytes < LIMITS.payload);
  assert.throws(() => exportPlan(bytes, hash(bytes), CATALOG), /payload-budget/);
});
test('inventory still stops at its separate 50,000 physical-key cap', async () => {
  const f = largeInventory(LIMITS.inventoryObjects);
  await assert.rejects(inventory(f.client, CATALOG, SOURCE), /object-count-budget/);
  assert.ok(f.calls.filter(c => c[0] === 'list').length <= 51);
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
test('a falsy reader close failure remains a cleanup failure and cannot retain output', async () => {
  for (const primaryFailure of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), 'train3-falsy-close-')), f = fixture();
    const originalGet = f.client.get;
    f.client.get = (...args) => { if (primaryFailure) throw new Error('read-failure'); return originalGet(...args); };
    f.client.close = () => { throw 0; };
    try {
      await assert.rejects(preparation({ env: { ...env, RUNNER_TEMP: root }, clientFactory: () => f.client }), error => {
        assert.equal(failureDiagnostic(error).cleanup, 'failed');
        assert.equal(failureDiagnostic(error).phase, primaryFailure ? 'pointer-before' : 'cleanup');
        if (primaryFailure) assert.match(error.message, /read-failure/);
        return true;
      });
      assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
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

test('batch admission validates the whole plan before selecting an exact disjoint partition', async () => {
  const { plan, bytes, batches, batchBytes } = await batched();
  assert.throws(() => batchPlan(bytes, 'b'.repeat(64), batchBytes, hash(batchBytes), 'batch-1', CATALOG), /reviewed-plan-hash/);
  assert.throws(() => batchPlan(bytes, hash(bytes), batchBytes, 'b'.repeat(64), 'batch-1', CATALOG), /reviewed-batch-plan-hash/);
  for (const mutate of [p => { p.reviewedInventorySha256 = 'b'.repeat(64); }, p => { p.catalogId = 'other'; },
    p => p.batches.pop(), p => p.batches[0].componentIds.pop(), p => p.batches[1].componentIds.push('ecmwf'),
    p => { p.batches[1].id = 'batch-1'; }, p => { p.batches[0].payloadBytes++; },
    p => p.batches[0].componentIds.push('unknown')]) {
    const copy = structuredClone(batches); mutate(copy); const raw = json(copy);
    assert.throws(() => batchPlan(bytes, hash(bytes), raw, hash(raw), 'batch-1', CATALOG));
  }
  // An unselected component's manifest/identity/count still has to pass full admission.
  for (const mutate of [p => { p.components.at(-1).manifestBase64 = Buffer.from('{}').toString('base64'); },
    p => { p.components.at(-1).layout = 'schema2'; }, p => p.components.at(-1).objects.pop(), p => p.objectCount++]) {
    const copy = structuredClone(plan); mutate(copy); const raw = json(copy), definitions = json(partition(copy));
    assert.throws(() => batchPlan(raw, hash(raw), definitions, hash(definitions), 'batch-1', CATALOG));
  }
});
test('real fixed three-batch measured plan is metadata-only and legacy full export remains refused', async () => {
  const bytes = await readFile(new URL('../ops/train3-baseline/export-plan.json', import.meta.url));
  const batchBytes = await readFile(new URL('../ops/train3-baseline/batch-plan.json', import.meta.url));
  const catalogId = JSON.parse(bytes).catalogId;
  assert.throws(() => exportPlan(bytes, hash(bytes), catalogId), /payload-budget/);
  for (const batchId of ['batch-1', 'batch-2', 'batch-3']) {
    const reviewed = batchPlan(bytes, hash(bytes), batchBytes, hash(batchBytes), batchId, catalogId);
    assert.equal(reviewed.plan.components.length, 22);
    assert.ok(reviewed.total <= LIMITS.payload);
    assert.ok(reviewed.selectedComponents.reduce((n, c) => n + c.objects.length, 0) <= LIMITS.objects);
  }
  const changed = JSON.parse(batchBytes); changed.batches[0].payloadObjects = LIMITS.objects + 1;
  const raw = json(changed); assert.throws(() => batchPlan(bytes, hash(bytes), raw, hash(raw), 'batch-2', catalogId), /batch-payload-budget/);
});
test('larger full-plan envelope never widens selected payload or object caps', async () => {
  for (const payloadCount of [25_000, 45_000]) {
    const plan = await inventory(largeInventory(payloadCount).client, CATALOG, SOURCE);
    const bytes = json(plan), batchBytes = json(partition(plan));
    assert.throws(() => batchPlan(bytes, hash(bytes), batchBytes, hash(batchBytes), 'batch-3', CATALOG),
      payloadCount === 25_000 ? /batch-payload-budget/ : /payload-budget/);
  }
  const bytes = await readFile(new URL('../ops/train3-baseline/export-plan.json', import.meta.url));
  const definitions = JSON.parse(await readFile(new URL('../ops/train3-baseline/batch-plan.json', import.meta.url)));
  for (const extraRows of [6, 20]) {
    const plan = JSON.parse(bytes), selected = plan.components.find(item => item.id === 'gfs');
    for (let i = 0; i < extraRows; i++) selected.objects[i].bytes = LIMITS.object;
    plan.payloadBytes = plan.components.reduce((sum, item) => sum + item.objects.reduce((n, row) => n + row.bytes, 0), 0);
    const raw = json(plan), batches = structuredClone(definitions); batches.reviewedInventorySha256 = hash(raw);
    batches.batches[0].payloadBytes = batches.batches[0].componentIds.reduce((sum, id) =>
      sum + plan.components.find(item => item.id === id).objects.reduce((n, row) => n + row.bytes, 0), 0);
    const batchBytes = json(batches);
    assert.throws(() => batchPlan(raw, hash(raw), batchBytes, hash(batchBytes), 'batch-3', plan.catalogId),
      extraRows === 6 ? /batch-payload-budget/ : /payload-budget/);
  }
});
test('batch export uses at most eight GET/write workers and authenticates out-of-order completion without a seal', async () => {
  const { f, reviewed } = await batched(morePayloads()), root = await mkdtemp(join(tmpdir(), 'train3-batch-pool-'));
  const original = f.client.get, keys = []; let active = 0, maximum = 0;
  f.client.get = async (...args) => {
    if (args[0] !== COMPONENTS || args[1].endsWith('/component.json')) return original(...args);
    keys.push(args[1]); maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 10 - keys.length % 8));
    try { return await original(...args); } finally { active--; }
  };
  try {
    const receipt = await exportBatch(f.client, reviewed, root, invocation);
    assert.equal(maximum, 8); assert.equal(active, 0); assert.equal(keys.length, new Set(keys).size);
    assert.equal(receipt.kind, 'weatherx-train3-original-baseline-batch-v1');
    assert.equal(receipt.completeBaselineEligible, false); assert.equal(receipt.coreSealSha256, null);
    assert.equal(receipt.scientificValidationPerformed, false); assert.equal(receipt.publicationAuthorized, false);
    assert.deepEqual(receipt.components.map(c => c.componentId), reviewed.selectedComponents.map(c => c.id));
    assert.equal(receipt.reviewedBatchPlanSha256, reviewed.reviewedBatchPlanSha256);
    await assert.rejects(readFile(join(root, 'core/seal.json')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(root, 'original/components/ecmwf/payload/part-0.txt')),
      await readFile(join(root, 'core/components/ecmwf/payload/part-0.txt')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('first falsy failure cancels in-flight reads, drains all workers and permits cleanup without late writes', async () => {
  const { f, reviewed } = await batched(morePayloads()), root = await mkdtemp(join(tmpdir(), 'train3-batch-abort-'));
  const abort = new AbortController(), original = f.client.get;
  let started = 0, settled = 0, cancelled = 0, release;
  const allStarted = new Promise(resolve => { release = resolve; });
  f.client.get = async (...args) => {
    if (args[0] !== COMPONENTS || args[1].endsWith('/component.json')) return original(...args);
    const n = ++started; if (started === 8) release();
    if (n === 1) { await allStarted; settled++; throw ''; }
    await new Promise(resolve => abort.signal.addEventListener('abort', resolve, { once: true }));
    await new Promise(resolve => setTimeout(resolve, 10)); settled++; return original(...args);
  };
  try {
    let rejected = false;
    try { await exportBatch(f.client, reviewed, root, { ...invocation, signal: abort.signal,
      cancel() { cancelled++; abort.abort(); } }); }
    catch (error) { rejected = true; assert.equal(error, ''); }
    assert.equal(rejected, true); assert.equal(cancelled, 1); assert.equal(started, 8); assert.equal(settled, 8);
    await assert.rejects(readdir(join(root, 'original/components/ecmwf/payload')), { code: 'ENOENT' });
    await rm(root, { recursive: true, force: true });
    await new Promise(resolve => setTimeout(resolve, 15));
    await assert.rejects(readdir(root), { code: 'ENOENT' }); assert.equal(started, 8);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('batch payload hash, pointer rotation, disk reserve and deadline failures cannot produce a receipt or seal', async () => {
  for (const scenario of ['hash', 'pointer', 'disk', 'deadline']) {
    const { f, reviewed } = await batched(), root = await mkdtemp(join(tmpdir(), 'train3-batch-refusal-'));
    let now = 0, diskLow = false, pointers = 0;
    const original = f.client.get;
    f.client.get = async (...args) => {
      const bytes = await original(...args);
      if (scenario === 'pointer' && args[1] === 'catalogs/current.json' && ++pointers === 2) return Buffer.concat([bytes, Buffer.from(' ')]);
      if (args[0] === COMPONENTS && !args[1].endsWith('/component.json')) {
        if (scenario === 'disk') diskLow = true;
        if (scenario === 'deadline') now = BATCH_LIMITS.milliseconds;
        if (scenario === 'hash') return Buffer.alloc(bytes.length);
      }
      return bytes;
    };
    try {
      await assert.rejects(exportBatch(f.client, reviewed, root, { ...invocation, now: () => now,
        disk: async () => ({ bavail: diskLow ? 0 : 2 * BATCH_LIMITS.reserve, bsize: 1 }) }));
      await assert.rejects(readFile(join(root, 'core/seal.json')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
test('exclusive payload write failure preserves its error and invokes cancellation before worker completion', async () => {
  const { f, reviewed } = await batched(), root = await mkdtemp(join(tmpdir(), 'train3-batch-write-'));
  const path = join(root, 'original/components/ecmwf/payload/A');
  await mkdir(path, { recursive: true }); await writeFile(join(path, '1.txt'), 'owned fixture');
  const abort = new AbortController(); let cancelled = 0;
  try {
    await assert.rejects(exportBatch(f.client, reviewed, root, { ...invocation, signal: abort.signal,
      cancel() { cancelled++; abort.abort(); } }), { code: 'EEXIST' });
    assert.equal(cancelled, 1);
    await assert.rejects(readFile(join(root, 'core/seal.json')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('batch CLI refuses unconfirmed recipients before a reader and retains only encrypted verified bytes', async () => {
  const { f, bytes, batchBytes } = await batched(), root = await realpath(await mkdtemp(join(tmpdir(), 'train3-batch-cli-')));
  const previous = process.cwd(), repo = join(root, 'repo');
  await mkdir(join(repo, 'ops/train3-baseline'), { recursive: true });
  await writeFile(join(repo, 'ops/train3-baseline/export-plan.json'), bytes);
  await writeFile(join(repo, 'ops/train3-baseline/batch-plan.json'), batchBytes);
  const batchEnv = { ...env, RUNNER_TEMP: root, PREPARATION_OPERATION: 'batch-export', BATCH_ID: 'batch-1',
    REVIEWED_PLAN_SHA256: hash(bytes), REVIEWED_BATCH_PLAN_SHA256: hash(batchBytes) };
  try {
    process.chdir(repo);
    for (const operation of ['batch-export', 'historical-batch-export'])
    for (const change of [{ REVIEWED_BATCH_PLAN_SHA256: '' }, { BATCH_ID: 'other' }, { REVIEWED_PLAN_SHA256: 'b'.repeat(64) },
      { REVIEWED_BATCH_PLAN_SHA256: 'b'.repeat(64) }, { REVIEWED_SOURCE_SHA: 'b'.repeat(40) }, { EXPECTED_CATALOG_ID: 'other-fixture' }]) {
      let called = false;
      await assert.rejects(preparation({ env: { ...batchEnv, PREPARATION_OPERATION: operation,
        HISTORICAL_BASELINE_CONFIRMED: 'true', ...change }, clientFactory() { called = true; } }));
      assert.equal(called, false); assert.deepEqual(await readdir(root), ['repo']);
    }
    let called = false;
    await assert.rejects(preparation({ env: batchEnv, clientFactory() { called = true; } }), /owner-recipient-confirmation/);
    assert.equal(called, false); assert.deepEqual(await readdir(root), ['repo']);
    called = false;
    await assert.rejects(preparation({ env: { ...batchEnv, PREPARATION_OPERATION: 'export' },
      clientFactory() { called = true; } }), /legacy-export-needs-confidential-transport/);
    assert.equal(called, false); assert.deepEqual(await readdir(root), ['repo']);
    const { verifyAgeToolchain } = await import('../tools/train3-baseline-encrypt.mjs');
    const toolchain = await verifyAgeToolchain({ ageBinary: process.env.TRAIN3_AGE_BINARY,
      ageKeygenBinary: process.env.TRAIN3_AGE_KEYGEN_BINARY, distributionArchive: process.env.TRAIN3_AGE_DISTRIBUTION_ARCHIVE });
    const keyPath = join(root, 'synthetic-identity.txt'), childEnv = { PATH: '/nonexistent', HOME: root, TMPDIR: root, LANG: 'C' };
    execFileSync(toolchain.ageKeygenBinary, ['-o', keyPath], { env: childEnv, stdio: 'pipe', timeout: 10_000 });
    const recipient = execFileSync(toolchain.ageKeygenBinary, ['-y', keyPath], { env: childEnv, stdio: 'pipe', timeout: 10_000 }).toString().trim();
    const confirmed = { ...batchEnv, OWNER_RECIPIENT_CONFIRMED: 'true', RECIPIENT_ID: 'synthetic-fixture',
      REVIEWED_RECIPIENT_ID: 'synthetic-fixture', AGE_RECIPIENT: recipient, REVIEWED_AGE_RECIPIENT: recipient,
      REVIEWED_AGE_RECIPIENT_SHA256: hash(Buffer.from(recipient)), TRAIN3_AGE_BINARY: toolchain.ageBinary,
      TRAIN3_AGE_KEYGEN_BINARY: toolchain.ageKeygenBinary, TRAIN3_AGE_DISTRIBUTION_ARCHIVE: toolchain.distributionArchive };
    for (const operation of ['batch-export', 'historical-batch-export'])
    for (const change of [{ REVIEWED_RECIPIENT_ID: 'different' }, { REVIEWED_AGE_RECIPIENT_SHA256: 'b'.repeat(64) },
      { OWNER_RECIPIENT_CONFIRMED: 'false' }, { TRAIN3_AGE_BINARY: '/nonexistent/age' }]) {
      called = false;
      await assert.rejects(preparation({ env: { ...confirmed, PREPARATION_OPERATION: operation,
        HISTORICAL_BASELINE_CONFIRMED: 'true', ...change }, clientFactory() { called = true; } }));
      assert.equal(called, false);
    }
    const output = join(root, 'train3-baseline-preparation'), pinnedPointer = f.objects.get(`${DATA}/catalogs/current.json`);
    for (const operation of ['batch-export', 'historical-batch-export']) {
      const observed = operation === 'historical-batch-export' ? newerPointer(f) : pinnedPointer;
      f.calls.length = 0;
      await preparation({ env: { ...confirmed, PREPARATION_OPERATION: operation, HISTORICAL_BASELINE_CONFIRMED: 'true' },
        clientFactory(_env, mode, _signal, options) {
          assert.equal(mode, operation);
          if (mode === 'historical-batch-export') assert.deepEqual(options.reviewedKeys, historicalReadKeys(batchPlan(bytes, hash(bytes), batchBytes, hash(batchBytes), 'batch-1', CATALOG)));
          return f.client;
        } });
      assert.deepEqual((await readdir(output)).sort(), ['batch.age', 'encrypted-receipt.json']);
      const receipt = JSON.parse(await readFile(join(output, 'encrypted-receipt.json')));
      assert.equal(receipt.kind, 'weatherx-train3-encrypted-baseline-batch-v1');
      assert.equal(receipt.completeBaselineEligible, false); assert.equal(receipt.publicationAuthorized, false);
      assert.equal(receipt.recipientSha256, hash(Buffer.from(recipient)));
      assert.equal(receipt.ciphertextSha256, hash(await readFile(join(output, 'batch.age'))));
      for (const field of ['catalogId', 'sourceSha', 'batchId', 'reviewedPlanSha256', 'reviewedBatchPlanSha256', 'observedCurrentPointerBase64', 'observedCurrentPointerAfterBase64', 'currentPointerPolicy', 'operation']) assert.equal(receipt[field], undefined);
      const archive = execFileSync(toolchain.ageBinary, ['--decrypt', '--identity', keyPath, join(output, 'batch.age')],
        { env: childEnv, stdio: 'pipe', timeout: 10_000, maxBuffer: 1024 ** 2 });
      assert.ok(archive.includes(Buffer.from('batch-receipt.json')));
      assert.ok(archive.includes(Buffer.from(hash(batchBytes))));
      assert.ok(archive.includes(Buffer.from('original ecmwf')));
      if (operation === 'historical-batch-export') {
        const observedField = Buffer.from(observed.toString('base64'));
        assert.ok(archive.includes(observedField));
        const beforeOffset = archive.indexOf(observedField), afterOffset = archive.indexOf(observedField, beforeOffset + observedField.length);
        assert.ok(afterOffset > beforeOffset);
        assert.equal(archive.indexOf(observedField, afterOffset + observedField.length), -1);
        assert.ok(archive.includes(Buffer.from('historical-observation-v1')));
        assert.ok(archive.includes(Buffer.from('historical-batch-export')));
      }
      assert.equal(f.calls.filter(c => c[0] === 'list').length, 0);
      await assert.rejects(readFile(join(output, 'core/seal.json')), { code: 'ENOENT' });
      await assert.rejects(readdir(join(root, 'train3-baseline-work-1-1')), { code: 'ENOENT' });
      await rm(output, { recursive: true });
    }
    f.objects.set(`${DATA}/catalogs/current.json`, pinnedPointer);
    // Change only a disposable exact tool copy after recipient admission. A real
    // encryption process failure must leave neither ciphertext nor plaintext upload output.
    const localTools = join(root, 'synthetic-tools'); await mkdir(localTools, { mode: 0o700 });
    for (const [name, source] of [['age', toolchain.ageBinary], ['age-keygen', toolchain.ageKeygenBinary],
      ['distribution.tar.gz', toolchain.distributionArchive]]) {
      await copyFile(source, join(localTools, name)); await chmod(join(localTools, name), name.endsWith('.gz') ? 0o600 : 0o700);
    }
    f.calls.length = 0; called = false;
    await assert.rejects(preparation({ env: { ...confirmed, TRAIN3_AGE_BINARY: join(localTools, 'age'),
      TRAIN3_AGE_KEYGEN_BINARY: join(localTools, 'age-keygen'), TRAIN3_AGE_DISTRIBUTION_ARCHIVE: join(localTools, 'distribution.tar.gz') },
      async clientFactory() { called = true; await chmod(join(localTools, 'age'), 0o600); return f.client; } }));
    assert.equal(called, true); assert.ok(f.calls.length > 0);
    await assert.rejects(readdir(output), { code: 'ENOENT' });
    await assert.rejects(readdir(join(root, 'train3-baseline-work-1-1')), { code: 'ENOENT' });
  } finally { process.chdir(previous); await rm(root, { recursive: true, force: true }); }
});
test('batch transport retains request/wire caps, allows payload GET but no LIST, and has a separate thirty-minute deadline', async () => {
  let calls = 0, now = 0;
  const inner = { metadata: {}, async handle() { calls++; return { response: { body: Readable.from(['x']) } }; } };
  const request = { protocol: 'https:', hostname: `${ACCOUNT}.r2.cloudflarestorage.com`, method: 'GET',
    path: `/${COMPONENTS}/components/ecmwf/a/payload.bin`, query: {} };
  const handler = new BoundedReadHandler(inner, { operation: 'batch-export', now: () => now });
  assert.equal(handler.deadline, 30 * 60_000);
  await assert.rejects(handler.handle({ ...request, path: `/${COMPONENTS}/`,
    query: { 'list-type': '2', 'max-keys': '1000', prefix: 'components/ecmwf/a/' } }, {}), /unscoped-list/);
  const response = await handler.handle(request, {}); await bodyBytes(response.response.body, LIMITS.object); assert.equal(calls, 1);
  handler.requests = LIMITS.exportRequests;
  await assert.rejects(handler.handle(request, {}), /request-or-time-budget/); assert.equal(calls, 1);
  handler.requests = 0; handler.bytes = LIMITS.payload + LIMITS.metadata;
  const excess = await handler.handle(request, {}); await assert.rejects(bodyBytes(excess.response.body, LIMITS.object), /wire-budget/);
  now = BATCH_LIMITS.milliseconds; await assert.rejects(handler.handle(request, {}), /request-or-time-budget/);
  assert.equal(new BoundedReadHandler(inner, { operation: 'export', now: () => 0 }).deadline, 43 * 60_000);
});

test('historical mode is explicit and defaults to refusal before any reader', async () => {
  const admitted = { ...env, PREPARATION_OPERATION: 'historical-batch-export', BATCH_ID: 'batch-1',
    REVIEWED_PLAN_SHA256: 'b'.repeat(64), REVIEWED_BATCH_PLAN_SHA256: 'c'.repeat(64) };
  for (const confirmation of [undefined, 'false', 'TRUE']) {
    let called = false;
    await assert.rejects(preparation({ env: { ...admitted, HISTORICAL_BASELINE_CONFIRMED: confirmation },
      clientFactory() { called = true; } }), /historical-baseline-confirmation/);
    assert.equal(called, false);
  }
  assert.equal(gate({ ...admitted, HISTORICAL_BASELINE_CONFIRMED: 'true' }).operation, 'historical-batch-export');
  assert.throws(() => gate({ ...admitted, HISTORICAL_BASELINE_CONFIRMED: 'true', PREPARATION_OPERATION: 'unknown' }), /operation/);
});

function newerPointer(f) {
  const current = JSON.parse(f.objects.get(`${DATA}/catalogs/current.json`));
  const observed = json({ ...current, catalogId: 'newer-fixture', sequence: current.sequence + 1,
    previousCatalogId: CATALOG, catalogSha256: 'f'.repeat(64) });
  f.objects.set(`${DATA}/catalogs/current.json`, observed);
  return observed;
}
const scientificGets = calls => calls.filter(c => c[0] === 'get' && c[1] === COMPONENTS && !c[2].endsWith('/component.json'));

test('strict refuses rotated pointer while historical preflights all pinned manifests and reads no newer keys', async () => {
  const { f, reviewed } = await batched(), observed = newerPointer(f);
  const root = await mkdtemp(join(tmpdir(), 'train3-historical-export-'));
  try {
    f.calls.length = 0;
    await assert.rejects(exportBatch(f.client, reviewed, root, invocation), /catalog-rotated/);
    assert.equal(f.calls.length, 1); assert.deepEqual(await readdir(root), []);
    f.calls.length = 0;
    const receipt = await exportBatch(f.client, reviewed, root, { ...invocation, operation: 'historical-batch-export' });
    assert.equal(receipt.operation, 'historical-batch-export');
    assert.equal(receipt.observedCurrentPointerBase64, observed.toString('base64'));
    assert.equal(receipt.completeBaselineEligible, false); assert.equal(receipt.coreSealSha256, null);
    assert.deepEqual(await readFile(join(root, 'original/catalog-pointer.json')), reviewed.pointer);
    assert.ok(f.calls.every(c => c[0] === 'get' && historicalReadKeys(reviewed).has(`${c[1]}/${c[2]}`)));
    const firstPayload = f.calls.findIndex(c => scientificGets([c]).length);
    assert.equal(firstPayload, reviewed.selectedComponents.length + 2);
    assert.equal(f.calls.length, scientificGets(f.calls).length + reviewed.selectedComponents.length + 3);
    assert.ok(!f.calls.some(c => c[2]?.includes('newer-fixture')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('historical snapshot or any selected manifest mismatch refuses before all scientific GETs', async () => {
  for (const kind of ['snapshot', 'last-manifest']) {
    const { f, reviewed } = await batched(); newerPointer(f); f.calls.length = 0;
    const key = kind === 'snapshot' ? `${DATA}/catalogs/snapshots/${CATALOG}.json`
      : `${COMPONENTS}/${reviewed.catalog.components[reviewed.selectedComponents.at(-1).id].manifestKey}`;
    f.objects.set(key, Buffer.from('{}'));
    const root = await mkdtemp(join(tmpdir(), 'train3-historical-preflight-'));
    try {
      await assert.rejects(exportBatch(f.client, reviewed, root, { ...invocation, operation: 'historical-batch-export' }),
        kind === 'snapshot' ? /snapshot-changed/ : /manifest-changed/);
      assert.equal(scientificGets(f.calls).length, 0); assert.deepEqual(await readdir(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('historical payload corruption and malformed final pointer still refuse', async () => {
  for (const kind of ['payload', 'pointer']) {
    const { f, reviewed } = await batched(); newerPointer(f); f.calls.length = 0;
    if (kind === 'payload') {
      const row = reviewed.selectedComponents[0].objects[0];
      f.objects.set(`${COMPONENTS}/${row.key}`, Buffer.alloc(row.bytes, 0));
    } else {
      const original = f.client.get; let pointers = 0;
      f.client.get = async (...args) => {
        const bytes = await original(...args);
        return args[1] === 'catalogs/current.json' && ++pointers === 2 ? Buffer.from('{}') : bytes;
      };
    }
    const root = await mkdtemp(join(tmpdir(), 'train3-historical-boundary-'));
    try {
      await assert.rejects(exportBatch(f.client, reviewed, root, { ...invocation, operation: 'historical-batch-export' }),
        kind === 'payload' ? /original-inventory-hash/ : /observed-current-pointer/);
      await assert.rejects(lstat(join(root, 'batch-receipt.json')), { code: 'ENOENT' });
      await assert.rejects(lstat(join(root, 'core/seal.json')), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('historical HTTP guard enforces exact original keys, bucket, GET and zero LIST before transport', async () => {
  const { reviewed } = await batched(); let calls = 0;
  const keys = historicalReadKeys(reviewed);
  const inner = { metadata: {}, async handle() { calls++; return { response: { body: Readable.from([Buffer.from('ok')]) } }; } };
  assert.throws(() => new BoundedReadHandler(inner, { operation: 'historical-batch-export' }), /historical-read-allowlist/);
  const handler = new BoundedReadHandler(inner, { operation: 'historical-batch-export', reviewedKeys: keys });
  const request = { protocol: 'https:', hostname: `${ACCOUNT}.r2.cloudflarestorage.com`, method: 'GET', query: {} };
  for (const key of keys) await bodyBytes((await handler.handle({ ...request, path: '/' + key })).response.body, 2);
  const before = calls;
  for (const path of [`/${DATA}/catalogs/snapshots/newer-fixture.json`,
    `/${COMPONENTS}/components/ecmwf/other/component.json`, `/${COMPONENTS}/components/ecmwf/artifact-ecmwf/alternate.txt`,
    `/${COMPONENTS}/${reviewed.selectedComponents.at(-1).objects[0].key.replace('artifact-', 'new-')}`, '/other/catalogs/current.json'])
    await assert.rejects(handler.handle({ ...request, path }));
  await assert.rejects(handler.handle({ ...request, path: `/${COMPONENTS}/`, query: { 'list-type': '2' } }), /unscoped-list/);
  await assert.rejects(handler.handle({ ...request, path: `/${DATA}/catalogs/current.json`, method: 'PUT' }), /non-read-request/);
  assert.equal(calls, before);
});

test('historical original tracked pins and recipient admission refuse before client construction', async () => {
  const planBytes = await readFile(new URL('../ops/train3-baseline/export-plan.json', import.meta.url));
  const batchBytes = await readFile(new URL('../ops/train3-baseline/batch-plan.json', import.meta.url));
  const admitted = { ...env, PREPARATION_OPERATION: 'historical-batch-export', HISTORICAL_BASELINE_CONFIRMED: 'true',
    EXPECTED_CATALOG_ID: JSON.parse(planBytes).catalogId, REVIEWED_PLAN_SHA256: hash(planBytes),
    REVIEWED_BATCH_PLAN_SHA256: hash(batchBytes), BATCH_ID: 'batch-1',
    TRAIN3_AGE_BINARY: process.env.TRAIN3_AGE_BINARY, TRAIN3_AGE_KEYGEN_BINARY: process.env.TRAIN3_AGE_KEYGEN_BINARY,
    TRAIN3_AGE_DISTRIBUTION_ARCHIVE: process.env.TRAIN3_AGE_DISTRIBUTION_ARCHIVE };
  for (const change of [{ REVIEWED_SOURCE_SHA: 'b'.repeat(40) }, { REVIEWED_PLAN_SHA256: 'b'.repeat(64) },
    { REVIEWED_BATCH_PLAN_SHA256: 'b'.repeat(64) }, { EXPECTED_CATALOG_ID: 'different-fixture' },
    { OWNER_RECIPIENT_CONFIRMED: 'false' }, { OWNER_RECIPIENT_CONFIRMED: 'true', RECIPIENT_ID: 'fixture', REVIEWED_RECIPIENT_ID: 'different' }]) {
    let called = false;
    await assert.rejects(preparation({ env: { ...admitted, ...change }, clientFactory() { called = true; } }));
    assert.equal(called, false);
  }
});


test('historical before/after rotation is observation only while strict final rotation refuses', async () => {
  for (const operation of ['batch-export', 'historical-batch-export']) {
    const { f, reviewed } = await batched(), before = reviewed.pointer;
    const after = json({ ...JSON.parse(before), catalogId: '1444-longer-rotated-fixture', sequence: 1444,
      previousCatalogId: CATALOG, catalogSha256: 'f'.repeat(64) });
    const get = f.client.get; let pointers = 0;
    f.client.get = async (...args) => args[1] === 'catalogs/current.json' && ++pointers === 2 ? after : get(...args);
    const root = await mkdtemp(join(tmpdir(), 'train3-pointer-observation-'));
    try {
      if (operation === 'batch-export') await assert.rejects(exportBatch(f.client, reviewed, root,
        { ...invocation, operation }), /catalog-rotated/);
      else {
        const result = await exportBatch(f.client, reviewed, root, { ...invocation, operation });
        assert.equal(result.currentPointerPolicy, 'historical-observation-v1');
        assert.equal(result.observedCurrentPointerBase64, before.toString('base64'));
        assert.equal(result.observedCurrentPointerAfterBase64, after.toString('base64'));
        assert.notEqual(before.length, after.length);
        assert.deepEqual(await readFile(join(root, 'original/catalog-snapshot.json')), reviewed.snapshot);
        for (const item of reviewed.selectedComponents) {
          assert.deepEqual(await readFile(join(root, `original/components/${item.id}/component.json`)),
            Buffer.from(item.manifestBase64, 'base64'));
          for (const object of item.objects) {
            const suffix = object.key.slice(reviewed.catalog.components[item.id].rootPrefix.length);
            assert.deepEqual(await readFile(join(root, `original/components/${item.id}/payload/${suffix}`)),
              f.objects.get(`${COMPONENTS}/${object.key}`));
          }
        }
      }
      assert.equal(pointers, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
