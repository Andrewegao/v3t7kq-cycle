#!/usr/bin/env node
// Production-only native Wind100 control. This file never promotes catalogs/current.json.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCatalogValidator, qualifyPointPacks, readPolicy as readIntegrityPolicy,
  sealedPointInputSha, verifySource } from './staging-wind100.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
const BAKE_WORKFLOW = `${REPOSITORY}/.github/workflows/bake.yml@refs/heads/main`;
const SOURCE = 'ECMWF IFS 0.25 degree direct open-data GRIB';
const SHA = /^[a-f0-9]{64}$/;
const RUN = /^\d{10}$/;
const INVOCATION = /^[1-9]\d{0,19}-[1-9]\d{0,5}$/;
const CATALOG = /^prod-wind100-recurring-[1-9]\d{0,19}-[1-9]\d{0,5}$/;
const CACHE = 'public, max-age=31536000, immutable';
const MAX_JSON = 512 * 1024;
const MAX_POINTER = 16 * 1024;
export const POINTER_KEY = 'production-candidates/wind100/current-v1.json';
export const JOURNAL_PREFIX = 'production-candidates/wind100/journal/';
export const JOURNAL_KIND = 'weatherx-production-native-wind100-pointer-journal';
export const POINTER_KIND = 'weatherx-production-native-wind100-pointer';
export const SELECTION_KIND = 'weatherx-production-native-wind100-selection';
export const ORIGIN = 'https://weatherx.org';
export const DATA = 'weatherx-data-production';
export const COMPONENTS = 'weatherx-components-production';
export const COMPONENT_PREFIX = 'components/point-ecmwf/prod-wind100-recurring-point-ecmwf-';
const CONTROL_FILES = [
  '.github/workflows/bake.yml',
  '.github/workflows/production-wind100-retention.yml',
  'docs/production-wind100-retention.md',
  '.github/workflows/production-wind100-recurring.yml', 'tools/production-wind100-policy.json',
  'tools/production-wind100.mjs', 'tools/staging-wind100.mjs', 'tools/staging-wind100-policy.json',
  'tools/production-wind100-retention.mjs',
  'tools/staging-wind100-python.py', 'tools/staging-wind100-requirements.txt',
];
const FORBIDDEN = [
  'R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY',
  'STAGING_R2_WRITE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_SECRET_ACCESS_KEY',
  'CATALOG_ENDPOINT_PRODUCTION', 'CATALOG_PROMOTION_KEY_PRODUCTION',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_DATA_EDGE_API_TOKEN',
  'STAGING_WORKER_API_TOKEN', 'UI_STAGING_PAGES_TOKEN', 'UI_PRODUCTION_PAGES_TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
];

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, fields) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
};
function utc(value) {
  assert.match(value ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  const time = Date.parse(value);
  assert.ok(Number.isFinite(time));
  assert.equal(new Date(time).toISOString(), value.length === 20 ? value.replace('Z', '.000Z') : value);
  return time;
}
function runTime(runId) {
  assert.match(runId ?? '', RUN);
  return utc(`${runId.slice(0, 4)}-${runId.slice(4, 6)}-${runId.slice(6, 8)}T${runId.slice(8)}:00:00Z`);
}
function lease(initializedAt, freshUntil, now, minimumHours = 0) {
  const init = utc(initializedAt), expiry = utc(freshUntil);
  assert.ok(init <= now && expiry > now + minimumHours * 3_600_000);
  assert.ok(expiry <= init + 30 * 3_600_000, 'native forecast exceeds its 30-hour lease');
}
const catalogIdFor = invocation => {
  assert.match(invocation ?? '', INVOCATION);
  return `prod-wind100-recurring-${invocation}`;
};
const selectionKeyFor = catalogId => `production-candidates/wind100/${catalogId}/selection.json`;
const catalogKeyFor = catalogId => `catalogs/snapshots/${catalogId}.json`;

export function readProductionPolicy() {
  const value = JSON.parse(readFileSync(resolve(ROOT, 'tools/production-wind100-policy.json'), 'utf8'));
  exact(value, ['schemaVersion', 'targetOrigin', 'model', 'sourceSha', 'coreSourceSha',
    'dataBucket', 'componentBucket', 'pointerKey', 'componentPrefix', 'catalogPrefix',
    'selectionPrefix', 'publicationMode', 'maximumComponentPrefixObjects',
    'freshnessHours', 'minimumForecastLeaseHours', 'retentionProfileStatus']);
  const integrity = readIntegrityPolicy();
  assert.equal(value.schemaVersion, 1); assert.equal(value.targetOrigin, ORIGIN);
  assert.equal(value.model, 'ecmwf'); assert.equal(value.sourceSha, integrity.sourceSha);
  assert.equal(value.coreSourceSha, integrity.coreSourceSha);
  assert.equal(value.dataBucket, DATA); assert.equal(value.componentBucket, COMPONENTS);
  assert.equal(value.pointerKey, POINTER_KEY); assert.equal(value.componentPrefix, COMPONENT_PREFIX);
  assert.equal(value.catalogPrefix, 'catalogs/snapshots/prod-wind100-recurring-');
  assert.equal(value.selectionPrefix, 'production-candidates/wind100/prod-wind100-recurring-');
  assert.equal(value.publicationMode, 'point-only-recurring-v1');
  assert.equal(value.maximumComponentPrefixObjects, 50_000);
  assert.equal(value.freshnessHours, 30); assert.equal(value.minimumForecastLeaseHours, 6);
  assert.ok(['unavailable-until-pointer-ancestry-gc', 'verified-pointer-ancestry-gc-v1']
    .includes(value.retentionProfileStatus));
  return value;
}

export function controllerDigest(root = ROOT) {
  const digest = createHash('sha256');
  for (const path of [...CONTROL_FILES].sort()) {
    const bytes = readFileSync(resolve(root, path));
    digest.update(`${path}\0${bytes.length}\0`); digest.update(bytes);
  }
  return digest.digest('hex');
}

export function gate(env, phase = 'none', policy = readProductionPolicy(), digest = controllerDigest()) {
  assert.ok(['none', 'metadata', 'component'].includes(phase));
  assert.equal(policy.retentionProfileStatus, 'verified-pointer-ancestry-gc-v1',
    'recurring production Wind100 requires reviewed pointer-ancestry GC');
  assert.equal(env.GITHUB_ACTIONS, 'true'); assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY); assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.ok(['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME));
  assert.equal(env.GITHUB_WORKFLOW_REF, BAKE_WORKFLOW); assert.equal(env.GITHUB_JOB, 'wind100');
  assert.equal(env.WIND100_PRODUCTION_ENVIRONMENT, 'data-production-wind100');
  assert.equal(env.PRODUCTION_WIND100_ENABLED, 'true');
  assert.equal(env.PRODUCTION_WIND100_APPROVED_SOURCE_SHA, policy.sourceSha);
  assert.equal(env.PRODUCTION_WIND100_CONTROLLER_SHA256, digest);
  assert.equal(env.PRODUCTION_WIND100_GC_READY_SHA256, digest,
    'production Wind100 retention resources require an exact reviewed controller digest');
  assert.equal(env.PRODUCTION_WIND100_R2_ACCOUNT_ID, ACCOUNT);
  assert.equal(env.ATMOS_SHA, policy.sourceSha); assert.equal(env.CORE_ATMOS_SHA, policy.coreSourceSha);
  assert.equal(env.MODEL_ID, 'ecmwf');
  assert.match(`${env.GITHUB_RUN_ID ?? ''}-${env.GITHUB_RUN_ATTEMPT ?? ''}`, INVOCATION);
  for (const name of FORBIDDEN) assert.ok(!env[name], `production Wind100 refuses ${name}`);
  if (phase !== 'none') {
    assert.ok(env.PRODUCTION_WIND100_R2_ACCESS_KEY_ID && env.PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY,
      'dedicated production Wind100 writer credentials are required');
  } else {
    assert.ok(!env.PRODUCTION_WIND100_R2_ACCESS_KEY_ID && !env.PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY,
      'writer credentials must not be present before the gate');
  }
  if (phase === 'component') {
    assert.equal(env.RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID, env.PRODUCTION_WIND100_R2_ACCESS_KEY_ID);
    assert.equal(env.RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY, env.PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY);
    assert.equal(env.RCLONE_CONFIG_WEATHERX_ENDPOINT, `https://${ACCOUNT}.r2.cloudflarestorage.com`);
    assert.equal(env.COMPONENT_R2_REMOTE, `weatherx:${COMPONENTS}`);
    assert.equal(env.PROMOTE, '0'); assert.equal(env.CATALOG_ENDPOINT, 'https://invalid.invalid');
    assert.equal(env.CATALOG_PROMOTION_KEY, 'unused-promote-zero');
  } else {
    assert.ok(!env.RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID && !env.RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY);
    assert.ok(!env.CATALOG_ENDPOINT && !env.CATALOG_PROMOTION_KEY);
  }
  return { invocation: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    sourceSha: policy.sourceSha, publicationMode: policy.publicationMode };
}

export function validateQualification(value, request, now = Date.now(), policy = readProductionPolicy()) {
  exact(value, ['schemaVersion', 'kind', 'targetOrigin', 'invocation', 'sourceSha',
    'coreSourceSha', 'inputSha256', 'integrity']);
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, 'weatherx-production-native-wind100-qualification');
  assert.equal(value.targetOrigin, ORIGIN); assert.equal(value.invocation, request.invocation);
  assert.equal(value.sourceSha, policy.sourceSha); assert.equal(value.coreSourceSha, policy.coreSourceSha);
  assert.match(value.inputSha256 ?? '', SHA);
  const q = value.integrity;
  assert.equal(q?.schemaVersion, 2); assert.equal(q.kind, 'weatherx-staging-native-wind100-point-candidate');
  assert.equal(q.status, 'CREDENTIAL_FREE_POINT_PACK_INTEGRITY_QUALIFIED_NOT_PUBLISHED');
  assert.equal(q.model, 'ecmwf'); assert.equal(q.sourceSha, policy.sourceSha);
  assert.equal(q.invocation, request.invocation); assert.equal(q.inputSha256, value.inputSha256);
  assert.equal(q.publicationMode, policy.publicationMode);
  for (const name of ['credentialFreeIntegrityQualification', 'decodedProviderSemanticsVerified',
    'dependencyClosureApproved', 'authenticatedCorePointInput']) assert.equal(q[name], true, name);
  assert.equal(q.productionWritten, false); assert.equal(q.sharedReadCanaryActivated, false);
  assert.equal(q.pointPacks?.allFieldsExactlyMatchSourceStage, true);
  assert.equal(q.native100m?.valuesExactlyMatchSourceStage, true);
  assert.equal(q.native100m?.valuesRepairedOrFilled, false);
  assert.deepEqual(q.native100m?.sourceFields, ['wind100_u', 'wind100_v']);
  assert.ok(Array.isArray(q.native100m?.perLead) && q.native100m.perLead.length === 81);
  assert.ok(q.native100m.perLead.every(row => row.jointCoveragePermille === 1000));
  assert.equal(q.pointPacks.descriptor?.source, SOURCE);
  assert.equal(q.pointPacks.descriptor?.runId, q.runId);
  assert.equal(utc(q.initializedAt), runTime(q.runId));
  assert.equal(q.pointPacks.descriptor?.freshUntil, q.freshUntil);
  lease(q.initializedAt, q.freshUntil, now, policy.minimumForecastLeaseHours);
  return q;
}

export function bindPointIntegrityInvocation(integrity, invocation) {
  assert.match(invocation ?? '', INVOCATION);
  assert.equal(integrity?.invocation, undefined,
    'the shared point qualifier must leave invocation binding to its caller');
  return { ...integrity, invocation };
}

function validateComponent(manifest, receipt, q, invocation, now) {
  const artifact = `prod-wind100-recurring-point-ecmwf-${invocation}`;
  const rootPrefix = `components/point-ecmwf/${artifact}/`;
  exact(receipt, ['expectedPreviousManifestSha256', 'expectedRollbackEpoch', 'manifestKey', 'manifestSha256']);
  assert.equal(receipt.expectedPreviousManifestSha256, null); assert.equal(receipt.expectedRollbackEpoch, 0);
  assert.equal(receipt.manifestKey, `${rootPrefix}component.json`);
  assert.match(receipt.manifestSha256 ?? '', SHA);
  exact(manifest, ['schemaVersion', 'artifactId', 'completedAt', 'componentId', 'generationTime',
    'inventorySha256', 'mounts', 'objectCount', 'quality', 'rootPrefix', 'pointSeries']);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.artifactId, artifact);
  assert.equal(manifest.componentId, 'point-ecmwf'); assert.equal(manifest.rootPrefix, rootPrefix);
  assert.deepEqual(manifest.mounts, ['point-series/v2/ecmwf/']);
  assert.equal(utc(manifest.generationTime), utc(q.initializedAt));
  assert.ok(utc(manifest.completedAt) >= utc(q.initializedAt) && utc(manifest.completedAt) <= now);
  assert.equal(manifest.objectCount, q.pointPacks.objectCount);
  assert.equal(manifest.quality?.status, 'passed');
  for (const check of ['manifest', 'inventory', 'remote_bytes', 'point_series'])
    assert.ok(manifest.quality.checks?.includes(check), `missing component ${check}`);
  assert.equal(manifest.pointSeries?.schemaVersion, 1);
  assert.equal(manifest.pointSeries?.modelId, 'ecmwf');
  assert.deepEqual(manifest.pointSeries?.descriptor, q.pointPacks.descriptor);
  const inventory = q.pointPacks.inventory.map(row => ({
    path: row.path.slice('v2/ecmwf/'.length), size: row.bytes, sha256: row.sha256,
  }));
  assert.equal(manifest.inventorySha256, hash(JSON.stringify(inventory)));
  return { ...manifest, manifestKey: receipt.manifestKey, manifestSha256: receipt.manifestSha256 };
}

