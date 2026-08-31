// Exact, encrypted UI artifacts. No source trees, plaintext Worker bundles, or data archives
// may be uploaded to this public repository's Actions artifacts.
import assert from 'node:assert/strict';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export const CONTROL_SHA = 'dbc97a26bc239398ffa9ec157a094148961b6451';
export const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
export const FREEZE_UNTIL = '2026-08-31T11:00:00Z';
export const MAX_BYTES = 96 * 1024 * 1024;
export const MAX_FILES = 5000;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const PROFILE = Object.freeze({ product: 'lab', account: false, expandedModels: false, data: false });
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]{0,19}$/;
const MAGIC = Buffer.from('WXUI1\0');

export function gate(env, now = Date.now()) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'UI deployment must be manually requested');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'only the protected workflow branch is permitted');
  assert.equal(env.UI_RELEASES_ENABLED, 'true', 'UI environment has not been explicitly enabled');
  assert.equal(env.UI_ISOLATION_APPROVED, 'true', 'credential and staging isolation review is required');
  const until = Date.parse(env.UI_DEPLOYMENT_HOLD_UNTIL);
  assert.ok(Number.isFinite(until), 'deployment hold must be explicitly configured');
  assert.ok(now >= Math.max(until, Date.parse(FREEZE_UNTIL)), 'deployment freeze is still active');
}

export function safePath(path) {
  assert.ok(typeof path === 'string' && path.length <= 240 && /^[A-Za-z0-9_./@+-]+$/.test(path), 'unsafe artifact path');
  assert.ok(!path.startsWith('/') && path.split('/').every(p => p && p !== '.' && p !== '..'), 'path traversal');
  assert.ok(!/^(data|data-atmos|point-series|functions|node_modules|\.git)(\/|$)/.test(path), 'source/data archive prohibited');
  assert.ok(!/\.(map|ts|tsx|pem|key)$/.test(path) && !path.includes('.env'), 'private source/secret file prohibited');
  return path;
}

export function readTree(root) {
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'artifact root must be a real directory');
  const files = []; let total = 0;
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir).sort()) {
      const path = safePath(prefix + name), full = resolve(dir, name), stat = lstatSync(full);
      assert.ok(!stat.isSymbolicLink(), 'symlink prohibited');
      if (stat.isDirectory()) walk(full, path + '/');
      else {
        assert.ok(stat.isFile(), 'special file prohibited');
        total += stat.size;
        assert.ok(total <= MAX_BYTES && files.length < MAX_FILES, 'artifact exceeds size/file limit');
        const bytes = readFileSync(full);
        files.push({ path, bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') });
      }
    }
  }
  walk(root);
  return files.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

export function validateFiles(files) {
  assert.ok(Array.isArray(files) && files.length > 0 && files.length <= MAX_FILES, 'invalid file inventory');
  const seen = new Set(); let total = 0;
  for (const file of files) {
    safePath(file.path);
    assert.ok(!seen.has(file.path), 'duplicate path'); seen.add(file.path);
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0, 'invalid file size');
    total += file.bytes; assert.ok(total <= MAX_BYTES, 'artifact exceeds byte limit');
    assert.ok(typeof file.base64 === 'string' && file.base64.length <= Math.ceil(MAX_BYTES / 3) * 4);
    const raw = Buffer.from(file.base64, 'base64');
    assert.equal(raw.toString('base64'), file.base64, 'noncanonical file encoding');
    assert.equal(raw.length, file.bytes); assert.equal(hash(raw), file.sha256, 'file hash mismatch');
    for (const parent of file.path.split('/').slice(0,-1).map((_,i,a) => a.slice(0,i+1).join('/'))) {
      assert.ok(!files.some(f => f.path === parent), 'file/directory collision');
    }
  }
  for (const path of ['index.html', '_worker.js', '_routes.json', 'health/release.json']) assert.ok(seen.has(path), `missing ${path}`);
  const inventory = files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { inventory, digest: hash(JSON.stringify(inventory)) };
}

export function createCandidate(root, context) {
  const files = readTree(root), { digest } = validateFiles(files);
  const candidate = { schemaVersion: 1, controlSha: CONTROL_SHA, profile: PROFILE,
    sourceSha: context.sourceSha, runId: context.runId, attempt: context.attempt,
    workflowSha: context.workflowSha, pipelineDigest: context.pipelineDigest, artifactDigest: digest, files };
  validateCandidate(candidate);
  return candidate;
}

