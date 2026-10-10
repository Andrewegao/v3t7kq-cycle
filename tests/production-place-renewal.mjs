import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ACCOUNT, hash, qualifyPlaces } from '../tools/staging-places.mjs';
import { CLOSURE as STAGING_CLOSURE, controllerDigest as stagingDigest } from '../tools/staging-place-renewal.mjs';
import { productionGate, validatePolicy, controllerDigest, CLOSURE, servedTideDataset, servedIsFresh, tidePrecondition,
  tideGeneration, artifactIdFor, localInventory, inventoryMatchesCandidate, renewProduction, verifyProductionLive,
  authenticateSnapshot, requireFreshness } from '../tools/production-place-renewal.mjs';

const policy = JSON.parse(await readFile('tools/production-place-renewal-policy.json'));
const stagingPolicy = JSON.parse(await readFile('tools/staging-place-renewal-policy.json'));
const DIGEST = 'a'.repeat(64), PUBLISHER = 'b'.repeat(40);
const encode = value => Buffer.from(JSON.stringify(value) + '\n');
const environment = (extra = {}) => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
  GITHUB_REF: 'refs/heads/main', GITHUB_JOB: 'renew', GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/production-place-renewal.yml@refs/heads/main',
  PRODUCTION_PLACES_RENEWAL_ENABLED: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', PLACES_KIND: 'tides', REQUESTED_FAMILY: 'tides', CALLER: '',
  ATMOS_SHA: policy.sourceSha, PRODUCTION_PLACES_RENEWAL_CONTROLLER_SHA256: DIGEST, RUNNER_TEMP: '/tmp', GITHUB_WORKSPACE: '/workspace', ...extra });
