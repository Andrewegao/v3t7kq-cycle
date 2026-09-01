// Staging-only activation core. No SDK, credentials, network, CLI, collector, or UI
// deployment is embedded here. The trusted hosted adapter must enforce every CAS
// option below and stream hashObject() rather than trusting R2 ETags as digests.
import assert from 'node:assert/strict';
import { gate as sharedGate, hash, identifier, safePath, validateRelease, validateCatalog, validateComponent } from './shared-data.mjs';

export const STAGING_DATA_BUCKET = 'weatherx-data-staging';
export const STAGING_COMPONENT_BUCKET = 'weatherx-components-staging';
export const STAGING_ORIGIN = 'https://staging.weatherx.org';
const CONTROL_LIMIT = 32 * 1024 ** 2, MAX_OBJECTS = 100_000, MAX_BYTES = 40 * 1024 ** 3;
const WRITE_LIMIT = 2 * 1024 ** 2;
const SHA = /^[a-f0-9]{64}$/;
const POINTERS = ['releases/current.json', 'catalogs/current.json'];
const json = value => Buffer.from(JSON.stringify(value) + '\n');
const order = (a, b) => a.path.localeCompare(b.path);
// Component manifests are produced by recursively visiting each directory and
// locale-sorting the names within that directory. Reconstruct that exact order
// from an S3 flat listing; whole-string sorting differs when a directory name is
// also a prefix of a sibling filename (for example grid/x before grid.json).
export function componentInventoryOrder(a, b) {
  const left = a.path.split('/'), right = b.path.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].localeCompare(right[i]);
    if (difference) return difference;
  }
  return left.length - right.length;
}

// Persist only fixed stage identifiers and a small error category. Never retain
// arbitrary exception text because transport errors can contain request details.
export async function checked(stage, action, report = () => {}) {
  assert.match(stage, /^[A-Za-z0-9:/._-]{1,180}$/, 'invalid diagnostic stage');
  report({ stage, state: 'started' });
  try {
    const result = await action(); report({ stage, state: 'passed' }); return result;
  } catch (error) {
    report({ stage, state: 'failed', kind: error?.code === 'ERR_ASSERTION' ? 'assertion' : error?.name === 'AbortError' ? 'aborted' : 'error' });
    throw error;
  }
}

export function activationGate(env) {
  const selection = sharedGate(env);
  assert.equal(env.GITHUB_WORKFLOW_REF, 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-data-activate.yml@refs/heads/main');
  assert.equal(env.GITHUB_JOB, 'activate');
  assert.equal(env.STAGING_DATA_ACTIVATION_ENABLED, 'true', 'activation is not approved');
  assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]*$/);
  assert.match(env.STAGING_DATA_APPROVED_RECEIPT_SHA256 ?? '', SHA, 'prepared receipt hash approval is required');
  return { selection, candidateId: hash(JSON.stringify(selection)),
    activationId: `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`, sourceSha: env.GITHUB_SHA,
    receiptSha256: env.STAGING_DATA_APPROVED_RECEIPT_SHA256 };
}

