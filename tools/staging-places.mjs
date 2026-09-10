// Place metadata/data qualification and publication primitives. No workflow or remote CLI action.
// CLI is dry-run only; injected I/O is required to prepare/activate. No production target exists.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { ACCOUNT } from './shared-data.mjs';

export { ACCOUNT };
export const BUCKET = 'weatherx-data-staging';
export const KINDS = ['surf', 'paragliding', 'tides'];
export const LIMITS = Object.freeze({ files: 20000, totalBytes: 256 * 1024 ** 2, fileBytes: 16 * 1024 ** 2, manifestBytes: 4 * 1024 ** 2, completionBytes: 8192, leaseMs: 48 * 3600000 });
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(`${JSON.stringify(value)}\n`);
const exact = (row, keys) => row && typeof row === 'object' && !Array.isArray(row) && Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
function kindId(kind, identity) {
  assert(KINDS.includes(kind), 'unsupported place family'); assert(typeof identity === 'string' && ID.test(identity) && !identity.includes('..'), 'unsafe snapshot identity');
  assert((kind === 'surf' ? /^surf-[A-Za-z0-9._-]+$/ : kind === 'paragliding' ? /^[a-f0-9]{20}$/ : /^noaa-coops-[A-Za-z0-9._-]+$/).test(identity), 'identity differs from family contract');
}
function finiteDate(value) { assert(typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)), 'invalid timestamp'); return Date.parse(value); }
export function prefix(kind, identity) { kindId(kind, identity); return `staging-places/${kind}/snapshots/${identity}/`; }
export function pointerKey(kind) { assert(KINDS.includes(kind)); return `shared-read/places-${kind}.json`; }
export function payloadPath(kind, path) {
  assert(typeof path === 'string' && path.length <= 512 && !path.includes('..'), 'unsafe payload path');
  const allowed = kind === 'surf' ? /^(?:index\.json|spots\/[a-z0-9][a-z0-9-]{0,63}\.json)$/
    : kind === 'paragliding' ? /^(?:index\.json|cells\/\d+_\d+\.json|sites\/\d+\.json)$/
      : kind === 'tides' ? /^(?:catalog\.json|tides\.json|availability-[a-f0-9]{64}\.json|stations\/\d+\/window\.json)$/ : /$a/;
  assert(allowed.test(path), 'payload outside family allowlist'); return path;
}
export function allowedKey(key) {
  assert(typeof key === 'string');
  if (KINDS.some(kind => key === pointerKey(kind))) return key;
  const match = /^staging-places\/(surf|paragliding|tides)\/snapshots\/([^/]+)\/(.+)$/.exec(key);
  assert(match, 'key outside staging place roots'); kindId(match[1], match[2]);
  if (!['manifest.json', 'completion.json'].includes(match[3])) payloadPath(match[1], match[3]);
  return key;
}
function receipt(value, kind, reserved = false) {
  assert(exact(value, ['path', 'bytes', 'sha256']), 'invalid object receipt');
  if (reserved) assert(['manifest.json', 'completion.json'].includes(value.path)); else payloadPath(kind, value.path);
  assert(Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= LIMITS.fileBytes, 'file budget exceeded');
  assert(typeof value.sha256 === 'string' && HASH.test(value.sha256), 'invalid object hash'); return value;
}
export function validateManifest(value) {
  assert(exact(value, ['schemaVersion', 'kind', 'identity', 'index', 'files']) && value.schemaVersion === 1, 'invalid manifest');
  kindId(value.kind, value.identity); receipt(value.index, value.kind);
  assert(value.index.path === (value.kind === 'tides' ? 'catalog.json' : 'index.json'));
  assert(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= LIMITS.files, 'file count budget');
  let prior = '', total = 0;
  for (const file of value.files) { receipt(file, value.kind); assert(file.path > prior, 'unsorted or duplicate files'); prior = file.path; total += file.bytes; }
  assert(total <= LIMITS.totalBytes, 'total byte budget');
  assert.deepEqual(value.files.find(file => file.path === value.index.path), value.index, 'index receipt mismatch');
  assert(encode(value).length <= LIMITS.manifestBytes, 'manifest byte budget');
  return value;
}
export function validateCompletion(value) {
  assert(exact(value, ['schemaVersion', 'kind', 'identity', 'index', 'manifest', 'objectCount', 'totalBytes', 'sourceExpiresAt']) && value.schemaVersion === 1, 'invalid completion');
  kindId(value.kind, value.identity); receipt(value.index, value.kind); receipt(value.manifest, value.kind, true);
  assert(value.index.path === (value.kind === 'tides' ? 'catalog.json' : 'index.json'));
  assert.equal(value.manifest.path, 'manifest.json'); assert(value.manifest.bytes <= LIMITS.manifestBytes);
  assert(Number.isSafeInteger(value.objectCount) && value.objectCount > 0 && value.objectCount <= LIMITS.files);
  assert(Number.isSafeInteger(value.totalBytes) && value.totalBytes > 0 && value.totalBytes <= LIMITS.totalBytes);
  if (value.sourceExpiresAt !== null) finiteDate(value.sourceExpiresAt);
  assert(value.kind === 'paragliding' || value.sourceExpiresAt !== null, 'forecast family requires source expiry');
  assert(value.kind !== 'paragliding' || value.sourceExpiresAt === null, 'PG lease is not source freshness');
  assert(encode(value).length <= LIMITS.completionBytes); return value;
}
export function validatePointer(value, now = Date.now()) {
  assert(exact(value, ['schemaVersion', 'kind', 'identity', 'index', 'manifest', 'objectCount', 'totalBytes', 'sourceExpiresAt', 'createdAt', 'expiresAt', 'completion']), 'invalid pointer');
  const { createdAt, expiresAt, completion, ...base } = value; validateCompletion(base); receipt(completion, base.kind, true);
  assert.equal(completion.path, 'completion.json'); assert(completion.bytes <= LIMITS.completionBytes);
  const created = finiteDate(createdAt), expires = finiteDate(expiresAt);
  assert(Number.isFinite(now) && created <= now && now < expires && expires - created <= LIMITS.leaseMs, 'expired or invalid pointer lease');
  if (base.sourceExpiresAt) assert(expires <= finiteDate(base.sourceExpiresAt), 'lease exceeds source coverage');
  assert.equal(completion.sha256, hash(encode(base)), 'completion hash mismatch'); assert.equal(completion.bytes, encode(base).length);
  return value;
}