const publishCredentials = { RCLONE_CONFIG_WEATHERX_TYPE: 's3', RCLONE_CONFIG_WEATHERX_PROVIDER: 'Cloudflare',
  RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID: 'id', RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY: 'secret',
  RCLONE_CONFIG_WEATHERX_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com`, RCLONE_CONFIG_WEATHERX_REGION: 'auto',
  CATALOG_PROMOTION_KEY: 'key', PUBLISHER_ATMOS_SHA: PUBLISHER, APPROVED_PUBLISHER_SHA: PUBLISHER };

test('gate requires the exact hosted main job, reviewed closure and source, and explicit production permission', () => {
  const context = productionGate(environment(), policy, DIGEST, 'plan');
  assert.deepEqual({ ...context }, { run: true, standAside: false, kind: 'tides', sourceSha: policy.sourceSha,
    componentId: 'places-tides', mount: 'data-atmos/tides/', source: '/workspace/control', publisher: '/workspace/publisher',
    root: '/tmp/weatherx-production-place-renewal-tides' });
  for (const [key, value] of Object.entries({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/heads/dev', GITHUB_JOB: 'places',
    GITHUB_REPOSITORY: 'weatherx-hq/atmos', RUNNER_ENVIRONMENT: 'self-hosted', GITHUB_ACTIONS: 'false',
    GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-place-renewal.yml@refs/heads/main',
    PRODUCTION_PLACES_RENEWAL_ENABLED: 'false', ATMOS_SHA: '0'.repeat(40), PRODUCTION_PLACES_RENEWAL_CONTROLLER_SHA256: '0'.repeat(64),
    PLACES_KIND: 'surf', REQUESTED_FAMILY: 'paragliding', CALLER: 'someone', RUNNER_TEMP: 'relative', GITHUB_WORKSPACE: '' })) {
    assert.throws(() => productionGate(environment({ [key]: value }), policy, DIGEST, 'plan'), key);
  }
  assert.throws(() => productionGate(environment(), { ...policy, tideRequestsPerSecond: 4 }, DIGEST, 'plan'), /pacing/);
  assert.throws(() => productionGate(environment(), { ...policy, tides: { ...policy.tides, mount: 'data-atmos/' } }, DIGEST, 'plan'));
  assert.throws(() => productionGate(environment(), policy, 'not-a-digest', 'plan'));
});

test('production storage and catalog credentials are admitted only in the publish step', () => {
  for (const action of ['plan', 'collect', 'qualify', 'verify-live']) {
    for (const key of Object.keys(publishCredentials).filter(k => /^RCLONE_|CATALOG_PROMOTION_KEY/.test(k))) {
      assert.throws(() => productionGate(environment({ [key]: publishCredentials[key] }), policy, DIGEST, action), /outside the publish step/, key);
    }
  }
  assert.equal(productionGate(environment(publishCredentials), policy, DIGEST, 'publish').run, true);
  for (const key of Object.keys(publishCredentials)) {
    assert.throws(() => productionGate(environment({ ...publishCredentials, [key]: '' }), policy, DIGEST, 'publish'), key);
  }
  for (const [key, value] of Object.entries({ RCLONE_CONFIG_WEATHERX_ENDPOINT: 'https://foreign.r2.cloudflarestorage.com',
    APPROVED_PUBLISHER_SHA: 'c'.repeat(40), RCLONE_CONFIG_OTHER_TYPE: 's3', STAGING_R2_WRITE_ACCESS_KEY_ID: 'staging',
    STAGING_PLACES_SEED_KEY: 'seed', AWS_ACCESS_KEY_ID: 'aws', CLOUDFLARE_API_TOKEN: 'cf', R2_PRODUCTION_ACCESS_KEY_ID: 'raw', UI_TOKEN: 'ui' })) {
    assert.throws(() => productionGate(environment({ ...publishCredentials, [key]: value }), policy, DIGEST, 'publish'), key);
  }
});

test('schedules and the scheduler caller stand aside when fresh; a manual dispatch always renews', () => {
  for (const slot of policy.schedules) {
    const context = productionGate(environment({ GITHUB_EVENT_NAME: 'schedule', RENEWAL_SCHEDULE: slot, REQUESTED_FAMILY: '' }), policy, DIGEST, 'plan');
    assert.equal(context.run, true); assert.equal(context.standAside, true);
  }
  assert.throws(() => productionGate(environment({ GITHUB_EVENT_NAME: 'schedule', RENEWAL_SCHEDULE: stagingPolicy.directoryTideSchedule }), policy, DIGEST, 'plan'));
  assert.equal(productionGate(environment({ CALLER: 'scheduler' }), policy, DIGEST, 'plan').standAside, true);
  assert.equal(productionGate(environment(), policy, DIGEST, 'plan').standAside, false);
  const now = Date.parse('2026-10-10T12:00:00Z'), served = age => ({ datasetId: 'noaa-coops-20261010T043024Z', retrievedAt: now - age * 3600000 });
  assert.equal(servedIsFresh(null, policy, now), false);
  assert.equal(servedIsFresh(served(19.9), policy, now), true);
  assert.equal(servedIsFresh(served(20), policy, now), false);
  assert.equal(servedIsFresh(served(-1), policy, now), false, 'a future-stamped dataset is not proof of freshness');
});

test('policy is exact, shares the staging-qualified source today and is a declared Atmos pin', async () => {
  assert.equal(validatePolicy(policy), policy);
  assert.equal(policy.sourceSha, stagingPolicy.sourceSha); assert.equal(policy.qualifierSha256, stagingPolicy.qualifierSha256);
  assert.equal(policy.tideRequestsPerSecond, stagingPolicy.tideRequestsPerSecond);
  for (const mutate of [p => { p.families = ['tides', 'surf']; }, p => { p.renewAfterHours = 168; }, p => { p.extra = true; },
    p => { p.schedules = ['*/5 * * * *']; }, p => { p.tides.componentId = 'tides'; }, p => { p.target = 'staging'; }]) {
    const copy = structuredClone(policy); mutate(copy); assert.throws(() => validatePolicy(copy));
  }
  const declaration = JSON.parse(await readFile('ops/atmos-production-source.json'));
  assert(declaration.otherAtmosCommits.commits[policy.sourceSha].includes('tools/production-place-renewal-policy.json'));
  const pin = declaration.pins.find(row => row.path === '.github/workflows/production-place-renewal.yml');
  assert.deepEqual(pin, { path: '.github/workflows/production-place-renewal.yml', occurrences: 2 });
});

test('controller digest covers workflow, policy, this controller and every reused staging module; staging is untouched', async t => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'wx-prod-renewal-closure-'))); t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of CLOSURE) { await mkdir(resolve(root, file, '..'), { recursive: true }); await writeFile(resolve(root, file), await readFile(file)); }
  const original = await controllerDigest(); assert.equal(await controllerDigest(root), original);
  await writeFile(resolve(root, 'unrelated.md'), 'unrelated main commit'); assert.equal(await controllerDigest(root), original);
  for (const file of CLOSURE) {
    const content = await readFile(resolve(root, file)); await writeFile(resolve(root, file), Buffer.concat([content, Buffer.from('\n')]));
    assert.notEqual(await controllerDigest(root), original, file); await writeFile(resolve(root, file), content);
  }
  // Every executable staging file production runs is covered; staging-only files are not.
  const stagingOnly = ['.github/workflows/staging-place-renewal.yml', 'tools/staging-place-renewal-policy.json',
    'tools/staging-place-renewal-requirements.txt', 'staging-controller/package.json', 'staging-controller/package-lock.json'];
  assert.deepEqual(STAGING_CLOSURE.filter(file => !stagingOnly.includes(file)).sort(),
    CLOSURE.filter(file => STAGING_CLOSURE.includes(file)).sort());
  assert(!STAGING_CLOSURE.some(file => file.includes('production')), 'staging closure never covers production files');
  assert.match(await stagingDigest(), /^[a-f0-9]{64}$/);
});

async function fixture(t, { identity = 'noaa-coops-20261010T043024Z', retrievedAt = '2026-10-10T04:30:24Z', endDays = 9 } = {}) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'wx-prod-renewal-test-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const write = async (path, value) => { await mkdir(resolve(root, path, '..'), { recursive: true }); const b = encode(value); await writeFile(resolve(root, path), b); return b; };
  const source = { provider: 'NOAA CO-OPS' }, datum = { id: 'MLLW' };
  const availabilityPath = `versions/${identity}/availability-${'b'.repeat(64)}.json`;
  await write(`v2/${availabilityPath}`, { schemaVersion: 1, kind: 'weatherx-tide-availability', scope: 'staging-only', datasetId: identity,
    source, datum, requestedStationIds: ['1', '2'], availableStationIds: ['1'], unavailableStations: [{ id: '2', reason: 'noaa-no-predictions' }] });
  const station = { id: '1', eventCoverage: { startMs: now - 6 * 3600000, endMs: now + endDays * 86400000 },
    sampleCoverage: { startMs: now - 86400000, endMs: now + endDays * 86400000 }, packs: [{ path: `versions/${identity}/stations/1/window.json` }] };
  await write(`v2/${station.packs[0].path}`, { schemaVersion: 2, datasetId: identity, stationId: '1', source, datum });
  await write('v2/catalog.json', { schemaVersion: 2, datasetId: identity, retrievedAt, source, datum, stations: [station],
    availability: { path: availabilityPath, requestedCount: 2, availableCount: 1, unavailableCount: 1 } });
  await write('tides.json', { stations: [{ id: '1' }] });
  const candidate = await qualifyPlaces({ kind: 'tides', root, now });
  const proof = { schemaVersion: 1, kind: 'tides', identity, sourceSha: policy.sourceSha, manifestSha256: hash(candidate.manifestBody),
    checks: { producer: true, consumer: true, coverage: true, roster: true } };
  return { root, now, candidate, proof, catalog: JSON.parse(await readFile(resolve(root, 'v2/catalog.json'))) };
}
const context = { componentId: 'places-tides', mount: 'data-atmos/tides/' };
const release = (paths = ['data-atmos/tides/tides.json']) => ({ releaseId: 'cycle-1', objects: [{ path: 'data/gfs/index.json' }, ...paths.map(path => ({ path }))] });
const previous = (generationTime, sha = 'c'.repeat(64)) => ({ componentId: 'places-tides', manifestSha256: sha, mounts: ['data-atmos/tides/'], generationTime });
const generation = { identity: 'noaa-coops-20261010T043024Z', generationTime: '2026-10-10T04:30:24Z' };

test('the dataset identity and catalog retrieval time are one generation', async t => {
  const f = await fixture(t);
  assert.deepEqual(tideGeneration(f.candidate, f.catalog), generation);
  assert.throws(() => tideGeneration(f.candidate, { ...f.catalog, retrievedAt: '2026-10-10T04:30:25Z' }), /disagree/);
  assert.throws(() => tideGeneration(f.candidate, { ...f.catalog, datasetId: 'noaa-coops-20261009T043024Z' }), /disagree/);
  assert.equal(artifactIdFor('places-tides', generation, { id: '38012345678', attempt: '1' }), 'places-tides-20261010T043024Z-38012345678-1');
  assert.throws(() => artifactIdFor('places-tides', generation, { id: '0', attempt: '1' }));
});

test('precondition: own mount only, never hides a non-tide release object, never replaces a newer dataset', () => {
  const catalog = (components = {}, rollbackEpoch = 3) => ({ rollbackEpoch, components: { gfs: { mounts: ['data/gfs/'] },
    'obs-metar': { mounts: ['data-atmos/stations/'] }, ...components } });
  assert.deepEqual(tidePrecondition(catalog(), release(), generation, policy), { previousManifestSha256: null, rollbackEpoch: 3 });
  assert.deepEqual(tidePrecondition(catalog({ fallback: { mounts: ['data-atmos/'] } }), release(['data-atmos/tides/tides.json',
    'data-atmos/tides/v2/catalog.json', 'data-atmos/tides/v2/versions/noaa-coops-20260808T211012Z/stations/1611347/window.json']), generation, policy),
  { previousManifestSha256: null, rollbackEpoch: 3 }, 'a broader fallback mount and same-grammar release tide files are replaced');
  assert.deepEqual(tidePrecondition(catalog({ 'places-tides': previous('2026-10-09T04:30:24Z') }), release(), generation, policy),
    { previousManifestSha256: 'c'.repeat(64), rollbackEpoch: 3 });
  assert.equal(tidePrecondition(catalog({ 'places-tides': previous(generation.generationTime) }), release(), generation, policy).previousManifestSha256,
    'c'.repeat(64), 'a retry of the same dataset is admitted');
  assert.throws(() => tidePrecondition(catalog({ 'places-tides': previous('2026-10-11T04:30:24Z') }), release(), generation, policy), /rollback/);
  assert.throws(() => tidePrecondition(catalog({ other: { mounts: ['data-atmos/tides/'] } }), release(), generation, policy), /claimed/);
  assert.throws(() => tidePrecondition(catalog({ other: { mounts: ['data-atmos/tides/eot20/'] } }), release(), generation, policy), /claimed/);
  assert.throws(() => tidePrecondition(catalog({ 'places-tides': { ...previous('2026-10-09T04:30:24Z'), mounts: ['data-atmos/tides/v2/'] } }), release(), generation, policy));
  for (const hidden of ['data-atmos/tides/eot20/v2/catalog.json', 'data-atmos/tides/index.json', 'data-atmos/tides/v2/versions/x/../../a.json']) {
    assert.throws(() => tidePrecondition(catalog(), release([hidden]), generation, policy), /hide/, hidden);
  }
  assert.throws(() => tidePrecondition(catalog({}, -1), release(), generation, policy));
});

test('snapshot authentication binds the catalog and release pointers to their exact bytes', () => {
  const catalogBytes = encode({ schemaVersion: 2, sequence: 7, components: {} });
  const manifest = { schemaVersion: 1, releaseId: 'cycle-1', objects: [] };
  const good = { pointerBytes: encode({ schemaVersion: 2, catalogId: '7-x', catalogSha256: hash(catalogBytes), sequence: 7 }), catalogBytes,
    releaseBytes: encode({ schemaVersion: 1, releaseId: 'cycle-1', manifestSha256: hash(Buffer.from(JSON.stringify(manifest))) }),
    manifestBytes: Buffer.from(JSON.stringify(manifest, null, 2)) };
  assert.equal(authenticateSnapshot(good).pointer.catalogId, '7-x');
  assert.throws(() => authenticateSnapshot({ ...good, catalogBytes: encode({ schemaVersion: 2, sequence: 7, components: { x: {} } }) }));
  assert.throws(() => authenticateSnapshot({ ...good, manifestBytes: encode({ ...manifest, objects: [{ path: 'x' }] }) }));
});

function fakeIO(f, { served = {}, promote = 'commit', mutateReceipt, mutateManifest, onStage } = {}) {
  const calls = { stage: [], promote: 0, snapshots: 0 }; let catalog = { rollbackEpoch: 2, components: { ...served } }, sequence = 10;
  const io = {
    async snapshot() { calls.snapshots++; return { pointer: { catalogId: `${sequence}-c` }, catalog: structuredClone(catalog), manifest: release() }; },
    async stage(env) {
      calls.stage.push(env); onStage?.();
      const { rows, inventorySha256 } = await localInventory(env.SOURCE_DIR);
      const rootPrefix = `components/${env.COMPONENT_ID}/${env.ARTIFACT_ID}/`;
      const manifest = { schemaVersion: 1, componentId: env.COMPONENT_ID, artifactId: env.ARTIFACT_ID, generationTime: env.GENERATION_TIME,
        completedAt: new Date().toISOString(), rootPrefix, mounts: [env.MOUNT], objectCount: rows.length, inventorySha256,
        quality: { status: 'passed', checks: ['manifest', 'inventory', 'remote_bytes', ...env.COMPONENT_QUALITY_CHECKS.split(',')] } };
      mutateManifest?.(manifest);
      io.bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
      const receipt = { manifestKey: `${rootPrefix}component.json`, manifestSha256: hash(io.bytes),
        expectedPreviousManifestSha256: env.EXPECTED_COMPONENT_MANIFEST_SHA256 || null, expectedRollbackEpoch: Number(env.EXPECTED_CATALOG_ROLLBACK_EPOCH) };
      mutateReceipt?.(receipt); return receipt;
    },
    async component(key) { assert(key.startsWith('components/places-tides/')); return io.bytes; },
    async promote(receipt) {
      calls.promote++;
      if (promote === 'refuse') throw new Error('catalog mutation failed (409)');
      catalog = { ...catalog, components: { ...catalog.components, 'places-tides': { componentId: 'places-tides', manifestKey: receipt.manifestKey,
        manifestSha256: receipt.manifestSha256, mounts: ['data-atmos/tides/'] } } }; sequence++;
      if (promote === 'uncertain') throw new Error('catalog mutation request failed after 4 attempts');
    },
  };
  return { io, calls };
}
const options = (f, extra = {}) => ({ clock: () => f.now, run: { id: '38012345678', attempt: '1' }, ...extra });

test('first publication stages immutably with PROMOTE=0, verifies, then CAS-promotes the absent predecessor', async t => {
  const f = await fixture(t), { io, calls } = fakeIO(f), rows = [];
  const result = await renewProduction(io, f.candidate, f.proof, policy, context, options(f, { report: row => rows.push(row) }));
  assert.equal(calls.stage.length, 1); assert.equal(calls.promote, 1);
  const env = calls.stage[0];
  assert.deepEqual({ PROMOTE: env.PROMOTE, MOUNT: env.MOUNT, COMPONENT_ID: env.COMPONENT_ID, SOURCE_DIR: env.SOURCE_DIR,
    EXPECTED_COMPONENT_MANIFEST_SHA256: env.EXPECTED_COMPONENT_MANIFEST_SHA256, EXPECTED_CATALOG_ROLLBACK_EPOCH: env.EXPECTED_CATALOG_ROLLBACK_EPOCH,
    COMPONENT_R2_REMOTE: env.COMPONENT_R2_REMOTE, CATALOG_ENDPOINT: env.CATALOG_ENDPOINT, PACK_COMPONENT_OBJECTS: env.PACK_COMPONENT_OBJECTS,
    GENERATION_TIME: env.GENERATION_TIME, ARTIFACT_ID: env.ARTIFACT_ID },
  { PROMOTE: '0', MOUNT: 'data-atmos/tides/', COMPONENT_ID: 'places-tides', SOURCE_DIR: f.root, EXPECTED_COMPONENT_MANIFEST_SHA256: '',
    EXPECTED_CATALOG_ROLLBACK_EPOCH: '2', COMPONENT_R2_REMOTE: 'weatherx:weatherx-components-production',
    CATALOG_ENDPOINT: 'https://weatherx.org/api/platform/internal/catalog', PACK_COMPONENT_OBJECTS: '0',
    GENERATION_TIME: '2026-10-10T04:30:24Z', ARTIFACT_ID: 'places-tides-20261010T043024Z-38012345678-1' });
  assert(!Object.keys(env).some(key => /KEY|SECRET|TOKEN|RCLONE/.test(key) && key !== 'REUSE_COMPONENT_MANIFEST_KEY' &&
    key !== 'REUSE_MAP_OBJECTS_MANIFEST_KEY'), 'credentials are not part of the publisher plan');
  assert.equal(result.promotion, 'accepted'); assert.equal(result.previousManifestSha256, null);
  assert.equal(result.predecessorCatalogId, '10-c'); assert.equal(result.catalogId, '11-c');
  assert.deepEqual(rows.map(row => row.stage), ['precondition', 'staged']);
});

test('an uncertain promotion is decided by the catalog readback, never by a retry', async t => {
  const f = await fixture(t);
  const uncertain = fakeIO(f, { promote: 'uncertain' });
  assert.equal((await renewProduction(uncertain.io, f.candidate, f.proof, policy, context, options(f))).promotion, 'uncertain');
  assert.equal(uncertain.calls.promote, 1);
  const refused = fakeIO(f, { promote: 'refuse', served: { 'places-tides': previous('2026-10-09T04:30:24Z') } });
  await assert.rejects(renewProduction(refused.io, f.candidate, f.proof, policy, context, options(f)), /previous component retained/);
  assert.equal(refused.calls.promote, 1);
  assert.equal(refused.calls.stage[0].EXPECTED_COMPONENT_MANIFEST_SHA256, 'c'.repeat(64));
});

test('nothing is promoted when the proof, freshness, receipt, staged manifest or inventory is wrong', async t => {
  const f = await fixture(t);
  for (const key of Object.keys(f.proof.checks)) {
    const { io, calls } = fakeIO(f);
    await assert.rejects(renewProduction(io, f.candidate, { ...f.proof, checks: { ...f.proof.checks, [key]: false } }, policy, context, options(f)));
    assert.equal(calls.stage.length + calls.promote, 0);
  }
  let clock = f.now;
  const slow = fakeIO(f, { onStage: () => { clock = Date.parse(f.candidate.completion.sourceExpiresAt) - 5 * 3600000; } });
  await assert.rejects(renewProduction(slow.io, f.candidate, f.proof, policy, context, options(f, { clock: () => clock })), /six hours/);
  assert.equal(slow.calls.promote, 0, 'freshness lost during staging');
  assert.throws(() => requireFreshness(f.candidate, policy, Date.parse(f.candidate.completion.sourceExpiresAt) - 5 * 3600000));
  for (const mutateReceipt of [r => { r.manifestKey = 'components/places-tides/other/component.json'; }, r => { r.expectedRollbackEpoch = 1; },
    r => { r.expectedPreviousManifestSha256 = 'd'.repeat(64); }, r => { r.extra = 1; }]) {
    const { io, calls } = fakeIO(f, { mutateReceipt });
    await assert.rejects(renewProduction(io, f.candidate, f.proof, policy, context, options(f))); assert.equal(calls.promote, 0);
  }
  for (const mutateManifest of [m => { m.mounts = ['data-atmos/']; }, m => { m.objectCount++; }, m => { m.inventorySha256 = 'e'.repeat(64); },
    m => { m.quality.status = 'failed'; }, m => { m.generationTime = '2026-10-11T00:00:00Z'; }, m => { m.objectLayout = { kind: 'packed-v1' }; }]) {
    const { io, calls } = fakeIO(f, { mutateManifest });
    await assert.rejects(renewProduction(io, f.candidate, f.proof, policy, context, options(f)), /readback/); assert.equal(calls.promote, 0);
  }
  const newer = fakeIO(f, { served: { 'places-tides': previous('2026-10-11T04:30:24Z') } });
  await assert.rejects(renewProduction(newer.io, f.candidate, f.proof, policy, context, options(f)), /rollback/);
  assert.equal(newer.calls.stage.length, 0, 'refused before any upload');
  await writeFile(resolve(f.root, 'v2/extra.json'), '{}');
  const { io, calls } = fakeIO(f);
  await assert.rejects(renewProduction(io, f.candidate, f.proof, policy, context, options(f)), /qualified candidate/);
  assert.equal(calls.stage.length, 0);
});

test('the staged tree is exactly the qualified candidate', async t => {
  const f = await fixture(t);
  const { rows } = await localInventory(f.root);
  assert.deepEqual(rows.map(row => row.path), ['tides.json', `v2/catalog.json`,
    `v2/versions/noaa-coops-20261010T043024Z/availability-${'b'.repeat(64)}.json`, 'v2/versions/noaa-coops-20261010T043024Z/stations/1/window.json']);
  inventoryMatchesCandidate(rows, f.candidate);
  assert.throws(() => inventoryMatchesCandidate(rows.map(row => row.path === 'tides.json' ? { ...row, sha256: 'f'.repeat(64) } : row), f.candidate));
  assert.throws(() => inventoryMatchesCandidate(rows.slice(1), f.candidate));
});

const liveResponse = (body, headers = {}) => new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8',
  'x-weatherx-catalog': '1791-abc', 'x-weatherx-data-source': 'own', 'x-content-type-options': 'nosniff', ...headers } });

test('live verification reads only weatherx.org, requires catalog service and exact bytes, retries reads only', async t => {
  const f = await fixture(t); let calls = 0; const urls = [];
  const byPath = new Map([['/data-atmos/tides/v2/catalog.json', 'v2/catalog.json'], ['/data-atmos/tides/tides.json', 'tides.json'],
    ['/data-atmos/tides/v2/versions/noaa-coops-20261010T043024Z/stations/1/window.json', 'v2/versions/noaa-coops-20261010T043024Z/stations/1/window.json'],
    [`/data-atmos/tides/v2/versions/noaa-coops-20261010T043024Z/availability-${'b'.repeat(64)}.json`, `v2/versions/noaa-coops-20261010T043024Z/availability-${'b'.repeat(64)}.json`]]);
  const fetcher = async url => { urls.push(String(url)); calls++;
    if (calls === 1) return liveResponse('old', { 'x-weatherx-catalog': '', 'x-weatherx-release': 'cycle-38008209877' });
    return liveResponse(await readFile(resolve(f.root, byPath.get(url.pathname)))); };
  const result = await verifyProductionLive(f.candidate, { fetcher, sleep: async () => {} });
  assert.deepEqual(result, { liveVerified: true, family: 'tides', identity: 'noaa-coops-20261010T043024Z', catalogId: '1791-abc', requests: 4 });
  assert.equal(calls, 5); assert(urls.every(url => new URL(url).origin === 'https://weatherx.org'));
  const fail = headers => verifyProductionLive(f.candidate, { fetcher: async url => liveResponse(await readFile(resolve(f.root, byPath.get(url.pathname))), headers),
    sleep: async () => {}, attempts: 2 });
  await assert.rejects(fail({ 'x-weatherx-release': 'cycle-1' }), /whole release/);
  await assert.rejects(fail({ 'x-weatherx-catalog': '' }));
  await assert.rejects(fail({ 'x-weatherx-data-source': 'shared' }));
  await assert.rejects(verifyProductionLive(f.candidate, { fetcher: async () => liveResponse('wrong'), sleep: async () => {}, attempts: 2 }));
});

test('the served-dataset probe renews unless this lane\'s catalog component is answering', async () => {
  const body = encode({ schemaVersion: 2, datasetId: 'noaa-coops-20261010T043024Z', retrievedAt: '2026-10-10T04:30:24Z', stations: [] });
  assert.deepEqual(await servedTideDataset(async () => liveResponse(body)), { datasetId: 'noaa-coops-20261010T043024Z', retrievedAt: Date.parse('2026-10-10T04:30:24Z') });
  assert.equal(await servedTideDataset(async () => new Response('{}', { status: 404 })), null);
  assert.equal(await servedTideDataset(async () => liveResponse(body, { 'x-weatherx-catalog': '', 'x-weatherx-release': 'cycle-1' })), null);
  assert.equal(await servedTideDataset(async () => liveResponse(encode({ datasetId: 'legacy-x', retrievedAt: 'now' }))), null);
  assert.equal(await servedTideDataset(async () => { throw new Error('network'); }), null);
});

test('workflow isolates credentials to publish, pins actions and sources, and stays off staging', async () => {
  const text = await readFile('.github/workflows/production-place-renewal.yml', 'utf8');
  const declaration = JSON.parse(await readFile('ops/atmos-production-source.json'));
  assert(text.includes('group: weatherx-places-production') && text.includes('cancel-in-progress: false'));
  assert(text.includes('name: production') && text.includes("if: vars.PRODUCTION_PLACES_RENEWAL_ENABLED == 'true' || github.event_name == 'workflow_dispatch'"));
  for (const slot of policy.schedules) assert(text.includes(`- cron: '${slot}'`));
  assert.equal(text.split(declaration.atmosSha).length - 1, 2, 'publisher is the declared production source');
  assert(!/upload-artifact|contents: write|wrangler|weatherx-data-staging|STAGING_R2|STAGING_PLACES_SEED_KEY|staging-controller/.test(text));
  const steps = text.split(/\n      - /);
  for (const step of steps) {
    if (/R2_PRODUCTION_|CATALOG_PROMOTION_KEY/.test(step)) assert(step.includes('mjs publish'), 'production credentials only in publish');
  }
  assert.equal(steps.filter(step => step.includes('CATALOG_PROMOTION_KEY_PRODUCTION')).length, 1);
  assert(text.indexOf('mjs qualify') < text.indexOf('R2_PRODUCTION_ACCESS_KEY_ID') && text.indexOf('mjs publish') < text.indexOf('mjs verify-live'));
  for (const match of text.matchAll(/uses: ([^\s]+)@([^\s]+)/g)) assert(/^[a-f0-9]{40}$/.test(match[2]));
  assert.match(text, /sparse-checkout: \|\n\s+ops\/platform\n/);
  assert.match(await readFile('tools/production-place-renewal.mjs', 'utf8'), /45 \* 60000/);
});

test('release verifiers probe a whole-release route, not the tides route this lane serves', async () => {
  const { platformVerificationEnvironment } = await import('../tools/ui-release.mjs');
  const { verifierEnvironment } = await import('../tools/platform-worker-production-release.mjs');
  for (const phase of ['candidate', 'rollback']) {
    assert.equal(platformVerificationEnvironment('production', phase, {}).EDGE_DATA_PROBE_PATH, '/data-atmos/airports/airports.json');
    assert.equal(verifierEnvironment(phase, 1, {}).EDGE_DATA_PROBE_PATH, '/data-atmos/airports/airports.json');
  }
});
