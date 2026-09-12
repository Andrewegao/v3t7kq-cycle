// Qualify one ECMWF native-100 candidate, publish immutable staging components,
// and prepare isolated metadata. This controller cannot mutate a serving pointer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import {
  closeSync, createReadStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  opendirSync, readFileSync, readSync, realpathSync, writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const SOURCE_SHA = '9174329db6ca8527569e67f14ef70406dedefb69';
export const CONFIRMATION = 'native-wind100-staging-only';
export const DATA = 'weatherx-data-staging';
export const COMPONENTS = 'weatherx-components-staging';
export const MODEL = 'ecmwf';
export const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
export const RECURRING_PUBLICATION_MODE = 'point-only-recurring-v1';
export const RECURRING_COMPONENT_PREFIX = 'components/point-ecmwf/stage-wind100-recurring-point-ecmwf-';
export const RECURRING_CATALOG_PREFIX = 'catalogs/snapshots/stage-wind100-recurring-';
export const RECURRING_SELECTION_PREFIX = 'staging-candidates/wind100/stage-wind100-recurring-';
const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
const WORKFLOW = `${REPOSITORY}/.github/workflows/staging-wind100.yml@refs/heads/main`;
const BAKE_WORKFLOW = `${REPOSITORY}/.github/workflows/bake.yml@refs/heads/main`;
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const RUN = /^\d{10}$/;
const MANUAL_CATALOG_ID = /^stage-wind100-[1-9]\d{0,19}-[1-9]\d{0,5}$/;
const RECURRING_CATALOG_ID = /^stage-wind100-recurring-[1-9]\d{0,19}-[1-9]\d{0,5}$/;
const RECURRING_COMPONENT_KEY = /^components\/point-ecmwf\/stage-wind100-recurring-point-ecmwf-[1-9]\d{0,19}-[1-9]\d{0,5}\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const MISSING = -32768;
const MAX_PACK_BYTES = 512 * 1024;
const MAX_UNPACKED_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_RECURRING_PREFIX_OBJECTS = 50_000;
export const POINTER_KEY = 'staging-candidates/wind100/current-v1.json';
export const MAX_POINTER_BYTES = 16 * 1024;
const POINTER_KIND = 'weatherx-staging-native-wind100-pointer';
const TARGET_ORIGIN = 'https://staging.weatherx.org';
const POINT_SOURCE = 'ECMWF IFS 0.25 degree direct open-data GRIB';
// This is the reviewed ceiling used by the pinned map catalog/reference reader.
// It bounds files, not traversal entries: every expected ancestor directory is
// derived below from the two authenticated run manifests.
const MAX_MAP_OBJECTS = 20_000;
const MAX_NATIVE_INDEX_BYTES = 96 * 1024;
const MAX_NATIVE_ROW_BYTES = 2 * 1024 * 1024;
const MAX_MAP_FILE_BYTES = 512 * 1024 * 1024;
const MAX_MAP_TOTAL_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_MAP_DEPTH = 8;
const NATIVE_REPRESENTATION = 'native-rgba128-halo-l2-t2-r3-b3-row-v1';
const NATIVE_LAYOUT = { core: 128, left: 2, top: 2, right: 3, bottom: 3, columns: 12, rows: 6 };
const NATIVE_VARIABLES = new Set(['wind', 'temp', 'gust', 'mslp', 'precip', 'cloud', 'dewpoint']);
const NATIVE_DIRECTORY = /^[a-z][a-z0-9_]{0,31}-native-[a-f0-9]{16}$/;
const CACHE = 'public, max-age=31536000, immutable';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTROLLER_FILES = [
  '.github/workflows/staging-wind100.yml',
  '.github/workflows/staging-wind100-recurring.yml',
  'tools/staging-wind100-policy.json',
  'tools/staging-wind100.mjs',
  'tools/staging-wind100-python.py',
  'tools/staging-wind100-requirements.txt',
  'tests/staging-wind100-core-flow.py',
];
const FORBIDDEN = [
  'R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY',
  'SHARED_R2_READ_ACCESS_KEY_ID', 'SHARED_R2_READ_SECRET_ACCESS_KEY',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_DATA_EDGE_API_TOKEN',
  'STAGING_WORKER_API_TOKEN', 'UI_STAGING_PAGES_TOKEN', 'UI_PRODUCTION_PAGES_TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'STAGING_R2_WRITE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_SECRET_ACCESS_KEY',
  'CATALOG_ENDPOINT', 'CATALOG_PROMOTION_KEY',
  'CATALOG_ENDPOINT_PRODUCTION', 'CATALOG_PROMOTION_KEY_PRODUCTION',
  'RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID', 'RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY',
];
const QUALIFICATION_PHASES = new Set([
  'gate', 'evidence', 'source-evidence', 'point-catalog', 'source-stage', 'pack-inventory', 'pack-scan',
  'coverage', 'structural-report', 'source-stage-inventory', 'map-proof', 'map-inventory', 'seal', 'lease', 'receipt',
]);
const PUBLICATION_PHASES = new Set([
  'gate', 'evidence', 'source-evidence', 'reader', 'transport', 'qualification',
  'map-component', 'point-component', 'pair', 'catalog-validation', 'catalog-write',
  'lease', 'selection-write', 'receipt',
]);
const CONTROLLER_LABEL = 'tools/staging-wind100.mjs';
const CONTROLLER_URL = import.meta.url;
const MAX_DIAGNOSTIC_NUMBER = 10_000;
const MAX_STACK_TAIL_CHARS = 64 * 1024;

export function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sealedPointRows(manifest) {
  assert.ok(Array.isArray(manifest?.files));
  const rows = manifest.files.filter(row => typeof row?.path === 'string'
    && row.path.startsWith('data/.ecmwf-point/'));
  assert.ok(rows.length >= 5 && rows.length <= 32, 'sealed ECMWF point-stage inventory is incomplete or oversized');
  for (const row of rows) {
    exactKeys(row, ['path', 'sha256', 'size'], 'sealed point-stage object');
    assert.match(row.path, /^data\/\.ecmwf-point\/[A-Za-z0-9._-]+$/);
    assert.match(row.sha256 ?? '', SHA); assert.ok(Number.isSafeInteger(row.size) && row.size > 0);
  }
  assert.equal(new Set(rows.map(row => row.path)).size, rows.length);
  return rows;
}

export function sealedPointInputSha(manifest) {
  return hash(JSON.stringify(sealedPointRows(manifest)));
}

function pythonInventorySha(rows) {
  return hash(JSON.stringify(rows.map(row => ({ bytes: row.bytes, path: row.path, sha256: row.sha256 }))));
}

export function validateWind100Pointer(value) {
  exactKeys(value, ['schemaVersion', 'kind', 'targetOrigin', 'updatedAt', 'entries'], 'wind100 pointer');
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, POINTER_KIND);
  assert.equal(value.targetOrigin, TARGET_ORIGIN);
  assert.ok(Number.isFinite(Date.parse(value.updatedAt)), 'wind100 pointer update time is invalid');
  assert.ok(Array.isArray(value.entries) && value.entries.length >= 1 && value.entries.length <= 2,
    'wind100 pointer must retain one or two entries');
  let previousRun = null;
  for (const entry of value.entries) {
    exactKeys(entry, ['runId', 'catalogId', 'catalogSha256', 'selectionKey', 'selectionSha256',
      'sourceSha', 'inputSha256', 'initializedAt', 'freshUntil'], 'wind100 pointer entry');
    assert.match(entry.runId ?? '', RUN);
    assert.ok(MANUAL_CATALOG_ID.test(entry.catalogId ?? '') || RECURRING_CATALOG_ID.test(entry.catalogId ?? ''),
      'wind100 pointer catalog ID is invalid');
    assert.equal(entry.selectionKey, `staging-candidates/wind100/${entry.catalogId}/selection.json`);
    assert.match(entry.catalogSha256 ?? '', SHA); assert.match(entry.selectionSha256 ?? '', SHA);
    assert.match(entry.sourceSha ?? '', COMMIT);
    assert.match(entry.inputSha256 ?? '', SHA);
    const initialized = finiteTime(entry.initializedAt, 'wind100 initialization');
    assert.equal(new Date(initialized).toISOString().replace(/[-:T]/g, '').slice(0, 10), entry.runId);
    assert.ok(finiteTime(entry.freshUntil, 'wind100 expiry') > initialized);
    if (previousRun !== null) assert.ok(previousRun > entry.runId, 'wind100 pointer entries are not newest-first');
    previousRun = entry.runId;
  }
  assert.equal(new Set(value.entries.map(entry => entry.runId)).size, value.entries.length,
    'wind100 pointer repeats a run');
  return value;
}

export function pointerEntry(selection, selectionSha256) {
  const fields = ['schemaVersion', 'kind', 'status', 'targetOrigin', 'model', 'runId', 'catalogId',
    'catalogSha256', 'sourceSha', 'inputSha256', 'invocation', 'qualificationCanonicalSha256',
    'initializedAt', 'freshUntil', 'createdAt', 'isolatedStagingCandidate', 'sharedReadPinChanged',
    'productionWritten', 'activated'];
  if (selection?.publicationMode !== undefined) fields.push('publicationMode');
  exactKeys(selection, fields, 'wind100 selection');
  assert.equal(selection.schemaVersion, 1);
  assert.equal(selection.kind, 'weatherx-staging-native-wind100-selection');
  assert.equal(selection.status, 'DATA_QUALIFIED_NOT_ACTIVATED');
  assert.equal(selection.targetOrigin, TARGET_ORIGIN); assert.equal(selection.model, MODEL);
  if (selection.publicationMode !== undefined) {
    assert.equal(selection.publicationMode, RECURRING_PUBLICATION_MODE);
    assert.match(selection.catalogId ?? '', RECURRING_CATALOG_ID);
  } else assert.match(selection.catalogId ?? '', MANUAL_CATALOG_ID);
  assert.match(selectionSha256 ?? '', SHA);
  return {
    runId: selection.runId, catalogId: selection.catalogId, catalogSha256: selection.catalogSha256,
    selectionKey: `staging-candidates/wind100/${selection.catalogId}/selection.json`, selectionSha256,
    sourceSha: selection.sourceSha, inputSha256: selection.inputSha256,
    initializedAt: selection.initializedAt, freshUntil: selection.freshUntil,
  };
}

export function nextWind100Pointer(current, entry, updatedAt) {
  if (current != null) {
    validateWind100Pointer(current);
    assert.ok(entry.runId >= current.entries[0].runId, 'Wind100 model run regressed');
    assert.ok(finiteTime(updatedAt, 'pointer update') >= finiteTime(current.updatedAt, 'prior pointer update'),
      'Wind100 pointer update time regressed');
  }
  const entries = [entry, ...(current?.entries ?? []).filter(row => row.runId !== entry.runId)]
    .sort((left, right) => right.runId.localeCompare(left.runId)).slice(0, 2);
  const value = { schemaVersion: 1, kind: POINTER_KIND, targetOrigin: TARGET_ORIGIN, updatedAt, entries };
  validateWind100Pointer(value);
  return value;
}

export function createQualificationTrace() {
  return { phase: 'gate', pointPackRowsChecked: 0, pointPacksChecked: 0 };
}

export function createPublicationTrace() {
  return { phase: 'gate' };
}

function markQualification(trace, phase, progress = {}) {
  if (!trace || !QUALIFICATION_PHASES.has(phase)) return;
  trace.phase = phase;
  for (const name of ['pointPackRowsChecked', 'pointPacksChecked']) {
    if (Number.isSafeInteger(progress[name]) && progress[name] >= 0 && progress[name] <= MAX_DIAGNOSTIC_NUMBER) {
      trace[name] = progress[name];
    }
  }
}

function markPublication(trace, phase) {
  if (trace && PUBLICATION_PHASES.has(phase)) trace.phase = phase;
}

function safeProperty(value, name) {
  try { return value?.[name]; } catch { return undefined; }
}

function qualificationCategory(error) {
  const code = safeProperty(error, 'code');
  if (code === 'ERR_ASSERTION') return 'contract';
  try { if (error instanceof SyntaxError) return 'parse'; } catch { /* fixed fallback below */ }
  if (new Set(['ENOENT', 'EACCES', 'EISDIR', 'ELOOP', 'EMFILE', 'ENFILE']).has(code)) return 'filesystem';
  if (new Set(['Z_DATA_ERROR', 'Z_BUF_ERROR', 'Z_MEM_ERROR']).has(code)) return 'decode';
  return 'unexpected';
}

