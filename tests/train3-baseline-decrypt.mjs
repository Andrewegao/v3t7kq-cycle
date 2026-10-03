import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { fixture, useFixture, meteredDisk } from './train3-baseline-join.mjs';
import { childStream, decryptAndJoin, decryptFailureDiagnostic, extractUstar } from '../tools/train3-baseline-decrypt.mjs';
import { baselineCapacity, verifyBatch, isVerifiedBatch } from '../tools/train3-baseline-join.mjs';
import { verifyAgeToolchain, validateRecipient, encryptBatch } from '../tools/train3-baseline-encrypt.mjs';
import { hash } from '../tools/train3-baseline-preparation.mjs';

// The owning preparation step supplies a verified public tool directory. Tests
// never download tools, install software, or use an owner's private identity.
const toolRoot = process.env.TRAIN3_TEST_AGE_TOOL_ROOT;
const paths = [process.env.TRAIN3_AGE_BINARY, process.env.TRAIN3_AGE_KEYGEN_BINARY, process.env.TRAIN3_AGE_DISTRIBUTION_ARCHIVE];
const toolConfig = paths.every(Boolean) ? { ageBinary: paths[0], ageKeygenBinary: paths[1], distributionArchive: paths[2] }
  : paths.some(Boolean) ? null : toolRoot && { ageBinary: join(toolRoot, 'age'), ageKeygenBinary: join(toolRoot, 'age-keygen'),
    distributionArchive: join(toolRoot, 'distribution.tar.gz') };
let toolPromise;
const tools = () => { assert.ok(toolConfig, 'All three prepared age-tool paths or a local fixture root are required');
  return toolPromise ??= verifyAgeToolchain(toolConfig); };
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const ample = async () => ({ bavail: 10 ** 12, bsize: 1 });