async function localFile(root, path) {
  assert(!isAbsolute(path) && !path.split('/').some(part => !part || part === '.' || part === '..'), 'unsafe local path');
  const file = resolve(root, path), stat = await lstat(file), real = await realpath(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && real === file && stat.size > 0 && stat.size <= LIMITS.fileBytes, 'invalid local file');
  const rel = relative(root, real); assert(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'local root escape');
  return { file, bytes: stat.size };
}
async function readLocal(file, expectedBytes, collect = true) {
  const stream = createReadStream(file, { start: 0, end: expectedBytes, flags: constants.O_RDONLY | constants.O_NOFOLLOW });
  const chunks = [], digest = createHash('sha256'); let bytes = 0;
  try { for await (const chunk of stream) { bytes += chunk.length; assert(bytes <= expectedBytes && bytes <= LIMITS.fileBytes, 'file changed or exceeds byte budget'); digest.update(chunk); if (collect) chunks.push(chunk); } }
  finally { stream.destroy(); }
  assert.equal(bytes, expectedBytes, 'truncated local file');
  return { bytes, sha256: digest.digest('hex'), ...(collect ? { body: Buffer.concat(chunks) } : {}) };
}
async function localJSON(root, path) { const info = await localFile(root, path), data = await readLocal(info.file, info.bytes); return { ...info, ...data, value: JSON.parse(data.body) }; }
async function inventory(root, folder = '', rows = []) {
  for (const entry of await readdir(resolve(root, folder), { withFileTypes: true })) {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), 'symlink candidate tree');
    if (entry.isDirectory()) await inventory(root, path, rows);
    else { assert(entry.isFile(), 'nonregular candidate tree'); rows.push(path); assert(rows.length <= LIMITS.files, 'candidate file count budget'); }
  }
  return rows;
}
export async function qualifyPlaces({ kind, root, now = Date.now() }) {
  assert(KINDS.includes(kind)); assert(isAbsolute(root), 'absolute candidate root required'); root = await realpath(root);
  const indexInput = kind === 'tides' ? 'v2/catalog.json' : 'index.json';
  const index = await localJSON(root, indexInput), value = index.value;
  const identity = kind === 'surf' ? value.releaseId : kind === 'paragliding' ? value.revision : value.datasetId;
  kindId(kind, identity);
  const mounted = new Map([[kind === 'tides' ? 'catalog.json' : 'index.json', indexInput]]);
  let sourceExpiresAt = null;
  const mount = (output, input) => { payloadPath(kind, output); assert(!mounted.has(output), 'duplicate mount'); mounted.set(output, input); };
  if (kind === 'surf') {
    assert(value.schemaVersion === 1 && typeof value.catalogVersion === 'string' && Array.isArray(value.spots) && value.spots.length > 0);
    assert(value.cadenceSeconds === 3600 && value.times?.length === 73 && value.times.every((time, i) => Number.isSafeInteger(time) && (!i || time - value.times[i - 1] === 3600000)));
    sourceExpiresAt = value.source?.freshUntil; assert(finiteDate(sourceExpiresAt) > now && finiteDate(value.source.initializedAt) <= now);
    for (const spot of value.spots) {
      assert(spot.path === `surf/spots/${spot.spotId}.json`); const path = `spots/${spot.spotId}.json`;
      const detail = await localJSON(root, path);
      assert.equal(detail.sha256, spot.sha256); assert.equal(detail.bytes, spot.bytes);
      assert.equal(detail.value.releaseId, identity); assert.equal(detail.value.catalogVersion, value.catalogVersion); assert.equal(detail.value.spotId, spot.spotId);
      assert.deepEqual(detail.value.source, value.source); assert.deepEqual(detail.value.samples?.map(row => row.time), value.times);
      assert.deepEqual(detail.value.samples.map(row => row.waveHeight), spot.waveHeight);
      assert(detail.value.windSource?.runId === value.source.runId, 'mixed wave/wind runs'); mount(path, path);
    }
  } else if (kind === 'paragliding') {
    assert(value.schema === 1 && /^[a-f0-9]{20}$/.test(identity) && Number.isSafeInteger(value.count) && value.count > 0 && Array.isArray(value.cells));
    for (const cell of value.cells) {
      const path = `cells/${cell.key}.json`, input = `versions/${identity}/${path}`; const detail = await localJSON(root, input);
      assert.equal(detail.sha256, cell.sha256, 'PG cell hash mismatch'); mount(path, input);
    }
    const siteFolder = `versions/${identity}/sites`;
    const sites = await readdir(resolve(root, siteFolder)); assert.equal(sites.length, value.count, 'PG site roster count mismatch');
    for (const file of sites) { assert(/^\d+\.json$/.test(file)); const path = `sites/${file}`, input = `${siteFolder}/${file}`; const detail = await localJSON(root, input);
      assert(String(detail.value.id) === file.slice(0, -5) && detail.value.revision === identity, 'PG site identity mismatch'); mount(path, input); }
  } else {
    assert(value.schemaVersion === 2 && Array.isArray(value.stations) && value.stations.length > 0);
    const ids = new Set(); let expires = Infinity;
    for (const station of value.stations) {
      assert(typeof station.id === 'string' && !ids.has(station.id), 'duplicate tide station'); ids.add(station.id);
      for (const ref of station.packs ?? []) {
        const lead = `versions/${identity}/`; assert(typeof ref.path === 'string' && ref.path.startsWith(lead), 'foreign tide dataset reference');
        const path = ref.path.slice(lead.length); assert(path.startsWith(`stations/${station.id}/`));
        const input = `v2/${ref.path}`, detail = await localJSON(root, input);
        assert(detail.value.schemaVersion === 2 && detail.value.datasetId === identity && detail.value.stationId === station.id, 'tide pack identity mismatch');
        assert.deepEqual(detail.value.source, value.source); assert.deepEqual(detail.value.datum, value.datum); mount(path, input);
      }
      // Data availability and completeness are certified by pinned producer+consumer proofs.
      // This publisher does not drop unavailable stations or fabricate samples.
      if (station.sampleCoverage) expires = Math.min(expires, station.sampleCoverage.endMs - 7 * 86400000);
    }
    if (Number.isFinite(expires)) { assert(expires > now, 'tide seven-day window exhausted'); sourceExpiresAt = new Date(expires).toISOString(); }
    const availabilityPath = value.availability?.path;
    if (availabilityPath !== undefined) {
      const lead = `versions/${identity}/`; assert(typeof availabilityPath === 'string' && availabilityPath.startsWith(lead));
      const path = availabilityPath.slice(lead.length); assert(/^availability-[a-f0-9]{64}\.json$/.test(path));
      const availability = await localJSON(root, `v2/${availabilityPath}`);
      // The producer names this file by its Python canonical-JSON digest, not its wire
      // bytes. The pinned producer proof checks that convention; our receipt hashes
      // the unmodified actual file, as it does every other payload.
      const summary = value.availability, report = availability.value;
      assert([summary.requestedCount, summary.availableCount, summary.unavailableCount].every(count => Number.isSafeInteger(count) && count >= 0));
      assert.equal(summary.requestedCount, summary.availableCount + summary.unavailableCount, 'tide availability count mismatch');
      assert.equal(report.schemaVersion, 1); assert.equal(report.kind, 'weatherx-tide-availability'); assert.equal(report.scope, 'staging-only');
      assert.equal(report.datasetId, identity); assert.deepEqual(report.source, value.source); assert.deepEqual(report.datum, value.datum);
      const roster = rows => { assert(Array.isArray(rows) && rows.every(id => typeof id === 'string' && /^\d+$/.test(id))); assert.equal(new Set(rows).size, rows.length); return [...rows].sort(); };
      const requested = roster(report.requestedStationIds), available = roster(report.availableStationIds);
      assert(Array.isArray(report.unavailableStations)); const unavailable = roster(report.unavailableStations.map(row => row.id));
      assert.equal(requested.length, summary.requestedCount); assert.equal(available.length, summary.availableCount); assert.equal(unavailable.length, summary.unavailableCount);
      assert.deepEqual(available, [...ids].sort()); assert.deepEqual(roster([...available, ...unavailable]), requested, 'tide requested roster not preserved');
      mount(path, `v2/${availabilityPath}`);
    }
    const legacy = await localJSON(root, 'tides.json'); assert(Array.isArray(legacy.value.stations)); mount('tides.json', 'tides.json');
  }
  assert.deepEqual((await inventory(root)).sort(), [...mounted.values()].sort(), 'candidate contains absent or unlisted objects');
  const files = [], local = new Map(); let totalBytes = 0;
  for (const [path, input] of [...mounted].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const info = await localFile(root, input), data = await readLocal(info.file, info.bytes, false);
    files.push({ path, bytes: data.bytes, sha256: data.sha256 }); local.set(path, { ...info, input, sha256: data.sha256 });
    totalBytes += data.bytes; assert(totalBytes <= LIMITS.totalBytes, 'candidate total byte budget');
  }
  const indexReceipt = files.find(row => row.path === (kind === 'tides' ? 'catalog.json' : 'index.json'));
  const manifest = validateManifest({ schemaVersion: 1, kind, identity, index: indexReceipt, files });
  const manifestBody = encode(manifest);
  const completion = validateCompletion({ schemaVersion: 1, kind, identity, index: indexReceipt,
    manifest: { path: 'manifest.json', bytes: manifestBody.length, sha256: hash(manifestBody) }, objectCount: files.length, totalBytes, sourceExpiresAt });
  return { root, manifest, manifestBody, completion, completionBody: encode(completion), local };
}

