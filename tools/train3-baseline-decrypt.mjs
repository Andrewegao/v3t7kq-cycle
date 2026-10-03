// Local standard-age decryption. Private identity and plaintext never leave this
// invocation. Inputs must be locally quiescent; this is not an OS sandbox.
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { batchPlan, BATCH_OPERATIONS, LIMITS, hash, safeKey } from './train3-baseline-preparation.mjs';
import { acquisitionSource, allocationEstimate, baselineCapacity, batchExpectedTree, historicalSourceBinding,
  joinBaseline, readRegular } from './train3-baseline-join.mjs';
import { verifyAgeToolchain, assertAgeToolchain } from './train3-baseline-encrypt.mjs';

const RESERVE = 1024 ** 3, RECEIPT_CAP = 64 * 1024, STDERR_CAP = 16 * 1024;
const refusalCodes = new WeakMap(), refusalPhases = new WeakMap();
const check = (ok, code) => { if (!ok) { const error = new Error(code); refusalCodes.set(error, code); throw error; } };
const PHASES = new Set(['descriptor', 'capacity', 'toolchain', 'identity', 'recipient', 'ciphertext', 'extraction', 'join', 'finalization', 'cleanup']);
const SHARED_CODES = new Set(['original-inventory-hash', 'input-file-type-size', 'input-file-changed',
  'input-file-replaced', 'input-tree-changed', 'batch-receipt-binding', 'acquisition-receipt-binding',
  'free-disk-budget', 'free-disk-reserve', 'age-version', 'age-version-failed', 'age-binary-hash',
  'age-binary-changed', 'age-distribution-hash', 'age-toolchain-platform']);
