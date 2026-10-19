// W15: staging Wind100 journal, retention and never-activated (orphan) reclaim.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ACCOUNT, COMPONENTS, DATA, JOURNAL_PREFIX, MODEL, POINTER_KEY, SOURCE_SHA, activateCandidate, controllerDigest,
  createPointerS3, hash, journalKeyFor, makePointerJournal, readPolicy, recurringPrefixCapacity,
  validatePointerJournal,
} from '../tools/staging-wind100.mjs';
import { INLINE_RECLAIM, STAGING_TARGET, createStagingReclaimIo, main, planRetention, reclaimRetired,
  retentionNotices } from '../tools/staging-wind100-retention.mjs';
import { ORPHAN_MIN_AGE_MS } from '../tools/wind100-retention.mjs';

const HOUR = 3_600_000;
const POINT_OBJECTS = 4_140;
const PREFIX = 'components/point-ecmwf/stage-wind100-recurring-point-ecmwf-';
const encode = value => Buffer.from(`${JSON.stringify(value)}\n`);
const BASE = Date.parse('2026-10-01T00:00:00Z');
const cadence = k => ({ k, init: BASE + k * 6 * HOUR, at: BASE + k * 6 * HOUR + 9 * HOUR });
const invocationFor = k => `${39100000000 + k}-1`;
const catalogIdFor = k => `stage-wind100-recurring-${invocationFor(k)}`;
const prefixFor = k => `${PREFIX}${invocationFor(k)}/`;
const uploadedAt = k => cadence(k).at - 30 * 60_000;
const runIdAt = time => new Date(time).toISOString().replace(/[-:T]/g, '').slice(0, 10);

// One staging bucket pair. `pointerIo` is the activator's transport (keys only); `io` is the
// retention transport (bucket and key), with R2-recorded LastModified per uploaded prefix.
function stagingStore() {
  const data = new Map(), components = new Map(), modified = new Map(), events = [];
  const stats = { deleted: 0 };
  let etag = 0;
  const pointerIo = {
    async get(key) {
      const body = data.get(key);
      return body ? { body, etag: key === POINTER_KEY ? `${etag}` : 'immutable' } : null;
    },
    async put(body, previous) {
      events.push(['put', hash(body)]);
      if (previous !== (data.has(POINTER_KEY) ? `${etag}` : null)) return false;
      data.set(POINTER_KEY, body); etag++; return true;
    },
    async immutable(key, body) {
      assert.ok(key.startsWith(JOURNAL_PREFIX));
      events.push(['journal', key]);
      if (data.has(key)) assert.ok(data.get(key).equals(body)); else data.set(key, body);
    },
  };
  const io = {
    async get(bucket, key) { assert.equal(bucket, DATA); const body = data.get(key); return body ? { body } : null; },
    async getIfPresent(bucket, key) { return io.get(bucket, key); },
    async listPrefix(prefix) { return [...(components.get(prefix)?.keys() ?? [])]; },
    async listNamespace() {
      const rows = [];
      for (const [prefix, keys] of components) for (const key of keys) rows.push({ key, lastModified: modified.get(prefix) });
      return rows;
    },
  };
  const deleteForPrefix = async prefix => ({ async delete(key) {
    assert.ok(key.startsWith(prefix)); assert.ok(components.get(prefix)?.delete(key)); stats.deleted++;
  } });
  const upload = (k, at, count = POINT_OBJECTS + 1) => {
    const keys = new Set();
    for (let index = 0; index < Math.min(count, POINT_OBJECTS); index++) keys.add(`${prefixFor(k)}v2/chunk-${index}.bin.gz`);
    if (count > POINT_OBJECTS) keys.add(`${prefixFor(k)}component.json`);
    components.set(prefixFor(k), keys); modified.set(prefixFor(k), new Date(at).toISOString());
  };
  const count = () => [...components.values()].reduce((n, keys) => n + keys.size, 0);
  const pointer = () => JSON.parse(data.get(POINTER_KEY));
  return { data, components, modified, events, stats, pointerIo, io, deleteForPrefix, upload, count, pointer };
}