export function validateQualification(proof, candidate, approvedSourceSha) {
  assert(/^[a-f0-9]{40}$/.test(approvedSourceSha ?? ''), 'reviewed Atmos source pin required');
  assert(exact(proof, ['schemaVersion', 'kind', 'identity', 'sourceSha', 'manifestSha256', 'checks']) && proof.schemaVersion === 1, 'pinned qualification receipt required');
  assert.equal(proof.sourceSha, approvedSourceSha); assert.equal(proof.kind, candidate.completion.kind); assert.equal(proof.identity, candidate.completion.identity);
  assert.equal(proof.manifestSha256, hash(candidate.manifestBody), 'qualification not bound to exact candidate inventory');
  assert(exact(proof.checks, ['producer', 'consumer', 'coverage', 'roster']) && Object.values(proof.checks).every(value => value === true), 'producer/consumer/coverage/roster proof missing');
  return proof;
}
function verifyRemote(object, wanted) {
  assert(object && object.bytes === wanted.bytes && object.sha256 === wanted.sha256, 'remote bytes differ');
  assert(object.customMetadata?.sha256 === wanted.sha256 && !object.httpMetadata?.contentEncoding, 'remote metadata differs');
}
async function immutable(io, key, wanted, bodyOrFile) {
  allowedKey(key); const before = await io.get(key, wanted.bytes, false);
  if (!before) { await io.put(key, bodyOrFile, { ifNoneMatch: '*', sha256: wanted.sha256, bytes: wanted.bytes }); }
  else verifyRemote(before, wanted);
  verifyRemote(await io.get(key, wanted.bytes, false), wanted);
}
// Fixed small pool: stop claiming work on the first failure, then join every in-flight
// operation before returning. No unbounded inventory of active promises or dangling writes.
export async function payloadPool(items, worker) {
  let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { await worker(items[index], index); } catch (error) { failure ??= { error }; }
    }
  }));
  if (failure) throw failure.error;
}
export async function preparePlaces(io, candidate, { qualification, approvedSourceSha, clock = Date.now, now = clock() } = {}) {
  validateQualification(qualification, candidate, approvedSourceSha); validateManifest(candidate.manifest); validateCompletion(candidate.completion);
  assert.deepEqual(candidate.manifestBody, encode(candidate.manifest), 'manifest changed after qualification');
  assert.deepEqual(candidate.completionBody, encode(candidate.completion), 'completion changed after qualification');
  assert.equal(candidate.completion.manifest.sha256, hash(candidate.manifestBody)); assert.equal(candidate.completion.manifest.bytes, candidate.manifestBody.length);
  assert.equal(candidate.completion.objectCount, candidate.manifest.files.length);
  assert.equal(candidate.completion.totalBytes, candidate.manifest.files.reduce((sum, file) => sum + file.bytes, 0));
  assert.equal(candidate.completion.kind, candidate.manifest.kind); assert.equal(candidate.completion.identity, candidate.manifest.identity); assert.deepEqual(candidate.completion.index, candidate.manifest.index);
  const sourceLive = () => { const current = clock(); assert(Number.isFinite(current) && current >= now, 'invalid publication clock'); if (candidate.completion.sourceExpiresAt) assert(finiteDate(candidate.completion.sourceExpiresAt) > current, 'source expired during preparation'); };
  sourceLive();
  // Pre-read every file before the first write so known local corruption cannot create a partial upload.
  for (const file of candidate.manifest.files) { const source = candidate.local.get(file.path); assert(source); const confined = await localFile(candidate.root, source.input); assert.equal(confined.file, source.file); const current = await readLocal(source.file, file.bytes, false); assert.equal(current.sha256, file.sha256, 'candidate changed before publication'); }
  const base = prefix(candidate.completion.kind, candidate.completion.identity);
  await payloadPool(candidate.manifest.files, async file => { sourceLive(); await immutable(io, base + file.path, file, candidate.local.get(file.path)); });
  sourceLive();
  await immutable(io, base + 'manifest.json', candidate.completion.manifest, candidate.manifestBody);
  // Completion is the reader's only immutable commit record. Never written before all remote bytes pass.
  const completionReceipt = { path: 'completion.json', bytes: candidate.completionBody.length, sha256: hash(candidate.completionBody) };
  sourceLive();
  await immutable(io, base + 'completion.json', completionReceipt, candidate.completionBody);
  return { ...candidate.completion, completion: completionReceipt, activated: false };
}
export async function inspectPlaces(io, kind) { const object = await io.get(pointerKey(kind), LIMITS.completionBytes, false); return { pointerSha256: object?.sha256 ?? 'absent', bytes: object?.bytes ?? 0 }; }
export async function activatePlaces(io, { kind, identity, expectedPointerSha256, approvedCompletionSha256, clock = Date.now, now = clock(), expiresAt }) {
  kindId(kind, identity); assert(expectedPointerSha256 === 'absent' || HASH.test(expectedPointerSha256 ?? '')); assert(HASH.test(approvedCompletionSha256 ?? ''));
  const base = prefix(kind, identity), completed = await io.get(base + 'completion.json', LIMITS.completionBytes, true);
  assert(completed && completed.sha256 === approvedCompletionSha256, 'unreviewed or absent completion');
  const completion = validateCompletion(JSON.parse(completed.body)); assert.equal(completion.kind, kind); assert.equal(completion.identity, identity);
  verifyRemote(completed, { bytes: completed.body.length, sha256: approvedCompletionSha256 });
  const remoteManifest = await io.get(base + 'manifest.json', completion.manifest.bytes, true); verifyRemote(remoteManifest, completion.manifest);
  const manifest = validateManifest(JSON.parse(remoteManifest.body)); assert.equal(manifest.kind, kind); assert.equal(manifest.identity, identity); assert.deepEqual(manifest.index, completion.index);
  assert.equal(manifest.files.length, completion.objectCount); assert.equal(manifest.files.reduce((sum, file) => sum + file.bytes, 0), completion.totalBytes);
  await payloadPool(manifest.files, async file => {
    if (completion.sourceExpiresAt) assert(finiteDate(completion.sourceExpiresAt) > clock(), 'source expired during verification');
    verifyRemote(await io.get(base + file.path, file.bytes, false), file);
  });
  const checkedAt = clock(); assert(checkedAt >= now);
  const pointer = validatePointer({ ...completion, createdAt: new Date(checkedAt).toISOString(), expiresAt,
    completion: { path: 'completion.json', bytes: completed.bytes, sha256: completed.sha256 } }, checkedAt);
  const key = pointerKey(kind), before = await io.get(key, LIMITS.completionBytes, false);
  assert.equal(before?.sha256 ?? 'absent', expectedPointerSha256, 'pointer changed; inspect before retry');
  const body = encode(pointer); assert(body.length <= LIMITS.completionBytes);
  validatePointer(pointer, clock());
  await io.put(key, body, { ...(before ? { ifMatch: before.etag } : { ifNoneMatch: '*' }), bytes: body.length, sha256: hash(body) });
  verifyRemote(await io.get(key, LIMITS.completionBytes, false), { bytes: body.length, sha256: hash(body) });
  return { identity, pointerSha256: hash(body), expiresAt, activated: true };
}

