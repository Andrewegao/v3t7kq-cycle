// Read-only acquisition of original published baseline bytes. No provider or writer API.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Transform } from 'node:stream';
import { lstat, mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
export const DATA = 'weatherx-data-production', COMPONENTS = 'weatherx-components-production';
export const CORE = ['ecmwf', 'gfs', 'hrrr', 'aifs'];
export const MODELS = [...CORE, 'icon', 'hrdps', 'arome-antilles', 'hrrr-ak', 'nam', 'nam-hi', 'nam-ak'];
export const IDS = MODELS.flatMap(id => [id, `point-${id}`]);
export const LIMITS = Object.freeze({ metadata: 32 * 1024 ** 2, plan: 48 * 1024 ** 2,
  pointer: 64 * 1024, snapshot: 512 * 1024, manifest: 1024 ** 2, page: 2 * 1024 ** 2,
  object: 64 * 1024 ** 2, payload: 2 * 1024 ** 3, objects: 25_000, inventoryObjects: 50_000,
  metadataRequests: IDS.length + 3, inventoryRequests: 200, exportRequests: 25_100, milliseconds: 43 * 60_000 });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/, HEX = /^[a-f0-9]{64}$/;
export const hash = value => createHash('sha256').update(value).digest('hex');
const localErrors = new WeakMap(), failureRecords = new WeakMap();
const refusal = code => { const error = new Error(code); localErrors.set(error, code); return error; };
const check = (ok, code) => { if (!ok) throw refusal(code); };
const PHASES = new Set(['gate', 'scratch-admission', 'plan-admission', 'reader-init', 'pointer-before',
  'snapshot', 'component-manifest', 'component-list', 'pointer-after', 'export-payload', 'output-finalization', 'cleanup']);
const SDK_NAMES = new Set(['AccessDenied', 'NoSuchKey', 'NoSuchBucket', 'InvalidAccessKeyId',
  'SignatureDoesNotMatch', 'ExpiredToken', 'SlowDown', 'TimeoutError', 'AbortError', 'RequestTimeout']);
const TRANSPORT_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);
const FILE_CODES = new Set(['EACCES', 'EPERM', 'ENOSPC', 'EMFILE', 'ENOENT']);
const own = (value, key) => { try { return value && Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; } };
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
function diagnostic(error, context) {
  const localCode = localErrors.get(error) ?? null, name = own(error, 'name'), code = own(error, 'code');
  const http = own(own(error, '$metadata'), 'httpStatusCode');
  const httpStatus = Number.isInteger(http) && http >= 100 && http <= 599 ? http : null;
  const sdkName = SDK_NAMES.has(name) ? name : null;
  const transportCode = TRANSPORT_CODES.has(code) ? code : null, filesystemCode = FILE_CODES.has(code) ? code : null;
  const category = localCode ? 'validation' : error instanceof SyntaxError ? 'invalid-json'
    : httpStatus === 403 || name === 'AccessDenied' ? 'access-denied'
    : httpStatus === 401 || ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken'].includes(name) ? 'authentication'
    : httpStatus === 404 || ['NoSuchKey', 'NoSuchBucket'].includes(name) ? 'not-found'
    : httpStatus === 429 || name === 'SlowDown' ? 'throttled'
    : ['TimeoutError', 'AbortError', 'RequestTimeout'].includes(name) ? 'timeout-or-interrupted'
    : transportCode ? 'transport' : filesystemCode ? 'filesystem' : httpStatus >= 500 ? 'service' : 'unknown';
  return { schemaVersion: 1, kind: 'weatherx-train3-baseline-failure-v1',
    phase: PHASES.has(context.failurePhase ?? context.phase) ? context.failurePhase ?? context.phase : 'unknown',
    category, localCode, sdkName, httpStatus, transportCode, filesystemCode,
    requests: count(own(context.counts, 'requests'), LIMITS.exportRequests),
    wireBytes: count(own(context.counts, 'wireBytes'), LIMITS.metadata + LIMITS.payload),
    cleanup: ['passed', 'failed'].includes(context.cleanup) ? context.cleanup : 'unknown',
    completeOutputEligible: false };
}
export function failureDiagnostic(error) {
  return failureRecords.get(error) ?? diagnostic(error, {});
}
function trackedReader(client, context) {
  let pointerReads = 0;
  return {
    async get(bucket, key, cap) {
      context.phase = bucket === DATA ? key === 'catalogs/current.json'
        ? pointerReads++ === 0 ? 'pointer-before' : 'pointer-after' : 'snapshot'
        : key.endsWith('/component.json') ? 'component-manifest' : 'export-payload';
      return client.get(bucket, key, cap);
    },
    async list(...args) { context.phase = 'component-list'; return client.list(...args); },
    stats() { return client.stats(); }, close() { return client.close(); },
  };
}
function captureCounts(client, context) { try { context.counts = client?.stats(); } catch { context.counts = undefined; } }
const json = bytes => JSON.parse(bytes.toString('utf8'));
export function safeKey(value) {
  check(typeof value === 'string' && value.length <= 1024 && /^[A-Za-z0-9_./@+-]+$/.test(value)
    && value.split('/').length <= 32 && value.split('/').every(p => p && p !== '.' && p !== '..'), 'unsafe-key');
  return value;
}
export function gate(env) {
  check(env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted'
    && env.GITHUB_REPOSITORY === 'Andrewegao/v3t7kq-cycle' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_REF === 'refs/heads/main' && env.TRAIN3_PREPARATION_ENABLED === 'true', 'disabled-or-wrong-surface');
  check(/^[a-f0-9]{40}$/.test(env.REVIEWED_SOURCE_SHA ?? '') && env.REVIEWED_SOURCE_SHA === env.GITHUB_SHA, 'source-pin');
  check(ID.test(env.EXPECTED_CATALOG_ID ?? '') && !env.EXPECTED_CATALOG_ID.includes('..'), 'catalog-pin');
  check(['metadata', 'inventory', 'export'].includes(env.PREPARATION_OPERATION), 'operation');
  check(/^\d+$/.test(env.GITHUB_RUN_ID ?? '') && /^\d+$/.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'invocation-identity');
  if (env.PREPARATION_OPERATION === 'export') check(HEX.test(env.REVIEWED_PLAN_SHA256 ?? ''), 'plan-pin');
  return { operation: env.PREPARATION_OPERATION, catalogId: env.EXPECTED_CATALOG_ID };
}

