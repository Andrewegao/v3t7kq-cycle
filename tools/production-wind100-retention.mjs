#!/usr/bin/env node
// Read-only planning precedes every production Wind100 deletion. A human-approved plan hash
// is required for the manual workflow; the recurring publisher may reclaim only journal-proven
// retired prefixes past grace, through the same planner and executor with per-batch pointer checks.
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPONENTS, COMPONENT_PREFIX, DATA, POINTER_KEY, RECLAIM_IO_TIMEOUT_MS,
  hash, journalKeyFor, pointerEntry, readProductionPolicy, settleWithin, validatePointer,
  validatePointerJournal, validateSelection } from './production-wind100.mjs';

const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const SHA = /^[a-f0-9]{64}$/;
const MAX_JSON = 512 * 1024;
const MAX_POINTER = 16 * 1024;
const MAX_JOURNALS = 64;
const MAX_CANDIDATES = 8;
const MAX_OBJECTS = 10_000;
// Hard per-run delete bound: two full recurring prefixes (2 x 4,141 objects) fit.
export const MAX_DELETES = 10_000;
export const DEFAULT_CANDIDATES = 2;
// A scoped delete credential covers at most this many keys of one prefix.
const CREDENTIAL_KEYS = 250;
const MAX_CONCURRENCY = 16;
// Inline reclaim re-verifies the live pointer once per credential window and runs that window's
// deletes eight at a time. Two serial round trips per key (pointer re-read, then delete) took
// about 0.3 s per object, so a two-prefix plan (8,282 keys) needed ~41 minutes and was killed
// by the 30-minute step bound every run (bake run 39181515197). The approved manual lane keeps
// the executor defaults: a pointer check before every key and one delete at a time.
export const INLINE_RECLAIM = Object.freeze({ batchSize: CREDENTIAL_KEYS, concurrency: 8 });
const GRACE_MS = 18 * 3_600_000;
const PLAN_KIND = 'weatherx-production-native-wind100-retention-plan';
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

