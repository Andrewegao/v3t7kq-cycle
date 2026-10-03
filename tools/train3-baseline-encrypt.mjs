// Confidential transport only. No reader, private key, provider, or upload interface.
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { isDeepStrictEqual } from 'node:util';
import { get as httpsGet } from 'node:https';
import { pathToFileURL } from 'node:url';
import { hash, safeKey } from './train3-baseline-preparation.mjs';
import { batchExpectedTree, isVerifiedBatch } from './train3-baseline-join.mjs';

export const ENCRYPTION_LIMITS = Object.freeze({ archive: 4 * 1024 ** 3 + 128 * 1024 ** 2,
  ciphertext: 4 * 1024 ** 3 + 132 * 1024 ** 2, files: 50_100, reserve: 1024 ** 3,
  milliseconds: 10 * 60_000, diagnostics: 64 * 1024, receipt: 4096 });
const tools = new WeakSet(), recipients = new WeakSet();
const check = (ok, code) => { if (!ok) throw new Error(code); };
const state = info => [info.dev, info.ino, info.mode, info.uid, info.gid, info.nlink, info.size, info.mtimeNs, info.ctimeNs];
const same = (a, b) => isDeepStrictEqual(state(a), state(b));
const contains = (a, b) => b === a || b.startsWith(a + sep);

