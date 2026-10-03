import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile, lstat, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { allocationEstimate, baselineCapacity, joinBaseline, readRegular, verifyBatch, isVerifiedBatch } from '../tools/train3-baseline-join.mjs';
import { CORE, IDS, hash, producerOrder } from '../tools/train3-baseline-preparation.mjs';

const SOURCE = 'a'.repeat(40), CATALOG = '1410-fixture';
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const ampleDisk = async () => ({ bavail: 10 ** 12, bsize: 1 });
const groupIds = [
  ['gfs', 'icon', 'nam', 'hrrr-ak', 'arome-antilles', 'point-nam', 'point-hrrr'],
  ['ecmwf', 'hrrr', 'point-icon'],
  ['point-ecmwf', 'point-gfs', 'point-aifs', 'hrdps', 'aifs', 'nam-ak', 'point-hrdps',
    'point-nam-ak', 'point-hrrr-ak', 'point-arome-antilles', 'nam-hi', 'point-nam-hi'],
];
const core = id => CORE.includes(id.replace(/^point-/, ''));

// Account for newly written fixture files/directories on every disk poll. Existing
// inputs already consume space and are excluded, just as statfs reports free space.
export async function meteredDisk(root, initialFreeBytes, blockSize = 4096) {
  const existing = new Set(await readdir(root));
  let minimumFreeBytes = initialFreeBytes, polls = 0;
  const disk = async () => {
    const files = new Map(), directories = new Set();
    async function visit(path) {
      const info = await lstat(join(root, path));
      if (info.isDirectory()) { directories.add(path);
        for (const child of await readdir(join(root, path))) await visit(`${path}/${child}`);
      } else { assert.ok(info.isFile()); files.set(path, info.size); }
    }
    for (const name of await readdir(root)) if (!existing.has(name)) await visit(name);
    const represented = new Set();
    for (const path of files.keys()) { let parent = dirname(path);
      while (parent !== '.') { represented.add(parent); parent = dirname(parent); } }
    const missingDirectories = [...directories].filter(path => !represented.has(path)).length;
    const allocation = allocationEstimate(files, blockSize).allocationBytes - 3 * blockSize + missingDirectories * 3 * blockSize;
    const free = initialFreeBytes - allocation; minimumFreeBytes = Math.min(minimumFreeBytes, free); polls++;
    return { bsize: blockSize, bavail: Math.floor(free / blockSize) };
  };
  return { disk, stats: () => ({ minimumFreeBytes, polls }) };
}
async function put(root, path, bytes) {
  await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  await writeFile(join(root, path), bytes, { mode: 0o600 });
}
async function changeJson(root, path, change) {
  const value = JSON.parse(await readFile(join(root, path))); change(value); await put(root, path, json(value));
}