export async function planRetention({ io, catalogValidator, now = Date.now,
  maximumCandidates = DEFAULT_CANDIDATES, maximumObjects = MAX_DELETES, policy = readProductionPolicy() }) {
  assert.equal(typeof catalogValidator, 'function');
  assert.ok(Number.isSafeInteger(maximumCandidates) && maximumCandidates > 0
    && maximumCandidates <= MAX_CANDIDATES);
  assert.ok(Number.isSafeInteger(maximumObjects) && maximumObjects > 0 && maximumObjects <= MAX_DELETES);
  const currentObject = await io.get(DATA, POINTER_KEY, MAX_POINTER);
  const current = validatePointer(parseObject(currentObject, MAX_POINTER), now(), policy);
  const currentSha256 = hash(currentObject.body);
  const protectedIds = new Set(current.entries.map(row => row.catalogId));
  const retired = new Map(), visited = new Set();
  let body = currentObject.body, reachedGenesis = false;
  for (let depth = 0; depth < MAX_JOURNALS; depth++) {
    const digest = hash(body);
    assert.ok(!visited.has(digest), 'pointer journal ancestry cycle');
    visited.add(digest);
    const journal = parseObject(await io.get(DATA, journalKeyFor(digest), MAX_JSON), MAX_JSON);
    const chain = validatePointerJournal(journal, body, now(), policy);
    for (const entry of chain.previous?.entries ?? []) {
      if (!chain.current.entries.some(row => row.catalogId === entry.catalogId)
        && !protectedIds.has(entry.catalogId)) retired.set(entry.catalogId, entry);
    }
    if (!chain.previousBody) { reachedGenesis = true; break; }
    body = chain.previousBody;
  }
  // A contiguous, bounded suffix proves its retired entries even when older history is retained.
  assert.ok(visited.size > 0);
  // The walk saw newest transitions first; reclaim the oldest retirement first so a prefix is
  // collected before it leaves the bounded ancestry window. Pointer and journal integrity
  // failures above abort the plan; a single retired entry that fails its own evidence below is
  // refused (never deleted) and planning continues, so one bad entry cannot block every run.
  const candidates = [], skippedEmptyCatalogIds = [], refusedCatalogIds = [], refusalReasons = {};
  let totalObjects = 0;
  for (const entry of [...retired.values()].reverse()) {
    if (candidates.length >= maximumCandidates) break;
    if (Date.parse(entry.freshUntil) + GRACE_MS > now()) continue;
    const prefix = prefixFor(entry);
    let keys, stage = 'inventory-unavailable';
    try {
      keys = await io.listPrefix(prefix, MAX_OBJECTS);
      assert.ok(Array.isArray(keys));
      // An already emptied prefix (an earlier run finished it) is progress, not a candidate.
      if (keys.length === 0) { skippedEmptyCatalogIds.push(entry.catalogId); continue; }
      stage = 'selection-unavailable';
      const selectedObject = await io.get(DATA, selectionKey(entry), MAX_JSON);
      const selected = parseObject(selectedObject, MAX_JSON);
      stage = 'selection-mismatch';
      assert.equal(hash(selectedObject.body), entry.selectionSha256);
      validateSelection(selected, Date.parse(selected.createdAt), policy, { allowPrevious: true });
      assert.deepEqual(pointerEntry(selected, entry.selectionSha256,
        Date.parse(selected.createdAt), { policy, allowPrevious: true }), entry);
      stage = 'catalog-unavailable';
      const catalogObject = await io.get(DATA, catalogKey(entry), MAX_JSON);
      const catalog = parseObject(catalogObject, MAX_JSON);
      stage = 'catalog-mismatch';
      assert.equal(hash(catalogObject.body), entry.catalogSha256);
      stage = 'catalog-rejected';
      assert.equal(catalogValidator(catalog), true);
      stage = 'component-mismatch';
      assert.deepEqual(Object.keys(catalog.components), ['point-ecmwf']);
      const component = catalog.components['point-ecmwf'];
      assert.equal(component.rootPrefix, prefix);
      assert.equal(component.manifestKey, `${prefix}component.json`);
      assert.equal(component.pointSeries?.descriptor?.runId, entry.runId);
      assert.equal(component.pointSeries?.descriptor?.freshUntil, entry.freshUntil);
      assert.ok(Number.isSafeInteger(component.objectCount) && component.objectCount > 0
        && component.objectCount < MAX_OBJECTS);
      stage = 'inventory-mismatch';
      assert.ok(keys.length <= component.objectCount + 1);
      assert.equal(keys.length, new Set(keys).size);
      for (const key of keys) {
        assert.ok(key.startsWith(prefix) && key.length > prefix.length && key.length <= 512);
        assert.match(key.slice(prefix.length), /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/);
        assert.ok(!key.split('/').includes('..'));
      }
    } catch {
      // The reason is a stable stage code, so a dry run and its recomputation hash identically.
      refusedCatalogIds.push(entry.catalogId); refusalReasons[entry.catalogId] = stage;
      continue;
    }
    // A prefix that would overrun the run's delete budget waits for the next run.
    if (totalObjects + keys.length > maximumObjects) break;
    totalObjects += keys.length;
    candidates.push({ catalogId: entry.catalogId, runId: entry.runId,
      freshUntil: entry.freshUntil, prefix, keys: keys.sort() });
  }
  const plan = { schemaVersion: 2, kind: PLAN_KIND,
    pointerSha256: currentSha256, protectedCatalogIds: [...protectedIds].sort(),
    ancestryRecordsChecked: visited.size, reachedGenesis, maximumCandidates, maximumObjects,
    skippedEmptyCatalogIds, refusedCatalogIds, refusalReasons, candidates, totalObjects };
  assert.ok(plan.totalObjects <= MAX_OBJECTS && plan.totalObjects <= maximumObjects);
  assert.ok(candidates.every(row => !refusedCatalogIds.includes(row.catalogId)));
  return { ...plan, planSha256: hash(JSON.stringify(plan)) };
}

