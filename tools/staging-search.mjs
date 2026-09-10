// Independent staging-only search publication. No weather pointers, model data, Worker/API
// tokens, arbitrary bucket names or credential-chain fallback are accepted by this lane.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
export const BUCKET = 'weatherx-data-staging';
export const POINTER_KEY = 'shared-read/ancillary-search.json';
export const FILES = ['core.json', 'more.json'];
const SHA = /^[a-f0-9]{64}$/;
const MAX_FILE = 1024 * 1024;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value)}\n`);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));

export function searchGate(env, action) {
  assert.ok(['inspect', 'prepare', 'activate', 'revoke'].includes(action), 'unsupported search action');
  assert.equal(env.GITHUB_ACTIONS, 'true', 'publication is cloud-only');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
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
  }
}

export function validateIndex(bytes, name) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_FILE, 'index exceeds byte budget');
  assert.ok(gzipSync(bytes, { level: 9 }).length <= 130 * 1024, 'index exceeds transfer budget');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.ok(exact(value, ['v', 'baked_at', 'families']) && value.v === 1 &&
    typeof value.baked_at === 'string' && Number.isFinite(Date.parse(value.baked_at)), 'invalid index envelope');
  const families = name === 'core.json' ? ['airport', 'storm'] : name === 'more.json' ? ['station', 'tide', 'sonde'] : [];
  assert.ok(families.length && exact(value.families, families), 'missing or unexpected search family');
  for (const family of families) {
    const row = value.families[family];
    assert.ok(object(row) && (exact(row, ['n', 'disp', 'll']) || exact(row, ['n', 'disp', 'll', 'w'])), 'invalid family shape');
    assert.ok(Number.isSafeInteger(row.n) && row.n > 0 && row.n <= 200_000 && typeof row.disp === 'string', 'invalid row count');
    const lines = row.disp.split('\n');
    assert.equal(lines.length, row.n, 'display/count mismatch');
    assert.ok(lines.every(line => line.length > 0 && line.length <= 1024 && !/[\r\0]/.test(line) &&
      line.split('\t').length === (family === 'storm' ? 6 : 2)), 'invalid display columns');
    assert.ok(Array.isArray(row.ll) && row.ll.length === 2 * row.n && row.ll.every((n, i) =>
      Number.isSafeInteger(n) && Math.abs(n) <= (i % 2 ? 180_000 : 90_000)), 'invalid coordinates');
    if (row.w !== undefined) assert.ok(Array.isArray(row.w) && row.w.length === row.n && row.w.every(n => Number.isInteger(n) && n >= 0 && n <= 255), 'invalid weights');
  }
  if (name === 'core.json') {
    assert.ok(value.families.airport.disp.split('\n').some(line => {
      const codes = line.split('\t')[1]?.split(' ');
      return codes?.includes('KSFO') && codes.includes('SFO');
    }), 'SFO/KSFO acceptance anchor missing');
  }
  return value;
}

export function candidate(files) {
  assert.ok(exact(files, FILES), 'both files required');
  const receipts = {};
  for (const name of FILES) {
    validateIndex(files[name], name);
    receipts[name] = { bytes: files[name].length, sha256: hash(files[name]) };
  }
  const manifest = jsonBytes({ schemaVersion: 1, kind: 'search', files: receipts });
  return { candidateId: hash(manifest), manifest, files: receipts };
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
  return { candidateId: c.candidateId, files: c.files, activated: false };
}

export async function activateSearch(io, { candidateId, expectedPointerSha256, now = Date.now(), hours = 24 }) {
  assert.ok(Number.isFinite(now) && Number.isInteger(hours) && hours >= 1 && hours <= 48, 'invalid activation lifetime');
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
  const c = candidate(files);
  assert.equal(c.candidateId, candidateId, 'candidate bytes changed');
  const pointer = { schemaVersion: 1, kind: 'search', candidateId,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + hours * 3_600_000).toISOString(), files: c.files };
  return writePointer(io, pointer, expectedPointerSha256);
}

async function writePointer(io, pointer, expectedPointerSha256) {
  assert.ok(expectedPointerSha256 === 'absent' || SHA.test(expectedPointerSha256 ?? ''), 'invalid pointer precondition');
  const before = await io.get(POINTER_KEY, 8192);
  assert.equal(before?.sha256 ?? 'absent', expectedPointerSha256, 'pointer changed; review before retry');
  const body = jsonBytes(pointer);
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
        expectedPointerSha256: process.env.EXPECTED_POINTER_SHA256 });
    } else result = await revokeSearch(io, process.env.EXPECTED_POINTER_SHA256);
    console.log(JSON.stringify(result)); // Only identities and bounded receipts, never bodies or credentials.
  } finally { io.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('staging search action refused; inspect gate/receipt and retry only after review'); process.exitCode = 1; });
}
