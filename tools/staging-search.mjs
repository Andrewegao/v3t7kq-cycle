// Independent staging-only search publication. No weather pointers, model data, Worker/API
// tokens, arbitrary bucket names or credential-chain fallback are accepted by this lane.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ATMOS_SHA, SEARCH_V4_READER_CLOSURE, STAGING_ORIGIN } from './staging-search-source.mjs';

export const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
export const BUCKET = 'weatherx-data-staging';
export const POINTER_KEY = 'shared-read/ancillary-search.json';
export const FILES = ['core.json', 'more.json'];
const SHA = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const SAFE_RELEASE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_FILE = 1024 * 1024;
const MAX_GZIP = 150 * 1024;
const MAX_ROWS = 200_000;
const GENERATION = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const WIND100_CATALOG = /^stage-wind100-[1-9]\d{0,19}-[1-9]\d{0,5}$/;
const WIND100_RUN = /^\d{10}$/;
const SOURCE_FILE_MAX = 2 * 1024 * 1024;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));

export function searchGate(env, action) {
  assert.ok(['inspect', 'prepare', 'activate', 'revoke', 'renew'].includes(action), 'unsupported search action');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'publication is cloud-only');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.ok(env.GITHUB_EVENT_NAME === 'workflow_dispatch' ||
    (env.GITHUB_EVENT_NAME === 'schedule' && action === 'renew'), 'schedule may only renew');
  assert.equal(env.GITHUB_JOB, 'search');
  assert.equal(env.GITHUB_WORKFLOW_REF, 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-search.yml@refs/heads/main');
  assert.equal(env.STAGING_SEARCH_ENABLED, 'true', 'search publication remains owner-gated');
  assert.equal(env.STAGING_DATA_ISOLATION_APPROVED, 'true');
  assert.equal(env.STAGING_R2_ACCOUNT_ID, ACCOUNT);
  for (const key of Object.keys(env)) {
    if (/^(AWS_|RCLONE_|CLOUDFLARE_|CF_API_|R2_ACCESS_|R2_SECRET_|SHARED_R2_|UI_PRODUCTION_|STAGING_WORKER_)/.test(key)) {
      assert.ok(!env[key], 'unrelated credential/configuration present');
    }
  }
  if (action === 'activate' || action === 'revoke') {
    assert.ok(env.EXPECTED_POINTER_SHA256 === 'absent' || SHA.test(env.EXPECTED_POINTER_SHA256 ?? ''), 'review the current pointer first');
  }
  if (action === 'activate') {
    assert.match(env.CANDIDATE_SHA256 ?? '', SHA);
    assert.equal(env.STAGING_SEARCH_APPROVED_CANDIDATE_SHA256, env.CANDIDATE_SHA256, 'candidate has not been reviewed');
    assert.match(env.STAGING_SEARCH_V4_APPROVED_UI_SOURCE_SHA ?? '', SOURCE_SHA,
      'an exact protected V4 UI source is required');
    assert.match(env.STAGING_SEARCH_V4_APPROVED_RELEASE_ID ?? '', SAFE_RELEASE,
      'a browser-qualified canonical staging release is required');
  }
  if (action === 'renew') {
    assert.equal(env.STAGING_SEARCH_RENEWAL_ENABLED, 'true', 'renewal is separately enabled');
    assert.match(env.STAGING_SEARCH_APPROVED_CANDIDATE_SHA256 ?? '', SHA);
  }
}

export function validateV4SourceEvidence(env, evidence) {
  const approved = env.STAGING_SEARCH_V4_APPROVED_UI_SOURCE_SHA;
  assert.match(approved ?? '', SOURCE_SHA, 'an exact protected V4 UI source is required');
  assert.ok(exact(evidence, ['head', 'clean', 'includesSearchV4Base', 'files']),
    'invalid V4 source evidence');
  assert.equal(evidence.head, approved, 'checked-out UI source differs from protected approval');
  assert.equal(evidence.clean, true, 'checked-out UI source is modified');
  assert.equal(evidence.includesSearchV4Base, true, 'UI source does not descend from the reviewed V4 integration');
  assert.deepEqual(evidence.files, SEARCH_V4_READER_CLOSURE,
    'Search V4 reader closure differs from the reviewed integration');
  return { uiSourceSha: approved, searchV4BaseSha: ATMOS_SHA,
    files: Object.keys(SEARCH_V4_READER_CLOSURE).length };
}

