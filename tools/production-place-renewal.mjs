#!/usr/bin/env node
// Production place renewal. The staging renewal's collector, runtime qualifier and candidate
// primitives run unchanged (imported, not copied); only the target differs. Staging activates a
// leased pointer that only the staging data Worker reads. Production has no such pointer: the
// production data Worker serves `/data-atmos/*` from its catalog (longest mount wins) and then
// from the whole release. So production publishes the qualified candidate as ONE immutable
// catalog component mounted at data-atmos/tides/ (the same keys the whole release serves:
// tides.json, v2/catalog.json, v2/versions/<dataset>/...), byte-verified and promoted with a
// compare-and-swap on the served component and the rollback epoch, then read back from the
// catalog and from weatherx.org.
//
//   plan         gate (no credential) + stand aside when production already serves a fresh dataset
//   collect      pinned NOAA CO-OPS collector (no storage credential)
//   qualify      pinned producer/consumer/roster/coverage proof (no storage credential)
//   publish      stage immutable component (PROMOTE=0), verify it, re-check freshness, CAS promote
//   verify-live  weatherx.org serves the exact catalog, legacy file, station window, availability
//   digest       print the controller closure digest the owner attests
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, appendFile, realpath, lstat, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ACCOUNT, LIMITS, hash, qualifyPlaces, validateQualification } from './staging-places.mjs';
import { noPublishCredentials, checkpointEvidence } from './staging-places-seed.mjs';
import { runRuntimeProof } from './staging-places-workflow.mjs';
import { placeFailureDiagnostic } from './staging-places-diagnostics.mjs';
import { isolatedPythonArguments, parseCollectorSuccess, collectorProcessFailure } from './staging-place-renewal.mjs';

const CYCLE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/, ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const TIDE_IDENTITY = /^noaa-coops-(\d{8}T\d{6}Z)$/;
export const ORIGIN = 'https://weatherx.org';
export const CATALOG_ENDPOINT = 'https://weatherx.org/api/platform/internal/catalog';
export const DATA_REMOTE = 'weatherx:weatherx-data-production';
export const COMPONENT_REMOTE = 'weatherx:weatherx-components-production';
export const WORKFLOW = '.github/workflows/production-place-renewal.yml';
export const POLICY = 'tools/production-place-renewal-policy.json';
// Everything this lane executes from cycle. The imported staging modules are part of it, so a
// staging change that reaches production code needs a fresh production attestation as well.
export const CLOSURE = [WORKFLOW, POLICY, 'tools/production-place-renewal.mjs', 'tools/staging-place-renewal.mjs',
  'tools/staging-place-collect.py', 'tools/staging-place-python', 'tools/staging-places-requirements.txt',
  'tools/staging-places.mjs', 'tools/staging-places-workflow.mjs', 'tools/staging-places-seed.mjs',
  'tools/staging-places-diagnostics.mjs', 'tools/shared-data.mjs'];
const RCLONE_KEYS = ['RCLONE_CONFIG_WEATHERX_TYPE', 'RCLONE_CONFIG_WEATHERX_PROVIDER', 'RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID',
  'RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY', 'RCLONE_CONFIG_WEATHERX_ENDPOINT', 'RCLONE_CONFIG_WEATHERX_REGION'];
const PUBLISH_KEYS = [...RCLONE_KEYS, 'CATALOG_PROMOTION_KEY'];
// Whole-release objects under the tide mount that the component legitimately replaces.
const RELEASE_TIDE_PATH = /^(?:tides\.json|v2\/catalog\.json|v2\/versions\/noaa-coops-[A-Za-z0-9._-]{1,80}\/(?:stations\/\d{1,16}\/window\.json|availability-[a-f0-9]{64}\.json))$/;
const QUALITY_CHECKS = 'producer_proof,consumer_proof,roster,coverage,source_identity,mount_inventory';

