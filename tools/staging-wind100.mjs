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

export const SOURCE_SHA = '9423990ed998fdf37ba10143cad67cb9ab8ac713';
export const CONFIRMATION = 'native-wind100-staging-only';
export const DATA = 'weatherx-data-staging';
export const COMPONENTS = 'weatherx-components-staging';
export const MODEL = 'ecmwf';
export const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
const WORKFLOW = `${REPOSITORY}/.github/workflows/staging-wind100.yml@refs/heads/main`;
const SHA = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const RUN = /^\d{10}$/;
const MISSING = -32768;
const MAX_PACK_BYTES = 512 * 1024;
const MAX_UNPACKED_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
const CACHE = 'public, max-age=31536000, immutable';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTROLLER_FILES = [
  '.github/workflows/staging-wind100.yml',
  'tools/staging-wind100-policy.json',
  'tools/staging-wind100.mjs',
  'tools/staging-wind100-python.py',
  'tools/staging-wind100-requirements.txt',
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

export function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

function filesUnder(root, maximumEntries, maximumDepth) {
  assert.ok(Number.isSafeInteger(maximumEntries) && maximumEntries > 0);
  assert.ok(Number.isSafeInteger(maximumDepth) && maximumDepth >= 0);
  const found = [];
  let entries = 0;
  function visit(directory, depth) {
    assert.ok(depth <= maximumDepth, 'candidate directory depth exceeds its fixed budget');
    const handle = opendirSync(directory);
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        entries++;
        assert.ok(entries <= maximumEntries, 'candidate traversal exceeds its fixed entry budget');
        const path = resolve(directory, entry.name);
        const stat = lstatSync(path);
        assert.ok(!stat.isSymbolicLink(), 'point candidate must not contain symlinks');
        if (stat.isDirectory()) visit(path, depth + 1);
        else {
          assert.ok(stat.isFile() && stat.nlink === 1, 'point candidate must contain ordinary single-link files');
          found.push(relative(root, path).replaceAll('\\', '/'));
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  visit(root, 0);
  return found.sort();
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

async function directoryInventory(root, maximumEntries = 10_000) {
  const directory = realpathSync(root), rows = []; let totalBytes = 0;
  for (const path of filesUnder(directory, maximumEntries, 8)) {
    const absolute = regularFile(directory, path), size = lstatSync(absolute).size;
    assert.ok(size > 0 && size <= 512 * 1024 * 1024, 'component file is empty or oversized');
    totalBytes += size; assert.ok(totalBytes <= 32 * 1024 * 1024 * 1024, 'component tree is oversized');
    rows.push({ path, size, sha256: await fileHash(absolute) });
  }
  assert.ok(rows.length > 0); return { objectCount: rows.length, inventorySha256: hash(JSON.stringify(rows)), inventory: rows };
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
  sourceEvidence, mapProof, mapRoot, sealedManifest, request = { sourceSha: policy.sourceSha, invocation: 'fixture-1' }, now = Date.now() }) {
  assert.equal(model, MODEL);
  const sourceClosure = validatedSourceEvidence(sourceEvidence, policy);
  const root = realpathSync(pointRoot);
  const catalogPath = regularFile(root, 'v2/catalog.json');
  const catalogBytes = boundedRead(catalogPath, 512 * 1024, 'point catalog');
  const catalog = JSON.parse(catalogBytes);
  const descriptor = validateDescriptor(catalog, model, policy);
  const stage = loadStage(stageRoot, model, descriptor);
  const chunksX = Math.ceil(descriptor.grid.width / descriptor.chunk.width);
  const chunksY = Math.ceil(descriptor.grid.height / descriptor.chunk.height);
  const expectedPacks = [];
  for (let chunkY = 0; chunkY < chunksY; chunkY++) {
    for (let chunkX = 0; chunkX < chunksX; chunkX++) {
      expectedPacks.push(`v2/${model}/${descriptor.runId}/chunks/${chunkY}/${chunkX}.bin.gz`);
    }
  }
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
      }
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
  assert.deepEqual(structuralReport?.models, { [model]: descriptor });
  assert.equal(structuralReport.schemaVersion, 2);
  assert.equal(structuralReport.objectCount, validatorObjects.length);
  assert.deepEqual(structuralReport.objects, validatorObjects,
    'reviewed structural validator report differs from actual point bytes');
  assert.equal(structuralReport.manifestSha256, hash(JSON.stringify(validatorObjects)),
    'reviewed structural validator digest differs from actual point bytes');

  const stageInventory = [];
  for (const path of filesUnder(stage.stage, fieldIds.length + 1, 1)) {
    const absolute = regularFile(stage.stage, path);
    const stat = lstatSync(absolute);
    stageInventory.push({ path, bytes: stat.size, sha256: await fileHash(absolute) });
  }
  stageInventory.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const map = { ...validateMapProof(mapProof, descriptor, policy), ...await directoryInventory(mapRoot) };
  const seal = validateSeal(sealedManifest, stageInventory, request, descriptor);
  assert.ok(finiteTime(descriptor.freshUntil, 'forecast expiry') - now >= policy.minimumForecastLeaseHours * 3600_000,
    'candidate lacks the minimum forecast lease');
  return {
    schemaVersion: 2,
    kind: 'weatherx-staging-native-wind100-point-candidate',
    status: 'CREDENTIAL_FREE_POINT_PACK_INTEGRITY_QUALIFIED_NOT_PUBLISHED',
    model,
    sourceSha: policy.sourceSha,
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
    map,
    sealedArtifact: seal,
    credentialFreeIntegrityQualification: true,
    decodedProviderSemanticsVerified: true,
    existingMapAndPointScienceGatesPassed: true,
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

function componentManifest(value, id, receipt, qualification, now) {
  assert.deepEqual(Object.keys(receipt ?? {}).sort(),
    ['expectedPreviousManifestSha256', 'expectedRollbackEpoch', 'manifestKey', 'manifestSha256'].sort());
  assert.equal(receipt.expectedPreviousManifestSha256, null);
  assert.equal(receipt.expectedRollbackEpoch, 0);
  assert.match(receipt.manifestSha256 ?? '', SHA);
  const artifact = `stage-wind100-${id}-${qualification.invocation}`;
  const rootPrefix = `components/${id}/${artifact}/`;
  assert.equal(receipt.manifestKey, `${rootPrefix}component.json`);
  assert.deepEqual(Object.keys(value ?? {}).sort(), [
    'artifactId', 'completedAt', 'componentId', 'generationTime', 'inventorySha256', 'mounts',
    'objectCount', 'quality', 'rootPrefix', 'schemaVersion', ...(id === `point-${MODEL}` ? ['pointSeries'] : []),
  ].sort());
  assert.equal(value.schemaVersion, 1); assert.equal(value.componentId, id); assert.equal(value.artifactId, artifact);
  assert.equal(value.rootPrefix, rootPrefix); assert.equal(finiteTime(value.generationTime, 'component generation'), finiteTime(qualification.initializedAt, 'qualification initialization'));
  assert.ok(finiteTime(value.completedAt, 'component completion') >= finiteTime(qualification.initializedAt, 'qualification initialization'));
  assert.ok(finiteTime(value.completedAt, 'component completion') <= now, 'component completion is in the future');
  assert.ok(Number.isSafeInteger(value.objectCount) && value.objectCount > 0 && value.objectCount <= 10_000);
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
  for (const key of ['credentialFreeIntegrityQualification', 'decodedProviderSemanticsVerified',
    'existingMapAndPointScienceGatesPassed', 'dependencyClosureApproved']) assert.equal(q[key], true, key);
  for (const key of ['scientificRangePolicyApproved', 'stagingCatalogPrepared', 'sharedReadCanaryActivated', 'productionWritten']) assert.equal(q[key], false, key);
  assert.deepEqual(q.pointPacks.descriptor.fieldSemantics,
    expectedSemantics(q.initializedAt, expectedSteps(MODEL, policy), policy));
  assert.ok(finiteTime(q.freshUntil, 'forecast expiry') - now >= policy.minimumForecastLeaseHours * 3600_000,
    'candidate lacks minimum lease at publication boundary');
  return q;
}

function candidateKeys(request) {
  const catalogId = `stage-wind100-${request.invocation}`;
  assert.match(catalogId, /^stage-wind100-[1-9]\d{0,19}-[1-9]\d{0,5}$/);
  return { catalogId, catalogKey: `catalogs/snapshots/${catalogId}.json`,
    selectionKey: `staging-candidates/wind100/${catalogId}/selection.json` };
}

export async function prepareCandidate({ request, qualification, mapReceipt, pointReceipt, io,
  policy = readPolicy(), now = Date.now, catalogValidator = () => true }) {
  const firstNow = now(), q = validateQualification(qualification, request, policy, firstNow);
  const manifests = {};
  for (const [id, receipt] of [[MODEL, mapReceipt], [`point-${MODEL}`, pointReceipt]]) {
    const object = await io.get(COMPONENTS, receipt.manifestKey, MAX_JSON_BYTES);
    assert.ok(object, `missing ${id} component manifest`); assert.equal(object.sha256, receipt.manifestSha256);
    assert.deepEqual(object.metadata, {}); assert.equal(object.httpMetadata.contentEncoding, undefined);
    assert.ok(object.httpMetadata.contentType == null || object.httpMetadata.contentType === 'application/json');
    assert.ok(object.httpMetadata.cacheControl == null || object.httpMetadata.cacheControl === CACHE);
    manifests[id] = componentManifest(JSON.parse(object.body), id, receipt, q, now());
  }
  assert.equal(manifests[MODEL].generationTime, manifests[`point-${MODEL}`].generationTime);
  assert.ok(finiteTime(q.freshUntil, 'forecast expiry') - now() >= policy.minimumForecastLeaseHours * 3600_000,
    'candidate lease expired during component readback');
  const { catalogId, catalogKey, selectionKey } = candidateKeys(request);
  const completedAt = new Date(now()).toISOString();
  const catalog = { schemaVersion: 2, sequence: 1, parentCatalogId: null, createdAt: completedAt,
    components: manifests, rollbackEpoch: 0 };
  assert.equal(catalogValidator(catalog), true, 'pinned data reader rejected isolated catalog');
  const catalogBody = Buffer.from(`${JSON.stringify(catalog)}\n`), catalogSha256 = hash(catalogBody);
  await io.immutable(DATA, catalogKey, catalogBody, { sha256: catalogSha256 });
  assert.ok(finiteTime(q.freshUntil, 'forecast expiry') - now() >= policy.minimumForecastLeaseHours * 3600_000,
    'candidate lease expired before isolated selection write');
  const selection = { schemaVersion: 1, kind: 'weatherx-staging-native-wind100-selection',
    status: 'DATA_QUALIFIED_NOT_ACTIVATED', targetOrigin: 'https://staging.weatherx.org', model: MODEL,
    catalogId, catalogSha256, sourceSha: request.sourceSha, invocation: request.invocation,
    qualificationCanonicalSha256: hash(JSON.stringify(q)), initializedAt: q.initializedAt,
    freshUntil: q.freshUntil, createdAt: completedAt, isolatedStagingCandidate: true,
    sharedReadPinChanged: false, productionWritten: false, activated: false };
  const selectionBody = Buffer.from(`${JSON.stringify(selection)}\n`);
  await io.immutable(DATA, selectionKey, selectionBody, { sha256: hash(selectionBody) });
  return selection;
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
  const allowedComponent = key => [MODEL, `point-${MODEL}`].some(id => key === `components/${id}/stage-wind100-${id}-${request.invocation}/component.json`);
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

export async function main(command, env = process.env, argv = process.argv.slice(3)) {
  if (command === 'digest') return { sha256: controllerDigest() };
  const policy = readPolicy();
  if (command === 'gate') return gate(env, policy);
  if (command === 'hydrate-gate') return gate(env, policy, controllerDigest(), 'hydrate');
  if (command === 'component-gate') return gate(env, policy, controllerDigest(), 'components');
  if (command === 'source') return verifySource(argv[0], policy);
  if (command === 'qualify') {
    const request = gate(env, policy);
    const sourceEvidence = privateJson(env.RUNNER_TEMP, argv[1]);
    assert.deepEqual(sourceBytes(argv[0], policy), sourceEvidence,
      'reviewed source bytes changed after pre-collection verification');
    const structuralReport = privateJson(env.RUNNER_TEMP, argv[4]);
    const mapProof = privateJson(env.RUNNER_TEMP, argv[5]);
    const sealedManifest = JSON.parse(boundedRead(regularFile(realpathSync(argv[6]), 'manifest.json'), 8 * 1024 * 1024, 'sealed manifest'));
    const receipt = await qualifyPointPacks({
      stageRoot: argv[2], pointRoot: argv[3], model: request.model, policy, structuralReport, sourceEvidence,
      mapProof, mapRoot: resolve(argv[0], 'app/public/data/ecmwf'), sealedManifest, request,
    });
    receipt.invocation = request.invocation;
    saveReceipt(env, receipt);
    return receipt;
  }
  if (command === 'publish') {
    const request = gate(env, policy, controllerDigest(), 'metadata');
    const qualification = privateJson(env.RUNNER_TEMP, argv[0]);
    const mapReceipt = privateJson(env.RUNNER_TEMP, argv[1]);
    const pointReceipt = privateJson(env.RUNNER_TEMP, argv[2]);
    assert.deepEqual(sourceBytes(argv[3], policy), privateJson(env.RUNNER_TEMP, 'weatherx-wind100-source.json'),
      'validator source closure changed before isolated publication');
    const validator = await loadCatalogValidator(argv[3]);
    const io = await createCandidateS3(env, request);
    try { return await prepareCandidate({ request, qualification, mapReceipt, pointReceipt, io, policy,
      catalogValidator: validator.validate }); }
    finally { validator.close(); io.close(); }
  }
  throw Error('usage: staging-wind100.mjs digest | gate | source SOURCE | qualify SOURCE SOURCE_EVIDENCE_REL STAGE_ROOT POINT_ROOT STRUCTURAL_REPORT_REL MAP_PROOF_REL SEALED_MODEL_ROOT | publish QUALIFICATION_REL MAP_RECEIPT_REL POINT_RECEIPT_REL');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).then(value => console.log(JSON.stringify(value)))
    .catch(() => { console.error('Staging wind100 refused; no serving pointer or production object changed.'); process.exitCode = 1; });
}