function context(value) {
  assert.ok(value && value.selection); identifier(value.selection.releaseId); identifier(value.selection.catalogId);
  for (const key of ['releaseManifestSha256', 'catalogSha256']) assert.match(value.selection[key], SHA);
  assert.equal(value.candidateId, hash(JSON.stringify(value.selection)));
  assert.match(value.activationId, /^[1-9][0-9]*-[1-9][0-9]*$/);
  assert.match(value.sourceSha, /^[a-f0-9]{40}$/); assert.match(value.receiptSha256, SHA);
  return value;
}
function object(value, required = true) {
  if (!value) { assert.ok(!required, 'required object missing'); return null; }
  assert.ok(Buffer.isBuffer(value.body) || value.body instanceof Uint8Array, 'object body must be exact bytes');
  assert.ok(value.body.length <= CONTROL_LIMIT, 'oversized control object');
  assert.ok(typeof value.etag === 'string' && value.etag.length > 0 && value.etag.length <= 256, 'object ETag required');
  return { ...value, body: Buffer.from(value.body), customMetadata: value.customMetadata ?? {}, httpMetadata: value.httpMetadata ?? {} };
}
function parse(value) { return JSON.parse(value.body); }
async function get(io, key, required = true, bucket = STAGING_DATA_BUCKET) {
  safePath(key); return object(await io.get(bucket, key, { maxBytes: CONTROL_LIMIT }), required);
}
async function put(io, key, body, options) {
  safePath(key);
  assert.ok(Buffer.isBuffer(body) && body.length <= WRITE_LIMIT, 'activation control write exceeds budget');
  assert.ok(POINTERS.includes(key) || /^catalogs\/snapshots\/[A-Za-z0-9._-]+\.json$/.test(key) ||
    /^staging-candidates\/[a-f0-9]{64}\/activations\/[1-9][0-9]*-[1-9][0-9]*\/(intent|journal)\.json$/.test(key), 'write key outside activation allowlist');
  assert.ok(options.ifMatch || options.ifNoneMatch === '*', 'unconditional write forbidden');
  assert.ok(!(options.ifMatch && options.ifNoneMatch), 'ambiguous write condition');
  const result = await io.put(STAGING_DATA_BUCKET, key, body, options);
  assert.ok(result && typeof result.etag === 'string' && result.etag.length, 'CAS write failed or returned no ETag');
  return result.etag;
}
function health(proof) {
  assert.equal(proof?.origin, STAGING_ORIGIN); assert.equal(proof.authMode, 'public');
  assert.equal(proof.billingMode, 'disabled'); assert.equal(proof.dataMode, 'serve');
  assert.equal(proof.ok, true, 'staging consumer is not healthy');
}
function validTime(value) { const time = Date.parse(value); assert.ok(Number.isFinite(time), 'invalid source time'); return time; }

// Whole release and component data must not regress. Source and staging catalog
// sequence counters belong to independent lineages and are NOT comparable.
export function assertNonRegression(previous, next) {
  const { release: oldRelease, manifest: oldManifest, catalogPointer: oldPointer, catalog: oldCatalog } = previous;
  assert.equal(oldRelease.schemaVersion, 1); assert.equal(oldManifest.schemaVersion, 1);
  assert.equal(oldRelease.releaseId, oldManifest.releaseId);
  assert.equal(oldRelease.manifestSha256, hash(JSON.stringify(oldManifest)));
  assert.equal(oldRelease.objectCount, oldManifest.objectCount); assert.deepEqual(oldRelease.pointSeries, oldManifest.pointSeries);
  assert.equal(next.release.releaseId === oldRelease.releaseId ? next.release.manifestSha256 : oldRelease.manifestSha256, oldRelease.manifestSha256);
  assert.ok(validTime(next.release.publishedAt) >= validTime(oldRelease.publishedAt), 'whole release would regress');
  assert.ok(oldManifest.pointSeries?.models, 'previous point descriptor missing');
  for (const [model, old] of Object.entries(oldManifest.pointSeries.models)) {
    const candidate = next.manifest.pointSeries.models?.[model]; assert.ok(candidate, 'point model removed');
    assert.ok(validTime(candidate.initializedAt) >= validTime(old.initializedAt), 'point model cycle regressed');
    assert.ok(validTime(candidate.freshUntil) >= validTime(old.freshUntil), 'point model horizon regressed');
    if (candidate.runId === old.runId) assert.deepEqual(candidate, old, 'same point run descriptor changed');
  }
  assert.equal(oldPointer.schemaVersion, 2); assert.equal(oldCatalog.schemaVersion, 2);
  assert.equal(oldPointer.sequence, oldCatalog.sequence);
  assert.equal(oldPointer.publishedAt, oldCatalog.createdAt); assert.equal(oldPointer.previousCatalogId, oldCatalog.parentCatalogId);
  assert.equal(oldPointer.rollbackOfCatalogId ?? null, oldCatalog.rollbackOfCatalogId ?? null);
  assert.ok(Number.isSafeInteger(oldPointer.sequence) && oldPointer.sequence > 0);
  assert.ok(oldCatalog.components && Object.keys(oldCatalog.components).length, 'previous catalog empty');
  for (const [model, old] of Object.entries(oldCatalog.components)) {
    const candidate = next.catalog.components[model]; assert.ok(candidate, 'catalog model removed');
    assert.ok(validTime(candidate.generationTime) >= validTime(old.generationTime), 'component cycle regressed');
    if (candidate.artifactId === old.artifactId) assert.deepEqual(candidate, old, 'same component changed');
  }
}