// Shared by the approved manual execution and the recurring inline reclaim. The plan is
// recomputed from live state and must match byte for byte. Keys are deleted in batches inside
// one credential window: before each batch the live pointer is re-read and must still hash to
// the plan's pointer, exclude the candidate and leave it past grace. Within a batch at most
// `concurrency` deletes are in flight; the first failure stops further dispatch, lets in-flight
// deletes settle and is rethrown (no retries). Once `clock()` reaches `deadline` no further
// delete is dispatched and the partial count is returned. `onProgress` gets one line per batch.
async function executeVerifiedPlan({ plan, io, deleteForPrefix, catalogValidator, now, maximumDeletes, policy,
  batchSize = 1, concurrency = 1, deadline = Infinity, clock = Date.now, onProgress = () => {} }) {
  assert.ok(Number.isSafeInteger(maximumDeletes) && maximumDeletes > 0 && maximumDeletes <= MAX_DELETES);
  assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0 && CREDENTIAL_KEYS % batchSize === 0);
  assert.ok(Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= MAX_CONCURRENCY);
  assert.ok(typeof deadline === 'number' && !Number.isNaN(deadline));
  assert.equal(typeof clock, 'function'); assert.equal(typeof onProgress, 'function');
  const { planSha256, ...content } = plan;
  assert.equal(planSha256, hash(JSON.stringify(content)));
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.kind, PLAN_KIND);
  assert.deepEqual(plan, await planRetention({ io, catalogValidator, now,
    maximumCandidates: plan.maximumCandidates, maximumObjects: plan.maximumObjects, policy }),
  'production retention plan changed since approval');
  assert.match(plan.pointerSha256, SHA);
  assert.ok(Array.isArray(plan.candidates) && plan.candidates.length <= MAX_CANDIDATES);
  assert.ok(Array.isArray(plan.protectedCatalogIds) && plan.protectedCatalogIds.length <= 2);
  assert.equal(plan.totalObjects, plan.candidates.reduce((n, row) => n + row.keys.length, 0));
  assert.ok(plan.totalObjects <= maximumDeletes, 'retention delete budget exceeded');
  let deleted = 0;
  const report = note => onProgress(`reclaim progress: deleted ${deleted} of ${plan.totalObjects}`
    + (note ? `; ${note}` : ''));
  const outOfTime = () => clock() >= deadline;
  const budgetStop = () => {
    report(`wall-clock budget reached; ${plan.totalObjects - deleted} left for the next run`);
    return { deleted, complete: false };
  };
  report();
  for (const candidate of plan.candidates) {
    assert.ok(!plan.protectedCatalogIds.includes(candidate.catalogId));
    assert.match(candidate.prefix, /^components\/point-ecmwf\/prod-wind100-recurring-point-ecmwf-[1-9]\d{0,19}-[1-9]\d{0,5}\/$/);
    let client;
    try {
      for (let start = 0; start < candidate.keys.length; start += batchSize) {
        if (outOfTime()) return budgetStop();
        if (start % CREDENTIAL_KEYS === 0) {
          client?.close?.();
          client = await deleteForPrefix(candidate.prefix);
        }
        const liveObject = await io.get(DATA, POINTER_KEY, MAX_POINTER);
        const live = validatePointer(parseObject(liveObject, MAX_POINTER), now(), policy);
        assert.equal(hash(liveObject.body), plan.pointerSha256,
          'production pointer changed after dry-run; replan before deletion');
        assert.ok(!live.entries.some(entry => entry.catalogId === candidate.catalogId),
          'current or rollback candidate cannot be deleted');
        assert.ok(Date.parse(candidate.freshUntil) + GRACE_MS <= now(),
          'candidate lacks post-expiry grace');
        const batch = candidate.keys.slice(start, start + batchSize);
        for (const key of batch) assert.ok(key.startsWith(candidate.prefix) && key.length > candidate.prefix.length);
        let next = 0, failed = false, failure;
        const worker = async () => {
          while (!failed && next < batch.length && !outOfTime()) {
            const key = batch[next++];
            try { await client.delete(key); deleted++; }
            catch (error) { if (!failed) { failed = true; failure = error; } }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));
        if (failed) {
          report('stopped by a failed delete; no further deletion was attempted');
          throw failure;
        }
        // Without a failure, an undispatched key means the deadline stopped this batch.
        if (next < batch.length) return budgetStop();
        report();
      }
    } finally { client?.close?.(); }
  }
  return { deleted, complete: true };
}

export async function executeRetention({ plan, io, deleteForPrefix, catalogValidator, approvedPlanSha256,
  now = Date.now, maximumDeletes = MAX_DELETES, policy = readProductionPolicy() }) {
  assert.ok(Number.isSafeInteger(maximumDeletes) && maximumDeletes > 0 && maximumDeletes <= MAX_DELETES);
  assert.match(approvedPlanSha256 ?? '', SHA);
  const { planSha256, ...content } = plan;
  assert.equal(planSha256, hash(JSON.stringify(content)));
  assert.equal(planSha256, approvedPlanSha256, 'dry-run plan has not been approved');
  const { deleted } = await executeVerifiedPlan({ plan, io, deleteForPrefix, catalogValidator, now,
    maximumDeletes, policy });
  return { status: 'deleted-retired-production-wind100-objects',
    pointerSha256: plan.pointerSha256, planSha256, deleted };
}

