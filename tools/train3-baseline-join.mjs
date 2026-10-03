// Credentialless join of three reviewed, locally quiescent original-byte artifacts.
// Content pins authenticate bytes; receipt labels do not authenticate a runner or science.
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import { batchPlan, CORE, IDS, LIMITS, hash, producerOrder, safeKey } from './train3-baseline-preparation.mjs';

const RESERVE = 1024 ** 3, RECEIPT_CAP = 1024 ** 2, SEAL_CAP = 16 * 1024 ** 2;
const check = (ok, code) => { if (!ok) throw new Error(code); };
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...fields].sort());
const parse = bytes => JSON.parse(bytes.toString('utf8'));
const encoded = value => Buffer.from(JSON.stringify(value) + '\n');
const coreId = id => CORE.includes(id.replace(/^point-/, ''));
const identity = info => [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs];
const same = (a, b) => isDeepStrictEqual(identity(a), identity(b));
const contains = (a, b) => b === a || b.startsWith(a + sep);

async function directory(path) {
  check(typeof path === 'string' && isAbsolute(path) && resolve(path) === path && path !== '/', 'canonical-directory');
  let current = '/';
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current, { bigint: true });
    check(info.isDirectory() && !info.isSymbolicLink(), 'directory-link-or-non-directory');
  }
  return lstat(path, { bigint: true });
}

export async function readRegular(root, path, cap, expectedSize) {
  safeKey(path); await directory(dirname(join(root, path)));
  const full = join(root, path), before = await lstat(full, { bigint: true });
  check(before.isFile() && before.nlink === 1n && before.size <= BigInt(cap)
    && (expectedSize === undefined || before.size === BigInt(expectedSize)), 'input-file-type-size');
  const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true }); check(same(before, opened), 'input-file-replaced');
    const bytes = await handle.readFile();
    check(bytes.length <= cap && BigInt(bytes.length) === before.size
      && same(before, await handle.stat({ bigint: true })), 'input-file-changed');
    check(same(before, await lstat(full, { bigint: true })), 'input-file-replaced');
    await directory(dirname(full)); return { bytes, info: before };
  } finally { await handle.close(); }
}

export function batchExpectedTree(selected, pointer, snapshot) {
  const files = new Map([
    ['batch-receipt.json', RECEIPT_CAP], ['acquisition-receipt.json', RECEIPT_CAP],
    ['original/catalog-pointer.json', pointer.length], ['original/catalog-snapshot.json', snapshot.length],
    ['core/catalog-pointer.json', pointer.length], ['core/catalog-snapshot.json', snapshot.length],
  ]);
  for (const item of selected) {
    const raw = Buffer.from(item.manifestBase64, 'base64'), entryPrefix = parse(raw).rootPrefix;
    files.set(`original/components/${item.id}/component.json`, raw.length);
    if (coreId(item.id)) files.set(`core/components/${item.id}/manifest.json`, raw.length);
    for (const row of item.objects) {
      const path = safeKey(row.key.slice(entryPrefix.length));
      files.set(`original/components/${item.id}/payload/${path}`, row.bytes);
      if (coreId(item.id)) files.set(`core/components/${item.id}/payload/${path}`, row.bytes);
    }
  }
  const directories = new Set(['']);
  for (const path of files.keys()) {
    let parent = dirname(path);
    while (parent !== '.') { directories.add(parent); parent = dirname(parent); }
  }
  return { files, directories };
}