function controllerCoordinate(error) {
  const stack = safeProperty(error, 'stack');
  if (typeof stack !== 'string') {
    return { controllerLine: null, controllerColumn: null };
  }
  const tail = stack.slice(-MAX_STACK_TAIL_CHARS);
  const escapedUrl = CONTROLLER_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const frame = new RegExp(`^\\s*at (?:[^()]* \\()?${escapedUrl}:(\\d+):(\\d+)\\)?\\s*$`, 'm');
  const match = frame.exec(tail);
  if (match) {
    const controllerLine = Number(match[1]), controllerColumn = Number(match[2]);
    if (Number.isSafeInteger(controllerLine) && controllerLine > 0 && controllerLine <= MAX_DIAGNOSTIC_NUMBER
      && Number.isSafeInteger(controllerColumn) && controllerColumn > 0 && controllerColumn <= MAX_DIAGNOSTIC_NUMBER) {
      return { controllerLine, controllerColumn };
    }
  }
  return { controllerLine: null, controllerColumn: null };
}

function diagnosticNumber(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DIAGNOSTIC_NUMBER ? value : 0;
}

export function qualificationFailureDiagnostic(error, trace, controllerSha256 = null) {
  const phase = safeProperty(trace, 'phase');
  return {
    schemaVersion: 1,
    operation: 'qualify',
    phase: QUALIFICATION_PHASES.has(phase) ? phase : 'unknown',
    category: qualificationCategory(error),
    controller: CONTROLLER_LABEL,
    controllerSha256: typeof controllerSha256 === 'string' && SHA.test(controllerSha256) ? controllerSha256 : null,
    ...controllerCoordinate(error),
    pointPackRowsChecked: diagnosticNumber(safeProperty(trace, 'pointPackRowsChecked')),
    pointPacksChecked: diagnosticNumber(safeProperty(trace, 'pointPacksChecked')),
  };
}

export function publicationFailureDiagnostic(error, trace, controllerSha256 = null) {
  const phase = safeProperty(trace, 'phase');
  return {
    schemaVersion: 1,
    operation: 'publish',
    phase: PUBLICATION_PHASES.has(phase) ? phase : 'unknown',
    category: qualificationCategory(error),
    controller: CONTROLLER_LABEL,
    controllerSha256: typeof controllerSha256 === 'string' && SHA.test(controllerSha256) ? controllerSha256 : null,
    ...controllerCoordinate(error),
  };
}

function policyPath() {
  return resolve(ROOT, 'tools/staging-wind100-policy.json');
}

function exactStorageFields(value) {
  assert.ok(Array.isArray(value) && value.length >= 6 && value.length <= 16);
  assert.equal(new Set(value.map(field => field?.id)).size, value.length);
  for (const field of value) {
    assert.match(field?.id ?? '', /^[a-z][a-z0-9_]{0,63}$/);
    assert.ok(Number.isSafeInteger(field.scaleInv) && field.scaleInv > 0 && field.scaleInv <= 10_000);
  }
  assert.ok(value.some(field => field.id === 'wind100_u'));
  assert.ok(value.some(field => field.id === 'wind100_v'));
  return value;
}

export function readPolicy(path = policyPath()) {
  const policy = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(policy.schemaVersion, 3);
  assert.match(policy.sourceSha ?? '', COMMIT);
  assert.equal(policy.sourceSha, SOURCE_SHA);
  assert.equal(policy.coreSourceSha, '0335a3b0a85b629c8659032a032bbc5ea0911eff');
  assert.equal(policy.recurringPublicationMode, RECURRING_PUBLICATION_MODE);
  assert.deepEqual(policy.recurringStorage, {
    componentObjectPrefix: RECURRING_COMPONENT_PREFIX,
    catalogObjectPrefix: RECURRING_CATALOG_PREFIX,
    selectionObjectPrefix: RECURRING_SELECTION_PREFIX,
    maximumComponentPrefixObjects: MAX_RECURRING_PREFIX_OBJECTS,
  });
  assert.equal(policy.model, MODEL);
  assert.deepEqual({ hours: policy.hours, leadCount: policy.leadCount, freshnessHours: policy.freshnessHours,
    minimumForecastLeaseHours: policy.minimumForecastLeaseHours, nativeCadenceSeconds: policy.nativeCadenceSeconds },
  { hours: 336, leadCount: 81, freshnessHours: 30, minimumForecastLeaseHours: 6, nativeCadenceSeconds: 10_800 });
  assert.deepEqual(policy.grid, {
    lon0: -180, lat0: 90, lonStep: 0.25, latStep: -0.25,
    width: 1440, height: 721, wrapLongitude: true,
  });
  assert.deepEqual(policy.chunk, { width: 16, height: 16 });
  exactStorageFields(policy.storageFields);
  assert.deepEqual(policy.native100m, {
    contract: 'weatherx-native-wind100-grib-v1', requiredJointCoveragePermille: 1000,
    sourceParameters: { wind100_u: '100u', wind100_v: '100v' }, sourceUnits: 'm s**-1',
    levelType: 'heightAboveGround', level: 100, stepType: 'instant', earthRelative: true,
    deliveryGrid: 'global-regular-ll-0.25-degree-v1',
  });
  assert.deepEqual(policy.dependencyLock, { path: 'tools/staging-wind100-requirements.txt',
    sha256: hash(readFileSync(regularFile(realpathSync(ROOT), 'tools/staging-wind100-requirements.txt'))) });
  assert.ok(Object.keys(policy.sourceClosure ?? {}).length >= 12);
  for (const [pathName, digest] of Object.entries(policy.sourceClosure)) {
    assert.match(pathName, /^(?:data|ops|platform\/edge\/src)\/[A-Za-z0-9._/-]+$/);
    assert.ok(!pathName.includes('..'));
    assert.match(digest, SHA);
  }
  return policy;
}

function regularFile(root, relativePath) {
  assert.ok(!relativePath.startsWith('/') && !relativePath.split('/').includes('..'));
  const path = resolve(root, relativePath);
  assert.equal(realpathSync(path), path);
  const stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, `${relativePath} is not a regular file`);
  return path;
}

function boundedRead(path, maximum, label) {
  const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  assert.ok(before.size > 0 && before.size <= maximum, `${label} is empty or oversized`);
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  assert.deepEqual(
    [after.dev, after.ino, after.size, after.mtimeMs],
    [before.dev, before.ino, before.size, before.mtimeMs],
    `${label} changed while reading`,
  );
  assert.equal(bytes.length, before.size, `${label} changed while reading`);
  return bytes;
}

function filesUnder(root, maximumEntries, maximumDepth, directories = null, depthFirstLocale = false) {
  assert.ok(Number.isSafeInteger(maximumEntries) && maximumEntries > 0);
  assert.ok(Number.isSafeInteger(maximumDepth) && maximumDepth >= 0);
  const found = [];
  let entries = 0;
  function visit(directory, depth) {
    assert.ok(depth <= maximumDepth, 'candidate directory depth exceeds its fixed budget');
    const handle = opendirSync(directory);
    const children = [];
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        entries++;
        assert.ok(entries <= maximumEntries, 'candidate traversal exceeds its fixed entry budget');
        children.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
    if (depthFirstLocale) children.sort((left, right) => left.localeCompare(right));
    for (const name of children) {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      assert.ok(!stat.isSymbolicLink(), 'point candidate must not contain symlinks');
      if (stat.isDirectory()) {
        directories?.push(relative(root, path).replaceAll('\\', '/'));
        visit(path, depth + 1);
      } else {
        assert.ok(stat.isFile() && stat.nlink === 1, 'point candidate must contain ordinary single-link files');
        found.push(relative(root, path).replaceAll('\\', '/'));
      }
    }
  }
  visit(root, 0);
  return depthFirstLocale ? found : found.sort();
}

export function controllerDigest(root = ROOT) {
  const digest = createHash('sha256');
  for (const relativePath of [...CONTROLLER_FILES].sort()) {
    const bytes = readFileSync(regularFile(realpathSync(root), relativePath));
    digest.update(`${relativePath}\0${bytes.length}\0`);
    digest.update(bytes);
  }
  return digest.digest('hex');
}

export function gate(env, policy = readPolicy(), digest = controllerDigest(), authority = 'none') {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_JOB, 'wind100');
  assert.equal(env.GITHUB_WORKFLOW_REF, WORKFLOW);
  assert.equal(env.STAGING_DATA_ISOLATION_APPROVED, 'true');
  assert.equal(env.STAGING_WIND100_ENABLED, 'true');
  assert.equal(env.STAGING_R2_ACCOUNT_ID, ACCOUNT);
  assert.equal(env.ATMOS_SHA, policy.sourceSha);
  assert.equal(env.STAGING_WIND100_CONTROLLER_SHA256, digest);
  assert.equal(env.WIND100_CONFIRMATION, CONFIRMATION);
  assert.equal(env.MODEL_ID, MODEL, 'only ECMWF is admitted');
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9]\d{0,19}$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9]\d{0,5}$/);
  assert.ok(['none', 'metadata', 'hydrate', 'components'].includes(authority));
  for (const name of FORBIDDEN) {
    if (authority !== 'none' && (name === 'STAGING_R2_WRITE_ACCESS_KEY_ID' || name === 'STAGING_R2_WRITE_SECRET_ACCESS_KEY')) continue;
    if ((authority === 'hydrate' || authority === 'components') && (name === 'RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID' || name === 'RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY')) continue;
    if (authority === 'components' && (name === 'CATALOG_ENDPOINT' || name === 'CATALOG_PROMOTION_KEY')) continue;
    assert.ok(!env[name], `staging wind100 refuses ${name}`);
  }
  if (authority !== 'none') {
    assert.ok(env.STAGING_R2_WRITE_ACCESS_KEY_ID && env.STAGING_R2_WRITE_SECRET_ACCESS_KEY,
      'exact staging writer credentials are required');
  }
  if (authority === 'hydrate' || authority === 'components') {
    assert.equal(env.RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID, env.STAGING_R2_WRITE_ACCESS_KEY_ID);
    assert.equal(env.RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY, env.STAGING_R2_WRITE_SECRET_ACCESS_KEY);
    assert.equal(env.RCLONE_CONFIG_WEATHERX_ENDPOINT, `https://${ACCOUNT}.r2.cloudflarestorage.com`);
    assert.equal(env.COMPONENT_R2_REMOTE, `weatherx:${COMPONENTS}`);
  }
  if (authority === 'hydrate') {
    assert.equal(env.CATALOG_R2_REMOTE, `weatherx:${DATA}`);
    assert.equal(env.ALLOW_EMPTY_CATALOG, '0'); assert.equal(env.ALLOW_MISSING_COMPONENT, '0');
    assert.equal(env.HYDRATE_MISSING_FROM_RELEASE, '0'); assert.equal(env.COMPONENT_ID, MODEL);
  }
  if (authority === 'components') {
    assert.equal(env.PROMOTE, '0'); assert.equal(env.CATALOG_ENDPOINT, 'https://invalid.invalid');
    assert.equal(env.CATALOG_PROMOTION_KEY, 'unused-promote-zero');
  }
  return { model: MODEL, sourceSha: policy.sourceSha, invocation: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` };
}

export function recurringGate(env, policy = readPolicy(), digest = controllerDigest(), authority = 'none') {
  assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY); assert.ok(['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME));
  assert.equal(env.GITHUB_REF, 'refs/heads/main'); assert.equal(env.GITHUB_WORKFLOW_REF, BAKE_WORKFLOW);
  assert.equal(env.STAGING_DATA_ISOLATION_APPROVED, 'true'); assert.equal(env.STAGING_WIND100_ENABLED, 'true');
  assert.equal(env.STAGING_R2_ACCOUNT_ID, ACCOUNT); assert.equal(env.ATMOS_SHA, policy.sourceSha);
  assert.equal(env.CORE_ATMOS_SHA, policy.coreSourceSha); assert.equal(env.STAGING_WIND100_CONTROLLER_SHA256, digest);
  assert.equal(env.MODEL_ID, MODEL); assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9]\d{0,19}$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9]\d{0,5}$/);
  assert.ok(['none', 'components', 'metadata'].includes(authority));
  for (const name of FORBIDDEN) {
    if (authority !== 'none' && (name === 'STAGING_R2_WRITE_ACCESS_KEY_ID' || name === 'STAGING_R2_WRITE_SECRET_ACCESS_KEY')) continue;
    if (authority === 'components' &&
        (name === 'RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID' || name === 'RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY')) continue;
    if (authority === 'components' && (name === 'CATALOG_ENDPOINT' || name === 'CATALOG_PROMOTION_KEY')) continue;
    assert.ok(!env[name], `recurring staging wind100 refuses ${name}`);
  }
  if (authority !== 'none') assert.ok(env.STAGING_R2_WRITE_ACCESS_KEY_ID && env.STAGING_R2_WRITE_SECRET_ACCESS_KEY);
  if (authority === 'components') {
    assert.equal(env.RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID, env.STAGING_R2_WRITE_ACCESS_KEY_ID);
    assert.equal(env.RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY, env.STAGING_R2_WRITE_SECRET_ACCESS_KEY);
    assert.equal(env.RCLONE_CONFIG_WEATHERX_ENDPOINT, `https://${ACCOUNT}.r2.cloudflarestorage.com`);
    assert.equal(env.COMPONENT_R2_REMOTE, `weatherx:${COMPONENTS}`);
  }
  if (authority === 'components') {
    assert.equal(env.PROMOTE, '0'); assert.equal(env.CATALOG_ENDPOINT, 'https://invalid.invalid');
    assert.equal(env.CATALOG_PROMOTION_KEY, 'unused-promote-zero');
  }
  const request = { model: MODEL, sourceSha: policy.sourceSha,
    invocation: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    publicationMode: policy.recurringPublicationMode };
  if (env.WIND100_INPUT_SHA256) { assert.match(env.WIND100_INPUT_SHA256, SHA); request.inputSha256 = env.WIND100_INPUT_SHA256; }
  return request;
}

