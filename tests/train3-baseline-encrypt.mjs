import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { batchPlan, COMPONENTS, DATA, exportBatch, hash, IDS, inventory, producerOrder } from '../tools/train3-baseline-preparation.mjs';
import { verifyBatch } from '../tools/train3-baseline-join.mjs';
import { ENCRYPTION_LIMITS, encryptBatch, isVerifiedAgeToolchain, prepareAgeToolchain,
  validateArchivePlan, validateRecipient, verifyAgeToolchain } from '../tools/train3-baseline-encrypt.mjs';

const execute = promisify(execFile), SOURCE = 'a'.repeat(40), CATALOG = 'synthetic-fixture';
const encoded = value => Buffer.from(JSON.stringify(value) + '\n');
const marker = 'SYNTHETIC-ONLY-PRIVATE-FIXTURE-MARKER';
const provided = { ageBinary: process.env.TRAIN3_AGE_BINARY, ageKeygenBinary: process.env.TRAIN3_AGE_KEYGEN_BINARY,
  distributionArchive: process.env.TRAIN3_AGE_DISTRIBUTION_ARCHIVE };
const available = Object.values(provided).every(value => typeof value === 'string' && value.length > 0);
const native = { skip: !available && 'Explicit verified public age tool paths required; no auto-download or lookup' };
const childEnv = root => ({ PATH: '/nonexistent', HOME: root, TMPDIR: root, LANG: 'C', GOMEMLIMIT: '128MiB' });
const temporary = async prefix => realpath(await mkdtemp(join(tmpdir(), prefix)));