// This is a polled allocation estimate, not a quota or exclusion of other writers.
// Charge rounded data, one allocation block per file for inode/extent metadata,
// and two rounded directory-entry blocks plus one inode block per directory.
// Directory entries include a conservative 256-byte overhead and the actual name.
export function allocationEstimate(files, blockSize) {
  check(Number.isSafeInteger(blockSize) && blockSize > 0 && blockSize <= 1024 ** 2, 'filesystem-block-size');
  check(files instanceof Map, 'allocation-files');
  const rounded = bytes => Math.ceil(bytes / blockSize) * blockSize;
  const entries = new Map([['', new Map()]]);
  let rawBytes = 0, dataBytes = 0;
  for (const [path, size] of files) {
    safeKey(path); check(Number.isSafeInteger(size) && size >= 0, 'allocation-file-size');
    rawBytes += size; dataBytes += rounded(size);
    const parts = path.split('/'); let parent = '';
    for (let i = 0; i < parts.length; i++) {
      entries.get(parent).set(parts[i], 256 + Buffer.byteLength(parts[i]));
      if (i + 1 < parts.length) {
        parent = parent ? `${parent}/${parts[i]}` : parts[i];
        if (!entries.has(parent)) entries.set(parent, new Map());
      }
    }
  }
  let directoryBytes = 0;
  for (const names of entries.values())
    directoryBytes += blockSize + 2 * rounded(512 + [...names.values()].reduce((sum, bytes) => sum + bytes, 0));
  const fileMetadataBytes = files.size * blockSize;
  const allocationBytes = dataBytes + fileMetadataBytes + directoryBytes;
  check(Number.isSafeInteger(rawBytes) && Number.isSafeInteger(allocationBytes), 'allocation-overflow');
  return Object.freeze({ rawBytes, dataBytes, fileMetadataBytes, directoryBytes,
    fileCount: files.size, directoryCount: entries.size, allocationBytes });
}

function capacityForReviewed(reviewed, blockSize) {
  const first = reviewed[0], decoded = reviewed.map(row => allocationEstimate(
    batchExpectedTree(row.selectedComponents, row.pointer, row.snapshot).files, blockSize));
  const joinedFiles = batchExpectedTree(first.plan.components, first.pointer, first.snapshot).files;
  joinedFiles.delete('batch-receipt.json'); joinedFiles.delete('acquisition-receipt.json');
  joinedFiles.set('core/seal.json', SEAL_CAP); joinedFiles.set('join-receipt.json', RECEIPT_CAP);
  const joined = allocationEstimate(joinedFiles, blockSize);
  // Fresh work/destination reservations and growth in the existing parent directory.
  // Decryption additionally retains a <=4096-byte identity and three batch roots.
  // Batch roots and joined work root are already included in their tree estimates.
  const joinScratchBytes = 8 * blockSize;
  const decryptScratchBytes = 32 * blockSize + Math.ceil(4096 / blockSize) * blockSize + blockSize;
  const decodedAllocationBytes = decoded.reduce((sum, row) => sum + row.allocationBytes, 0);
  const decodedRawBytes = decoded.reduce((sum, row) => sum + row.rawBytes, 0);
  const result = { blockSize, reserveBytes: RESERVE, decoded: Object.freeze(decoded), joined,
    decodedRawBytes, decodedAllocationBytes, joinScratchBytes, decryptScratchBytes,
    joinAdditionalBytes: joined.allocationBytes + joinScratchBytes + RESERVE,
    decryptAdditionalBytes: decodedAllocationBytes + joined.allocationBytes + joinScratchBytes + decryptScratchBytes + RESERVE };
  check(Number.isSafeInteger(result.decryptAdditionalBytes), 'allocation-overflow');
  return Object.freeze(result);
}

// Independently authenticate the complete plan and exact three-batch partition
// before deriving any capacity from sizes, manifests, catalog bytes or core copies.
export function baselineCapacity({ planBytes, planSha256, batchPlanBytes, batchPlanSha256, blockSize }) {
  check(Buffer.isBuffer(planBytes) && planBytes.length <= LIMITS.plan
    && Buffer.isBuffer(batchPlanBytes) && batchPlanBytes.length <= LIMITS.plan, 'plan-bytes');
  const partition = parse(batchPlanBytes), catalogId = parse(planBytes).catalogId;
  check(Array.isArray(partition.batches) && partition.batches.length === 3, 'three-batch-partition');
  return capacityForReviewed(partition.batches.map(row => batchPlan(planBytes, planSha256,
    batchPlanBytes, batchPlanSha256, row.id, catalogId)), blockSize);
}