export function validateCandidate(candidate) {
  assert.equal(candidate.schemaVersion, 1);
  assert.equal(candidate.controlSha, CONTROL_SHA, 'unreviewed release controller');
  assert.deepEqual(candidate.profile, PROFILE, 'non-public build profile');
  assert.match(candidate.sourceSha, SHA); assert.match(candidate.workflowSha, SHA);
  assert.match(candidate.runId, ID); assert.match(candidate.attempt, ID);
  assert.match(candidate.pipelineDigest, DIGEST);
  assert.equal(validateFiles(candidate.files).digest, candidate.artifactDigest, 'inventory mismatch');
  const receipt = JSON.parse(Buffer.from(candidate.files.find(f => f.path === 'health/release.json').base64, 'base64'));
  assert.equal(receipt.gitSha, candidate.sourceSha);
  assert.equal(receipt.workflowRunId, candidate.runId);
  assert.equal(receipt.releaseId, `git-${candidate.sourceSha.slice(0,12)}-run-${candidate.runId}`);
  const shell = candidate.files.filter(f => f.path !== 'health/release.json').sort((a,b) => a.path < b.path ? -1 : 1);
  const digest = createHash('sha256');
  for (const f of shell) digest.update(f.path).update('\0').update(String(f.bytes)).update('\0').update(Buffer.from(f.base64,'base64')).update('\0');
  assert.equal(digest.digest('hex'), receipt.shellSha256, 'source receipt shell hash mismatch');
  assert.equal(receipt.shellFileCount, shell.length); assert.equal(receipt.shellBytes, shell.reduce((n,f)=>n+f.bytes,0));
  assert.equal(receipt.indexSha256, candidate.files.find(f => f.path === 'index.html').sha256);
  return receipt;
}

function keyBytes(key) {
  // A dedicated random key shared only by the two UI environments. Never a CF/API token.
  assert.ok(typeof key === 'string' && /^[a-f0-9]{64}$/.test(key), 'UI_CANDIDATE_KEY must be a 32-byte hex key');
  return Buffer.from(key, 'hex');
}
export function seal(candidate, key) {
  validateCandidate(candidate);
  assert.ok(candidate.qualification, 'cannot retain an unqualified candidate');
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(JSON.stringify(candidate)), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}
export function unseal(bytes, key) {
  assert.ok(bytes.length > 34 && bytes.length <= MAX_BYTES * 2, 'invalid encrypted artifact size');
  assert.ok(bytes.subarray(0,6).equals(MAGIC), 'invalid encrypted artifact format');
  const cipher = createDecipheriv('aes-256-gcm', keyBytes(key), bytes.subarray(6,18));
  cipher.setAAD(MAGIC); cipher.setAuthTag(bytes.subarray(18,34));
  const candidate = JSON.parse(Buffer.concat([cipher.update(bytes.subarray(34)), cipher.final()]));
  validateCandidate(candidate); return candidate;
}

export function restore(candidate, root) {
  validateCandidate(candidate);
  // Refuse an existing destination. No overlays, stale files, symlink ancestors or partial reuse.
  assert.ok(lstatSync(dirname(root)).isDirectory() && !lstatSync(dirname(root)).isSymbolicLink());
  mkdirSync(root, { mode: 0o700 });
  for (const file of candidate.files) {
    const full = resolve(root, file.path);
    mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
    writeFileSync(full, Buffer.from(file.base64,'base64'), { flag: 'wx', mode: 0o600 });
  }
  assert.equal(validateFiles(readTree(root)).digest, candidate.artifactDigest);
}

export function eligibleRun(run, artifacts, { runId, sourceSha, digest, pipelineDigest, candidate }, now = Date.now()) {
  assert.match(runId, ID); assert.match(sourceSha, SHA); assert.match(digest, DIGEST);
  assert.equal(String(run.id), runId); assert.equal(run.repository?.full_name, REPOSITORY);
  assert.equal(run.path, '.github/workflows/ui-staging.yml');
  assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.head_branch, 'main');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(candidate.runId, runId); assert.equal(candidate.attempt, String(run.run_attempt));
  assert.equal(candidate.workflowSha, run.head_sha); assert.equal(candidate.sourceSha, sourceSha);
  assert.equal(candidate.artifactDigest, digest); assert.equal(candidate.pipelineDigest, pipelineDigest, 'release policy changed: stage again');
  const matches = artifacts.filter(a => a.name === `ui-candidate-${runId}-${run.run_attempt}`);
  assert.equal(matches.length, 1, 'a unique exact-attempt candidate is required');
  assert.equal(matches[0].expired, false); assert.ok(Date.parse(matches[0].expires_at) > now, 'candidate expired');
  const q = candidate.qualification;
  assert.equal(q?.origin, 'https://staging.weatherx.org'); assert.equal(q?.artifactDigest, digest);
  assert.equal(q?.fullTests, true); assert.equal(q?.weatherLab, true); assert.equal(q?.builtRuntime, true);
  assert.equal(q?.probes, 3); assert.match(q?.deploymentId ?? '', /^[a-f0-9-]{36}$/);
  assert.ok(Date.parse(q.qualifiedAt) <= now && now - Date.parse(q.qualifiedAt) < 30 * 86400000, 'staging qualification is stale');
  return matches[0];
}