export async function fixture({ pairMismatch = false } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'train3-join-test-'));
  const descriptors = {}, components = [], bodies = new Map();
  for (const id of IDS) {
    const rootPrefix = `components/${id}/artifact-${id}/`;
    const payload = new Map([['A/1.txt', Buffer.from(`original ${id}\n`)], ['z.txt', Buffer.from('bytes')]]);
    const rows = [...payload].map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) })).sort(producerOrder);
    const manifest = { schemaVersion: 1, componentId: id, artifactId: `artifact-${id}`, rootPrefix,
      generationTime: '2026-10-03T00:00:00Z', completedAt: '2026-10-03T01:00:00Z',
      mounts: [id.startsWith('point-') ? `point-series/v2/${id.slice(6)}/` : `data/${id}/`],
      objectCount: rows.length, inventorySha256: hash(JSON.stringify(rows)), quality: { status: 'passed', checks: [] },
      ...(id.startsWith('point-') ? { pointSeries: { modelId: id.slice(6), descriptor: {
        initializedAt: pairMismatch && id === 'point-gfs' ? '2026-10-02T18:00:00Z' : '2026-10-03T00:00:00Z',
        runId: pairMismatch && id === 'point-gfs' ? '2026100218' : '2026100300' } } } : {}) };
    const raw = json(manifest), manifestKey = rootPrefix + 'component.json';
    descriptors[id] = { ...manifest, manifestKey, manifestSha256: hash(raw) };
    components.push({ id, layout: 'schema1', manifestBase64: raw.toString('base64'),
      objects: [...payload].map(([path, bytes]) => ({ key: rootPrefix + path, bytes: bytes.length })) });
    bodies.set(id, { raw, payload, rows, manifest });
  }
  const snapshot = json({ schemaVersion: 2, sequence: 1410, createdAt: '2026-10-03T02:00:00Z', parentCatalogId: null,
    components: descriptors });
  const pointer = json({ schemaVersion: 2, catalogId: CATALOG, sequence: 1410, publishedAt: '2026-10-03T02:00:00Z',
    previousCatalogId: null, catalogSha256: hash(snapshot) });
  const payloadBytes = components.reduce((sum, c) => sum + c.objects.reduce((n, o) => n + o.bytes, 0), 0);
  const planBytes = json({ schemaVersion: 1, kind: 'weatherx-train3-baseline-inventory-v1', catalogId: CATALOG,
    inventorySourceSha: 'b'.repeat(40), pointerBase64: pointer.toString('base64'), snapshotBase64: snapshot.toString('base64'),
    components, missing: [], objectCount: IDS.length * 3, payloadBytes, payloadsRead: false, publicationAuthorized: false });
  const planSha256 = hash(planBytes);
  const batches = groupIds.map((componentIds, i) => ({ id: `batch-${i + 1}`, componentIds,
    payloadObjects: components.filter(c => componentIds.includes(c.id)).reduce((n, c) => n + c.objects.length, 0),
    payloadBytes: components.filter(c => componentIds.includes(c.id)).reduce((n, c) => n + c.objects.reduce((s, o) => s + o.bytes, 0), 0) }));
  const batchPlanBytes = json({ schemaVersion: 1, kind: 'weatherx-train3-baseline-batches-v1', catalogId: CATALOG,
    reviewedInventorySha256: planSha256, batches }), batchPlanSha256 = hash(batchPlanBytes), batchDirectories = [];
  for (const batch of batches) {
    const directory = join(root, batch.id); await mkdir(directory, { mode: 0o700 }); batchDirectories.push(directory);
    for (const [path, bytes] of [['original/catalog-pointer.json', pointer], ['core/catalog-pointer.json', pointer],
      ['original/catalog-snapshot.json', snapshot], ['core/catalog-snapshot.json', snapshot]]) await put(directory, path, bytes);
    const receipts = [];
    for (const id of batch.componentIds) {
      const { raw, payload, manifest } = bodies.get(id);
      await put(directory, `original/components/${id}/component.json`, raw);
      if (core(id)) await put(directory, `core/components/${id}/manifest.json`, raw);
      for (const [path, bytes] of payload) {
        await put(directory, `original/components/${id}/payload/${path}`, bytes);
        if (core(id)) await put(directory, `core/components/${id}/payload/${path}`, bytes);
      }
      receipts.push({ componentId: id, manifestSha256: hash(raw), inventorySha256: manifest.inventorySha256,
        objectCount: payload.size, bytes: [...payload.values()].reduce((sum, bytes) => sum + bytes.length, 0) });
    }
    await put(directory, 'batch-receipt.json', json({ schemaVersion: 1, kind: 'weatherx-train3-original-baseline-batch-v1',
      catalogId: CATALOG, reviewedPlanSha256: planSha256, reviewedBatchPlanSha256: batchPlanSha256, batchId: batch.id,
      catalogSha256: hash(snapshot), sourceSha: SOURCE, runId: String(10 + batchDirectories.length), runAttempt: '1',
      completeBaselineEligible: false, coreSealSha256: null, components: receipts,
      scientificValidationPerformed: false, publicationAuthorized: false }));
    await put(directory, 'acquisition-receipt.json', json({ operation: 'batch-export', catalogId: CATALOG, sourceSha: SOURCE,
      batchId: batch.id, reviewedPlanSha256: planSha256, reviewedBatchPlanSha256: batchPlanSha256,
      requests: batch.payloadObjects + batch.componentIds.length + 3,
      wireBytes: batch.payloadBytes + pointer.length * 2 + snapshot.length
        + batch.componentIds.reduce((sum, id) => sum + bodies.get(id).raw.length, 0), publicationAuthorized: false }));
  }
  return { root, bodies, pointer, snapshot, planBytes, planSha256, batchPlanBytes, batchPlanSha256, batchDirectories,
    destination: join(root, 'joined'), expectedSourceSha: SOURCE };
}