export async function controllerDigest(root = CYCLE) {
  const rows = [];
  for (const file of CLOSURE) {
    const path = resolve(root, file), stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && await realpath(path) === path);
    rows.push([file, hash(await readFile(path))]);
  }
  return hash(Buffer.from(JSON.stringify(rows)));
}

export function validatePolicy(policy) {
  assert(policy && typeof policy === 'object' && !Array.isArray(policy), 'invalid production place policy');
  assert.deepEqual(Object.keys(policy).sort(), ['schemaVersion', 'target', 'families', 'sourceSha', 'qualifierSha256', 'schedules',
    'renewAfterHours', 'tideRequestsPerSecond', 'minimumForecastLeaseHours', 'tides'].sort(), 'production place policy fields');
  assert.equal(policy.schemaVersion, 1); assert.equal(policy.target, 'production');
  assert.deepEqual(policy.families, ['tides'], 'production serves only tides');
  assert(COMMIT.test(policy.sourceSha) && SHA.test(policy.qualifierSha256), 'reviewed source and qualifier pins required');
  assert(Array.isArray(policy.schedules) && policy.schedules.length > 0 && new Set(policy.schedules).size === policy.schedules.length &&
    policy.schedules.every(cron => typeof cron === 'string' && /^\d{1,2} \d{1,2}(?:,\d{1,2})* \* \* \*$/.test(cron)), 'daily schedules');
  assert(policy.renewAfterHours === 20 && policy.tideRequestsPerSecond === 2 && policy.minimumForecastLeaseHours === 6, 'reviewed cadence and pacing');
  assert.deepEqual(policy.tides, { componentId: 'places-tides', mount: 'data-atmos/tides/' }, 'reviewed tide component and mount');
  return policy;
}