// The immutable catalog and selection `prepareCandidate` writes for run k.
function publish(store, k, { rootPrefix = prefixFor(k), extra = null } = {}) {
  const { init, at } = cadence(k);
  const initializedAt = new Date(init).toISOString().replace('.000Z', 'Z');
  const freshUntil = new Date(init + 30 * HOUR).toISOString();
  const descriptor = { runId: runIdAt(init), initializedAt, freshUntil,
    source: 'ECMWF IFS 0.25 degree direct open-data GRIB',
    variables: { wind_speed: { kind: 'instantaneous', units: 'm/s' }, wind_speed_100m: { kind: 'instantaneous', units: 'm/s' } } };
  const catalog = { schemaVersion: 2, sequence: 1, parentCatalogId: null, createdAt: new Date(at).toISOString(),
    components: { 'point-ecmwf': { componentId: 'point-ecmwf', artifactId: rootPrefix.split('/')[2], rootPrefix,
      manifestKey: `${rootPrefix}component.json`, objectCount: POINT_OBJECTS, generationTime: initializedAt,
      mounts: ['point-series/v2/ecmwf/'], pointSeries: { schemaVersion: 1, modelId: MODEL, descriptor } },
    ...(extra ? { extra } : {}) }, rollbackEpoch: 0 };
  const catalogBody = encode(catalog);
  const selection = { schemaVersion: 1, kind: 'weatherx-staging-native-wind100-selection',
    status: 'DATA_QUALIFIED_NOT_ACTIVATED', targetOrigin: 'https://staging.weatherx.org', model: MODEL,
    runId: descriptor.runId, catalogId: catalogIdFor(k), catalogSha256: hash(catalogBody), sourceSha: SOURCE_SHA,
    inputSha256: hash(Buffer.from(`input-${k}`)), invocation: invocationFor(k),
    publicationMode: 'point-only-recurring-v1', qualificationCanonicalSha256: 'c'.repeat(64), initializedAt,
    freshUntil, createdAt: new Date(at).toISOString(), isolatedStagingCandidate: true,
    sharedReadPinChanged: false, productionWritten: false, activated: false };
  store.data.set(`catalogs/snapshots/${catalogIdFor(k)}.json`, catalogBody);
  store.data.set(`staging-candidates/wind100/${catalogIdFor(k)}/selection.json`, encode(selection));
  return selection;
}

let pointRoot;
test.before(() => {
  // 4,140 planned point objects for the real capacity check (it counts the files it would upload).
  pointRoot = mkdtempSync(join(tmpdir(), 'staging-wind100-points-'));
  for (let index = 0; index < POINT_OBJECTS; index++) writeFileSync(join(pointRoot, `p${index}.bin`), 'x');
});
test.after(() => rmSync(pointRoot, { recursive: true, force: true }));
const qualification = { publicationMode: 'point-only-recurring-v1', pointPacks: { objectCount: POINT_OBJECTS } };
const capacity = store => recurringPrefixCapacity([...store.components.values()].flatMap(keys => [...keys]),
  qualification, pointRoot, readPolicy());

// The recurring job order: inline reclaim, capacity check, upload, publish, activate. `fail` stops
// a run after its upload began: 'upload' part way, 'publish' before metadata, 'activate' after it.
async function run(store, k, { reclaim = true, fail = null, orphans = true } = {}) {
  const { at } = cadence(k);
  const reclaimed = reclaim && store.data.has(POINTER_KEY)
    ? await reclaimRetired({ io: store.io, deleteForPrefix: store.deleteForPrefix, catalogValidator: () => true,
      now: () => at, orphans, ...INLINE_RECLAIM }) : null;
  const room = capacity(store);
  store.upload(k, uploadedAt(k), fail === 'upload' ? 1_000 : undefined);
  if (fail === 'upload' || fail === 'publish') return { room, reclaimed };
  const selection = publish(store, k);
  if (fail === 'activate') return { room, reclaimed };
  await activateCandidate({ selection, selectionSha256: hash(encode(selection)), io: store.pointerIo,
    now: () => at, catalogValidator: () => true });
  return { room, reclaimed };
}

