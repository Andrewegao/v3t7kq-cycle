// Cloud-only replay of already published bytes. NO collector, processor, current-pointer
// mutation, catalog promotion, UI deployment, or production write operation exists here.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
export const MODELS = ['aifs', 'ecmwf', 'gfs', 'hrrr'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_OBJECTS = 100_000, MAX_BYTES = 40 * 1024 ** 3;
const checks = ['manifest', 'inventory', 'remote_bytes', 'coverage', 'freshness', 'live_superset', 'horizon', 'cadence', 'grid', 'referenced_bytes'];
export const hash = x => createHash('sha256').update(x).digest('hex');
export function identifier(value) { assert.match(value ?? '', ID); assert.ok(!value.includes('..')); return value; }
export function safePath(value) {
  assert.ok(typeof value === 'string' && value.length <= 1024 && /^[A-Za-z0-9_./@+-]+$/.test(value), 'unsafe object key');
  assert.ok(value.split('/').every(p => p && p !== '.' && p !== '..'), 'object key traversal');
  return value;
}
export function selection(env) {
  const value = { releaseId: identifier(env.RELEASE_ID), releaseManifestSha256: env.RELEASE_MANIFEST_SHA256,
    catalogId: identifier(env.CATALOG_ID), catalogSha256: env.CATALOG_SHA256 };
  assert.match(value.releaseManifestSha256 ?? '', SHA); assert.match(value.catalogSha256 ?? '', SHA);
  return value;
}
export function gate(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'shared-data preparation is cloud-only');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch'); assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.STAGING_DATA_ENABLED, 'true', 'staging data lane remains disabled');
  assert.equal(env.STAGING_DATA_ISOLATION_APPROVED, 'true', 'effective bucket-scoped credentials must be audited');
  assert.equal(env.STAGING_R2_ACCOUNT_ID, ACCOUNT, 'same-account storage only');
  const pin = selection(env);
  assert.equal(hash(JSON.stringify(pin)), env.STAGING_DATA_APPROVED_SELECTION_SHA256, 'snapshot differs from reviewed selection');
  return pin;
}
function date(value, now) {
  const time = Date.parse(value);
  assert.ok(typeof value === 'string' && Number.isFinite(time) && time <= now + 300_000, 'invalid/future timestamp');
  return time;
}
function inventory(items, sizeKey) {
  assert.ok(Array.isArray(items) && items.length > 0 && items.length <= MAX_OBJECTS, 'invalid inventory count');
  const seen = new Set(); let total = 0;
  for (const item of items) {
    safePath(item.path); assert.ok(!seen.has(item.path), 'duplicate inventory path'); seen.add(item.path);
    assert.ok(Number.isSafeInteger(item[sizeKey]) && item[sizeKey] >= 0, 'invalid object size');
    total += item[sizeKey]; assert.ok(total <= MAX_BYTES, 'snapshot exceeds disk budget');
    assert.match(item.sha256 ?? '', SHA);
  }
  for (const key of seen) {
    const parts = key.split('/'); parts.pop();
    while (parts.length) { assert.ok(!seen.has(parts.join('/')), 'file/directory collision'); parts.pop(); }
  }
  return total;
}
export function validateRelease(pointer, manifest, pin, now = Date.now()) {
  assert.equal(pointer.schemaVersion, 1); assert.equal(pointer.releaseId, pin.releaseId);
  assert.equal(pointer.manifestSha256, pin.releaseManifestSha256);
  assert.equal(hash(JSON.stringify(manifest)), pin.releaseManifestSha256, 'whole manifest hash mismatch');
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.releaseId, pin.releaseId);
  assert.ok(now - date(pointer.publishedAt, now) <= 48 * 3600_000, 'published snapshot is too old');
  date(manifest.createdAt, now);
  const bytes = inventory(manifest.objects, 'bytes');
  assert.equal(pointer.objectCount, manifest.objects.length); assert.equal(manifest.objectCount, pointer.objectCount);
  for (const item of manifest.objects) assert.match(item.path, /^(data|data-atmos|point-series)\//);
  // The pinned upstream validator also checks every WXPS descriptor and its complete
  // inventory. These preliminary checks refuse missing point products before transfer.
  assert.equal(manifest.pointSeries?.schemaVersion, 2, 'qualified v2 point products required');
  assert.deepEqual(pointer.pointSeries, manifest.pointSeries);
  for (const model of ['ecmwf', 'gfs']) {
    const m = manifest.pointSeries.models?.[model];
    assert.ok(m && Date.parse(m.freshUntil) > now + 30 * 60_000, 'point source lacks freshness margin');
  }
  const paths = new Set(manifest.objects.filter(o => o.bytes > 0).map(o => o.path));
  for (const path of ['data/ledger/index.json', 'data/verify/index.json', 'data/ledger/accuracy/current.json', 'data/ledger/accuracy/current.txt'])
    assert.ok(paths.has(path), `required whole-release product missing: ${path}`);
  return bytes;
}
export function validateCatalog(pointer, raw, pin, now = Date.now()) {
  assert.equal(pointer.schemaVersion, 2); assert.equal(pointer.catalogId, pin.catalogId);
  assert.equal(pointer.catalogSha256, pin.catalogSha256); assert.equal(hash(raw), pin.catalogSha256, 'catalog hash mismatch');
  const catalog = JSON.parse(raw);
  assert.equal(catalog.schemaVersion, 2); assert.ok(Number.isSafeInteger(catalog.sequence) && catalog.sequence > 0);
  assert.equal(catalog.sequence, pointer.sequence); assert.equal(catalog.createdAt, pointer.publishedAt);
  assert.equal(catalog.parentCatalogId, pointer.previousCatalogId);
  assert.equal(catalog.rollbackOfCatalogId ?? null, pointer.rollbackOfCatalogId ?? null);
  date(catalog.createdAt, now);
  assert.deepEqual(Object.keys(catalog.components ?? {}).sort(), MODELS, 'unqualified model/catalog expansion');
  for (const [id, c] of Object.entries(catalog.components)) {
    assert.equal(c.schemaVersion, 1); assert.equal(c.componentId, id); identifier(c.artifactId);
    assert.equal(c.rootPrefix, `components/${id}/${c.artifactId}/`);
    assert.equal(c.manifestKey, `${c.rootPrefix}component.json`); assert.deepEqual(c.mounts, [`data/${id}/`]);
    assert.match(c.manifestSha256, SHA); assert.match(c.inventorySha256, SHA);
    assert.ok(Number.isSafeInteger(c.objectCount) && c.objectCount > 0 && c.objectCount <= MAX_OBJECTS);
    assert.ok(now - date(c.generationTime, now) <= 48 * 3600_000, 'component generation too old'); date(c.completedAt, now);
    assert.equal(c.quality?.status, 'passed'); assert.ok(checks.every(x => c.quality.checks?.includes(x)), 'missing original component gates');
  }
  return catalog;
}
export function validateComponent(c, raw) {
  assert.equal(hash(raw), c.manifestSha256, 'component manifest hash mismatch');
  const m = JSON.parse(raw), { manifestKey, manifestSha256, ...descriptor } = c;
  assert.deepEqual(m, descriptor, 'component descriptor changed'); return m;
}
export async function localInventory(root) {
  const files = [];
  async function visit(dir, prefix = '') {
    const stat = lstatSync(dir); assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'real directory required');
    for (const name of readdirSync(dir).sort((a,b) => a.localeCompare(b))) {
      const path = safePath(prefix + name), full = resolve(dir, name), s = lstatSync(full);
      if (s.isDirectory() && !s.isSymbolicLink()) await visit(full, path + '/');
      else {
        assert.ok(s.isFile() && !s.isSymbolicLink(), 'non-regular object');
        const digest = createHash('sha256'); for await (const chunk of createReadStream(full)) digest.update(chunk);
        files.push({ path, size: s.size, sha256: digest.digest('hex') });
      }
    }
  }
  await visit(root); inventory(files, 'size'); return files;
}
export function compareInventory(actual, expected) {
  const ordered = values => [...values].sort((a,b) => a.path < b.path ? -1 : 1);
  assert.deepEqual(ordered(actual), ordered(expected), 'downloaded inventory/bytes differ');
}
const byPath = (a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
function listing(items) {
  assert.ok(Array.isArray(items) && items.length <= MAX_OBJECTS + 1, 'oversized listing');
  const seen = new Set(); let total = 0;
  return items.map(item => {
    const path = safePath(item.Path);
    assert.equal(item.IsDir, false); assert.ok(!seen.has(path), 'duplicate listed path'); seen.add(path);
    assert.ok(Number.isSafeInteger(item.Size) && item.Size >= 0); total += item.Size;
    assert.ok(total <= MAX_BYTES, 'listed tree exceeds disk budget');
    return {path, size:item.Size};
  }).sort(byPath);
}

// rclone uses the S3 endpoint, not Cloudflare REST. Build its environment from an
// allowlist: neither inherited remotes nor broad Cloudflare credentials are passed.
export function transferEnvironment(env, role) {
  assert.ok(['read', 'write'].includes(role));
  const prefix = role === 'read' ? 'SHARED_R2_READ' : 'STAGING_R2_WRITE';
  assert.ok(env[`${prefix}_ACCESS_KEY_ID`] && env[`${prefix}_SECRET_ACCESS_KEY`], 'missing scoped S3 credentials');
  return { PATH: env.PATH, HOME: env.HOME, RCLONE_CONFIG: '/dev/null',
    RCLONE_CONFIG_OBJECTS_TYPE: 's3', RCLONE_CONFIG_OBJECTS_PROVIDER: 'Cloudflare',
    RCLONE_CONFIG_OBJECTS_REGION: 'auto', RCLONE_CONFIG_OBJECTS_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID: env[`${prefix}_ACCESS_KEY_ID`],
    RCLONE_CONFIG_OBJECTS_SECRET_ACCESS_KEY: env[`${prefix}_SECRET_ACCESS_KEY`] };
}
function remote(kind, key, role) {
  assert.ok(['data', 'components'].includes(kind)); safePath(key);
  assert.ok(kind === 'components' ? key.startsWith('components/') :
    key.startsWith('releases/') || key.startsWith('catalogs/') || key.startsWith('staging-candidates/'));
  if (role === 'write') assert.ok(!key.endsWith('/current.json'), 'current pointers are never written by preparation');
  return `objects:weatherx-${kind}-${role === 'read' ? 'production' : 'staging'}/${key}`;
}
// Log only controller-owned labels/numbers. Never serialize subprocess stderr,
// request headers, credentials, local paths, or arbitrary remote error messages.
function failureFields(error) {
  return { exitCode: Number.isInteger(error?.status) ? error.status : null,
    signal: ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(error?.signal) ? error.signal : null,
    timedOut: error?.code === 'ETIMEDOUT' };
}
export function createTransport(env, execute = execFileSync, emit = () => {}) {
  function call(role, args) {
    const started = performance.now(), operation = args[0];
    assert.ok(['cat', 'lsjson', 'copy', 'check', 'copyto'].includes(operation));
    emit({ event: 'transfer-start', role, operation });
    try {
      const result = execute('rclone', [...args, '--s3-no-check-bucket', '--retries', '1', '--low-level-retries', '2', '--contimeout', '15s', '--timeout', '60s'],
        { env: transferEnvironment(env, role), maxBuffer: 32 * 1024 ** 2, timeout: 45 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
      emit({ event: 'transfer-complete', role, operation, elapsedMs: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      emit({ event: 'transfer-failed', role, operation, elapsedMs: Math.round(performance.now() - started), ...failureFields(error) });
      throw Error(`S3 ${role} ${operation} failed; snapshot not activated`);
    }
  }
  return {
    get: (kind, key) => call('read', ['cat', remote(kind, key, 'read')]),
    // Only Path/Size/IsDir feed the inventory gate. Asking S3 for unused ModTime
    // or MimeType adds a HEAD per object; full byte hashing/readback stays below.
    list: (kind, prefix) => JSON.parse(call('read', ['lsjson', remote(kind, prefix, 'read'), '--recursive', '--files-only', '--no-modtime', '--no-mimetype'])),
    download: (kind, prefix, dir) => call('read', ['copy', remote(kind, prefix, 'read'), dir, '--transfers', '4', '--checkers', '8', '--max-transfer', '40Gi', '--cutoff-mode', 'HARD']),
    upload: (kind, prefix, dir) => {
      const target = remote(kind, prefix, 'write');
      call('write', ['copy', dir, target, '--immutable', '--transfers', '4', '--checkers', '8']);
      // --immutable alone does not prove bytes for equal-size objects or multipart ETags.
      call('write', ['check', dir, target, '--download', '--checkers', '4']);
    },
    put: (kind, key, file) => {
      const target = remote(kind, key, 'write');
      call('write', ['copyto', file, target, '--immutable']);
      assert.equal(hash(call('write', ['cat', target])), hash(readFileSync(file)), 'staging control object byte mismatch');
    },
  };
}
export async function prepare(pin, io, root, validatePoints, clock = Date.now, emit = () => {}) {
  // A fixed timestamp remains a fixture seam; the cloud entrypoint always uses
  // the live clock, including after long transfers and before the final receipt.
  const currentTime = typeof clock === 'function' ? clock : () => clock;
  const now = currentTime();
  async function phase(name, fn) {
    const started = performance.now(); emit({ event: 'phase-start', phase: name });
    try {
      const result = await fn();
      emit({ event: 'phase-complete', phase: name, elapsedMs: Math.round(performance.now() - started) });
      return result;
    } catch (error) {
      emit({ event: 'phase-failed', phase: name, elapsedMs: Math.round(performance.now() - started) });
      throw error;
    }
  }
  mkdirSync(root, { mode: 0o700 }); // existing/stale trees are refused, never overlaid
  emit({ event: 'phase-start', phase: 'source-controls' });
  const releaseRaw = io.get('data', 'releases/current.json'), release = JSON.parse(releaseRaw);
  const catalogPointerRaw = io.get('data', 'catalogs/current.json'), catalogPointer = JSON.parse(catalogPointerRaw);
  const manifestRaw = io.get('data', `releases/${pin.releaseId}/manifest.json`), manifest = JSON.parse(manifestRaw);
  const catalogRaw = io.get('data', `catalogs/snapshots/${pin.catalogId}.json`);
  let total = validateRelease(release, manifest, pin, now);
  await validatePoints(manifest); // exact pinned v2 schema/inventory validator, before transfer
  const catalog = validateCatalog(catalogPointer, catalogRaw, pin, now);
  emit({ event: 'phase-complete', phase: 'source-controls', objects: manifest.objectCount, bytes: total });
  const save = (name, bytes) => { const p = resolve(root, name); writeFileSync(p, bytes, { flag: 'wx', mode: 0o600 }); return p; };
  const manifestFile = save('manifest.json', manifestRaw), releaseFile = save('release-pointer.json', releaseRaw);
  const catalogFile = save('catalog.json', catalogRaw), catalogPointerFile = save('catalog-pointer.json', catalogPointerRaw);
  const whole = resolve(root, 'whole'); mkdirSync(whole);
  // Audit the entire listing before downloading, not after an unexpected tree fills disk.
  // Prefixes must contain exactly the manifest allowlist; no bucket/vault mirroring.
  for (const top of ['data', 'data-atmos', 'point-series']) {
    const dir = resolve(whole, top); mkdirSync(dir);
    const listed = listing(await phase(`whole-${top}-list`, () => io.list('data', `releases/${pin.releaseId}/${top}`)));
    assert.deepEqual(listed, manifest.objects.filter(o => o.path.startsWith(top + '/')).map(o =>
      ({path:o.path.slice(top.length + 1), size:o.bytes})).sort(byPath), 'unexpected source objects');
    emit({ event: 'inventory', phase: `whole-${top}`, objects: listed.length, bytes: listed.reduce((n,o) => n + o.size, 0) });
    await phase(`whole-${top}-download`, () => io.download('data', `releases/${pin.releaseId}/${top}`, dir));
  }
  await phase('whole-sha256', async () => compareInventory(await localInventory(whole), manifest.objects.map(({path, bytes, sha256}) => ({path, size: bytes, sha256}))));
  const components = [];
  for (const c of Object.values(catalog.components)) {
    const raw = io.get('components', c.manifestKey); validateComponent(c, raw);
    const dir = resolve(root, c.componentId); mkdirSync(dir);
    const listed = listing(await phase(`${c.componentId}-list`, () => io.list('components', c.rootPrefix.slice(0,-1))));
    assert.equal(listed.length, c.objectCount + 1, 'unexpected component object count');
    assert.equal(listed.find(o => o.path === 'component.json')?.size, raw.length, 'component metadata size changed');
    const componentBytes = listed.reduce((n,o) => n + (o.path === 'component.json' ? 0 : o.size), 0);
    assert.ok(total + componentBytes <= MAX_BYTES, 'combined snapshot exceeds disk budget');
    emit({ event: 'inventory', phase: c.componentId, objects: listed.length, bytes: componentBytes });
    await phase(`${c.componentId}-download`, () => io.download('components', c.rootPrefix.slice(0,-1), dir));
    const all = await phase(`${c.componentId}-sha256`, () => localInventory(dir)), values = all.filter(f => f.path !== 'component.json');
    assert.equal(hash(readFileSync(resolve(dir, 'component.json'))), c.manifestSha256);
    assert.equal(values.length, c.objectCount); assert.equal(hash(JSON.stringify(values)), c.inventorySha256, 'component inventory hash mismatch');
    total += inventory(values, 'size'); assert.ok(total <= MAX_BYTES, 'combined snapshot exceeds disk budget');
    components.push({ descriptor: c, dir });
  }
  // No controller fields are rewritten: source IDs, timestamps, hashes and quality receipts
  // retain their original meaning. A copy is NOT a new model issue or accuracy claim.
  const freshness = () => {
    const time = currentTime(); validateRelease(release, manifest, pin, time); validateCatalog(catalogPointer, catalogRaw, pin, time);
  };
  await phase('pre-upload-freshness', freshness);
  for (const { descriptor: c, dir } of components) await phase(`${c.componentId}-upload-readback`, () => io.upload('components', c.rootPrefix.slice(0,-1), dir));
  for (const top of ['data', 'data-atmos', 'point-series']) await phase(`whole-${top}-upload-readback`, () => io.upload('data', `releases/${pin.releaseId}/${top}`, resolve(whole, top)));
  io.put('data', `releases/${pin.releaseId}/manifest.json`, manifestFile);
  // Catalog metadata is prepared under the candidate, not a serving snapshot key: the
  // activation controller must install its verified sha256 metadata before selecting it.
  const candidateId = hash(JSON.stringify(pin)), prefix = `staging-candidates/${candidateId}`;
  io.put('data', `${prefix}/release-pointer.json`, releaseFile);
  io.put('data', `${prefix}/catalog.json`, catalogFile);
  io.put('data', `${prefix}/catalog-pointer.json`, catalogPointerFile);
  // Deterministic receipt makes repeated preparation of identical bytes idempotent.
  // The workflow run records the execution time; upstream timestamps are preserved.
  const receipt = { schemaVersion: 1, candidateId, selection: pin,
    objects: manifest.objectCount + components.reduce((n,c) => n + c.descriptor.objectCount, 0), bytes: total,
    collected: false, processed: false, activated: false, productionWritten: false,
    producerSource: 'preserved upstream receipts; no new collector-source attestation',
    components: components.map(({descriptor:c}) => ({model:c.componentId, artifactId:c.artifactId, manifestSha256:c.manifestSha256})) };
  await phase('pre-receipt-freshness', freshness);
  await phase('completed-receipt', () => io.put('data', `${prefix}/receipt.json`, save('receipt.json', JSON.stringify(receipt) + '\n')));
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const pin = gate(process.env);
    if (process.argv[2] === 'gate') console.log(JSON.stringify({selection:pin, collects:false, activates:false}));
    else {
      assert.equal(process.argv[2], 'prepare');
      const control = resolve(process.env.GITHUB_WORKSPACE, 'control');
      assert.equal(execFileSync('git', ['rev-parse','HEAD'], {cwd:control,encoding:'utf8'}).trim(), 'dbc97a26bc239398ffa9ec157a094148961b6451');
      execFileSync('git', ['diff','--exit-code','HEAD'], {cwd:control,stdio:'pipe'});
      const { validatePointSeriesDescriptor } = await import(pathToFileURL(resolve(control, 'ops/platform/validate-point-series.mjs')));
      const emit = event => console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
      const receipt = await prepare(pin, createTransport(process.env, execFileSync, emit), resolve(process.env.RUNNER_TEMP, 'shared-staging-snapshot'),
        m => validatePointSeriesDescriptor(m.pointSeries, m.objects), Date.now, emit);
      console.log(JSON.stringify(receipt));
    }
  } catch (error) { console.error(`Shared-data preparation refused: ${error.message}`); process.exitCode = 1; }
}