// Recurring-publisher reclaim: the planner only ever proposes journal-retired, unprotected
// prefixes past grace, so this class needs no human plan hash. Never-activated uploads are not
// journal-proven and are not collected by this or any other path. The CLI passes
// INLINE_RECLAIM, a wall-clock deadline and a progress logger; a deadline stop is a clean
// partial result (`reclaim-budget-exhausted`) so the capacity check still decides.
export async function reclaimRetired({ io, deleteForPrefix, catalogValidator, now = Date.now,
  maximumCandidates = DEFAULT_CANDIDATES, maximumDeletes = MAX_DELETES, policy = readProductionPolicy(),
  batchSize, concurrency, deadline, clock, onProgress }) {
  const plan = await planRetention({ io, catalogValidator, now, maximumCandidates,
    maximumObjects: maximumDeletes, policy });
  const summary = { pointerSha256: plan.pointerSha256, planSha256: plan.planSha256,
    candidates: plan.candidates.map(row => row.catalogId),
    skippedEmptyCatalogIds: plan.skippedEmptyCatalogIds, refusedCatalogIds: plan.refusedCatalogIds,
    refusalReasons: plan.refusalReasons, plannedObjects: plan.totalObjects };
  if (plan.candidates.length === 0) {
    return { status: 'nothing-to-reclaim', ...summary, deleted: 0, remainingObjects: 0 };
  }
  const { deleted, complete } = await executeVerifiedPlan({ plan, io, deleteForPrefix, catalogValidator,
    now, maximumDeletes, policy, batchSize, concurrency, deadline, clock, onProgress });
  return { status: complete ? 'reclaimed-retired-production-wind100-objects' : 'reclaim-budget-exhausted',
    ...summary, deleted, remainingObjects: plan.totalObjects - deleted };
}

// Operator-facing notices for a plan or reclaim result: a warning per refused retired entry
// (it is kept, and blocks no other entry) and a one-line step summary.
export function retentionNotices(result) {
  const refused = result.refusedCatalogIds ?? [];
  const warnings = refused.map(id => `retired ${id} was refused (${result.refusalReasons?.[id]}) `
    + 'and kept; inspect its selection, catalog and prefix');
  if (result.status === 'reclaim-budget-exhausted') {
    warnings.push(`inline reclaim reached its wall-clock budget after deleting ${result.deleted} of`
      + ` ${result.plannedObjects} planned objects; ${result.remainingObjects} remain for the next run`);
  }
  const candidates = (result.candidates ?? []).map(row => (typeof row === 'string' ? row : row.catalogId));
  const summary = `Production Wind100 retention: ${result.status ?? 'plan'}; candidates ${candidates.join(', ') || 'none'};`
    + ` deleted ${result.deleted ?? 0}; skipped empty ${(result.skippedEmptyCatalogIds ?? []).length};`
    + ` refused ${refused.length ? refused.map(id => `${id} (${result.refusalReasons?.[id]})`).join(', ') : 'none'}`;
  return { warnings, summary };
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }
export function scopedDeleteCredentials(parent, prefix, nowSeconds = Math.floor(Date.now() / 1000)) {
  assert.match(parent.accessKeyId ?? '', /^[A-Za-z0-9]{10,128}$/);
  assert.ok(typeof parent.secretAccessKey === 'string' && parent.secretAccessKey.length >= 32);
  assert.match(prefix ?? '', /^components\/point-ecmwf\/prod-wind100-recurring-point-ecmwf-[1-9]\d{0,19}-[1-9]\d{0,5}\/$/);
  assert.ok(Number.isSafeInteger(nowSeconds) && nowSeconds > 0);
  const claims = { bucket: COMPONENTS, actions: ['DeleteObject'],
    paths: { prefixPaths: [prefix], objectPaths: [] }, sub: ACCOUNT, iss: parent.accessKeyId,
    aud: new URL(endpoint).host, iat: nowSeconds, exp: nowSeconds + 900 };
  const unsigned = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  const jwt = `${unsigned}.${createHmac('sha256', parent.secretAccessKey).update(unsigned).digest('base64url')}`;
  return { accessKeyId: parent.accessKeyId,
    secretAccessKey: createHash('sha256').update(jwt).digest('hex'),
    sessionToken: Buffer.from(`jwt/${jwt}`).toString('base64') };
}