function assertLiveIntact(store) {
  for (const entry of store.pointer().entries) {
    const keys = store.components.get(`${PREFIX}${entry.catalogId.slice('stage-wind100-recurring-'.length)}/`);
    assert.equal(keys?.size, POINT_OBJECTS + 1, `${entry.catalogId} lost objects`);
  }
}

test('a staging journal record is written before every pointer swap', async () => {
  const store = stagingStore();
  // The first pointer is a journal genesis; the record precedes the compare-and-swap.
  await run(store, 0);
  assert.deepEqual(store.events.map(([kind]) => kind), ['journal', 'put']);
  const first = store.data.get(POINTER_KEY);
  assert.equal(store.events[0][1], journalKeyFor(hash(first)));
  assert.equal(store.events[1][1], hash(first));
  const genesis = validatePointerJournal(JSON.parse(store.data.get(journalKeyFor(hash(first)))), first);
  assert.equal(genesis.previousBody, null); assert.equal(genesis.journalStart, false);
  await run(store, 1);
  const second = store.data.get(POINTER_KEY);
  const record = JSON.parse(store.data.get(journalKeyFor(hash(second))));
  assert.equal(record.ancestry, 'journaled');
  assert.equal(record.previousPointerSha256, hash(first));
  assert.ok(Buffer.from(record.previousPointerBodyBase64, 'base64').equals(first));
  // A lost compare-and-swap leaves a record no live pointer reaches; the retry writes its own.
  const selection = publish(store, 2);
  let lost = 1;
  const racing = { ...store.pointerIo, async put(body, previous) {
    if (lost-- > 0) { store.events.push(['put', hash(body)]); return false; }
    return store.pointerIo.put(body, previous);
  } };
  store.events.length = 0;
  let tick = cadence(2).at;
  await activateCandidate({ selection, selectionSha256: hash(encode(selection)), io: racing,
    now: () => tick++, catalogValidator: () => true });
  assert.deepEqual(store.events.map(([kind]) => kind), ['journal', 'put', 'journal', 'put']);
  assert.notEqual(store.events[0][1], store.events[2][1]);
  assert.equal(store.events[2][1], journalKeyFor(hash(store.data.get(POINTER_KEY))));
  // No swap without its record: a failed journal write stops activation before the pointer.
  const before = store.data.get(POINTER_KEY);
  const next = publish(store, 3);
  await assert.rejects(activateCandidate({ selection: next, selectionSha256: hash(encode(next)),
    io: { ...store.pointerIo, immutable: async () => { throw Error('journal PutObject 503'); } },
    now: () => cadence(3).at, catalogValidator: () => true }), /journal PutObject 503/);
  assert.ok(store.data.get(POINTER_KEY).equals(before));
  // A record must be the exact activation of its previous pointer.
  const forged = { ...record, previousPointerBodyBase64: Buffer.from(first.toString().replace(/"updatedAt":"[^"]+"/,
    '"updatedAt":"2026-09-01T00:00:00.000Z"')).toString('base64') };
  assert.throws(() => validatePointerJournal(forged, second));
  assert.throws(() => makePointerJournal(second, first, 'genesis'), /genesis/);
  assert.throws(() => makePointerJournal(first, second, 'journaled'));
});

test('the staging pointer transport writes only immutable journal records besides the pointer', async () => {
  class Command { constructor(input) { this.input = input; } }
  const sent = [];
  let stored = null;
  const client = { async send(command) {
    sent.push(command.input);
    if (command.input.Body) { stored = command.input.Body; return {}; }
    if (!stored) throw { $metadata: { httpStatusCode: 404 } };
    return { ContentLength: stored.length, Body: [stored], ETag: 'e' };
  } };
  const io = await createPointerS3({ STAGING_R2_ACCOUNT_ID: ACCOUNT }, client,
    { GetObjectCommand: Command, PutObjectCommand: Command });
  const key = journalKeyFor('a'.repeat(64));
  assert.equal(await io.get(key), null);
  await io.immutable(key, Buffer.from('{"x":1}\n'));
  assert.deepEqual({ ...sent[1], Body: undefined }, { Bucket: DATA, Key: key, Body: undefined, ContentLength: 8,
    IfNoneMatch: '*', Metadata: { sha256: hash(Buffer.from('{"x":1}\n')) }, ContentType: 'application/json',
    CacheControl: 'public, max-age=31536000, immutable' });
  await assert.rejects(io.immutable(POINTER_KEY, Buffer.from('{}')), /only Wind100 journal records/);
  await assert.rejects(io.immutable('catalogs/snapshots/stage-wind100-recurring-1-1.json', Buffer.from('{}')));
});

