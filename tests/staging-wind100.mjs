import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync,
  truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  ACCOUNT, COMPONENTS, CONFIRMATION, DATA, MODEL, SOURCE_SHA, activateCandidate, controllerDigest,
  createCandidateS3, createPublicationTrace, createQualificationTrace, findQualifiedInput, gate, hash, loadCatalogValidator, prepareCandidate,
  listRecurringPrefixS3, nextWind100Pointer, pointerEntry, publicationFailureDiagnostic, qualificationFailureDiagnostic,
  qualifyMapInventory, qualifyPointPacks, readPolicy, recurringPrefixCapacity, sealedPointInputSha,
  validateWind100Pointer, verifySource,
} from '../tools/staging-wind100.mjs';

const MISSING = -32768;
const FIELDS = [
  { id: 'temperature', scaleInv: 100 },
  { id: 'wind_u', scaleInv: 20 },
  { id: 'wind_v', scaleInv: 20 },
  { id: 'wind_gust', scaleInv: 20 },
  { id: 'precipitation', scaleInv: 50 },
  { id: 'dewpoint', scaleInv: 100 },
  { id: 'solar_radiation', scaleInv: 1 },
  { id: 'wind100_u', scaleInv: 20 },
  { id: 'wind100_v', scaleInv: 20 },
];

test('dynamic pointer retains at most two distinct model runs and binds immutable inputs', () => {
  const selection = runId => ({ schemaVersion: 1, kind: 'weatherx-staging-native-wind100-selection',
    status: 'DATA_QUALIFIED_NOT_ACTIVATED', targetOrigin: 'https://staging.weatherx.org', model: MODEL,
    runId, catalogId: `stage-wind100-${Number(runId)}-1`, catalogSha256: 'a'.repeat(64),
    sourceSha: SOURCE_SHA, inputSha256: runId[9].repeat(64), invocation: `${Number(runId)}-1`,
    qualificationCanonicalSha256: 'b'.repeat(64), initializedAt: mapRunTime(runId),
    freshUntil: new Date(Date.parse(mapRunTime(runId)) + 30 * 3600_000).toISOString(),
    createdAt: '2026-09-11T12:00:00.000Z', isolatedStagingCandidate: true,
    sharedReadPinChanged: false, productionWritten: false, activated: false });
  const first = pointerEntry(selection('2026091100'), 'c'.repeat(64));
  const p1 = nextWind100Pointer(null, first, '2026-09-11T12:00:00.000Z');
  const second = pointerEntry(selection('2026091112'), 'd'.repeat(64));
  const p2 = nextWind100Pointer(p1, second, '2026-09-11T20:00:00.000Z');
  const third = pointerEntry(selection('2026091200'), 'e'.repeat(64));
  const p3 = nextWind100Pointer(p2, third, '2026-09-12T08:00:00.000Z');
  assert.deepEqual(p3.entries.map(row => row.runId), ['2026091200', '2026091112']);
  assert.equal(p3.entries[0].inputSha256, '0'.repeat(64));
  assert.equal(validateWind100Pointer(p3), p3);
});

test('dynamic pointer refuses duplicate, reordered, expired-identity and extra fields', () => {
  const entry = { runId: '2026091112', catalogId: 'stage-wind100-1234-1', catalogSha256: 'a'.repeat(64),
    selectionKey: 'staging-candidates/wind100/stage-wind100-1234-1/selection.json',
    selectionSha256: 'b'.repeat(64), sourceSha: SOURCE_SHA, inputSha256: 'c'.repeat(64),
    initializedAt: '2026-09-11T12:00:00Z', freshUntil: '2026-09-12T18:00:00Z' };
  const pointer = { schemaVersion: 1, kind: 'weatherx-staging-native-wind100-pointer',
    targetOrigin: 'https://staging.weatherx.org', updatedAt: '2026-09-11T20:00:00Z', entries: [entry] };
  assert.equal(validateWind100Pointer(pointer), pointer);
  for (const mutate of [
    value => value.entries.push({ ...entry }),
    value => { value.entries = [{ ...entry, runId: '2026091100', initializedAt: '2026-09-11T00:00:00Z' }, entry]; },
    value => { value.entries[0].selectionKey = 'catalogs/current.json'; },
    value => { value.entries[0].sourceSha = 'f'.repeat(39); },
    value => { value.unbounded = true; },
  ]) {
    const changed = structuredClone(pointer); mutate(changed);
    assert.throws(() => validateWind100Pointer(changed));
  }
});

test('pointer source upgrades retain one immutable prior source and refuse a backwards run', () => {
  const previousEntry = { runId: '2026091100', catalogId: 'stage-wind100-100-1', catalogSha256: 'a'.repeat(64),
    selectionKey: 'staging-candidates/wind100/stage-wind100-100-1/selection.json',
    selectionSha256: 'b'.repeat(64), sourceSha: '1'.repeat(40), inputSha256: '2'.repeat(64),
    initializedAt: '2026-09-11T00:00:00Z', freshUntil: '2026-09-12T06:00:00Z' };
  const current = { schemaVersion: 1, kind: 'weatherx-staging-native-wind100-pointer',
    targetOrigin: 'https://staging.weatherx.org', updatedAt: '2026-09-11T08:00:00Z', entries: [previousEntry] };
  const nextEntry = { ...previousEntry, runId: '2026091112', catalogId: 'stage-wind100-200-1',
    selectionKey: 'staging-candidates/wind100/stage-wind100-200-1/selection.json', sourceSha: SOURCE_SHA,
    inputSha256: '3'.repeat(64), initializedAt: '2026-09-11T12:00:00Z', freshUntil: '2026-09-12T18:00:00Z' };
  const rotated = nextWind100Pointer(current, nextEntry, '2026-09-11T20:00:00Z');
  assert.deepEqual(rotated.entries.map(row => row.sourceSha), [SOURCE_SHA, '1'.repeat(40)]);
  assert.throws(() => nextWind100Pointer(rotated, { ...previousEntry, runId: '2026091012',
    initializedAt: '2026-09-10T12:00:00Z' }, '2026-09-11T21:00:00Z'), /regressed/);
});

test('input identity covers only authenticated point-stage bytes and ignores regenerated maps', () => {
  const point = { path: 'data/.ecmwf-point/meta.json', size: 10, sha256: 'a'.repeat(64) };
  const fields = ['temperature', 'wind_u', 'wind_v', 'precipitation'].map((name, index) =>
    ({ path: `data/.ecmwf-point/${name}.i16.npy`, size: index + 1, sha256: String(index + 1).repeat(64) }));
  const first = { files: [{ path: 'app/public/data/ecmwf/index.json', size: 9, sha256: 'b'.repeat(64) }, point, ...fields] };
  const second = structuredClone(first); second.files[0].sha256 = 'c'.repeat(64);
  assert.equal(sealedPointInputSha(first), sealedPointInputSha(second));
  second.files[2].sha256 = 'd'.repeat(64);
  assert.notEqual(sealedPointInputSha(first), sealedPointInputSha(second));
});

test('pointer activation verifies immutable selection/catalog and retries one CAS conflict', async () => {
  const selection = { schemaVersion: 1, kind: 'weatherx-staging-native-wind100-selection',
    status: 'DATA_QUALIFIED_NOT_ACTIVATED', targetOrigin: 'https://staging.weatherx.org', model: MODEL,
    runId: '2026091112', catalogId: 'stage-wind100-recurring-1234-1', catalogSha256: '', sourceSha: SOURCE_SHA,
    inputSha256: '4'.repeat(64), invocation: '1234-1', qualificationCanonicalSha256: '5'.repeat(64),
    publicationMode: 'point-only-recurring-v1',
    initializedAt: '2026-09-11T12:00:00Z', freshUntil: '2026-09-12T18:00:00Z',
    createdAt: '2026-09-11T20:00:00.000Z', isolatedStagingCandidate: true,
    sharedReadPinChanged: false, productionWritten: false, activated: false };
  const catalog = { schemaVersion: 2, sequence: 1, parentCatalogId: null,
    createdAt: selection.createdAt, components: { 'point-ecmwf': {
      componentId: 'point-ecmwf', generationTime: selection.initializedAt,
      mounts: ['point-series/v2/ecmwf/'], pointSeries: { schemaVersion: 1, modelId: 'ecmwf', descriptor: {
        runId: selection.runId, initializedAt: selection.initializedAt, freshUntil: selection.freshUntil,
        source: 'ECMWF IFS 0.25 degree direct open-data GRIB', variables: {
          wind_speed: { kind: 'instantaneous', units: 'm/s' },
          wind_speed_100m: { kind: 'instantaneous', units: 'm/s' },
        },
      } },
    } }, rollbackEpoch: 0 };
  const catalogBody = encode(catalog); selection.catalogSha256 = hash(catalogBody);
  const selectionBody = encode(selection), selectionSha256 = hash(selectionBody);
  assert.throws(() => pointerEntry({ ...selection, catalogId: 'stage-wind100-1234-1' }, selectionSha256));
  let pointerBody = null, conflicts = 1;
  const io = {
    async get(key) {
      if (key.endsWith('/selection.json')) return { body: selectionBody };
      if (key.startsWith('catalogs/snapshots/')) return { body: catalogBody };
      return pointerBody == null ? null : { body: pointerBody, etag: 'etag-1' };
    },
    async put(body) { if (conflicts-- > 0) return false; pointerBody = body; return true; },
  };
  const pointer = await activateCandidate({ selection, selectionSha256, io, now: () => Date.parse('2026-09-11T20:00:00Z'),
    catalogValidator: value => JSON.stringify(value) === JSON.stringify(catalog) });
  assert.equal(conflicts, -1); assert.equal(pointer.entries[0].inputSha256, selection.inputSha256);
  const unchanged = await findQualifiedInput({ runId: selection.runId, inputSha256: selection.inputSha256,
    io, catalogValidator: value => JSON.stringify(value) === JSON.stringify(catalog) });
  assert.equal(unchanged.status, 'unchanged'); assert.equal(unchanged.catalogId, selection.catalogId);
  const upgradedSource = await findQualifiedInput({ runId: selection.runId, inputSha256: selection.inputSha256,
    sourceSha: '9'.repeat(40), io, catalogValidator: () => true });
  assert.equal(upgradedSource.status, 'new-input');
  pointerBody = encode({ ...pointer, entries: [{ ...pointer.entries[0], sourceSha: '9'.repeat(40) }] });
  const replaced = await activateCandidate({ selection, selectionSha256, io,
    now: () => Date.parse('2026-09-11T20:00:01Z'), catalogValidator: value => JSON.stringify(value) === JSON.stringify(catalog) });
  assert.equal(replaced.entries.length, 1);
  assert.equal(replaced.entries[0].sourceSha, SOURCE_SHA);
});

test('recurring preflight never treats a legacy paired selection as unchanged', async () => {
  const selection = { schemaVersion: 1, kind: 'weatherx-staging-native-wind100-selection',
    status: 'DATA_QUALIFIED_NOT_ACTIVATED', targetOrigin: 'https://staging.weatherx.org', model: MODEL,
    runId: '2026091112', catalogId: 'stage-wind100-77-1', catalogSha256: 'a'.repeat(64),
    sourceSha: SOURCE_SHA, inputSha256: 'b'.repeat(64), invocation: '77-1',
    qualificationCanonicalSha256: 'c'.repeat(64), initializedAt: '2026-09-11T12:00:00Z',
    freshUntil: '2026-09-12T18:00:00Z', createdAt: '2026-09-11T20:00:00Z',
    isolatedStagingCandidate: true, sharedReadPinChanged: false, productionWritten: false, activated: false };
  const selectionBody = encode(selection), selectionSha256 = hash(selectionBody);
  assert.throws(() => pointerEntry({ ...selection, catalogId: 'stage-wind100-recurring-77-1' }, selectionSha256));
  const entry = pointerEntry(selection, selectionSha256);
  const pointerBody = encode({ schemaVersion: 1, kind: 'weatherx-staging-native-wind100-pointer',
    targetOrigin: 'https://staging.weatherx.org', updatedAt: selection.createdAt, entries: [entry] });
  const io = { get: async key => key === 'staging-candidates/wind100/current-v1.json'
    ? { body: pointerBody } : key === entry.selectionKey ? { body: selectionBody } : null };
  const result = await findQualifiedInput({ runId: selection.runId, inputSha256: selection.inputSha256,
    sourceSha: selection.sourceSha, io, catalogValidator: () => true });
  assert.equal(result.status, 'new-input');
  const candidate = { ...selection, catalogId: 'stage-wind100-recurring-78-1', catalogSha256: '', invocation: '78-1',
    publicationMode: 'point-only-recurring-v1', createdAt: '2026-09-11T20:00:01Z' };
  const descriptor = { runId: candidate.runId, initializedAt: candidate.initializedAt, freshUntil: candidate.freshUntil,
    source: 'ECMWF IFS 0.25 degree direct open-data GRIB', variables: {
      wind_speed: { kind: 'instantaneous', units: 'm/s' }, wind_speed_100m: { kind: 'instantaneous', units: 'm/s' },
    } };
  const catalog = { schemaVersion: 2, components: { 'point-ecmwf': { componentId: 'point-ecmwf',
    generationTime: candidate.initializedAt, mounts: ['point-series/v2/ecmwf/'],
    pointSeries: { schemaVersion: 1, modelId: MODEL, descriptor } } } };
  const catalogBody = encode(catalog); candidate.catalogSha256 = hash(catalogBody);
  const candidateBody = encode(candidate), candidateSha = hash(candidateBody);
  let current = pointerBody;
  const mutable = { get: async key => key === 'staging-candidates/wind100/current-v1.json' ? { body: current, etag: 'old' }
    : key === entry.selectionKey ? { body: selectionBody }
      : key === `staging-candidates/wind100/${candidate.catalogId}/selection.json` ? { body: candidateBody }
        : key === `catalogs/snapshots/${candidate.catalogId}.json` ? { body: catalogBody } : null,
  put: async body => { current = body; return true; } };
  const migrated = await activateCandidate({ selection: candidate, selectionSha256: candidateSha, io: mutable,
    now: () => Date.parse(candidate.createdAt), catalogValidator: () => true });
  assert.equal(migrated.entries.length, 1);
  assert.equal(migrated.entries[0].catalogId, candidate.catalogId);
});