function validateComponentMetadata(object) {
  if (object.metadata) {
    const keys = Object.keys(object.metadata);
    // The Atmos rclone transport may add mtime; the receipt and body hash carry identity.
    assert.ok(keys.length === 0 || (keys.length === 1 && keys[0] === 'mtime'));
    if (keys.length) assert.match(object.metadata.mtime, /^\d{10}(?:\.\d{1,9})?$/);
  }
  assert.ok(object.contentType == null || object.contentType === 'application/json');
  assert.ok(object.cacheControl == null || object.cacheControl === CACHE);
  assert.equal(object.contentEncoding, undefined);
}

export function validateSelection(value, now = Date.now(), policy = readProductionPolicy()) {
  exact(value, ['schemaVersion', 'kind', 'status', 'targetOrigin', 'model', 'runId', 'catalogId',
    'catalogSha256', 'sourceSha', 'inputSha256', 'invocation', 'qualificationCanonicalSha256',
    'initializedAt', 'freshUntil', 'createdAt', 'publicationMode', 'isolatedProductionCandidate',
    'sharedReadPinChanged', 'productionWritten', 'activated']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, SELECTION_KIND);
  assert.equal(value.status, 'DATA_QUALIFIED_NOT_ACTIVATED'); assert.equal(value.targetOrigin, ORIGIN);
  assert.equal(value.model, 'ecmwf'); assert.equal(value.catalogId, catalogIdFor(value.invocation));
  assert.equal(value.publicationMode, policy.publicationMode);
  assert.equal(value.sourceSha, policy.sourceSha);
  for (const key of ['catalogSha256', 'inputSha256', 'qualificationCanonicalSha256']) assert.match(value[key], SHA);
  assert.equal(utc(value.initializedAt), runTime(value.runId));
  assert.ok(utc(value.createdAt) >= utc(value.initializedAt) && utc(value.createdAt) <= now);
  lease(value.initializedAt, value.freshUntil, now);
  assert.equal(value.isolatedProductionCandidate, true); assert.equal(value.sharedReadPinChanged, false);
  assert.equal(value.productionWritten, true); assert.equal(value.activated, false);
  return value;
}

