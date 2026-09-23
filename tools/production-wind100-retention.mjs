#!/usr/bin/env node
// Read-only planning precedes every separately approved production Wind100 deletion.
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPONENTS, COMPONENT_PREFIX, DATA, POINTER_KEY,
  hash, journalKeyFor, pointerEntry, validatePointer, validatePointerJournal,
  validateSelection } from './production-wind100.mjs';

const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const SHA = /^[a-f0-9]{64}$/;
const MAX_JSON = 512 * 1024;
const MAX_POINTER = 16 * 1024;
const MAX_JOURNALS = 64;
const MAX_CANDIDATES = 8;
const MAX_OBJECTS = 10_000;
const GRACE_MS = 18 * 3_600_000;
const endpoint = `https://${ACCOUNT}.r2.cloudflarestorage.com`;

function exact(value, fields) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
}
function parseObject(object, maximum) {
  assert.ok(object && Buffer.isBuffer(object.body) && object.body.length > 0
    && object.body.length <= maximum);
  return JSON.parse(object.body);
}
function selectionKey(entry) {
  return `production-candidates/wind100/${entry.catalogId}/selection.json`;
}
function catalogKey(entry) { return `catalogs/snapshots/${entry.catalogId}.json`; }
function prefixFor(entry) {
  const invocation = entry.catalogId.slice('prod-wind100-recurring-'.length);
  return `${COMPONENT_PREFIX}${invocation}/`;
}

export async function planRetention({ io, catalogValidator, now = Date.now, maximumCandidates = 1 }) {
  assert.equal(typeof catalogValidator, 'function');
  assert.ok(Number.isSafeInteger(maximumCandidates) && maximumCandidates > 0
    && maximumCandidates <= MAX_CANDIDATES);
  const currentObject = await io.get(DATA, POINTER_KEY, MAX_POINTER);
  const current = validatePointer(parseObject(currentObject, MAX_POINTER), now());
  const currentSha256 = hash(currentObject.body);
  const protectedIds = new Set(current.entries.map(row => row.catalogId));
  const retired = new Map(), visited = new Set();
  let body = currentObject.body, reachedGenesis = false;
  for (let depth = 0; depth < MAX_JOURNALS; depth++) {
    const digest = hash(body);
    assert.ok(!visited.has(digest), 'pointer journal ancestry cycle');
    visited.add(digest);
    const journal = parseObject(await io.get(DATA, journalKeyFor(digest), MAX_JSON), MAX_JSON);
    const chain = validatePointerJournal(journal, body, now());
    for (const entry of chain.previous?.entries ?? []) {
      if (!chain.current.entries.some(row => row.catalogId === entry.catalogId)
        && !protectedIds.has(entry.catalogId)) retired.set(entry.catalogId, entry);
    }
    if (!chain.previousBody) { reachedGenesis = true; break; }
    body = chain.previousBody;
  }
  // A contiguous, bounded suffix proves its retired entries even when older history is retained.
  assert.ok(visited.size > 0);
  const candidates = [];
  for (const entry of retired.values()) {
    if (Date.parse(entry.freshUntil) + GRACE_MS > now()) continue;
    if (candidates.length >= maximumCandidates) break;
    const selectedObject = await io.get(DATA, selectionKey(entry), MAX_JSON);
    const selected = parseObject(selectedObject, MAX_JSON);
    assert.equal(hash(selectedObject.body), entry.selectionSha256);
    validateSelection(selected, Date.parse(selected.createdAt));
    assert.deepEqual(pointerEntry(selected, entry.selectionSha256,
      Date.parse(selected.createdAt)), entry);
    const catalogObject = await io.get(DATA, catalogKey(entry), MAX_JSON);
    const catalog = parseObject(catalogObject, MAX_JSON);
    assert.equal(hash(catalogObject.body), entry.catalogSha256);
    assert.equal(catalogValidator(catalog), true);
    assert.deepEqual(Object.keys(catalog.components), ['point-ecmwf']);
    const component = catalog.components['point-ecmwf'];
    const prefix = prefixFor(entry);
    assert.equal(component.rootPrefix, prefix);
    assert.equal(component.manifestKey, `${prefix}component.json`);
    assert.equal(component.pointSeries?.descriptor?.runId, entry.runId);
    assert.equal(component.pointSeries?.descriptor?.freshUntil, entry.freshUntil);
    assert.ok(Number.isSafeInteger(component.objectCount) && component.objectCount > 0
      && component.objectCount < MAX_OBJECTS);
    const keys = await io.listPrefix(prefix, MAX_OBJECTS);
    assert.ok(Array.isArray(keys) && keys.length <= component.objectCount + 1);
    assert.equal(keys.length, new Set(keys).size);
    for (const key of keys) {
      assert.ok(key.startsWith(prefix) && key.length > prefix.length && key.length <= 512);
      assert.match(key.slice(prefix.length), /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/);
      assert.ok(!key.split('/').includes('..'));
    }
    candidates.push({ catalogId: entry.catalogId, runId: entry.runId,
      freshUntil: entry.freshUntil, prefix, keys: keys.sort() });
  }
  const plan = { schemaVersion: 1, kind: 'weatherx-production-native-wind100-retention-plan',
    pointerSha256: currentSha256, protectedCatalogIds: [...protectedIds].sort(),
    ancestryRecordsChecked: visited.size, reachedGenesis, candidates,
    totalObjects: candidates.reduce((n, row) => n + row.keys.length, 0) };
  assert.ok(plan.totalObjects <= MAX_OBJECTS);
  return { ...plan, planSha256: hash(JSON.stringify(plan)) };
}