// This wraps the SDK response stream BEFORE XML deserialization. A post-deserialization
// array-length check alone would not bound malicious/oversized listing responses.
export class BoundedReadHandler {
  constructor(inner, { operation, now = Date.now }) {
    this.inner = inner; this.now = now; this.deadline = now() + LIMITS.milliseconds;
    this.operation = operation; this.requests = 0; this.bytes = 0; this.metadata = inner.metadata;
  }
  destroy() { this.inner.destroy(); }
  updateHttpClientConfig(...args) { return this.inner.updateHttpClientConfig(...args); }
  httpHandlerConfigs() { return this.inner.httpHandlerConfigs(); }
  async handle(request, options) {
    check(request.protocol === 'https:' && request.hostname === `${ACCOUNT}.r2.cloudflarestorage.com`
      && request.method === 'GET' && (!request.port || Number(request.port) === 443), 'non-read-request');
    const path = decodeURIComponent(request.path), query = request.query ?? {};
    let cap;
    if (path === `/${COMPONENTS}/` || path === `/${COMPONENTS}`) {
      check(this.operation === 'inventory' && query['list-type'] === '2' && String(query['max-keys']) === '1000'
        && /^components\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/$/.test(query.prefix ?? '')
        && Object.keys(query).every(k => ['list-type', 'max-keys', 'prefix', 'continuation-token'].includes(k)), 'unscoped-list');
      safeKey(query.prefix.slice(0, -1));
      check(IDS.includes(query.prefix.split('/')[1]) && !query.prefix.split('/')[2].includes('..'), 'unselected-prefix');
      cap = LIMITS.page;
    } else {
      const bucket = path.split('/')[1], key = safeKey(path.split('/').slice(2).join('/'));
      check(Object.keys(query).every(k => k === 'x-id') && (!query['x-id'] || query['x-id'] === 'GetObject'), 'object-query');
      check((bucket === DATA && (key === 'catalogs/current.json' || /^catalogs\/snapshots\/[A-Za-z0-9._-]+\.json$/.test(key)))
        || (bucket === COMPONENTS && /^components\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\//.test(key)), 'bucket-or-key');
      cap = bucket === DATA ? (key === 'catalogs/current.json' ? LIMITS.pointer : LIMITS.snapshot)
        : key.endsWith('/component.json') ? LIMITS.manifest : LIMITS.object;
      check(this.operation === 'export' || bucket === DATA || key.endsWith('/component.json'), 'inventory-payload-read');
      if (this.operation === 'metadata' && bucket === COMPONENTS) {
        const parts = key.split('/');
        check(parts.length === 4 && parts[0] === 'components' && IDS.includes(parts[1])
          && ID.test(parts[2]) && parts[3] === 'component.json', 'metadata-manifest-key');
      }
    }
    check(this.now() < this.deadline && ++this.requests <= (this.operation === 'metadata' ? LIMITS.metadataRequests
      : this.operation === 'inventory' ? LIMITS.inventoryRequests : LIMITS.exportRequests), 'request-or-time-budget');
    const result = await this.inner.handle(request, options);
    const sourceBody = result.response.body;
    let bytes = 0;
    const bounded = new Transform({ transform: (chunk, _encoding, callback) => {
      bytes += chunk.length; this.bytes += chunk.length;
      if (bytes > cap || this.bytes > LIMITS.metadata + (this.operation === 'export' ? LIMITS.payload : 0)
        || this.now() >= this.deadline) callback(refusal('wire-budget'));
      else callback(null, chunk);
    }, flush: callback => callback(this.now() >= this.deadline ? refusal('wire-deadline') : undefined) });
    bounded.on('error', () => sourceBody.destroy());
    sourceBody.on('error', error => bounded.destroy(error));
    sourceBody.pipe(bounded);
    result.response.body = bounded;
    return result;
  }
}
export async function bodyBytes(body, cap) {
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of body) {
      bytes += chunk.length; check(bytes <= cap, 'body-budget'); chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) { body.destroy?.(); throw error; }
}
export async function readClient(env, operation, signal, { httpHandler } = {}) {
  check(env.SHARED_R2_READ_ACCESS_KEY_ID && env.SHARED_R2_READ_SECRET_ACCESS_KEY, 'missing-existing-reader');
  const require = createRequire(new URL('../staging-controller/package.json', import.meta.url));
  const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const { NodeHttpHandler } = require('@smithy/node-http-handler');
  const handler = new BoundedReadHandler(httpHandler ?? new NodeHttpHandler({ connectionTimeout: 10_000,
    requestTimeout: 30_000, socketTimeout: 30_000, throwOnRequestTimeout: true }), { operation });
  const client = new S3Client({ region: 'auto', endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    forcePathStyle: true, maxAttempts: 1, requestHandler: handler,
    credentials: { accessKeyId: env.SHARED_R2_READ_ACCESS_KEY_ID, secretAccessKey: env.SHARED_R2_READ_SECRET_ACCESS_KEY } });
  const abort = () => client.destroy(); signal?.addEventListener('abort', abort, { once: true });
  return {
    async get(bucket, key, cap) {
      const abort = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: abort });
      check(Number.isSafeInteger(result.ContentLength) && result.ContentLength >= 0 && result.ContentLength <= cap, 'content-length');
      const bytes = await bodyBytes(result.Body, cap);
      check(bytes.length === result.ContentLength && !abort.aborted, 'incomplete-object'); return bytes;
    },
    async list(prefix, token) {
      return client.send(new ListObjectsV2Command({ Bucket: COMPONENTS, Prefix: prefix,
        MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }), {
        abortSignal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) });
    },
    close() { signal?.removeEventListener('abort', abort); client.destroy(); },
    stats() { return { requests: handler.requests, wireBytes: handler.bytes }; },
  };
}