export function pointerEntry(selection, selectionSha256, now = Date.now()) {
  validateSelection(selection, now); assert.match(selectionSha256 ?? '', SHA);
  return { runId: selection.runId, catalogId: selection.catalogId,
    catalogSha256: selection.catalogSha256, selectionKey: selectionKeyFor(selection.catalogId),
    selectionSha256, sourceSha: selection.sourceSha, inputSha256: selection.inputSha256,
    initializedAt: selection.initializedAt, freshUntil: selection.freshUntil };
}

export function validatePointer(value, now = Date.now()) {
  exact(value, ['schemaVersion', 'kind', 'targetOrigin', 'updatedAt', 'entries']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, POINTER_KIND);
  assert.equal(value.targetOrigin, ORIGIN); assert.ok(utc(value.updatedAt) <= now);
  assert.ok(Array.isArray(value.entries) && value.entries.length >= 1 && value.entries.length <= 2);
  let prior = Infinity;
  for (const entry of value.entries) {
    exact(entry, ['runId', 'catalogId', 'catalogSha256', 'selectionKey', 'selectionSha256',
      'sourceSha', 'inputSha256', 'initializedAt', 'freshUntil']);
    assert.match(entry.catalogId, CATALOG);
    assert.equal(entry.selectionKey, selectionKeyFor(entry.catalogId));
    for (const key of ['catalogSha256', 'selectionSha256', 'inputSha256']) assert.match(entry[key], SHA);
    assert.equal(entry.sourceSha, readProductionPolicy().sourceSha);
    const init = runTime(entry.runId);
    assert.equal(utc(entry.initializedAt), init); assert.ok(init < prior); prior = init;
    assert.ok(utc(entry.freshUntil) > init && utc(entry.freshUntil) <= init + 30 * 3_600_000);
  }
  return value;
}