export function buildServingCatalog(ctx, previousPointer, previousCatalog, sourceCatalog, time) {
  context(ctx); identifier(previousPointer.catalogId);
  assert.ok(Number.isSafeInteger(previousPointer.sequence) && previousPointer.sequence > 0);
  assert.equal(previousPointer.sequence, previousCatalog.sequence);
  assert.ok(Number.isSafeInteger(previousPointer.sequence + 1), 'staging sequence overflow');
  const rollbackEpoch = previousCatalog.rollbackEpoch ?? 0;
  assert.ok(Number.isSafeInteger(rollbackEpoch) && rollbackEpoch >= 0, 'invalid previous rollback epoch');
  assert.ok(Number.isSafeInteger(time) && time >= validTime(previousCatalog.createdAt), 'activation clock predates current staging catalog');
  const catalog = { schemaVersion: 2, sequence: previousPointer.sequence + 1,
    parentCatalogId: previousPointer.catalogId, createdAt: new Date(time).toISOString(),
    components: structuredClone(sourceCatalog.components), rollbackEpoch };
  const body = json(catalog), catalogId = identifier(`${catalog.sequence}-staging-${ctx.activationId}`);
  const pointer = { schemaVersion: 2, catalogId, sequence: catalog.sequence, publishedAt: catalog.createdAt,
    catalogSha256: hash(body), previousCatalogId: previousPointer.catalogId };
  return { catalog, body, pointer };
}