function sourceBytes(sourceRoot, policy) {
  const source = realpathSync(sourceRoot);
  const files = [];
  for (const [relativePath, expected] of Object.entries(policy.sourceClosure).sort()) {
    const actual = hash(readFileSync(regularFile(source, relativePath)));
    assert.equal(actual, expected, `${relativePath} differs from reviewed source closure`);
    files.push({ path: relativePath, sha256: actual });
  }
  return { sourceSha: policy.sourceSha, files };
}

export function verifySource(sourceRoot, policy = readPolicy()) {
  const source = realpathSync(sourceRoot);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), policy.sourceSha);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim(), '');
  return sourceBytes(source, policy);
}

function expectedSteps(model, contract) {
  assert.equal(model, MODEL);
  return [
    ...Array.from({ length: Math.floor(Math.min(contract.hours, 144) / 3) + 1 }, (_, index) => index * 3),
    ...(contract.hours > 144
      ? Array.from({ length: Math.floor((contract.hours - 150) / 6) + 1 }, (_, index) => 150 + index * 6)
      : []),
  ];
}

function expectedSemantics(initializedAt, leads, policy) {
  const fields = Object.fromEntries([['wind100_u', 2], ['wind100_v', 3]].map(([field, parameterNumber]) => [field, {
    sourceParameter: policy.native100m.sourceParameters[field], discipline: 0, parameterCategory: 2,
    parameterNumber, typeOfLevel: policy.native100m.levelType, level: policy.native100m.level,
    sourceUnits: policy.native100m.sourceUnits, outputUnits: 'm/s', stepType: policy.native100m.stepType,
    earthRelative: policy.native100m.earthRelative,
  }]));
  return { schemaVersion: 1, contract: policy.native100m.contract, model: MODEL,
    initializedAt: new Date(Date.parse(initializedAt)).toISOString().replace('.000Z', 'Z'),
    verifiedLeadHours: leads, deliveryGrid: policy.native100m.deliveryGrid, fields };
}