function envelope(pointerBytes, snapshotBytes, expected) {
  const p = json(pointerBytes), s = json(snapshotBytes);
  check(p.schemaVersion === 2 && p.catalogId === expected && HEX.test(p.catalogSha256 ?? '')
    && hash(snapshotBytes) === p.catalogSha256 && s.schemaVersion === 2 && s.sequence === p.sequence
    && Number.isSafeInteger(p.sequence) && p.sequence > 0 && s.createdAt === p.publishedAt
    && s.parentCatalogId === p.previousCatalogId && (s.rollbackOfCatalogId ?? null) === (p.rollbackOfCatalogId ?? null)
    && s.components && !Array.isArray(s.components), 'catalog-envelope');
  return s;
}
function descriptor(entry, id) {
  check(entry.componentId === id && ID.test(entry.artifactId ?? '') && !entry.artifactId.includes('..')
    && entry.rootPrefix === `components/${id}/${entry.artifactId}/`
    && entry.manifestKey === `${entry.rootPrefix}component.json` && HEX.test(entry.manifestSha256 ?? ''), 'component-identity');
}
function manifestMatches(manifest, entry) {
  for (const key of ['schemaVersion', 'componentId', 'artifactId', 'rootPrefix', 'generationTime', 'completedAt',
    'mounts', 'objectCount', 'inventorySha256', 'quality', 'pointSeries', 'objectLayout'])
    check(isDeepStrictEqual(manifest[key], entry[key]), 'manifest-descriptor');
}
const layoutOf = manifest => manifest.schemaVersion === 1 ? 'schema1'
  : manifest.objectLayout?.kind ?? manifest.layout ?? manifest.storage?.layout ?? `schema${manifest.schemaVersion}`;