test('a 100-publication staging simulation never reaches the cap while publications fail', async () => {
  const failure = k => (k % 7 === 3 ? 'activate' : k % 11 === 5 ? 'publish' : k % 13 === 8 ? 'upload' : null);
  const store = stagingStore();
  let peak = 0, warnings = 0, failures = 0, orphansDeleted = 0;
  for (let k = 0; k < 100; k++) {
    const result = await run(store, k, { reclaim: k % 9 !== 4, fail: failure(k) });
    peak = Math.max(peak, result.room.existingObjects + result.room.plannedObjects);
    if (result.room.headroomPublications < 3) warnings++;
    if (failure(k)) failures++;
    orphansDeleted += result.reclaimed?.orphanCandidates?.length ?? 0;
    for (const id of result.reclaimed?.orphanCandidates ?? []) {
      const j = Number(id.split('-').at(-2)) - 39100000000;
      assert.ok(cadence(k).at - uploadedAt(j) >= ORPHAN_MIN_AGE_MS, `${id} reclaimed too young`);
    }
    assertLiveIntact(store);
  }
  assert.ok(failures >= 25, `${failures} failed publications`);
  assert.ok(peak <= 50_000, `peak ${peak}`);
  assert.ok(peak <= 9 * (POINT_OBJECTS + 1), `peak ${peak}`);
  assert.equal(warnings, 0);
  assert.ok(orphansDeleted >= failures - 6);
  // Without retention (staging before W15) the same schedule is refused at the cap.
  const unmanaged = stagingStore();
  await assert.rejects((async () => {
    for (let k = 0; k < 100; k++) await run(unmanaged, k, { reclaim: false, fail: failure(k) });
  })(), /lacks capacity for this candidate/);
  // Retired reclaim alone still fills up with never-activated uploads.
  const retiredOnly = stagingStore();
  await assert.rejects((async () => {
    for (let k = 0; k < 100; k++) await run(retiredOnly, k, { orphans: false, fail: failure(k) });
  })(), /lacks capacity for this candidate/);
});