export function nextPointer(current, entry, now = Date.now()) {
  assert.ok(utc(entry.freshUntil) > now + 6 * 3_600_000, 'candidate lacks activation lease');
  if (current) {
    validatePointer(current, now);
    assert.ok(entry.runId >= current.entries[0].runId, 'model run regressed');
    assert.ok(now > utc(current.updatedAt), 'pointer timestamp must advance');
  }
  const entries = [entry, ...(current?.entries ?? []).filter(row =>
    row.runId !== entry.runId && utc(row.freshUntil) > now)]
    .sort((a, b) => b.runId.localeCompare(a.runId)).slice(0, 2);
  const result = { schemaVersion: 1, kind: POINTER_KIND, targetOrigin: ORIGIN,
    updatedAt: new Date(now).toISOString(), entries };
  return validatePointer(result, now);
}

export const journalKeyFor = pointerSha256 => {
  assert.match(pointerSha256 ?? '', SHA);
  return `${JOURNAL_PREFIX}${pointerSha256}.json`;
};

export function makePointerJournal(operation, nextBody, priorBody = null) {
  assert.ok(['activate', 'rollback'].includes(operation));
  assert.ok(Buffer.isBuffer(nextBody) && nextBody.length > 0 && nextBody.length <= MAX_POINTER);
  assert.ok(priorBody == null || (Buffer.isBuffer(priorBody) && priorBody.length > 0
    && priorBody.length <= MAX_POINTER));
  const parsedNext = JSON.parse(nextBody);
  const next = validatePointer(parsedNext, Date.parse(parsedNext.updatedAt));
  const prior = priorBody ? validatePointer(JSON.parse(priorBody), Date.parse(next.updatedAt)) : null;
  if (operation === 'activate') {
    assert.deepEqual(next, nextPointer(prior, next.entries[0], Date.parse(next.updatedAt)));
  } else {
    assert.ok(prior && prior.entries.length === 2);
    assert.ok(utc(prior.entries[1].freshUntil) > Date.parse(next.updatedAt) + 6 * 3_600_000);
    assert.deepEqual(next.entries, [prior.entries[1]]);
    assert.ok(Date.parse(next.updatedAt) > Date.parse(prior.updatedAt));
  }
  return { schemaVersion: 1, kind: JOURNAL_KIND, operation,
    currentPointerSha256: hash(nextBody), previousPointerSha256: priorBody ? hash(priorBody) : null,
    previousPointerBodyBase64: priorBody ? priorBody.toString('base64') : null,
    createdAt: next.updatedAt };
}