test('recurring workflow consumes a core artifact, augments two fields, and uploads no map component', () => {
  const source = readFileSync(new URL('../.github/workflows/staging-wind100-recurring.yml', import.meta.url), 'utf8');
  const code = source.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.match(code, /workflow_call:/); assert.doesNotMatch(code, /\n  (?:schedule|push|pull_request|workflow_run):/);
  assert.match(source, /STAGING_R2_WRITE_ACCESS_KEY_ID:\n\s+required: false/);
  assert.match(source, /STAGING_R2_WRITE_SECRET_ACCESS_KEY:\n\s+required: false/);
  assert.ok(code.indexOf('Check the protected staging opt-in') < code.indexOf('actions/checkout@'));
  assert.match(code, /current-model-artifact\.py/); assert.match(code, /augment_ecmwf_wind100\.py/);
  assert.match(code, /WIND100_INPUT_SHA256/); assert.match(code, /staging-wind100\.mjs preflight/);
  assert.ok(code.indexOf('staging-wind100.mjs preflight') < code.indexOf('augment_ecmwf_wind100.py'));
  assert.match(code, /SOURCE_DIR=.*weatherx-wind100-point-series/);
  assert.doesNotMatch(code, /SOURCE_DIR=app\/public\/data\/ecmwf|stage-wind100-ecmwf-\$GITHUB_RUN_ID/);
  assert.doesNotMatch(code, /hydrate-r2-component|validate-model-component|weatherx-wind100-map-component/);
  assert.match(code, /recurring-retention-gate/);
  assert.match(code, /ARTIFACT_ID="stage-wind100-recurring-point-ecmwf-\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT"/);
  assert.match(code, /publish-recurring staging-wind100\/qualification\.json \\\n\s+weatherx-wind100-point-component\.json/);
  assert.doesNotMatch(code, /fetch_ecmwf\.py --hours|bake-model-component\.sh|weatherx-(?:data|components)-production/);
  assert.doesNotMatch(code, /wrangler|pages|deploy|catalogs\/current\.json|shared-read\/pin\.json/);
  assert.match(code, /staging-candidates\/wind100\/current-v1\.json|staging-wind100\.mjs activate/);
});

test('bake staging-only pilot can start only the fresh ECMWF collector and recurring publisher', () => {
  const source = readFileSync(new URL('../.github/workflows/bake.yml', import.meta.url), 'utf8');
  const trigger = source.split('\njobs:\n')[0];
  assert.match(trigger, /staging_wind100_only:\n\s+description: Run only a fresh ECMWF collector and the isolated staging Wind100 publisher\n\s+type: boolean\n\s+required: false\n\s+default: false/);
  const jobsSource = source.split('\njobs:\n')[1];
  assert.ok(jobsSource);
  const starts = [...jobsSource.matchAll(/^  ([A-Za-z_][A-Za-z0-9_-]*):\n/gm)];
  const jobs = Object.fromEntries(starts.map((match, index) => [match[1],
    jobsSource.slice(match.index, starts[index + 1]?.index)]));
  assert.deepEqual(Object.keys(jobs), [
    'core-ecmwf', 'staging-wind100',
    'core-gfs', 'core-hrrr', 'core-aifs',
    'regional-icon', 'regional-hrdps', 'regional-arome-antilles', 'regional-hrrr-ak',
    'regional-nam', 'regional-nam-hi', 'regional-nam-ak',
    'publish-ecmwf', 'publish-gfs', 'publish-hrrr', 'publish-aifs',
    'publish-icon', 'publish-hrdps', 'publish-arome-antilles', 'publish-hrrr-ak',
    'publish-nam', 'publish-nam-hi', 'publish-nam-ak',
    'component-publish-status', 'bake', 'model-status',
  ]);
  assert.match(jobs['core-ecmwf'], /inputs\.staging_wind100_only == true && github\.event_name == 'workflow_dispatch' && inputs\.model == 'ecmwf' && inputs\.recovery_run_id == ''/);
  assert.match(jobs['core-ecmwf'], /inputs\.staging_wind100_only != true && \(inputs\.model == '' \|\| inputs\.model == 'all' \|\| inputs\.model == 'ecmwf'\)/);
  assert.match(jobs['staging-wind100'], /needs\.core-ecmwf\.result == 'success'/);
  assert.match(jobs['staging-wind100'], /inputs\.staging_wind100_only != true \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.model == 'ecmwf' && inputs\.recovery_run_id == ''\)/);
  assert.doesNotMatch(jobs['staging-wind100'], /R2_PRODUCTION|CATALOG_ENDPOINT_PRODUCTION|CATALOG_PROMOTION_KEY_PRODUCTION/);
  for (const [name, block] of Object.entries(jobs)) {
    if (name === 'core-ecmwf' || name === 'staging-wind100') continue;
    assert.match(block, /^    if: \$\{\{ inputs\.staging_wind100_only != true && \(/m,
      `${name} can start during a staging-only pilot`);
  }
});

function semantics(initializedAt, leads) {
  return { schemaVersion: 1, contract: 'weatherx-native-wind100-grib-v1', model: 'ecmwf',
    initializedAt: initializedAt.replace('.000Z', 'Z'), verifiedLeadHours: leads,
    deliveryGrid: 'global-regular-ll-0.25-degree-v1', fields: {
      wind100_u: { sourceParameter: '100u', discipline: 0, parameterCategory: 2, parameterNumber: 2,
        typeOfLevel: 'heightAboveGround', level: 100, sourceUnits: 'm s**-1', outputUnits: 'm/s', stepType: 'instant', earthRelative: true },
      wind100_v: { sourceParameter: '100v', discipline: 0, parameterCategory: 2, parameterNumber: 3,
        typeOfLevel: 'heightAboveGround', level: 100, sourceUnits: 'm s**-1', outputUnits: 'm/s', stepType: 'instant', earthRelative: true },
    } };
}

function encode(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

const MAP_DYNAMIC_VARIABLES = [
  'wind', 'temp', 'gust', 'mslp', 'precip', 'ptype', 'cloud', 'cape', 'dewpoint',
  'gh925', 'gh850', 'gh500', 'wind925', 'wind850', 'wind500',
];
const MAP_NATIVE_VARIABLES = new Set(['wind', 'temp', 'gust', 'mslp', 'precip', 'cloud', 'dewpoint']);

function mapRunTime(runId) {
  return `${runId.slice(0, 4)}-${runId.slice(4, 6)}-${runId.slice(6, 8)}T${runId.slice(8, 10)}:00:00Z`;
}

function writeMapFile(root, path, bytes = Buffer.from([1])) {
  const target = resolve(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes);
}

function nativeFrameIndex(runId, variable, frame) {
  const objects = Array.from({ length: 12 }, (_, tileX) => ({
    tileX, offset: tileX * 16, length: 16, encodedSha256: 'a'.repeat(64), decodedSha256: 'b'.repeat(64),
    width: tileX === 11 ? 37 : 133, height: 133,
  }));
  return {
    schemaVersion: 1, representation: 'native-rgba128-halo-l2-t2-r3-b3-row-v1',
    source: { model: 'ecmwf', run: mapRunTime(runId), variable, frame,
      decodedSha256: 'c'.repeat(64), width: 1440, height: 721 },
    layout: { core: 128, left: 2, top: 2, right: 3, bottom: 3, columns: 12, rows: 6 },
    rows: Array.from({ length: 6 }, (_, tileY) => ({
      tileY, file: `row-${String(tileY).padStart(2, '0')}.wxb`, bytes: 192,
      sha256: hash(Buffer.alloc(192, 1)), objects: objects.map(object => ({
        ...object, height: tileY === 5 ? 86 : 133,
      })),
    })),
  };
}

function writeMapTree(mapRoot, { frames = 2, realistic = false } = {}) {
  rmSync(mapRoot, { recursive: true, force: true });
  mkdirSync(mapRoot, { recursive: true });
  const runIds = ['2026091012', '2026091000'];
  const variableNames = realistic ? MAP_DYNAMIC_VARIABLES : MAP_DYNAMIC_VARIABLES.slice(0, 5);
  for (const [runIndex, runId] of runIds.entries()) {
    const runRoot = `runs/${runId}`;
    const frameRows = Array.from({ length: frames }, (_, i) => ({ i, valid_time: mapRunTime(runId) }));
    const variables = {};
    for (const variable of variableNames) {
      variables[variable] = { file: `${variable}/{i}.png` };
      for (let frame = 0; frame < frames; frame++) {
        writeMapFile(mapRoot, `${runRoot}/${variable}/${String(frame).padStart(3, '0')}.png`);
      }
    }
    variables.wind.progressive = { file: 'wind-low/{i}.png', grid: { width: 360, height: 181 } };
    for (let frame = 0; frame < frames; frame++) {
      writeMapFile(mapRoot, `${runRoot}/wind-low/${String(frame).padStart(3, '0')}.png`);
    }
    variables.orog = { file: 'orog.png', static: true };
    writeMapFile(mapRoot, `${runRoot}/orog.png`);
    // A hydrated baseline may retain an older conventional run without native
    // sidecars. The fresh run is required to be native; the realistic fixture
    // models the two-native-run tree observed after a second qualification.
    const nativeVariables = realistic || runIndex === 0 ? [...MAP_NATIVE_VARIABLES].filter(
      variable => realistic || variable === 'wind') : [];
    for (const variable of nativeVariables) {
      const directory = `${variable}-native-${hash(Buffer.from(variable)).slice(0, 16)}`;
      variables[variable].nativeViewport = {
        schemaVersion: 1, representation: 'native-rgba128-halo-l2-t2-r3-b3-row-v1',
        index: `${directory}/{i}/index.json`, rangeRequired: true, fullGridFallback: true,
      };
      for (let frame = 0; frame < frames; frame++) {
        const frameId = String(frame).padStart(3, '0');
        writeMapFile(mapRoot, `${runRoot}/${directory}/${frameId}/index.json`, encode(nativeFrameIndex(runId, variable, frame)));
        for (let row = 0; row < 6; row++) {
          writeMapFile(mapRoot, `${runRoot}/${directory}/${frameId}/row-${String(row).padStart(2, '0')}.wxb`, Buffer.alloc(192, 1));
        }
      }
    }
    writeMapFile(mapRoot, `${runRoot}/manifest.json`, encode({
      schemaVersion: 1, model: 'ecmwf', init_time: mapRunTime(runId),
      grid: { width: 1440, height: 721 }, variables, frames: frameRows,
    }));
  }
  writeMapFile(mapRoot, 'index.json', encode({ schemaVersion: 1, model: 'ecmwf', runs: runIds.map(runId => ({
    init_time: mapRunTime(runId), path: `runs/${runId}/`,
  })) }));
}

function inventoryHash(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

// Repository-independent copy of the exact frozen publisher traversal contract
// in ops/platform/build-component-manifest.mjs: depth-first, locale-sorted per
// directory. The controller receipt must hash this order, not a global path sort.
function publisherInventory(root) {
  const files = [];
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = resolve(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else assert.fail(`unsupported publisher fixture entry ${entry.name}`);
    }
  };
  visit(root);
  return files.map(absolute => {
    const bytes = readFileSync(absolute);
    return { path: relative(root, absolute).replaceAll('\\', '/'), size: lstatSync(absolute).size, sha256: hash(bytes) };
  });
}

function writePack(path, { chunkX, chunkY, width, height, leads = 2, mutate = ({ value }) => value }) {
  const raw = Buffer.alloc(14 + width * height * FIELDS.length * leads * 2);
  raw.write('WXPS', 0, 'ascii');
  raw.writeUInt8(1, 4);
  raw.writeUInt8(width, 5);
  raw.writeUInt8(height, 6);
  raw.writeUInt8(FIELDS.length, 7);
  raw.writeUInt16LE(leads, 8);
  raw.writeUInt16LE(chunkX, 10);
  raw.writeUInt16LE(chunkY, 12);
  let offset = 14;
  for (const field of FIELDS) {
    for (let cell = 0; cell < width * height; cell++) {
      for (let lead = 0; lead < leads; lead++) {
        let value = field.id === 'wind100_u' ? 60 + lead : field.id === 'wind100_v' ? 80 + lead : 10;
        value = mutate({ cell, field: field.id, lead, value });
        raw.writeInt16LE(value, offset);
        offset += 2;
      }
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, gzipSync(raw, { mtime: 0 }));
}

function writeNpy(path, shape, values) {
  let dictionary = `{'descr': '<i2', 'fortran_order': False, 'shape': (${shape.join(', ')},), }`;
  const padding = (16 - ((10 + Buffer.byteLength(dictionary) + 1) % 16)) % 16;
  dictionary += `${' '.repeat(padding)}\n`;
  const header = Buffer.alloc(10);
  Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]).copy(header);
  header.writeUInt16LE(Buffer.byteLength(dictionary), 8);
  const data = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => data.writeInt16LE(value, index * 2));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.concat([header, Buffer.from(dictionary, 'latin1'), data]));
}