export async function executeRetention({ plan, io, deleteForPrefix, catalogValidator, approvedPlanSha256,
  now = Date.now, maximumDeletes = 5_000 }) {
  assert.ok(Number.isSafeInteger(maximumDeletes) && maximumDeletes > 0 && maximumDeletes <= 5_000);
  assert.match(approvedPlanSha256 ?? '', SHA);
  const { planSha256, ...content } = plan;
  assert.equal(planSha256, hash(JSON.stringify(content)));
  assert.equal(planSha256, approvedPlanSha256, 'dry-run plan has not been approved');
  assert.deepEqual(plan, await planRetention({ io, catalogValidator, now,
    maximumCandidates: Math.max(1, plan.candidates.length) }),
  'production retention plan changed since approval');
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.kind, 'weatherx-production-native-wind100-retention-plan');
  assert.match(plan.pointerSha256, SHA);
  assert.ok(Array.isArray(plan.candidates) && plan.candidates.length <= MAX_CANDIDATES);
  assert.ok(Array.isArray(plan.protectedCatalogIds) && plan.protectedCatalogIds.length <= 2);
  assert.equal(plan.totalObjects, plan.candidates.reduce((n, row) => n + row.keys.length, 0));
  assert.ok(plan.totalObjects <= maximumDeletes, 'retention delete budget exceeded');
  let deleted = 0;
  for (const candidate of plan.candidates) {
    assert.ok(!plan.protectedCatalogIds.includes(candidate.catalogId));
    assert.match(candidate.prefix, /^components\/point-ecmwf\/prod-wind100-recurring-point-ecmwf-[1-9]\d{0,19}-[1-9]\d{0,5}\/$/);
    let client;
    try {
      for (const [index, key] of candidate.keys.entries()) {
        if (index % 250 === 0) {
          client?.close?.();
          client = await deleteForPrefix(candidate.prefix);
        }
        const liveObject = await io.get(DATA, POINTER_KEY, MAX_POINTER);
        const live = validatePointer(parseObject(liveObject, MAX_POINTER), now());
        assert.equal(hash(liveObject.body), plan.pointerSha256,
          'production pointer changed after dry-run; replan before deletion');
        assert.ok(!live.entries.some(entry => entry.catalogId === candidate.catalogId),
          'current or rollback candidate cannot be deleted');
        assert.ok(Date.parse(candidate.freshUntil) + GRACE_MS <= now(),
          'candidate lacks post-expiry grace');
        assert.ok(key.startsWith(candidate.prefix) && key.length > candidate.prefix.length);
        await client.delete(key);
        deleted++;
      }
    } finally { client?.close?.(); }
  }
  return { status: 'deleted-retired-production-wind100-objects',
    pointerSha256: plan.pointerSha256, planSha256, deleted };
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }
export function scopedDeleteCredentials(parent, prefix, nowSeconds = Math.floor(Date.now() / 1000)) {
  assert.match(parent.accessKeyId ?? '', /^[A-Za-z0-9]{10,128}$/);
  assert.ok(typeof parent.secretAccessKey === 'string' && parent.secretAccessKey.length >= 32);
  assert.match(prefix ?? '', /^components\/point-ecmwf\/prod-wind100-recurring-point-ecmwf-[1-9]\d{0,19}-[1-9]\d{0,5}\/$/);
  assert.ok(Number.isSafeInteger(nowSeconds) && nowSeconds > 0);
  const claims = { bucket: COMPONENTS, scope: 'object-read-write', actions: ['DeleteObject'],
    paths: { prefixPaths: [prefix], objectPaths: [] }, sub: ACCOUNT, iss: parent.accessKeyId,
    aud: new URL(endpoint).host, iat: nowSeconds, exp: nowSeconds + 900 };
  const unsigned = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  const jwt = `${unsigned}.${createHmac('sha256', parent.secretAccessKey).update(unsigned).digest('base64url')}`;
  return { accessKeyId: parent.accessKeyId,
    secretAccessKey: createHash('sha256').update(jwt).digest('hex'),
    sessionToken: Buffer.from(`jwt/${jwt}`).toString('base64') };
}