test('an unjournaled staging pointer migrates: history stops at the journal start, nothing older is retired', async () => {
  const store = stagingStore();
  // Before W15: pointers written with no journal (runs 0-3), objects uploaded long ago.
  for (let k = 0; k < 4; k++) {
    store.upload(k, uploadedAt(k));
    const selection = publish(store, k);
    await activateCandidate({ selection, selectionSha256: hash(encode(selection)), io: store.pointerIo,
      now: () => cadence(k).at, catalogValidator: () => true });
  }
  for (const key of [...store.data.keys()]) if (key.startsWith(JOURNAL_PREFIX)) store.data.delete(key);
  // The first run after deployment: the live pointer has no record yet. Nothing is journal-proven,
  // the live entries stay protected, and old unreferenced prefixes are reclaimable as orphans, so a
  // staging prefix already at its cap is relieved before the capacity check.
  const first = await planRetention({ io: store.io, now: () => cadence(4).at + 2 * 24 * HOUR,
    catalogValidator: () => true, orphans: true });
  assert.equal(first.reachedJournalStart, true); assert.equal(first.ancestryRecordsChecked, 0);
  assert.deepEqual(first.candidates, []);
  assert.deepEqual(first.protectedCatalogIds, [catalogIdFor(2), catalogIdFor(3)]);
  assert.deepEqual(first.orphanCandidates.map(row => row.catalogId), [catalogIdFor(0), catalogIdFor(1)]);
  // ...but never a live or in-grace one: just after run 3, run 1 is still inside its grace.
  const early = await planRetention({ io: store.io, now: () => cadence(3).at, catalogValidator: () => true,
    orphans: true });
  assert.deepEqual(early.orphanCandidates, []);
  // The first journaled activation marks its previous pointer pre-journal.
  await run(store, 4, { reclaim: false });
  const record = JSON.parse(store.data.get(journalKeyFor(hash(store.data.get(POINTER_KEY)))));
  assert.equal(record.ancestry, 'pre-journal');
  const at = cadence(12).at;
  const plan = await planRetention({ io: store.io, now: () => at, catalogValidator: () => true, orphans: true,
    maximumOrphans: 8 });
  assert.equal(plan.reachedJournalStart, true); assert.equal(plan.reachedGenesis, false);
  assert.equal(plan.ancestryRecordsChecked, 1);
  // Run 2 left the pointer in the journaled transition: journal-proven retired.
  assert.deepEqual(plan.candidates.map(row => row.catalogId), [catalogIdFor(2)]);
  // Runs 0 and 1 left it before journaling began: only the orphan rules (unreferenced, 48 hours,
  // selection past grace) can reclaim them; their selections exist and are long expired. The
  // 10,000-object budget holds one retired and one orphan prefix; the next run takes the other.
  assert.deepEqual(plan.orphanCandidates.map(row => [row.catalogId, row.selection]), [[catalogIdFor(0), 'expired']]);
  assert.deepEqual(plan.protectedCatalogIds, [catalogIdFor(3), catalogIdFor(4)]);
  await reclaimRetired({ io: store.io, deleteForPrefix: store.deleteForPrefix, catalogValidator: () => true,
    now: () => at, orphans: true, ...INLINE_RECLAIM });
  const next = await planRetention({ io: store.io, now: () => at, catalogValidator: () => true, orphans: true });
  assert.deepEqual(next.skippedEmptyCatalogIds, [catalogIdFor(2)]);
  assert.deepEqual(next.orphanCandidates.map(row => [row.catalogId, row.selection]), [[catalogIdFor(1), 'expired']]);
  assertLiveIntact(store);
  // A missing record anywhere after the journal start still aborts the whole plan.
  await run(store, 5, { reclaim: false });
  store.data.delete(journalKeyFor(hash(Buffer.from(record.previousPointerBodyBase64, 'base64'))));
  const middle = [...store.data.keys()].find(key => key.startsWith(JOURNAL_PREFIX)
    && JSON.parse(store.data.get(key)).ancestry === 'pre-journal');
  store.data.delete(middle);
  await assert.rejects(planRetention({ io: store.io, now: () => at, catalogValidator: () => true }));
});

test('a staging prefix already at its cap with no journal is relieved on the first run after deployment', async () => {
  const store = stagingStore();
  // Twelve unjournaled publications fill 49,692 of 50,000 objects, as staging may be today.
  for (let k = 0; k < 12; k++) await run(store, k, { reclaim: false });
  for (const key of [...store.data.keys()]) if (key.startsWith(JOURNAL_PREFIX)) store.data.delete(key);
  assert.equal(store.count(), 12 * (POINT_OBJECTS + 1));
  assert.throws(() => capacity(store), /lacks capacity for this candidate/);
  const first = await run(store, 12);
  assert.equal(first.reclaimed.status, 'reclaimed-retired-staging-wind100-objects');
  assert.deepEqual(first.reclaimed.candidates, []);
  assert.equal(first.reclaimed.orphanCandidates.length, 2);
  assert.ok(first.room.existingObjects + first.room.plannedObjects <= 50_000);
  assert.equal(JSON.parse(store.data.get(journalKeyFor(hash(store.data.get(POINTER_KEY))))).ancestry, 'pre-journal');
  for (let k = 13; k < 30; k++) {
    const next = await run(store, k);
    assert.ok(next.room.existingObjects + next.room.plannedObjects <= 50_000);
    assertLiveIntact(store);
  }
});