export function productionGate(env, policy, digest, action) {
  validatePolicy(policy);
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_REF: 'refs/heads/main', GITHUB_JOB: 'renew',
    GITHUB_WORKFLOW_REF: `Andrewegao/v3t7kq-cycle/${WORKFLOW}@refs/heads/main`, PRODUCTION_PLACES_RENEWAL_ENABLED: 'true' })) {
    assert.equal(env[key], value, `guard ${key}`);
  }
  assert(['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'unadmitted event');
  assert(policy.families.includes(env.PLACES_KIND), 'unknown production place family');
  assert(COMMIT.test(env.ATMOS_SHA ?? '') && env.ATMOS_SHA === policy.sourceSha, 'unapproved source');
  assert(SHA.test(digest) && env.PRODUCTION_PLACES_RENEWAL_CONTROLLER_SHA256 === digest, 'unapproved controller closure');
  // Production storage and catalog credentials exist only in the publish step's environment.
  for (const key of Object.keys(env)) {
    if (/^(?:AWS_|CLOUDFLARE_|CF_API_|R2_|SHARED_R2_|UI_|STAGING_)/.test(key)) assert(!env[key], 'foreign credential refused');
    if (/^RCLONE_/.test(key) || key === 'CATALOG_PROMOTION_KEY') {
      assert(action === 'publish' ? PUBLISH_KEYS.includes(key) : !env[key], 'credential outside the publish step refused');
    }
  }
  if (action === 'publish') {
    for (const key of PUBLISH_KEYS) assert(env[key], `publish credential ${key} required`);
    assert.equal(env.RCLONE_CONFIG_WEATHERX_ENDPOINT, `https://${ACCOUNT}.r2.cloudflarestorage.com`, 'production R2 account');
    assert(COMMIT.test(env.PUBLISHER_ATMOS_SHA ?? '') && env.PUBLISHER_ATMOS_SHA === env.APPROVED_PUBLISHER_SHA,
      'publisher source is not the approved production publisher');
  }
  for (const path of [env.RUNNER_TEMP, env.GITHUB_WORKSPACE]) assert(path && resolve(path) === path, 'absolute runner paths');
  let run, standAside;
  if (env.GITHUB_EVENT_NAME === 'schedule') {
    assert(policy.schedules.includes(env.RENEWAL_SCHEDULE), 'unknown schedule');
    run = true; standAside = true;
  } else {
    assert(policy.families.includes(env.REQUESTED_FAMILY), 'unknown requested family');
    assert(['', 'scheduler'].includes(env.CALLER ?? ''), 'unadmitted caller');
    run = env.REQUESTED_FAMILY === env.PLACES_KIND; standAside = env.CALLER === 'scheduler';
  }
  const { componentId, mount } = policy[env.PLACES_KIND];
  return { run, standAside, kind: env.PLACES_KIND, sourceSha: policy.sourceSha, componentId, mount,
    source: resolve(env.GITHUB_WORKSPACE, 'control'), publisher: resolve(env.GITHUB_WORKSPACE, 'publisher'),
    root: resolve(env.RUNNER_TEMP, `weatherx-production-place-renewal-${env.PLACES_KIND}`) };
}

async function boundedBody(response, max) {
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.length; assert(bytes <= max, 'public object exceeds its bound'); chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}
async function cancel(response) { try { if (response?.body && !response.body.locked) await response.body.cancel(); } catch { /* closed */ } }

/** The dataset production serves through this lane's catalog component, or null (renew). */
export async function servedTideDataset(fetcher = fetch) {
  let response;
  try {
    response = await fetcher(new URL('/data-atmos/tides/v2/catalog.json', ORIGIN), { redirect: 'error', credentials: 'omit',
      cache: 'no-store', signal: AbortSignal.timeout(20000) });
    // A release-served or missing v2 catalog was not renewed by this lane: renew.
    if (response.status !== 200 || !ID.test(response.headers.get('x-weatherx-catalog') ?? '')) return null;
    const value = JSON.parse(await boundedBody(response, LIMITS.fileBytes));
    const retrievedAt = Date.parse(value?.retrievedAt);
    if (!TIDE_IDENTITY.test(value?.datasetId ?? '') || !Number.isFinite(retrievedAt)) return null;
    return { datasetId: value.datasetId, retrievedAt };
  } catch { return null; } finally { await cancel(response); }
}
export function servedIsFresh(served, policy, now) {
  return served !== null && served.retrievedAt <= now && now - served.retrievedAt < policy.renewAfterHours * 3600000;
}

/** The candidate's dataset identity and catalog generation time, bound to each other. */
export function tideGeneration(candidate, catalog) {
  const { kind, identity } = candidate.completion; assert.equal(kind, 'tides');
  const match = TIDE_IDENTITY.exec(identity); assert(match, 'noncanonical tide identity');
  const s = match[1];
  const generationTime = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;
  assert(Number.isFinite(Date.parse(generationTime)) && catalog?.datasetId === identity &&
    Date.parse(catalog.retrievedAt) === Date.parse(generationTime), 'tide dataset identity and retrieval time disagree');
  return { identity, generationTime };
}

export function requireFreshness(candidate, policy, now) {
  const end = Date.parse(candidate.completion.sourceExpiresAt);
  assert(Number.isFinite(end) && end - now >= policy.minimumForecastLeaseHours * 3600000,
    'candidate needs six hours of remaining seven-day tide window');
}

/** The served component (if any) and proof nothing else claims or hides under this mount. */
export function tidePrecondition(catalog, releaseManifest, generation, policy) {
  const { componentId, mount } = policy.tides;
  assert(catalog && typeof catalog.components === 'object' && !Array.isArray(catalog.components), 'catalog envelope');
  const epoch = catalog.rollbackEpoch ?? 0; assert(Number.isSafeInteger(epoch) && epoch >= 0, 'catalog rollback epoch');
  for (const [id, component] of Object.entries(catalog.components)) {
    assert(Array.isArray(component?.mounts), 'catalog component mounts');
    for (const active of component.mounts) {
      assert(typeof active === 'string', 'catalog component mount');
      // Longest mount wins: a broader fallback (data-atmos/) is harmless; an equal or deeper one is not ours.
      if (active.startsWith(mount)) assert(id === componentId && active === mount && component.mounts.length === 1, 'tide mount claimed by another component');
    }
  }
  assert(Array.isArray(releaseManifest?.objects), 'whole release manifest');
  for (const row of releaseManifest.objects) {
    if (typeof row?.path !== 'string' || !row.path.startsWith(mount)) continue;
    // The component replaces only release tide files of the same grammar; never hide anything else.
    assert(RELEASE_TIDE_PATH.test(row.path.slice(mount.length)), 'the component would hide a non-tide release object');
  }
  const previous = catalog.components[componentId] ?? null;
  if (previous) {
    assert(SHA.test(previous.manifestSha256 ?? '') && previous.mounts.length === 1 && previous.mounts[0] === mount, 'previous tide component');
    const prior = Date.parse(previous.generationTime);
    assert(Number.isFinite(prior) && prior <= Date.parse(generation.generationTime), 'newer tide dataset rollback refused');
  }
  return { previousManifestSha256: previous?.manifestSha256 ?? null, rollbackEpoch: epoch };
}

export function artifactIdFor(componentId, generation, run) {
  assert(/^[1-9][0-9]{0,19}$/.test(run.id ?? '') && /^[1-9][0-9]{0,3}$/.test(run.attempt ?? ''), 'run identity');
  const artifactId = `${componentId}-${TIDE_IDENTITY.exec(generation.identity)[1]}-${run.id}-${run.attempt}`;
  assert(ID.test(artifactId), 'artifact id'); return artifactId;
}

/** Same traversal, order and JSON as Atmos ops/platform/build-component-manifest.mjs. */
export async function localInventory(root) {
  const rows = [];
  async function visit(folder) {
    const entries = (await readdir(resolve(root, folder), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      assert(!entry.isSymbolicLink(), 'symlink in component tree');
      if (entry.isDirectory()) await visit(path);
      else { assert(entry.isFile(), 'nonregular component entry'); const bytes = await readFile(resolve(root, path)); rows.push({ path, size: bytes.length, sha256: hash(bytes) }); }
    }
  }
  await visit('');
  return { rows, inventorySha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
}

/** The staged tree is exactly the qualified candidate: every input file, nothing else, same bytes. */
export function inventoryMatchesCandidate(rows, candidate) {
  const expected = new Map([...candidate.local.values()].map(row => [row.input, row.sha256]));
  assert.equal(rows.length, expected.size, 'component inventory differs from qualified candidate');
  for (const row of rows) assert.equal(expected.get(row.path), row.sha256, 'component inventory differs from qualified candidate');
}

export function validateStagedComponent(bytes, receipt, expected) {
  assert.equal(hash(bytes), receipt.manifestSha256, 'staged component manifest bytes');
  const manifest = JSON.parse(bytes);
  assert(manifest.schemaVersion === 1 && manifest.componentId === expected.componentId && manifest.artifactId === expected.artifactId &&
    manifest.rootPrefix === `components/${expected.componentId}/${expected.artifactId}/` &&
    JSON.stringify(manifest.mounts) === JSON.stringify([expected.mount]) &&
    Date.parse(manifest.generationTime) === Date.parse(expected.generationTime) &&
    manifest.objectCount === expected.objectCount && manifest.inventorySha256 === expected.inventorySha256 &&
    manifest.quality?.status === 'passed' && manifest.objectLayout === undefined &&
    ['manifest', 'inventory', 'remote_bytes', ...QUALITY_CHECKS.split(',')].every(check => manifest.quality.checks?.includes(check)),
  'immutable staged component readback');
  return manifest;
}

function validateReceipt(receipt, expected) {
  assert.deepEqual(Object.keys(receipt ?? {}).sort(), ['manifestKey', 'manifestSha256', 'expectedPreviousManifestSha256', 'expectedRollbackEpoch'].sort());
  assert.equal(receipt.manifestKey, `components/${expected.componentId}/${expected.artifactId}/component.json`, 'staged component key');
  assert(SHA.test(receipt.manifestSha256), 'staged component digest');
  assert.equal(receipt.expectedPreviousManifestSha256, expected.previousManifestSha256, 'staged precondition');
  assert.equal(receipt.expectedRollbackEpoch, expected.rollbackEpoch, 'staged rollback epoch');
}

/**
 * Stage, verify and conditionally promote one qualified candidate. `io` is injected:
 *   snapshot() -> {pointer, catalog, manifest}   authenticated production catalog + whole release
 *   stage(env) -> receipt                         Atmos publisher with PROMOTE=0 (immutable upload + byte check)
 *   component(key) -> Buffer                      staged component.json from the component bucket
 *   promote(receipt) -> void                      signed catalog CAS (throws on refusal or uncertainty)
 */
export async function renewProduction(io, candidate, proof, policy, context, { clock = Date.now, run, report = () => {} } = {}) {
  validateQualification(proof, candidate, policy.sourceSha);
  const generation = tideGeneration(candidate, JSON.parse(await readFile(candidate.local.get('catalog.json').file)));
  requireFreshness(candidate, policy, clock());
  const { rows, inventorySha256 } = await localInventory(candidate.root);
  inventoryMatchesCandidate(rows, candidate);
  const before = await io.snapshot();
  const pre = tidePrecondition(before.catalog, before.manifest, generation, policy);
  const artifactId = artifactIdFor(context.componentId, generation, run);
  report({ stage: 'precondition', catalogId: before.pointer.catalogId, previousManifestSha256: pre.previousManifestSha256, rollbackEpoch: pre.rollbackEpoch });
  const expected = { componentId: context.componentId, mount: context.mount, artifactId, generationTime: generation.generationTime,
    objectCount: rows.length, inventorySha256, ...pre };
  const receipt = await io.stage({ SOURCE_DIR: candidate.root, COMPONENT_ID: context.componentId, MOUNT: context.mount,
    GENERATION_TIME: generation.generationTime, ARTIFACT_ID: artifactId, COMPONENT_R2_REMOTE: COMPONENT_REMOTE,
    CATALOG_ENDPOINT, PROMOTE: '0', PACK_COMPONENT_OBJECTS: '0', DIRECT_SCHEMA1_CHECKSUM: '0',
    REUSE_COMPONENT_MANIFEST_KEY: '', REUSE_MAP_OBJECTS_MANIFEST_KEY: '',
    EXPECTED_COMPONENT_MANIFEST_SHA256: pre.previousManifestSha256 ?? '', EXPECTED_CATALOG_ROLLBACK_EPOCH: String(pre.rollbackEpoch),
    COMPONENT_QUALITY_CHECKS: QUALITY_CHECKS });
  validateReceipt(receipt, expected);
  validateStagedComponent(await io.component(receipt.manifestKey), receipt, expected);
  report({ stage: 'staged', manifestKey: receipt.manifestKey, manifestSha256: receipt.manifestSha256, objectCount: rows.length });
  // Staging is the slow part; never activate a candidate that lost its margin meanwhile.
  requireFreshness(candidate, policy, clock());
  let promotion = 'accepted';
  try { await io.promote(receipt); }
  catch (error) { promotion = 'uncertain'; report({ stage: 'promote', outcome: 'refused-or-uncertain', error: String(error?.message ?? error).slice(0, 200) }); }
  // The catalog itself decides: our exact component is served, or the run failed (nothing retried).
  const after = await io.snapshot();
  const served = after.catalog.components[context.componentId];
  assert(served && served.manifestKey === receipt.manifestKey && served.manifestSha256 === receipt.manifestSha256 &&
    (after.catalog.rollbackEpoch ?? 0) === pre.rollbackEpoch, 'catalog does not serve the staged tide component; previous component retained');
  return { published: true, family: 'tides', identity: generation.identity, generationTime: generation.generationTime,
    sourceExpiresAt: candidate.completion.sourceExpiresAt, componentId: context.componentId, artifactId,
    manifestKey: receipt.manifestKey, manifestSha256: receipt.manifestSha256, previousManifestSha256: pre.previousManifestSha256,
    predecessorCatalogId: before.pointer.catalogId, catalogId: after.pointer.catalogId, promotion };
}

export async function verifyProductionLive(candidate, { fetcher = fetch, sleep = delay, attempts = 12, intervalMs = 15000 } = {}) {
  const { kind, identity } = candidate.completion; assert.equal(kind, 'tides');
  const receipt = path => { const row = candidate.manifest.files.find(file => file.path === path); assert(row, `receipt ${path}`); return row; };
  const station = candidate.manifest.files.find(row => row.path.startsWith('stations/')); assert(station, 'representative station missing');
  const availability = candidate.manifest.files.find(row => row.path.startsWith('availability-'));
  const checks = [['/data-atmos/tides/v2/catalog.json', receipt('catalog.json')], ['/data-atmos/tides/tides.json', receipt('tides.json')],
    [`/data-atmos/tides/v2/versions/${identity}/${station.path}`, station],
    ...(availability ? [[`/data-atmos/tides/v2/versions/${identity}/${availability.path}`, availability]] : [])];
  // The catalog pointer is cached for 30 s per isolate. Retries are reads only.
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      let catalogId = null;
      for (const [path, row] of checks) {
        const response = await fetcher(new URL(path, ORIGIN), { redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000) });
        try {
          assert.equal(response.status, 200);
          // Model and observation lanes advance the catalog every few minutes; each object is
          // bound by its own bytes, so only catalog (not release) service is required here.
          catalogId = response.headers.get('x-weatherx-catalog') ?? '';
          assert(ID.test(catalogId), 'not served by the catalog');
          assert.equal(response.headers.get('x-weatherx-release'), null, 'still served by the whole release');
          assert.equal(response.headers.get('x-weatherx-data-source'), 'own');
          assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
          assert(/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? ''));
          const body = await boundedBody(response, row.bytes);
          assert.equal(body.length, row.bytes); assert.equal(hash(body), row.sha256);
        } finally { await cancel(response); }
      }
      return { liveVerified: true, family: kind, identity, catalogId, requests: checks.length };
    } catch (error) { if (attempt === attempts - 1) throw error; await sleep(intervalMs); }
  }
}