// A separate narrow adapter is necessary: existing search/shared adapters correctly reject this
// prefix. Keep their fixed account, explicit credentials, single-write-attempt and CAS semantics.
export async function createPlacesS3(env, injectedClient) {
  assert.equal(env.STAGING_R2_ACCOUNT_ID, ACCOUNT);
  assert(env.STAGING_R2_WRITE_ACCESS_KEY_ID && env.STAGING_R2_WRITE_SECRET_ACCESS_KEY, 'staging-only credentials required');
  for (const key of Object.keys(env)) if (/^(AWS_|RCLONE_|CLOUDFLARE_|CF_API_|R2_PRODUCTION_|SHARED_R2_|UI_PRODUCTION_|STAGING_WORKER_)/.test(key)) assert(!env[key], 'unrelated credential refused');
  const { S3Client, GetObjectCommand, PutObjectCommand } = await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
  const client = injectedClient ?? new S3Client({ region: 'auto', endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`, forcePathStyle: true, maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.STAGING_R2_WRITE_ACCESS_KEY_ID, secretAccessKey: env.STAGING_R2_WRITE_SECRET_ACCESS_KEY } });
  async function send(command, missing = false) { try { return await client.send(command, { abortSignal: AbortSignal.timeout(45000) }); }
    catch (error) { if (missing && error?.$metadata?.httpStatusCode === 404) return null; throw new Error(error?.$metadata?.httpStatusCode === 412 ? 'staging place CAS conflict' : 'staging place request failed or uncertain'); } }
  return { close: () => client.destroy?.(), async get(key, maxBytes, collect = true) {
    allowedKey(key); assert(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= LIMITS.fileBytes);
    const object = await send(new GetObjectCommand({ Bucket: BUCKET, Key: key }), true); if (!object) return null;
    const chunks = [], digest = createHash('sha256'); let bytes = 0;
    try { assert(Number.isSafeInteger(object.ContentLength) && object.ContentLength <= maxBytes); assert(object.Body?.[Symbol.asyncIterator]);
      for await (const chunk of object.Body) { bytes += chunk.length; assert(bytes <= maxBytes); digest.update(chunk); if (collect) chunks.push(Buffer.from(chunk)); }
      assert.equal(bytes, object.ContentLength); assert(/^"[A-Za-z0-9-]+"$/.test(object.ETag ?? ''));
      return { bytes, sha256: digest.digest('hex'), etag: object.ETag, customMetadata: object.Metadata ?? {}, httpMetadata: { contentEncoding: object.ContentEncoding }, ...(collect ? { body: Buffer.concat(chunks) } : {}) };
    } finally { object.Body?.destroy?.(); }
  }, async put(key, input, condition) {
    allowedKey(key); assert(Number.isSafeInteger(condition.bytes) && condition.bytes > 0 && condition.bytes <= LIMITS.fileBytes); assert(HASH.test(condition.sha256 ?? ''));
    const pointer = KINDS.some(kind => key === pointerKey(kind));
    assert(Boolean(condition.ifMatch) !== Boolean(condition.ifNoneMatch), 'one CAS condition required');
    if (condition.ifMatch) { assert(pointer, 'immutable snapshots cannot be overwritten'); assert(/^"[A-Za-z0-9-]+"$/.test(condition.ifMatch)); } else assert.equal(condition.ifNoneMatch, '*');
    let body;
    if (Buffer.isBuffer(input)) { assert.equal(input.length, condition.bytes); assert.equal(hash(input), condition.sha256); body = input; }
    else {
      assert(!pointer && input?.file && input.bytes === condition.bytes && input.sha256 === condition.sha256, 'invalid streamed file');
      body = Readable.from((async function* () { const stream = createReadStream(input.file, { start: 0, end: condition.bytes, flags: constants.O_RDONLY | constants.O_NOFOLLOW }), digest = createHash('sha256'); let bytes = 0;
        try { for await (const chunk of stream) { bytes += chunk.length; assert(bytes <= condition.bytes); digest.update(chunk); yield chunk; } assert.equal(bytes, condition.bytes); assert.equal(digest.digest('hex'), condition.sha256, 'candidate changed during upload'); }
        finally { stream.destroy(); }
      })());
    }
    try { const result = await send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentLength: condition.bytes, IfMatch: condition.ifMatch, IfNoneMatch: condition.ifNoneMatch,
      Metadata: { sha256: condition.sha256 }, ContentType: 'application/json', CacheControl: pointer ? 'no-store' : 'public, max-age=31536000, immutable' })); assert(/^"[A-Za-z0-9-]+"$/.test(result.ETag ?? '')); }
    finally { if (!Buffer.isBuffer(body)) body.destroy(); }
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert(process.argv[2] === 'dry-run', 'only dry-run CLI is implemented; remote publication requires a separately reviewed workflow');
    const candidate = await qualifyPlaces({ kind: process.argv[3], root: process.argv[4] });
    console.log(JSON.stringify({ dryRun: true, qualificationRequired: true, kind: candidate.completion.kind, identity: candidate.completion.identity,
      objectCount: candidate.completion.objectCount, totalBytes: candidate.completion.totalBytes, manifestSha256: hash(candidate.manifestBody), completionSha256: hash(candidate.completionBody), sourceExpiresAt: candidate.completion.sourceExpiresAt }));
  } catch { console.error('staging place qualification refused; no remote action was performed'); process.exitCode = 1; }
}