const FILESYSTEM_CODES = new Set(['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'ENOSPC', 'EMFILE', 'ENFILE', 'EIO', 'ELOOP', 'EBADF']);
const objectError = error => error && (typeof error === 'object' || typeof error === 'function');
async function atPhase(phase, action) {
  try { return await action(); } catch (error) {
    if (objectError(error) && !refusalPhases.has(error)) refusalPhases.set(error, phase); throw error;
  }
}
// Finite diagnostic vocabulary only: never expose native messages, arguments,
// filesystem paths, stderr, private identities, public recipients or descriptor bytes.
export function decryptFailureDiagnostic(error, fallback = 'descriptor') {
  let code = 'unknown', phase = PHASES.has(fallback) ? fallback : 'unknown';
  if (objectError(error)) {
    phase = refusalPhases.get(error) ?? phase;
    if (refusalCodes.has(error)) code = refusalCodes.get(error);
    else if (error instanceof SyntaxError) code = 'invalid-json';
    else if (FILESYSTEM_CODES.has(error.code)) code = `filesystem-${error.code.toLowerCase()}`;
    else if (SHARED_CODES.has(error.message)) code = error.message;
  }
  return Object.freeze({ phase, code });
}
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const parse = bytes => JSON.parse(bytes.toString('utf8'));
const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(k => a[k] === b[k]);
const contains = (a, b) => a === b || b.startsWith(a + sep);
async function directory(path) {
  check(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path !== '/', 'canonical-directory');
  check(await realpath(path) === path && (await lstat(path)).isDirectory(), 'directory-link-or-non-directory');
}
async function removeOwned(path, info) {
  if (!path || !info) return;
  let current;
  try { current = await lstat(path, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  check(current.isDirectory() && current.dev === info.dev && current.ino === info.ino, 'cleanup-ownership-changed');
  await rm(path, { recursive: true, force: true });
}

class StreamReader {
  constructor(stream, maximum, budget) { this.iterator = stream[Symbol.asyncIterator](); this.maximum = maximum;
    this.budget = budget; this.current = Buffer.alloc(0); this.offset = 0; this.total = 0; this.eof = false; }
  async read(size, allowEof = false) {
    this.budget(); const chunks = []; let length = 0;
    while (length < size) {
      if (this.offset === this.current.length) {
        if (this.eof) break;
        const next = await this.iterator.next(); this.budget();
        if (next.done) { this.eof = true; break; }
        this.current = Buffer.from(next.value); this.offset = 0; this.total += this.current.length;
        check(this.total <= this.maximum, 'plaintext-archive-budget');
        if (!this.current.length) continue;
      }
      const count = Math.min(size - length, this.current.length - this.offset);
      chunks.push(this.current.subarray(this.offset, this.offset + count)); this.offset += count; length += count;
    }
    check(length === size || allowEof, 'truncated-archive'); return length ? Buffer.concat(chunks, length) : null;
  }
}
function text(buffer) {
  const end = buffer.indexOf(0), tail = end < 0 ? buffer.length : end;
  check(buffer.subarray(tail).every(byte => byte === 0), 'archive-string-padding');
  check(buffer.subarray(0, tail).every(byte => byte >= 32 && byte < 127), 'archive-string-encoding');
  return buffer.subarray(0, tail).toString('ascii');
}
function octal(buffer) {
  const value = buffer.toString('ascii'); check(/^[0-7]+[\0 ]+$/.test(value), 'archive-number');
  const number = Number.parseInt(value, 8); check(Number.isSafeInteger(number) && number >= 0, 'archive-number'); return number;
}
function header(block) {
  const checksum = octal(block.subarray(148, 156)); let actual = 0;
  for (let i = 0; i < block.length; i++) actual += i >= 148 && i < 156 ? 32 : block[i];
  check(checksum === actual && block.subarray(257, 263).equals(Buffer.from('ustar\0'))
    && block.subarray(263, 265).toString('ascii') === '00', 'archive-header');
  check((block[156] === 48 || block[156] === 0) && block.subarray(157, 257).every(byte => byte === 0), 'archive-nonregular');
  check(octal(block.subarray(100, 108)) === 0o600 && octal(block.subarray(108, 116)) === 0
    && octal(block.subarray(116, 124)) === 0 && octal(block.subarray(136, 148)) === 0, 'archive-file-metadata');
  const name = text(block.subarray(0, 100)), prefix = text(block.subarray(345, 500));
  return { path: safeKey(prefix ? `${prefix}/${name}` : name), size: octal(block.subarray(124, 136)) };
}

// The archive contract is deterministic USTAR, files only, lexicographic order,
// two zero end blocks, no PAX/GNU extensions or extra trailing blocks.
export async function extractUstar(stream, { planBytes, planSha256, batchPlanBytes, batchPlanSha256,
  expectedSourceSha, destination, maximumArchiveBytes, sourceBindingBytes, sourceBindingSha256 }, { disk = statfs, budget = () => {} } = {}) {
  const binding = historicalSourceBinding({ sourceBindingBytes, sourceBindingSha256, expectedSourceSha,
    catalogId: parse(planBytes).catalogId, planSha256, batchPlanSha256 });
  await directory(destination);
  const reader = new StreamReader(stream, maximumArchiveBytes, budget), seen = new Set();
  let selected, expected, last = '', receiptBytes;
  for (;;) {
    const block = await reader.read(512);
    if (block.every(byte => byte === 0)) {
      check((await reader.read(512)).every(byte => byte === 0) && await reader.read(1, true) === null, 'archive-end'); break;
    }
    const entry = header(block);
    check(entry.path > last && !seen.has(entry.path), 'archive-order-or-duplicate'); last = entry.path; seen.add(entry.path);
    if (!selected) check(entry.path === 'acquisition-receipt.json' && entry.size <= 1024 ** 2, 'archive-first-receipt');
    else check(expected.files.has(entry.path) && entry.size <= expected.files.get(entry.path), 'archive-unexpected-or-oversized-file');
    const path = join(destination, entry.path), available = await disk(destination);
    check(available.bavail * available.bsize >= RESERVE
      + allocationEstimate(new Map([[entry.path, entry.size]]), available.bsize).allocationBytes, 'free-disk-reserve');
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const receipt = entry.path === 'acquisition-receipt.json' ? [] : null;
    try {
      let left = entry.size;
      while (left) { const bytes = await reader.read(Math.min(left, 64 * 1024)); budget();
        await file.writeFile(bytes); if (receipt) receipt.push(bytes); left -= bytes.length; }
    } finally { await file.close(); }
    const afterWrite = await disk(destination);
    check(afterWrite.bavail * afterWrite.bsize >= RESERVE, 'free-disk-reserve');
    const padding = (512 - entry.size % 512) % 512;
    if (padding) check((await reader.read(padding)).every(byte => byte === 0), 'archive-padding');
    if (!selected) {
      receiptBytes = Buffer.concat(receipt); const acquisition = parse(receiptBytes);
      check(BATCH_OPERATIONS.includes(acquisition.operation)
        && (acquisition.currentPointerPolicy === undefined || acquisition.operation === 'historical-batch-export'
          && acquisition.currentPointerPolicy === 'historical-observation-v1')
        && acquisition.sourceSha === acquisitionSource(acquisition, binding, expectedSourceSha)
        && acquisition.reviewedPlanSha256 === planSha256 && acquisition.reviewedBatchPlanSha256 === batchPlanSha256,
      'archive-receipt-binding');
      selected = batchPlan(planBytes, planSha256, batchPlanBytes, batchPlanSha256, acquisition.batchId, acquisition.catalogId);
      expected = batchExpectedTree(selected.selectedComponents, selected.pointer, selected.snapshot);
    }
    // Every non-receipt length is exact, including all core duplicate bytes.
    if (selected && !['acquisition-receipt.json', 'batch-receipt.json'].includes(entry.path))
      check(entry.size === expected.files.get(entry.path), 'archive-file-size');
  }
  check(selected && seen.size === expected.files.size && [...expected.files.keys()].every(path => seen.has(path)), 'archive-missing-files');
  return { batchId: selected.batchId, archiveBytes: reader.total };
}

export async function childStream(binary, args, { cwd, signal, spawnProcess, input, consume, budget }) {
  budget();
  const child = spawnProcess(binary, args, { cwd, env: { LANG: 'C' }, stdio: ['pipe', 'pipe', 'pipe'] });
  // Node flushStdio resumes unread child stdout on process exit. Directory
  // admission may await I/O before the consumer installs its async iterator, so
  // connect an owned bounded pipe synchronously, before that admission starts.
  const output = new PassThrough({ highWaterMark: 64 * 1024 });
  let timer, stderr = 0, processError, closed = false;
  const completion = new Promise(resolveClose => {
    child.once('error', () => { processError = new Error('age-process-start'); });
    child.once('close', (code, term) => { closed = true; resolveClose({ code, term }); });
  });
  const stop = () => {
    child.stdin.destroy(); child.stdout.destroy(); output.destroy(); input?.destroy?.();
    if (!closed) { child.kill('SIGTERM'); timer ??= setTimeout(() => { if (!closed) child.kill('SIGKILL'); }, 1000); }
  };
  const abort = () => stop(); signal.addEventListener('abort', abort, { once: true });
  child.stderr.on('data', bytes => { stderr += bytes.length; if (stderr > STDERR_CAP) stop(); });
  child.stderr.on('error', () => { processError = new Error('age-process-stream'); stop(); });
  // Registration is synchronous; an already cancelled invocation is honored only
  // after the spawned child and its completion/cleanup handlers are owned.
  if (signal.aborted) stop();
  let primary, result;
  const forward = pipeline(child.stdout, output);
  const send = input ? pipeline(input, child.stdin) : Promise.resolve().then(() => child.stdin.end());
  const receive = Promise.resolve().then(() => consume(output));
  try {
    [result] = await Promise.all([receive, send, forward]);
    const status = await completion; budget();
    check(!processError && status.code === 0 && !status.term && stderr <= STDERR_CAP, 'age-process-failed');
    return result;
  } catch (error) { primary = error; stop(); throw error; }
  finally {
    if (primary || signal.aborted) stop();
    await Promise.allSettled([send, receive, forward, completion]);
    clearTimeout(timer); signal.removeEventListener('abort', abort);
  }
}

export async function decryptAndJoin({ planBytes, planSha256, batchPlanBytes, batchPlanSha256, expectedSourceSha,
  encryptedBatches, identityFile, toolchain, destination, sourceBindingBytes, sourceBindingSha256 }, { disk = statfs, now = Date.now, signal,
  spawnProcess = spawn } = {}) {
  check(Buffer.isBuffer(planBytes) && planBytes.length <= LIMITS.plan && Buffer.isBuffer(batchPlanBytes)
    && batchPlanBytes.length <= LIMITS.plan, 'plan-bytes');
  const partition = parse(batchPlanBytes), catalogId = parse(planBytes).catalogId;
  check(Array.isArray(partition.batches) && partition.batches.length === 3, 'three-batches');
  const reviewed = partition.batches.map(row => batchPlan(planBytes, planSha256, batchPlanBytes, batchPlanSha256, row.id, catalogId));
  historicalSourceBinding({ sourceBindingBytes, sourceBindingSha256, expectedSourceSha, catalogId, planSha256, batchPlanSha256 });
  check(/^[a-f0-9]{40}$/.test(expectedSourceSha ?? '') && Array.isArray(encryptedBatches) && encryptedBatches.length === 3
    && new Set(encryptedBatches.map(row => row.ciphertextSha256)).size === 3, 'encrypted-inputs');
  check(typeof destination === 'string' && isAbsolute(destination) && resolve(destination) === destination && destination !== '/', 'destination');
  const parent = dirname(destination); await directory(parent);
  const archiveMaximum = Math.max(...reviewed.map(row => {
    const files = batchExpectedTree(row.selectedComponents, row.pointer, row.snapshot).files;
    return [...files.values()].reduce((sum, size) => sum + 512 + Math.ceil(size / 512) * 512, 1024);
  }));
  const cipherMaximum = archiveMaximum + Math.ceil(archiveMaximum / (64 * 1024)) * 16 + 16 * 1024;
  for (const item of encryptedBatches) {
    check(exact(item, ['ciphertextPath', 'ciphertextSha256', 'ciphertextBytes', 'receiptBytes', 'receiptSha256'])
      && typeof item.ciphertextPath === 'string' && isAbsolute(item.ciphertextPath) && resolve(item.ciphertextPath) === item.ciphertextPath
      && !contains(destination, item.ciphertextPath) && /^[a-f0-9]{64}$/.test(item.ciphertextSha256 ?? '')
      && Number.isSafeInteger(item.ciphertextBytes) && item.ciphertextBytes > 0 && item.ciphertextBytes <= cipherMaximum
      && Buffer.isBuffer(item.receiptBytes) && item.receiptBytes.length <= RECEIPT_CAP
      && hash(item.receiptBytes) === item.receiptSha256, 'ciphertext-pin');
  }
  await atPhase('capacity', async () => {
    const available = await disk(parent), capacity = baselineCapacity({ planBytes, planSha256,
      batchPlanBytes, batchPlanSha256, blockSize: available.bsize });
    // Ciphertext inputs are already on disk. Require the additional decoded trees
    // AND complete joined tree before any child starts; there is no plaintext tar spool.
    check(available.bavail * available.bsize >= capacity.decryptAdditionalBytes, 'free-disk-budget');
  });
  const verifiedTool = await atPhase('toolchain', () => verifyAgeToolchain(toolchain)), controller = new AbortController();
  const deadline = now() + LIMITS.milliseconds, cancel = () => controller.abort();
  const budget = () => check(!controller.signal.aborted && !signal?.aborted && now() < deadline, 'interrupted-or-deadline');
  const timeout = setTimeout(cancel, LIMITS.milliseconds); timeout.unref();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel); signal?.addEventListener('abort', cancel, { once: true });
  let work, workInfo, destinationInfo, complete = false, primary, phase = 'identity';
  try {
    budget(); await mkdir(destination, { mode: 0o700 }); destinationInfo = await lstat(destination, { bigint: true });
    work = await mkdtemp(join(parent, '.train3-baseline-decrypt-')); workInfo = await lstat(work, { bigint: true });
    const key = await atPhase('identity', () => readRegular(dirname(identityFile), relative(dirname(identityFile), identityFile), 4096));
    check((key.info.mode & 0o077n) === 0n && /^((#[^\r\n]*\r?\n)*)AGE-SECRET-KEY-1[0-9A-Z]{50,100}\r?\n?$/.test(key.bytes.toString('ascii')), 'native-private-identity');
    const privateIdentity = join(work, '.identity');
    const keyDisk = await disk(parent);
    check(keyDisk.bavail * keyDisk.bsize >= RESERVE
      + allocationEstimate(new Map([['.identity', key.bytes.length]]), keyDisk.bsize).allocationBytes, 'free-disk-reserve');
    const keyFile = await open(privateIdentity, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await keyFile.writeFile(key.bytes); } finally { key.bytes.fill(0); await keyFile.close(); }
    phase = 'recipient'; await assertAgeToolchain(verifiedTool); budget();
    const recipientBytes = await atPhase('recipient', () => childStream(verifiedTool.ageKeygenBinary, ['-y', privateIdentity], {
      cwd: work, signal: controller.signal, spawnProcess, budget, consume: async stream => {
        const chunks = []; let bytes = 0;
        for await (const chunk of stream) { bytes += chunk.length; check(bytes <= 1024, 'recipient-output-budget'); chunks.push(chunk); }
        return Buffer.concat(chunks);
      },
    }));
    const recipient = recipientBytes.toString('ascii').trim();
    check(/^age1[0-9a-z]{50,100}$/.test(recipient), 'native-recipient');
    const directories = [];
    for (let i = 0; i < encryptedBatches.length; i++) {
      phase = 'ciphertext'; budget(); const item = encryptedBatches[i], receipt = parse(item.receiptBytes);
      check(exact(receipt, ['schemaVersion', 'kind', 'ageVersion', 'recipientSha256', 'ciphertextSha256', 'ciphertextBytes',
        'archiveFormat', 'completeBaselineEligible', 'publicationAuthorized']) && receipt.schemaVersion === 1
        && receipt.kind === 'weatherx-train3-encrypted-baseline-batch-v1' && receipt.ageVersion === 'v1.3.2'
        && receipt.recipientSha256 === hash(Buffer.from(recipient)) && receipt.ciphertextSha256 === item.ciphertextSha256
        && receipt.ciphertextBytes === item.ciphertextBytes && receipt.archiveFormat === 'ustar-v1'
        && receipt.completeBaselineEligible === false && receipt.publicationAuthorized === false, 'encrypted-receipt-binding');
      await directory(dirname(item.ciphertextPath));
      const info = await lstat(item.ciphertextPath, { bigint: true });
      check(info.isFile() && info.nlink === 1n && info.size === BigInt(item.ciphertextBytes), 'ciphertext-file');
      const file = await open(item.ciphertextPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const batchDestination = join(work, `batch-${i + 1}`); await mkdir(batchDestination, { mode: 0o700 });
      try {
        check(same(info, await file.stat({ bigint: true })), 'ciphertext-changed');
        const digest = createHash('sha256'); let bytes = 0;
        const cap = new Transform({ transform(chunk, _encoding, callback) {
          try { budget(); bytes += chunk.length; check(bytes <= item.ciphertextBytes, 'ciphertext-size'); digest.update(chunk); callback(null, chunk); }
          catch (error) { callback(error); }
        } });
        const source = file.createReadStream({ autoClose: false });
        source.on('error', error => cap.destroy(error)); cap.on('error', () => source.destroy());
        cap.once('close', () => { if (!source.readableEnded) source.destroy(); }); source.pipe(cap);
        await assertAgeToolchain(verifiedTool); budget();
        await atPhase('extraction', () => childStream(verifiedTool.ageBinary, ['--decrypt', '--identity', privateIdentity], {
          cwd: work, signal: controller.signal, spawnProcess, input: cap, budget,
          consume: stream => extractUstar(stream, { planBytes, planSha256, batchPlanBytes, batchPlanSha256,
            expectedSourceSha, sourceBindingBytes, sourceBindingSha256,
            destination: batchDestination, maximumArchiveBytes: archiveMaximum }, { disk, budget }),
        }));
        check(bytes === item.ciphertextBytes && digest.digest('hex') === item.ciphertextSha256
          && same(info, await file.stat({ bigint: true })) && same(info, await lstat(item.ciphertextPath, { bigint: true })), 'ciphertext-digest-or-change');
      } finally { await file.close(); }
      directories.push(batchDestination);
    }
    phase = 'join'; budget();
    const joined = join(work, 'joined');
    const receipt = await atPhase('join', () => joinBaseline({ planBytes, planSha256, batchPlanBytes, batchPlanSha256,
      expectedSourceSha, sourceBindingBytes, sourceBindingSha256,
      batchDirectories: directories, destination: joined }, { disk, now, signal: controller.signal }));
    phase = 'finalization'; budget(); check(same(destinationInfo, await lstat(destination, { bigint: true })) && (await readdir(destination)).length === 0, 'destination-reservation');
    const joinedInfo = await lstat(joined, { bigint: true });
    await rename(joined, destination); destinationInfo = joinedInfo; budget(); complete = true;
    return receipt;
  } catch (error) { primary = error;
    if (objectError(error) && !refusalPhases.has(error)) refusalPhases.set(error, phase);
    controller.abort(); throw error; }
  finally {
    let cleanupError;
    try { await removeOwned(work, workInfo); } catch (error) { cleanupError = error; }
    const interrupted = controller.signal.aborted || signal?.aborted || now() >= deadline;
    if (!complete || cleanupError || interrupted) try { await removeOwned(destination, destinationInfo); } catch (error) { cleanupError ??= error; }
    clearTimeout(timeout); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    signal?.removeEventListener('abort', cancel);
    if (cleanupError) {
      const error = new Error('decrypt-cleanup-failed', { cause: primary ?? cleanupError });
      refusalCodes.set(error, 'decrypt-cleanup-failed'); refusalPhases.set(error, 'cleanup'); throw error;
    }
    if (complete && interrupted) throw new Error('interrupted-or-deadline');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (async () => {
    const args = process.argv.slice(2); check(args.length === 11 || args.length === 14
      && args[11] === '--historical-source-binding', 'explicit-decrypt-arguments');
    const [planPath, planSha256, batchPath, batchPlanSha256, expectedSourceSha, identityFile,
      toolPath, toolSha, destination, inputPath, inputSha] = args;
    const read = async (path, cap) => (await readRegular(dirname(resolve(path)), relative(dirname(resolve(path)), resolve(path)), cap)).bytes;
    const planBytes = await read(planPath, LIMITS.plan), batchPlanBytes = await read(batchPath, LIMITS.plan);
    const toolBytes = await read(toolPath, RECEIPT_CAP), inputBytes = await read(inputPath, RECEIPT_CAP);
    const sourceBindingBytes = args.length === 14 ? await read(args[12], 1024 ** 2) : undefined,
      sourceBindingSha256 = args[13];
    check(hash(toolBytes) === toolSha && hash(inputBytes) === inputSha, 'local-descriptor-pin');
    const descriptors = parse(inputBytes); check(Array.isArray(descriptors) && descriptors.length === 3, 'input-descriptor');
    const encryptedBatches = [];
    for (const item of descriptors) {
      check(exact(item, ['ciphertextPath', 'ciphertextSha256', 'ciphertextBytes', 'receiptPath', 'receiptSha256']), 'input-descriptor');
      encryptedBatches.push({ ciphertextPath: item.ciphertextPath,
        ciphertextSha256: item.ciphertextSha256, ciphertextBytes: item.ciphertextBytes,
        receiptSha256: item.receiptSha256, receiptBytes: await read(item.receiptPath, RECEIPT_CAP) });
    }
    await decryptAndJoin({ planBytes, planSha256, batchPlanBytes, batchPlanSha256, expectedSourceSha,
      identityFile, toolchain: parse(toolBytes), destination, encryptedBatches, sourceBindingBytes, sourceBindingSha256 });
    console.log('Train 3 private local baseline assembly complete.');
  })().catch(error => {
    const diagnostic = decryptFailureDiagnostic(error);
    console.error(`Train 3 private local baseline assembly refused: ${diagnostic.phase}/${diagnostic.code}.`);
    process.exitCode = 1;
  });
}