async function directory(path) {
  check(isAbsolute(path) && resolve(path) === path && path !== '/', 'canonical-directory');
  let current = '/';
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part); const info = await lstat(current);
    check(info.isDirectory() && !info.isSymbolicLink(), 'directory-link');
  }
  return lstat(path, { bigint: true });
}
async function regular(path, maximum) {
  check(isAbsolute(path) && resolve(path) === path, 'canonical-file'); await directory(dirname(path));
  const before = await lstat(path, { bigint: true });
  check(before.isFile() && before.nlink === 1n && before.size <= BigInt(maximum), 'tool-file-bound');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    check(same(before, await handle.stat({ bigint: true })), 'tool-file-replaced');
    const bytes = await handle.readFile();
    check(BigInt(bytes.length) === before.size && same(before, await handle.stat({ bigint: true }))
      && same(before, await lstat(path, { bigint: true })), 'tool-file-changed');
    return bytes;
  } finally { await handle.close(); }
}
function members(archive, maximum) {
  const bytes = gunzipSync(archive, { maxOutputLength: maximum }), found = new Map();
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const sizeText = text(124, 12).trim(); check(/^[0-7]+$/.test(sizeText), 'distribution-tar-size');
    const size = Number.parseInt(sizeText, 8), start = offset + 512;
    check(Number.isSafeInteger(size) && start + size <= bytes.length, 'distribution-tar-bound');
    const name = text(345, 155) ? `${text(345, 155)}/${text(0, 100)}` : text(0, 100);
    safeKey(name.endsWith('/') ? name.slice(0, -1) : name);
    check([0, 48, 53].includes(header[156]), 'distribution-link-or-special-member');
    if (['age/age', 'age/age-keygen'].includes(name)) {
      check(!found.has(name) && [0, 48].includes(header[156]), 'distribution-member-type');
      found.set(name, bytes.subarray(start, start + size));
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  check(found.size === 2, 'distribution-members'); return found;
}
const environment = home => ({ PATH: '/nonexistent', HOME: home, TMPDIR: home, LANG: 'C', GOMEMLIMIT: '128MiB' });
async function version(binary, signal) {
  return new Promise((resolveVersion, reject) => execFile(binary, ['--version'], {
    env: environment(dirname(binary)), cwd: dirname(binary), timeout: 10_000, maxBuffer: 1024, signal,
  }, (error, stdout) => error ? reject(new Error('age-version-failed')) : resolveVersion(stdout.trim())));
}
export async function verifyAgeToolchain({ ageBinary, ageKeygenBinary, distributionArchive, signal }) {
  const config = JSON.parse(await readFile(new URL('../ops/train3-baseline/encryption-toolchain.json', import.meta.url), 'utf8'));
  check(config.schemaVersion === 1 && config.kind === 'weatherx-train3-age-toolchain-v1'
    && config.version === 'v1.3.2', 'age-toolchain-config');
  const platform = `${process.platform}-${process.arch}`, distribution = config.distributions[platform];
  check(distribution && /^[a-f0-9]{64}$/.test(distribution.sha256), 'age-toolchain-platform');
  const archive = await regular(distributionArchive, config.archiveMaximumBytes);
  check(archive.length === distribution.bytes && hash(archive) === distribution.sha256, 'age-distribution-hash');
  const original = members(archive, config.expandedMaximumBytes);
  const ageBytes = await regular(ageBinary, 32 * 1024 ** 2), keygenBytes = await regular(ageKeygenBinary, 32 * 1024 ** 2);
  const ageSha256 = hash(ageBytes), ageKeygenSha256 = hash(keygenBytes);
  check(ageBytes.equals(original.get('age/age')) && keygenBytes.equals(original.get('age/age-keygen'))
    && (!distribution.ageSha256 || ageSha256 === distribution.ageSha256)
    && (!distribution.identityGeneratorSha256 || ageKeygenSha256 === distribution.identityGeneratorSha256), 'age-binary-hash');
  check(hash(await regular(ageBinary, 32 * 1024 ** 2)) === ageSha256, 'age-binary-changed');
  check(await version(ageBinary, signal) === config.version, 'age-version');
  check(hash(await regular(ageKeygenBinary, 32 * 1024 ** 2)) === ageKeygenSha256, 'age-binary-changed');
  check(await version(ageKeygenBinary, signal) === config.version, 'age-version');
  const result = Object.freeze({ ageBinary, ageKeygenBinary, distributionArchive, platform,
    ageVersion: config.version, archiveSha256: distribution.sha256, ageSha256, ageKeygenSha256 });
  tools.add(result); return result;
}
export const isVerifiedAgeToolchain = value => tools.has(value);
export async function assertAgeToolchain(toolchain) {
  check(tools.has(toolchain), 'unverified-age-toolchain');
  check(hash(await regular(toolchain.ageBinary, 32 * 1024 ** 2)) === toolchain.ageSha256
    && hash(await regular(toolchain.ageKeygenBinary, 32 * 1024 ** 2)) === toolchain.ageKeygenSha256, 'age-binary-changed');
}

async function* officialArchive(url, signal) {
  const initial = new URL(url); let current = initial;
  for (let redirects = 0; redirects <= 2; redirects++) {
    check(current.protocol === 'https:' && !current.username && !current.password && !current.hash
      && (!current.port || current.port === '443') && (redirects === 0 ? current.href === initial.href
        : current.hostname === 'release-assets.githubusercontent.com'), 'age-download-host');
    const response = await new Promise((resolveResponse, reject) => {
      const request = httpsGet(current, { agent: false, signal, headers: { 'Accept-Encoding': 'identity' } }, resolveResponse);
      request.setTimeout(15_000, () => request.destroy(new Error('age-download-timeout')));
      request.on('error', () => reject(new Error('age-download-failed')));
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location; response.destroy();
      check(redirects < 2 && typeof location === 'string', 'age-download-redirect'); current = new URL(location, current); continue;
    }
    if (response.statusCode !== 200) { response.destroy(); throw new Error('age-download-status'); }
    try { for await (const chunk of response) yield chunk; }
    finally { response.destroy(); }
    return;
  }
  throw new Error('age-download-redirect');
}
export async function prepareAgeToolchain({ destination, signal }, { fetcher = officialArchive } = {}) {
  const config = JSON.parse(await readFile(new URL('../ops/train3-baseline/encryption-toolchain.json', import.meta.url), 'utf8'));
  const descriptor = config.distributions[`${process.platform}-${process.arch}`]; check(descriptor, 'age-toolchain-platform');
  check(isAbsolute(destination) && resolve(destination) === destination && destination !== '/', 'canonical-destination');
  await directory(dirname(destination));
  const abort = new AbortController(), interrupted = () => abort.abort();
  signal?.addEventListener('abort', interrupted, { once: true }); process.on('SIGINT', interrupted); process.on('SIGTERM', interrupted);
  const deadline = Date.now() + 60_000;
  const budget = () => check(!signal?.aborted && !abort.signal.aborted && Date.now() < deadline, 'age-download-interrupted');
  const timer = setTimeout(interrupted, 60_000); timer.unref(); let owned, complete = false, hasPrimary = false;
  try {
    budget(); await mkdir(destination, { mode: 0o700 });
    owned = await lstat(destination, { bigint: true });
    const archivePath = join(destination, 'distribution.tar.gz'), file = await open(archivePath, 'wx', 0o600);
    const digest = createHash('sha256'); let count = 0;
    try {
      for await (const chunk of fetcher(descriptor.url, abort.signal)) {
        budget(); count += chunk.length;
        check(count <= config.archiveMaximumBytes && count <= descriptor.bytes, 'age-download-byte-limit');
        digest.update(chunk); await file.writeFile(chunk);
      }
    } finally { await file.close(); }
    budget(); check(count === descriptor.bytes && digest.digest('hex') === descriptor.sha256, 'age-distribution-hash');
    const original = members(await regular(archivePath, config.archiveMaximumBytes), config.expandedMaximumBytes);
    for (const name of ['age', 'age-keygen']) {
      budget();
      const path = join(destination, name); await writeFile(path, original.get(`age/${name}`), { flag: 'wx', mode: 0o700 }); await chmod(path, 0o700);
    }
    const result = await verifyAgeToolchain({ ageBinary: join(destination, 'age'),
      ageKeygenBinary: join(destination, 'age-keygen'), distributionArchive: archivePath, signal: abort.signal });
    budget(); complete = true; return result;
  } catch (error) { hasPrimary = true; throw error; }
  finally {
    abort.abort(); clearTimeout(timer);
    try { if (!complete) await removeOwned(destination, owned); }
    catch (error) { if (!hasPrimary) throw error; }
    finally { signal?.removeEventListener('abort', interrupted); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); }
  }
}

async function recipientProbe(toolchain, recipient, signal) {
  const child = spawn(toolchain.ageBinary, ['--encrypt', '--recipient', recipient], {
    stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: environment(dirname(toolchain.ageBinary)),
    cwd: dirname(toolchain.ageBinary),
  });
  let failure, failed = false, bytes = 0;
  const stop = () => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const fail = () => { if (!failed) { failed = true; failure = new Error('recipient-validation-failed'); stop(); } };
  const done = new Promise(resolveDone => {
    child.once('error', fail); child.once('close', (code, childSignal) => resolveDone({ code, childSignal }));
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('error', fail); stream.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) fail(); });
  }
  child.stdin.on('error', fail); signal?.addEventListener('abort', fail, { once: true });
  const timer = setTimeout(fail, 10_000); timer.unref();
  try {
    if (signal?.aborted) fail(); child.stdin.end();
    const result = await done;
    if (failed) throw failure;
    check(result.code === 0 && !result.childSignal, 'recipient-validation-failed');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', fail); stop(); await done; }
}
// Call before constructing any source reader. Confirmation is supplied by the owning
// human-reviewed configuration, never generated from an agent's private key.
export async function validateRecipient({ ownerConfirmed, recipientId, expectedRecipientId, recipient,
  expectedRecipient, expectedRecipientSha256, toolchain, signal }) {
  check(ownerConfirmed === true && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(recipientId ?? '')
    && recipientId === expectedRecipientId, 'owner-recipient-confirmation');
  check(typeof recipient === 'string' && /^age1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{58}$/.test(recipient)
    && recipient === expectedRecipient && /^[a-f0-9]{64}$/.test(expectedRecipientSha256 ?? '')
    && hash(Buffer.from(recipient)) === expectedRecipientSha256, 'owner-recipient-pin');
  await assertAgeToolchain(toolchain); await recipientProbe(toolchain, recipient, signal);
  const result = Object.freeze({ recipient, recipientId, recipientSha256: expectedRecipientSha256 });
  recipients.add(result); return result;
}