async function inventoryTree(root, tree) {
  const identities = new Map();
  async function visit(path) {
    const full = path ? join(root, path) : root, info = await lstat(full, { bigint: true });
    check(!info.isSymbolicLink(), 'input-symlink'); identities.set(path, info);
    if (info.isDirectory()) {
      check(tree.directories.has(path), 'unexpected-directory');
      for (const name of await readdir(full)) await visit(path ? `${path}/${name}` : name);
    } else {
      check(info.isFile() && info.nlink === 1n && tree.files.has(path), 'unexpected-or-linked-file');
      check(info.size <= BigInt(tree.files.get(path)), 'input-file-size');
    }
  }
  await visit('');
  check(identities.size === tree.files.size + tree.directories.size
    && [...tree.files.keys(), ...tree.directories].every(path => identities.has(path)), 'missing-input-path');
  return identities;
}

async function unchanged(root, tree, before) {
  const after = await inventoryTree(root, tree);
  check(after.size === before.size && [...before].every(([path, info]) => same(info, after.get(path))), 'input-tree-changed');
  await directory(root);
}

async function removeOwned(path, info) {
  if (!path || !info) return;
  let current;
  try { current = await lstat(path, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  check(current.isDirectory() && current.dev === info.dev && current.ino === info.ino, 'cleanup-ownership-changed');
  await rm(path, { recursive: true, force: true });
}

const verifiedBatches = new WeakSet();
const verifiedStates = new WeakMap();
export const isVerifiedBatch = value => verifiedBatches.has(value);
function freeze(value) {
  if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

// Read-only byte admission shared by local joining and standard-tool encryption.
export async function verifyBatch({ planBytes, planSha256, batchPlanBytes, batchPlanSha256,
  batchDirectory: root, expectedSourceSha }, { inputRead = readRegular, onFile = async () => {}, budget = () => {} } = {}) {
  check(/^[a-f0-9]{40}$/.test(expectedSourceSha ?? ''), 'expected-source');
  check(Buffer.isBuffer(planBytes) && planBytes.length <= LIMITS.plan && Buffer.isBuffer(batchPlanBytes)
    && batchPlanBytes.length <= LIMITS.plan, 'plan-bytes');
  const catalogId = parse(planBytes).catalogId, partition = parse(batchPlanBytes);
  check(Array.isArray(partition.batches) && partition.batches.length === 3, 'three-batch-partition');
  const reviewed = partition.batches.map(row => batchPlan(planBytes, planSha256, batchPlanBytes, batchPlanSha256, row.id, catalogId));
  await directory(root);
  const { pointer, snapshot } = reviewed[0], components = [], files = [], reader = inputRead;
  inputRead = async (...args) => {
    budget(); const result = await reader(...args);
    files.push({ path: args[1], size: result.bytes.length, sha256: hash(result.bytes), info: result.info });
    return result;
  };
  const receiptRead = await inputRead(root, 'batch-receipt.json', RECEIPT_CAP);
  const receiptRaw = receiptRead.bytes, receipt = parse(receiptRaw);
  check(exact(receipt, ['schemaVersion', 'kind', 'catalogId', 'reviewedPlanSha256', 'reviewedBatchPlanSha256',
    'batchId', 'catalogSha256', 'sourceSha', 'runId', 'runAttempt', 'completeBaselineEligible', 'coreSealSha256',
    'components', 'scientificValidationPerformed', 'publicationAuthorized']) && receipt.schemaVersion === 1
    && receipt.kind === 'weatherx-train3-original-baseline-batch-v1' && receipt.catalogId === catalogId
    && receipt.reviewedPlanSha256 === planSha256 && receipt.reviewedBatchPlanSha256 === batchPlanSha256
    && receipt.catalogSha256 === parse(pointer).catalogSha256 && receipt.sourceSha === expectedSourceSha
    && /^[1-9][0-9]{0,19}$/.test(receipt.runId ?? '') && /^[1-9][0-9]{0,19}$/.test(receipt.runAttempt ?? '')
    && receipt.completeBaselineEligible === false && receipt.coreSealSha256 === null
    && receipt.scientificValidationPerformed === false && receipt.publicationAuthorized === false, 'batch-receipt-binding');
  const selected = reviewed.find(row => row.batchId === receipt.batchId);
  check(selected, 'missing-or-duplicate-batch');
  const tree = batchExpectedTree(selected.selectedComponents, pointer, snapshot), before = await inventoryTree(root, tree);
  check(same(receiptRead.info, before.get('batch-receipt.json')), 'receipt-changed-before-tree-audit');
  for (const [path, bytes] of [['original/catalog-pointer.json', pointer], ['core/catalog-pointer.json', pointer],
    ['original/catalog-snapshot.json', snapshot], ['core/catalog-snapshot.json', snapshot]])
    check((await inputRead(root, path, bytes.length, bytes.length)).bytes.equals(bytes), 'catalog-bytes');
  const acquisitionRaw = (await inputRead(root, 'acquisition-receipt.json', RECEIPT_CAP)).bytes, acquisition = parse(acquisitionRaw);
  const expectedRequests = selected.selectedComponents.reduce((sum, item) => sum + item.objects.length, 0)
    + selected.selectedComponents.length + 3;
  const expectedWireBytes = selected.total + pointer.length * 2 + snapshot.length
    + selected.selectedComponents.reduce((sum, item) => sum + Buffer.from(item.manifestBase64, 'base64').length, 0);
  check(exact(acquisition, ['operation', 'catalogId', 'sourceSha', 'batchId', 'reviewedPlanSha256',
    'reviewedBatchPlanSha256', 'requests', 'wireBytes', 'publicationAuthorized'])
    && acquisition.operation === 'batch-export' && acquisition.catalogId === catalogId
    && acquisition.sourceSha === expectedSourceSha && acquisition.batchId === receipt.batchId
    && acquisition.reviewedPlanSha256 === planSha256 && acquisition.reviewedBatchPlanSha256 === batchPlanSha256
    && Number.isSafeInteger(acquisition.requests) && acquisition.requests === expectedRequests && acquisition.requests <= LIMITS.exportRequests
    && Number.isSafeInteger(acquisition.wireBytes) && acquisition.wireBytes === expectedWireBytes
    && acquisition.wireBytes <= LIMITS.metadata + LIMITS.payload && acquisition.publicationAuthorized === false, 'acquisition-receipt-binding');
  check(Array.isArray(receipt.components) && receipt.components.length === selected.selectedComponents.length
    && new Set(receipt.components.map(row => row.componentId)).size === receipt.components.length, 'batch-component-receipts');
  for (const item of selected.selectedComponents) {
    budget(); const raw = Buffer.from(item.manifestBase64, 'base64'), manifest = parse(raw);
    const path = `original/components/${item.id}/component.json`;
    check((await inputRead(root, path, raw.length, raw.length)).bytes.equals(raw), 'manifest-bytes');
    await onFile(path, raw);
    if (coreId(item.id)) {
      const corePath = `core/components/${item.id}/manifest.json`;
      check((await inputRead(root, corePath, raw.length, raw.length)).bytes.equals(raw), 'core-manifest-bytes');
      await onFile(corePath, raw, true);
    }
    const rows = [];
    for (const object of item.objects) {
      budget(); const suffix = safeKey(object.key.slice(manifest.rootPrefix.length));
      const originalPath = `original/components/${item.id}/payload/${suffix}`;
      const bytes = (await inputRead(root, originalPath, Math.min(object.bytes, LIMITS.object), object.bytes)).bytes;
      const row = { path: suffix, size: bytes.length, sha256: hash(bytes) }; rows.push(row);
      await onFile(originalPath, bytes);
      if (coreId(item.id)) {
        const corePath = `core/components/${item.id}/payload/${suffix}`;
        check((await inputRead(root, corePath, bytes.length, bytes.length)).bytes.equals(bytes), 'core-payload-bytes');
        await onFile(corePath, bytes, true);
      }
    }
    rows.sort(producerOrder);
    check(rows.length === manifest.objectCount && hash(JSON.stringify(rows)) === manifest.inventorySha256, 'original-inventory-hash');
    const component = { componentId: item.id, manifestSha256: hash(raw), inventorySha256: manifest.inventorySha256,
      objectCount: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0) };
    check(isDeepStrictEqual(receipt.components.find(row => row.componentId === item.id), component), 'component-receipt-mismatch');
    components.push(component);
  }
  await unchanged(root, tree, before);
  const batchReceipt = { batchId: receipt.batchId, sourceSha: receipt.sourceSha, runId: receipt.runId,
    runAttempt: receipt.runAttempt, batchReceiptSha256: hash(receiptRaw), acquisitionReceiptSha256: hash(acquisitionRaw) };
  files.sort((a, b) => a.path < b.path ? -1 : 1);
  check(files.length === tree.files.size, 'incomplete-verified-files');
  const immutableReviewed = { ...selected };
  delete immutableReviewed.pointer; delete immutableReviewed.snapshot;
  Object.defineProperties(immutableReviewed, {
    pointer: { enumerable: true, get: () => Buffer.from(selected.pointer) },
    snapshot: { enumerable: true, get: () => Buffer.from(selected.snapshot) },
  });
  const result = freeze({ root, reviewed: immutableReviewed, files, receipt, acquisition, components, batchReceipt });
  verifiedStates.set(result, { root, tree, before });
  // Test-only alternate readers cannot mint the encryption admission capability.
  if (reader === readRegular) verifiedBatches.add(result);
  return result;
}

export async function joinBaseline({ planBytes, planSha256, batchPlanBytes, batchPlanSha256,
  batchDirectories, destination, expectedSourceSha }, { disk = statfs, now = Date.now, signal,
  inputRead = readRegular } = {}) {
  check(/^[a-f0-9]{40}$/.test(expectedSourceSha ?? ''), 'expected-source');
  check(Buffer.isBuffer(planBytes) && planBytes.length <= LIMITS.plan
    && Buffer.isBuffer(batchPlanBytes) && batchPlanBytes.length <= LIMITS.plan, 'plan-bytes');
  const catalogId = parse(planBytes).catalogId, partition = parse(batchPlanBytes);
  check(Array.isArray(partition.batches) && partition.batches.length === 3, 'three-batch-partition');
  const reviewed = partition.batches.map(row => batchPlan(planBytes, planSha256,
    batchPlanBytes, batchPlanSha256, row.id, catalogId));
  check(Array.isArray(batchDirectories) && batchDirectories.length === 3, 'three-batch-inputs');
  check(typeof destination === 'string' && isAbsolute(destination) && resolve(destination) === destination
    && destination !== '/', 'canonical-destination');
  const parent = dirname(destination); await directory(parent);
  for (const root of batchDirectories) await directory(root);
  const roots = [...batchDirectories, destination];
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++)
    check(!contains(roots[i], roots[j]) && !contains(roots[j], roots[i]), 'overlapping-input-output');
  const total = reviewed[0].plan.payloadBytes;
  check(Number.isSafeInteger(total) && total > 0 && total <= 3 * LIMITS.payload, 'joined-payload-bound');
  const initialDisk = await disk(parent), capacity = capacityForReviewed(reviewed, initialDisk.bsize);
  const free = async minimum => { const value = await disk(parent);
    check(value.bsize === capacity.blockSize && value.bavail * value.bsize >= minimum, 'free-disk-budget'); };
  check(initialDisk.bavail * initialDisk.bsize >= capacity.joinAdditionalBytes, 'free-disk-budget');
  let cancelled = false;
  const deadline = now() + LIMITS.milliseconds, cancel = () => { cancelled = true; };
  const budget = () => check(!cancelled && !signal?.aborted && now() < deadline, 'interrupted-or-deadline');
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  let work, workInfo, destinationInfo, complete = false, primary;
  try {
    budget();
    // mkdir exclusively reserves the destination. Final rename replaces only this
    // invocation's unchanged empty reservation, never a pre-existing directory.
    await mkdir(destination, { mode: 0o700 }); destinationInfo = await lstat(destination, { bigint: true });
    work = await mkdtemp(join(parent, '.train3-baseline-join-')); workInfo = await lstat(work, { bigint: true });
    const coreFiles = [], components = [], batchReceipts = [], seen = new Set(), states = [];
    async function save(path, bytes, core = false) {
      budget(); safeKey(path);
      await free(RESERVE + allocationEstimate(new Map([[path, bytes.length]]), capacity.blockSize).allocationBytes);
      await mkdir(dirname(join(work, path)), { recursive: true, mode: 0o700 });
      const handle = await open(join(work, path), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      try { await handle.writeFile(bytes); } finally { await handle.close(); }
      budget(); await free(RESERVE); const row = { path, size: bytes.length, sha256: hash(bytes) };
      if (core) coreFiles.push({ ...row, path: path.slice('core/'.length) });
      return row;
    }
    const { pointer, snapshot } = reviewed[0];
    await save('original/catalog-pointer.json', pointer); await save('original/catalog-snapshot.json', snapshot);
    await save('core/catalog-pointer.json', pointer, true); await save('core/catalog-snapshot.json', snapshot, true);
    for (const root of batchDirectories) {
      budget();
      const verified = await verifyBatch({ planBytes, planSha256, batchPlanBytes, batchPlanSha256,
        batchDirectory: root, expectedSourceSha }, { inputRead, budget, onFile: save });
      check(!seen.has(verified.receipt.batchId), 'missing-or-duplicate-batch'); seen.add(verified.receipt.batchId);
      states.push(verifiedStates.get(verified)); components.push(...verified.components); batchReceipts.push(verified.batchReceipt);
    }
    check(seen.size === 3 && components.length === IDS.length && new Set(components.map(row => row.componentId)).size === IDS.length
      && IDS.every(id => components.some(row => row.componentId === id))
      && components.reduce((sum, row) => sum + row.bytes, 0) === total, 'incomplete-joined-baseline');
    // Re-audit every private input before publishing the complete joined seal.
    for (const state of states) await unchanged(state.root, state.tree, state.before);
    coreFiles.sort((a, b) => a.path < b.path ? -1 : 1);
    const seal = encoded({ schemaVersion: 1, kind: 'weatherx-validation-catalog-baseline-v1', files: coreFiles });
    check(seal.length <= SEAL_CAP, 'seal-budget'); await save('core/seal.json', seal);
    components.sort((a, b) => IDS.indexOf(a.componentId) - IDS.indexOf(b.componentId));
    batchReceipts.sort((a, b) => a.batchId < b.batchId ? -1 : 1);
    const receipt = { schemaVersion: 1, kind: 'weatherx-train3-original-baseline-join-v1', catalogId,
      reviewedPlanSha256: planSha256, reviewedBatchPlanSha256: batchPlanSha256,
      catalogSha256: parse(pointer).catalogSha256, sourceSha: expectedSourceSha, coreSealSha256: hash(seal),
      components, batches: batchReceipts, scientificValidationPerformed: false, publicationAuthorized: false };
    const receiptBytes = encoded(receipt); check(receiptBytes.length <= RECEIPT_CAP, 'join-receipt-budget');
    await save('join-receipt.json', receiptBytes); budget(); await free(RESERVE);
    check(same(destinationInfo, await lstat(destination, { bigint: true })) && (await readdir(destination)).length === 0,
      'destination-reservation-changed');
    await rename(work, destination); destinationInfo = workInfo; work = undefined; workInfo = undefined;
    budget(); complete = true; return receipt;
  } catch (error) { primary = error; throw error; }
  finally {
    let cleanupError;
    try { await removeOwned(work, workInfo); } catch (error) { cleanupError = error; }
    const interrupted = cancelled || signal?.aborted || now() >= deadline;
    if (!complete || cleanupError || interrupted) try { await removeOwned(destination, destinationInfo); } catch (error) { cleanupError ??= error; }
    process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    if (cleanupError) throw new Error(primary ? 'join-refused-cleanup-failed' : 'join-cleanup-failed', { cause: primary ?? cleanupError });
    if (complete && interrupted) throw new Error('interrupted-or-deadline');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  (async () => {
    check(args.length === 9, 'usage: join PLAN SHA BATCH_PLAN SHA SOURCE_SHA DEST BATCH1 BATCH2 BATCH3');
    const [plan, planSha256, batches, batchPlanSha256, expectedSourceSha, destination, ...batchDirectories] = args;
    const planBytes = (await readRegular(dirname(resolve(plan)), relative(dirname(resolve(plan)), resolve(plan)), LIMITS.plan)).bytes;
    const batchPlanBytes = (await readRegular(dirname(resolve(batches)), relative(dirname(resolve(batches)), resolve(batches)), LIMITS.plan)).bytes;
    await joinBaseline({ planBytes, planSha256, batchPlanBytes, batchPlanSha256, expectedSourceSha, destination, batchDirectories });
    console.log('Train 3 original baseline join complete.');
  })().catch(() => { console.error('Train 3 original baseline join refused.'); process.exitCode = 1; });
}