export async function useFixture(action, options) {
  const f = await fixture(options);
  try { await action(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}
async function refused(f, options) {
  await assert.rejects(joinBaseline(f, options));
  assert.ok((await readdir(f.root)).every(name => !name.startsWith('.train3-baseline-join-')));
  await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
}

// Shared synthetic builder imports do not register this suite twice.
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
test('three batches join exact original bytes and only then produce the complete eight-component core seal', async () => {
  await useFixture(async f => {
    f.batchDirectories.reverse();
    const receipt = await joinBaseline(f);
    assert.equal(receipt.kind, 'weatherx-train3-original-baseline-join-v1');
    assert.equal(receipt.components.length, 22); assert.equal(receipt.batches.length, 3);
    assert.equal(receipt.publicationAuthorized, false); assert.equal(receipt.scientificValidationPerformed, false);
    const sealBytes = await readFile(join(f.destination, 'core/seal.json')), seal = JSON.parse(sealBytes);
    assert.equal(receipt.coreSealSha256, hash(sealBytes)); assert.equal(seal.kind, 'weatherx-validation-catalog-baseline-v1');
    assert.equal(seal.files.length, 26); assert.deepEqual(seal.files.map(row => row.path), seal.files.map(row => row.path).sort());
    for (const row of seal.files) {
      const path = join(f.destination, 'core', row.path), bytes = await readFile(path), info = await lstat(path);
      assert.equal(info.nlink, 1); assert.equal(info.mode & 0o777, 0o600);
      assert.equal(row.size, bytes.length); assert.equal(row.sha256, hash(bytes));
    }
    for (const [id, { raw, payload }] of f.bodies) {
      assert.deepEqual(await readFile(join(f.destination, `original/components/${id}/component.json`)), raw);
      for (const [path, bytes] of payload) assert.deepEqual(await readFile(join(f.destination, `original/components/${id}/payload/${path}`)), bytes);
    }
    assert.equal((await lstat(f.destination)).mode & 0o777, 0o700);
    assert.ok((await readdir(f.root)).every(name => !name.startsWith('.train3-baseline-join-')));
    for (const input of f.batchDirectories) await assert.rejects(lstat(join(input, 'core/seal.json')), { code: 'ENOENT' });
  });
});

for (const [name, mutation] of [
  ['mixed source', r => { r.sourceSha = 'c'.repeat(40); }],
  ['mixed catalog', r => { r.catalogId = 'other-catalog'; }],
  ['mixed inventory pin', r => { r.reviewedPlanSha256 = 'c'.repeat(64); }],
  ['mixed partition pin', r => { r.reviewedBatchPlanSha256 = 'c'.repeat(64); }],
  ['advertised partial seal', r => { r.coreSealSha256 = 'c'.repeat(64); }],
  ['partial advertised as complete', r => { r.completeBaselineEligible = true; }],
  ['science claim', r => { r.scientificValidationPerformed = true; }],
  ['unrecognized receipt field', r => { r.authorized = true; }],
  ['duplicate batch ID', r => { r.batchId = 'batch-1'; }],
  ['missing component receipt', r => { r.components.pop(); }],
  ['wrong component receipt', r => { r.components[0].inventorySha256 = 'c'.repeat(64); }],
]) test(name + ' refuses without complete output', async () => {
  await useFixture(async f => { await changeJson(f.batchDirectories[2], 'batch-receipt.json', mutation); await refused(f); });
});

for (const [name, path, transform] of [
  ['payload corruption', 'original/components/gfs/payload/A/1.txt', bytes => Buffer.from('x'.repeat(bytes.length))],
  ['core copy corruption', 'core/components/gfs/payload/A/1.txt', bytes => Buffer.from('x'.repeat(bytes.length))],
  ['manifest corruption', 'original/components/gfs/component.json', bytes => Buffer.from('x'.repeat(bytes.length))],
  ['core manifest corruption', 'core/components/gfs/manifest.json', bytes => Buffer.from('x'.repeat(bytes.length))],
  ['pointer corruption', 'original/catalog-pointer.json', bytes => Buffer.from('x'.repeat(bytes.length))],
  ['core snapshot corruption', 'core/catalog-snapshot.json', bytes => Buffer.from('x'.repeat(bytes.length))],
]) test(name + ' refuses', async () => {
  await useFixture(async f => { const root = f.batchDirectories[0]; await put(root, path, transform(await readFile(join(root, path)))); await refused(f); });
});

test('cross-batch GFS pair mismatch in the independently pinned full plan refuses', async () => {
  await useFixture(async f => { await refused(f); }, { pairMismatch: true });
});
test('missing batch and repeated directory refuse', async () => {
  await useFixture(async f => { const dirs = f.batchDirectories; f.batchDirectories = dirs.slice(0, 2); await refused(f);
    f.batchDirectories = [dirs[0], dirs[0], dirs[2]]; await refused(f); });
});
test('missing component payload refuses', async () => {
  await useFixture(async f => { await rm(join(f.batchDirectories[0], 'original/components/gfs/payload/z.txt')); await refused(f); });
});
test('extra file, empty directory, and a forbidden partial seal refuse', async () => {
  for (const extra of ['file', 'directory', 'seal']) await useFixture(async f => {
    if (extra === 'directory') await mkdir(join(f.batchDirectories[0], 'unexpected'));
    else await put(f.batchDirectories[0], extra === 'seal' ? 'core/seal.json' : 'unexpected.txt', Buffer.from('extra'));
    await refused(f);
  });
});
test('symlink file and artifact-root alias refuse', async () => {
  await useFixture(async f => {
    const path = join(f.batchDirectories[0], 'original/components/gfs/payload/z.txt');
    await rm(path); await symlink(join(f.batchDirectories[0], 'core/components/gfs/payload/z.txt'), path); await refused(f);
  });
  await useFixture(async f => { const alias = join(f.root, 'alias'); await symlink(f.batchDirectories[0], alias);
    f.batchDirectories[0] = alias; await refused(f); });
});
test('hardlinked payload refuses even with identical authentic bytes', async () => {
  await useFixture(async f => { const path = join(f.batchDirectories[0], 'original/components/gfs/payload/z.txt');
    await link(path, join(f.root, 'outside-hardlink')); await refused(f); });
});
test('FIFO payload refuses without opening it', async () => {
  await useFixture(async f => { const path = join(f.batchDirectories[0], 'original/components/gfs/payload/z.txt');
    await rm(path); const result = spawnSync('mkfifo', [path]); assert.equal(result.status, 0); await refused(f); });
});
test('existing destination is never overwritten or cleaned', async () => {
  await useFixture(async f => { await mkdir(f.destination); await put(f.destination, 'keep.txt', Buffer.from('keep'));
    await assert.rejects(joinBaseline(f), { code: 'EEXIST' });
    assert.equal(await readFile(join(f.destination, 'keep.txt'), 'utf8'), 'keep');
  });
});
test('destination overlapping an input refuses', async () => {
  await useFixture(async f => { f.destination = join(f.batchDirectories[0], 'joined'); await refused(f); });
});
test('capacity admission and reserve exhaustion refuse with owned scratch cleanup', async () => {
  await useFixture(async f => { await refused(f, { disk: async () => ({ bavail: 0, bsize: 1 }) }); });
  await useFixture(async f => { let reads = 0; await refused(f, { disk: async () => ++reads === 1
    ? ampleDisk() : ({ bavail: 0, bsize: 1 }) }); });
});
test('authenticated allocation rounds blocks and accounts for original/core copies, metadata and bounded receipts', async () => {
  await useFixture(async f => {
    const capacity = baselineCapacity({ ...f, blockSize: 4096 });
    assert.ok(Object.isFrozen(capacity) && Object.isFrozen(capacity.decoded));
    assert.equal(capacity.reserveBytes, 1024 ** 3);
    assert.equal(capacity.joinAdditionalBytes, capacity.joined.allocationBytes + capacity.joinScratchBytes + capacity.reserveBytes);
    assert.equal(capacity.decryptAdditionalBytes, capacity.decodedAllocationBytes + capacity.joinAdditionalBytes + capacity.decryptScratchBytes);
    assert.equal(capacity.joined.fileCount, 96); // 44 original + 16 core payloads, 30 manifests, 4 catalogs, seal and receipt.
    assert.ok(capacity.joined.rawBytes >= 17 * 1024 ** 2);
    assert.ok(capacity.decoded.every(row => row.rawBytes >= 2 * 1024 ** 2));
    const small = allocationEstimate(new Map([['a/b', 4097], ['z', 0]]), 4096);
    assert.equal(small.dataBytes, 8192); assert.equal(small.fileMetadataBytes, 8192);
    assert.equal(small.directoryCount, 2); assert.ok(small.directoryBytes >= 6 * 4096);
    assert.throws(() => baselineCapacity({ ...f, planSha256: '0'.repeat(64), blockSize: 4096 }));
    for (const size of [0, -1, NaN, 1.5, 2 ** 21]) assert.throws(() => baselineCapacity({ ...f, blockSize: size }));
  });
});
test('join admits exactly additional output plus reserve on a declining filesystem and refuses one block below', async () => {
  await useFixture(async f => {
    const capacity = baselineCapacity({ ...f, blockSize: 4096 });
    const meter = await meteredDisk(f.root, capacity.joinAdditionalBytes);
    await joinBaseline(f, { disk: meter.disk });
    assert.ok(meter.stats().polls > 100); assert.ok(meter.stats().minimumFreeBytes >= capacity.reserveBytes);
    assert.ok((await readdir(f.root)).every(name => !name.startsWith('.train3-baseline-join-')));
  });
  await useFixture(async f => {
    const capacity = baselineCapacity({ ...f, blockSize: 4096 }), before = await readdir(f.root);
    await refused(f, { disk: async () => ({ bsize: 4096, bavail: (capacity.joinAdditionalBytes - 4096) / 4096 }) });
    assert.deepEqual(await readdir(f.root), before);
  });
});
test('cancellation while writing and elapsed deadline withhold seal and clean only owned output', async () => {
  await useFixture(async f => { const controller = new AbortController(); let reads = 0;
    await refused(f, { signal: controller.signal, disk: async () => { if (++reads === 3) controller.abort(); return ampleDisk(); } }); });
  await useFixture(async f => { let reads = 0; await refused(f, { disk: ampleDisk, now: () => ++reads < 5 ? 0 : 43 * 60_000 }); });
});
test('acquisition receipt source, caps and unknown fields are checked', async () => {
  for (const change of [r => { r.sourceSha = 'c'.repeat(40); }, r => { r.requests = 25_101; },
    r => { r.wireBytes = 3 * 1024 ** 3; }, r => { r.extra = true; }]) await useFixture(async f => {
    await changeJson(f.batchDirectories[0], 'acquisition-receipt.json', change); await refused(f);
  });
});
test('wrong externally supplied full-plan or partition digest refuses before output', async () => {
  await useFixture(async f => { f.planSha256 = 'd'.repeat(64); await refused(f); });
  await useFixture(async f => { f.batchPlanSha256 = 'd'.repeat(64); await refused(f); });
});
test('joined tool has no reader, subprocess, provider, or credential interface', async () => {
  const source = await readFile(new URL('../tools/train3-baseline-join.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /SHARED_R2|readClient|child_process|fetch\(|https:\/\//);
  assert.match(source, /locally quiescent/);
});

test('receipt replacement between its first read and tree capture refuses', async () => {
  await useFixture(async f => {
    let changed = false;
    await assert.rejects(joinBaseline(f, { inputRead: async (...args) => {
      const result = await readRegular(...args);
      if (!changed && args[1] === 'batch-receipt.json') {
        changed = true; await changeJson(args[0], args[1], r => { r.runAttempt = '2'; });
      }
      return result;
    } }), /receipt-changed-before-tree-audit/);
    await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  });
});

test('cancellation during post-publication finalization removes the owned complete destination', async () => {
  await useFixture(async f => {
    const controller = new AbortController(); let queued = false;
    await assert.rejects(joinBaseline(f, { signal: controller.signal, now: () => {
      if (!queued && existsSync(join(f.destination, 'core/seal.json'))) {
        queued = true; queueMicrotask(() => controller.abort());
      }
      return 0;
    } }), /interrupted-or-deadline/);
    assert.equal(queued, true); await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
    assert.ok((await readdir(f.root)).every(name => !name.startsWith('.train3-baseline-join-')));
  });
});

test('read-only batch capability freezes exact files, stats, receipts and metadata copies', async () => {
  await useFixture(async f => {
    const verified = await verifyBatch({ ...f, batchDirectory: f.batchDirectories[0] });
    assert.equal(isVerifiedBatch(verified), true); assert.equal(isVerifiedBatch({ ...verified }), false);
    assert.ok(Object.isFrozen(verified) && Object.isFrozen(verified.files) && Object.isFrozen(verified.files[0].info));
    assert.throws(() => { verified.files[0].sha256 = 'c'.repeat(64); }, TypeError);
    assert.throws(() => { verified.receipt.sourceSha = 'c'.repeat(40); }, TypeError);
    const pointer = verified.reviewed.pointer; pointer.fill(0); assert.deepEqual(verified.reviewed.pointer, f.pointer);
    const alternate = await verifyBatch({ ...f, batchDirectory: f.batchDirectories[0] }, { inputRead: (...args) => readRegular(...args) });
    assert.equal(isVerifiedBatch(alternate), false);
  });
});
test('successful one-attempt acquisition counters must match exact selected bodies and requests', async () => {
  for (const field of ['requests', 'wireBytes']) await useFixture(async f => {
    await changeJson(f.batchDirectories[0], 'acquisition-receipt.json', r => { r[field]--; });
    await refused(f);
  });
});

}