export async function createRetentionIo(env, injectedSdk, injectedReadClient,
  injectedDeleteClientFactory) {
  assert.equal(env.PRODUCTION_WIND100_R2_ACCOUNT_ID, ACCOUNT);
  assert.ok(env.PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID
    && env.PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY);
  for (const key of ['PRODUCTION_WIND100_R2_ACCESS_KEY_ID', 'PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY',
    'R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY',
    'STAGING_R2_WRITE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_SECRET_ACCESS_KEY'])
    assert.ok(!env[key], `retention refuses ${key}`);
  const sdk = injectedSdk ?? await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
  const readClient = injectedReadClient ?? new sdk.S3Client({ region: 'auto', endpoint,
    forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: env.PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID,
      secretAccessKey: env.PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY } });
  const send = command => readClient.send(command, { abortSignal: AbortSignal.timeout(120_000) });
  async function get(bucket, key, maximum = MAX_JSON) {
    assert.equal(bucket, DATA);
    assert.ok(key === POINTER_KEY || /^production-candidates\/wind100\/journal\/[a-f0-9]{64}\.json$/.test(key)
      || /^catalogs\/snapshots\/prod-wind100-recurring-[1-9]\d{0,19}-[1-9]\d{0,5}\.json$/.test(key)
      || /^production-candidates\/wind100\/prod-wind100-recurring-[1-9]\d{0,19}-[1-9]\d{0,5}\/selection\.json$/.test(key));
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_JSON);
    const response = await send(new sdk.GetObjectCommand({ Bucket: DATA, Key: key }));
    assert.ok(response.ContentLength > 0 && response.ContentLength <= maximum);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.Body) {
      bytes += chunk.length; assert.ok(bytes <= response.ContentLength);
      chunks.push(Buffer.from(chunk));
    }
    assert.equal(bytes, response.ContentLength);
    return { body: Buffer.concat(chunks), etag: response.ETag };
  }
  async function listPrefix(prefix, maximum) {
    assert.match(prefix, /^components\/point-ecmwf\/prod-wind100-recurring-point-ecmwf-[1-9]\d{0,19}-[1-9]\d{0,5}\/$/);
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_OBJECTS);
    const keys = [], tokens = new Set(); let token;
    do {
      const page = await send(new sdk.ListObjectsV2Command({ Bucket: COMPONENTS,
        Prefix: prefix, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }));
      for (const row of page.Contents ?? []) {
        assert.ok(row.Key.startsWith(prefix)); keys.push(row.Key);
        assert.ok(keys.length <= maximum);
      }
      token = page.NextContinuationToken;
      if (token) { assert.ok(!tokens.has(token)); tokens.add(token); }
      assert.equal(Boolean(token), Boolean(page.IsTruncated));
    } while (token);
    return keys;
  }
  async function deleteForPrefix(prefix) {
    assert.ok(env.PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID
      && env.PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY);
    assert.notEqual(env.PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID,
      env.PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID);
    const credentials = scopedDeleteCredentials({
      accessKeyId: env.PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID,
      secretAccessKey: env.PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY }, prefix);
    const client = injectedDeleteClientFactory?.(credentials) ?? new sdk.S3Client({ region: 'auto', endpoint,
      forcePathStyle: true, maxAttempts: 1, credentials });
    return { async delete(key) {
      assert.ok(key.startsWith(prefix) && key.length > prefix.length);
      await client.send(new sdk.DeleteObjectCommand({ Bucket: COMPONENTS, Key: key }),
        { abortSignal: AbortSignal.timeout(120_000) });
    }, close: () => client.destroy?.() };
  }
  return { get, listPrefix, deleteForPrefix, close: () => readClient.destroy?.() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // The protected workflow supplies an already reviewed, pinned Atmos source root.
  const { loadCatalogValidator, verifySource } = await import('./staging-wind100.mjs');
  const { controllerDigest } = await import('./production-wind100.mjs');
  const [command, sourceRoot] = process.argv.slice(2);
  try {
    assert.ok(['dry-run', 'execute'].includes(command));
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle');
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
    assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(process.env.GITHUB_WORKFLOW_REF,
      'Andrewegao/v3t7kq-cycle/.github/workflows/production-wind100-retention.yml@refs/heads/main');
    assert.equal(process.env.GITHUB_JOB, 'retention');
    assert.equal(process.env.WIND100_GC_ENVIRONMENT, 'data-production-wind100-cleanup');
    assert.equal(process.env.PRODUCTION_WIND100_GC_ENABLED, 'true');
    assert.equal(process.env.PRODUCTION_WIND100_GC_CONTROLLER_SHA256, controllerDigest());
    if (command === 'execute') assert.equal(process.env.PRODUCTION_WIND100_GC_EXECUTE_ENABLED, 'true');
    verifySource(sourceRoot);
    const validator = await loadCatalogValidator(sourceRoot);
    const io = await createRetentionIo(process.env);
    try {
      const plan = await planRetention({ io, catalogValidator: validator.validate });
      if (command === 'dry-run') process.stdout.write(`${JSON.stringify(plan)}\n`);
      else process.stdout.write(`${JSON.stringify(await executeRetention({ plan, io,
        deleteForPrefix: io.deleteForPrefix,
        catalogValidator: validator.validate,
        approvedPlanSha256: process.env.PRODUCTION_WIND100_GC_APPROVED_PLAN_SHA256 }))}\n`);
    } finally { io.close(); validator.close(); }
  } catch (error) { console.error(`Production Wind100 retention refused: ${error.message}`); process.exitCode = 1; }
}