export function validatePointerJournal(journal, currentBody, now = Date.now()) {
  exact(journal, ['schemaVersion', 'kind', 'operation', 'currentPointerSha256',
    'previousPointerSha256', 'previousPointerBodyBase64', 'createdAt']);
  assert.equal(journal.schemaVersion, 1); assert.equal(journal.kind, JOURNAL_KIND);
  assert.ok(Buffer.isBuffer(currentBody)); assert.equal(journal.currentPointerSha256, hash(currentBody));
  const current = validatePointer(JSON.parse(currentBody), now);
  assert.equal(journal.createdAt, current.updatedAt);
  const previousBody = journal.previousPointerBodyBase64 == null ? null
    : Buffer.from(journal.previousPointerBodyBase64, 'base64');
  assert.equal(journal.previousPointerSha256, previousBody ? hash(previousBody) : null);
  assert.deepEqual(journal, makePointerJournal(journal.operation, currentBody, previousBody));
  return { current, previousBody, previous: previousBody ? JSON.parse(previousBody) : null };
}

export async function publishCandidate({ request, qualification, componentReceipt, io,
  now = Date.now, catalogValidator }) {
  const policy = readProductionPolicy();
  const q = validateQualification(qualification, request, now(), policy);
  assert.equal(typeof catalogValidator, 'function', 'exact Atmos catalog validator required');
  const catalogId = catalogIdFor(request.invocation);
  const object = await io.get(COMPONENTS, componentReceipt.manifestKey, MAX_JSON);
  assert.ok(object && hash(object.body) === componentReceipt.manifestSha256,
    'production point component readback differs');
  validateComponentMetadata(object);
  const component = validateComponent(JSON.parse(object.body), componentReceipt, q, request.invocation, now());
  lease(q.initializedAt, q.freshUntil, now(), policy.minimumForecastLeaseHours);
  const catalog = { schemaVersion: 2, sequence: 1, parentCatalogId: null,
    createdAt: new Date(now()).toISOString(), components: { 'point-ecmwf': component }, rollbackEpoch: 0 };
  assert.equal(catalogValidator(catalog), true, 'reader rejected production candidate catalog');
  const catalogBody = Buffer.from(`${JSON.stringify(catalog)}\n`);
  const catalogSha256 = hash(catalogBody);
  await io.immutable(DATA, catalogKeyFor(catalogId), catalogBody, { sha256: catalogSha256 });
  lease(q.initializedAt, q.freshUntil, now(), policy.minimumForecastLeaseHours);
  const selection = { schemaVersion: 1, kind: SELECTION_KIND,
    status: 'DATA_QUALIFIED_NOT_ACTIVATED', targetOrigin: ORIGIN, model: 'ecmwf',
    runId: q.runId, catalogId, catalogSha256, sourceSha: policy.sourceSha,
    inputSha256: qualification.inputSha256, invocation: request.invocation,
    qualificationCanonicalSha256: hash(JSON.stringify(qualification)),
    initializedAt: q.initializedAt, freshUntil: q.freshUntil,
    createdAt: new Date(now()).toISOString(), publicationMode: policy.publicationMode,
    isolatedProductionCandidate: true, sharedReadPinChanged: false,
    productionWritten: true, activated: false };
  validateSelection(selection, now());
  const selectionBody = Buffer.from(`${JSON.stringify(selection)}\n`);
  await io.immutable(DATA, selectionKeyFor(catalogId), selectionBody, { sha256: hash(selectionBody) });
  return selection;
}

async function verifySelected(selection, sha, io, catalogValidator, now) {
  const entry = pointerEntry(selection, sha, now);
  const selected = await io.get(DATA, entry.selectionKey, MAX_JSON);
  assert.ok(selected && hash(selected.body) === sha);
  assert.deepEqual(JSON.parse(selected.body), selection);
  const catalog = await io.get(DATA, catalogKeyFor(entry.catalogId), MAX_JSON);
  assert.ok(catalog && hash(catalog.body) === entry.catalogSha256);
  assert.equal(catalogValidator(JSON.parse(catalog.body)), true);
  const parsed = JSON.parse(catalog.body);
  assert.deepEqual(Object.keys(parsed.components ?? {}), ['point-ecmwf']);
  assert.equal(parsed.components['point-ecmwf'].pointSeries?.descriptor?.runId, entry.runId);
  assert.equal(parsed.components['point-ecmwf'].pointSeries?.descriptor?.freshUntil, entry.freshUntil);
  return entry;
}