async function fixture(root) {
  const objects = new Map(), lists = new Map(), components = {}; let requests = 0, wireBytes = 0;
  for (const id of IDS) {
    const prefix = `components/${id}/fixture-${id}/`, payload = new Map([
      ['A/one.txt', Buffer.from(`${marker} ${id}`)], ['z.txt', Buffer.from(`original ${id}`)],
    ]);
    const rows = [...payload].map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) })).sort(producerOrder);
    const manifest = { schemaVersion: 1, componentId: id, artifactId: `fixture-${id}`, rootPrefix: prefix,
      generationTime: '2026-10-03T00:00:00Z', completedAt: '2026-10-03T01:00:00Z',
      mounts: [id.startsWith('point-') ? `point-series/v2/${id.slice(6)}/` : `data/${id}/`],
      objectCount: rows.length, inventorySha256: hash(JSON.stringify(rows)), quality: { status: 'passed', checks: [] },
      ...(id.startsWith('point-') ? { pointSeries: { modelId: id.slice(6), descriptor: {
        initializedAt: '2026-10-03T00:00:00Z', runId: '2026100300' } } } : {}) };
    const raw = encoded(manifest), manifestKey = prefix + 'component.json';
    components[id] = { ...manifest, manifestKey, manifestSha256: hash(raw) };
    objects.set(`${COMPONENTS}/${manifestKey}`, raw);
    for (const [path, bytes] of payload) objects.set(`${COMPONENTS}/${prefix}${path}`, bytes);
    lists.set(prefix, [{ Key: manifestKey, Size: raw.length }, ...[...payload].map(([path, bytes]) => ({ Key: prefix + path, Size: bytes.length }))]);
  }
  const snapshot = encoded({ schemaVersion: 2, sequence: 1, createdAt: '2026-10-03T02:00:00Z', parentCatalogId: null, components });
  const pointer = encoded({ schemaVersion: 2, catalogId: CATALOG, sequence: 1, publishedAt: '2026-10-03T02:00:00Z',
    previousCatalogId: null, catalogSha256: hash(snapshot) });
  objects.set(`${DATA}/catalogs/current.json`, pointer); objects.set(`${DATA}/catalogs/snapshots/${CATALOG}.json`, snapshot);
  const client = {
    async get(bucket, key, cap) { const bytes = objects.get(`${bucket}/${key}`); assert.ok(bytes && bytes.length <= cap);
      requests++; wireBytes += bytes.length; return bytes; },
    async list(prefix) { requests++; return { IsTruncated: false, Contents: lists.get(prefix) }; },
    close() {}, stats() { return { requests, wireBytes }; },
  };
  const plan = await inventory(client, CATALOG, SOURCE), planBytes = encoded(plan), planSha256 = hash(planBytes);
  const groups = [IDS.slice(0, 8), IDS.slice(8, 15), IDS.slice(15)];
  const batches = { schemaVersion: 1, kind: 'weatherx-train3-baseline-batches-v1', catalogId: CATALOG,
    reviewedInventorySha256: planSha256, batches: groups.map((ids, i) => {
      const items = ids.map(id => plan.components.find(item => item.id === id));
      return { id: `batch-${i + 1}`, componentIds: ids, payloadObjects: items.reduce((n, c) => n + c.objects.length, 0),
        payloadBytes: items.reduce((n, c) => n + c.objects.reduce((sum, row) => sum + row.bytes, 0), 0) };
    }) };
  const batchPlanBytes = encoded(batches), batchPlanSha256 = hash(batchPlanBytes);
  const reviewed = batchPlan(planBytes, planSha256, batchPlanBytes, batchPlanSha256, 'batch-1', CATALOG);
  requests = 0; wireBytes = 0;
  const batchDirectory = join(root, 'batch'); await mkdir(batchDirectory, { mode: 0o700 });
  const receipt = await exportBatch(client, reviewed, batchDirectory, { sourceSha: SOURCE, runId: '1', runAttempt: '1' });
  await writeFile(join(batchDirectory, 'batch-receipt.json'), encoded(receipt), { mode: 0o600 });
  await writeFile(join(batchDirectory, 'acquisition-receipt.json'), encoded({ operation: 'batch-export', catalogId: CATALOG,
    sourceSha: SOURCE, batchId: reviewed.batchId, reviewedPlanSha256: planSha256,
    reviewedBatchPlanSha256: batchPlanSha256, ...client.stats(), publicationAuthorized: false }), { mode: 0o600 });
  const verifiedBatch = await verifyBatch({ planBytes, planSha256, batchPlanBytes, batchPlanSha256, batchDirectory, expectedSourceSha: SOURCE });
  return { verifiedBatch, batchDirectory, reviewed };
}
async function toolsAndRecipient(root) {
  const toolchain = await verifyAgeToolchain(provided), identity = join(root, 'synthetic-identity.txt');
  await execute(toolchain.ageKeygenBinary, ['-o', identity], { cwd: root, env: childEnv(root), timeout: 10_000, maxBuffer: 4096 });
  const { stdout } = await execute(toolchain.ageKeygenBinary, ['-y', identity], { cwd: root, env: childEnv(root), timeout: 10_000, maxBuffer: 4096 });
  const publicRecipient = stdout.trim(), config = { ownerConfirmed: true, recipientId: 'synthetic-only', expectedRecipientId: 'synthetic-only',
    recipient: publicRecipient, expectedRecipient: publicRecipient, expectedRecipientSha256: hash(Buffer.from(publicRecipient)), toolchain };
  return { toolchain, identity, config, recipient: await validateRecipient(config) };
}
function tarFiles(bytes) {
  const files = new Map(); let offset = 0;
  while (!bytes.subarray(offset, offset + 512).every(byte => byte === 0)) {
    const h = bytes.subarray(offset, offset + 512), text = (start, n) => h.subarray(start, start + n).toString().split('\0')[0];
    const path = text(345, 155) ? `${text(345, 155)}/${text(0, 100)}` : text(0, 100), size = Number.parseInt(text(124, 12), 8);
    assert.equal(h[156], 48); assert.equal(text(257, 6), 'ustar');
    files.set(path, bytes.subarray(offset + 512, offset + 512 + size)); offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(bytes.length - offset, 1024); assert.ok(bytes.subarray(offset).every(byte => byte === 0)); return files;
}

test('owner confirmation and recipient identity/hash gate precede any tool or source access', async () => {
  for (const config of [{}, { ownerConfirmed: false }, { ownerConfirmed: true, recipientId: 'a', expectedRecipientId: 'b' }])
    await assert.rejects(validateRecipient(config), /owner-recipient-confirmation/);
  await assert.rejects(validateRecipient({ ownerConfirmed: true, recipientId: 'fixture', expectedRecipientId: 'fixture',
    recipient: 'ssh-ed25519 forbidden', expectedRecipient: 'ssh-ed25519 forbidden', expectedRecipientSha256: 'a'.repeat(64) }), /owner-recipient-pin/);
  await assert.rejects(encryptBatch({ verifiedBatch: {}, recipient: {}, toolchain: {}, destination: '/private/tmp/not-created' }), /unverified-encryption-input/);
});
test('archive metadata admission rejects unsupported paths, file counts and expanded bytes before reader construction', () => {
  const prefix = 'components/gfs/fixture/', reviewed = { pointer: Buffer.from('pointer'), snapshot: Buffer.from('snapshot'),
    selectedComponents: [{ id: 'gfs', manifestBase64: encoded({ rootPrefix: prefix }).toString('base64'),
      objects: [{ key: prefix + 'tiny.txt', bytes: 7 }] }] };
  const capacity = validateArchivePlan(reviewed);
  assert.equal(capacity.archiveFileCount, 10); assert.equal(capacity.copiedPayloadBytes, 14);
  assert.ok(capacity.metadataAllowanceBytes >= 2 * 1024 ** 2);
  assert.equal(capacity.ciphertextMaximumBytes - capacity.archiveMaximumBytes, 4 * 1024 ** 2);
  assert.equal(capacity.minimumFreeBytes - capacity.ciphertextMaximumBytes, ENCRYPTION_LIMITS.reserve);
  const selection = objects => ({ ...reviewed, selectedComponents: [{ ...reviewed.selectedComponents[0], objects }] });
  assert.throws(() => validateArchivePlan(selection([{ key: prefix + 'x'.repeat(101), bytes: 1 }])), /ustar-path/);
  assert.throws(() => validateArchivePlan(selection([{ key: prefix + 'large', bytes: 3 * 1024 ** 3 }])), /archive-byte-limit/);
  assert.throws(() => validateArchivePlan(selection(Array.from({ length: 25_047 }, (_, i) => ({ key: prefix + i, bytes: 0 })))), /archive-file-count/);
});
test('exact official archive and both executable closure pins are verified before invocation', native, async () => {
  const root = await temporary('train3-age-pins-');
  try {
    const toolchain = await verifyAgeToolchain(provided); assert.equal(isVerifiedAgeToolchain(toolchain), true); assert.equal(toolchain.ageVersion, 'v1.3.2');
    const wrongArchive = join(root, 'wrong.tar.gz'); await writeFile(wrongArchive, 'not an official tool archive');
    await assert.rejects(verifyAgeToolchain({ ...provided, distributionArchive: wrongArchive }), /age-distribution-hash/);
    const wrongBinary = join(root, 'wrong-age'); await writeFile(wrongBinary, 'not an official binary');
    await assert.rejects(verifyAgeToolchain({ ...provided, ageBinary: wrongBinary }), /age-binary-hash/);
    assert.equal(isVerifiedAgeToolchain({ ...toolchain }), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('public tool setup extracts only pinned executables and archive with no retry and no partial destination', native, async () => {
  const root = await temporary('train3-age-setup-');
  try {
    const archive = await readFile(provided.distributionArchive); let calls = 0;
    const installed = await prepareAgeToolchain({ destination: join(root, 'tools') }, { async *fetcher() { calls++; yield archive; } });
    assert.equal(calls, 1); assert.deepEqual((await readdir(join(root, 'tools'))).sort(), ['age', 'age-keygen', 'distribution.tar.gz']);
    assert.equal(isVerifiedAgeToolchain(installed), true);
    await assert.rejects(prepareAgeToolchain({ destination: join(root, 'tools') }), { code: 'EEXIST' });
    assert.equal((await readdir(join(root, 'tools'))).length, 3);
    for (const payload of [Buffer.from('wrong'), Buffer.alloc(32 * 1024 ** 2 + 1)]) {
      const destination = join(root, 'refused');
      await assert.rejects(prepareAgeToolchain({ destination }, { async *fetcher() { calls++; yield payload; } }));
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('real age roundtrip encrypts all path/receipt metadata, binds original source/plans, and rejects tampering', native, async () => {
  const root = await temporary('train3-age-roundtrip-');
  try {
    const { verifiedBatch } = await fixture(root), { toolchain, recipient, identity } = await toolsAndRecipient(root);
    const capacity = validateArchivePlan(verifiedBatch.reviewed);
    const destination = join(root, 'upload');
    const cleanup = [];
    const receipt = await encryptBatch({ verifiedBatch, toolchain, recipient, destination }, { onCleanup(status) { cleanup.push(status); } });
    assert.deepEqual(cleanup, ['passed']);
    assert.deepEqual((await readdir(destination)).sort(), ['batch.age', 'encrypted-receipt.json']);
    const ciphertext = await readFile(join(destination, 'batch.age')); assert.equal(hash(ciphertext), receipt.ciphertextSha256);
    assert.equal(ciphertext.length, receipt.ciphertextBytes);
    for (const path of ['batch.age', 'encrypted-receipt.json']) {
      const bytes = await readFile(join(destination, path));
      for (const sensitive of [marker, CATALOG, SOURCE, 'batch-1', 'original/components', root]) assert.equal(bytes.includes(Buffer.from(sensitive)), false);
    }
    const { stdout } = await execute(toolchain.ageBinary, ['--decrypt', '-i', identity, join(destination, 'batch.age')], {
      cwd: root, env: childEnv(root), timeout: 10_000, maxBuffer: 4 * 1024 ** 2, encoding: 'buffer' });
    const files = tarFiles(stdout); assert.deepEqual([...files.keys()], verifiedBatch.files.map(f => f.path));
    assert.ok(stdout.length <= capacity.archiveMaximumBytes); assert.ok(ciphertext.length <= capacity.ciphertextMaximumBytes);
    assert.equal(files.size, capacity.archiveFileCount);
    for (const file of verifiedBatch.files) assert.deepEqual(files.get(file.path), await readFile(join(verifiedBatch.root, file.path)));
    const bound = JSON.parse(files.get('acquisition-receipt.json')); assert.equal(bound.sourceSha, SOURCE);
    assert.equal(bound.reviewedPlanSha256, verifiedBatch.reviewed.reviewedPlanSha256);
    assert.equal(bound.reviewedBatchPlanSha256, verifiedBatch.reviewed.reviewedBatchPlanSha256);
    ciphertext[ciphertext.length - 1] ^= 1; await writeFile(join(root, 'tampered.age'), ciphertext);
    await assert.rejects(execute(toolchain.ageBinary, ['--decrypt', '-i', identity, join(root, 'tampered.age')], {
      cwd: root, env: childEnv(root), timeout: 10_000, maxBuffer: 4 * 1024 ** 2 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('recipient checksum, expected recipient/hash mismatch and absent owner confirmation refuse real-tool encryption', native, async () => {
  const root = await temporary('train3-age-recipient-');
  try {
    const { config } = await toolsAndRecipient(root);
    for (const change of [{ ownerConfirmed: false }, { expectedRecipientId: 'other' }, { expectedRecipient: config.recipient + 'x' },
      { expectedRecipientSha256: 'b'.repeat(64) }]) await assert.rejects(validateRecipient({ ...config, ...change }));
    const bad = config.recipient.slice(0, -1) + (config.recipient.endsWith('q') ? 'p' : 'q');
    await assert.rejects(validateRecipient({ ...config, recipient: bad, expectedRecipient: bad,
      expectedRecipientSha256: hash(Buffer.from(bad)) }), /recipient-validation-failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('ciphertext bounds, disk admission, cancellation and changed verified inputs remove only owned output', native, async () => {
  for (const scenario of ['ciphertext', 'disk', 'abort', 'active-abort', 'deadline', 'changed', 'final-abort', 'post-complete-abort', 'post-complete-falsy']) {
    const root = await temporary('train3-age-refusal-');
    try {
      const { verifiedBatch } = await fixture(root), { toolchain, recipient } = await toolsAndRecipient(root);
      const destination = join(root, 'upload'), abort = new AbortController(); let calls = 0;
      if (scenario === 'abort') abort.abort();
      if (scenario === 'changed') await writeFile(join(verifiedBatch.root, verifiedBatch.files[0].path), 'changed');
      const options = scenario === 'ciphertext' ? { maximumCiphertextBytes: 1 } : {};
      if (scenario === 'deadline') options.milliseconds = 1;
      if (scenario === 'disk') options.disk = async () => ({ bavail: 0, bsize: 1 });
      if (scenario === 'final-abort') options.disk = async () => {
        calls++;
        if (await lstat(join(destination, 'batch.age')).catch(() => null)) abort.abort();
        return { bavail: 20 * 1024 ** 3, bsize: 1 };
      };
      if (scenario.startsWith('post-complete-')) options.disk = async () => {
        if (await lstat(join(destination, 'batch.age')).catch(() => null)) {
          if (++calls === 2) {
            if (scenario === 'post-complete-falsy') throw 0;
            abort.abort();
          }
        }
        return { bavail: 20 * 1024 ** 3, bsize: 1 };
      };
      if (scenario === 'active-abort') options.disk = async () => {
        if (++calls === 7) abort.abort();
        return { bavail: 20 * 1024 ** 3, bsize: 1 };
      };
      const result = encryptBatch({ verifiedBatch, toolchain, recipient, destination, signal: abort.signal }, options);
      if (scenario === 'post-complete-falsy') {
        let rejected = false; try { await result; } catch (error) { rejected = true; assert.equal(error, 0); }
        assert.equal(rejected, true);
      } else await assert.rejects(result);
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
      assert.equal((await readdir(root)).some(name => name.startsWith('.train3-ciphertext-')), false);
      assert.ok(await lstat(verifiedBatch.root));
      await new Promise(resolve => setTimeout(resolve, 15));
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
test('primary failure and crypto cleanup residue are independently reported, including falsy errors and failing callbacks', native, async () => {
  for (const primary of ['ciphertext-bound', 0]) {
    const root = await temporary('train3-age-cleanup-failure-');
    try {
      const { verifiedBatch } = await fixture(root), { toolchain, recipient } = await toolsAndRecipient(root);
      const destination = join(root, 'upload'), status = [], removals = [];
      const options = {
        onCleanup(value) { status.push(value); throw new Error('synthetic-diagnostics-failure'); },
        async removeOwnedPath(path, info) {
          if (!info) return;
          removals.push(path);
          if (path.includes('.train3-ciphertext-')) throw 0;
          const current = await lstat(path, { bigint: true });
          assert.equal(current.dev, info.dev); assert.equal(current.ino, info.ino);
          await rm(path, { recursive: true, force: true });
        },
      };
      if (primary === 'ciphertext-bound') options.maximumCiphertextBytes = 1;
      else options.disk = async () => {
        for (const name of await readdir(root)) {
          if (name.startsWith('.train3-ciphertext-')) {
            const file = await lstat(join(root, name, 'batch.age')).catch(() => null);
            if (file?.size > 0) throw 0;
          }
        }
        return { bavail: 20 * 1024 ** 3, bsize: 1 };
      };
      let rejected = false;
      try { await encryptBatch({ verifiedBatch, toolchain, recipient, destination }, options); }
      catch (error) {
        rejected = true;
        if (primary === 0) assert.equal(error, 0); else assert.match(error.message, /ciphertext-byte-limit/);
      }
      assert.equal(rejected, true); assert.deepEqual(status, ['failed']);
      assert.equal(removals.length, 2); assert.equal(removals[1], destination);
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
      const residue = (await readdir(root)).filter(name => name.startsWith('.train3-ciphertext-'));
      assert.equal(residue.length, 1); assert.ok(await lstat(join(root, residue[0])));
      if (primary === 0) assert.ok((await lstat(join(root, residue[0], 'batch.age'))).size > 0);
      await new Promise(resolve => setTimeout(resolve, 15));
      assert.deepEqual((await readdir(root)).filter(name => name.startsWith('.train3-ciphertext-')), residue);
      assert.ok(await lstat(verifiedBatch.root));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});
test('existing destinations and nested output never overwrite or remove unrelated files', native, async () => {
  const root = await temporary('train3-age-existing-');
  try {
    const { verifiedBatch } = await fixture(root), { toolchain, recipient } = await toolsAndRecipient(root);
    const destination = join(root, 'sentinel'); await mkdir(destination); await writeFile(join(destination, 'keep'), 'unrelated');
    await assert.rejects(encryptBatch({ verifiedBatch, toolchain, recipient, destination }), /existing-destination/);
    assert.equal(await readFile(join(destination, 'keep'), 'utf8'), 'unrelated');
    await assert.rejects(encryptBatch({ verifiedBatch, toolchain, recipient, destination: join(verifiedBatch.root, 'output') }), /overlapping-destination/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
