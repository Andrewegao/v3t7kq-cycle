// Dedicated staging-place transport. No storage credentials, publication or generic archive extraction.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, constants } from 'node:fs';
import { open, mkdir, rm, realpath, lstat, readdir } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { LIMITS, KINDS, hash, prefix, payloadPath, validateManifest, qualifyPlaces } from './staging-places.mjs';

const MAGIC = Buffer.from('WXPS1\0');
const SHA = /^[a-f0-9]{64}$/;
export const MAX_ARCHIVE = LIMITS.totalBytes + LIMITS.manifestBytes + 8192;
export const PG_EVIDENCE_FILE_BYTES = 32 * 1024 ** 2;
const EVIDENCE_KINDS = { tides: 'tide-checkpoint', paragliding: 'paragliding-snapshot', surf: 'surf-stage' };
const bytes = value => Buffer.from(JSON.stringify(value) + '\n');
function seedKey(value) { assert(SHA.test(value ?? ''), 'dedicated 32-byte staging seed key required'); return Buffer.from(value, 'hex'); }
export function noPublishCredentials(env) {
  for (const key of Object.keys(env)) if (/^(?:STAGING_R2_WRITE_|UI_|AWS_|RCLONE_|CLOUDFLARE_|CF_API_|R2_|SHARED_R2_|STAGING_WORKER_)/.test(key)) assert(!env[key], 'foreign credentials refused');
}
async function newPath(path) { assert(isAbsolute(path) && resolve(path) === path); assert.equal(await realpath(dirname(path)), dirname(path)); }
async function write(handle, data) { let offset = 0; while (offset < data.length) { const result = await handle.write(data, offset, data.length - offset); assert(result.bytesWritten > 0); offset += result.bytesWritten; } }
async function read(handle, length, position) { const result = Buffer.alloc(length); let offset = 0; while (offset < length) { const row = await handle.read(result, offset, length - offset, position + offset); assert(row.bytesRead > 0, 'truncated seed'); offset += row.bytesRead; } return result; }
async function regular(path, max) {
  assert(isAbsolute(path) && resolve(path) === path && await realpath(path) === path);
  const stat = await lstat(path); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= max, 'invalid seed file'); return stat;
}
export function inputPath(kind, identity, path) {
  prefix(kind, identity); payloadPath(kind, path);
  if (kind === 'surf') return path;
  if (kind === 'paragliding') return path === 'index.json' ? path : `versions/${identity}/${path}`;
  return path === 'catalog.json' ? 'v2/catalog.json' : path === 'tides.json' ? path : `v2/versions/${identity}/${path}`;
}
function validateHeader(header, pins) {
  assert(header && Object.keys(header).sort().join(',') === 'evidence,identity,kind,manifest,manifestSha256,schemaVersion,sourceSha' && header.schemaVersion === 1);
  assert(/^[a-f0-9]{40}$/.test(header.sourceSha ?? '')); validateManifest(header.manifest);
  assert.equal(header.kind, header.manifest.kind); assert.equal(header.identity, header.manifest.identity);
  assert.equal(header.manifestSha256, hash(bytes(header.manifest)));
  for (const field of ['kind', 'sourceSha', 'manifestSha256']) assert.equal(header[field], pins[field], `seed ${field} pin differs`);
  const evidence = header.evidence;
  if (evidence !== null) {
    assert(evidence?.kind === EVIDENCE_KINDS[header.kind] && Object.keys(evidence).sort().join(',') === 'files,kind');
    assert(Array.isArray(evidence.files) && evidence.files.length > 0); let previous = '';
    for (const file of evidence.files) { assert(Object.keys(file).sort().join(',') === 'bytes,path,sha256'); evidencePath(header.kind, file.path); assert(file.path > previous); previous = file.path;
      assert(Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= evidenceLimit(header.kind, file.path) && SHA.test(file.sha256)); }
    evidenceRoster(header.kind, evidence.files);
  }
  const files = [...header.manifest.files, ...(evidence?.files ?? [])];
  assert(files.length <= LIMITS.files && files.reduce((sum, file) => sum + file.bytes, 0) <= LIMITS.totalBytes, 'combined payload/evidence budget');
  return header;
}
function evidencePath(kind, path) {
  const pattern = kind === 'tides' ? /^(?:manifest\.json|products\/[0-9]{1,16}\/(?:hilo|6)\.json)$/ : kind === 'paragliding' ? /^(?:all-sites|manifest)\.json$/ : kind === 'surf' ? /^stage\.json$/ : /$a/;
  assert(typeof path === 'string' && pattern.test(path), 'unsafe family evidence path'); return path;
}
function evidenceLimit(kind, path) { return kind === 'paragliding' && path === 'all-sites.json' ? PG_EVIDENCE_FILE_BYTES : LIMITS.fileBytes; }
function evidenceRoster(kind, files) {
  if (kind === 'tides') assert.equal(files[0]?.path, 'manifest.json');
  else assert.deepEqual(files.map(file => file.path), kind === 'paragliding' ? ['all-sites.json', 'manifest.json'] : ['stage.json']);
}
export async function checkpointEvidence(root, kind = 'tides') {
  assert(KINDS.includes(kind));
  assert(isAbsolute(root)); root = await realpath(root); const files = [], local = new Map(); let total = 0;
  async function walk(folder = '') { for (const entry of await readdir(resolve(root, folder), { withFileTypes: true })) {
    const path = folder ? `${folder}/${entry.name}` : entry.name; assert(!entry.isSymbolicLink());
    if (entry.isDirectory()) { assert(kind === 'tides' && /^(?:products|products\/[0-9]{1,16})$/.test(path)); await walk(path); }
    else { evidencePath(kind, path); const file = resolve(root, path), stat = await regular(file, evidenceLimit(kind, path)), digest = createHash('sha256'); let count = 0;
      for await (const chunk of createReadStream(file, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, start: 0, end: stat.size })) { count += chunk.length; assert(count <= stat.size); digest.update(chunk); }
      assert.equal(count, stat.size); total += count; assert(total <= LIMITS.totalBytes && files.length < LIMITS.files);
      const receipt = { path, bytes: count, sha256: digest.digest('hex') }; files.push(receipt); local.set(path, { file }); }
  } }
  await walk(); files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  evidenceRoster(kind, files);
  if (kind === 'tides') {
    const manifest = JSON.parse(await readFileSmall(resolve(root, 'manifest.json'))); assert(manifest.kind === 'weatherx-tide-fetch' && Array.isArray(manifest.stations));
    const ids = new Set(manifest.stations.map(row => String(row.id))); assert.equal(ids.size, manifest.stations.length);
    assert(files.every(file => file.path === 'manifest.json' || ids.has(file.path.split('/')[1])), 'checkpoint station outside frozen roster');
  }
  return { document: { kind: EVIDENCE_KINDS[kind], files }, local };
}
async function readFileSmall(path) { const stat = await regular(path, LIMITS.fileBytes); const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { return await read(handle, stat.size, 0); } finally { await handle.close(); } }
export async function packSeed({ candidate, evidence = null, sourceSha, key, output }) {
  const secret = seedKey(key);
  const header = { schemaVersion: 1, kind: candidate.completion.kind, identity: candidate.completion.identity, sourceSha,
    manifestSha256: hash(candidate.manifestBody), manifest: candidate.manifest, evidence: evidence?.document ?? null };
  validateHeader(header, header); const metadata = bytes(header); assert(metadata.length <= LIMITS.manifestBytes + 4096);
  await newPath(output); const target = await open(output, 'wx', 0o600), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, iv); cipher.setAAD(MAGIC);
  const plain = createHash('sha256'), encrypted = createHash('sha256'); let size = 0;
  const emit = async chunk => { encrypted.update(chunk); size += chunk.length; assert(size <= MAX_ARCHIVE); await write(target, chunk); };
  const encrypt = async chunk => { plain.update(chunk); await emit(cipher.update(chunk)); };
  try {
    await emit(Buffer.concat([MAGIC, iv])); const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length); await encrypt(length); await encrypt(metadata);
    for (const [receipt, local, limit] of [...candidate.manifest.files.map(file => [file, candidate.local.get(file.path), LIMITS.fileBytes]), ...(evidence?.document.files ?? []).map(file => [file, evidence.local.get(file.path), evidenceLimit(header.kind, file.path)])]) {
      assert(local); const stat = await regular(local.file, limit); assert.equal(stat.size, receipt.bytes);
      let count = 0; const digest = createHash('sha256');
      const stream = createReadStream(local.file, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, start: 0, end: receipt.bytes });
      try { for await (const chunk of stream) { count += chunk.length; assert(count <= receipt.bytes); digest.update(chunk); await encrypt(chunk); } } finally { stream.destroy(); }
      assert.equal(count, receipt.bytes); assert.equal(digest.digest('hex'), receipt.sha256, 'seed input changed');
    }
    await emit(cipher.final()); await emit(cipher.getAuthTag());
    return { kind: header.kind, sourceSha, manifestSha256: header.manifestSha256, plaintextSha256: plain.digest('hex'), ciphertextSha256: encrypted.digest('hex'), bytes: size };
  } catch (error) { await target.close(); await rm(output); throw error; } finally { await target.close(); }
}
export function seedURL(kind, tag) {
  assert(KINDS.includes(kind)); assert(/^[A-Za-z0-9][A-Za-z0-9.-]{0,95}$/.test(tag ?? '') && !tag.includes('..'));
  return `https://github.com/Andrewegao/v3t7kq-cycle/releases/download/${tag}/places-${kind}-seed.wxps`;
}
export async function downloadSeed({ kind, tag, ciphertextSha256, output, fetchImpl = fetch }) {
  assert(SHA.test(ciphertextSha256 ?? '')); await newPath(output); let url = seedURL(kind, tag), response;
  const signal = AbortSignal.timeout(120000);
  for (let i = 0; i < 3; i++) {
    response = await fetchImpl(url, { redirect: 'manual', credentials: 'omit', signal, headers: { Accept: 'application/octet-stream' } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location'); await response.body?.cancel();
    const next = new URL(location, url);
    assert(next.protocol === 'https:' && next.hostname === 'release-assets.githubusercontent.com' && !next.username && !next.password && !next.port && !next.hash, 'unapproved asset redirect'); url = next.href;
  }
  if (response?.status !== 200 || !response.body) { await response?.body?.cancel(); throw Error('seed download refused'); }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) <= 0 || Number(declared) > MAX_ARCHIVE)) { await response.body.cancel(); throw Error('seed download budget'); }
  let target; try { target = await open(output, 'wx', 0o600); } catch (error) { await response.body.cancel(); throw error; }
  const digest = createHash('sha256'); let count = 0;
  try { for await (const chunk of response.body) { count += chunk.length; assert(count <= MAX_ARCHIVE); digest.update(chunk); await write(target, chunk); }
    assert(count > 0 && (declared === null || count === Number(declared))); assert.equal(digest.digest('hex'), ciphertextSha256, 'encrypted seed SHA differs');
  } catch (error) { await target.close(); await rm(output); throw error; } finally { await target.close(); }
}
export async function unpackSeed({ archive, output, evidenceOutput = output + '-checkpoint', key, ciphertextSha256, plaintextSha256, ...pins }) {
  assert(SHA.test(ciphertextSha256 ?? '') && SHA.test(plaintextSha256 ?? '')); seedKey(key);
  const stat = await regular(archive, MAX_ARCHIVE); assert(stat.size > MAGIC.length + 12 + 16 + 4);
  const digest = createHash('sha256'); let cipherBytes = 0;
  for await (const chunk of createReadStream(archive, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, start: 0, end: stat.size })) { cipherBytes += chunk.length; assert(cipherBytes <= stat.size); digest.update(chunk); }
  assert.equal(cipherBytes, stat.size);
  assert.equal(digest.digest('hex'), ciphertextSha256, 'encrypted seed SHA differs');
  await newPath(output); await mkdir(output, { mode: 0o700 });
  let madeEvidence = false, authenticatedEvidence = null;
  const spool = resolve(output, '.authenticated-seed'), handle = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const prefix = await read(handle, MAGIC.length + 12, 0); assert(prefix.subarray(0, MAGIC.length).equals(MAGIC));
    const decipher = createDecipheriv('aes-256-gcm', seedKey(key), prefix.subarray(MAGIC.length)); decipher.setAAD(MAGIC);
    decipher.setAuthTag(await read(handle, 16, stat.size - 16));
    const plain = createHash('sha256'); let count = 0;
    await pipeline(createReadStream(archive, { flags: constants.O_RDONLY | constants.O_NOFOLLOW, start: prefix.length, end: stat.size - 17 }), decipher,
      new Transform({ transform(chunk, _, callback) { count += chunk.length; if (count > MAX_ARCHIVE) return callback(Error('plaintext budget')); plain.update(chunk); callback(null, chunk); } }), createWriteStream(spool, { flags: 'wx', mode: 0o600 }));
    assert.equal(plain.digest('hex'), plaintextSha256, 'plaintext seed SHA differs');
    // No payload path is interpreted until the full GCM tag and both digests pass.
    const source = await open(spool, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const length = (await read(source, 4, 0)).readUInt32BE(); assert(length > 0 && length <= LIMITS.manifestBytes + 4096);
      const header = validateHeader(JSON.parse(await read(source, length, 4)), pins); authenticatedEvidence = header.evidence; let position = 4 + length;
      const payloads = header.manifest.files.map(file => ({ receipt: file, root: output, relative: inputPath(header.kind, header.identity, file.path) }));
      if (header.evidence) { await newPath(evidenceOutput); assert(evidenceOutput !== output && !evidenceOutput.startsWith(output + '/')); await mkdir(evidenceOutput, { mode: 0o700 }); madeEvidence = true;
        payloads.push(...header.evidence.files.map(file => ({ receipt: file, root: evidenceOutput, relative: evidencePath(header.kind, file.path) }))); }
      assert.equal(position + payloads.reduce((sum, file) => sum + file.receipt.bytes, 0), count, 'extra or missing seed bytes');
      for (const { receipt, root, relative } of payloads) {
        const path = resolve(root, relative); assert(path.startsWith(root + '/'));
        await mkdir(dirname(path), { recursive: true, mode: 0o700 }); const target = await open(path, 'wx', 0o600), fileHash = createHash('sha256');
        try { for (let left = receipt.bytes; left > 0;) { const chunk = await read(source, Math.min(left, 65536), position); left -= chunk.length; position += chunk.length; fileHash.update(chunk); await write(target, chunk); }
          assert.equal(fileHash.digest('hex'), receipt.sha256, 'seed payload SHA differs');
        } finally { await target.close(); }
      }
    } finally { await source.close(); }
    await rm(spool);
    const candidate = await qualifyPlaces({ kind: pins.kind, root: output }); assert.equal(hash(candidate.manifestBody), pins.manifestSha256);
    if (madeEvidence) assert.deepEqual((await checkpointEvidence(evidenceOutput, pins.kind)).document, authenticatedEvidence);
    return { ...candidate, seedEvidence: authenticatedEvidence };
  } catch (error) { await rm(output, { recursive: true }); if (madeEvidence) await rm(evidenceOutput, { recursive: true }); throw error; } finally { await handle.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    noPublishCredentials(process.env); assert.equal(process.argv[2], 'pack');
    const candidate = await qualifyPlaces({ kind: process.argv[3], root: process.argv[4] });
    const evidence = process.argv[6] ? await checkpointEvidence(process.argv[6], process.argv[3]) : null;
    console.log(JSON.stringify(await packSeed({ candidate, evidence, sourceSha: process.env.ATMOS_SHA, key: process.env.STAGING_PLACES_SEED_KEY, output: process.argv[5] })));
  } catch { console.error('staging seed transport refused; no publication attempted'); process.exitCode = 1; }
}