function fixture(t, mutate = ({ value }) => value) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'weatherx-wind100-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pointRoot = resolve(root, 'point-series');
  const grid = { lon0: -180, lat0: 90, lonStep: 1, latStep: -1, width: 3, height: 2, wrapLongitude: true };
  const policy = {
    sourceSha: 'a'.repeat(40), coreSourceSha: 'd'.repeat(40), recurringPublicationMode: 'point-only-recurring-v1',
    recurringStorage: {
      componentObjectPrefix: 'components/point-ecmwf/stage-wind100-recurring-point-ecmwf-',
      catalogObjectPrefix: 'catalogs/snapshots/stage-wind100-recurring-',
      selectionObjectPrefix: 'staging-candidates/wind100/stage-wind100-recurring-',
      maximumComponentPrefixObjects: 50_000,
    },
    model: 'ecmwf', hours: 3, leadCount: 2, freshnessHours: 30,
    minimumForecastLeaseHours: 6, nativeCadenceSeconds: 10800, storageFields: FIELDS.map(field => ({ ...field })),
    grid,
    chunk: { width: 2, height: 1 },
    native100m: { contract: 'weatherx-native-wind100-grib-v1', requiredJointCoveragePermille: 1000,
      sourceParameters: { wind100_u: '100u', wind100_v: '100v' }, sourceUnits: 'm s**-1',
      levelType: 'heightAboveGround', level: 100, stepType: 'instant', earthRelative: true,
      deliveryGrid: 'global-regular-ll-0.25-degree-v1' },
  };
  const stageRoot = resolve(root, 'data/.ecmwf-point');
  const initializedAt = '2026-09-10T12:00:00.000Z';
  const descriptor = {
    runId: '2026091012', initializedAt,
    generatedAt: '2026-09-10T12:10:00.000Z', freshUntil: '2026-09-11T18:00:00.000Z',
    source: 'synthetic ECMWF', license: { id: 'CC-BY-4.0', redistributionAllowed: true, reviewedAt: '2026-09-01T00:00:00.000Z' },
    resolutionDegrees: 0.25, nativeCadenceSeconds: 10800, grid, chunk: { width: 2, height: 1 },
    variables: {
      temperature: { kind: 'instantaneous', units: 'degC' },
      wind_speed: { kind: 'instantaneous', units: 'm/s' },
      precipitation: { kind: 'interval', units: 'mm/h' },
      wind_speed_100m: { kind: 'instantaneous', units: 'm/s' },
    },
    storage: { format: 'WXPS1', missing: MISSING, leadHours: [0, 3], fields: FIELDS.map(field => ({ ...field })) },
    fieldSemantics: semantics(initializedAt, [0, 3]),
  };
  const catalog = { schemaVersion: 2, models: { ecmwf: descriptor } };
  const catalogPath = resolve(pointRoot, 'v2/catalog.json');
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(catalogPath, encode(catalog));
  for (let chunkY = 0; chunkY < 2; chunkY++) {
    for (let chunkX = 0; chunkX < 2; chunkX++) {
      const width = chunkX === 0 ? 2 : 1;
      writePack(resolve(pointRoot, `v2/ecmwf/${descriptor.runId}/chunks/${chunkY}/${chunkX}.bin.gz`), {
        chunkX, chunkY, width, height: 1, mutate: value => mutate({ ...value, chunkX, chunkY }),
      });
    }
  }
  const stageMeta = {
    schemaVersion: 2, model: 'ecmwf', run: '20260910/12z', steps: [0, 3], grid,
    fields: FIELDS.map(field => field.id), fieldSemantics: semantics(initializedAt, [0, 3]),
  };
  mkdirSync(stageRoot, { recursive: true });
  writeFileSync(resolve(stageRoot, 'meta.json'), encode(stageMeta));
  for (const field of FIELDS) {
    const values = [];
    for (let lead = 0; lead < 2; lead++) {
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 3; x++) {
          const chunkX = Math.floor(x / 2), chunkY = y, cell = x % 2;
          const original = field.id === 'wind100_u' ? 60 + lead : field.id === 'wind100_v' ? 80 + lead : 10;
          values.push(mutate({ cell, field: field.id, lead, value: original, chunkX, chunkY }));
        }
      }
    }
    writeNpy(resolve(stageRoot, `${field.id}.i16.npy`), [2, 2, 3], values);
  }
  const paths = [catalogPath,
    ...[0, 1].flatMap(chunkY => [0, 1].map(chunkX =>
      resolve(pointRoot, `v2/ecmwf/${descriptor.runId}/chunks/${chunkY}/${chunkX}.bin.gz`))),
  ];
  const objects = paths.map(path => {
    const relative = path.slice(pointRoot.length + 1);
    const bytes = readFileSync(path);
    return { path: `point-series/${relative}`, bytes: bytes.length, sha256: hash(bytes) };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const structuralReport = {
    schemaVersion: 2, objectCount: objects.length, manifestSha256: inventoryHash(objects),
    models: { ecmwf: descriptor }, objects,
  };
  const sourceEvidence = {
    sourceSha: policy.sourceSha,
    files: [{ path: 'data/build_point_series.py', sha256: 'b'.repeat(64) }],
  };
  const stageInventory = [resolve(stageRoot, 'meta.json'), ...FIELDS.map(field => resolve(stageRoot, `${field.id}.i16.npy`))]
    .map(path => ({ path: path.slice(stageRoot.length + 1), bytes: readFileSync(path).length, sha256: hash(readFileSync(path)) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const sealedManifest = { schemaVersion: 1, status: 'unqualified-core-inputs', model: 'ecmwf',
    sourceSha: policy.sourceSha, runId: 'fixture-1', forecastRun: descriptor.runId,
    files: [{ path: 'app/public/data/ecmwf/index.json', size: 10, sha256: 'c'.repeat(64) },
      ...stageInventory.map(row => ({ path: `data/.ecmwf-point/${row.path}`, size: row.bytes, sha256: row.sha256 }))] };
  const mapProof = { model: 'ecmwf', generationTime: initializedAt, ageHours: 1,
    variables: 6, frames: 2, horizonHours: 3, runs: 2 };
  const mapRoot = resolve(root, 'app/public/data/ecmwf');
  writeMapTree(mapRoot);
  return { root, pointRoot, stageRoot, catalogPath, catalog, descriptor, policy, structuralReport,
    sourceEvidence, sealedManifest, mapProof, mapRoot, now: Date.parse('2026-09-10T13:00:00Z'), model: 'ecmwf' };
}

function recurringFixture(t) {
  const f = fixture(t);
  f.descriptor.source = 'ECMWF IFS 0.25 degree direct open-data GRIB';
  writeFileSync(f.catalogPath, encode(f.catalog));
  const catalogObject = f.structuralReport.objects.find(row => row.path === 'point-series/v2/catalog.json');
  const catalogBytes = readFileSync(f.catalogPath);
  catalogObject.bytes = catalogBytes.length;
  catalogObject.sha256 = hash(catalogBytes);
  f.structuralReport.manifestSha256 = inventoryHash(f.structuralReport.objects);
  const inputRows = readdirSync(f.stageRoot).sort().map(path => {
    const bytes = readFileSync(resolve(f.stageRoot, path));
    return { path: `data/.ecmwf-point/${path}`, size: bytes.length, sha256: hash(bytes) };
  });
  const inputManifest = { schemaVersion: 1, status: 'unqualified-core-inputs', model: MODEL,
    sourceSha: f.policy.coreSourceSha, runId: '777', forecastRun: f.descriptor.runId, files: inputRows };
  const inputSha256 = sealedPointInputSha(inputManifest);
  const normalized = inputRows.map(row => ({ path: row.path.slice('data/.ecmwf-point/'.length),
    bytes: row.size, sha256: row.sha256 }));
  const inventorySha256 = hash(Buffer.from(JSON.stringify(normalized.map(row => ({
    bytes: row.bytes, path: row.path, sha256: row.sha256,
  })))));
  const request = { model: MODEL, sourceSha: f.policy.sourceSha, invocation: '1234-1', inputSha256,
    publicationMode: f.policy.recurringPublicationMode };
  return { ...f, request, mapProof: { generationTime: 'frozen-staging-map' },
    mapRoot: resolve(f.root, 'missing-frozen-staging-map'), inputManifest,
    inputHandoff: { schemaVersion: 1, kind: 'weatherx-current-model-artifact-handoff', status: 'ready',
      publicationAuthorized: false, model: MODEL, componentKind: 'core',
      origin: { atmosSourceSha: f.policy.coreSourceSha, artifactSha256: 'e'.repeat(64), runId: '777' },
      pack: { forecastRun: f.descriptor.runId, receiptSha256: hash(encode(inputManifest)) } },
    augmentationReceipt: { schemaVersion: 1, kind: 'weatherx-ecmwf-native-wind100-augmentation', model: MODEL,
      runId: f.descriptor.runId, initializedAt: f.descriptor.initializedAt, inputSha256,
      sourceContract: f.policy.native100m.contract, leadHours: f.descriptor.storage.leadHours,
      fetched: false, inputInventorySha256: inventorySha256, outputInventorySha256: inventorySha256,
      publicationAuthorized: false } };
}

function environment(digest = controllerDigest()) {
  return {
    GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', GITHUB_JOB: 'wind100',
    GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-wind100.yml@refs/heads/main',
    GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1',
    STAGING_DATA_ISOLATION_APPROVED: 'true', STAGING_WIND100_ENABLED: 'true',
    STAGING_R2_ACCOUNT_ID: ACCOUNT,
    ATMOS_SHA: SOURCE_SHA, STAGING_WIND100_CONTROLLER_SHA256: digest,
    WIND100_CONFIRMATION: CONFIRMATION, MODEL_ID: 'ecmwf',
  };
}

test('synthetic pack layout matches the pinned producer bytes apart from gzip OS metadata', t => {
  // Generated by SOURCE_SHA data/build_point_series.py (blob
  // 88d040923e99130f4c5bcd32ce76c2cae3971f69e1af736b9d92ea3766405f80)
  // from a two-cell, two-lead stage. This prevents a self-consistent but wrong
  // JS fixture/validator field ordering from going green.
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'weatherx-wxps-golden-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = resolve(root, '0.bin.gz');
  writePack(path, { chunkX: 0, chunkY: 0, width: 2, height: 1 });
  const golden = Buffer.from('H4sIAAAAAAAAEwuPCAhmZGLkZGIAAS4yoQ2DLRgHMASCMQB7u4G+VgAAAA==', 'base64');
  const actual = readFileSync(path);
  // gzip byte 9 identifies the compression host (Linux=3, macOS=19), not WXPS
  // data. Hosted CI differs from the Mac golden at this byte alone. Preserve
  // every layout/data/deflate/CRC assertion; normalize only this known header.
  assert.ok([3, 19].includes(actual[9]));
  assert.deepEqual(gunzipSync(actual), gunzipSync(golden));
  actual[9] = golden[9];
  assert.deepEqual(actual, golden);
  assert.equal(hash(actual), '60e9fd15171fa22c3b779c71e9690748714ab224d763294612fd9585f33c9885');
});

test('policy fixes one reviewed ECMWF source, exact semantics and dependency closure', () => {
  const policy = readPolicy();
  assert.equal(policy.sourceSha, SOURCE_SHA);
  assert.equal(policy.recurringPublicationMode, 'point-only-recurring-v1');
  assert.deepEqual(policy.recurringStorage, {
    componentObjectPrefix: 'components/point-ecmwf/stage-wind100-recurring-point-ecmwf-',
    catalogObjectPrefix: 'catalogs/snapshots/stage-wind100-recurring-',
    selectionObjectPrefix: 'staging-candidates/wind100/stage-wind100-recurring-',
    maximumComponentPrefixObjects: 50_000,
  });
  assert.deepEqual({ model: policy.model, hours: policy.hours, leadCount: policy.leadCount,
    freshnessHours: policy.freshnessHours, minimumForecastLeaseHours: policy.minimumForecastLeaseHours,
    nativeCadenceSeconds: policy.nativeCadenceSeconds },
  { model: 'ecmwf', hours: 336, leadCount: 81, freshnessHours: 30,
    minimumForecastLeaseHours: 6, nativeCadenceSeconds: 10800 });
  assert.deepEqual(policy.chunk, { width: 16, height: 16 });
  assert.equal(Math.ceil(policy.grid.width / policy.chunk.width) * Math.ceil(policy.grid.height / policy.chunk.height), 4140);
  assert.deepEqual(policy.storageFields.map(field => field.id), [
    'temperature', 'wind_u', 'wind_v', 'wind_gust', 'precipitation', 'dewpoint',
    'solar_radiation', 'wind100_u', 'wind100_v',
  ]);
  assert.equal(policy.native100m.requiredJointCoveragePermille, 1000);
  assert.equal(policy.native100m.contract, 'weatherx-native-wind100-grib-v1');
  assert.equal(policy.dependencyLock.path, 'tools/staging-wind100-requirements.txt');
  assert.ok(Object.keys(policy.sourceClosure).includes('data/native_wind100.py'));
  assert.ok(Object.keys(policy.sourceClosure).includes('ops/core_model_artifact.py'));
  assert.ok(Object.keys(policy.sourceClosure).includes('ops/platform/publish-r2-component.sh'));
  assert.ok(Object.values(policy.sourceClosure).every(value => /^[a-f0-9]{64}$/.test(value)));
});

test('gate is manual hosted main, ECMWF-only, exact-controller and credential-free', () => {
  const env = environment();
  assert.deepEqual(gate(env), { model: 'ecmwf', sourceSha: SOURCE_SHA, invocation: '1234-1' });
  for (const patch of [
    { GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_REF: 'refs/heads/dev' }, { GITHUB_JOB: 'other' },
    { ATMOS_SHA: 'c'.repeat(40) }, { MODEL_ID: 'gfs' }, { WIND100_CONFIRMATION: 'yes' },
    { STAGING_WIND100_ENABLED: 'false' }, { STAGING_WIND100_CONTROLLER_SHA256: 'e'.repeat(64) },
    { GITHUB_RUN_ID: 'not-a-run' }, { GITHUB_RUN_ATTEMPT: '0' },
    { R2_PRODUCTION_ACCESS_KEY_ID: 'secret' }, { SHARED_R2_READ_SECRET_ACCESS_KEY: 'secret' },
    { CLOUDFLARE_API_TOKEN: 'secret' }, { AWS_ACCESS_KEY_ID: 'secret' },
    { STAGING_R2_WRITE_ACCESS_KEY_ID: 'secret' }, { CATALOG_PROMOTION_KEY: 'secret' },
  ]) assert.throws(() => gate({ ...env, ...patch }), JSON.stringify(patch));
});

test('credential gates accept only the exact staging account, buckets and inert component mode', () => {
  const common = { ...environment(), STAGING_R2_WRITE_ACCESS_KEY_ID: 'id', STAGING_R2_WRITE_SECRET_ACCESS_KEY: 'secret',
    RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID: 'id', RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY: 'secret',
    RCLONE_CONFIG_WEATHERX_ENDPOINT: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    COMPONENT_R2_REMOTE: `weatherx:${COMPONENTS}` };
  const hydrate = { ...common, CATALOG_R2_REMOTE: `weatherx:${DATA}`, COMPONENT_ID: MODEL,
    ALLOW_EMPTY_CATALOG: '0', ALLOW_MISSING_COMPONENT: '0', HYDRATE_MISSING_FROM_RELEASE: '0' };
  assert.equal(gate(hydrate, readPolicy(), controllerDigest(), 'hydrate').model, MODEL);
  assert.throws(() => gate({ ...hydrate, CATALOG_R2_REMOTE: 'weatherx:weatherx-data-production' }, readPolicy(), controllerDigest(), 'hydrate'));
  const components = { ...common, PROMOTE: '0', CATALOG_ENDPOINT: 'https://invalid.invalid', CATALOG_PROMOTION_KEY: 'unused-promote-zero' };
  assert.equal(gate(components, readPolicy(), controllerDigest(), 'components').model, MODEL);
  assert.throws(() => gate({ ...components, PROMOTE: '1' }, readPolicy(), controllerDigest(), 'components'));
  assert.throws(() => gate({ ...components, COMPONENT_R2_REMOTE: 'weatherx:weatherx-components-production' }, readPolicy(), controllerDigest(), 'components'));
});

test('source verification requires the exact clean commit and every pinned byte', t => {
  const f = fixture(t);
  const source = resolve(f.root, 'source');
  mkdirSync(resolve(source, 'data'), { recursive: true });
  writeFileSync(resolve(source, 'data/fetch.py'), 'reviewed\n');
  execFileSync('git', ['init', '-q'], { cwd: source });
  execFileSync('git', ['add', '.'], { cwd: source });
  execFileSync('git', ['-c', 'user.name=WeatherX Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: source });
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
  const policy = { sourceSha, sourceClosure: { 'data/fetch.py': hash(Buffer.from('reviewed\n')) } };
  assert.equal(verifySource(source, policy).files.length, 1);
  writeFileSync(resolve(source, 'data/fetch.py'), 'changed\n');
  assert.throws(() => verifySource(source, policy));
});

test('isolated Python wrapper restores only the reviewed Atmos data import root', t => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'weatherx-wind100-python-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'data'), { recursive: true });
  writeFileSync(resolve(root, 'data/hrrr_point.py'), 'VALUE = "local-reviewed-helper"\n');
  writeFileSync(resolve(root, 'data/json.py'), 'raise RuntimeError("unreviewed sibling executed")\n');
  writeFileSync(resolve(root, 'data/build_point_series.py'),
    'import argparse, hrrr_point, json\np=argparse.ArgumentParser();p.parse_args();print(hrrr_point.VALUE, json.dumps("stdlib"))\n');
  const wrapper = fileURLToPath(new URL('../tools/staging-wind100-python.py', import.meta.url));
  assert.equal(execFileSync('python3', ['-I', wrapper, root, 'data/build_point_series.py'], { encoding: 'utf8' }).trim(),
    'local-reviewed-helper "stdlib"');
  assert.throws(() => execFileSync('python3', ['-I', wrapper, root, 'data/unreviewed.py'], { stdio: 'pipe' }));

  const allowed = resolve(root, 'data/build_point_series.py');
  const replacement = resolve(root, 'data/replacement.py');
  rmSync(allowed);
  writeFileSync(replacement, 'print("must not execute")\n');
  symlinkSync('replacement.py', allowed);
  assert.throws(() => execFileSync('python3', ['-I', wrapper, root, 'data/build_point_series.py'], { stdio: 'pipe' }),
    /invalid Atmos entry point/);
  rmSync(allowed);
  linkSync(replacement, allowed);
  assert.throws(() => execFileSync('python3', ['-I', wrapper, root, 'data/build_point_series.py'], { stdio: 'pipe' }),
    /invalid Atmos entry point/);
});

test('qualification decodes every actual WXPS byte and binds its complete inventory', async t => {
  const f = fixture(t), trace = createQualificationTrace();
  f.trace = trace;
  const receipt = await qualifyPointPacks(f);
  assert.equal(receipt.status, 'CREDENTIAL_FREE_POINT_PACK_INTEGRITY_QUALIFIED_NOT_PUBLISHED');
  assert.equal(receipt.runId, '2026091012');
  assert.equal(receipt.pointPacks.objectCount, 4);
  assert.equal(receipt.pointPacks.cellCount, 6);
  assert.match(receipt.pointPacks.inventorySha256, /^[a-f0-9]{64}$/);
  assert.match(receipt.pointPacks.catalogSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.pointPacks.allFieldsExactlyMatchSourceStage, true);
  assert.deepEqual(receipt.native100m.perLead.map(row => [row.leadHour, row.jointPresentCells, row.oneSidedMissingCells]), [
    [0, 6, 0], [3, 6, 0],
  ]);
  assert.deepEqual(receipt.native100m.perLead.map(row => [row.uMinRaw, row.uMaxRaw, row.vMinRaw, row.vMaxRaw]), [
    [60, 60, 80, 80], [61, 61, 81, 81],
  ]);
  assert.equal(receipt.native100m.minimumJointCoveragePermille, 1000);
  assert.equal(receipt.credentialFreeIntegrityQualification, true);
  assert.equal(receipt.decodedProviderSemanticsVerified, true);
  assert.equal(receipt.scientificRangePolicyApproved, false);
  assert.equal(receipt.dependencyClosureApproved, true);
  assert.equal(receipt.stagingCatalogPrepared, false);
  assert.equal(receipt.sharedReadCanaryActivated, false);
  assert.equal(receipt.productionWritten, false);
  assert.equal(receipt.sourceClosure.files, 1);
  assert.equal(receipt.sourceStage.objectCount, FIELDS.length + 1);
  assert.match(receipt.sourceStage.inventorySha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(trace, { phase: 'receipt', pointPackRowsChecked: 2, pointPacksChecked: 4 });
});

test('recurring qualification uses only the authenticated point input and ignores a frozen staging map', async t => {
  const f = recurringFixture(t), trace = createQualificationTrace();
  f.trace = trace;
  const receipt = await qualifyPointPacks(f);
  assert.equal(receipt.publicationMode, 'point-only-recurring-v1');
  assert.equal(receipt.authenticatedCorePointInput, true);
  assert.equal(receipt.existingMapAndPointScienceGatesPassed, false);
  assert.equal(receipt.map, undefined);
  assert.equal(receipt.inputSha256, f.request.inputSha256);
  assert.equal(receipt.sealedArtifact.outputInventorySha256, f.augmentationReceipt.outputInventorySha256);
  assert.deepEqual(trace, { phase: 'receipt', pointPackRowsChecked: 2, pointPacksChecked: 4 });
  f.augmentationReceipt.inputInventorySha256 = '0'.repeat(64);
  await assert.rejects(qualifyPointPacks(f), /input inventory differs/);
});

test('map inventory admits the exact two-native-run shape and no unreferenced filesystem entries', async t => {
  const preserveParent = process.env.WIND100_PRESERVE_MAP_FIXTURE_PARENT;
  const parent = preserveParent ? realpathSync(preserveParent) : tmpdir();
  const root = realpathSync(mkdtempSync(resolve(parent, 'weatherx-wind100-map-realistic-')));
  if (!preserveParent) t.after(() => rmSync(root, { recursive: true, force: true }));
  writeMapTree(root, { frames: 81, realistic: true });
  const result = await qualifyMapInventory(root,
    { runs: 2, variables: 16, frames: 81 }, { initializedAt: mapRunTime('2026091012') }, { leadCount: 81 });
  assert.equal(result.objectCount, 10_535);
  assert.equal(result.directoryCount, 1_183);
  assert.equal(result.traversalEntryCount, 11_718);
  assert.equal(result.inventory.length, 10_535);
  assert.match(result.inventorySha256, /^[a-f0-9]{64}$/);
  if (preserveParent) {
    const receiptPath = `${root}-qualification.json`;
    writeFileSync(receiptPath, encode(result));
    process.stdout.write(`# preserved-map-fixture ${root}\n# preserved-map-receipt ${receiptPath}\n`);
  }
});

test('map inventory accepts an older non-native run and matches publisher depth-first locale order', async t => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'weatherx-wind100-map-retained-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeMapTree(root);
  const result = await qualifyMapInventory(root,
    { runs: 2, variables: 6, frames: 2 }, { initializedAt: mapRunTime('2026091012') }, { leadCount: 2 });
  const publisher = publisherInventory(root);
  assert.deepEqual(result.inventory, publisher);
  assert.equal(result.inventorySha256, inventoryHash(publisher));
  assert.equal(new Set(result.inventory.map(row => row.path)).size, result.objectCount);
  const newestPrefix = 'runs/2026091012/';
  const olderPrefix = 'runs/2026091000/';
  assert.ok(result.inventory.some(row => row.path.startsWith(`${newestPrefix}wind-native-`)));
  assert.ok(!result.inventory.some(row => row.path.startsWith(olderPrefix) && row.path.includes('-native-')));
  const wind = result.inventory.findIndex(row => row.path === `${newestPrefix}wind/000.png`);
  const windLow = result.inventory.findIndex(row => row.path === `${newestPrefix}wind-low/000.png`);
  assert.ok(wind >= 0 && windLow >= 0 && wind < windLow, 'publisher visits wind before wind-low');
  const globalPaths = result.inventory.map(row => row.path).toSorted();
  assert.ok(globalPaths.indexOf(`${newestPrefix}wind-low/000.png`) < globalPaths.indexOf(`${newestPrefix}wind/000.png`),
    'fixture must distinguish publisher order from a global codepoint sort');
  assert.notEqual(inventoryHash(result.inventory), inventoryHash(result.inventory.toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
});

test('map inventory rejects orphan files, empty directories, links, deep paths and unsafe references', async t => {
  const args = [{ runs: 2, variables: 6, frames: 2 }, { initializedAt: mapRunTime('2026091012') }, { leadCount: 2 }];
  for (const mode of ['missing', 'missing-native', 'file', 'empty-directory', 'symlink', 'hardlink', 'deep-directory',
    'empty', 'oversized', 'oversized-root-index', 'oversized-manifest', 'oversized-native-index',
    'traversal-template', 'traversal-run', 'unknown-native']) await t.test(mode, async t => {
    const root = realpathSync(mkdtempSync(resolve(tmpdir(), `weatherx-wind100-map-${mode}-`)));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeMapTree(root);
    if (mode === 'missing') rmSync(resolve(root, 'runs/2026091012/temp/000.png'));
    if (mode === 'missing-native') {
      const manifest = JSON.parse(readFileSync(resolve(root, 'runs/2026091012/manifest.json')));
      const native = manifest.variables.wind.nativeViewport.index.replace('{i}', '000');
      rmSync(resolve(root, 'runs/2026091012', dirname(native), 'row-00.wxb'));
    }
    if (mode === 'file') writeMapFile(root, 'runs/2026091012/unreferenced.bin');
    if (mode === 'empty-directory') mkdirSync(resolve(root, 'runs/2026091012/orphan'), { recursive: true });
    if (mode === 'symlink') symlinkSync('manifest.json', resolve(root, 'runs/2026091012/orphan-link'));
    if (mode === 'hardlink') linkSync(resolve(root, 'runs/2026091012/manifest.json'), resolve(root, 'runs/2026091012/orphan-hardlink'));
    if (mode === 'deep-directory') mkdirSync(resolve(root, 'a/b/c/d/e/f/g/h/i'), { recursive: true });
    if (mode === 'empty') truncateSync(resolve(root, 'runs/2026091012/wind/000.png'), 0);
    if (mode === 'oversized') truncateSync(resolve(root, 'runs/2026091012/wind/000.png'), 512 * 1024 * 1024 + 1);
    if (mode === 'oversized-root-index') truncateSync(resolve(root, 'index.json'), 512 * 1024 + 1);
    if (mode === 'oversized-manifest') truncateSync(resolve(root, 'runs/2026091012/manifest.json'), 512 * 1024 + 1);
    if (mode === 'oversized-native-index') {
      const manifest = JSON.parse(readFileSync(resolve(root, 'runs/2026091012/manifest.json')));
      const native = manifest.variables.wind.nativeViewport.index.replace('{i}', '000');
      truncateSync(resolve(root, 'runs/2026091012', native), 96 * 1024 + 1);
    }
    if (mode === 'traversal-template') {
      const path = resolve(root, 'runs/2026091012/manifest.json');
      const manifest = JSON.parse(readFileSync(path));
      manifest.variables.temp.file = '../escape/{i}.png';
      writeFileSync(path, encode(manifest));
    }
    if (mode === 'traversal-run') {
      const path = resolve(root, 'index.json');
      const index = JSON.parse(readFileSync(path));
      index.runs[0].path = 'runs/../2026091012/';
      writeFileSync(path, encode(index));
    }
    if (mode === 'unknown-native') {
      const path = resolve(root, 'runs/2026091012/manifest.json');
      const manifest = JSON.parse(readFileSync(path));
      manifest.variables.wind.nativeViewport.representation = 'unreviewed-native-v2';
      writeFileSync(path, encode(manifest));
    }
    await assert.rejects(qualifyMapInventory(root, ...args));
  });
});

test('qualification failure diagnostics expose only fixed categories, phases and bounded progress', () => {
  const secret = 'PRIVATE_ARRAY_PATH_TOKEN';
  const controllerSha256 = 'a'.repeat(64);
  const assertion = new Error(secret); assertion.code = 'ERR_ASSERTION'; assertion.actual = [secret];
  const filesystem = new Error(secret); filesystem.code = 'ENOENT'; filesystem.path = secret;
  const decode = new Error(secret); decode.code = 'Z_DATA_ERROR';
  for (const [error, category] of [
    [assertion, 'contract'], [new SyntaxError(secret), 'parse'], [filesystem, 'filesystem'],
    [decode, 'decode'], [{ message: secret, stack: secret }, 'unexpected'],
  ]) {
    const diagnostic = qualificationFailureDiagnostic(error,
      { phase: 'pack-scan', pointPackRowsChecked: 2, pointPacksChecked: 181, secret }, controllerSha256);
    assert.deepEqual(diagnostic, { schemaVersion: 1, operation: 'qualify', phase: 'pack-scan', category,
      controller: 'tools/staging-wind100.mjs', controllerSha256, controllerLine: null, controllerColumn: null,
      pointPackRowsChecked: 2, pointPacksChecked: 181 });
    assert.deepEqual(Object.keys(diagnostic).sort(),
      ['category', 'controller', 'controllerColumn', 'controllerLine', 'controllerSha256', 'operation', 'phase',
        'pointPackRowsChecked', 'pointPacksChecked', 'schemaVersion'].sort());
    assert.ok(!JSON.stringify(diagnostic).includes(secret));
  }
  assert.deepEqual(qualificationFailureDiagnostic(new Error(secret),
    { phase: secret, pointPackRowsChecked: -1, pointPacksChecked: 10001 }, secret),
  { schemaVersion: 1, operation: 'qualify', phase: 'unknown', category: 'unexpected',
    controller: 'tools/staging-wind100.mjs', controllerSha256: null, controllerLine: null, controllerColumn: null,
    pointPackRowsChecked: 0, pointPacksChecked: 0 });

  let internalError;
  try { gate({}, readPolicy(), controllerDigest()); } catch (error) { internalError = error; }
  const internal = qualificationFailureDiagnostic(internalError, createQualificationTrace(), controllerSha256);
  assert.equal(internal.controller, 'tools/staging-wind100.mjs');
  assert.equal(internal.controllerSha256, controllerSha256);
  assert.ok(Number.isSafeInteger(internal.controllerLine) && internal.controllerLine > 0 && internal.controllerLine <= 10_000);
  assert.ok(Number.isSafeInteger(internal.controllerColumn) && internal.controllerColumn > 0 && internal.controllerColumn <= 10_000);

  const largeAssertion = new Error(secret);
  largeAssertion.code = 'ERR_ASSERTION';
  largeAssertion.stack = `AssertionError: ${secret.repeat(10_000)}\n${String(internalError.stack).split('\n').slice(1).join('\n')}`;
  const largeDiagnostic = qualificationFailureDiagnostic(largeAssertion, createQualificationTrace(), controllerSha256);
  assert.equal(largeDiagnostic.controllerLine, internal.controllerLine);
  assert.equal(largeDiagnostic.controllerColumn, internal.controllerColumn);
  assert.ok(!JSON.stringify(largeDiagnostic).includes(secret));

  const hostile = {};
  Object.defineProperties(hostile, {
    code: { get() { throw new Error(secret); } },
    stack: { get() { throw new Error(secret); } },
  });
  const hostileDiagnostic = qualificationFailureDiagnostic(hostile, createQualificationTrace(), controllerSha256);
  assert.equal(hostileDiagnostic.category, 'unexpected');
  assert.equal(hostileDiagnostic.controllerLine, null);
  assert.equal(hostileDiagnostic.controllerColumn, null);
  assert.ok(!JSON.stringify(hostileDiagnostic).includes(secret));

  const foreign = new Error(secret);
  foreign.stack = `Error: ${secret}\n    at qualify (file:///private/${secret}/tools/staging-wind100.mjs:123:9)`;
  const foreignDiagnostic = qualificationFailureDiagnostic(foreign, createQualificationTrace(), controllerSha256);
  assert.equal(foreignDiagnostic.controllerLine, null);
  assert.equal(foreignDiagnostic.controllerColumn, null);
  assert.ok(!JSON.stringify(foreignDiagnostic).includes(secret));

  const oversizedCoordinate = new Error(secret);
  oversizedCoordinate.stack = `Error: ${secret}\n    at gate (${new URL('../tools/staging-wind100.mjs', import.meta.url).href}:10001:1)`;
  const oversizedDiagnostic = qualificationFailureDiagnostic(oversizedCoordinate, createQualificationTrace(), controllerSha256);
  assert.equal(oversizedDiagnostic.controllerLine, null);
  assert.equal(oversizedDiagnostic.controllerColumn, null);
});

test('qualify CLI emits one sanitized controller diagnostic before its generic refusal', () => {
  const secret = 'CLI_PRIVATE_TOKEN';
  const tool = resolve(dirname(fileURLToPath(import.meta.url)), '../tools/staging-wind100.mjs');
  assert.throws(() => execFileSync(process.execPath, [tool, 'qualify'], {
    cwd: resolve(dirname(tool), '..'), env: { PATH: process.env.PATH, DIAGNOSTIC_SECRET: secret }, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }), error => {
    const stderr = String(error.stderr);
    const lines = stderr.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Staging wind100 diagnostic \{.*\}$/);
    const diagnostic = JSON.parse(lines[0].slice('Staging wind100 diagnostic '.length));
    assert.equal(diagnostic.operation, 'qualify');
    assert.equal(diagnostic.phase, 'gate');
    assert.equal(diagnostic.category, 'contract');
    assert.equal(diagnostic.controller, 'tools/staging-wind100.mjs');
    assert.equal(diagnostic.controllerSha256, null);
    assert.ok(Number.isSafeInteger(diagnostic.controllerLine)
      && diagnostic.controllerLine > 0 && diagnostic.controllerLine <= 10_000);
    assert.ok(Number.isSafeInteger(diagnostic.controllerColumn)
      && diagnostic.controllerColumn > 0 && diagnostic.controllerColumn <= 10_000);
    assert.equal(lines[1], 'Staging wind100 refused; no serving pointer or production object changed.');
    assert.ok(!stderr.includes(secret));
    assert.ok(!stderr.includes('/private/'));
    return true;
  });
});

test('publish diagnostics expose only an exact bounded phase and controller coordinate', () => {
  const secret = 'PUBLISH_PRIVATE_TOKEN';
  let internalError;
  try { gate({}, readPolicy(), controllerDigest()); } catch (error) { internalError = error; }
  const diagnostic = publicationFailureDiagnostic(internalError, { phase: 'map-component', secret }, 'a'.repeat(64));
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    'category', 'controller', 'controllerColumn', 'controllerLine', 'controllerSha256',
    'operation', 'phase', 'schemaVersion',
  ].sort());
  assert.equal(diagnostic.operation, 'publish'); assert.equal(diagnostic.phase, 'map-component');
  assert.equal(diagnostic.category, 'contract'); assert.equal(diagnostic.controllerSha256, 'a'.repeat(64));
  assert.ok(Number.isSafeInteger(diagnostic.controllerLine) && diagnostic.controllerLine > 0);
  assert.ok(Number.isSafeInteger(diagnostic.controllerColumn) && diagnostic.controllerColumn > 0);
  assert.ok(!JSON.stringify(diagnostic).includes(secret));
  assert.equal(publicationFailureDiagnostic({ message: secret, stack: secret }, { phase: secret }, secret).phase, 'unknown');
});

test('publish CLI emits one sanitized phase diagnostic before its generic refusal', () => {
  const secret = 'PUBLISH_CLI_PRIVATE_TOKEN';
  const tool = resolve(dirname(fileURLToPath(import.meta.url)), '../tools/staging-wind100.mjs');
  assert.throws(() => execFileSync(process.execPath, [tool, 'publish'], {
    cwd: resolve(dirname(tool), '..'), env: { PATH: process.env.PATH, DIAGNOSTIC_SECRET: secret }, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }), error => {
    const stderr = String(error.stderr), lines = stderr.trim().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Staging wind100 diagnostic \{.*\}$/);
    const diagnostic = JSON.parse(lines[0].slice('Staging wind100 diagnostic '.length));
    assert.equal(diagnostic.operation, 'publish'); assert.equal(diagnostic.phase, 'gate');
    assert.equal(diagnostic.category, 'contract'); assert.equal(diagnostic.controllerSha256, null);
    assert.equal(lines[1], 'Staging wind100 refused; no serving pointer or production object changed.');
    assert.ok(!stderr.includes(secret)); assert.ok(!stderr.includes('/private/'));
    return true;
  });
});

test('one finite cell cannot satisfy the per-lead native coverage contract', async t => {
  const f = fixture(t, ({ field, chunkX, chunkY, cell, value }) => {
    if ((field === 'wind100_u' || field === 'wind100_v') && !(chunkX === 0 && chunkY === 0 && cell === 0)) return MISSING;
    return value;
  });
  await assert.rejects(qualifyPointPacks(f), /joint native 100m coverage/);
});

test('one-sided U\/V missing values never qualify', async t => {
  const trace = createQualificationTrace();
  const f = fixture(t, ({ field, chunkX, chunkY, cell, lead, value }) =>
    field === 'wind100_v' && chunkX === 0 && chunkY === 0 && cell === 0 && lead === 1 ? MISSING : value);
  f.trace = trace;
  await assert.rejects(qualifyPointPacks(f), /one-sided native 100m missing value/);
  assert.deepEqual(trace, { phase: 'coverage', pointPackRowsChecked: 2, pointPacksChecked: 4 });
});

test('every expected lead must independently meet coverage', async t => {
  const f = fixture(t, ({ field, lead, value }) =>
    (field === 'wind100_u' || field === 'wind100_v') && lead === 1 ? MISSING : value);
  await assert.rejects(qualifyPointPacks(f), /lead 3.*joint native 100m coverage/);
});

test('missing, extra, malformed or report-unbound packs never qualify', async t => {
  for (const mode of ['missing', 'extra', 'header', 'bytes', 'report']) {
    await t.test(mode, async t => {
      const f = fixture(t);
      const pack = resolve(f.pointRoot, `v2/ecmwf/${f.descriptor.runId}/chunks/0/0.bin.gz`);
      if (mode === 'missing') rmSync(pack);
      if (mode === 'extra') {
        const extra = resolve(f.pointRoot, `v2/ecmwf/${f.descriptor.runId}/chunks/9/9.bin.gz`);
        mkdirSync(dirname(extra), { recursive: true });
        writeFileSync(extra, readFileSync(pack));
      }
      if (mode === 'header') writePack(pack, { chunkX: 1, chunkY: 0, width: 2, height: 1 });
      if (mode === 'bytes') {
        const bytes = readFileSync(pack);
        bytes[bytes.length - 1] ^= 1;
        writeFileSync(pack, bytes);
      }
      if (mode === 'report') f.structuralReport.manifestSha256 = 'f'.repeat(64);
      await assert.rejects(qualifyPointPacks(f));
    });
  }
});

test('oversized sparse inputs are rejected before they can be read into memory', async t => {
  for (const [kind, limit, message] of [
    ['pack', 512 * 1024, /WXPS pack is empty or oversized/],
    ['catalog', 512 * 1024, /point catalog is empty or oversized/],
    ['meta', 64 * 1024, /source-stage metadata is empty or oversized/],
  ]) {
    await t.test(kind, async t => {
      const f = fixture(t);
      const path = kind === 'pack'
        ? resolve(f.pointRoot, `v2/ecmwf/${f.descriptor.runId}/chunks/0/0.bin.gz`)
        : kind === 'catalog' ? f.catalogPath : resolve(f.stageRoot, 'meta.json');
      truncateSync(path, limit + 1);
      await assert.rejects(qualifyPointPacks(f), message);
    });
  }
});

test('WXPS U/V values must exactly equal their source-stage cells', async t => {
  const f = fixture(t);
  const pack = resolve(f.pointRoot, `v2/ecmwf/${f.descriptor.runId}/chunks/0/0.bin.gz`);
  writePack(pack, {
    chunkX: 0, chunkY: 0, width: 2, height: 1,
    mutate: ({ field, cell, lead, value }) => field === 'wind100_u' && cell === 1 && lead === 1 ? value + 1 : value,
  });
  const bytes = readFileSync(pack);
  const object = f.structuralReport.objects.find(value => value.path.endsWith('/chunks/0/0.bin.gz'));
  object.bytes = bytes.length;
  object.sha256 = hash(bytes);
  f.structuralReport.manifestSha256 = inventoryHash(f.structuralReport.objects);
  await assert.rejects(qualifyPointPacks(f), /differs from source stage/);
});

test('WXPS surface values must exactly equal their source-stage cells', async t => {
  const f = fixture(t);
  const pack = resolve(f.pointRoot, `v2/ecmwf/${f.descriptor.runId}/chunks/0/0.bin.gz`);
  writePack(pack, {
    chunkX: 0, chunkY: 0, width: 2, height: 1,
    mutate: ({ field, cell, lead, value }) => field === 'temperature' && cell === 1 && lead === 1 ? value + 1 : value,
  });
  const bytes = readFileSync(pack);
  const object = f.structuralReport.objects.find(value => value.path.endsWith('/chunks/0/0.bin.gz'));
  object.bytes = bytes.length;
  object.sha256 = hash(bytes);
  f.structuralReport.manifestSha256 = inventoryHash(f.structuralReport.objects);
  await assert.rejects(qualifyPointPacks(f), /packed temperature differs from source stage/);
});

test('descriptor must expose native 100m semantics and exact storage', async t => {
  for (const mode of ['variable', 'field', 'scale', 'leads', 'freshness', 'semantics']) {
    await t.test(mode, async t => {
      const f = fixture(t);
      if (mode === 'variable') delete f.catalog.models.ecmwf.variables.wind_speed_100m;
      if (mode === 'field') f.catalog.models.ecmwf.storage.fields.pop();
      if (mode === 'scale') f.catalog.models.ecmwf.storage.fields.at(-1).scaleInv = 10;
      if (mode === 'leads') f.catalog.models.ecmwf.storage.leadHours = [0, 6];
      if (mode === 'freshness') f.catalog.models.ecmwf.freshUntil = '2026-09-11T17:59:59.000Z';
      if (mode === 'semantics') f.catalog.models.ecmwf.fieldSemantics.fields.wind100_u.level = 10;
      writeFileSync(f.catalogPath, encode(f.catalog));
      await assert.rejects(qualifyPointPacks(f));
    });
  }
});

async function publicationFixture(t) {
  const f = fixture(t), qualification = await qualifyPointPacks(f);
  qualification.invocation = '1234-1';
  const request = { model: MODEL, sourceSha: f.policy.sourceSha, invocation: '1234-1' };
  const rows = {};
  for (const id of [MODEL, `point-${MODEL}`]) {
    const artifactId = `stage-wind100-${id}-1234-1`, rootPrefix = `components/${id}/${artifactId}/`;
    const pointInventory = qualification.pointPacks.inventory.map(row => ({
      path: row.path.slice(`v2/${MODEL}/`.length), size: row.bytes, sha256: row.sha256,
    }));
    const expected = id === MODEL ? qualification.map : { objectCount: pointInventory.length, inventorySha256: inventoryHash(pointInventory) };
    const manifest = { schemaVersion: 1, componentId: id, artifactId,
      generationTime: qualification.initializedAt, completedAt: '2026-09-10T13:05:00.000Z', rootPrefix,
      mounts: [id === MODEL ? `data/${MODEL}/` : `point-series/v2/${MODEL}/`], objectCount: expected.objectCount,
      inventorySha256: expected.inventorySha256, quality: { status: 'passed', checks: id === MODEL
        ? ['manifest', 'inventory', 'remote_bytes', 'coverage', 'freshness', 'live_superset', 'horizon', 'cadence', 'grid', 'referenced_bytes', 'native_viewport']
        : ['manifest', 'inventory', 'remote_bytes', 'point_series'] },
      ...(id === MODEL ? {} : { pointSeries: { schemaVersion: 1, modelId: MODEL, descriptor: qualification.pointPacks.descriptor } }) };
    const body = Buffer.from(`${JSON.stringify(manifest)}\n`), manifestSha256 = hash(body), manifestKey = `${rootPrefix}component.json`;
    rows[id] = { body, receipt: { manifestKey, manifestSha256, expectedPreviousManifestSha256: null, expectedRollbackEpoch: 0 } };
  }
  const saved = new Map(Object.values(rows).map(row => [row.receipt.manifestKey, { body: row.body, sha256: hash(row.body), metadata: {},
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable', contentEncoding: undefined } }]));
  const writes = [];
  const io = { get: async (bucket, key) => { assert.equal(bucket, COMPONENTS); return saved.get(key) ?? null; },
    immutable: async (bucket, key, body, metadata) => { assert.equal(bucket, DATA); writes.push({ key, body, metadata }); } };
  return { f, qualification, request, rows, io, writes, saved };
}

function setPublicationMapCount(fixture, objectCount) {
  const inventorySha256 = hash(Buffer.from(`map-${objectCount}`));
  fixture.qualification.map.objectCount = objectCount;
  fixture.qualification.map.inventorySha256 = inventorySha256;
  const manifest = JSON.parse(fixture.rows[MODEL].body);
  manifest.objectCount = objectCount;
  manifest.inventorySha256 = inventorySha256;
  const body = Buffer.from(`${JSON.stringify(manifest)}\n`);
  fixture.rows[MODEL].body = body;
  fixture.rows[MODEL].receipt.manifestSha256 = hash(body);
  fixture.saved.set(fixture.rows[MODEL].receipt.manifestKey, { body, sha256: hash(body), metadata: {},
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable', contentEncoding: undefined } });
}

test('qualified pair prepares only an immutable non-serving staging selection', async t => {
  const f = await publicationFixture(t);
  const selection = await prepareCandidate({ request: f.request, qualification: f.qualification,
    mapReceipt: f.rows[MODEL].receipt, pointReceipt: f.rows[`point-${MODEL}`].receipt,
    io: f.io, policy: f.f.policy, now: () => Date.parse('2026-09-10T13:10:00Z') });
  assert.equal(selection.status, 'DATA_QUALIFIED_NOT_ACTIVATED');
  assert.equal(selection.activated, false); assert.equal(selection.sharedReadPinChanged, false);
  assert.deepEqual(f.writes.map(row => row.key), [
    'catalogs/snapshots/stage-wind100-1234-1.json',
    'staging-candidates/wind100/stage-wind100-1234-1/selection.json',
  ]);
  assert.ok(f.writes.every(row => row.metadata.sha256 === hash(row.body)));
});

test('recurring publication writes an exact point-only catalog and hash-bound publication mode', async t => {
  const f = await publicationFixture(t);
  f.request.publicationMode = 'point-only-recurring-v1';
  f.qualification.publicationMode = 'point-only-recurring-v1';
  f.qualification.authenticatedCorePointInput = true;
  f.qualification.existingMapAndPointScienceGatesPassed = false;
  delete f.qualification.map;
  const descriptor = f.qualification.pointPacks.descriptor;
  descriptor.source = 'ECMWF IFS 0.25 degree direct open-data GRIB';
  const point = JSON.parse(f.rows[`point-${MODEL}`].body);
  const oldManifestKey = f.rows[`point-${MODEL}`].receipt.manifestKey;
  point.artifactId = 'stage-wind100-recurring-point-ecmwf-1234-1';
  point.rootPrefix = `components/point-${MODEL}/${point.artifactId}/`;
  point.pointSeries.descriptor = descriptor;
  const pointBody = encode(point);
  f.rows[`point-${MODEL}`].body = pointBody;
  f.rows[`point-${MODEL}`].receipt.manifestKey = `${point.rootPrefix}component.json`;
  f.rows[`point-${MODEL}`].receipt.manifestSha256 = hash(pointBody);
  f.saved.delete(oldManifestKey);
  f.saved.set(f.rows[`point-${MODEL}`].receipt.manifestKey, { body: pointBody, sha256: hash(pointBody), metadata: {},
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable', contentEncoding: undefined } });
  const selection = await prepareCandidate({ request: f.request, qualification: f.qualification,
    mapReceipt: null, pointReceipt: f.rows[`point-${MODEL}`].receipt,
    io: f.io, policy: f.f.policy, now: () => Date.parse('2026-09-10T13:10:00Z') });
  assert.equal(selection.publicationMode, 'point-only-recurring-v1');
  assert.deepEqual(Object.keys(JSON.parse(f.writes[0].body).components), [`point-${MODEL}`]);
  assert.deepEqual(f.writes.map(row => row.key), [
    'catalogs/snapshots/stage-wind100-recurring-1234-1.json',
    'staging-candidates/wind100/stage-wind100-recurring-1234-1/selection.json',
  ]);
});

test('recurring prefix capacity counts existing and planned immutable component objects', async t => {
  const f = recurringFixture(t);
  const qualification = await qualifyPointPacks(f);
  const pointRoot = resolve(f.pointRoot, 'v2/ecmwf');
  const inventory = count => Array.from({ length: count }, (_, index) =>
    `components/point-ecmwf/stage-wind100-recurring-point-ecmwf-${index + 1}-1/run/file-${index}.bin`);
  assert.deepEqual(recurringPrefixCapacity([], qualification, pointRoot, f.policy),
    { existingObjects: 0, plannedObjects: 5, maximumObjects: 50_000 });
  assert.equal(recurringPrefixCapacity(inventory(49_995), qualification, pointRoot, f.policy).existingObjects, 49_995);
  assert.throws(() => recurringPrefixCapacity(inventory(49_996), qualification, pointRoot, f.policy),
    /lacks capacity/);
  assert.throws(() => recurringPrefixCapacity(['components/point-ecmwf/stage-wind100-point-ecmwf-1-1/file'],
    qualification, pointRoot, f.policy), /unexpected key/);
});

test('recurring prefix inventory is exact, paginated, bounded and staging-only', async () => {
  class ListObjectsV2Command { constructor(input) { this.input = input; } }
  const commands = [];
  let injectedDestroyed = 0;
  const client = { destroy: () => { injectedDestroyed++; }, send: async command => {
    commands.push(command.input);
    if (!command.input.ContinuationToken) return { IsTruncated: true, NextContinuationToken: 'page-2',
      Contents: [{ Key: 'components/point-ecmwf/stage-wind100-recurring-point-ecmwf-1-1/a.bin' }] };
    return { IsTruncated: false,
      Contents: [{ Key: 'components/point-ecmwf/stage-wind100-recurring-point-ecmwf-2-1/b.bin' }] };
  } };
  const env = { STAGING_R2_ACCOUNT_ID: ACCOUNT, STAGING_R2_WRITE_ACCESS_KEY_ID: 'fixture-id',
    STAGING_R2_WRITE_SECRET_ACCESS_KEY: 'fixture-secret' };
  const keys = await listRecurringPrefixS3(env, client, { ListObjectsV2Command });
  assert.equal(keys.length, 2);
  assert.equal(injectedDestroyed, 0);
  assert.deepEqual(commands, [
    { Bucket: COMPONENTS, Prefix: 'components/point-ecmwf/stage-wind100-recurring-point-ecmwf-', MaxKeys: 1000 },
    { Bucket: COMPONENTS, Prefix: 'components/point-ecmwf/stage-wind100-recurring-point-ecmwf-',
      MaxKeys: 1000, ContinuationToken: 'page-2' },
  ]);
  const escaped = { send: async () => ({ IsTruncated: false,
    Contents: [{ Key: 'components/point-ecmwf/stage-wind100-point-ecmwf-1-1/a.bin' }] }) };
  await assert.rejects(listRecurringPrefixS3(env, escaped, { ListObjectsV2Command }), /escaped its prefix/);
  const missingToken = { send: async () => ({ IsTruncated: true, Contents: [] }) };
  await assert.rejects(listRecurringPrefixS3(env, missingToken, { ListObjectsV2Command }), /pagination is invalid/);
  const repeatedToken = { send: async () => ({ IsTruncated: true, NextContinuationToken: 'same', Contents: [] }) };
  await assert.rejects(listRecurringPrefixS3(env, repeatedToken, { ListObjectsV2Command }), /pagination is invalid/);
  let page = 0;
  const oversized = { send: async () => ({ IsTruncated: true, NextContinuationToken: `page-${++page}`,
    Contents: Array.from({ length: 1000 }, (_, index) => ({
      Key: `components/point-ecmwf/stage-wind100-recurring-point-ecmwf-${page}-1/file-${index}.bin`,
    })) }) };
  await assert.rejects(listRecurringPrefixS3(env, oversized, { ListObjectsV2Command }), /already exceeds/);
  let ownedDestroyed = 0;
  class S3Client {
    send() { return { IsTruncated: false, Contents: [] }; }
    destroy() { ownedDestroyed++; }
  }
  assert.deepEqual(await listRecurringPrefixS3(env, undefined, { ListObjectsV2Command, S3Client }), []);
  assert.equal(ownedDestroyed, 1);
  await assert.rejects(listRecurringPrefixS3({ ...env, STAGING_R2_ACCOUNT_ID: 'wrong' }, client,
    { ListObjectsV2Command }));
});

test('component manifests admit only the exact bounded rclone mtime metadata shape', async t => {
  for (const metadata of [{}, { mtime: '1788177600' }, { mtime: '1788177600.123456789' }]) await t.test(JSON.stringify(metadata), async t => {
    const f = await publicationFixture(t);
    for (const row of f.saved.values()) row.metadata = metadata;
    const selection = await prepareCandidate({ request: f.request, qualification: f.qualification,
      mapReceipt: f.rows[MODEL].receipt, pointReceipt: f.rows[`point-${MODEL}`].receipt,
      io: f.io, policy: f.f.policy, now: () => Date.parse('2026-09-10T13:10:00Z') });
    assert.equal(selection.status, 'DATA_QUALIFIED_NOT_ACTIVATED');
  });
  for (const metadata of [
    null, [], { Mtime: '1788177600' }, { mtime: '1788177600', extra: 'x' }, { mtime: 1788177600 },
    { mtime: 'abcdefghij' }, { mtime: '788177600' }, { mtime: '11788177600' },
    { mtime: '-1788177600' }, { mtime: '+1788177600' }, { mtime: '1.7881776e9' },
    { mtime: ' 1788177600' }, { mtime: '1788177600 ' }, { mtime: '1788177600\n' },
    { mtime: '1788177600.' }, { mtime: '1788177600.1234567890' },
  ]) await t.test(`reject ${JSON.stringify(metadata)}`, async t => {
    const f = await publicationFixture(t);
    const trace = createPublicationTrace();
    f.saved.get(f.rows[MODEL].receipt.manifestKey).metadata = metadata;
    await assert.rejects(prepareCandidate({ request: f.request, qualification: f.qualification,
      mapReceipt: f.rows[MODEL].receipt, pointReceipt: f.rows[`point-${MODEL}`].receipt,
      io: f.io, policy: f.f.policy, now: () => Date.parse('2026-09-10T13:10:00Z'), trace }));
    assert.equal(trace.phase, 'map-component');
    assert.equal(f.writes.length, 0);
  });
  await t.test('reject malformed point-component metadata at its exact phase', async () => {
    const f = await publicationFixture(t);
    const trace = createPublicationTrace();
    f.saved.get(f.rows[`point-${MODEL}`].receipt.manifestKey).metadata = { mtime: '1788177600.1234567890' };
    await assert.rejects(prepareCandidate({ request: f.request, qualification: f.qualification,
      mapReceipt: f.rows[MODEL].receipt, pointReceipt: f.rows[`point-${MODEL}`].receipt,
      io: f.io, policy: f.f.policy, now: () => Date.parse('2026-09-10T13:10:00Z'), trace }));
    assert.equal(trace.phase, 'point-component');
    assert.equal(f.writes.length, 0);
  });
});

test('S3 component read accepts publisher mtime while candidate metadata remains exact sha256', async t => {
  const f = await publicationFixture(t);
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class PutObjectCommand { constructor(input) { this.input = input; } }
  const objects = new Map(Object.entries(f.rows).map(([id, row]) => [`${COMPONENTS}/${row.receipt.manifestKey}`, {
    body: row.body, metadata: { mtime: id === MODEL ? '1788177600.123456789' : '1788177601' },
    contentType: 'application/json', cacheControl: undefined,
  }]));
  const commands = [];
  const client = { send: async command => {
    commands.push(command);
    const key = `${command.input.Bucket}/${command.input.Key}`;
    if (command instanceof PutObjectCommand) {
      objects.set(key, { body: Buffer.from(command.input.Body), metadata: command.input.Metadata,
        contentType: command.input.ContentType, cacheControl: command.input.CacheControl });
      return {};
    }
    const object = objects.get(key);
    if (!object) throw { $metadata: { httpStatusCode: 404 } };
    return { ContentLength: object.body.length, Body: Readable.from([object.body]), Metadata: object.metadata,
      ContentType: object.contentType, CacheControl: object.cacheControl };
  } };
  const io = await createCandidateS3({ STAGING_R2_ACCOUNT_ID: ACCOUNT,
    STAGING_R2_WRITE_ACCESS_KEY_ID: 'fixture-id', STAGING_R2_WRITE_SECRET_ACCESS_KEY: 'fixture-secret' },
  f.request, client, { GetObjectCommand, PutObjectCommand });
  try {
    const trace = createPublicationTrace();
    const selection = await prepareCandidate({ request: f.request, qualification: f.qualification,
      mapReceipt: f.rows[MODEL].receipt, pointReceipt: f.rows[`point-${MODEL}`].receipt,
      io, policy: f.f.policy, now: () => Date.parse('2026-09-10T13:10:00Z'), trace });
    assert.equal(selection.status, 'DATA_QUALIFIED_NOT_ACTIVATED');
    assert.equal(trace.phase, 'receipt');
  } finally { io.close(); }
  const puts = commands.filter(command => command instanceof PutObjectCommand);
  assert.equal(puts.length, 2);
  for (const command of puts) {
    assert.deepEqual(Object.keys(command.input.Metadata), ['sha256']);
    assert.equal(command.input.Metadata.sha256, hash(command.input.Body));
    assert.equal(command.input.IfNoneMatch, '*');
  }
});

test('S3 candidate readback rejects inherited rclone metadata before selection write', async t => {
  const f = await publicationFixture(t);
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class PutObjectCommand { constructor(input) { this.input = input; } }
  const objects = new Map(Object.entries(f.rows).map(([, row]) => [`${COMPONENTS}/${row.receipt.manifestKey}`, {
    body: row.body, metadata: { mtime: '1788177600' }, contentType: 'application/json', cacheControl: undefined,
  }]));
  const puts = [];
  const client = { send: async command => {
    const key = `${command.input.Bucket}/${command.input.Key}`;
    if (command instanceof PutObjectCommand) {
      puts.push(command);
      objects.set(key, { body: Buffer.from(command.input.Body),
        metadata: { ...command.input.Metadata, mtime: '1788177600' },
        contentType: command.input.ContentType, cacheControl: command.input.CacheControl });
      return {};
    }
    const object = objects.get(key);
    if (!object) throw { $metadata: { httpStatusCode: 404 } };
    return { ContentLength: object.body.length, Body: Readable.from([object.body]), Metadata: object.metadata,
      ContentType: object.contentType, CacheControl: object.cacheControl };
  } };
  const io = await createCandidateS3({ STAGING_R2_ACCOUNT_ID: ACCOUNT,
    STAGING_R2_WRITE_ACCESS_KEY_ID: 'fixture-id', STAGING_R2_WRITE_SECRET_ACCESS_KEY: 'fixture-secret' },
  f.request, client, { GetObjectCommand, PutObjectCommand });
  try {
    await assert.rejects(prepareCandidate({ request: f.request, qualification: f.qualification,
      mapReceipt: f.rows[MODEL].receipt, pointReceipt: f.rows[`point-${MODEL}`].receipt,
      io, policy: f.f.policy, now: () => Date.parse('2026-09-10T13:10:00Z') }));
  } finally { io.close(); }
  assert.equal(puts.length, 1);
  assert.match(puts[0].input.Key, /^catalogs\/snapshots\/stage-wind100-[1-9]\d*-[1-9]\d*\.json$/);
  assert.ok(puts.every(command => !command.input.Key.startsWith('staging-candidates/wind100/')));
});

test('map component receipt admits the reviewed 20k boundary and rejects one more object', async t => {
  for (const [objectCount, accepted] of [[10_535, true], [20_000, true], [20_001, false]]) await t.test(String(objectCount), async t => {
    const f = await publicationFixture(t);
    setPublicationMapCount(f, objectCount);
    const pending = prepareCandidate({ request: f.request, qualification: f.qualification,
      mapReceipt: f.rows[MODEL].receipt, pointReceipt: f.rows[`point-${MODEL}`].receipt,
      io: f.io, policy: f.f.policy, now: () => Date.parse('2026-09-10T13:10:00Z') });
    if (accepted) {
      const selection = await pending;
      assert.equal(selection.status, 'DATA_QUALIFIED_NOT_ACTIVATED');
    } else {
      await assert.rejects(pending);
      assert.equal(f.writes.length, 0);
    }
  });
});

test('the pinned reader must accept the isolated catalog before either metadata write', async t => {
  const f = await publicationFixture(t);
  await assert.rejects(prepareCandidate({ request: f.request, qualification: f.qualification,
    mapReceipt: f.rows[MODEL].receipt, pointReceipt: f.rows[`point-${MODEL}`].receipt,
    io: f.io, policy: f.f.policy, now: () => Date.parse('2026-09-10T13:10:00Z'),
    catalogValidator: () => false }), /pinned data reader rejected/);
  assert.equal(f.writes.length, 0);
});

test('publication rechecks lease after remote manifests and rejects semantic or receipt tampering', async t => {
  for (const mode of ['lease', 'descriptor', 'receipt', 'quality', 'inventory']) await t.test(mode, async t => {
    const f = await publicationFixture(t);
    if (mode === 'descriptor') f.qualification.pointPacks.descriptor.fieldSemantics.fields.wind100_v.level = 10;
    if (mode === 'receipt') f.rows[MODEL].receipt.manifestSha256 = 'e'.repeat(64);
    if (mode === 'quality' || mode === 'inventory') {
      const manifest = JSON.parse(f.rows[MODEL].body); manifest.quality.checks.pop();
      if (mode === 'inventory') {
        manifest.quality.checks.push('native_viewport');
        manifest.inventorySha256 = 'f'.repeat(64);
      }
      const body = Buffer.from(`${JSON.stringify(manifest)}\n`);
      f.rows[MODEL].receipt.manifestSha256 = hash(body);
      f.saved.set(f.rows[MODEL].receipt.manifestKey, { body, sha256: hash(body), metadata: {},
        httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=31536000, immutable', contentEncoding: undefined } });
    }
    let calls = 0;
    await assert.rejects(prepareCandidate({ request: f.request, qualification: f.qualification,
      mapReceipt: f.rows[MODEL].receipt, pointReceipt: f.rows[`point-${MODEL}`].receipt, io: f.io,
      policy: f.f.policy, now: () => mode === 'lease' && ++calls > 1
        ? Date.parse('2026-09-11T13:00:01Z') : Date.parse('2026-09-10T13:10:00Z') }));
    assert.equal(f.writes.length, 0);
  });
});

test('catalog validator loader exposes the exact TypeScript reader from a verified source root', async t => {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'weatherx-wind100-reader-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, 'platform/edge/src'), { recursive: true });
  writeFileSync(resolve(root, 'platform/edge/src/catalog.ts'),
    'export function isDataCatalog(value: unknown): boolean { return value === "reviewed-catalog"; }\n');
  const validator = await loadCatalogValidator(root);
  try {
    assert.equal(validator.validate('reviewed-catalog'), true);
    assert.equal(validator.validate('other'), false);
  } finally { validator.close(); }
});

test('S3 adapter is confined to two staging manifests and two immutable metadata keys', async () => {
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class PutObjectCommand { constructor(input) { this.input = input; } }
  const commands = [], stored = new Map();
  const client = { send: async command => { commands.push(command); const key = `${command.input.Bucket}/${command.input.Key}`;
    if (command instanceof PutObjectCommand) { stored.set(key, { body: Buffer.from(command.input.Body), metadata: command.input.Metadata }); return {}; }
    const value = stored.get(key); if (!value) throw { $metadata: { httpStatusCode: 404 } };
    return { ContentLength: value.body.length, Body: Readable.from([value.body]), Metadata: value.metadata,
      ContentType: 'application/json', CacheControl: 'public, max-age=31536000, immutable' }; } };
  const env = { ...environment(), STAGING_R2_ACCOUNT_ID: ACCOUNT,
    STAGING_R2_WRITE_ACCESS_KEY_ID: 'fixture-id', STAGING_R2_WRITE_SECRET_ACCESS_KEY: 'fixture-secret' };
  const request = gate(env, readPolicy(), controllerDigest(), 'metadata');
  const io = await createCandidateS3(env, request, client, { GetObjectCommand, PutObjectCommand });
  const body = Buffer.from('{}\n'), metadata = { sha256: hash(body) };
  await io.immutable(DATA, 'catalogs/snapshots/stage-wind100-1234-1.json', body, metadata);
  assert.equal(commands[0].input.IfNoneMatch, '*'); assert.equal(commands[0].input.Bucket, DATA);
  await assert.rejects(io.immutable('weatherx-data-production', 'catalogs/snapshots/stage-wind100-1234-1.json', body, metadata));
  await assert.rejects(io.immutable(DATA, 'catalogs/current.json', body, metadata));
  await assert.rejects(io.get(COMPONENTS, 'components/gfs/x/component.json', 10));
  const recurringRequest = { ...request, publicationMode: 'point-only-recurring-v1' };
  const recurringIo = await createCandidateS3(env, recurringRequest, client, { GetObjectCommand, PutObjectCommand });
  assert.equal(await recurringIo.get(COMPONENTS,
    'components/point-ecmwf/stage-wind100-recurring-point-ecmwf-1234-1/component.json', 10), null);
  await assert.rejects(recurringIo.get(COMPONENTS,
    'components/point-ecmwf/stage-wind100-point-ecmwf-1234-1/component.json', 10));
});

test('version check drains output under pipefail and still rejects the wrong version', () => {
  const source = readFileSync(new URL('../.github/workflows/staging-wind100.yml', import.meta.url), 'utf8');
  const command = source.split('\n').find(line => line.trim().startsWith('rclone version |'))?.trim();
  assert.ok(command, 'workflow version check absent');
  const run = version => execFileSync('bash', ['-c', `set -euo pipefail
rclone() { printf '%s\\n' "$1"; printf '%1000000s\\n' ''; }
rclone_version() { rclone '${version}'; }
${command.replace('rclone version', 'rclone_version')}`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(run('rclone v1.75.0').trim(), 'rclone v1.75.0');
  assert.throws(() => run('rclone v1.74.0'));
});

test('workflow is manual ECMWF-only, sealed, hash-locked and cannot promote or deploy', () => {
  const source = readFileSync(new URL('../.github/workflows/staging-wind100.yml', import.meta.url), 'utf8');
  const code = source.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.match(code, /workflow_dispatch:/);
  assert.doesNotMatch(code, /\n  (?:schedule|push|pull_request|workflow_run|workflow_call):/);
  assert.doesNotMatch(code, /jobs:\n  wind100:\n    if:/);
  assert.doesNotMatch(code, /options: \[ecmwf, gfs\]/);
  assert.match(code, /MODEL_ID: ecmwf/);
  assert.match(code, /--require-hashes --only-binary=:all:/);
  assert.match(code, /core_model_artifact\.py/); assert.match(code, /seal --model ecmwf/);
  assert.match(code, /CORE_MODEL_PACKS_DIR/);
  assert.match(code, /staging-wind100-core-flow\.py/);
  const hydrate = source.split('- name: Hydrate only the isolated staging ECMWF baseline')[1]
    .split('- name: Authenticate the hydrated baseline before provider collection')[0];
  const baselineProof = source.split('- name: Authenticate the hydrated baseline before provider collection')[1]
    .split('- name: Collect and seal exact ECMWF core inputs')[0];
  const collect = source.split('- name: Collect and seal exact ECMWF core inputs')[1]
    .split('- name: Reinstall sealed inputs')[0];
  const reinstall = source.split('- name: Reinstall sealed inputs')[1]
    .split('- name: Qualify every map identity')[0];
  assert.match(hydrate, /working-directory: atmos\b/);
  assert.doesNotMatch(hydrate, /working-directory: atmos-source\b/);
  assert.match(hydrate, /GITHUB_ENV=''/);
  assert.match(hydrate, /HYDRATED_COMPONENT_PROOF_DIR="\$RUNNER_TEMP\/wind100-component-baseline-proof"/);
  assert.doesNotMatch(hydrate, /source\s+|\.\s+[^\n]*baseline/);
  assert.match(baselineProof, /working-directory: atmos\b/);
  assert.match(baselineProof, /verify-component-baseline/);
  for (const proof of ['pointer.json', 'catalog.json', 'component.json']) {
    assert.match(baselineProof, new RegExp(`wind100-component-baseline-proof/${proof.replace('.', '\\.')}`));
    assert.match(reinstall, new RegExp(`wind100-component-baseline-proof/${proof.replace('.', '\\.')}`));
  }
  assert.ok(code.indexOf('verify-component-baseline') < code.indexOf('Collect and seal exact ECMWF core inputs'),
    'authenticated baseline preflight must precede provider collection');
  assert.match(baselineProof, /> "\$RUNNER_TEMP\/weatherx-wind100-baseline-proof\.json"/);
  assert.doesNotMatch(baselineProof, /secrets\.|RCLONE_|CATALOG_R2_REMOTE|STAGING_R2/);
  assert.match(collect, /working-directory: atmos-source\b/);
  assert.match(collect, /--root "\$GITHUB_WORKSPACE\/atmos-source"/);
  assert.match(reinstall, /working-directory: atmos\b/);
  assert.match(reinstall, /CORE_MODEL_PACKS_DIR/);
  assert.match(reinstall, /CORE_BASELINE_CATALOG_POINTER/);
  assert.match(reinstall, /CORE_BASELINE_CATALOG_SNAPSHOT/);
  assert.match(reinstall, /CORE_BASELINE_COMPONENT_MANIFEST/);
  assert.doesNotMatch(reinstall, /source\s+|\.\s+[^\n]*baseline/);
  assert.doesNotMatch(code, /rm\s+-r|find\s+[^\n]*-delete/);
  assert.match(code, /build_point_series\.py/);
  assert.match(code, /staging-wind100-python\.py/);
  assert.doesNotMatch(code, /python -I data\/(?:fetch|build_point_series)/);
  assert.match(code, /validate-point-series\.mjs/);
  assert.match(code, /staging-wind100\.mjs qualify/);
  assert.match(code, /PROMOTE: '0'/);
  assert.match(code, /weatherx-data-staging/);
  assert.match(code, /weatherx-components-staging/);
  assert.doesNotMatch(code, /PUBLISH:\s*['"]?1|submit-catalog-mutation|weatherx-(?:data|components)-production/);
  assert.doesNotMatch(code, /wrangler|pages|deploy|shared-read\/pin\.json|staging-shared-read|catalogs\/current|releases\/current/);
  for (const line of source.split('\n').filter(value => value.includes('uses:'))) assert.match(line, /@[a-f0-9]{40}\b/);
  const secrets = [...new Set([...source.matchAll(/secrets\.([A-Z_0-9]+)/g)].map(match => match[1]))].sort();
  assert.deepEqual(secrets, ['ATMOS_DEPLOY_KEY', 'STAGING_R2_WRITE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_SECRET_ACCESS_KEY']);
  assert.doesNotMatch(code, /\btee\b/);
  const qualify = source.split('- name: Qualify')[1].split('- name: Upload immutable')[0];
  assert.doesNotMatch(qualify, /secrets\.|RCLONE_|CATALOG_|STAGING_R2/);
});