export async function activateCandidate({ selection, selectionSha256, io, now = Date.now,
  catalogValidator }) {
  assert.equal(typeof catalogValidator, 'function');
  const entry = await verifySelected(selection, selectionSha256, io, catalogValidator, now());
  assert.ok(utc(entry.freshUntil) > now() + 6 * 3_600_000);
  for (let attempt = 0; attempt < 4; attempt++) {
    const priorObject = await io.get(DATA, POINTER_KEY, MAX_POINTER);
    const prior = priorObject ? validatePointer(JSON.parse(priorObject.body), now()) : null;
    if (prior?.entries.some(row => JSON.stringify(row) === JSON.stringify(entry))) return prior;
    const next = nextPointer(prior, entry, now());
    const body = Buffer.from(`${JSON.stringify(next)}\n`);
    const journal = makePointerJournal('activate', body, priorObject?.body ?? null);
    const journalBody = Buffer.from(`${JSON.stringify(journal)}\n`);
    await io.immutable(DATA, journalKeyFor(journal.currentPointerSha256), journalBody,
      { sha256: hash(journalBody) });
    if (!await io.putPointer(body, priorObject?.etag ?? null)) continue;
    const saved = await io.get(DATA, POINTER_KEY, MAX_POINTER);
    assert.ok(saved && saved.body.equals(body), 'production Wind100 pointer readback differs');
    return next;
  }
  throw Error('production Wind100 pointer changed during all bounded CAS attempts');
}

export async function findQualifiedInput({ runId, inputSha256, io, catalogValidator, now = Date.now }) {
  runTime(runId); assert.match(inputSha256 ?? '', SHA);
  const saved = await io.get(DATA, POINTER_KEY, MAX_POINTER);
  if (!saved) return { status: 'new-input', runId, inputSha256 };
  const pointer = validatePointer(JSON.parse(saved.body), now());
  const entry = pointer.entries.find(row => row.runId === runId && row.inputSha256 === inputSha256);
  if (!entry) return { status: 'new-input', runId, inputSha256 };
  const selected = await io.get(DATA, entry.selectionKey, MAX_JSON);
  assert.ok(selected && hash(selected.body) === entry.selectionSha256);
  const selection = JSON.parse(selected.body);
  assert.deepEqual(pointerEntry(selection, entry.selectionSha256, now()), entry);
  await verifySelected(selection, entry.selectionSha256, io, catalogValidator, now());
  return { status: 'unchanged', runId, inputSha256, catalogId: entry.catalogId,
    selectionSha256: entry.selectionSha256, freshUntil: entry.freshUntil };
}

export async function rollbackToPrior({ io, now = Date.now, catalogValidator }) {
  const observed = await io.get(DATA, POINTER_KEY, MAX_POINTER);
  assert.ok(observed, 'no production Wind100 pointer to roll back');
  const pointer = validatePointer(JSON.parse(observed.body), now());
  assert.ok(now() > Date.parse(pointer.updatedAt), 'rollback pointer timestamp must advance');
  assert.equal(pointer.entries.length, 2, 'no prior selection to restore');
  const prior = pointer.entries[1];
  assert.ok(utc(prior.freshUntil) > now() + 6 * 3_600_000,
    'prior selection lacks safe rollback lease');
  const selected = await io.get(DATA, prior.selectionKey, MAX_JSON);
  assert.ok(selected && hash(selected.body) === prior.selectionSha256);
  await verifySelected(JSON.parse(selected.body), prior.selectionSha256, io, catalogValidator, now());
  // One entry preserves newest-first order and cannot resurrect an expired run later.
  const next = validatePointer({ ...pointer, updatedAt: new Date(now()).toISOString(), entries: [prior] }, now());
  const body = Buffer.from(`${JSON.stringify(next)}\n`);
  const journal = makePointerJournal('rollback', body, observed.body);
  const journalBody = Buffer.from(`${JSON.stringify(journal)}\n`);
  await io.immutable(DATA, journalKeyFor(journal.currentPointerSha256), journalBody,
    { sha256: hash(journalBody) });
  assert.ok(await io.putPointer(body, observed.etag), 'rollback pointer CAS lost; inspect before retry');
  const saved = await io.get(DATA, POINTER_KEY, MAX_POINTER);
  assert.ok(saved && saved.body.equals(body), 'rollback pointer readback differs');
  return next;
}

export { sealedPointInputSha, verifySource };

export function recurringPrefixCapacity(existingCount, qualification) {
  assert.ok(Number.isSafeInteger(existingCount) && existingCount >= 0 && existingCount <= 50_000);
  const planned = validateQualification(qualification, { invocation: qualification.invocation }).pointPacks.objectCount + 1;
  assert.ok(existingCount + planned <= 50_000, 'production Wind100 component prefix lacks capacity');
  return { existingObjects: existingCount, plannedObjects: planned, maximumObjects: 50_000 };
}