function tarHeader(path, size) {
  safeKey(path); const header = Buffer.alloc(512); let name = path, prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const split = path.lastIndexOf('/'); prefix = path.slice(0, split); name = path.slice(split + 1);
  }
  check(Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155, 'ustar-path');
  header.write(name, 0, 100); header.write(prefix, 345, 155);
  const octal = (value, offset, length) => {
    const text = value.toString(8); check(text.length < length, 'ustar-number');
    header.write(text.padStart(length - 1, '0') + '\0', offset, length);
  };
  octal(0o600, 100, 8); octal(0, 108, 8); octal(0, 116, 8); octal(size, 124, 12); octal(0, 136, 12);
  header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257, 6); header.write('00', 263, 2);
  const sum = header.reduce((n, byte) => n + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8); return header;
}
// Pure metadata admission. Call on batchPlan's fully reviewed selection before
// constructing a reader; receipt maxima are conservative, never invented bytes.
export function validateArchivePlan(reviewed) {
  check(reviewed && Array.isArray(reviewed.selectedComponents) && Buffer.isBuffer(reviewed.pointer)
    && Buffer.isBuffer(reviewed.snapshot), 'archive-review-input');
  const tree = batchExpectedTree(reviewed.selectedComponents, reviewed.pointer, reviewed.snapshot);
  check(tree.files.size <= ENCRYPTION_LIMITS.files, 'archive-file-count');
  let archiveMaximumBytes = 1024, copiedPayloadBytes = 0, metadataAllowanceBytes = 0;
  for (const [path, size] of tree.files) {
    check(Number.isSafeInteger(size) && size >= 0, 'archive-file-size'); tarHeader(path, size);
    archiveMaximumBytes += 512 + Math.ceil(size / 512) * 512;
    if (path.includes('/payload/')) copiedPayloadBytes += size; else metadataAllowanceBytes += size;
  }
  check(Number.isSafeInteger(archiveMaximumBytes) && metadataAllowanceBytes <= 128 * 1024 ** 2
    && archiveMaximumBytes <= ENCRYPTION_LIMITS.archive, 'archive-byte-limit');
  const ciphertextMaximumBytes = archiveMaximumBytes + 4 * 1024 ** 2;
  check(ciphertextMaximumBytes <= ENCRYPTION_LIMITS.ciphertext, 'ciphertext-byte-limit');
  return Object.freeze({ archiveFileCount: tree.files.size, copiedPayloadBytes, metadataAllowanceBytes,
    archiveMaximumBytes, ciphertextMaximumBytes, minimumFreeBytes: ciphertextMaximumBytes + ENCRYPTION_LIMITS.reserve });
}
async function* archiveBytes(batch, budget) {
  for (const file of batch.files) {
    await budget(); const full = join(batch.root, safeKey(file.path)); await directory(dirname(full));
    const before = await lstat(full, { bigint: true }); check(same(before, file.info), 'verified-input-changed');
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      check(same(before, await handle.stat({ bigint: true })), 'verified-input-replaced');
      yield tarHeader(file.path, file.size);
      const digest = createHash('sha256'); let count = 0;
      const buffer = Buffer.alloc(65536);
      while (count < file.size) {
        await budget(); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - count), count);
        check(bytesRead > 0, 'verified-input-short'); count += bytesRead;
        const chunk = Buffer.from(buffer.subarray(0, bytesRead)); digest.update(chunk); yield chunk;
      }
      check(digest.digest('hex') === file.sha256 && same(before, await handle.stat({ bigint: true }))
        && same(before, await lstat(full, { bigint: true })), 'verified-input-changed');
      const padding = (512 - file.size % 512) % 512; if (padding) yield Buffer.alloc(padding);
    } finally { await handle.close(); }
  }
  await budget(); yield Buffer.alloc(1024);
}
async function removeOwned(path, info) {
  if (!info) return; const current = await lstat(path, { bigint: true }).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!current) return;
  check(current.isDirectory() && current.dev === info.dev && current.ino === info.ino, 'cleanup-ownership-changed');
  await rm(path, { recursive: true, force: true });
}
export async function encryptBatch({ verifiedBatch, recipient, toolchain, destination, signal }, {
  disk = statfs, now = Date.now, milliseconds = ENCRYPTION_LIMITS.milliseconds,
  maximumCiphertextBytes = ENCRYPTION_LIMITS.ciphertext, onCleanup = () => {}, removeOwnedPath = removeOwned } = {}) {
  check(isVerifiedBatch(verifiedBatch) && tools.has(toolchain) && recipients.has(recipient), 'unverified-encryption-input');
  check(typeof onCleanup === 'function' && typeof removeOwnedPath === 'function', 'encryption-cleanup-interface');
  check(Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= ENCRYPTION_LIMITS.milliseconds
    && Number.isSafeInteger(maximumCiphertextBytes) && maximumCiphertextBytes > 0
    && maximumCiphertextBytes <= ENCRYPTION_LIMITS.ciphertext, 'encryption-limits');
  check(isAbsolute(destination) && resolve(destination) === destination && destination !== '/', 'canonical-destination');
  check(!contains(verifiedBatch.root, destination) && !contains(destination, verifiedBatch.root), 'overlapping-destination');
  const parent = dirname(destination); await directory(parent);
  try { await lstat(destination); throw new Error('existing-destination'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  check(verifiedBatch.files.length <= ENCRYPTION_LIMITS.files, 'archive-file-count');
  const expectedArchiveBytes = 1024 + verifiedBatch.files.reduce((n, f) => n + 512 + Math.ceil(f.size / 512) * 512, 0);
  check(expectedArchiveBytes <= ENCRYPTION_LIMITS.archive, 'archive-byte-limit');
  const deadline = now() + milliseconds; let interrupted = false, recordBudgetFailure = () => {};
  const budget = async () => {
    try {
      check(!interrupted && !signal?.aborted && now() < deadline, 'encryption-interrupted-or-deadline');
      const available = await disk(parent);
      check(available.bavail * available.bsize >= ENCRYPTION_LIMITS.reserve, 'encryption-disk-reserve');
      check(!interrupted && !signal?.aborted && now() < deadline, 'encryption-interrupted-or-deadline');
    } catch (error) {
      // Streams interpret falsy callback errors as success; remember the actual
      // budget failure before passing it through any stream machinery.
      recordBudgetFailure(error); throw error;
    }
  };
  await budget(); const available = await disk(parent);
  check(available.bavail * available.bsize >= expectedArchiveBytes + 4 * 1024 ** 2 + ENCRYPTION_LIMITS.reserve, 'encryption-free-disk');
  let reservation, work, workInfo, child, complete = false, firstError, failed = false, close, timer, hasPrimary = false;
  const stop = () => { try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} };
  const fail = error => { if (!failed) { failed = true; firstError = error; stop(); } };
  recordBudgetFailure = fail;
  const cancelled = () => { interrupted = true; fail(new Error('encryption-interrupted-or-deadline')); };
  signal?.addEventListener('abort', cancelled, { once: true }); process.on('SIGINT', cancelled); process.on('SIGTERM', cancelled);
  let output;
  try {
    await mkdir(destination, { mode: 0o700 }); reservation = await lstat(destination, { bigint: true });
    await budget(); work = await mkdtemp(join(parent, '.train3-ciphertext-')); workInfo = await lstat(work, { bigint: true }); await budget();
    await assertAgeToolchain(toolchain); await budget();
    child = spawn(toolchain.ageBinary, ['--encrypt', '--recipient', recipient.recipient], {
      stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: environment(work), cwd: work,
    });
    close = new Promise(resolveClose => {
      child.once('error', () => fail(new Error('age-process-failed')));
      child.once('close', (code, childSignal) => resolveClose({ code, childSignal }));
    });
    child.stdin.on('error', fail); child.stdout.on('error', fail);
    let diagnosticBytes = 0; child.stderr.on('data', chunk => {
      diagnosticBytes += chunk.length; if (diagnosticBytes > ENCRYPTION_LIMITS.diagnostics) fail(new Error('age-diagnostic-limit'));
    }); child.stderr.on('error', () => fail(new Error('age-process-failed')));
    timer = setTimeout(cancelled, Math.max(1, deadline - now())); timer.unref();
    const file = await open(join(work, 'batch.age'), 'wx', 0o600); output = file.createWriteStream();
    const digest = createHash('sha256'); let ciphertextBytes = 0, plaintextBytes = 0;
    const cipherBound = new Transform({ transform(chunk, _encoding, callback) {
      ciphertextBytes += chunk.length;
      if (ciphertextBytes > maximumCiphertextBytes) callback(new Error('ciphertext-byte-limit'));
      else { digest.update(chunk); budget().then(() => callback(null, chunk), callback); }
    } });
    const archiveBound = new Transform({ transform(chunk, _encoding, callback) {
      plaintextBytes += chunk.length;
      callback(plaintextBytes > expectedArchiveBytes ? new Error('archive-byte-limit') : null, chunk);
    } });
    const jobs = [pipeline(Readable.from(archiveBytes(verifiedBatch, budget)), archiveBound, child.stdin),
      pipeline(child.stdout, cipherBound, output)].map(job => job.catch(error => { fail(error); throw error; }));
    const settled = await Promise.allSettled(jobs); const result = await close;
    if (failed) throw firstError;
    check(settled.every(row => row.status === 'fulfilled') && result.code === 0 && !result.childSignal
      && plaintextBytes === expectedArchiveBytes && ciphertextBytes > 0, 'age-process-failed');
    await budget();
    const receipt = { schemaVersion: 1, kind: 'weatherx-train3-encrypted-baseline-batch-v1', ageVersion: toolchain.ageVersion,
      recipientSha256: recipient.recipientSha256, ciphertextSha256: digest.digest('hex'), ciphertextBytes,
      archiveFormat: 'ustar-v1', completeBaselineEligible: false, publicationAuthorized: false };
    const receiptBytes = Buffer.from(JSON.stringify(receipt) + '\n'); check(receiptBytes.length <= ENCRYPTION_LIMITS.receipt, 'encrypted-receipt-limit');
    await writeFile(join(work, 'encrypted-receipt.json'), receiptBytes, { flag: 'wx', mode: 0o600 }); await budget();
    const current = await lstat(destination, { bigint: true });
    check(current.isDirectory() && current.dev === reservation.dev && current.ino === reservation.ino, 'destination-ownership-changed');
    await rename(work, destination); reservation = workInfo; work = null; await budget(); complete = true; return receipt;
  } catch (error) { hasPrimary = true; throw error;
  } finally {
    stop(); child?.stdin.destroy(); child?.stdout.resume(); child?.stderr.resume();
    if (close) await close; output?.destroy();
    let cleanupError, hasCleanupError = false;
    try { if (complete) await budget(); } catch (error) { cleanupError = error; hasCleanupError = true; }
    clearTimeout(timer);
    try { if (work) await removeOwnedPath(work, workInfo); } catch (error) { if (!hasCleanupError) cleanupError = error; hasCleanupError = true; }
    try { if (!complete || interrupted || signal?.aborted || hasCleanupError) await removeOwnedPath(destination, reservation); }
    catch (error) { if (!hasCleanupError) cleanupError = error; hasCleanupError = true; }
    // Advisory synchronous status only: no paths or messages leave this layer.
    // A diagnostics consumer cannot replace the primary lifecycle error.
    try { onCleanup(hasCleanupError ? 'failed' : 'passed'); } catch {}
    signal?.removeEventListener('abort', cancelled); process.removeListener('SIGINT', cancelled); process.removeListener('SIGTERM', cancelled);
    if (hasCleanupError && !hasPrimary) throw cleanupError;
    if (!hasPrimary && (interrupted || signal?.aborted)) throw failed ? firstError : new Error('encryption-interrupted-or-deadline');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5 || process.argv[2] !== 'prepare-toolchain' || process.argv[3] !== '--destination') {
    console.error('Invalid public tool preparation command.'); process.exitCode = 1;
  } else prepareAgeToolchain({ destination: process.argv[4] }).then(() => console.log('Pinned public age toolchain prepared.'))
    .catch(() => { console.error('Pinned public age tool preparation failed.'); process.exitCode = 1; });
}