// Read, list and per-prefix scoped delete over exactly the retention key space.
function retentionIo({ sdk, readClient, deleteParent, deleteClientFactory }) {
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
    const credentials = scopedDeleteCredentials(deleteParent(), prefix);
    const client = deleteClientFactory?.(credentials) ?? new sdk.S3Client({ region: 'auto', endpoint,
      forcePathStyle: true, maxAttempts: 1, credentials });
    return { async delete(key) {
      assert.ok(key.startsWith(prefix) && key.length > prefix.length);
      await client.send(new sdk.DeleteObjectCommand({ Bucket: COMPONENTS, Key: key }),
        { abortSignal: AbortSignal.timeout(120_000) });
    }, close: () => client.destroy?.() };
  }
  return { get, listPrefix, deleteForPrefix, close: () => readClient.destroy?.() };
}

// Inline reclaim wraps its IO so each get, list, credential mint and delete settles or times
// out with a clear error; `progress` counts completed calls for the failure report. No retries.
export function boundedReclaimIo(io, progress, timeoutMs = RECLAIM_IO_TIMEOUT_MS) {
  return {
    async get(bucket, key, maximum) {
      const value = await settleWithin(`get ${key}`, io.get(bucket, key, maximum), timeoutMs);
      progress.gets++; return value;
    },
    async listPrefix(prefix, maximum) {
      const value = await settleWithin(`list ${prefix}`, io.listPrefix(prefix, maximum), timeoutMs);
      progress.lists++; return value;
    },
    async deleteForPrefix(prefix) {
      const client = await settleWithin(`delete credential for ${prefix}`,
        Promise.resolve().then(() => io.deleteForPrefix(prefix)), timeoutMs);
      progress.deleteCredentials++;
      return { async delete(key) {
        await settleWithin(`delete ${key}`, Promise.resolve().then(() => client.delete(key)), timeoutMs);
        progress.deletes++;
      }, close: () => client.close?.() };
    },
    close: () => io.close?.(),
  };
}

const loadSdk = () => import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
const BROAD = ['R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY',
  'STAGING_R2_WRITE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_SECRET_ACCESS_KEY'];

export async function createRetentionIo(env, injectedSdk, injectedReadClient,
  injectedDeleteClientFactory) {
  assert.equal(env.PRODUCTION_WIND100_R2_ACCOUNT_ID, ACCOUNT);
  assert.ok(env.PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID
    && env.PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY);
  for (const key of ['PRODUCTION_WIND100_R2_ACCESS_KEY_ID', 'PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY', ...BROAD])
    assert.ok(!env[key], `retention refuses ${key}`);
  const sdk = injectedSdk ?? await loadSdk();
  const readClient = injectedReadClient ?? new sdk.S3Client({ region: 'auto', endpoint,
    forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: env.PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID,
      secretAccessKey: env.PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY } });
  return retentionIo({ sdk, readClient, deleteClientFactory: injectedDeleteClientFactory,
    deleteParent() {
      assert.ok(env.PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID
        && env.PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY);
      assert.notEqual(env.PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID,
        env.PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID);
      return { accessKeyId: env.PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID,
        secretAccessKey: env.PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY };
    } });
}

// The recurring publisher's own dedicated Wind100 token reads the journal and lists retired
// prefixes; each deletion still goes through a 15-minute DeleteObject-only credential minted
// for one journal-proven prefix. Cleanup-environment and broad credentials are refused.
export async function createReclaimIo(env, injectedSdk, injectedReadClient, injectedDeleteClientFactory) {
  assert.equal(env.PRODUCTION_WIND100_R2_ACCOUNT_ID, ACCOUNT);
  assert.ok(env.PRODUCTION_WIND100_R2_ACCESS_KEY_ID && env.PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY,
    'dedicated production Wind100 writer credentials are required');
  for (const key of ['PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY',
    'PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY',
    'PRODUCTION_WIND100_GC_APPROVED_PLAN_SHA256', ...BROAD])
    assert.ok(!env[key], `inline reclaim refuses ${key}`);
  const sdk = injectedSdk ?? await loadSdk();
  const credentials = { accessKeyId: env.PRODUCTION_WIND100_R2_ACCESS_KEY_ID,
    secretAccessKey: env.PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY };
  const readClient = injectedReadClient ?? new sdk.S3Client({ region: 'auto', endpoint,
    forcePathStyle: true, maxAttempts: 1, credentials });
  return retentionIo({ sdk, readClient, deleteClientFactory: injectedDeleteClientFactory,
    deleteParent: () => credentials });
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