function npyHeader(path, expectedShape) {
  const fd = openSync(path, 'r');
  try {
    const prefix = Buffer.alloc(12);
    assert.ok(readSync(fd, prefix, 0, prefix.length, 0) >= 10, 'truncated NPY header');
    assert.deepEqual(prefix.subarray(0, 6), Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59]));
    const major = prefix[6];
    assert.ok(major === 1 || major === 2 || major === 3, 'unsupported NPY version');
    const lengthBytes = major === 1 ? 2 : 4;
    const headerLength = lengthBytes === 2 ? prefix.readUInt16LE(8) : prefix.readUInt32LE(8);
    assert.ok(headerLength > 0 && headerLength <= 4096, 'invalid NPY header length');
    const offset = 8 + lengthBytes;
    const header = Buffer.alloc(headerLength);
    assert.equal(readSync(fd, header, 0, headerLength, offset), headerLength, 'truncated NPY dictionary');
    const text = header.toString('latin1');
    assert.match(text, /['"]descr['"]\s*:\s*['"]<i2['"]/);
    assert.match(text, /['"]fortran_order['"]\s*:\s*False/);
    const shapeText = text.match(/['"]shape['"]\s*:\s*\(([^)]*)\)/)?.[1];
    assert.ok(shapeText, 'NPY shape is missing');
    const shape = shapeText.split(',').map(value => value.trim()).filter(Boolean).map(Number);
    assert.deepEqual(shape, expectedShape);
    const dataOffset = offset + headerLength;
    const bytes = expectedShape.reduce((value, next) => value * next, 1) * 2;
    assert.equal(fstatSync(fd).size, dataOffset + bytes, 'NPY byte length differs');
    return { dataOffset, bytes, shape };
  } finally {
    closeSync(fd);
  }
}

async function fileHash(path) {
  const before = lstatSync(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const after = lstatSync(path);
  assert.deepEqual(
    [after.dev, after.ino, after.size, after.mtimeMs],
    [before.dev, before.ino, before.size, before.mtimeMs],
    'file changed while hashing',
  );
  return digest.digest('hex');
}

function codepointSorted(values) {
  return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} is not an object`);
  assert.deepEqual(codepointSorted(Object.keys(value)), codepointSorted(keys), `${label} keys differ`);
  return value;
}

function safeMapPath(value, label, { directory = false, placeholders = 0 } = {}) {
  assert.ok(typeof value === 'string' && value.length > 0 && value.length <= 512, `${label} is missing or oversized`);
  assert.ok(!value.startsWith('/') && !value.includes('\\') && !value.includes('\0'), `${label} is unsafe`);
  if (directory) assert.ok(value.endsWith('/'), `${label} must end in /`);
  const path = directory ? value.slice(0, -1) : value;
  const markerCount = path.split('{i}').length - 1;
  assert.equal(markerCount, placeholders, `${label} placeholder count differs`);
  const withoutMarker = path.replaceAll('{i}', '0');
  assert.match(withoutMarker, /^[A-Za-z0-9._/-]+$/, `${label} has unsafe characters`);
  const parts = withoutMarker.split('/');
  assert.ok(parts.length > 0 && parts.length <= MAX_MAP_DEPTH,
    `${label} exceeds the map path depth budget`);
  assert.ok(parts.every(part => part && part !== '.' && part !== '..'), `${label} is not normalized`);
  assert.ok(!path.replaceAll('{i}', '').includes('{') && !path.replaceAll('{i}', '').includes('}'),
    `${label} has an unknown placeholder`);
  return value;
}

function mapTemplate(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} definition is invalid`);
  const file = value.file;
  assert.ok(typeof file === 'string');
  const placeholders = file.includes('{i}') ? 1 : 0;
  return { file: safeMapPath(file, `${label} file`, { placeholders }), placeholders };
}

function addExpectedMapPath(paths, path, label) {
  const normalized = safeMapPath(path, label);
  assert.ok(!paths.has(normalized), `${label} duplicates another map object`);
  paths.add(normalized);
}

function expectedMapDirectories(paths) {
  const directories = new Set();
  for (const path of paths) {
    const parts = path.split('/');
    for (let end = 1; end < parts.length; end++) directories.add(parts.slice(0, end).join('/'));
  }
  return directories;
}

function jsonObject(root, path, maximum, label, metadata = null) {
  const bytes = boundedRead(regularFile(root, path), maximum, label);
  if (metadata) {
    const stat = lstatSync(regularFile(root, path));
    metadata.set(path, { maximum, label, sha256: hash(bytes),
      identity: [stat.dev, stat.ino, stat.size, stat.mtimeMs] });
  }
  const value = JSON.parse(bytes);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} is not an object`);
  return value;
}

function expectedNativeFiles(root, runPath, manifest, variable, definition, frames, expected, metadata) {
  const descriptor = definition.nativeViewport;
  if (descriptor === undefined) return;
  assert.ok(NATIVE_VARIABLES.has(variable), `variable ${variable} has an unsupported native viewport`);
  exactKeys(descriptor, ['schemaVersion', 'representation', 'index', 'rangeRequired', 'fullGridFallback'],
    `variable ${variable} native descriptor`);
  assert.deepEqual({ schemaVersion: descriptor.schemaVersion, representation: descriptor.representation,
    rangeRequired: descriptor.rangeRequired, fullGridFallback: descriptor.fullGridFallback },
  { schemaVersion: 1, representation: NATIVE_REPRESENTATION, rangeRequired: true, fullGridFallback: true });
  const template = safeMapPath(descriptor.index, `variable ${variable} native index`, { placeholders: 1 });
  const [directory, suffix] = template.split('/{i}/');
  assert.equal(suffix, 'index.json', `variable ${variable} native index is not canonical`);
  assert.match(directory ?? '', NATIVE_DIRECTORY, `variable ${variable} native directory is invalid`);
  assert.ok(directory.startsWith(`${variable}-native-`), `variable ${variable} native directory differs`);
  for (const frame of frames) {
    const frameId = String(frame.i).padStart(3, '0');
    const indexRelative = `${runPath}${template.replace('{i}', frameId)}`;
    addExpectedMapPath(expected, indexRelative, `variable ${variable} native index`);
    const index = jsonObject(root, indexRelative, MAX_NATIVE_INDEX_BYTES,
      `variable ${variable} native frame ${frame.i} index`, metadata);
    exactKeys(index, ['schemaVersion', 'representation', 'source', 'layout', 'rows'],
      `variable ${variable} native frame ${frame.i} index`);
    assert.equal(index.schemaVersion, 1);
    assert.equal(index.representation, NATIVE_REPRESENTATION);
    assert.deepEqual(index.layout, NATIVE_LAYOUT);
    exactKeys(index.source, ['model', 'run', 'variable', 'frame', 'decodedSha256', 'width', 'height'],
      `variable ${variable} native frame ${frame.i} source`);
    assert.deepEqual({ model: index.source.model, run: index.source.run, variable: index.source.variable,
      frame: index.source.frame, width: index.source.width, height: index.source.height },
    { model: MODEL, run: manifest.init_time, variable, frame: frame.i, width: 1440, height: 721 });
    assert.match(index.source.decodedSha256 ?? '', SHA);
    assert.ok(Array.isArray(index.rows) && index.rows.length === NATIVE_LAYOUT.rows,
      `variable ${variable} native frame ${frame.i} row count differs`);
    for (const [tileY, row] of index.rows.entries()) {
      exactKeys(row, ['tileY', 'file', 'bytes', 'sha256', 'objects'],
        `variable ${variable} native frame ${frame.i} row ${tileY}`);
      const file = `row-${String(tileY).padStart(2, '0')}.wxb`;
      assert.equal(row.tileY, tileY);
      assert.equal(row.file, file);
      assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= MAX_NATIVE_ROW_BYTES);
      assert.match(row.sha256 ?? '', SHA);
      assert.ok(Array.isArray(row.objects) && row.objects.length === NATIVE_LAYOUT.columns,
        `variable ${variable} native frame ${frame.i} row ${tileY} object count differs`);
      addExpectedMapPath(expected, `${runPath}${directory}/${frameId}/${file}`,
        `variable ${variable} native frame ${frame.i} row ${tileY}`);
    }
  }
}

function expectedMapFiles(root, proof, descriptor, policy) {
  const expected = new Set(['index.json']);
  const metadata = new Map();
  const index = jsonObject(root, 'index.json', MAX_JSON_BYTES, 'map index', metadata);
  exactKeys(index, ['schemaVersion', 'model', 'runs'], 'map index');
  assert.equal(index.schemaVersion, 1); assert.equal(index.model, MODEL);
  assert.ok(Array.isArray(index.runs) && index.runs.length === proof.runs && index.runs.length === 2,
    'map run count differs');
  const seenRuns = new Set(); let previousRun = Infinity;
  for (const [runIndex, run] of index.runs.entries()) {
    exactKeys(run, ['init_time', 'path'], `map run ${runIndex}`);
    const initialized = finiteTime(run.init_time, `map run ${runIndex} initialization`);
    assert.ok(initialized < previousRun, 'map runs are not newest-first'); previousRun = initialized;
    const compact = new Date(initialized).toISOString().replace(/[-:T]/g, '').slice(0, 10);
    const runPath = safeMapPath(run.path, `map run ${runIndex} path`, { directory: true });
    assert.equal(runPath, `runs/${compact}/`, `map run ${runIndex} path differs from initialization`);
    assert.ok(!seenRuns.has(runPath), 'map run path is duplicated'); seenRuns.add(runPath);
    if (runIndex === 0) assert.equal(initialized, finiteTime(descriptor.initializedAt, 'point initialization'));
    const manifestPath = `${runPath}manifest.json`;
    addExpectedMapPath(expected, manifestPath, `map run ${runIndex} manifest`);
    const manifest = jsonObject(root, manifestPath, MAX_JSON_BYTES, `map run ${runIndex} manifest`, metadata);
    assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.model, MODEL);
    assert.equal(finiteTime(manifest.init_time, `map run ${runIndex} manifest initialization`), initialized);
    assert.ok(manifest.variables && typeof manifest.variables === 'object' && !Array.isArray(manifest.variables),
      `map run ${runIndex} variables are invalid`);
    const variables = Object.entries(manifest.variables);
    assert.ok(variables.length > 0 && variables.length <= 32, `map run ${runIndex} variable count is invalid`);
    assert.ok(Array.isArray(manifest.frames) && manifest.frames.length > 0
      && manifest.frames.length <= policy.leadCount, `map run ${runIndex} frames are invalid`);
    for (const [frameIndex, frame] of manifest.frames.entries()) {
      assert.ok(frame && typeof frame === 'object' && !Array.isArray(frame) && frame.i === frameIndex,
        `map run ${runIndex} frame indices differ`);
    }
    if (runIndex === 0) {
      assert.equal(variables.length, proof.variables, 'newest map variable count differs from proof');
      assert.equal(manifest.frames.length, proof.frames, 'newest map frame count differs from proof');
    }
    for (const [variable, definition] of variables) {
      assert.match(variable, /^[a-z][a-z0-9_-]{0,31}$/);
      const source = mapTemplate(definition, `variable ${variable}`);
      const sourceFrames = source.placeholders === 1 ? manifest.frames : [{ i: null }];
      for (const frame of sourceFrames) {
        const file = source.placeholders === 1 ? source.file.replace('{i}', String(frame.i).padStart(3, '0')) : source.file;
        addExpectedMapPath(expected, `${runPath}${file}`, `variable ${variable} source`);
      }
      if (definition.progressive !== undefined) {
        const progressive = mapTemplate(definition.progressive, `variable ${variable} progressive`);
        assert.equal(progressive.placeholders, 1, `variable ${variable} progressive file is not framed`);
        assert.ok(definition.progressive.grid && typeof definition.progressive.grid === 'object'
          && !Array.isArray(definition.progressive.grid), `variable ${variable} progressive grid is invalid`);
        for (const frame of manifest.frames) addExpectedMapPath(expected,
          `${runPath}${progressive.file.replace('{i}', String(frame.i).padStart(3, '0'))}`,
          `variable ${variable} progressive source`);
      }
      expectedNativeFiles(root, runPath, manifest, variable, definition, manifest.frames, expected, metadata);
    }
  }
  assert.ok(expected.size > 0 && expected.size <= MAX_MAP_OBJECTS, 'map manifest references too many objects');
  return { expected, metadata };
}

export async function qualifyMapInventory(root, proof, descriptor, policy) {
  const directory = realpathSync(root);
  const { expected, metadata } = expectedMapFiles(directory, proof, descriptor, policy);
  const expectedFiles = codepointSorted(expected);
  const expectedDirectories = codepointSorted(expectedMapDirectories(expected));
  assert.ok(expectedDirectories.length <= MAX_MAP_OBJECTS, 'map manifest references too many directories');
  const maximumEntries = expectedFiles.length + expectedDirectories.length;
  const actualDirectories = [];
  const actualFiles = filesUnder(directory, maximumEntries, MAX_MAP_DEPTH, actualDirectories, true);
  assert.deepEqual(codepointSorted(actualFiles), expectedFiles, 'map files differ from the manifest-derived inventory');
  assert.deepEqual(codepointSorted(actualDirectories), expectedDirectories,
    'map directories differ from the manifest-derived inventory');
  const rows = []; let totalBytes = 0;
  for (const path of actualFiles) {
    const absolute = regularFile(directory, path), size = lstatSync(absolute).size;
    assert.ok(size > 0 && size <= MAX_MAP_FILE_BYTES, 'component file is empty or oversized');
    totalBytes += size; assert.ok(totalBytes <= MAX_MAP_TOTAL_BYTES, 'component tree is oversized');
    const sha256 = await fileHash(absolute);
    const parsed = metadata.get(path);
    if (parsed) {
      assert.equal(size, parsed.identity[2], `${parsed.label} changed after parsing`);
      assert.equal(sha256, parsed.sha256, `${parsed.label} changed after parsing`);
    }
    rows.push({ path, size, sha256 });
  }
  const finalDirectories = [];
  assert.deepEqual(filesUnder(directory, maximumEntries, MAX_MAP_DEPTH, finalDirectories, true), actualFiles,
    'map files changed while hashing');
  assert.deepEqual(codepointSorted(finalDirectories), expectedDirectories, 'map directories changed while hashing');
  for (const [path, parsed] of metadata) {
    const absolute = regularFile(directory, path);
    const stat = lstatSync(absolute);
    assert.deepEqual([stat.dev, stat.ino, stat.size, stat.mtimeMs], parsed.identity,
      `${parsed.label} identity changed after qualification`);
    assert.equal(hash(boundedRead(absolute, parsed.maximum, parsed.label)), parsed.sha256,
      `${parsed.label} changed after qualification`);
  }
  return { objectCount: rows.length, directoryCount: expectedDirectories.length,
    traversalEntryCount: maximumEntries, inventorySha256: hash(JSON.stringify(rows)), inventory: rows };
}

function validatedSourceEvidence(evidence, policy) {
  assert.equal(evidence?.sourceSha, policy.sourceSha);
  assert.ok(Array.isArray(evidence.files) && evidence.files.length > 0);
  const files = evidence.files.map(row => {
    assert.match(row?.path ?? '', /^(?:data|ops|platform\/edge\/src)\/[A-Za-z0-9._/-]+$/);
    assert.match(row?.sha256 ?? '', SHA);
    return { path: row.path, sha256: row.sha256 };
  });
  assert.equal(new Set(files.map(row => row.path)).size, files.length);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (policy.sourceClosure) {
    assert.deepEqual(files, Object.entries(policy.sourceClosure).sort()
      .map(([path, sha256]) => ({ path, sha256 })));
  }
  return { sourceSha: policy.sourceSha, files: files.length, inventorySha256: hash(JSON.stringify(files)) };
}

function finiteTime(value, label) {
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), `${label} is not a timestamp`);
  return parsed;
}

function validateMapProof(proof, descriptor, policy) {
  assert.deepEqual(Object.keys(proof ?? {}).sort(),
    ['ageHours', 'frames', 'generationTime', 'horizonHours', 'model', 'runs', 'variables'].sort());
  assert.equal(proof.model, MODEL);
  assert.equal(finiteTime(proof.generationTime, 'map generation'), finiteTime(descriptor.initializedAt, 'point initialization'));
  assert.ok(Number.isFinite(proof.ageHours) && proof.ageHours >= -1 && proof.ageHours <= policy.freshnessHours);
  assert.equal(proof.frames, policy.leadCount);
  assert.equal(proof.horizonHours, policy.hours);
  assert.equal(proof.runs, 2);
  assert.ok(Number.isSafeInteger(proof.variables) && proof.variables >= 6 && proof.variables <= 32);
  return { ...proof };
}

function validateSeal(manifest, stageInventory, request, descriptor) {
  assert.deepEqual(Object.keys(manifest ?? {}).sort(),
    ['files', 'forecastRun', 'model', 'runId', 'schemaVersion', 'sourceSha', 'status'].sort());
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.status, 'unqualified-core-inputs');
  assert.equal(manifest.model, MODEL);
  assert.equal(manifest.sourceSha, request.sourceSha);
  assert.equal(manifest.runId, request.invocation);
  assert.equal(manifest.forecastRun, descriptor.runId);
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > stageInventory.length);
  const rows = manifest.files.map(row => {
    assert.deepEqual(Object.keys(row ?? {}).sort(), ['path', 'sha256', 'size'].sort());
    assert.match(row.path ?? '', /^[A-Za-z0-9._/-]+$/); assert.ok(!row.path.includes('..'));
    assert.ok(Number.isSafeInteger(row.size) && row.size > 0); assert.match(row.sha256 ?? '', SHA);
    return row;
  });
  assert.equal(new Set(rows.map(row => row.path)).size, rows.length);
  for (const row of stageInventory) assert.deepEqual(rows.find(value => value.path === `data/.ecmwf-point/${row.path}`),
    { path: `data/.ecmwf-point/${row.path}`, size: row.bytes, sha256: row.sha256 }, `sealed artifact omitted ${row.path}`);
  return { files: rows.length, manifestSha256: hash(JSON.stringify(manifest)) };
}

function validateAugmentedInput(augmentation, handoff, inputManifest, stageInventory, request, descriptor, policy) {
  exactKeys(handoff, ['schemaVersion', 'kind', 'status', 'publicationAuthorized', 'model',
    'componentKind', 'origin', 'pack'], 'core artifact handoff');
  assert.equal(handoff.schemaVersion, 1); assert.equal(handoff.kind, 'weatherx-current-model-artifact-handoff');
  assert.equal(handoff.status, 'ready'); assert.equal(handoff.publicationAuthorized, false);
  assert.equal(handoff.model, MODEL); assert.equal(handoff.componentKind, 'core');
  assert.equal(handoff.origin?.atmosSourceSha, policy.coreSourceSha);
  assert.match(handoff.origin?.artifactSha256 ?? '', SHA);
  assert.equal(handoff.pack?.forecastRun, descriptor.runId);
  assert.match(handoff.pack?.receiptSha256 ?? '', SHA);
  assert.equal(hash(Buffer.from(`${JSON.stringify(inputManifest)}\n`)), handoff.pack.receiptSha256,
    'authenticated core input manifest bytes differ');
  assert.equal(inputManifest?.schemaVersion, 1); assert.equal(inputManifest.status, 'unqualified-core-inputs');
  assert.equal(inputManifest.model, MODEL); assert.equal(inputManifest.sourceSha, policy.coreSourceSha);
  assert.equal(String(inputManifest.runId), String(handoff.origin.runId));
  assert.equal(inputManifest.forecastRun, descriptor.runId); assert.ok(Array.isArray(inputManifest.files));
  const contentSha256 = sealedPointInputSha(inputManifest);
  exactKeys(augmentation, ['schemaVersion', 'kind', 'model', 'runId', 'initializedAt', 'inputSha256',
    'sourceContract', 'leadHours', 'fetched', 'inputInventorySha256', 'outputInventorySha256',
    'publicationAuthorized'], 'native wind100 augmentation');
  assert.equal(augmentation.schemaVersion, 1);
  assert.equal(augmentation.kind, 'weatherx-ecmwf-native-wind100-augmentation');
  assert.equal(augmentation.model, MODEL); assert.equal(augmentation.runId, descriptor.runId);
  assert.equal(finiteTime(augmentation.initializedAt, 'augmentation initialization'),
    finiteTime(descriptor.initializedAt, 'point initialization'));
  assert.equal(augmentation.inputSha256, contentSha256);
  assert.equal(augmentation.sourceContract, policy.native100m.contract);
  assert.deepEqual(augmentation.leadHours, descriptor.storage.leadHours);
  assert.equal(typeof augmentation.fetched, 'boolean'); assert.equal(augmentation.publicationAuthorized, false);
  const sealedRows = sealedPointRows(inputManifest).map(row => ({
    path: row.path.slice('data/.ecmwf-point/'.length), bytes: row.size, sha256: row.sha256,
  }));
  assert.equal(augmentation.inputInventorySha256, pythonInventorySha(sealedRows),
    'augmentation input inventory differs from authenticated sealed point input');
  for (const row of sealedRows.filter(value => value.path !== 'meta.json')) {
    assert.deepEqual(stageInventory.find(value => value.path === row.path), row,
      `authenticated surface input ${row.path} changed during augmentation`);
  }
  assert.equal(augmentation.outputInventorySha256, pythonInventorySha(stageInventory),
    'augmented source-stage inventory differs from its receipt');
  assert.equal(request.inputSha256, augmentation.inputSha256);
  return { kind: 'authenticated-core-plus-native-wind100-augmentation',
    coreSourceSha: policy.coreSourceSha, wind100SourceSha: request.sourceSha,
    inputSha256: contentSha256, artifactReceiptSha256: handoff.pack.receiptSha256,
    artifactSha256: handoff.origin.artifactSha256,
    outputInventorySha256: augmentation.outputInventorySha256 };
}

function validateDescriptor(catalog, model, policy) {
  assert.equal(catalog?.schemaVersion, 2);
  assert.deepEqual(Object.keys(catalog.models ?? {}), [model]);
  const descriptor = catalog.models[model];
  assert.equal(model, MODEL);
  const contract = policy;
  assert.match(descriptor?.runId ?? '', RUN);
  const initialized = Date.parse(descriptor.initializedAt);
  const generated = Date.parse(descriptor.generatedAt);
  const freshUntil = Date.parse(descriptor.freshUntil);
  assert.ok([initialized, generated, freshUntil].every(Number.isFinite));
  const compact = new Date(initialized).toISOString().replace(/[-:T]/g, '').slice(0, 10);
  assert.equal(descriptor.runId, compact, 'initializedAt differs from runId');
  assert.equal(freshUntil, initialized + contract.freshnessHours * 3600_000,
    'freshUntil must be derived from model initialization, never preparation time');
  assert.deepEqual(descriptor.grid, policy.grid);
  assert.deepEqual(descriptor.chunk, policy.chunk);
  assert.equal(descriptor.resolutionDegrees, 0.25);
  assert.equal(descriptor.nativeCadenceSeconds, contract.nativeCadenceSeconds);
  assert.deepEqual(descriptor.storage?.leadHours, expectedSteps(model, contract));
  assert.equal(descriptor.storage?.format, 'WXPS1');
  assert.equal(descriptor.storage?.missing, MISSING);
  assert.deepEqual(descriptor.storage?.fields, exactStorageFields(contract.storageFields),
    'surface/native storage fields or ordering changed');
  assert.deepEqual(descriptor.variables?.wind_speed_100m, { kind: 'instantaneous', units: 'm/s' });
  assert.deepEqual(descriptor.fieldSemantics,
    expectedSemantics(descriptor.initializedAt, descriptor.storage.leadHours, policy),
    'point descriptor lacks the exact decoded native 100m source identity');
  return descriptor;
}

function exactRead(fd, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const count = readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    assert.ok(count > 0, 'truncated source-stage array');
    offset += count;
  }
}

function loadStage(stageRoot, model, descriptor) {
  const stage = realpathSync(stageRoot);
  const fieldIds = descriptor.storage.fields.map(field => field.id);
  const expectedFiles = ['meta.json', ...fieldIds.map(field => `${field}.i16.npy`)].sort();
  assert.deepEqual(filesUnder(stage, expectedFiles.length, 1), expectedFiles,
    'source stage inventory differs from descriptor fields');
  const metaPath = regularFile(stage, 'meta.json');
  const metaBytes = boundedRead(metaPath, 64 * 1024, 'source-stage metadata');
  const meta = JSON.parse(metaBytes);
  assert.equal(meta.schemaVersion, 2);
  assert.equal(meta.model, model);
  assert.equal(meta.run.replace('/', '').replace('z', ''), descriptor.runId);
  assert.deepEqual(meta.steps, descriptor.storage.leadHours);
  assert.deepEqual(meta.grid, descriptor.grid);
  assert.deepEqual(meta.fields, fieldIds, 'source stage field order differs from packed descriptor');
  assert.deepEqual(meta.fieldSemantics, descriptor.fieldSemantics,
    'source-stage and point descriptor native 100m identities differ');
  const shape = [descriptor.storage.leadHours.length, descriptor.grid.height, descriptor.grid.width];
  const headers = {};
  for (const field of fieldIds) headers[field] = npyHeader(regularFile(stage, `${field}.i16.npy`), shape);
  return { stage, metaBytes, headers, shape };
}

function unpack(bytes, descriptor, chunkX, chunkY) {
  assert.ok(bytes.length <= MAX_PACK_BYTES, 'WXPS pack is oversized');
  const raw = gunzipSync(bytes, { maxOutputLength: MAX_UNPACKED_BYTES });
  const width = Math.min(descriptor.chunk.width, descriptor.grid.width - chunkX * descriptor.chunk.width);
  const height = Math.min(descriptor.chunk.height, descriptor.grid.height - chunkY * descriptor.chunk.height);
  const fields = descriptor.storage.fields.length;
  const leads = descriptor.storage.leadHours.length;
  assert.ok(raw.length >= 14 && raw.subarray(0, 4).toString('ascii') === 'WXPS');
  assert.equal(raw.readUInt8(4), 1);
  assert.equal(raw.readUInt8(5), width);
  assert.equal(raw.readUInt8(6), height);
  assert.equal(raw.readUInt8(7), fields);
  assert.equal(raw.readUInt16LE(8), leads);
  assert.equal(raw.readUInt16LE(10), chunkX);
  assert.equal(raw.readUInt16LE(12), chunkY);
  assert.equal(raw.length, 14 + width * height * fields * leads * 2);
  return { raw, width, height, fields, leads };
}

function slab(fd, header, lead, chunkY, descriptor) {
  const firstY = chunkY * descriptor.chunk.height;
  const height = Math.min(descriptor.chunk.height, descriptor.grid.height - firstY);
  const bytes = Buffer.allocUnsafe(height * descriptor.grid.width * 2);
  const cell = lead * descriptor.grid.height * descriptor.grid.width + firstY * descriptor.grid.width;
  exactRead(fd, bytes, header.dataOffset + cell * 2);
  return bytes;
}

function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs];
}

export async function qualifyPointPacks({ pointRoot, stageRoot, model, policy = readPolicy(), structuralReport,
  sourceEvidence, mapProof, mapRoot, sealedManifest, request = { sourceSha: policy.sourceSha, invocation: 'fixture-1' },
  augmentationReceipt = null, inputHandoff = null, inputManifest = null, now = Date.now(), trace = null }) {
  markQualification(trace, 'source-evidence');
  assert.equal(model, MODEL);
  const recurring = request.publicationMode !== undefined;
  if (recurring) assert.equal(request.publicationMode, policy.recurringPublicationMode);
  const sourceClosure = validatedSourceEvidence(sourceEvidence, policy);
  markQualification(trace, 'point-catalog');
  const root = realpathSync(pointRoot);
  const catalogPath = regularFile(root, 'v2/catalog.json');
  const catalogBytes = boundedRead(catalogPath, 512 * 1024, 'point catalog');
  const catalog = JSON.parse(catalogBytes);
  const descriptor = validateDescriptor(catalog, model, policy);
  markQualification(trace, 'source-stage');
  const stage = loadStage(stageRoot, model, descriptor);
  const chunksX = Math.ceil(descriptor.grid.width / descriptor.chunk.width);
  const chunksY = Math.ceil(descriptor.grid.height / descriptor.chunk.height);
  const expectedPacks = [];
  for (let chunkY = 0; chunkY < chunksY; chunkY++) {
    for (let chunkX = 0; chunkX < chunksX; chunkX++) {
      expectedPacks.push(`v2/${model}/${descriptor.runId}/chunks/${chunkY}/${chunkX}.bin.gz`);
    }
  }
  markQualification(trace, 'pack-inventory');
  const pointEntryBudget = expectedPacks.length + chunksY + 5;
  assert.deepEqual(filesUnder(root, pointEntryBudget, 5), ['v2/catalog.json', ...expectedPacks].sort(),
    'point pack inventory is incomplete or contains extras');

  const fieldIds = descriptor.storage.fields.map(field => field.id);
  const uIndex = fieldIds.indexOf('wind100_u'), vIndex = fieldIds.indexOf('wind100_v');
  assert.ok(uIndex >= 0 && vIndex >= 0 && uIndex !== vIndex);
  const stageFields = fieldIds.map((field, index) => {
    const path = regularFile(stage.stage, `${field}.i16.npy`);
    return { field, index, path, before: fileIdentity(lstatSync(path)), fd: null };
  });
  const uPath = stageFields[uIndex].path;
  const vPath = stageFields[vIndex].path;
  const uBeforeSha256 = await fileHash(uPath);
  const vBeforeSha256 = await fileHash(vPath);
  const totalCells = descriptor.grid.width * descriptor.grid.height;
  const perLead = descriptor.storage.leadHours.map(leadHour => ({
    leadHour, jointPresentCells: 0, missingPairCells: 0, oneSidedMissingCells: 0,
    uMinRaw: null, uMaxRaw: null, vMinRaw: null, vMaxRaw: null,
  }));
  const packInventory = [];
  markQualification(trace, 'pack-scan');
  try {
    for (const sourceField of stageFields) {
      sourceField.fd = openSync(sourceField.path, 'r');
      assert.deepEqual(fileIdentity(fstatSync(sourceField.fd)), sourceField.before,
        `${sourceField.field} source stage changed before comparison`);
    }
    for (let chunkY = 0; chunkY < chunksY; chunkY++) {
      const fieldSlabs = stageFields.map(sourceField => perLead.map((_, lead) =>
        slab(sourceField.fd, stage.headers[sourceField.field], lead, chunkY, descriptor)));
      for (let chunkX = 0; chunkX < chunksX; chunkX++) {
        const path = `v2/${model}/${descriptor.runId}/chunks/${chunkY}/${chunkX}.bin.gz`;
        const bytes = boundedRead(regularFile(root, path), MAX_PACK_BYTES, 'WXPS pack');
        const pack = unpack(bytes, descriptor, chunkX, chunkY);
        packInventory.push({ path, bytes: bytes.length, sha256: hash(bytes) });
        for (let localY = 0; localY < pack.height; localY++) {
          for (let localX = 0; localX < pack.width; localX++) {
            const localCell = localY * pack.width + localX;
            const globalX = chunkX * descriptor.chunk.width + localX;
            const stageOffset = (localY * descriptor.grid.width + globalX) * 2;
            for (let lead = 0; lead < pack.leads; lead++) {
              for (const sourceField of stageFields) {
                const packed = pack.raw.readInt16LE(14 + (
                  sourceField.index * pack.width * pack.height * pack.leads
                  + localCell * pack.leads + lead
                ) * 2);
                const staged = fieldSlabs[sourceField.index][lead].readInt16LE(stageOffset);
                assert.equal(packed, staged,
                  `packed ${sourceField.field} differs from source stage at ${chunkY}/${chunkX}`);
              }
              const packedU = pack.raw.readInt16LE(14 + (uIndex * pack.width * pack.height * pack.leads + localCell * pack.leads + lead) * 2);
              const packedV = pack.raw.readInt16LE(14 + (vIndex * pack.width * pack.height * pack.leads + localCell * pack.leads + lead) * 2);
              const uMissing = packedU === MISSING, vMissing = packedV === MISSING;
              if (uMissing !== vMissing) perLead[lead].oneSidedMissingCells++;
              else if (uMissing) perLead[lead].missingPairCells++;
              else {
                assert.ok(packedU >= -32767 && packedU <= 32767 && packedV >= -32767 && packedV <= 32767);
                const row = perLead[lead];
                row.jointPresentCells++;
                row.uMinRaw = row.uMinRaw == null ? packedU : Math.min(row.uMinRaw, packedU);
                row.uMaxRaw = row.uMaxRaw == null ? packedU : Math.max(row.uMaxRaw, packedU);
                row.vMinRaw = row.vMinRaw == null ? packedV : Math.min(row.vMinRaw, packedV);
                row.vMaxRaw = row.vMaxRaw == null ? packedV : Math.max(row.vMaxRaw, packedV);
              }
            }
          }
        }
        markQualification(trace, 'pack-scan', { pointPacksChecked: packInventory.length });
      }
      markQualification(trace, 'pack-scan', { pointPackRowsChecked: chunkY + 1 });
    }
  } finally {
    for (const sourceField of stageFields) {
      if (sourceField.fd != null) closeSync(sourceField.fd);
    }
  }
  for (const sourceField of stageFields) {
    assert.deepEqual(fileIdentity(lstatSync(sourceField.path)), sourceField.before,
      `${sourceField.field} source stage changed during comparison`);
  }
  assert.equal(await fileHash(uPath), uBeforeSha256, 'wind100_u source stage changed during comparison');
  assert.equal(await fileHash(vPath), vBeforeSha256, 'wind100_v source stage changed during comparison');
  markQualification(trace, 'coverage');
  for (const row of perLead) {
    assert.equal(row.jointPresentCells + row.missingPairCells + row.oneSidedMissingCells, totalCells,
      `lead ${row.leadHour} native 100m accounting differs from the full grid`);
    assert.equal(row.oneSidedMissingCells, 0, `lead ${row.leadHour} has a one-sided native 100m missing value`);
    const permille = Math.floor(row.jointPresentCells * 1000 / totalCells);
    assert.ok(permille >= policy.native100m.requiredJointCoveragePermille,
      `lead ${row.leadHour} lacks required joint native 100m coverage`);
    row.jointCoveragePermille = permille;
  }

  packInventory.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const validatorObjects = [
    { path: 'point-series/v2/catalog.json', bytes: catalogBytes.length, sha256: hash(catalogBytes) },
    ...packInventory.map(row => ({ ...row, path: `point-series/${row.path}` })),
  ].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  markQualification(trace, 'structural-report');
  assert.deepEqual(structuralReport?.models, { [model]: descriptor });
  assert.equal(structuralReport.schemaVersion, 2);
  assert.equal(structuralReport.objectCount, validatorObjects.length);
  assert.deepEqual(structuralReport.objects, validatorObjects,
    'reviewed structural validator report differs from actual point bytes');
  assert.equal(structuralReport.manifestSha256, hash(JSON.stringify(validatorObjects)),
    'reviewed structural validator digest differs from actual point bytes');

  markQualification(trace, 'source-stage-inventory');
  const stageInventory = [];
  for (const path of filesUnder(stage.stage, fieldIds.length + 1, 1)) {
    const absolute = regularFile(stage.stage, path);
    const stat = lstatSync(absolute);
    stageInventory.push({ path, bytes: stat.size, sha256: await fileHash(absolute) });
  }
  stageInventory.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  markQualification(trace, 'seal');
  const seal = recurring
    ? validateAugmentedInput(augmentationReceipt, inputHandoff, inputManifest, stageInventory, request, descriptor, policy)
    : validateSeal(sealedManifest, stageInventory, request, descriptor);
  let map = null;
  if (!recurring) {
    markQualification(trace, 'map-proof');
    const validatedMapProof = validateMapProof(mapProof, descriptor, policy);
    markQualification(trace, 'map-inventory');
    map = { ...validatedMapProof, ...await qualifyMapInventory(mapRoot, validatedMapProof, descriptor, policy) };
  }
  markQualification(trace, 'lease');
  assert.ok(finiteTime(descriptor.freshUntil, 'forecast expiry') - now >= policy.minimumForecastLeaseHours * 3600_000,
    'candidate lacks the minimum forecast lease');
  markQualification(trace, 'receipt');
  return {
    schemaVersion: 2,
    kind: 'weatherx-staging-native-wind100-point-candidate',
    status: 'CREDENTIAL_FREE_POINT_PACK_INTEGRITY_QUALIFIED_NOT_PUBLISHED',
    model,
    sourceSha: policy.sourceSha,
    ...(recurring ? { publicationMode: policy.recurringPublicationMode } : {}),
    inputSha256: seal.inputSha256 ?? seal.manifestSha256,
    runId: descriptor.runId,
    initializedAt: descriptor.initializedAt,
    freshUntil: descriptor.freshUntil,
    sourceClosure,
    sourceStage: {
      objectCount: stageInventory.length,
      inventorySha256: hash(JSON.stringify(stageInventory)),
      inventory: stageInventory,
    },
    pointPacks: {
      format: 'WXPS1',
      objectCount: packInventory.length,
      totalBytes: packInventory.reduce((sum, row) => sum + row.bytes, 0),
      cellCount: totalCells,
      catalogBytes: catalogBytes.length,
      catalogSha256: hash(catalogBytes),
      descriptorSha256: hash(JSON.stringify(descriptor)),
      descriptor,
      inventorySha256: hash(JSON.stringify(packInventory)),
      inventory: packInventory,
      structuralManifestSha256: structuralReport.manifestSha256,
      allFieldsExactlyMatchSourceStage: true,
    },
    native100m: {
      sourceFields: ['wind100_u', 'wind100_v'],
      derivedVariable: 'wind_speed_100m',
      minimumJointCoveragePermille: policy.native100m.requiredJointCoveragePermille,
      perLead,
      valuesExactlyMatchSourceStage: true,
      valuesRepairedOrFilled: false,
    },
    ...(map == null ? {} : { map }),
    sealedArtifact: seal,
    credentialFreeIntegrityQualification: true,
    decodedProviderSemanticsVerified: true,
    ...(recurring ? { authenticatedCorePointInput: true } : {}),
    existingMapAndPointScienceGatesPassed: !recurring,
    scientificRangePolicyApproved: false,
    dependencyClosureApproved: true,
    stagingCatalogPrepared: false,
    sharedReadCanaryActivated: false,
    productionWritten: false,
  };
}

function safeKey(key) {
  assert.match(key ?? '', /^[A-Za-z0-9._/-]{1,512}$/);
  assert.ok(!key.startsWith('/') && !key.split('/').includes('..'));
  return key;
}

function componentManifest(value, id, receipt, qualification, now, reuseExisting = false) {
  assert.deepEqual(Object.keys(receipt ?? {}).sort(), (reuseExisting
    ? ['manifestKey', 'manifestSha256']
    : ['expectedPreviousManifestSha256', 'expectedRollbackEpoch', 'manifestKey', 'manifestSha256']).sort());
  if (!reuseExisting) { assert.equal(receipt.expectedPreviousManifestSha256, null); assert.equal(receipt.expectedRollbackEpoch, 0); }
  assert.match(receipt.manifestSha256 ?? '', SHA);
  const artifact = reuseExisting ? value?.artifactId
    : `${qualification.publicationMode === RECURRING_PUBLICATION_MODE ? 'stage-wind100-recurring' : 'stage-wind100'}-${id}-${qualification.invocation}`;
  assert.match(artifact ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/);
  const rootPrefix = `components/${id}/${artifact}/`;
  assert.equal(receipt.manifestKey, `${rootPrefix}component.json`);
  assert.deepEqual(Object.keys(value ?? {}).sort(), [
    'artifactId', 'completedAt', 'componentId', 'generationTime', 'inventorySha256', 'mounts',
    'objectCount', 'quality', 'rootPrefix', 'schemaVersion', ...(id === `point-${MODEL}` ? ['pointSeries'] : []),
    ...(reuseExisting && value?.objectLayout != null ? ['objectLayout'] : []),
  ].sort());
  if (reuseExisting) assert.ok(value.schemaVersion === 1 || value.schemaVersion === 2);
  else assert.equal(value.schemaVersion, 1);
  assert.equal(value.componentId, id); assert.equal(value.artifactId, artifact);
  assert.equal(value.rootPrefix, rootPrefix); assert.equal(finiteTime(value.generationTime, 'component generation'), finiteTime(qualification.initializedAt, 'qualification initialization'));
  assert.ok(finiteTime(value.completedAt, 'component completion') >= finiteTime(qualification.initializedAt, 'qualification initialization'));
  assert.ok(finiteTime(value.completedAt, 'component completion') <= now, 'component completion is in the future');
  const maximumObjects = id === MODEL ? MAX_MAP_OBJECTS : 10_000;
  assert.ok(Number.isSafeInteger(value.objectCount) && value.objectCount > 0 && value.objectCount <= maximumObjects);
  assert.match(value.inventorySha256 ?? '', SHA); assert.equal(value.quality?.status, 'passed');
  assert.ok(Array.isArray(value.quality.checks) && value.quality.checks.length === new Set(value.quality.checks).size);
  for (const required of id === MODEL
    ? ['manifest', 'inventory', 'remote_bytes', 'coverage', 'freshness', 'live_superset', 'horizon', 'cadence', 'grid', 'referenced_bytes', 'native_viewport']
    : ['manifest', 'inventory', 'remote_bytes', 'point_series']) assert.ok(value.quality.checks.includes(required), `missing ${required} check`);
  if (id === MODEL) assert.deepEqual(value.mounts, [`data/${MODEL}/`]);
  else {
    assert.deepEqual(value.mounts, [`point-series/v2/${MODEL}/`]);
    assert.equal(value.pointSeries?.schemaVersion, 1); assert.equal(value.pointSeries?.modelId, MODEL);
    assert.deepEqual(value.pointSeries?.descriptor, qualification.pointPacks.descriptor);
  }
  const expectedInventory = id === MODEL ? qualification.map : {
    objectCount: qualification.pointPacks.objectCount,
    inventorySha256: hash(JSON.stringify(qualification.pointPacks.inventory.map(row => ({
      path: row.path.slice(`v2/${MODEL}/`.length), size: row.bytes, sha256: row.sha256,
    })))),
  };
  assert.equal(value.objectCount, expectedInventory.objectCount, `${id} object count differs from qualification`);
  assert.equal(value.inventorySha256, expectedInventory.inventorySha256, `${id} inventory differs from qualification`);
  return { ...value, manifestKey: receipt.manifestKey, manifestSha256: receipt.manifestSha256 };
}

function validateQualification(q, request, policy, now) {
  assert.equal(q?.schemaVersion, 2); assert.equal(q.kind, 'weatherx-staging-native-wind100-point-candidate');
  assert.equal(q.status, 'CREDENTIAL_FREE_POINT_PACK_INTEGRITY_QUALIFIED_NOT_PUBLISHED');
  assert.equal(q.model, MODEL); assert.equal(q.sourceSha, request.sourceSha); assert.equal(q.invocation, request.invocation);
  const inputSha256 = q.inputSha256 ?? q.sealedArtifact?.manifestSha256;
  assert.match(inputSha256 ?? '', SHA); if (request.inputSha256) assert.equal(inputSha256, request.inputSha256);
  for (const key of ['credentialFreeIntegrityQualification', 'decodedProviderSemanticsVerified',
    'dependencyClosureApproved']) assert.equal(q[key], true, key);
  if (request.publicationMode !== undefined) {
    assert.equal(request.publicationMode, policy.recurringPublicationMode);
    assert.equal(q.publicationMode, request.publicationMode);
    assert.equal(q.authenticatedCorePointInput, true);
    assert.equal(q.existingMapAndPointScienceGatesPassed, false);
    assert.equal(q.map, undefined);
  } else {
    assert.equal(q.publicationMode, undefined);
    assert.equal(q.authenticatedCorePointInput, undefined);
    assert.equal(q.existingMapAndPointScienceGatesPassed, true);
  }
  for (const key of ['scientificRangePolicyApproved', 'stagingCatalogPrepared', 'sharedReadCanaryActivated', 'productionWritten']) assert.equal(q[key], false, key);
  assert.deepEqual(q.pointPacks.descriptor.fieldSemantics,
    expectedSemantics(q.initializedAt, expectedSteps(MODEL, policy), policy));
  assert.ok(finiteTime(q.freshUntil, 'forecast expiry') - now >= policy.minimumForecastLeaseHours * 3600_000,
    'candidate lacks minimum lease at publication boundary');
  return { ...q, inputSha256 };
}

function candidateKeys(request) {
  const recurring = request.publicationMode === RECURRING_PUBLICATION_MODE;
  const catalogId = `${recurring ? 'stage-wind100-recurring' : 'stage-wind100'}-${request.invocation}`;
  assert.match(catalogId, recurring ? RECURRING_CATALOG_ID : MANUAL_CATALOG_ID);
  return { catalogId, catalogKey: `catalogs/snapshots/${catalogId}.json`,
    selectionKey: `staging-candidates/wind100/${catalogId}/selection.json` };
}

export function recurringPrefixCapacity(existing, qualification, pointRoot, policy = readPolicy()) {
  assert.ok(Array.isArray(existing));
  assert.equal(qualification?.publicationMode, policy.recurringPublicationMode);
  assert.ok(existing.every(path => typeof path === 'string' && path.length > 0 && path.length <= 512
    && RECURRING_COMPONENT_KEY.test(path)),
  'recurring component prefix inventory contains an unexpected key');
  assert.equal(new Set(existing).size, existing.length,
    'recurring component prefix inventory contains a duplicate key');
  assert.ok(existing.length <= policy.recurringStorage.maximumComponentPrefixObjects,
    'recurring component prefix already exceeds its object ceiling');
  const root = realpathSync(pointRoot);
  const plannedFiles = filesUnder(root, 10_000, 8);
  assert.equal(plannedFiles.length, qualification.pointPacks?.objectCount,
    'planned recurring component object count differs from qualification');
  const planned = plannedFiles.length + 1; // build-component-manifest adds component.json.
  assert.ok(existing.length + planned <= policy.recurringStorage.maximumComponentPrefixObjects,
    'recurring component prefix lacks capacity for this candidate');
  return { existingObjects: existing.length, plannedObjects: planned,
    maximumObjects: policy.recurringStorage.maximumComponentPrefixObjects };
}

export async function listRecurringPrefixS3(env, injectedClient, injectedSdk) {
  assert.equal(env.STAGING_R2_ACCOUNT_ID, ACCOUNT);
  assert.ok(env.STAGING_R2_WRITE_ACCESS_KEY_ID && env.STAGING_R2_WRITE_SECRET_ACCESS_KEY);
  const sdk = injectedSdk ?? await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
  const client = injectedClient ?? new sdk.S3Client({ region: 'auto', endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.STAGING_R2_WRITE_ACCESS_KEY_ID, secretAccessKey: env.STAGING_R2_WRITE_SECRET_ACCESS_KEY } });
  const keys = [], tokens = new Set();
  let token;
  try {
    for (let pageNumber = 0; pageNumber <= 50; pageNumber++) {
      let page;
      try {
        page = await client.send(new sdk.ListObjectsV2Command({ Bucket: COMPONENTS,
          Prefix: RECURRING_COMPONENT_PREFIX, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }),
        { abortSignal: AbortSignal.timeout(120_000) });
      } catch { throw Error('recurring component prefix inventory failed'); }
      assert.ok(Array.isArray(page.Contents ?? []), 'recurring component prefix inventory is invalid');
      assert.ok((page.Contents ?? []).length <= 1000, 'recurring component prefix page is oversized');
      assert.ok(page.IsTruncated === true || page.IsTruncated === false,
        'recurring component prefix pagination is invalid');
      for (const object of page.Contents ?? []) {
        assert.ok(typeof object?.Key === 'string' && object.Key.length <= 512
          && RECURRING_COMPONENT_KEY.test(object.Key),
          'recurring component prefix inventory escaped its prefix');
        keys.push(object.Key);
        assert.ok(keys.length <= MAX_RECURRING_PREFIX_OBJECTS,
          'recurring component prefix already exceeds its object ceiling');
      }
      if (page.IsTruncated !== true) return keys;
      assert.ok(typeof page.NextContinuationToken === 'string' && page.NextContinuationToken.length > 0
        && page.NextContinuationToken.length <= 4096 && !tokens.has(page.NextContinuationToken),
      'recurring component prefix pagination is invalid');
      token = page.NextContinuationToken; tokens.add(token);
    }
    throw Error('recurring component prefix pagination exceeded its page ceiling');
  } finally { if (!injectedClient) client.destroy?.(); }
}

function validateComponentObjectMetadata(metadata) {
  assert.ok(metadata && typeof metadata === 'object' && !Array.isArray(metadata),
    'component object metadata is invalid');
  const keys = Object.keys(metadata);
  if (keys.length === 0) return;
  // rclone records this transport timestamp by default. It is not weather identity:
  // the authenticated body hash, receipt and parsed manifest remain authoritative.
  assert.deepEqual(keys, ['mtime'], 'component object metadata has an unknown field');
  assert.match(metadata.mtime, /^\d{10}(?:\.\d{1,9})?$/,
    'component object mtime is not a canonical rclone timestamp');
}

export async function prepareCandidate({ request, qualification, mapReceipt, pointReceipt, io,
  policy = readPolicy(), now = Date.now, catalogValidator = () => true, trace = null }) {
  markPublication(trace, 'qualification');
  const firstNow = now(), q = validateQualification(qualification, request, policy, firstNow);
  const pointOnly = request.publicationMode !== undefined
    && request.publicationMode === policy.recurringPublicationMode;
  const manifests = {};
  const components = pointOnly ? [[`point-${MODEL}`, pointReceipt]] : [[MODEL, mapReceipt], [`point-${MODEL}`, pointReceipt]];
  for (const [id, receipt] of components) {
    markPublication(trace, id === MODEL ? 'map-component' : 'point-component');
    const object = await io.get(COMPONENTS, receipt.manifestKey, MAX_JSON_BYTES);
    assert.ok(object, `missing ${id} component manifest`); assert.equal(object.sha256, receipt.manifestSha256);
    validateComponentObjectMetadata(object.metadata); assert.equal(object.httpMetadata.contentEncoding, undefined);
    assert.ok(object.httpMetadata.contentType == null || object.httpMetadata.contentType === 'application/json');
    assert.ok(object.httpMetadata.cacheControl == null || object.httpMetadata.cacheControl === CACHE);
    manifests[id] = componentManifest(JSON.parse(object.body), id, receipt, q, now());
  }
  if (!pointOnly) {
    markPublication(trace, 'pair');
    assert.equal(manifests[MODEL].generationTime, manifests[`point-${MODEL}`].generationTime);
  }
  markPublication(trace, 'lease');
  assert.ok(finiteTime(q.freshUntil, 'forecast expiry') - now() >= policy.minimumForecastLeaseHours * 3600_000,
    'candidate lease expired during component readback');
  const { catalogId, catalogKey, selectionKey } = candidateKeys(request);
  const completedAt = new Date(now()).toISOString();
  const catalog = { schemaVersion: 2, sequence: 1, parentCatalogId: null, createdAt: completedAt,
    components: manifests, rollbackEpoch: 0 };
  markPublication(trace, 'catalog-validation');
  assert.equal(catalogValidator(catalog), true, 'pinned data reader rejected isolated catalog');
  if (pointOnly) assert.deepEqual(Object.keys(catalog.components), [`point-${MODEL}`],
    'recurring catalog must contain only the point component');
  const catalogBody = Buffer.from(`${JSON.stringify(catalog)}\n`), catalogSha256 = hash(catalogBody);
  markPublication(trace, 'catalog-write');
  await io.immutable(DATA, catalogKey, catalogBody, { sha256: catalogSha256 });
  markPublication(trace, 'lease');
  assert.ok(finiteTime(q.freshUntil, 'forecast expiry') - now() >= policy.minimumForecastLeaseHours * 3600_000,
    'candidate lease expired before isolated selection write');
  const selection = { schemaVersion: 1, kind: 'weatherx-staging-native-wind100-selection',
    status: 'DATA_QUALIFIED_NOT_ACTIVATED', targetOrigin: 'https://staging.weatherx.org', model: MODEL,
    runId: q.runId, catalogId, catalogSha256, sourceSha: request.sourceSha,
    inputSha256: q.inputSha256, invocation: request.invocation,
    ...(pointOnly ? { publicationMode: policy.recurringPublicationMode } : {}),
    qualificationCanonicalSha256: hash(JSON.stringify(q)), initializedAt: q.initializedAt,
    freshUntil: q.freshUntil, createdAt: completedAt, isolatedStagingCandidate: true,
    sharedReadPinChanged: false, productionWritten: false, activated: false };
  assert.match(selection.inputSha256, SHA, 'candidate sealed input SHA-256 is invalid');
  const selectionBody = Buffer.from(`${JSON.stringify(selection)}\n`);
  markPublication(trace, 'selection-write');
  await io.immutable(DATA, selectionKey, selectionBody, { sha256: hash(selectionBody) });
  markPublication(trace, 'receipt');
  return selection;
}

function validateSelectedCatalog(selection, catalog, catalogValidator) {
  assert.equal(catalogValidator(catalog), true, 'selected catalog is not reader-qualified');
  if (selection.publicationMode === RECURRING_PUBLICATION_MODE) {
    assert.deepEqual(Object.keys(catalog.components ?? {}), [`point-${MODEL}`],
      'recurring selection is not bound to an exact point-only catalog');
    const point = catalog.components[`point-${MODEL}`];
    assert.equal(point.componentId, `point-${MODEL}`);
    assert.deepEqual(point.mounts, [`point-series/v2/${MODEL}/`]);
    assert.equal(finiteTime(point.generationTime, 'point component generation'),
      finiteTime(selection.initializedAt, 'selection initialization'));
    assert.equal(point.pointSeries?.schemaVersion, 1);
    assert.equal(point.pointSeries?.modelId, MODEL);
    const descriptor = point.pointSeries.descriptor;
    assert.equal(descriptor.runId, selection.runId);
    assert.equal(descriptor.initializedAt, selection.initializedAt);
    assert.equal(descriptor.freshUntil, selection.freshUntil);
    assert.equal(descriptor.source, POINT_SOURCE);
    assert.deepEqual(descriptor.variables?.wind_speed, { kind: 'instantaneous', units: 'm/s' });
    assert.deepEqual(descriptor.variables?.wind_speed_100m, { kind: 'instantaneous', units: 'm/s' });
  }
  return true;
}

export async function loadCatalogValidator(sourceRoot) {
  const root = realpathSync(sourceRoot);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier.startsWith('.') && context.parentURL?.startsWith('file:') && new URL(context.parentURL).pathname.endsWith('.ts')) {
        const candidate = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
        if (existsSync(candidate)) return next(`${specifier}.ts`, context);
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (url.startsWith('file:') && new URL(url).pathname.endsWith('.ts')) return {
        format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true,
      };
      return next(url, context);
    },
  });
  try {
    const module = await import(`${pathToFileURL(resolve(root, 'platform/edge/src/catalog.ts')).href}?wind100=${Date.now()}`);
    return { validate: module.isDataCatalog, close: () => hooks.deregister() };
  } catch (error) { hooks.deregister(); throw error; }
}

export async function createCandidateS3(env, request, injectedClient, injectedSdk) {
  assert.equal(env.STAGING_R2_ACCOUNT_ID, ACCOUNT);
  const sdk = injectedSdk ?? await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
  const client = injectedClient ?? new sdk.S3Client({ region: 'auto', endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.STAGING_R2_WRITE_ACCESS_KEY_ID, secretAccessKey: env.STAGING_R2_WRITE_SECRET_ACCESS_KEY } });
  const pointManifest = request.publicationMode === RECURRING_PUBLICATION_MODE
    ? `${RECURRING_COMPONENT_PREFIX}${request.invocation}/component.json`
    : `components/point-${MODEL}/stage-wind100-point-${MODEL}-${request.invocation}/component.json`;
  const mapManifest = `components/${MODEL}/stage-wind100-${MODEL}-${request.invocation}/component.json`;
  const allowedComponent = key => key === pointManifest
    || (request.publicationMode === undefined && key === mapManifest);
  const keys = candidateKeys(request);
  function target(bucket, key, write = false) {
    safeKey(key); assert.ok(bucket === DATA || bucket === COMPONENTS, 'staging buckets only');
    if (bucket === COMPONENTS) assert.ok(!write && allowedComponent(key), 'component manifests are read-only here');
    else assert.ok(write && (key === keys.catalogKey || key === keys.selectionKey), 'serving and foreign metadata paths forbidden');
    return { Bucket: bucket, Key: key };
  }
  async function send(command, missing = false) {
    try { return await client.send(command, { abortSignal: AbortSignal.timeout(120_000) }); }
    catch (error) { if (missing && error?.$metadata?.httpStatusCode === 404) return null; throw Error(error?.$metadata?.httpStatusCode === 412 ? 'immutable staging collision' : 'staging object operation failed'); }
  }
  async function get(bucket, key, maxBytes) {
    assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_JSON_BYTES);
    const object = await send(new sdk.GetObjectCommand(target(bucket, key)), true); if (!object) return null;
    const chunks = []; let bytes = 0; const digest = createHash('sha256');
    try { assert.ok(Number.isSafeInteger(object.ContentLength) && object.ContentLength > 0 && object.ContentLength <= maxBytes);
      for await (const chunk of object.Body) { bytes += chunk.length; assert.ok(bytes <= maxBytes); const part = Buffer.from(chunk); chunks.push(part); digest.update(part); }
      assert.equal(bytes, object.ContentLength); return { body: Buffer.concat(chunks), sha256: digest.digest('hex'), metadata: object.Metadata ?? {},
        httpMetadata: { contentType: object.ContentType, cacheControl: object.CacheControl, contentEncoding: object.ContentEncoding } };
    } finally { object.Body?.destroy?.(); }
  }
  async function immutable(bucket, key, body, metadata) {
    target(bucket, key, true); assert.ok(Buffer.isBuffer(body) && body.length > 0 && body.length <= MAX_JSON_BYTES);
    try { await send(new sdk.PutObjectCommand({ ...target(bucket, key, true), Body: body, ContentLength: body.length,
      IfNoneMatch: '*', Metadata: metadata, ContentType: 'application/json', CacheControl: CACHE })); }
    catch (error) { if (error.message !== 'immutable staging collision') throw error; }
    const saved = await getForData(bucket, key, body.length); assert.ok(saved); assert.deepEqual(saved.body, body);
    assert.deepEqual(saved.metadata, metadata); assert.deepEqual(saved.httpMetadata,
      { contentType: 'application/json', cacheControl: CACHE, contentEncoding: undefined });
  }
  async function getForData(bucket, key, maxBytes) {
    // Readback is limited to this invocation's immutable candidate objects.
    assert.equal(bucket, DATA); assert.ok(key === keys.catalogKey || key === keys.selectionKey);
    const object = await send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }), true); if (!object) return null;
    const chunks = []; let bytes = 0; const digest = createHash('sha256');
    try { assert.ok(Number.isSafeInteger(object.ContentLength) && object.ContentLength > 0 && object.ContentLength <= maxBytes);
      for await (const chunk of object.Body) { bytes += chunk.length; assert.ok(bytes <= maxBytes); const part = Buffer.from(chunk); chunks.push(part); digest.update(part); }
      assert.equal(bytes, object.ContentLength); return { body: Buffer.concat(chunks), sha256: digest.digest('hex'), metadata: object.Metadata ?? {},
        httpMetadata: { contentType: object.ContentType, cacheControl: object.CacheControl, contentEncoding: object.ContentEncoding } };
    } finally { object.Body?.destroy?.(); }
  }
  return { get, immutable, close: () => client.destroy?.() };
}

export async function createPointerS3(env, injectedClient, injectedSdk) {
  assert.equal(env.STAGING_R2_ACCOUNT_ID, ACCOUNT);
  const sdk = injectedSdk ?? await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
  const client = injectedClient ?? new sdk.S3Client({ region: 'auto', endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.STAGING_R2_WRITE_ACCESS_KEY_ID, secretAccessKey: env.STAGING_R2_WRITE_SECRET_ACCESS_KEY } });
  function admitted(key, write = false) {
    safeKey(key);
    if (write) assert.equal(key, POINTER_KEY, 'only the Wind100 serving pointer is mutable');
    else assert.ok(key === POINTER_KEY
      || /^catalogs\/snapshots\/stage-wind100(?:-recurring)?-[1-9]\d{0,19}-[1-9]\d{0,5}\.json$/.test(key)
      || /^staging-candidates\/wind100\/stage-wind100(?:-recurring)?-[1-9]\d{0,19}-[1-9]\d{0,5}\/selection\.json$/.test(key),
    'pointer controller read escaped its namespace');
    return { Bucket: DATA, Key: key };
  }
  async function get(key, maximum = MAX_POINTER_BYTES) {
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_JSON_BYTES);
    let object;
    try { object = await client.send(new sdk.GetObjectCommand(admitted(key)), { abortSignal: AbortSignal.timeout(120_000) }); }
    catch (error) { if (error?.$metadata?.httpStatusCode === 404) return null; throw Error('staging pointer read failed'); }
    const chunks = []; let bytes = 0;
    try {
      assert.ok(Number.isSafeInteger(object.ContentLength) && object.ContentLength > 0 && object.ContentLength <= maximum);
      for await (const chunk of object.Body) { bytes += chunk.length; assert.ok(bytes <= maximum); chunks.push(Buffer.from(chunk)); }
      assert.equal(bytes, object.ContentLength);
      return { body: Buffer.concat(chunks), etag: object.ETag };
    } finally { object.Body?.destroy?.(); }
  }
  async function put(body, etag) {
    assert.ok(Buffer.isBuffer(body) && body.length > 0 && body.length <= MAX_POINTER_BYTES);
    const conditional = etag == null ? { IfNoneMatch: '*' } : { IfMatch: etag };
    try {
      await client.send(new sdk.PutObjectCommand({ ...admitted(POINTER_KEY, true), Body: body,
        ContentLength: body.length, ContentType: 'application/json', CacheControl: 'public, max-age=30, must-revalidate',
        Metadata: { sha256: hash(body) }, ...conditional }), { abortSignal: AbortSignal.timeout(120_000) });
      return true;
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 412) return false;
      throw Error('staging pointer write failed');
    }
  }
  return { get, put, close: () => client.destroy?.() };
}

export async function activateCandidate({ selection, selectionSha256, io, now = Date.now, policy = readPolicy(),
  catalogValidator = () => true }) {
  const entry = pointerEntry(selection, selectionSha256);
  assert.ok(finiteTime(entry.freshUntil, 'forecast expiry') - now() >= policy.minimumForecastLeaseHours * 3600_000,
    'candidate lacks minimum lease before pointer rotation');
  const savedSelection = await io.get(entry.selectionKey, MAX_JSON_BYTES);
  assert.ok(savedSelection && hash(savedSelection.body) === entry.selectionSha256);
  assert.deepEqual(JSON.parse(savedSelection.body), selection, 'immutable selection differs before activation');
  assert.equal(selection.publicationMode, policy.recurringPublicationMode,
    'dynamic pointer accepts only recurring point-only selections');
  const catalogKey = `catalogs/snapshots/${entry.catalogId}.json`;
  const savedCatalog = await io.get(catalogKey, MAX_JSON_BYTES);
  assert.ok(savedCatalog && hash(savedCatalog.body) === entry.catalogSha256);
  validateSelectedCatalog(selection, JSON.parse(savedCatalog.body), catalogValidator);
  for (let attempt = 0; attempt < 4; attempt++) {
    const observed = await io.get(POINTER_KEY, MAX_POINTER_BYTES);
    const current = observed == null ? null : validateWind100Pointer(JSON.parse(observed.body));
    const same = current?.entries.find(row => row.runId === entry.runId && row.inputSha256 === entry.inputSha256
      && row.sourceSha === entry.sourceSha);
    if (same && JSON.stringify(same) === JSON.stringify(entry)) return current;
    if (same) {
      const priorObject = await io.get(same.selectionKey, MAX_JSON_BYTES);
      assert.ok(priorObject && hash(priorObject.body) === same.selectionSha256,
        'prior same-input selection is unavailable');
      const prior = JSON.parse(priorObject.body);
      assert.deepEqual(pointerEntry(prior, same.selectionSha256), same,
        'prior same-input selection differs from its pointer entry');
      assert.notEqual(prior.publicationMode, policy.recurringPublicationMode,
        'same reviewed point-only input has a different immutable candidate');
    }
    const updatedAt = new Date(now()).toISOString();
    const next = nextWind100Pointer(current, entry, updatedAt);
    const body = Buffer.from(`${JSON.stringify(next)}\n`);
    if (!await io.put(body, observed?.etag ?? null)) continue;
    const readback = await io.get(POINTER_KEY, MAX_POINTER_BYTES);
    assert.ok(readback); assert.deepEqual(readback.body, body, 'Wind100 pointer readback differs');
    return next;
  }
  throw Error('Wind100 pointer changed during all bounded CAS attempts');
}

export async function findQualifiedInput({ runId, inputSha256, sourceSha, io, policy = readPolicy(),
  catalogValidator = () => true }) {
  sourceSha ??= policy.sourceSha;
  assert.match(runId ?? '', RUN); assert.match(inputSha256 ?? '', SHA); assert.match(sourceSha ?? '', COMMIT);
  const saved = await io.get(POINTER_KEY, MAX_POINTER_BYTES);
  if (!saved) return { status: 'new-input', runId, inputSha256 };
  const pointer = validateWind100Pointer(JSON.parse(saved.body));
  const entry = pointer.entries.find(row => row.runId === runId && row.inputSha256 === inputSha256
    && row.sourceSha === sourceSha);
  if (!entry) return { status: 'new-input', runId, inputSha256 };
  const selectionObject = await io.get(entry.selectionKey, MAX_JSON_BYTES);
  assert.ok(selectionObject && hash(selectionObject.body) === entry.selectionSha256);
  const selection = JSON.parse(selectionObject.body);
  assert.deepEqual(pointerEntry(selection, entry.selectionSha256), entry,
    'selected immutable candidate differs from the serving pointer');
  if (selection.publicationMode !== policy.recurringPublicationMode) {
    return { status: 'new-input', runId, inputSha256 };
  }
  const catalogObject = await io.get(`catalogs/snapshots/${entry.catalogId}.json`, MAX_JSON_BYTES);
  assert.ok(catalogObject && hash(catalogObject.body) === entry.catalogSha256);
  validateSelectedCatalog(selection, JSON.parse(catalogObject.body), catalogValidator);
  return { status: 'unchanged', runId, inputSha256, freshUntil: entry.freshUntil,
    catalogId: entry.catalogId, selectionSha256: entry.selectionSha256 };
}

function saveReceipt(env, receipt) {
  const root = resolve(env.RUNNER_TEMP, 'staging-wind100');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = resolve(root, 'qualification.json');
  assert.ok(!existsSync(path));
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function privateJson(tempRoot, relativePath, maximum = 8 * 1024 * 1024) {
  const path = regularFile(realpathSync(tempRoot), relativePath);
  const bytes = boundedRead(path, maximum, 'private evidence file');
  return JSON.parse(bytes);
}

export async function main(command, env = process.env, argv = process.argv.slice(3), trace = null) {
  if (command === 'digest') return { sha256: controllerDigest() };
  const policy = readPolicy();
  if (command === 'gate') return gate(env, policy);
  if (command === 'hydrate-gate') return gate(env, policy, controllerDigest(), 'hydrate');
  if (command === 'component-gate') return gate(env, policy, controllerDigest(), 'components');
  if (command === 'recurring-gate') return recurringGate(env, policy);
  if (command === 'recurring-component-gate') return recurringGate(env, policy, controllerDigest(), 'components');
  if (command === 'recurring-retention-gate') {
    recurringGate(env, policy, controllerDigest(), 'components');
    const existing = await listRecurringPrefixS3(env);
    return recurringPrefixCapacity(existing, privateJson(env.RUNNER_TEMP, argv[0]), argv[1], policy);
  }
  if (command === 'source') return verifySource(argv[0], policy);
  if (command === 'preflight') {
    recurringGate(env, policy, controllerDigest(), 'metadata');
    assert.match(env.WIND100_RUN_ID ?? '', RUN); assert.match(env.WIND100_INPUT_SHA256 ?? '', SHA);
    const validator = await loadCatalogValidator(argv[0]);
    const io = await createPointerS3(env);
    try { return await findQualifiedInput({ runId: env.WIND100_RUN_ID, inputSha256: env.WIND100_INPUT_SHA256,
      sourceSha: policy.sourceSha,
      io, policy, catalogValidator: validator.validate }); }
    finally { validator.close(); io.close(); }
  }
  if (command === 'qualify' || command === 'qualify-recurring') {
    markQualification(trace, 'gate');
    const digest = controllerDigest();
    const recurring = command === 'qualify-recurring';
    const request = recurring ? recurringGate(env, policy, digest) : gate(env, policy, digest);
    if (trace) trace.controllerSha256 = digest;
    markQualification(trace, 'evidence');
    const sourceEvidence = privateJson(env.RUNNER_TEMP, argv[1]);
    assert.deepEqual(sourceBytes(argv[0], policy), sourceEvidence,
      'reviewed source bytes changed after pre-collection verification');
    const structuralReport = privateJson(env.RUNNER_TEMP, argv[4]);
    const mapProof = recurring ? null : privateJson(env.RUNNER_TEMP, argv[5]);
    const sealedManifest = recurring ? null
      : JSON.parse(boundedRead(regularFile(realpathSync(argv[6]), 'manifest.json'), 8 * 1024 * 1024, 'sealed manifest'));
    const augmentationReceipt = recurring ? privateJson(env.RUNNER_TEMP, argv[5]) : null;
    const inputHandoff = recurring ? privateJson(env.RUNNER_TEMP, argv[6]) : null;
    const inputManifest = recurring ? privateJson(env.RUNNER_TEMP, argv[7]) : null;
    const receipt = await qualifyPointPacks({
      stageRoot: argv[2], pointRoot: argv[3], model: request.model, policy, structuralReport, sourceEvidence,
      mapProof, mapRoot: resolve(argv[0], 'app/public/data/ecmwf'), sealedManifest,
      augmentationReceipt, inputHandoff, inputManifest, request, trace,
    });
    receipt.invocation = request.invocation;
    saveReceipt(env, receipt);
    return receipt;
  }
  if (command === 'publish' || command === 'publish-recurring') {
    markPublication(trace, 'gate');
    const digest = controllerDigest();
    const recurring = command === 'publish-recurring';
    const request = recurring ? recurringGate(env, policy, digest, 'metadata') : gate(env, policy, digest, 'metadata');
    if (trace) trace.controllerSha256 = digest;
    markPublication(trace, 'evidence');
    const qualification = privateJson(env.RUNNER_TEMP, argv[0]);
    const mapReceipt = recurring ? null : privateJson(env.RUNNER_TEMP, argv[1]);
    const pointReceipt = privateJson(env.RUNNER_TEMP, argv[recurring ? 1 : 2]);
    const sourceRoot = argv[recurring ? 2 : 3];
    markPublication(trace, 'source-evidence');
    assert.deepEqual(sourceBytes(sourceRoot, policy), privateJson(env.RUNNER_TEMP, 'weatherx-wind100-source.json'),
      'validator source closure changed before isolated publication');
    markPublication(trace, 'reader');
    const validator = await loadCatalogValidator(sourceRoot);
    markPublication(trace, 'transport');
    const io = await createCandidateS3(env, request);
    try { return await prepareCandidate({ request, qualification, mapReceipt, pointReceipt, io, policy,
      catalogValidator: validator.validate, trace }); }
    finally { validator.close(); io.close(); }
  }
  if (command === 'activate') {
    const digest = controllerDigest(); recurringGate(env, policy, digest, 'metadata');
    const selection = privateJson(env.RUNNER_TEMP, argv[0]);
    const selectionBody = Buffer.from(`${JSON.stringify(selection)}\n`);
    const validator = await loadCatalogValidator(argv[1]);
    const io = await createPointerS3(env);
    try { return await activateCandidate({ selection, selectionSha256: hash(selectionBody), io, policy,
      catalogValidator: validator.validate }); }
    finally { validator.close(); io.close(); }
  }
  throw Error('usage: staging-wind100.mjs digest | gate | recurring-gate | recurring-retention-gate QUALIFICATION POINT_ROOT | source SOURCE | qualify[...] | publish[...] | activate SELECTION_REL SOURCE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const command = process.argv[2];
  const trace = command === 'qualify' || command === 'qualify-recurring' ? createQualificationTrace()
    : command === 'publish' || command === 'publish-recurring' ? createPublicationTrace() : null;
  main(command, process.env, process.argv.slice(3), trace).then(value => console.log(JSON.stringify(value)))
    .catch(error => {
      if (trace) {
        const diagnostic = command === 'qualify' ? qualificationFailureDiagnostic : publicationFailureDiagnostic;
        console.error(`Staging wind100 diagnostic ${JSON.stringify(diagnostic(
          error, trace, safeProperty(trace, 'controllerSha256')))}`);
      }
      console.error('Staging wind100 refused; no serving pointer or production object changed.');
      process.exitCode = 1;
    });
}