test('a young or referenced staging orphan is never deleted, including one a live catalog names', async () => {
  const OLD = 90, YOUNG = 91; // invocations no run below reuses
  const store = stagingStore();
  for (let k = 0; k < 3; k++) await run(store, k);
  // Run 4 activates a catalog whose point component names an old never-activated upload's prefix
  // (invocation OLD's), not its own; the staging activator does not bind the two.
  await run(store, 3);
  store.upload(OLD, cadence(3).at - 72 * HOUR);
  const named = publish(store, 4, { rootPrefix: prefixFor(OLD) });
  store.upload(4, uploadedAt(4));
  await activateCandidate({ selection: named, selectionSha256: hash(encode(named)), io: store.pointerIo,
    now: () => cadence(4).at, catalogValidator: () => true });
  store.upload(YOUNG, cadence(4).at - 47 * HOUR); // never activated, 47 hours old
  const at = cadence(4).at;
  const plan = await planRetention({ io: store.io, now: () => at, catalogValidator: () => true, orphans: true,
    maximumOrphans: 8 });
  assert.equal(plan.orphanInventory, 'listed');
  const orphanIds = plan.orphanCandidates.map(row => row.catalogId);
  assert.ok(!orphanIds.includes(catalogIdFor(OLD)), 'a prefix a live catalog names is referenced');
  assert.ok(!orphanIds.includes(catalogIdFor(YOUNG)), 'a 47-hour-old upload is too young');
  for (const id of [...plan.protectedCatalogIds, catalogIdFor(0), catalogIdFor(1), catalogIdFor(2)])
    assert.ok(!orphanIds.includes(id), `${id} is referenced by the pointer or its journal`);
  const before = store.count();
  const result = await reclaimRetired({ io: store.io, deleteForPrefix: store.deleteForPrefix,
    catalogValidator: () => true, now: () => at, orphans: true, ...INLINE_RECLAIM });
  assert.equal(result.deleted, before - store.count());
  for (const k of [OLD, YOUNG]) assert.ok(store.components.get(prefixFor(k)).size > 0);
  assertLiveIntact(store);
  const notices = retentionNotices(result);
  assert.match(notices.summary, /^Staging Wind100 retention: /);
  // Once run 4 has left the pointer and its grace, its catalog no longer holds that old prefix.
  for (let k = 5; k < 14; k++) await run(store, k);
  assert.equal(store.components.get(prefixFor(OLD)).size, 0);
  assert.equal(store.components.get(prefixFor(YOUNG)).size, 0);
  assertLiveIntact(store);
});

test('staging inline reclaim uses only the staging writer token and per-prefix DeleteObject credentials', async () => {
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class ListObjectsV2Command { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; } }
  const sdk = { GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand };
  const reads = [];
  const readClient = { async send(command) {
    reads.push(command.input);
    if (command.input.Key === 'staging-candidates/wind100/stage-wind100-recurring-9-1/selection.json')
      throw { $metadata: { httpStatusCode: 404 } };
    return { ContentLength: 2, Body: [Buffer.from('{}')], ETag: 'e', IsTruncated: false,
      Contents: [{ Key: `${PREFIX}9-1/a.bin`, LastModified: new Date('2026-10-01T00:00:00Z') }] };
  }, destroy() {} };
  const writer = { STAGING_R2_ACCOUNT_ID: ACCOUNT, STAGING_R2_WRITE_ACCESS_KEY_ID: 'stagingwriterid',
    STAGING_R2_WRITE_SECRET_ACCESS_KEY: 's'.repeat(64) };
  await assert.rejects(createStagingReclaimIo({ ...writer, STAGING_R2_WRITE_ACCESS_KEY_ID: '' }, sdk, readClient));
  for (const extra of ['PRODUCTION_WIND100_R2_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID',
    'R2_PRODUCTION_ACCESS_KEY_ID', 'SHARED_R2_READ_ACCESS_KEY_ID', 'RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID'])
    await assert.rejects(createStagingReclaimIo({ ...writer, [extra]: 'x' }, sdk, readClient), new RegExp(extra));
  const sessions = [], deletes = [];
  const io = await createStagingReclaimIo(writer, sdk, readClient, credentials => {
    sessions.push(credentials);
    return { async send(command) { deletes.push(command.input); }, destroy() {} };
  });
  await io.get(DATA, POINTER_KEY);
  await io.get(DATA, journalKeyFor('b'.repeat(64)));
  assert.equal(await io.getIfPresent(DATA, 'staging-candidates/wind100/stage-wind100-recurring-9-1/selection.json'), null);
  assert.deepEqual(await io.listNamespace(10), [{ key: `${PREFIX}9-1/a.bin`, lastModified: '2026-10-01T00:00:00.000Z' }]);
  assert.deepEqual(reads.at(-1), { Bucket: COMPONENTS, Prefix: PREFIX, MaxKeys: 1000 });
  const prior = reads.length;
  await assert.rejects(io.get(DATA, 'catalogs/current.json'));
  await assert.rejects(io.get('weatherx-data-production', POINTER_KEY));
  await assert.rejects(io.listPrefix('components/point-ecmwf/stage-wind100-point-ecmwf-1-1/', 10));
  assert.equal(reads.length, prior);
  const client = await io.deleteForPrefix(`${PREFIX}9-1/`);
  await client.delete(`${PREFIX}9-1/a.bin`);
  await assert.rejects(client.delete(`${PREFIX}8-1/a.bin`));
  await assert.rejects(io.deleteForPrefix('components/point-ecmwf/prod-wind100-recurring-point-ecmwf-1-1/'));
  assert.deepEqual(deletes, [{ Bucket: COMPONENTS, Key: `${PREFIX}9-1/a.bin` }]);
  const claims = JSON.parse(Buffer.from(Buffer.from(sessions[0].sessionToken, 'base64')
    .toString().slice(4).split('.')[1], 'base64url'));
  assert.equal(claims.bucket, 'weatherx-components-staging');
  assert.equal(claims.iss, 'stagingwriterid');
  assert.deepEqual(claims.actions, ['DeleteObject']);
  assert.deepEqual(claims.paths.prefixPaths, [`${PREFIX}9-1/`]);
  assert.equal(claims.exp - claims.iat, 900);
});