function tarHeader(path, size, type = '0') {
  const block = Buffer.alloc(512); let name = path, prefix = '';
  if (Buffer.byteLength(path) > 100) { const split = path.lastIndexOf('/'); prefix = path.slice(0, split); name = path.slice(split + 1); }
  block.write(name, 0, 100); block.write(prefix, 345, 155);
  const octal = (value, start, length) => block.write(value.toString(8).padStart(length - 1, '0') + '\0', start, length);
  octal(0o600, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(0, 136, 12);
  block.fill(32, 148, 156); block.write(type, 156, 1); block.write('ustar\0', 257, 6); block.write('00', 263, 2);
  block.write(block.reduce((n, byte) => n + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8); return block;
}
function archive(entries) {
  return Buffer.concat([...entries.flatMap(e => [tarHeader(e.path, e.bytes.length, e.type), e.bytes,
    Buffer.alloc((512 - e.bytes.length % 512) % 512)]), Buffer.alloc(1024)]);
}
async function entriesFor(f, batch = 0) {
  const verified = await verifyBatch({ ...f, batchDirectory: f.batchDirectories[batch] });
  assert.equal(isVerifiedBatch(verified), true); assert.ok(Object.isFrozen(verified.files));
  return Promise.all(verified.files.map(async row => ({ path: row.path, bytes: await readFile(join(verified.root, row.path)) })));
}
async function extract(f, bytes, options) {
  const destination = join(f.root, 'extract'); await mkdir(destination, { mode: 0o700 });
  return extractUstar(Readable.from([bytes]), { ...f, destination, maximumArchiveBytes: 16 * 1024 ** 2 }, options);
}
async function generateIdentity(f, tool, name = 'synthetic.key') {
  const path = join(f.root, name), result = spawnSync(tool.ageKeygenBinary, ['-o', path], {
    env: { LANG: 'C' }, cwd: f.root, maxBuffer: 4096 });
  assert.equal(result.status, 0, 'synthetic standard-tool key generation must succeed');
  const publicResult = spawnSync(tool.ageKeygenBinary, ['-y', path], { env: { LANG: 'C' }, cwd: f.root, maxBuffer: 4096 });
  assert.equal(publicResult.status, 0); return { path, recipient: publicResult.stdout.toString('ascii').trim() };
}
async function encryptedFixture(historical = false) {
  const f = await fixture({ historical });
  try {
    const toolchain = await tools(), identity = await generateIdentity(f, toolchain);
    const recipient = await validateRecipient({ ownerConfirmed: true, recipientId: 'synthetic-fixture',
      expectedRecipientId: 'synthetic-fixture', recipient: identity.recipient, expectedRecipient: identity.recipient,
      expectedRecipientSha256: hash(Buffer.from(identity.recipient)), toolchain });
    const encryptedBatches = [];
    for (let i = 0; i < 3; i++) {
      const verifiedBatch = await verifyBatch({ ...f, batchDirectory: f.batchDirectories[i] });
      const destination = join(f.root, `encrypted-${i}`);
      await encryptBatch({ verifiedBatch, recipient, toolchain, destination });
      const receiptBytes = await readFile(join(destination, 'encrypted-receipt.json')), receipt = JSON.parse(receiptBytes);
      encryptedBatches.push({ ciphertextPath: join(destination, 'batch.age'), ciphertextSha256: receipt.ciphertextSha256,
        ciphertextBytes: receipt.ciphertextBytes, receiptBytes, receiptSha256: hash(receiptBytes) });
    }
    return { ...f, identityFile: identity.path, recipient: identity.recipient, toolchain: toolConfig, encryptedBatches };
  } catch (error) { await rm(f.root, { recursive: true, force: true }); throw error; }
}
async function useEncrypted(action, historical = false) {
  const f = await encryptedFixture(historical);
  try { await action(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}
async function refuses(f, options) {
  await assert.rejects(decryptAndJoin(f, options));
  await assert.rejects(lstat(f.destination), { code: 'ENOENT' });
  assert.ok((await readdir(f.root)).every(name => !name.startsWith('.train3-baseline-decrypt-')));
}
async function replaceWithEncryptedBytes(f, plaintext) {
  const tool = await tools(), encrypted = spawnSync(tool.ageBinary, ['--encrypt', '--recipient', f.recipient], {
    input: plaintext, env: { LANG: 'C' }, cwd: f.root, maxBuffer: 16 * 1024 ** 2 });
  assert.equal(encrypted.status, 0, 'standard tool must encrypt the synthetic adversarial archive');
  const item = f.encryptedBatches[0], receipt = JSON.parse(item.receiptBytes);
  await writeFile(item.ciphertextPath, encrypted.stdout);
  item.ciphertextSha256 = receipt.ciphertextSha256 = hash(encrypted.stdout);
  item.ciphertextBytes = receipt.ciphertextBytes = encrypted.stdout.length;
  item.receiptBytes = json(receipt); item.receiptSha256 = hash(item.receiptBytes);
}

test('bounded USTAR extractor accepts exactly one original batch without a plaintext archive file', async () => {
  await useFixture(async f => { const entries = await entriesFor(f); const result = await extract(f, archive(entries));
    assert.equal(result.batchId, 'batch-1'); assert.equal(result.archiveBytes, archive(entries).length);
    for (const e of entries) assert.deepEqual(await readFile(join(f.root, 'extract', e.path)), e.bytes);
  });
});
test('child close before archive consumption preserves buffered stdout across initial directory admission', async () => {
  await useFixture(async f => {
    const bytes = archive(await entriesFor(f)); assert.ok(bytes.length < 64 * 1024);
    const destination = join(f.root, 'slow-extraction'); await mkdir(destination, { mode: 0o700 });
    let child, closed = false, consumedAfterClose = false;
    // Deterministic transport fixture, not cryptography: keep the consumer behind
    // initial directory admission until a real child exits and Node flushes stdio.
    const script = `const chunks=[];process.stdin.on('data',b=>chunks.push(b));
      process.stdin.on('end',()=>process.stdout.end(Buffer.concat(chunks)));`;
    const result = await childStream(process.execPath, ['-e', script], {
      cwd: f.root, signal: new AbortController().signal, input: Readable.from([bytes]), budget: () => {},
      spawnProcess: (binary, args, options) => {
        child = spawn(binary, args, options);
        child.once('close', () => { closed = true; }); return child;
      },
      consume: async stream => {
        await once(child, 'close'); consumedAfterClose = closed;
        return extractUstar(stream, { ...f, destination, maximumArchiveBytes: bytes.length }, { disk: ample });
      },
    });
    assert.equal(consumedAfterClose, true); assert.equal(closed, true); assert.equal(result.archiveBytes, bytes.length);
    assert.equal(result.batchId, 'batch-1');
    for (const entry of await entriesFor(f)) assert.deepEqual(await readFile(join(destination, entry.path)), entry.bytes);
    assert.ok(!(await readdir(f.root)).includes('joined'));
  });
});

for (const [name, mutation] of [
  ['traversal', entries => { entries[0].path = '../escape'; }],
  ['absolute path', entries => { entries[0].path = '/escape'; }],
  ['duplicate', entries => { entries.splice(1, 0, entries[0]); }],
  ['missing file', entries => { entries.pop(); }],
  ['unexpected file', entries => { entries.push({ path: 'z-extra', bytes: Buffer.from('extra') }); }],
  ['oversized payload', entries => { const e = entries.find(e => e.path.includes('/payload/')); e.bytes = Buffer.concat([e.bytes, Buffer.from('x')]); }],
  ['mixed source', entries => { const value = JSON.parse(entries[0].bytes); value.sourceSha = 'c'.repeat(40); entries[0].bytes = json(value); }],
  ['wrong plan', entries => { const value = JSON.parse(entries[0].bytes); value.reviewedPlanSha256 = 'c'.repeat(64); entries[0].bytes = json(value); }],
  ['partial seal', entries => { entries.push({ path: 'core/seal.json', bytes: Buffer.from('seal') }); entries.sort((a, b) => a.path < b.path ? -1 : 1); }],
]) test('USTAR refuses ' + name, async () => {
  await useFixture(async f => { const entries = await entriesFor(f); mutation(entries); await assert.rejects(extract(f, archive(entries))); });
});
for (const type of ['1', '2', '3', '5', 'x', 'g']) test('USTAR rejects nonregular/extension type ' + type, async () => {
  await useFixture(async f => { const entries = await entriesFor(f); entries[0].type = type; await assert.rejects(extract(f, archive(entries))); });
});
test('USTAR checksum, end blocks, trailing bytes, padding and finite byte bound are enforced', async () => {
  for (const mode of ['checksum', 'truncated', 'extra', 'padding', 'cap']) await useFixture(async f => {
    const entries = await entriesFor(f); let bytes = archive(entries);
    if (mode === 'checksum') bytes[0] ^= 1;
    if (mode === 'truncated') bytes = bytes.subarray(0, bytes.length - 1024);
    if (mode === 'extra') bytes = Buffer.concat([bytes, Buffer.from('x')]);
    if (mode === 'padding') bytes[512 + entries[0].bytes.length] = 1;
    if (mode === 'cap') {
      const destination = join(f.root, 'extract'); await mkdir(destination);
      await assert.rejects(extractUstar(Readable.from([bytes]), { ...f, destination, maximumArchiveBytes: bytes.length - 1 }), /plaintext-archive-budget/);
    } else await assert.rejects(extract(f, bytes));
  });
});

test('real pinned age encrypt/decrypt roundtrip assembles all22 exact components with only a complete core seal', async () => {
  await useEncrypted(async f => {
    const originalIdentity = await readFile(f.identityFile), receipt = await decryptAndJoin(f);
    assert.equal(receipt.components.length, 22); assert.equal(receipt.scientificValidationPerformed, false);
    assert.equal(receipt.publicationAuthorized, false);
    const sealBytes = await readFile(join(f.destination, 'core/seal.json')); assert.equal(hash(sealBytes), receipt.coreSealSha256);
    assert.equal(JSON.parse(sealBytes).files.length, 26); assert.deepEqual(await readFile(f.identityFile), originalIdentity);
    for (const [id, body] of f.bodies) {
      assert.deepEqual(await readFile(join(f.destination, `original/components/${id}/component.json`)), body.raw);
      for (const [path, bytes] of body.payload) assert.deepEqual(await readFile(join(f.destination, `original/components/${id}/payload/${path}`)), bytes);
    }
    assert.ok((await readdir(f.root)).every(name => !name.startsWith('.train3-baseline-decrypt-')));
    assert.equal((await lstat(f.destination)).mode & 0o777, 0o700);
  });
});
test('real ciphertext corruption refuses and removes plaintext scratch', async () => {
  await useEncrypted(async f => { const item = f.encryptedBatches[0], bytes = await readFile(item.ciphertextPath);
    bytes[bytes.length - 10] ^= 1; await writeFile(item.ciphertextPath, bytes); await refuses(f); });
});
test('wrong synthetic native identity refuses without retaining a private key copy', async () => {
  await useEncrypted(async f => { const wrong = await generateIdentity(f, await tools(), 'wrong-synthetic.key');
    f.identityFile = wrong.path; await refuses(f); });
});
test('ciphertext pins, minimal receipt and expected source are enforced', async () => {
  for (const mode of ['digest', 'receipt', 'source', 'duplicate']) await useEncrypted(async f => {
    if (mode === 'digest') { const item = f.encryptedBatches[0], receipt = JSON.parse(item.receiptBytes);
      item.ciphertextSha256 = receipt.ciphertextSha256 = 'd'.repeat(64); item.receiptBytes = json(receipt); item.receiptSha256 = hash(item.receiptBytes); }
    if (mode === 'receipt') { const item = f.encryptedBatches[0], receipt = JSON.parse(item.receiptBytes);
      receipt.sourceSha = f.expectedSourceSha; item.receiptBytes = json(receipt); item.receiptSha256 = hash(item.receiptBytes); }
    if (mode === 'source') f.expectedSourceSha = 'd'.repeat(40);
    if (mode === 'duplicate') f.encryptedBatches[2] = f.encryptedBatches[0];
    await refuses(f);
  });
});
test('disk refusal preserves existing inputs and existing destination is never overwritten', async () => {
  await useEncrypted(async f => { await refuses(f, { disk: async () => ({ bavail: 0, bsize: 1 }) }); });
  await useEncrypted(async f => { await mkdir(f.destination); await writeFile(join(f.destination, 'keep'), 'keep');
    await assert.rejects(decryptAndJoin(f), { code: 'EEXIST' }); assert.equal(await readFile(join(f.destination, 'keep'), 'utf8'), 'keep'); });
});
test('combined admission refuses below decoded plus joined allocation before any tool child', async () => {
  await useEncrypted(async f => {
    const capacity = baselineCapacity({ ...f, blockSize: 4096 }), before = await readdir(f.root); let children = 0;
    await refuses(f, { disk: async () => ({ bsize: 4096, bavail: (capacity.decryptAdditionalBytes - 4096) / 4096 }),
      spawnProcess: () => { children++; throw new Error('unexpected child'); } });
    assert.equal(children, 0); assert.deepEqual(await readdir(f.root), before);
  });
});
test('exact combined additional allocation survives declining space through three real decryptions and join', async () => {
  await useEncrypted(async f => {
    const capacity = baselineCapacity({ ...f, blockSize: 4096 });
    const meter = await meteredDisk(f.root, capacity.decryptAdditionalBytes); let children = 0;
    const receipt = await decryptAndJoin(f, { disk: meter.disk,
      spawnProcess: (...args) => { children++; return spawn(...args); } });
    assert.equal(children, 4); assert.equal(receipt.components.length, 22);
    assert.ok(meter.stats().polls > 300); assert.ok(meter.stats().minimumFreeBytes >= capacity.reserveBytes);
    assert.ok((await readdir(f.root)).every(name => !name.startsWith('.train3-baseline-decrypt-')));
    assert.equal(receipt.scientificValidationPerformed, false); assert.equal(receipt.publicationAuthorized, false);
  });
});
test('reserve lost during extraction kills and drains the child before removing owned plaintext', async () => {
  await useEncrypted(async f => {
    let spawned = 0, closed = 0, extractionPolls = 0;
    await refuses(f, {
      disk: async path => {
        if (/\/batch-[1-3]$/.test(path) && ++extractionPolls === 2)
          return { bsize: 4096, bavail: (1024 ** 3 - 4096) / 4096 };
        return ample();
      },
      spawnProcess: (...args) => { const child = spawn(...args); spawned++;
        child.once('close', () => { closed++; }); return child; },
    });
    assert.equal(extractionPolls, 2); assert.equal(spawned, 2); assert.equal(closed, spawned);
  });
});
test('real decryption child cancellation is killed/drained before plaintext cleanup returns', async () => {
  await useEncrypted(async f => {
    const controller = new AbortController(); let spawned = 0, closed = 0, decryptStarted = false;
    await refuses(f, { signal: controller.signal, spawnProcess: (binary, args, options) => {
      const child = spawn(binary, args, options); spawned++; child.once('close', () => { closed++; });
      if (args.includes('--decrypt')) { decryptStarted = true; child.stdout.once('data', () => controller.abort()); }
      return child;
    } });
    assert.equal(decryptStarted, true); assert.equal(closed, spawned);
  });
});
test('real decryption deadline drains child before returning', async () => {
  await useEncrypted(async f => {
    let expired = false, spawned = 0, closed = 0;
    await refuses(f, { now: () => expired ? 43 * 60_000 : 0, spawnProcess: (binary, args, options) => {
      const child = spawn(binary, args, options); spawned++; child.once('close', () => { closed++; });
      if (args.includes('--decrypt')) child.stdout.once('data', () => { expired = true; }); return child;
    } });
    assert.equal(expired, true); assert.equal(closed, spawned);
  });
});
test('real authenticated age archive with a forbidden link is refused and drained', async () => {
  await useEncrypted(async f => {
    const entries = await entriesFor(f); entries[1].type = '2'; await replaceWithEncryptedBytes(f, archive(entries));
    let spawned = 0, closed = 0;
    await refuses(f, { spawnProcess: (binary, args, options) => {
      const child = spawn(binary, args, options); spawned++; child.once('close', () => { closed++; }); return child;
    } });
    assert.equal(spawned > 1, true); assert.equal(closed, spawned);
  });
});
test('real authenticated age payload with a wrong original inventory hash cannot produce a joined seal', async () => {
  await useEncrypted(async f => {
    const entries = await entriesFor(f), entry = entries.find(e => e.path.startsWith('original/') && e.path.includes('/payload/'));
    entry.bytes = Buffer.from('x'.repeat(entry.bytes.length)); await replaceWithEncryptedBytes(f, archive(entries));
    await refuses(f);
  });
});
test('explicit pinned local CLI roundtrip produces only the private joined destination', async () => {
  await useEncrypted(async f => {
    const toolBytes = json(toolConfig), descriptors = f.encryptedBatches.map(item => ({
      ciphertextPath: item.ciphertextPath, ciphertextSha256: item.ciphertextSha256, ciphertextBytes: item.ciphertextBytes,
      receiptPath: join(item.ciphertextPath, '..', 'encrypted-receipt.json'), receiptSha256: item.receiptSha256,
    })), inputBytes = json(descriptors);
    const plan = join(f.root, 'plan.json'), batches = join(f.root, 'batches.json'), config = join(f.root, 'tool.json'), inputs = join(f.root, 'inputs.json');
    await writeFile(plan, f.planBytes); await writeFile(batches, f.batchPlanBytes);
    await writeFile(config, toolBytes); await writeFile(inputs, inputBytes);
    for (const [index, env] of [{ LANG: 'C' }, { LANG: 'C.UTF-8' }, { LANG: 'en_US.UTF-8' },
      { LANG: 'en_US.UTF-8', LC_ALL: 'C' }].entries()) {
      const destination = index === 0 ? f.destination : join(f.root, `cli-joined-${index}`);
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/train3-baseline-decrypt.mjs', import.meta.url)),
        plan, f.planSha256, batches, f.batchPlanSha256, f.expectedSourceSha, f.identityFile, config, hash(toolBytes),
        destination, inputs, hash(inputBytes)], { env, cwd: f.root, timeout: 20_000, maxBuffer: 4096 });
      // Refusal output is finite and safe to include in an assertion. Unexpected
      // output is withheld so the fixture never dumps paths or key material.
      assert.ok(result.stderr.length === 0 || /^Train 3 private local baseline assembly refused: [a-z-]+\/[a-z-]+\.\n$/.test(result.stderr.toString()),
        'CLI diagnostics must be one finite refusal line');
      assert.equal(result.status, 0, `explicit synthetic CLI assembly must succeed (${index}; ${result.stderr.toString().trim()})`);
      assert.equal(result.stderr.length, 0); assert.equal(result.stdout.toString(), 'Train 3 private local baseline assembly complete.\n');
      assert.equal(JSON.parse(await readFile(join(destination, 'join-receipt.json'))).components.length, 22);
    }
    const refusedDestination = join(f.root, 'cli-refused');
    const refused = spawnSync(process.execPath, [fileURLToPath(new URL('../tools/train3-baseline-decrypt.mjs', import.meta.url)),
      plan, f.planSha256, batches, f.batchPlanSha256, f.expectedSourceSha, f.identityFile, config, hash(toolBytes),
      refusedDestination, inputs, '0'.repeat(64)], { env: { LANG: 'C' }, cwd: f.root, timeout: 20_000, maxBuffer: 4096 });
    assert.equal(refused.status, 1); assert.equal(refused.stdout.length, 0);
    assert.equal(refused.stderr.toString(), 'Train 3 private local baseline assembly refused: descriptor/local-descriptor-pin.\n');
    await assert.rejects(lstat(refusedDestination), { code: 'ENOENT' });
    assert.ok((await readdir(f.root)).every(name => !name.startsWith('.train3-baseline-decrypt-')));
  });
});
test('finite refusal diagnostics withhold native paths, key material and arbitrary error messages', async () => {
  const sensitive = 'AGE-SECRET-KEY-1SYNTHETIC /private/fixture/identity';
  assert.deepEqual(decryptFailureDiagnostic(new Error(sensitive)), { phase: 'descriptor', code: 'unknown' });
  assert.deepEqual(decryptFailureDiagnostic(Object.assign(new Error(sensitive), { code: 'EACCES' })),
    { phase: 'descriptor', code: 'filesystem-eacces' });
  assert.deepEqual(decryptFailureDiagnostic(new SyntaxError(sensitive)), { phase: 'descriptor', code: 'invalid-json' });
  assert.deepEqual(decryptFailureDiagnostic(new Error('original-inventory-hash'), sensitive),
    { phase: 'unknown', code: 'original-inventory-hash' });
  await useEncrypted(async f => {
    f.encryptedBatches[0].receiptSha256 = '0'.repeat(64);
    await assert.rejects(decryptAndJoin(f), error => {
      assert.deepEqual(decryptFailureDiagnostic(error), { phase: 'descriptor', code: 'ciphertext-pin' }); return true;
    });
  });
});

test('historical native encryption/decryption admits only pinned original bytes and all3 same-mode batches', async () => {
  await useEncrypted(async f => {
    const receipt = await decryptAndJoin(f);
    assert.equal(receipt.operation, 'historical-batch-export');
    assert.equal(receipt.components.length, 22);
    assert.equal(receipt.scientificValidationPerformed, false); assert.equal(receipt.publicationAuthorized, false);
    const seal = await readFile(join(f.destination, 'core/seal.json')); assert.equal(hash(seal), receipt.coreSealSha256);
    for (const [id, body] of f.bodies) for (const [path, bytes] of body.payload)
      assert.deepEqual(await readFile(join(f.destination, `original/components/${id}/payload/${path}`)), bytes);
    for (const item of f.encryptedBatches) {
      const publicReceipt = JSON.parse(item.receiptBytes);
      assert.equal(publicReceipt.observedCurrentPointerBase64, undefined);
      assert.equal(publicReceipt.operation, undefined);
    }
  }, true);
});

test('decryption archive admission refuses an unknown operation before accepting its tree', async () => {
  await useFixture(async f => {
    const entries = await entriesFor(f), acquisition = entries.find(e => e.path === 'acquisition-receipt.json');
    const receipt = JSON.parse(acquisition.bytes); receipt.operation = 'unknown'; acquisition.bytes = json(receipt);
    await assert.rejects(extract(f, archive(entries)), /archive-receipt-binding/);
  }, { historical: true });
});
