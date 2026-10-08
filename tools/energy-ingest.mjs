#!/usr/bin/env node
// Energy Desk own ingest (Kazakhstan energy edition, owner ruling 2026-10-08: no aggregators).
// glofas-ingest.yml and cams-ingest.yml run the pinned Atmos producers (data/fetch_glofas.py --dams,
// data/fetch_cams.py), then this controller publishes the result as ONE immutable catalog component
// per family through the unchanged Atmos publisher (ops/platform/publish-r2-component.sh, PROMOTE=1,
// compare-and-swap on the served component), and reads the public pointer back.
//
//   family  component       mount                        public pointer
//   glofas  energy-glofas   data-atmos/energy/glofas/    /data-atmos/energy/glofas/current.json
//   cams    energy-cams     data-atmos/energy/cams/      /data-atmos/energy/cams/current.json
//
// Operations (all refuse outside main of this repository):
//   check-tree <family> <dir>            the producer output is exactly a pointer + the files it names
//   served <family> <expectedInit>       prints served=<true|false>: is that init already public?
//   publish <family> <dir> <atmos>       read the catalog precondition (served component sha, rollback
//                                        epoch, no mount conflict), then stage + promote through the
//                                        Atmos publisher; the catalog endpoint refuses a stale precondition
//   readback <family> <dir>              public pointer and dated file hash-match the source tree
// A failed run never touches the served component: the last good pointer keeps serving, and the
// app labels it with its own init (and drops it after 48 h for GloFAS, 24 h for CAMS).
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, readdirSync, statSync, appendFileSync} from 'node:fs';
import {join, relative, resolve, sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const FAMILIES = Object.freeze({
  glofas: Object.freeze({componentId: 'energy-glofas', mount: 'data-atmos/energy/glofas/',
    dated: /^\d{8}\/dams\.json$/, extra: [], maxBytes: 2 * 1024 * 1024, docSchema: 'weatherx.energy.glofas.dams/1',
    attribution: /^Contains modified Copernicus Emergency Management Service information \d{4}$/}),
  cams: Object.freeze({componentId: 'energy-cams', mount: 'data-atmos/energy/cams/',
    dated: /^\d{8}(?:00|12)\/clusters\.json$/, extra: [/^\d{8}(?:00|12)\/dust-map\.json$/], maxBytes: 4 * 1024 * 1024,
    docSchema: 'weatherx.energy.cams.clusters/1',
    attribution: /^Generated using Copernicus Atmosphere Monitoring Service information \d{4}$/}),
});
export const POINTER_SCHEMA = 'weatherx.energy.pointer/1';
const ORIGIN = 'https://weatherx.org';
const ENDPOINT = 'https://weatherx.org/api/platform/internal/catalog';
const DATA = 'weatherx:weatherx-data-production';
const COMPONENTS = 'weatherx:weatherx-components-production';
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ISO_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
class EnergyIngestError extends Error {}
const fail = (ok, code) => { if (!ok) throw new EnergyIngestError(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function family(name) {
  fail(Object.hasOwn(FAMILIES, name), 'unknown-family');
  return FAMILIES[name];
}

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    const path = join(dir, entry.name);
    fail(!entry.isSymbolicLink(), 'symlink-in-tree');
    if (entry.isDirectory()) walk(root, path, out);
    else out.push(relative(root, path).split(sep).join('/'));
  }
  return out.sort();
}

/** The producer output must be exactly current.json + the dated document (+ the CAMS map it names). */
export function checkTree(name, dir) {
  const spec = family(name);
  const files = walk(dir);
  fail(files.includes('current.json'), 'pointer-missing');
  const pointer = JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8'));
  fail(pointer?.schema === POINTER_SCHEMA && pointer.family === name && ISO_Z.test(pointer.newest_init ?? '') &&
    ISO_Z.test(pointer.baked_at ?? '') && HASH.test(pointer.sha256 ?? '') && Number.isSafeInteger(pointer.bytes) &&
    spec.dated.test(pointer.path ?? '') && spec.attribution.test(pointer.attribution ?? '') && pointer.fixture !== true,
  'pointer-contract');
  const named = [pointer.path, ...(pointer.map ? [pointer.map] : [])];
  if (pointer.map) fail(spec.extra.some(rx => rx.test(pointer.map)) && pointer.map.split('/')[0] === pointer.path.split('/')[0], 'pointer-map');
  assert.deepEqual(files, ['current.json', ...named].sort(), 'tree-is-exactly-pointer-and-named-files');
  const body = readFileSync(join(dir, pointer.path));
  fail(body.length === pointer.bytes && body.length <= spec.maxBytes && sha(body) === pointer.sha256, 'dated-file-hash');
  const doc = JSON.parse(body.toString('utf8'));
  fail(doc?.schema === spec.docSchema && doc.newest_init === pointer.newest_init && doc.fixture !== true &&
    doc.attribution === pointer.attribution, 'document-contract');
  for (const path of named) fail(statSync(join(dir, path)).size <= spec.maxBytes, 'file-size');
  return {pointer, files};
}

/** The served component, if any, and proof nothing else claims or shadows this family's mount. */
export function catalogPrecondition(name, catalog, releaseManifest) {
  const {componentId, mount} = family(name);
  fail(object(catalog?.components), 'catalog-envelope');
  for (const [id, c] of Object.entries(catalog.components)) {
    for (const active of c.mounts ?? []) {
      const overlaps = active.startsWith(mount) || mount.startsWith(active);
      // A broad fallback mount (data-atmos/) is a shorter prefix; routing is longest-prefix, so only an
      // equal or deeper mount owned by another component is a conflict.
      if (overlaps && active.length >= mount.length) fail(id === componentId && active === mount, 'mount-claimed-by-another-component');
    }
  }
  if (releaseManifest) {
    fail(Array.isArray(releaseManifest.objects), 'release-manifest');
    fail(!releaseManifest.objects.some(row => typeof row.path === 'string' && row.path.startsWith(mount)), 'whole-release-shadows-mount');
  }
  const previous = catalog.components[componentId] ?? null;
  if (previous) fail(HASH.test(previous.manifestSha256 ?? '') && previous.mounts?.length === 1 && previous.mounts[0] === mount, 'previous-component');
  return {previousManifestSha256: previous?.manifestSha256 ?? '', rollbackEpoch: catalog.rollbackEpoch ?? 0};
}

export function publisherEnv(name, dir, pointer, precondition, run) {
  const {componentId, mount} = family(name);
  fail(/^[1-9][0-9]*$/.test(run.id ?? '') && /^[1-9][0-9]*$/.test(run.attempt ?? ''), 'run-identity');
  const artifactId = `${componentId}-${pointer.newest_init.replace(/[-:]/g, '').replace(/T(\d{2})0000Z$/, '$1')}-${run.id}-${run.attempt}`;
  fail(ID.test(artifactId), 'artifact-id');
  return {SOURCE_DIR: dir, COMPONENT_ID: componentId, MOUNT: mount, GENERATION_TIME: pointer.newest_init,
    ARTIFACT_ID: artifactId, COMPONENT_R2_REMOTE: COMPONENTS, CATALOG_ENDPOINT: ENDPOINT, PROMOTE: '1',
    PACK_COMPONENT_OBJECTS: '0', DIRECT_SCHEMA1_CHECKSUM: '0', REUSE_COMPONENT_MANIFEST_KEY: '', REUSE_MAP_OBJECTS_MANIFEST_KEY: '',
    EXPECTED_COMPONENT_MANIFEST_SHA256: precondition.previousManifestSha256,
    EXPECTED_CATALOG_ROLLBACK_EPOCH: String(precondition.rollbackEpoch),
    COMPONENT_QUALITY_CHECKS: 'native_schema,fresh_records,source_identity,mount_inventory'};
}

function run(command, args, env = process.env, timeout = 60000, maxBuffer = 16 * 1024 ** 2) {
  const r = spawnSync(command, args, {env, timeout, maxBuffer, encoding: null, stdio: ['ignore', 'pipe', 'inherit']});
  fail(!r.error && r.status === 0, `command-refused:${command}`);
  return r.stdout;
}
function r2(key, remote = DATA, cap = 4 * 1024 ** 2) {
  const bytes = run('rclone', ['cat', `${remote}/${key}`, '--s3-no-check-bucket', '--retries', '1', '--low-level-retries', '1',
    '--contimeout', '15s', '--timeout', '30s']);
  fail(bytes.length > 0 && bytes.length <= cap, 'r2-object-bound');
  return bytes;
}
function snapshot() {
  const pointer = JSON.parse(r2('catalogs/current.json', DATA, 1024 ** 2).toString('utf8'));
  fail(ID.test(pointer?.catalogId ?? '') && HASH.test(pointer?.catalogSha256 ?? ''), 'catalog-pointer');
  const bytes = r2(`catalogs/snapshots/${pointer.catalogId}.json`);
  fail(sha(bytes) === pointer.catalogSha256, 'catalog-pointer-hash');
  const catalog = JSON.parse(bytes.toString('utf8'));
  const release = JSON.parse(r2('releases/current.json', DATA, 1024 ** 2).toString('utf8'));
  fail(ID.test(release?.releaseId ?? ''), 'release-pointer');
  const manifest = JSON.parse(r2(`releases/${release.releaseId}/manifest.json`, DATA, 64 * 1024 ** 2).toString('utf8'));
  return {catalog, manifest};
}
async function fetchBytes(url, cap) {
  const response = await fetch(url, {redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20000)});
  if (!response.ok) return {status: response.status, bytes: null};
  const bytes = Buffer.from(await response.arrayBuffer());
  fail(bytes.length <= cap, 'public-object-bound');
  return {status: response.status, bytes};
}
function output(line) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
  console.log(line);
}