const recurringEnv = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/bake.yml@refs/heads/main',
  STAGING_DATA_ISOLATION_APPROVED: 'true', STAGING_WIND100_ENABLED: 'true', STAGING_R2_ACCOUNT_ID: ACCOUNT,
  ATMOS_SHA: readPolicy().sourceSha, CORE_ATMOS_SHA: readPolicy().coreSourceSha,
  STAGING_WIND100_CONTROLLER_SHA256: controllerDigest(), MODEL_ID: 'ecmwf', GITHUB_RUN_ID: '39100000099',
  GITHUB_RUN_ATTEMPT: '1', STAGING_R2_WRITE_ACCESS_KEY_ID: 'stagingwriterid',
  STAGING_R2_WRITE_SECRET_ACCESS_KEY: 's'.repeat(64) });

test('the staging reclaim command runs behind the recurring gate with bounded IO', async () => {
  await assert.rejects(main('reclaim', { ...recurringEnv(), STAGING_WIND100_CONTROLLER_SHA256: 'f'.repeat(64) }, ['/s']));
  await assert.rejects(main('reclaim', { ...recurringEnv(), RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID: 'x' }, ['/s']));
  await assert.rejects(main('reclaim', { ...recurringEnv(), STAGING_R2_WRITE_ACCESS_KEY_ID: '' }, ['/s']));
  await assert.rejects(main('dry-run', recurringEnv(), ['/s']), /usage/);
  const never = () => new Promise(() => {});
  const closed = [];
  await assert.rejects(main('reclaim', recurringEnv(), ['/s'], () => {}, { ioTimeoutMs: 50,
    createReclaimIo: async () => ({ get: never, listPrefix: never, deleteForPrefix: never, close: () => closed.push('io') }),
    loadCatalogValidator: async () => ({ validate: () => true, close: () => closed.push('validator') }) }),
  /^Error: inline reclaim failed \(stage plan-and-delete; completed gets 0, lists 0, delete credentials 0, deletes 0\): get staging-candidates\/wind100\/current-v1\.json did not settle within 50 ms/);
  assert.deepEqual(closed.sort(), ['io', 'validator']);
  // A full run through the command: result, progress lines and a summary.
  const store = stagingStore();
  for (let k = 0; k < 12; k++) await run(store, k, { reclaim: false });
  const lines = [], directory = mkdtempSync(join(tmpdir(), 'staging-wind100-summary-'));
  try {
    const summary = join(directory, 'summary.md');
    const result = await main('reclaim', { ...recurringEnv(), GITHUB_STEP_SUMMARY: summary }, ['/s'],
      line => lines.push(line), { createReclaimIo: async () => ({ ...store.io,
        deleteForPrefix: store.deleteForPrefix, close() {} }),
      loadCatalogValidator: async () => ({ validate: () => true, close() {} }), now: () => cadence(12).at });
    assert.equal(result.status, 'reclaimed-retired-staging-wind100-objects');
    assert.equal(result.deleted, 2 * (POINT_OBJECTS + 1));
    assert.equal(lines.filter(line => line.startsWith('reclaim progress: ')).length, 1 + 2 * 17);
    assert.match(readFileSync(summary, 'utf8'), /^Staging Wind100 retention: reclaimed-retired-staging-wind100-objects; .*never-activated none \(inventory listed; refused none\)\n$/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
  assertLiveIntact(store);
});

test('the recurring staging workflow reclaims before its capacity check with the writer token only', () => {
  const workflow = readFileSync(new URL('../.github/workflows/staging-wind100-recurring.yml', import.meta.url), 'utf8');
  const steps = workflow.split(/\n      - /);
  const reclaimIndex = steps.findIndex(step => step.startsWith('name: Reclaim retired and never-activated staging point prefixes'));
  const uploadIndex = steps.findIndex(step => step.startsWith('name: Upload one immutable staging point component'));
  assert.ok(reclaimIndex > 0 && uploadIndex === reclaimIndex + 1);
  const reclaim = steps[reclaimIndex], upload = steps[uploadIndex];
  // The same step shape as production: guarded, bounded, and never able to publish on failure.
  const production = readFileSync(new URL('../.github/workflows/production-wind100-recurring.yml', import.meta.url), 'utf8')
    .split(/\n      - /).find(step => step.startsWith('name: Reclaim retired and never-activated production point prefixes'));
  const shape = step => step.split('\n').filter(line => /^\s+(?:if|continue-on-error|timeout-minutes):/.test(line)).join('\n');
  assert.equal(shape(reclaim), shape(production));
  assert.match(reclaim, /continue-on-error: true/);
  assert.match(reclaim, /timeout-minutes: 30/);
  assert.match(reclaim, /if: \$\{\{ steps\.preflight\.outputs\.status == 'new-input' \}\}/);
  assert.match(reclaim, /node cycle\/tools\/staging-wind100-retention\.mjs reclaim "\$GITHUB_WORKSPACE\/atmos"/);
  assert.match(reclaim, /::warning title=Staging Wind100 reclaim::inline reclaim failed; the capacity check decides/);
  const secrets = text => [...text.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]).sort();
  assert.deepEqual(secrets(reclaim), ['STAGING_R2_WRITE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_SECRET_ACCESS_KEY']);
  assert.ok(secrets(reclaim).every(name => secrets(upload).includes(name)));
  assert.doesNotMatch(reclaim, /RCLONE_CONFIG|PRODUCTION|CATALOG_/);
  assert.match(upload, /recurring-retention-gate/);
});

test('the staging controller digest covers its retention, generic planner and bounded-step modules', () => {
  const code = readFileSync(new URL('../tools/staging-wind100.mjs', import.meta.url), 'utf8');
  const files = code.slice(code.indexOf('const CONTROLLER_FILES = ['), code.indexOf('];', code.indexOf('const CONTROLLER_FILES = [')));
  for (const path of ['tools/staging-wind100-retention.mjs', 'tools/wind100-retention.mjs', 'tools/wind100-bounded-step.mjs',
    '.github/workflows/staging-wind100-recurring.yml']) assert.ok(files.includes(`'${path}'`), path);
  const production = readFileSync(new URL('../tools/production-wind100.mjs', import.meta.url), 'utf8');
  for (const path of ['tools/wind100-retention.mjs', 'tools/wind100-bounded-step.mjs']) assert.ok(production.includes(`'${path}'`), path);
  assert.equal(STAGING_TARGET.componentBucket, 'weatherx-components-staging');
  assert.equal(STAGING_TARGET.dataBucket, 'weatherx-data-staging');
});