async function mapBounded(items, task) {
  let cursor = 0, failure;
  const result = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(8, items.length) }, async () => {
    while (cursor < items.length && !failure) {
      const index = cursor++;
      try { result[index] = await task(items[index]); } catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure; return result;
}
async function readInventory(io, bucket, prefix) {
  const listed = await io.list(bucket, prefix, { maxObjects: MAX_OBJECTS });
  assert.ok(Array.isArray(listed) && listed.length > 0 && listed.length <= MAX_OBJECTS, 'invalid complete listing');
  const seen = new Set(); let total = 0;
  const items = listed.map(item => {
    safePath(item.key); assert.ok(item.key.startsWith(prefix), 'listing escaped prefix');
    const path = safePath(item.key.slice(prefix.length)); assert.ok(!seen.has(path), 'duplicate listing key'); seen.add(path);
    assert.ok(Number.isSafeInteger(item.bytes) && item.bytes >= 0); total += item.bytes;
    assert.ok(total <= MAX_BYTES, 'inventory exceeds byte budget'); return { path, key: item.key, size: item.bytes };
  });
  const actual = await mapBounded(items, async item => {
    const read = await io.hashObject(bucket, item.key, { maxBytes: item.size });
    assert.equal(read.bytes, item.size, 'object bytes changed during readback'); assert.match(read.sha256, SHA);
    return { path: item.path, size: read.bytes, sha256: read.sha256 };
  });
  return actual.sort(order);
}

export async function inspectPrepared(ctx, io, { validatePoints, now = Date.now, report = () => {} }) {
  context(ctx); assert.equal(typeof validatePoints, 'function', 'real point validator required');
  const check = (stage, action) => checked(`candidate:${stage}`, action, report);
  const prefix = `staging-candidates/${ctx.candidateId}/`;
  const receiptObject = await check('receipt-read', () => get(io, `${prefix}receipt.json`));
  await check('receipt-hash', () => assert.equal(hash(receiptObject.body), ctx.receiptSha256, 'prepared receipt differs from approval'));
  const receipt = parse(receiptObject);
  const [releaseObject, catalogObject, catalogPointerObject, manifestObject] = await check('metadata-read', () => Promise.all([
    get(io, `${prefix}release-pointer.json`), get(io, `${prefix}catalog.json`), get(io, `${prefix}catalog-pointer.json`),
    get(io, `releases/${ctx.selection.releaseId}/manifest.json`),
  ]));
  const release = parse(releaseObject), manifest = parse(manifestObject), catalogPointer = parse(catalogPointerObject);
  let bytes = await check('release-validation', () => validateRelease(release, manifest, ctx.selection, now()));
  await check('point-validation', () => validatePoints(manifest)); // Must use the pinned deployed consumer's actual v2 validator.
  const catalog = await check('catalog-validation', () => validateCatalog(catalogPointer, catalogObject.body, ctx.selection, now()));
  // Check the smaller component trees first. This preserves every byte gate but
  // makes a component-specific failure observable without first rereading the
  // much larger whole release.
  for (const c of Object.values(catalog.components)) {
    const name = identifier(c.componentId);
    const metadata = await check(`component:${name}:metadata`, () => get(io, c.manifestKey, true, STAGING_COMPONENT_BUCKET));
    await check(`component:${name}:validation`, () => validateComponent(c, metadata.body));
    const all = await check(`component:${name}:inventory`, () => readInventory(io, STAGING_COMPONENT_BUCKET, c.rootPrefix));
    const values = all.filter(x => x.path !== 'component.json').sort(componentInventoryOrder);
    await check(`component:${name}:manifest-entry`, () => {
      assert.deepEqual(all.find(x => x.path === 'component.json'), { path: 'component.json', size: metadata.body.length, sha256: c.manifestSha256 });
    });
    await check(`component:${name}:object-count`, () => assert.equal(values.length, c.objectCount, 'component object count mismatch'));
    await check(`component:${name}:inventory-hash`, () =>
      assert.equal(hash(JSON.stringify(values)), c.inventorySha256, 'component inventory/readback mismatch'));
    bytes += values.reduce((n, x) => n + x.size, 0); assert.ok(bytes <= MAX_BYTES, 'combined byte budget exceeded');
  }
  const whole = await check('whole-inventory', () => readInventory(io, STAGING_DATA_BUCKET, `releases/${ctx.selection.releaseId}/`));
  const expected = [...manifest.objects.map(o => ({ path: o.path, size: o.bytes, sha256: o.sha256 })),
    { path: 'manifest.json', size: manifestObject.body.length, sha256: hash(manifestObject.body) }].sort(order);
  await check('whole-inventory-compare', () => assert.deepEqual(whole, expected, 'whole release inventory/readback mismatch'));
  await check('receipt-compare', () => assert.deepEqual(receipt, { schemaVersion: 1, candidateId: ctx.candidateId, selection: ctx.selection,
    objects: manifest.objectCount + Object.values(catalog.components).reduce((n, c) => n + c.objectCount, 0), bytes,
    collected: false, processed: false, activated: false, productionWritten: false,
    producerSource: 'preserved upstream receipts; no new collector-source attestation',
    components: Object.values(catalog.components).map(c => ({ model: c.componentId, artifactId: c.artifactId, manifestSha256: c.manifestSha256 })) }));
  // Recheck freshness after the full streaming readback, not merely at its start.
  await check('freshness-recheck', () => {
    validateRelease(release, manifest, ctx.selection, now()); validateCatalog(catalogPointer, catalogObject.body, ctx.selection, now());
  });
  return { release, manifest, catalogPointer, catalog, releaseObject, catalogObject, catalogPointerObject };
}

export function assertLiveProof(proof, prepared, ctx, servingCatalog) {
  health(proof); assert.deepEqual(proof.selection, ctx.selection);
  assert.ok(servingCatalog && servingCatalog.catalogId); assert.deepEqual(proof.servingCatalog, servingCatalog, 'live staging catalog identity differs');
  assert.equal(proof.sourceVerified, true, 'real decoded source comparison required');
  assert.ok(Array.isArray(proof.points) && proof.points.length >= 14, 'fourteen real point responses required');
  for (const model of ['ecmwf', 'gfs']) {
    const points = proof.points.filter(p => p.model === model);
    assert.ok(points.length >= 7 && new Set(points.map(p => JSON.stringify(p.coordinates))).size >= 7, 'seven distinct points per model required');
  }
  for (const point of proof.points) {
    assert.ok(['ecmwf', 'gfs'].includes(point.model)); assert.equal(point.status, 200); assert.equal(point.complete, true);
    assert.equal(point.releaseId, ctx.selection.releaseId); assert.equal(point.runId, prepared.manifest.pointSeries.models[point.model].runId);
    assert.ok(Array.isArray(point.coordinates) && point.coordinates.length === 2 && point.coordinates.every(Number.isFinite));
    assert.ok(Math.abs(point.coordinates[0]) <= 180 && Math.abs(point.coordinates[1]) <= 90);
    const source = prepared.manifest.objects.find(o => o.path === point.packPath);
    assert.ok(source && point.packPath.startsWith(`point-series/v2/${point.model}/${point.runId}/chunks/`), 'point source absent from manifest');
    assert.equal(point.packSha256, source.sha256); assert.match(point.responseSha256, SHA);
    assert.equal(point.numericMatch, true, 'numeric payload/source comparison missing');
    for (const name of ['temperature', 'wind_speed', 'wind_direction', 'precipitation']) {
      assert.ok(Array.isArray(point.values?.[name]) && point.values[name].length > 0 && point.values[name].every(Number.isFinite), 'finite real numeric samples required');
    }
  }
}

const stored = o => ({ body: o.body.toString('base64'), etag: o.etag, customMetadata: o.customMetadata, httpMetadata: o.httpMetadata });
const restored = o => object({ ...o, body: Buffer.from(o.body, 'base64') });
const root = ctx => `staging-candidates/${ctx.candidateId}/activations/${ctx.activationId}/`;
function owned(current, intent, pointer) {
  return current?.customMetadata?.['activation-id'] === intent.activationId &&
    current.customMetadata['activation-source-sha'] === intent.sourceSha && hash(current.body) === pointer.nextSha256;
}

// Recovery is deliberately rollback-only. A retry cannot turn a partially activated
// or expired candidate into success without a new full validation/live transaction.
export async function recoverActivation(ctx, io) {
  context(ctx); assert.equal(typeof io.validateRestore, 'function', 'restore metadata preflight required');
  const intentObject = await get(io, `${root(ctx)}intent.json`), intent = parse(intentObject);
  assert.equal(intent.schemaVersion, 1); assert.equal(intent.activationId, ctx.activationId);
  assert.equal(intent.sourceSha, ctx.sourceSha); assert.equal(intent.receiptSha256, ctx.receiptSha256);
  assert.deepEqual(intent.selection, ctx.selection); assert.deepEqual(intent.pointers.map(p => p.key), POINTERS);
  assert.equal(intent.servingCatalog?.catalogId, `${intent.servingCatalog?.sequence}-staging-${ctx.activationId}`);
  const oldCatalogPointer = parse(restored(intent.pointers[1].previous));
  assert.equal(intent.servingCatalog.sequence, oldCatalogPointer.sequence + 1);
  assert.equal(intent.servingCatalog.previousCatalogId, oldCatalogPointer.catalogId);
  const marker = { id: ctx.activationId, sourceSha: ctx.sourceSha };
  assert.deepEqual(parse(restored(intent.pointers[1].next)), { ...intent.servingCatalog, stagingActivation: marker });
  const nextRelease = parse(restored(intent.pointers[0].next));
  assert.deepEqual(nextRelease.stagingActivation, marker); assert.equal(nextRelease.releaseId, ctx.selection.releaseId);
  assert.equal(nextRelease.manifestSha256, ctx.selection.releaseManifestSha256);
  for (const pointer of intent.pointers) await io.validateRestore(restored(pointer.previous));
  const journalObject = await get(io, `${root(ctx)}journal.json`, false);
  if (journalObject) {
    assert.equal(parse(journalObject).schemaVersion, 1); assert.equal(parse(journalObject).intentSha256, hash(intentObject.body));
    if (parse(journalObject).state === 'complete') throw Error('completed activation is not automatically rolled back');
  }
  const result = [];
  for (const pointer of [...intent.pointers].reverse()) {
    const previous = restored(pointer.previous), next = restored(pointer.next);
    assert.equal(pointer.nextSha256, hash(next.body)); assert.equal(pointer.previousSha256, hash(previous.body));
    const current = await get(io, pointer.key);
    if (hash(current.body) === pointer.previousSha256 && !owned(current, intent, pointer)) { result.push({ key: pointer.key, status: 'previous' }); continue; }
    if (!owned(current, intent, pointer)) { result.push({ key: pointer.key, status: 'conflict' }); continue; }
    // Exact bytes + transaction identity establish ownership after a crash between
    // pointer PUT and journal save. Fresh ETag CAS prevents overwriting later writers.
    try {
      await put(io, pointer.key, previous.body, { ifMatch: current.etag, customMetadata: previous.customMetadata, httpMetadata: previous.httpMetadata });
      const check = await get(io, pointer.key);
      assert.equal(hash(check.body), pointer.previousSha256, 'rollback readback failed');
      result.push({ key: pointer.key, status: 'restored' });
    } catch { result.push({ key: pointer.key, status: 'conflict' }); }
  }
  const state = result.some(x => x.status === 'conflict') ? 'recovery-conflict' : 'rolled-back';
  await put(io, `${root(ctx)}journal.json`, json({ schemaVersion: 1, intentSha256: hash(intentObject.body), state, pointers: result }),
    journalObject ? { ifMatch: journalObject.etag } : { ifNoneMatch: '*' });
  return { state, pointers: result, productionWritten: false };
}

export async function activatePrepared(ctx, io, { validatePoints, validateServingPointers, verifyConsumer, verifyLive, now = Date.now, report = () => {} }) {
  context(ctx); assert.equal(typeof verifyConsumer, 'function'); assert.equal(typeof verifyLive, 'function');
  assert.equal(typeof validateServingPointers, 'function', 'pinned consumer pointer validators required');
  assert.equal(typeof io.validateRestore, 'function', 'restore metadata preflight required');
  const check = (stage, action) => checked(`activation:${stage}`, action, report);
  await check('consumer-health', async () => health(await verifyConsumer({ origin: STAGING_ORIGIN })));
  const prepared = await check('candidate-inspection', () => inspectPrepared(ctx, io, { validatePoints, now, report }));
  const [oldReleaseObject, oldCatalogPointerObject] = await check('current-pointers-read', () => Promise.all(POINTERS.map(key => get(io, key))));
  // Refuse before any write if the transport cannot round-trip prior metadata.
  await check('restore-metadata-preflight', async () => { for (const previous of [oldReleaseObject, oldCatalogPointerObject]) await io.validateRestore(previous); });
  const { oldRelease, oldPointer } = await check('current-pointers-validation', () => {
    const release = parse(oldReleaseObject), pointer = parse(oldCatalogPointerObject);
    identifier(release.releaseId); identifier(pointer.catalogId);
    return { oldRelease: release, oldPointer: pointer };
  });
  const oldManifestObject = await check('current-manifest-read', () => get(io, `releases/${oldRelease.releaseId}/manifest.json`));
  const oldManifest = await check('current-manifest-validation', () => parse(oldManifestObject));
  const oldCatalogObject = await check('current-catalog-read', () => get(io, `catalogs/snapshots/${oldPointer.catalogId}.json`));
  const oldCatalog = await check('current-catalog-validation', () => {
    assert.equal(hash(oldCatalogObject.body), oldPointer.catalogSha256, 'previous catalog integrity failure');
    return parse(oldCatalogObject);
  });
  await check('non-regression', () => assertNonRegression({ release: oldRelease, manifest: oldManifest, catalogPointer: oldPointer, catalog: oldCatalog }, prepared));
  const serving = await check('serving-catalog-build', () => buildServingCatalog(ctx, oldPointer, oldCatalog, prepared.catalog, now()));
  // R2 ETags may identify content, not metadata revisions. The staging-only body
  // marker makes different activation runs ETag-distinct. Immutable upstream
  // candidate/manifest/catalog bytes and all source identities remain unchanged.
  const stagedPointers = [prepared.release, serving.pointer].map(pointer => {
    assert.equal(pointer.stagingActivation, undefined, 'source pointer unexpectedly contains activation metadata');
    return { ...pointer, stagingActivation: { id: ctx.activationId, sourceSha: ctx.sourceSha } };
  });
  await check('serving-pointer-validation', () => validateServingPointers({ release: stagedPointers[0], catalogPointer: stagedPointers[1], catalog: serving.catalog }));
  const { intent, intentBytes, intentSha256 } = await check('intent-construction', () => {
    const previous = [oldReleaseObject, oldCatalogPointerObject];
    const next = [prepared.releaseObject, prepared.catalogPointerObject].map((value, index) => ({ ...value, body: json(stagedPointers[index]) }));
    const value = { schemaVersion: 1, activationId: ctx.activationId, sourceSha: ctx.sourceSha, selection: ctx.selection,
      servingCatalog: serving.pointer, receiptSha256: ctx.receiptSha256, pointers: POINTERS.map((key, index) => ({ key, previous: stored(previous[index]), next: stored(next[index]),
        previousSha256: hash(previous[index].body), nextSha256: hash(next[index].body) })) };
    const bytes = json(value);
    for (const body of [bytes, serving.body, ...next.map(pointer => pointer.body)])
      assert.ok(body.length <= WRITE_LIMIT, 'activation control write exceeds budget');
    return { intent: value, intentBytes: bytes, intentSha256: hash(bytes) };
  });
  const snapshotKey = `catalogs/snapshots/${serving.pointer.catalogId}.json`;
  const snapshot = await check('immutable-snapshot-read', () => get(io, snapshotKey, false));
  if (snapshot) {
    await check('immutable-snapshot-validation', () => {
      assert.equal(hash(snapshot.body), serving.pointer.catalogSha256);
      assert.equal(snapshot.customMetadata.sha256, serving.pointer.catalogSha256, 'existing immutable snapshot lacks verified metadata');
    });
  } else {
    await check('immutable-snapshot-create-readback', async () => {
      await put(io, snapshotKey, serving.body, { ifNoneMatch: '*', customMetadata: { sha256: serving.pointer.catalogSha256 }, httpMetadata: { contentType: 'application/json' } });
      const saved = await get(io, snapshotKey);
      assert.equal(hash(saved.body), serving.pointer.catalogSha256);
      assert.equal(saved.customMetadata.sha256, serving.pointer.catalogSha256);
    });
  }
  await check('durable-intent-create-readback', async () => {
    await put(io, `${root(ctx)}intent.json`, intentBytes, { ifNoneMatch: '*' });
    assert.equal(hash((await get(io, `${root(ctx)}intent.json`)).body), intentSha256, 'durable intent readback failed');
  });
  let journalEtag;
  const journal = async value => { journalEtag = await put(io, `${root(ctx)}journal.json`, json({ schemaVersion: 1, intentSha256, ...value }),
    journalEtag ? { ifMatch: journalEtag } : { ifNoneMatch: '*' }); };
  try {
    await journal({ state: 'prepared', pointers: [] });
    health(await verifyConsumer({ origin: STAGING_ORIGIN }));
    validateRelease(prepared.release, prepared.manifest, ctx.selection, now());
    validateCatalog(prepared.catalogPointer, prepared.catalogObject.body, ctx.selection, now());
    const changed = [];
    for (const pointer of intent.pointers) {
      const nextObject = restored(pointer.next);
      const etag = await put(io, pointer.key, nextObject.body, { ifMatch: pointer.previous.etag,
        customMetadata: { 'activation-id': ctx.activationId, 'activation-source-sha': ctx.sourceSha, sha256: pointer.nextSha256 },
        httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' } });
      const current = await get(io, pointer.key); assert.equal(current.etag, etag); assert.ok(owned(current, intent, pointer), 'pointer readback/ownership mismatch');
      changed.push({ key: pointer.key, etag }); await journal({ state: 'activating', pointers: changed });
    }
    const proof = await verifyLive({ origin: STAGING_ORIGIN, selection: ctx.selection, manifest: prepared.manifest,
      catalog: serving.catalog, sourceCatalog: prepared.catalog, servingCatalog: serving.pointer });
    assertLiveProof(proof, prepared, ctx, serving.pointer);
    for (const pointer of intent.pointers) assert.ok(owned(await get(io, pointer.key), intent, pointer), 'pointer changed during live verification');
    validateRelease(prepared.release, prepared.manifest, ctx.selection, now());
    validateCatalog(prepared.catalogPointer, prepared.catalogObject.body, ctx.selection, now());
    await journal({ state: 'complete', pointers: changed, liveProofSha256: hash(JSON.stringify(proof)) });
    return { schemaVersion: 1, selection: ctx.selection, servingCatalog: serving.pointer, activationId: ctx.activationId, sourceSha: ctx.sourceSha,
      intentSha256, liveProofSha256: hash(JSON.stringify(proof)), activated: true, productionWritten: false };
  } catch (error) {
    let recovery;
    try { recovery = await recoverActivation(ctx, io); } catch { recovery = { state: 'recovery-required' }; }
    throw Object.assign(new Error(`staging activation failed; ${recovery.state}`, { cause: error }), { recovery });
  }
}