function safeExecute(command, args, cwd, env, timeout) {
  // Same isolation as the staging lane: the child sees only PATH, locale and temp, never a secret.
  return execFileSync(command, args, { cwd, env: { PATH: env.PATH, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', TMPDIR: env.RUNNER_TEMP },
    encoding: 'utf8', stdio: 'pipe', timeout, maxBuffer: 65536 });
}
function pristine(path, sha, env) {
  assert.equal(safeExecute('git', ['rev-parse', 'HEAD'], path, env, 10000).trim(), sha, 'checkout is not the approved commit');
  assert.equal(safeExecute('git', ['status', '--porcelain'], path, env, 10000).trim(), '', 'checkout changed');
}
async function json(path, max = 8192) {
  assert.equal(await realpath(path), path);
  const stat = await lstat(path); assert(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= max);
  return JSON.parse(await readFile(path));
}
const rcloneEnv = env => Object.fromEntries([['PATH', env.PATH], ['HOME', env.HOME], ...RCLONE_KEYS.map(key => [key, env[key]])]
  .filter(([, value]) => typeof value === 'string'));
function r2(env, remote, key, cap) {
  const result = spawnSync('rclone', ['cat', `${remote}/${key}`, '--s3-no-check-bucket', '--retries', '1', '--low-level-retries', '1',
    '--contimeout', '15s', '--timeout', '30s'], { env: rcloneEnv(env), encoding: null, maxBuffer: cap + 1, timeout: 180000, stdio: ['ignore', 'pipe', 'ignore'] });
  assert(!result.error && result.status === 0, `R2 read refused: ${key.split('/')[0]}`);
  assert(result.stdout.length > 0 && result.stdout.length <= cap, 'R2 object bound');
  return result.stdout;
}
export function authenticateSnapshot({ pointerBytes, catalogBytes, releaseBytes, manifestBytes }) {
  const pointer = JSON.parse(pointerBytes), catalog = JSON.parse(catalogBytes);
  assert(pointer?.schemaVersion === 2 && ID.test(pointer.catalogId ?? '') && SHA.test(pointer.catalogSha256 ?? '') &&
    hash(catalogBytes) === pointer.catalogSha256 && catalog?.schemaVersion === 2 && catalog.sequence === pointer.sequence &&
    catalog.components && typeof catalog.components === 'object', 'catalog pointer authentication');
  const release = JSON.parse(releaseBytes), manifest = JSON.parse(manifestBytes);
  // Release pointers commit JSON.stringify(parsed manifest), as tools/data-reader-proof.mjs verifies.
  assert(release?.schemaVersion === 1 && ID.test(release.releaseId ?? '') && hash(Buffer.from(JSON.stringify(manifest))) === release.manifestSha256 &&
    manifest.releaseId === release.releaseId && Array.isArray(manifest.objects), 'whole release authentication');
  return { pointer, catalog, release, manifest };
}
function productionIO(env, context) {
  return {
    async snapshot() {
      const pointerBytes = r2(env, DATA_REMOTE, 'catalogs/current.json', 1024 ** 2);
      const pointer = JSON.parse(pointerBytes); assert(ID.test(pointer?.catalogId ?? ''), 'catalog pointer');
      const catalogBytes = r2(env, DATA_REMOTE, `catalogs/snapshots/${pointer.catalogId}.json`, 16 * 1024 ** 2);
      const releaseBytes = r2(env, DATA_REMOTE, 'releases/current.json', 1024 ** 2);
      const release = JSON.parse(releaseBytes); assert(ID.test(release?.releaseId ?? ''), 'release pointer');
      const manifestBytes = r2(env, DATA_REMOTE, `releases/${release.releaseId}/manifest.json`, 64 * 1024 ** 2);
      return authenticateSnapshot({ pointerBytes, catalogBytes, releaseBytes, manifestBytes });
    },
    async stage(publisherEnv) {
      const receiptFile = resolve(context.root, 'component-receipt.json');
      const result = spawnSync('bash', [resolve(context.publisher, 'ops/platform/publish-r2-component.sh')], {
        env: { ...rcloneEnv(env), CATALOG_PROMOTION_KEY: env.CATALOG_PROMOTION_KEY, TMPDIR: env.RUNNER_TEMP, ...publisherEnv, COMPONENT_RECEIPT_FILE: receiptFile },
        stdio: ['ignore', 'inherit', 'inherit'], timeout: 20 * 60000 });
      assert(!result.error && result.status === 0, 'immutable component staging refused; nothing promoted');
      return json(receiptFile, 4096);
    },
    async component(key) { return r2(env, COMPONENT_REMOTE, key, 256 * 1024); },
    async promote(receipt) {
      const result = spawnSync(process.execPath, [resolve(context.publisher, 'ops/platform/submit-catalog-mutation.mjs'), 'promote', CATALOG_ENDPOINT,
        receipt.manifestKey, receipt.manifestSha256, receipt.expectedPreviousManifestSha256 ?? '', String(receipt.expectedRollbackEpoch)], {
        env: { PATH: env.PATH, CATALOG_PROMOTION_KEY: env.CATALOG_PROMOTION_KEY }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 180000 });
      assert(!result.error && result.status === 0, `catalog promotion refused or uncertain: ${(result.stderr ?? '').slice(-300)}`);
    },
  };
}
async function summary(env, lines) { if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`); }

async function main(env, action) {
  const policy = validatePolicy(JSON.parse(await readFile(resolve(CYCLE, POLICY))));
  const digest = await controllerDigest();
  if (action === 'digest') { console.log(digest); return; }
  const context = productionGate(env, policy, digest, action);
  if (action === 'plan') {
    noPublishCredentials(env);
    let run = context.run;
    if (run && context.standAside) {
      const served = await servedTideDataset();
      if (servedIsFresh(served, policy, Date.now())) {
        run = false;
        console.log(`::notice::Production already serves ${served.datasetId} (under ${policy.renewAfterHours} h old). Nothing to do.`);
        await summary(env, [`Production place renewal (${context.kind}): SKIPPED, ${served.datasetId} is under ${policy.renewAfterHours} h old.`]);
      }
    }
    assert(env.GITHUB_OUTPUT); await appendFile(env.GITHUB_OUTPUT, `run=${run}\n`); return;
  }
  assert(context.run, 'family not selected by this event');
  if (action === 'collect') {
    noPublishCredentials(env);
    pristine(context.source, context.sourceSha, env);
    let output;
    try {
      output = safeExecute('python3', isolatedPythonArguments(resolve(CYCLE, 'tools/staging-place-collect.py'),
        ['--source', context.source, '--root', context.root, '--family', context.kind,
          '--tide-requests-per-second', String(policy.tideRequestsPerSecond)]), context.source, env, 45 * 60000);
    } catch (error) { throw Object.assign(new Error('collector refused'), { collector: collectorProcessFailure(error, context.kind) }); }
    let receipt;
    try { receipt = parseCollectorSuccess(output, context.kind); }
    catch { throw Object.assign(new Error('collector output refused'), { collector: collectorProcessFailure({ status: 0, stdout: output, stderr: '' }, context.kind) }); }
    console.log(JSON.stringify(receipt)); return;
  }
  assert.equal(await realpath(context.root), context.root);
  const candidateRoot = resolve(context.root, 'candidate');
  if (action === 'qualify') {
    noPublishCredentials(env);
    const candidate = await qualifyPlaces({ kind: context.kind, root: candidateRoot });
    const evidence = await checkpointEvidence(resolve(context.root, 'checkpoint'), context.kind);
    await writeFile(resolve(context.root, 'seed-evidence.json'), JSON.stringify(evidence.document) + '\n', { flag: 'wx', mode: 0o600 });
    const result = await runRuntimeProof({ ...env, STAGING_PLACES_APPROVED_QUALIFIER_SHA256: policy.qualifierSha256 },
      { ...context, manifestSha256: hash(candidate.manifestBody) });
    console.log(JSON.stringify(result)); return;
  }
  const candidate = await qualifyPlaces({ kind: context.kind, root: candidateRoot });
  if (action === 'verify-live') {
    noPublishCredentials(env);
    const result = await verifyProductionLive(candidate);
    console.log(JSON.stringify(result));
    await summary(env, [`weatherx.org serves ${result.identity} from catalog ${result.catalogId}; seven-day window lasts until ${candidate.completion.sourceExpiresAt}.`]);
    return;
  }
  assert.equal(action, 'publish');
  const proof = await json(resolve(context.root, 'qualification.json'));
  const qualified = await json(resolve(context.root, 'qualified.json'));
  assert.deepEqual(qualified, { sourceSha: context.sourceSha, manifestSha256: hash(candidate.manifestBody),
    qualificationSha256: hash(Buffer.from(JSON.stringify(proof))) });
  pristine(context.publisher, env.PUBLISHER_ATMOS_SHA, env);
  const result = await renewProduction(productionIO(env, context), candidate, proof, policy, context,
    { run: { id: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT }, report: row => console.log(JSON.stringify(row)) });
  console.log(JSON.stringify(result));
  await summary(env, [`Production place renewal (${context.kind}): published ${result.identity} as ${result.manifestKey}`,
    `catalog ${result.predecessorCatalogId} -> ${result.catalogId}; previous component ${result.previousManifestSha256 ?? '(none: first publication)'}`]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.env, process.argv[2]).catch(error => {
    console.error(JSON.stringify(error?.collector ?? placeFailureDiagnostic(error)));
    console.error('Production place renewal stopped. The served component is unchanged unless the catalog readback above shows the new one.');
    process.exitCode = 1;
  });
}