// Descriptor counts are logical, not physical listing counts or measured payload bytes.
// This distinct audit kind is deliberately ineligible for exportPlan admission.
export async function metadataAudit(client, catalogId, sourceSha) {
  check(ID.test(catalogId) && !catalogId.includes('..'), 'catalog-pin');
  const pointer = await client.get(DATA, 'catalogs/current.json', LIMITS.pointer);
  check(json(pointer).catalogId === catalogId, 'catalog-rotated');
  const snapshot = await client.get(DATA, `catalogs/snapshots/${catalogId}.json`, LIMITS.snapshot);
  const catalog = envelope(pointer, snapshot, catalogId), components = [], missing = [];
  for (const id of IDS) {
    const entry = catalog.components[id];
    if (!entry) { missing.push(id); continue; }
    descriptor(entry, id);
    const raw = await client.get(COMPONENTS, entry.manifestKey, LIMITS.manifest);
    check(hash(raw) === entry.manifestSha256, 'manifest-hash');
    const manifest = json(raw); manifestMatches(manifest, entry);
    check(Number.isSafeInteger(manifest.objectCount) && manifest.objectCount >= 0, 'manifest-object-count');
    const model = id.startsWith('point-') ? id.slice(6) : id;
    components.push({ id, model, consumerScope: CORE.includes(model) ? 'core-catalog-and-eleven-model-gates' : 'eleven-model-gates',
      schemaVersion: manifest.schemaVersion, layout: layoutOf(manifest), logicalObjectCount: manifest.objectCount,
      generationTime: manifest.generationTime, pointSeries: manifest.pointSeries ?? null,
      manifestSha256: hash(raw), inventorySha256: manifest.inventorySha256 ?? null,
      manifestBase64: raw.toString('base64') });
  }
  const after = await client.get(DATA, 'catalogs/current.json', LIMITS.pointer);
  check(pointer.equals(after), 'catalog-rotated');
  const result = { schemaVersion: 1, kind: 'weatherx-train3-baseline-metadata-v1', catalogId, sourceSha,
    pointerBase64: pointer.toString('base64'), snapshotBase64: snapshot.toString('base64'), components, missing,
    payloadBytes: null, physicalObjectCount: null, payloadsRead: false, objectsListed: false,
    exportPlanEligible: false, scientificValidationPerformed: false, publicationAuthorized: false };
  check(Buffer.byteLength(JSON.stringify(result) + '\n') <= LIMITS.plan, 'plan-budget');
  return result;
}
function rowsSafe(rows, prefix) {
  const seen = new Set(); let bytes = 0;
  for (const row of rows) {
    safeKey(row.key); check(row.key.startsWith(prefix) && !seen.has(row.key), 'listing-key'); seen.add(row.key);
    check(Number.isSafeInteger(row.bytes) && row.bytes >= 0, 'listing-size'); bytes += row.bytes;
    check(Number.isSafeInteger(bytes), 'listing-overflow');
  }
  for (const key of seen) {
    let path = key;
    while (path.includes('/')) { path = path.slice(0, path.lastIndexOf('/')); check(!seen.has(path), 'file-directory-collision'); }
  }
  return bytes;
}
export async function inventory(client, catalogId, sourceSha) {
  check(ID.test(catalogId) && !catalogId.includes('..'), 'catalog-pin');
  const pointer = await client.get(DATA, 'catalogs/current.json', LIMITS.pointer);
  check(json(pointer).catalogId === catalogId, 'catalog-rotated');
  const snapshot = await client.get(DATA, `catalogs/snapshots/${catalogId}.json`, LIMITS.snapshot);
  const catalog = envelope(pointer, snapshot, catalogId), components = [], missing = []; let objectCount = 0, payloadBytes = 0;
  for (const id of IDS) {
    const entry = catalog.components[id];
    if (!entry) { missing.push(id); continue; }
    descriptor(entry, id);
    const raw = await client.get(COMPONENTS, entry.manifestKey, LIMITS.manifest);
    check(hash(raw) === entry.manifestSha256, 'manifest-hash');
    const manifest = json(raw); manifestMatches(manifest, entry);
    const rows = [], tokens = new Set(); let token;
    do {
      const page = await client.list(entry.rootPrefix, token);
      check(Array.isArray(page.Contents ?? []) && (page.Contents ?? []).length <= 1000, 'listing-page');
      for (const row of page.Contents ?? []) {
        rows.push({ key: row.Key, bytes: row.Size });
        check(++objectCount <= LIMITS.inventoryObjects, 'object-count-budget');
      }
      check(typeof page.IsTruncated === 'boolean', 'listing-truncation');
      if (!page.IsTruncated) break;
      token = page.NextContinuationToken;
      check(typeof token === 'string' && token.length > 0 && token.length <= 8192 && !tokens.has(token), 'listing-token'); tokens.add(token);
    } while (true);
    rowsSafe(rows, entry.rootPrefix);
    check(rows.filter(row => row.key === entry.manifestKey).length === 1
      && rows.find(row => row.key === entry.manifestKey).bytes === raw.length, 'manifest-listing');
    const payload = rows.filter(row => row.key !== entry.manifestKey).sort((a, b) => a.key < b.key ? -1 : 1);
    payloadBytes += payload.reduce((sum, row) => sum + row.bytes, 0);
    components.push({ id, manifestBase64: raw.toString('base64'), layout: layoutOf(manifest), objects: payload });
  }
  const after = await client.get(DATA, 'catalogs/current.json', LIMITS.pointer);
  check(pointer.equals(after), 'catalog-rotated');
  const plan = { schemaVersion: 1, kind: 'weatherx-train3-baseline-inventory-v1', catalogId, inventorySourceSha: sourceSha,
    pointerBase64: pointer.toString('base64'), snapshotBase64: snapshot.toString('base64'), components, missing,
    objectCount, payloadBytes, payloadsRead: false, publicationAuthorized: false };
  check(Buffer.byteLength(JSON.stringify(plan)) <= LIMITS.plan, 'plan-budget');
  return plan;
}