export async function main(argv) {
  const [operation, name, dirArg, atmosArg] = argv;
  fail(['check-tree', 'served', 'publish', 'readback'].includes(operation), 'operation');
  const spec = family(name);
  if (operation === 'check-tree') { checkTree(name, resolve(dirArg ?? '')); console.log(`${name}: tree ok`); return; }
  if (operation === 'served') {
    fail(ISO_Z.test(dirArg ?? ''), 'expected-init');
    const {bytes} = await fetchBytes(`${ORIGIN}/${spec.mount}current.json`, 64 * 1024).catch(() => ({bytes: null}));
    let served = false;
    try { served = !!bytes && JSON.parse(bytes.toString('utf8')).newest_init === dirArg && JSON.parse(bytes.toString('utf8')).fixture !== true; }
    catch { served = false; }
    output(`served=${served}`);
    return;
  }
  fail(process.env.GITHUB_REPOSITORY === 'Andrewegao/v3t7kq-cycle' && process.env.GITHUB_REF === 'refs/heads/main', 'main-only');
  const dir = resolve(dirArg ?? '');
  const {pointer} = checkTree(name, dir);
  if (operation === 'publish') {
    const atmos = resolve(atmosArg ?? '');
    const {catalog, manifest} = snapshot();
    const pre = catalogPrecondition(name, catalog, manifest);
    console.log(`${name}: served ${spec.componentId} manifest ${pre.previousManifestSha256 || '(none: first publication)'}, rollback epoch ${pre.rollbackEpoch}`);
    const env = {...process.env, ...publisherEnv(name, dir, pointer, pre,
      {id: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT})};
    run('bash', [join(atmos, 'ops/platform/publish-r2-component.sh')], env, 600000);
    return;
  }
  // readback: the catalog pointer is cached for 30 s by the reader; poll up to 3 minutes.
  const deadline = Date.now() + 180000;
  for (;;) {
    const current = await fetchBytes(`${ORIGIN}/${spec.mount}current.json`, 64 * 1024).catch(() => ({bytes: null}));
    const local = readFileSync(join(dir, 'current.json'));
    if (current.bytes && sha(current.bytes) === sha(local)) break;
    fail(Date.now() < deadline, 'public-pointer-not-served');
    await new Promise(r => setTimeout(r, 15000));
  }
  for (const path of [pointer.path, ...(pointer.map ? [pointer.map] : [])]) {
    const {bytes} = await fetchBytes(`${ORIGIN}/${spec.mount}${path}`, spec.maxBytes);
    fail(bytes && sha(bytes) === sha(readFileSync(join(dir, path))), 'public-file-hash');
  }
  console.log(`${name}: public ${spec.mount}current.json serves ${pointer.newest_init} (${pointer.path})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({status: 'refused', operation: process.argv[2] ?? null,
      code: error instanceof EnergyIngestError ? error.message : error?.code === 'ERR_ASSERTION' ? 'tree-mismatch' : 'invalid-or-unavailable-state'}));
    process.exitCode = 1;
  });
}