export function verifyV4Source(root, env, run = execFileSync) {
  assert.equal(typeof root, 'string', 'source root missing');
  const source = resolve(root);
  assert.equal(realpathSync(source), source, 'source root must not be a symlink');
  const sourceStat = lstatSync(source);
  assert.ok(sourceStat.isDirectory() && !sourceStat.isSymbolicLink(), 'source root must be a regular directory');
  const options = { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 30_000, maxBuffer: 64 * 1024 };
  const command = args => run('git', args, options).trim();
  assert.equal(resolve(command(['rev-parse', '--show-toplevel'])), source, 'source is not the checkout root');
  const head = command(['rev-parse', 'HEAD']);
  const clean = command(['status', '--porcelain=v1', '--untracked-files=all']) === '';
  let includesSearchV4Base = false;
  try {
    command(['merge-base', '--is-ancestor', ATMOS_SHA, 'HEAD']);
    includesSearchV4Base = true;
  } catch {}
  const files = {};
  for (const path of Object.keys(SEARCH_V4_READER_CLOSURE)) {
    const file = resolve(source, path);
    assert.ok(file.startsWith(`${source}/`) && realpathSync(file) === file,
      'reader closure path must remain inside the source checkout without symlinks');
    const stat = lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= SOURCE_FILE_MAX,
      'reader closure file is not a bounded regular file');
    files[path] = hash(readFileSync(file));
  }
  return validateV4SourceEvidence(env, { head, clean, includesSearchV4Base, files });
}