// Match the original schema-one producer: localeCompare per directory, depth-first.
export function producerOrder(a, b) {
  const x = a.path.split('/'), y = b.path.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) { const cmp = x[i].localeCompare(y[i]); if (cmp) return cmp; }
  return x.length - y.length;
}
export function exportPlan(bytes, sha256, catalogId) {
  check(bytes.length <= LIMITS.plan && HEX.test(sha256 ?? '') && hash(bytes) === sha256, 'reviewed-plan-hash');
  const plan = json(bytes);
  check(plan.schemaVersion === 1 && plan.kind === 'weatherx-train3-baseline-inventory-v1' && plan.catalogId === catalogId
    && Array.isArray(plan.missing) && plan.missing.length === 0 && Array.isArray(plan.components)
    && plan.components.length === IDS.length && new Set(plan.components.map(row => row.id)).size === IDS.length
    && IDS.every(id => plan.components.some(row => row.id === id)), 'incomplete-plan');
  const pointer = Buffer.from(plan.pointerBase64, 'base64'), snapshot = Buffer.from(plan.snapshotBase64, 'base64');
  check(pointer.length <= LIMITS.pointer && snapshot.length <= LIMITS.snapshot, 'metadata-budget');
  const catalog = envelope(pointer, snapshot, catalogId);
  let total = 0, count = 0;
  for (const item of plan.components) {
    const entry = catalog.components[item.id]; descriptor(entry, item.id);
    const raw = Buffer.from(item.manifestBase64, 'base64'), manifest = json(raw);
    check(raw.length <= LIMITS.manifest && hash(raw) === entry.manifestSha256, 'manifest-hash'); manifestMatches(manifest, entry);
    check(item.layout === 'schema1' && manifest.schemaVersion === 1, 'unsupported-layout');
    check(manifest.quality?.status === 'passed' && HEX.test(manifest.inventorySha256 ?? '')
      && Array.isArray(item.objects) && item.objects.length > 0 && item.objects.length === manifest.objectCount, 'component-inventory');
    total += rowsSafe(item.objects, entry.rootPrefix); count += item.objects.length;
    for (const row of item.objects) check(row.key !== entry.manifestKey && row.bytes <= LIMITS.object, 'payload-object-budget');
  }
  check(total === plan.payloadBytes && total <= LIMITS.payload && count <= LIMITS.objects, 'payload-budget');
  for (const model of MODELS) {
    const map = catalog.components[model], point = catalog.components[`point-${model}`], d = point.pointSeries?.descriptor;
    check(map.generationTime === point.generationTime && Date.parse(map.generationTime) === Date.parse(d?.initializedAt)
      && point.pointSeries?.modelId === model && /^\d{10}$/.test(d?.runId ?? '')
      && new Date(d.initializedAt).toISOString().replace(/[-:T]/g, '').slice(0, 10) === d.runId, 'pair-generation');
  }
  return { plan, pointer, snapshot, catalog, total, reviewedPlanSha256: sha256 };
}
async function save(root, path, bytes) {
  safeKey(path); const full = join(root, path); await mkdir(dirname(full), { recursive: true });
  await writeFile(full, bytes, { flag: 'wx', mode: 0o600 });
  return { path, size: bytes.length, sha256: hash(bytes) };
}
export async function exportBaseline(client, reviewed, root) {
  const { plan, pointer, snapshot, catalog } = reviewed, seal = [];
  check(pointer.equals(await client.get(DATA, 'catalogs/current.json', LIMITS.pointer)), 'catalog-rotated');
  check(snapshot.equals(await client.get(DATA, `catalogs/snapshots/${plan.catalogId}.json`, LIMITS.snapshot)), 'snapshot-changed');
  seal.push(await save(root, 'core/catalog-pointer.json', pointer), await save(root, 'core/catalog-snapshot.json', snapshot));
  await save(root, 'original/catalog-pointer.json', pointer); await save(root, 'original/catalog-snapshot.json', snapshot);
  const receipts = [];
  for (const item of plan.components) {
    const entry = catalog.components[item.id], raw = Buffer.from(item.manifestBase64, 'base64'), manifest = json(raw);
    check(raw.equals(await client.get(COMPONENTS, entry.manifestKey, LIMITS.manifest)), 'manifest-changed');
    await save(root, `original/components/${item.id}/component.json`, raw);
    const core = CORE.includes(item.id.replace(/^point-/, ''));
    if (core) seal.push(await save(root, `core/components/${item.id}/manifest.json`, raw));
    const rows = [];
    for (const object of item.objects) {
      const bytes = await client.get(COMPONENTS, object.key, Math.min(object.bytes, LIMITS.object));
      check(bytes.length === object.bytes, 'object-changed');
      const path = safeKey(object.key.slice(entry.rootPrefix.length));
      rows.push({ path, size: bytes.length, sha256: hash(bytes) });
      await save(root, `original/components/${item.id}/payload/${path}`, bytes);
      if (core) seal.push(await save(root, `core/components/${item.id}/payload/${path}`, bytes));
    }
    rows.sort(producerOrder);
    check(rows.length === manifest.objectCount && hash(JSON.stringify(rows)) === manifest.inventorySha256, 'original-inventory-hash');
    receipts.push({ componentId: item.id, manifestSha256: hash(raw), inventorySha256: manifest.inventorySha256,
      objectCount: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0) });
  }
  check(pointer.equals(await client.get(DATA, 'catalogs/current.json', LIMITS.pointer)), 'catalog-rotated');
  const files = seal.map(row => ({ ...row, path: row.path.slice('core/'.length) })).sort((a, b) => a.path < b.path ? -1 : 1);
  const sealBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: 'weatherx-validation-catalog-baseline-v1', files }) + '\n');
  check(sealBytes.length <= 16 * 1024 ** 2, 'seal-budget'); await save(root, 'core/seal.json', sealBytes);
  return { schemaVersion: 1, kind: 'weatherx-train3-original-baseline-export-v1', catalogId: plan.catalogId,
    reviewedPlanSha256: reviewed.reviewedPlanSha256, catalogSha256: json(pointer).catalogSha256,
    coreSealSha256: hash(sealBytes), components: receipts, scientificValidationPerformed: false, publicationAuthorized: false };
}