export async function createStorage(env, invocation, injectedClient, injectedSdk) {
  const policy = readProductionPolicy();
  assert.equal(env.PRODUCTION_WIND100_R2_ACCOUNT_ID, ACCOUNT);
  assert.ok(env.PRODUCTION_WIND100_R2_ACCESS_KEY_ID && env.PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY);
  assert.match(invocation ?? '', INVOCATION);
  const sdk = injectedSdk ?? await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
  const client = injectedClient ?? new sdk.S3Client({ region: 'auto',
    endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`, forcePathStyle: true, maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.PRODUCTION_WIND100_R2_ACCESS_KEY_ID,
      secretAccessKey: env.PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY } });
  const ownId = catalogIdFor(invocation);
  const ownComponent = `${COMPONENT_PREFIX}${invocation}/component.json`;
  function allowed(bucket, key, operation) {
    assert.match(key ?? '', /^[A-Za-z0-9._/-]{1,512}$/);
    assert.ok(!key.startsWith('/') && !key.split('/').includes('..'));
    if (bucket === COMPONENTS) {
      assert.equal(operation, 'read'); assert.equal(key, ownComponent);
    } else {
      assert.equal(bucket, DATA);
      if (operation === 'pointer-write') assert.equal(key, POINTER_KEY);
      else if (operation === 'immutable-write')
        assert.ok(key === catalogKeyFor(ownId) || key === selectionKeyFor(ownId)
          || /^production-candidates\/wind100\/journal\/[a-f0-9]{64}\.json$/.test(key));
      else assert.ok(key === POINTER_KEY
        || /^catalogs\/snapshots\/prod-wind100-recurring-[1-9]\d{0,19}-[1-9]\d{0,5}\.json$/.test(key)
        || /^production-candidates\/wind100\/prod-wind100-recurring-[1-9]\d{0,19}-[1-9]\d{0,5}\/selection\.json$/.test(key)
        || /^production-candidates\/wind100\/journal\/[a-f0-9]{64}\.json$/.test(key));
    }
    return { Bucket: bucket, Key: key };
  }
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(120_000) });
  async function get(bucket, key, maximum = MAX_JSON) {
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_JSON);
    let response;
    try { response = await send(new sdk.GetObjectCommand(allowed(bucket, key, 'read'))); }
    catch (error) { if (error?.$metadata?.httpStatusCode === 404) return null; throw Error('production Wind100 read failed'); }
    const chunks = []; let count = 0;
    try {
      assert.ok(Number.isSafeInteger(response.ContentLength) && response.ContentLength > 0
        && response.ContentLength <= maximum, 'production Wind100 object exceeds read bound');
      for await (const chunk of response.Body) {
        count += chunk.length; assert.ok(count <= response.ContentLength);
        chunks.push(Buffer.from(chunk));
      }
      assert.equal(count, response.ContentLength);
      return { body: Buffer.concat(chunks), etag: response.ETag,
        metadata: response.Metadata ?? {}, contentType: response.ContentType,
        cacheControl: response.CacheControl, contentEncoding: response.ContentEncoding };
    } finally { response.Body?.destroy?.(); }
  }
  async function immutable(bucket, key, body, metadata) {
    const target = allowed(bucket, key, 'immutable-write');
    assert.ok(Buffer.isBuffer(body) && body.length > 0 && body.length <= MAX_JSON);
    assert.deepEqual(metadata, { sha256: hash(body) });
    try {
      await send(new sdk.PutObjectCommand({ ...target, Body: body, ContentLength: body.length,
        IfNoneMatch: '*', Metadata: metadata, ContentType: 'application/json', CacheControl: CACHE }));
    } catch (error) { if (error?.$metadata?.httpStatusCode !== 412) throw Error('production immutable write failed'); }
    const saved = await get(bucket, key, body.length);
    assert.ok(saved && saved.body.equals(body), 'immutable production object readback differs');
    assert.deepEqual(saved.metadata, metadata);
    assert.equal(saved.contentType, 'application/json'); assert.equal(saved.cacheControl, CACHE);
    assert.equal(saved.contentEncoding, undefined);
  }
  async function putPointer(body, etag) {
    const target = allowed(DATA, POINTER_KEY, 'pointer-write');
    assert.ok(Buffer.isBuffer(body) && body.length > 0 && body.length <= MAX_POINTER);
    const conditional = etag == null ? { IfNoneMatch: '*' } : { IfMatch: etag };
    try {
      await send(new sdk.PutObjectCommand({ ...target, Body: body, ContentLength: body.length,
        ContentType: 'application/json', CacheControl: 'public, max-age=30, must-revalidate',
        Metadata: { sha256: hash(body) }, ...conditional }));
      return true;
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 412) return false;
      throw Error('production Wind100 pointer write failed');
    }
  }
  async function prefixCount() {
    let count = 0, continuationToken;
    do {
      const page = await send(new sdk.ListObjectsV2Command({ Bucket: COMPONENTS,
        Prefix: policy.componentPrefix, MaxKeys: 1000,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}) }));
      assert.ok(Array.isArray(page.Contents ?? []));
      for (const row of page.Contents ?? []) {
        assert.match(row.Key ?? '', /^components\/point-ecmwf\/prod-wind100-recurring-point-ecmwf-[1-9]\d{0,19}-[1-9]\d{0,5}\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/);
        count++; assert.ok(count <= policy.maximumComponentPrefixObjects);
      }
      continuationToken = page.NextContinuationToken;
      assert.equal(Boolean(continuationToken), Boolean(page.IsTruncated));
    } while (continuationToken);
    return count;
  }
  return { get, immutable, putPointer, prefixCount, close: () => client.destroy?.() };
}

function privateJson(env, relativePath) {
  assert.match(relativePath ?? '', /^[A-Za-z0-9._/-]{1,200}$/);
  assert.ok(!relativePath.split('/').includes('..'));
  const path = resolve(env.RUNNER_TEMP, relativePath);
  const bytes = readFileSync(path);
  assert.ok(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024);
  return JSON.parse(bytes);
}
function saveQualification(env, value) {
  const directory = resolve(env.RUNNER_TEMP, 'production-wind100');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, 'qualification.json');
  assert.ok(!existsSync(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
async function withCatalogValidator(sourceRoot, callback) {
  const validator = await loadCatalogValidator(sourceRoot);
  try { return await callback(validator.validate); }
  finally { validator.close(); }
}

export async function main(command, env = process.env, argv = process.argv.slice(3)) {
  if (command === 'digest') return { sha256: controllerDigest() };
  const policy = readProductionPolicy();
  if (command === 'gate') return gate(env, 'none', policy);
  if (command === 'component-gate') return gate(env, 'component', policy);
  if (command === 'metadata-gate') return gate(env, 'metadata', policy);
  if (command === 'source') { gate(env, 'none', policy); return verifySource(argv[0]); }
  if (command === 'qualify') {
    const request = gate(env, 'none', policy);
    const pointIntegrity = await qualifyPointPacks({ stageRoot: argv[2], pointRoot: argv[3], model: 'ecmwf',
      policy: readIntegrityPolicy(), structuralReport: privateJson(env, argv[4]),
      sourceEvidence: privateJson(env, argv[1]), augmentationReceipt: privateJson(env, argv[5]),
      inputHandoff: privateJson(env, argv[6]), inputManifest: privateJson(env, argv[7]), request: {
        ...request, inputSha256: env.WIND100_INPUT_SHA256,
      } });
    const integrity = bindPointIntegrityInvocation(pointIntegrity, request.invocation);
    assert.deepEqual(verifySource(argv[0]), privateJson(env, argv[1]));
    const result = { schemaVersion: 1, kind: 'weatherx-production-native-wind100-qualification',
      targetOrigin: ORIGIN, invocation: request.invocation, sourceSha: policy.sourceSha,
      coreSourceSha: policy.coreSourceSha, inputSha256: env.WIND100_INPUT_SHA256, integrity };
    validateQualification(result, request);
    saveQualification(env, result);
    return result;
  }
  if (command === 'preflight' || command === 'retention-gate'
    || command === 'publish' || command === 'activate') {
    const request = gate(env, command === 'retention-gate' ? 'component' : 'metadata', policy);
    const io = await createStorage(env, request.invocation);
    try {
      if (command === 'preflight') return withCatalogValidator(argv[0], validator =>
        findQualifiedInput({ runId: env.WIND100_RUN_ID, inputSha256: env.WIND100_INPUT_SHA256,
          io, catalogValidator: validator }));
      if (command === 'retention-gate') return recurringPrefixCapacity(await io.prefixCount(),
        privateJson(env, argv[0]));
      if (command === 'publish') return withCatalogValidator(argv[2], validator => publishCandidate({
        request, qualification: privateJson(env, argv[0]), componentReceipt: privateJson(env, argv[1]),
        io, catalogValidator: validator }));
      return withCatalogValidator(argv[1], validator => activateCandidate({
        selection: privateJson(env, argv[0]), selectionSha256: hash(readFileSync(resolve(env.RUNNER_TEMP, argv[0]))),
        io, catalogValidator: validator }));
    } finally { io.close(); }
  }
  throw Error('usage: production-wind100.mjs digest | gate | source SOURCE | preflight SOURCE | qualify SOURCE SOURCE_EVIDENCE STAGE POINT PROOF AUGMENTATION HANDOFF MANIFEST | component-gate | metadata-gate | retention-gate QUALIFICATION | publish QUALIFICATION COMPONENT_RECEIPT SOURCE | activate SELECTION SOURCE');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(`${JSON.stringify(await main(process.argv[2]))}\n`); }
  catch (error) { console.error(`Production Wind100 refused: ${error.message}`); process.exitCode = 1; }
}