function validWind100Run(runId) {
  if (!WIND100_RUN.test(runId ?? '')) return false;
  const iso = `${runId.slice(0, 4)}-${runId.slice(4, 6)}-${runId.slice(6, 8)}T${runId.slice(8)}:00:00.000Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso;
}

function validStagingBuildProfile(value) {
  const base = ['product', 'platformAccount', 'platformDataAuth'];
  if (!object(value) || !exact(value, Object.hasOwn(value, 'wind100') ? [...base, 'wind100'] : base) ||
      value.product !== 'lab' || value.platformAccount !== '1' || value.platformDataAuth !== 'public') return false;
  if (!Object.hasOwn(value, 'wind100')) return true;
  const wind100 = value.wind100;
  return exact(wind100, ['catalogId', 'runId', 'selectionSha256']) &&
    WIND100_CATALOG.test(wind100.catalogId ?? '') && validWind100Run(wind100.runId) &&
    SHA.test(wind100.selectionSha256 ?? '');
}

async function readBounded(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    await response.body?.cancel();
    throw new Error('canonical staging response exceeds byte budget');
  }
  assert.ok(response.body, 'canonical staging response body missing');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assert.ok(size <= maxBytes, 'canonical staging response exceeds streamed budget');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  assert.ok(size > 0 && (declared === null || Number(declared) === size), 'canonical staging response truncated');
  return Buffer.concat(chunks);
}

export async function verifyV4Staging(env, fetchImpl = fetch) {
  assert.match(env.STAGING_SEARCH_V4_APPROVED_UI_SOURCE_SHA ?? '', SOURCE_SHA,
    'an exact protected V4 UI source is required');
  assert.match(env.STAGING_SEARCH_V4_APPROVED_RELEASE_ID ?? '', SAFE_RELEASE,
    'approved canonical staging release missing');
  const response = await fetchImpl(`${STAGING_ORIGIN}/health/release.json?search_v4_compatibility=1`, {
    redirect: 'error', cache: 'no-store', credentials: 'omit',
    headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error('canonical staging release unavailable');
  }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBounded(response, 8192)));
  assert.ok(object(value) && value.gitSha === env.STAGING_SEARCH_V4_APPROVED_UI_SOURCE_SHA &&
    value.releaseId === env.STAGING_SEARCH_V4_APPROVED_RELEASE_ID &&
    SHA.test(value.shellSha256 ?? '') && SHA.test(value.indexSha256 ?? '') &&
    validStagingBuildProfile(value.buildProfile),
  'canonical staging release is not the reviewed V4 shell');
  const indexResponse = await fetchImpl(`${STAGING_ORIGIN}/?search_v4_compatibility=1`, {
    redirect: 'error', cache: 'no-store', credentials: 'omit',
    headers: { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30_000),
  });
  if (indexResponse.status !== 200 || !/^text\/html(?:;|$)/i.test(indexResponse.headers.get('content-type') ?? '')) {
    await indexResponse.body?.cancel();
    throw new Error('canonical staging shell unavailable');
  }
  const index = await readBounded(indexResponse, 4 * 1024 * 1024);
  assert.equal(hash(index), value.indexSha256, 'canonical staging shell differs from its reviewed release');
  return { releaseId: value.releaseId, sourceSha: value.gitSha };
}

export function validateIndex(bytes, name) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_FILE, 'index exceeds byte budget');
  assert.ok(gzipSync(bytes, { level: 9 }).length <= MAX_GZIP, 'index exceeds transfer budget');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.ok(exact(value, ['v', 'baked_at', 'families']) && value.v === 2 &&
    typeof value.baked_at === 'string' && GENERATION.test(value.baked_at) &&
    Number.isFinite(Date.parse(value.baked_at)) &&
    new Date(Date.parse(value.baked_at)).toISOString().replace('.000Z', 'Z') === value.baked_at,
  'invalid V2 index envelope');
  const families = name === 'core.json' ? ['airport', 'storm'] : name === 'more.json' ? ['station', 'tide', 'sonde'] : [];
  assert.ok(families.length && exact(value.families, families), 'missing or unexpected search family');
  for (const family of families) {
    const row = value.families[family];
    const allowed = new Set(['n', 'disp', 'll',
      ...(['airport', 'storm'].includes(family) ? ['w'] : []),
      ...(family !== 'storm' ? ['rgv', 'rgi', 'ccv', 'cci'] : []),
      ...(family === 'station' ? ['ap'] : [])]);
    assert.ok(object(row) && Object.keys(row).every(key => allowed.has(key)) &&
      ['n', 'disp', 'll'].every(key => Object.hasOwn(row, key)), 'invalid V2 family shape');
    assert.ok(Number.isSafeInteger(row.n) && row.n > 0 && row.n <= MAX_ROWS && typeof row.disp === 'string', 'invalid row count');
    const lines = row.disp.split('\n');
    assert.equal(lines.length, row.n, 'display/count mismatch');
    assert.ok(lines.every(line => line.length > 0 && line.length <= 1024 && !/[\r\0]/.test(line) &&
      line.split('\t').length === (family === 'storm' ? 6 : family === 'airport' ? 3 : 2)), 'invalid display columns');
    assert.ok(Array.isArray(row.ll) && row.ll.length === 2 * row.n && row.ll.every((n, i) =>
      Number.isSafeInteger(n) && Math.abs(n) <= (i % 2 ? 180_000 : 90_000)), 'invalid coordinates');
    if (row.w !== undefined) assert.ok(Array.isArray(row.w) && row.w.length === row.n &&
      row.w.every(n => n === 0 || n === 1) && row.w.includes(1), 'invalid weights');
    for (const [namesKey, indicesKey] of [['rgv', 'rgi'], ['ccv', 'cci']]) {
      const names = row[namesKey], indices = row[indicesKey];
      assert.equal(names === undefined, indices === undefined, 'dictionary columns must be paired');
      if (names !== undefined) {
        assert.ok(Array.isArray(names) && names.length > 0 && names.length <= row.n &&
          names.every(item => typeof item === 'string' && item.length > 0 && item.length <= 1024 && !/[\t\r\n\0]/.test(item)) &&
          new Set(names).size === names.length, 'invalid dictionary values');
        assert.ok(Array.isArray(indices) && indices.length === row.n && indices.every(index =>
          Number.isSafeInteger(index) && index >= -1 && index < names.length), 'invalid dictionary indices');
        assert.equal(new Set(indices.filter(index => index >= 0)).size, names.length, 'unreferenced dictionary value');
      }
    }
    if (row.ap !== undefined) assert.ok(Array.isArray(row.ap) && row.ap.length === row.n &&
      row.ap.every(index => Number.isSafeInteger(index) && index >= -1) && row.ap.some(index => index >= 0),
    'invalid airport links');
  }
  if (name === 'core.json') {
    assert.ok(value.families.airport.disp.split('\n').some(line => {
      const codes = line.split('\t')[1]?.split(' ');
      return codes?.includes('KSFO') && codes.includes('SFO');
    }), 'SFO/KSFO acceptance anchor missing');
  }
  return value;
}

// Existing staging may still point at the previously admitted V1 pair while the V4 shell is
// qualified. Renewal must preserve those exact immutable bytes until the reviewed V2 switch;
// this legacy validator is never accepted by prepare or activate.
function validateLegacyV1Index(bytes, name) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_FILE, 'legacy index exceeds byte budget');
  assert.ok(gzipSync(bytes, { level: 9 }).length <= 130 * 1024, 'legacy index exceeds transfer budget');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.ok(exact(value, ['v', 'baked_at', 'families']) && value.v === 1 &&
    typeof value.baked_at === 'string' && Number.isFinite(Date.parse(value.baked_at)), 'invalid legacy index envelope');
  const families = name === 'core.json' ? ['airport', 'storm'] : name === 'more.json' ? ['station', 'tide', 'sonde'] : [];
  assert.ok(families.length && exact(value.families, families), 'missing or unexpected legacy search family');
  for (const family of families) {
    const row = value.families[family];
    assert.ok(object(row) && (exact(row, ['n', 'disp', 'll']) || exact(row, ['n', 'disp', 'll', 'w'])),
      'invalid legacy family shape');
    assert.ok(Number.isSafeInteger(row.n) && row.n > 0 && row.n <= MAX_ROWS && typeof row.disp === 'string',
      'invalid legacy row count');
    const lines = row.disp.split('\n');
    assert.equal(lines.length, row.n, 'legacy display/count mismatch');
    assert.ok(lines.every(line => line.length > 0 && line.length <= 1024 && !/[\r\0]/.test(line) &&
      line.split('\t').length === (family === 'storm' ? 6 : 2)), 'invalid legacy display columns');
    assert.ok(Array.isArray(row.ll) && row.ll.length === 2 * row.n && row.ll.every((n, i) =>
      Number.isSafeInteger(n) && Math.abs(n) <= (i % 2 ? 180_000 : 90_000)), 'invalid legacy coordinates');
    if (row.w !== undefined) assert.ok(Array.isArray(row.w) && row.w.length === row.n &&
      row.w.every(n => Number.isInteger(n) && n >= 0 && n <= 255), 'invalid legacy weights');
  }
  if (name === 'core.json') assert.ok(value.families.airport.disp.split('\n').some(line => {
    const codes = line.split('\t')[1]?.split(' ');
    return codes?.includes('KSFO') && codes.includes('SFO');
  }), 'legacy SFO/KSFO acceptance anchor missing');
  return value;
}

function candidateWith(files, validator) {
  assert.ok(exact(files, FILES), 'both files required');
  const receipts = {}, indexes = {};
  for (const name of FILES) {
    indexes[name] = validator(files[name], name);
    receipts[name] = { bytes: files[name].length, sha256: hash(files[name]) };
  }
  const manifest = jsonBytes({ schemaVersion: 1, kind: 'search', files: receipts });
  return { candidateId: hash(manifest), manifest, files: receipts, indexes };
}

export function candidate(files) {
  const c = candidateWith(files, validateIndex);
  const indexes = c.indexes;
  assert.equal(indexes['core.json'].baked_at, indexes['more.json'].baked_at,
    'search V2 pair generation mismatch');
  const airportRows = indexes['core.json'].families.airport.n;
  const links = indexes['more.json'].families.station.ap;
  if (links !== undefined) assert.ok(links.every(index => index < airportRows),
    'station link falls outside the paired core airport family');
  return { candidateId: c.candidateId, manifest: c.manifest, files: c.files,
    generation: indexes['core.json'].baked_at, formatVersion: 2 };
}

function legacyCandidate(files) {
  const c = candidateWith(files, validateLegacyV1Index);
  return { candidateId: c.candidateId, manifest: c.manifest, files: c.files, formatVersion: 1 };
}

export function allowedSearchKey(key) {
  assert.ok(key === POINTER_KEY || /^staging-candidates\/[a-f0-9]{64}\/search\/(?:core\.json|more\.json|manifest\.json)$/.test(key), 'outside search publication allowlist');
  return key;
}
function prefix(id) { assert.match(id, SHA); return `staging-candidates/${id}/search/`; }

async function ensureImmutable(io, key, body) {
  const before = await io.get(key, body.length);
  if (before) {
    assert.equal(before.sha256, hash(body), 'immutable object differs');
    assert.equal(before.customMetadata?.sha256, hash(body), 'immutable metadata differs');
    assert.ok(!before.httpMetadata?.contentEncoding, 'unexpected content encoding');
    return;
  }
  await io.put(key, body, { ifNoneMatch: '*', sha256: hash(body) });
  const after = await io.get(key, body.length);
  assert.ok(after && after.sha256 === hash(body), 'immutable readback failed');
  assert.equal(after.customMetadata?.sha256, hash(body), 'immutable metadata readback failed');
  assert.ok(!after.httpMetadata?.contentEncoding, 'unexpected content encoding');
}

export async function prepareSearch(io, files) {
  const c = candidate(files); // Validate the complete pair before the first write.
  for (const name of FILES) await ensureImmutable(io, `${prefix(c.candidateId)}${name}`, files[name]);
  // Manifest is the completion receipt; it is absent after a partial upload.
  await ensureImmutable(io, `${prefix(c.candidateId)}manifest.json`, c.manifest);
  return { candidateId: c.candidateId, generation: c.generation, files: c.files, activated: false };
}

export async function activateSearch(io, { candidateId, expectedPointerSha256, now = Date.now(), hours = 24,
  ensureV2Compatible }) {
  assert.ok(Number.isFinite(now) && Number.isInteger(hours) && hours >= 1 && hours <= 48, 'invalid activation lifetime');
  const c = await verifyCandidate(io, candidateId);
  assert.equal(typeof ensureV2Compatible, 'function', 'V2 activation requires the compatible staging shell');
  const pointer = { schemaVersion: 1, kind: 'search', candidateId,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + hours * 3_600_000).toISOString(), files: c.files };
  return writePointer(io, pointer, expectedPointerSha256, ensureV2Compatible);
}

async function verifyCandidate(io, candidateId, { allowLegacyV1 = false } = {}) {
  const manifest = await io.get(`${prefix(candidateId)}manifest.json`, 8192);
  assert.ok(manifest && manifest.sha256 === candidateId, 'candidate receipt missing or invalid');
  const files = {};
  for (const name of FILES) {
    const file = await io.get(`${prefix(candidateId)}${name}`, MAX_FILE);
    assert.ok(file, 'candidate file missing');
    assert.equal(file.customMetadata?.sha256, file.sha256, 'candidate metadata changed');
    assert.ok(!file.httpMetadata?.contentEncoding, 'unexpected content encoding');
    files[name] = file.body;
  }
  let c;
  try {
    c = candidate(files);
  } catch (error) {
    if (!allowLegacyV1) throw error;
    c = legacyCandidate(files);
  }
  assert.equal(c.candidateId, candidateId, 'candidate bytes changed');
  return c;
}

// Renew availability of unchanged reviewed metadata, never its source timestamp.
// Absence/revocation/expiry requires a fresh manual activation, not resurrection.
export async function renewSearch(io, { approvedCandidateId, clock = Date.now, ensureV2Compatible }) {
  assert.match(approvedCandidateId, SHA);
  const before = await io.get(POINTER_KEY, 8192);
  assert.ok(before, 'renewal requires an active pointer');
  const pointer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(before.body));
  assert.ok(exact(pointer, ['schemaVersion', 'kind', 'candidateId', 'createdAt', 'expiresAt', 'files']) &&
    pointer.schemaVersion === 1 && pointer.kind === 'search', 'invalid active pointer');
  assert.equal(pointer.candidateId, approvedCandidateId, 'active candidate is not approved');
  const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value);
  assert.ok(iso(pointer.createdAt) && iso(pointer.expiresAt), 'invalid timestamp format');
  const created = Date.parse(pointer.createdAt), expires = Date.parse(pointer.expiresAt);
  const checkLive = () => {
    const now = clock();
    assert.ok(Number.isFinite(now) && Number.isFinite(created) && Number.isFinite(expires) && created <= now && expires > now &&
      expires > created && expires - created <= 48 * 3_600_000, 'invalid or expired lease');
    return now;
  };
  checkLive();
  const c = await verifyCandidate(io, approvedCandidateId, { allowLegacyV1: true });
  assert.deepEqual(pointer.files, c.files, 'pointer receipt differs from verified candidate');
  if (c.formatVersion === 2) assert.equal(typeof ensureV2Compatible, 'function',
    'V2 renewal requires the compatible staging shell');
  const now = checkLive();
  const renewed = { ...pointer, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 24 * 3_600_000).toISOString() };
  return writePointer(io, renewed, before.sha256, async () => {
    checkLive();
    if (c.formatVersion === 2) await ensureV2Compatible();
    checkLive();
  });
}

async function writePointer(io, pointer, expectedPointerSha256, beforePut = async () => {}) {
  assert.ok(expectedPointerSha256 === 'absent' || SHA.test(expectedPointerSha256 ?? ''), 'invalid pointer precondition');
  const before = await io.get(POINTER_KEY, 8192);
  assert.equal(before?.sha256 ?? 'absent', expectedPointerSha256, 'pointer changed; review before retry');
  const body = jsonBytes(pointer);
  await beforePut();
  await io.put(POINTER_KEY, body, { ...(before ? { ifMatch: before.etag } : { ifNoneMatch: '*' }), sha256: hash(body) });
  const after = await io.get(POINTER_KEY, 8192);
  assert.ok(after && after.sha256 === hash(body), 'pointer readback changed; inspect, do not overwrite');
  return { pointer, pointerSha256: hash(body), previousPointerSha256: before?.sha256 ?? 'absent' };
}
export const revokeSearch = (io, expectedPointerSha256) => writePointer(io,
  { schemaVersion: 1, kind: 'search', candidateId: null }, expectedPointerSha256);

export async function inspectSearch(io) {
  const current = await io.get(POINTER_KEY, 8192);
  // A corrupt pointer may itself contain untrusted text: report only its digest, never echo it.
  return { pointerSha256: current?.sha256 ?? 'absent', bytes: current?.body.length ?? 0 };
}

async function main() {
  const action = process.env.SEARCH_ACTION;
  searchGate(process.env, action);
  if (process.argv[2] === 'gate') return;
  if (process.argv[2] === 'source-compatibility') {
    assert.equal(action, 'activate', 'source compatibility proof is activation-only');
    assert.equal(typeof process.env.GITHUB_WORKSPACE, 'string', 'GitHub workspace missing');
    console.log(JSON.stringify(verifyV4Source(resolve(process.env.GITHUB_WORKSPACE, 'control'), process.env)));
    return;
  }
  if (process.argv[2] === 'compatibility') {
    assert.equal(action, 'activate', 'compatibility proof is activation-only');
    console.log(JSON.stringify(await verifyV4Staging(process.env)));
    return;
  }
  const { createSearchS3 } = await import('./staging-search-s3.mjs');
  const io = createSearchS3(process.env);
  try {
    let result;
    if (action === 'inspect') result = await inspectSearch(io);
    else if (action === 'prepare') {
      const directory = resolve(process.env.RUNNER_TEMP, 'staging-search', 'candidate');
      const files = Object.fromEntries(FILES.map(name => {
        const path = resolve(directory, name), stat = lstatSync(path);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE, 'invalid candidate file');
        return [name, readFileSync(path)];
      }));
      result = await prepareSearch(io, files);
    } else if (action === 'activate') {
      result = await activateSearch(io, { candidateId: process.env.CANDIDATE_SHA256,
        expectedPointerSha256: process.env.EXPECTED_POINTER_SHA256,
        ensureV2Compatible: () => verifyV4Staging(process.env) });
    } else if (action === 'renew') {
      result = await renewSearch(io, { approvedCandidateId: process.env.STAGING_SEARCH_APPROVED_CANDIDATE_SHA256,
        ensureV2Compatible: () => verifyV4Staging(process.env) });
    } else result = await revokeSearch(io, process.env.EXPECTED_POINTER_SHA256);
    console.log(JSON.stringify(result)); // Only identities and bounded receipts, never bodies or credentials.
  } finally { io.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('staging search action refused; inspect gate/receipt and retry only after review'); process.exitCode = 1; });
}