async function runPreparation({ env = process.env, clientFactory = readClient, now = Date.now,
  milliseconds = LIMITS.milliseconds } = {}, context) {
  const { operation, catalogId } = gate(env);
  const deadline = now() + milliseconds; context.phase = 'scratch-admission';
  const parent = resolve(env.RUNNER_TEMP), destination = join(parent, 'train3-baseline-preparation');
  check((await lstat(parent)).isDirectory() && !(await lstat(parent)).isSymbolicLink(), 'temporary-root');
  try { await lstat(destination); throw refusal('existing-output'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let reviewed;
  if (operation === 'export') {
    context.phase = 'plan-admission';
    const path = resolve('ops/train3-baseline/export-plan.json'), info = await lstat(path);
    check(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= LIMITS.plan, 'plan-file');
    reviewed = exportPlan(await readFile(path), env.REVIEWED_PLAN_SHA256, catalogId);
  }
  context.phase = 'scratch-admission';
  const disk = await statfs(parent); check(disk.bavail * disk.bsize >= (reviewed ? 4 * reviewed.total : LIMITS.plan * 2) + 1024 ** 3, 'free-disk-budget');
  const work = join(parent, `train3-baseline-work-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`);
  await mkdir(work, { mode: 0o700 }); let client;
  const abort = new AbortController(), cancel = () => abort.abort(new Error('interrupted'));
  const timer = setTimeout(cancel, Math.max(0, deadline - now())); timer.unref();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  const checkBudget = () => check(!abort.signal.aborted && now() < deadline, 'interrupted-or-deadline');
  let ownsDestination = false, complete = false;
  try {
    checkBudget();
    context.phase = 'reader-init';
    client = trackedReader(await clientFactory(env, operation, abort.signal), context);
    const result = operation === 'metadata' ? await metadataAudit(client, catalogId, env.GITHUB_SHA)
      : operation === 'inventory' ? await inventory(client, catalogId, env.GITHUB_SHA) : await exportBaseline(client, reviewed, work);
    checkBudget(); context.phase = 'output-finalization';
    await save(work, operation === 'metadata' ? 'metadata-audit.json' : operation === 'inventory'
      ? 'inventory-plan.json' : 'export-receipt.json', Buffer.from(JSON.stringify(result) + '\n'));
    await save(work, 'acquisition-receipt.json', Buffer.from(JSON.stringify({ operation, catalogId,
      sourceSha: env.GITHUB_SHA, ...client.stats(), publicationAuthorized: false }) + '\n'));
    checkBudget(); await rename(work, destination); ownsDestination = true;
    checkBudget(); complete = true; return result;
  } catch (error) {
    context.hasPrimaryFailure = true; context.failurePhase = context.phase; captureCounts(client, context); throw error;
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
    let cleanupError;
    try { client?.close(); } catch (error) { cleanupError = error; }
    try { await rm(work, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; }
    if (ownsDestination && (!complete || cleanupError)) {
      try { await rm(destination, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; }
    }
    context.cleanup = cleanupError ? 'failed' : 'passed';
    if (cleanupError && !context.hasPrimaryFailure) { context.failurePhase = 'cleanup'; captureCounts(client, context); throw cleanupError; }
  }
}
export async function preparation(options) {
  const context = { phase: 'gate' };
  try { return await runPreparation(options, context); }
  catch (error) {
    const failure = error && typeof error === 'object' ? error : new Error('preparation-failed');
    failureRecords.set(failure, diagnostic(failure, context)); throw failure;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  preparation().then(() => console.log('Train 3 baseline preparation complete.')).catch(error => {
    // Only finite categories/local codes and validated counts; never serialize SDK error/env.
    console.error(JSON.stringify(failureDiagnostic(error))); process.exitCode = 1;
  });
}
