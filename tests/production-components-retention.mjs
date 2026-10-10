import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalArtifact, capacityLine, controllerDigest, createRetentionIo, executeRetention, planRetention, planSummary,
  readPolicy, scopedDeleteCredentials, scopedRoot, validatePolicy } from '../tools/production-components-retention.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-10T06:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const policy = { ...readPolicy(), maximumDeletesPerRun: 40, deleteConcurrency: 3, maximumChainSnapshots: 400 };
const DATA = policy.dataBucket, COMPONENTS = policy.componentBucket, STAGING = policy.stagingControlBucket;
const artifact = (id, hoursAgo, suffix = 1791000000) => `${id}-${iso(T0 - hoursAgo * HOUR).replace(/[-:]/g, '').replace('.000', '')}-${suffix + hoursAgo}`;
const rootFor = (id, hoursAgo, suffix) => `components/${id}/${artifact(id, hoursAgo, suffix)}/`;

// In-memory R2: objects carry body, metadata and LastModified; snapshots get the writer's sha256 metadata.
function world() {
  const buckets = { [DATA]: new Map(), [COMPONENTS]: new Map(), [STAGING]: new Map() };
  const put = (bucket, key, body, modified = T0, metadata = {}) =>
    buckets[bucket].set(key, { body: Buffer.from(body), modified, metadata });
  const components = new Map();
  function component(id, hoursAgo, { objects = 3, layout = null, suffix } = {}) {
    const root = rootFor(id, hoursAgo, suffix);
    const modified = T0 - hoursAgo * HOUR;
    for (let i = 0; i < objects; i++) put(COMPONENTS, `${root}f${i}.png`, `payload ${root} ${i}`, modified);
    const manifest = `${JSON.stringify({ schemaVersion: layout ? 2 : 1, componentId: id, artifactId: root.split('/')[2],
      rootPrefix: root, objectCount: objects, quality: { status: 'passed' }, ...(layout ? { objectLayout: layout } : {}) })}\n`;
    put(COMPONENTS, `${root}component.json`, manifest, modified);
    const entry = { schemaVersion: 1, componentId: id, artifactId: root.split('/')[2], rootPrefix: root,
      manifestKey: `${root}component.json`, manifestSha256: sha(manifest), generationTime: iso(modified) };
    components.set(root, entry);
    return entry;
  }
  let head = null;
  function promote(entries, at, { rollbackOf } = {}) {
    const parent = head;
    const sequence = (parent?.sequence ?? 0) + 1;
    const catalogId = `${sequence}-c${sequence}`;
    const merged = { ...(parent?.components ?? {}) };
    for (const entry of entries) merged[entry.componentId] = entry;
    const catalog = { schemaVersion: 2, sequence, parentCatalogId: parent?.catalogId ?? null, createdAt: iso(at), components: merged,
      rollbackEpoch: 0, ...(rollbackOf ? { rollbackOfCatalogId: rollbackOf } : {}) };
    const body = `${JSON.stringify(catalog)}\n`;
    put(DATA, `catalogs/snapshots/${catalogId}.json`, body, at, { sha256: sha(body) });
    const pointer = { schemaVersion: 2, catalogId, sequence, publishedAt: iso(at), catalogSha256: sha(body),
      previousCatalogId: parent?.catalogId ?? null, ...(rollbackOf ? { rollbackOfCatalogId: rollbackOf } : {}) };
    put(DATA, 'catalogs/current.json', `${JSON.stringify(pointer)}\n`, at);
    head = { catalogId, sequence, components: merged };
    return catalogId;
  }
  const io = {
    deletes: [], reads: 0,
    async get(bucket, key, maximum) {
      io.reads += 1;
      const value = buckets[bucket]?.get(key);
      if (!value) throw Object.assign(new Error(`NoSuchKey ${bucket}/${key}`), { name: 'NoSuchKey' });
      assert.ok(value.body.length <= maximum);
      return { body: value.body, metadata: value.metadata };
    },
    async getOptional(bucket, key, maximum) { return buckets[bucket]?.has(key) ? io.get(bucket, key, maximum) : null; },
    async listPrefixes(prefix) {
      const prefixes = new Set(), rows = [];
      for (const [key, value] of buckets[COMPONENTS]) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length), slash = rest.indexOf('/');
        if (slash < 0) rows.push({ key, size: value.body.length }); else prefixes.add(prefix + rest.slice(0, slash + 1));
      }
      return { prefixes: [...prefixes].sort(), rows };
    },
    async list(prefix, onRow) {
      for (const [key, value] of [...buckets[COMPONENTS]].sort(([a], [b]) => a.localeCompare(b)))
        if (key.startsWith(prefix)) onRow({ key, size: value.body.length, lastModified: value.modified, etag: `"${sha(value.body).slice(0, 32)}"` });
    },
    async listRows(prefix) { const rows = []; await io.list(prefix, row => rows.push(row)); return rows; },
    async deleteForPrefix(prefix) {
      return { delete: async key => { assert.ok(key.startsWith(prefix)); io.deletes.push(key); buckets[COMPONENTS].delete(key); }, close() {} };
    },
  };
  return { buckets, put, component, promote, io, components, head: () => head };
}

// Ten days of history: ECMWF twice a day, HRRR hourly-ish, an obs component, a Wind100 root and an experiment.
function history({ pinCatalog = false, referenced = false } = {}) {
  const w = world();
  const old = [];
  for (let h = 240; h >= 0; h -= 12) {
    const ecmwf = w.component('ecmwf', h), point = w.component('point-ecmwf', h, { objects: 2 });
    const hrrr = w.component('hrrr', h, { objects: 4 });
    w.promote([ecmwf, point, hrrr], T0 - h * HOUR);
    if (h > 168 + 12) old.push(ecmwf.rootPrefix, point.rootPrefix, hrrr.rootPrefix);
  }
  // A failed upload that never activated, 9 days old: unreferenced, so eligible.
  const orphan = w.component('gfs', 216, { objects: 5 });
  // Recent orphan (in flight): held.
  const inflight = w.component('gfs', 1, { objects: 5, suffix: 1792000000 });
  // Out of scope and non-canonical roots never move.
  w.put(COMPONENTS, 'components/obs-metar/obs-metar-20260901T000000Z-1/data.json', 'obs', T0 - 900 * HOUR);
  w.put(COMPONENTS, 'components/point-ecmwf/prod-wind100-recurring-point-ecmwf-35834279562-1/chunk.bin.gz', 'w', T0 - 900 * HOUR);
  w.put(COMPONENTS, 'components/ecmwf/canary-20260909/file.png', 'canary', T0 - 900 * HOUR);
  let routed = null;
  if (referenced) {
    // A routed map component in the window that borrows objects from an 8-day-old root.
    const source = old.find(root => root.startsWith('components/ecmwf/'));
    const routingBody = `${JSON.stringify({ schemaVersion: 1, kind: 'weatherx-map-object-references-v1', sourceRoots: [
      { rootPrefix: source, manifestKey: `${source}component.json`, manifestSha256: sha('x') }] })}\n`;
    const root = rootFor('ecmwf', 0, 1793000000);
    w.put(COMPONENTS, `${root}.weatherx-object-references-v1.json`, routingBody, T0);
    routed = w.component('ecmwf', 0, { suffix: 1793000000, layout: { schemaVersion: 1, kind: 'references-v1',
      manifestKey: `${root}.weatherx-object-references-v1.json`, manifestSha256: sha(routingBody) } });
    w.promote([routed], T0 + 60_000);
    routed.source = source;
  }
  let pinned = null;
  if (pinCatalog) {
    // The staging pin names a 10-day-old catalog: all of its roots stay.
    pinned = '1-c1';
    w.put(STAGING, 'shared-read/pin.json', JSON.stringify({ schemaVersion: 1, releaseId: null, catalogId: pinned,
      expiresAt: iso(T0 - 100 * HOUR), reason: 'canary' }));
  }
  return { ...w, old, orphan, inflight, routed, pinned };
}
const now = () => T0 + 2 * HOUR;

test('policy and scope: only canonical model roots, never the Wind100 or experiment roots', () => {
  assert.doesNotThrow(() => validatePolicy(readPolicy()));
  assert.throws(() => validatePolicy({ ...readPolicy(), windowHours: 24 }), /7 days/);
  assert.throws(() => validatePolicy({ ...readPolicy(), componentBucket: 'weatherx-data-production' }));
  assert.ok(canonicalArtifact('ecmwf', 'ecmwf-20261009T120000Z-1791611713'));
  assert.ok(canonicalArtifact('point-ecmwf', 'point-ecmwf-20261008T120000Z-1791497751'));
  assert.ok(canonicalArtifact('point-gfs', `point-gfs-20261008T120000Z-${'a'.repeat(32)}`));
  for (const [id, value] of [['point-ecmwf', 'prod-wind100-recurring-point-ecmwf-35834279562-1'], ['ecmwf', 'canary-20260909'],
    ['ecmwf', 'ecmwf-20261009T120000.123Z-1791611713'], ['gfs', 'ecmwf-20261009T120000Z-1791611713']])
    assert.equal(canonicalArtifact(id, value), false, value);
  assert.ok(scopedRoot(policy, 'components/nam-hi/nam-hi-20261009T120000Z-1791611713/'));
  assert.equal(scopedRoot(policy, 'components/obs-metar/obs-metar-20261009T120000Z-1791611713/'), false);
  assert.equal(scopedRoot(policy, 'components/ecmwf/ecmwf-20261009T120000Z-1791611713'), false);
});

test('dry run keeps the verified window, pins and routed sources and selects the oldest unreferenced roots within budget', async () => {
  const h = history({ pinCatalog: true, referenced: true });
  const plan = await planRetention({ io: h.io, policy, now });
  const again = await planRetention({ io: h.io, policy, now });
  assert.equal(plan.planSha256, again.planSha256, 'the plan is deterministic');
  assert.equal(plan.baseline.catalogId, h.head().catalogId);
  assert.equal(plan.baseline.windowStart, iso(T0 + 60_000 - 168 * HOUR));
  // Window: snapshots from the baseline back to the one serving at the window start (promoted at T0-168h).
  assert.equal(plan.chain.oldestCreatedAt, iso(T0 - 168 * HOUR));
  assert.equal(plan.stagingPin.catalogId, '1-c1');
  const selected = plan.candidates.map(row => row.prefix);
  const keptBySnapshot = [...h.components.keys()].filter(root => {
    const hours = (T0 - Date.parse(h.components.get(root).generationTime)) / HOUR;
    return hours <= 168;
  });
  for (const root of keptBySnapshot) assert.ok(!selected.includes(root), `window root ${root}`);
  assert.ok(!selected.includes(h.routed.source), 'a routed source root stays');
  for (const id of ['ecmwf', 'point-ecmwf', 'hrrr']) assert.ok(!selected.includes(rootFor(id, 240)), `pinned catalog 1-c1 keeps ${id}`);
  assert.ok(selected.includes(rootFor('ecmwf', 228)), 'the oldest unpinned, unreferenced root goes first');
  assert.ok(!selected.includes(h.inflight.rootPrefix), 'recent uploads stay');
  assert.ok(selected.every(root => scopedRoot(policy, root)));
  assert.ok(plan.totals.objects <= policy.maximumDeletesPerRun);
  assert.ok(plan.eligible.objects > plan.totals.objects, 'the budget bounds this run, the rest waits');
  const ages = plan.candidates.map(row => Date.parse(row.newestModified));
  assert.deepEqual(ages, [...ages].sort((a, b) => a - b), 'oldest first');
  assert.ok(selected.includes(h.orphan.rootPrefix) || plan.eligible.roots > plan.totals.roots, 'never-activated old uploads are eligible');
  assert.equal(plan.report.held.nonCanonical.objects, 2, 'the Wind100 and canary roots are held');
  assert.equal(plan.report.held.outOfScope.objects, 1, 'the observation component is outside the model prefixes');
  assert.equal(Object.values(plan.report.held).reduce((n, v) => n + v.objects, 0) + plan.eligible.objects, plan.report.bucket.objects);
  assert.match(planSummary(plan), /planSha256 `[a-f0-9]{64}` · baseline catalog `\d+-c\d+`[\s\S]*This run deletes: \d+ roots[\s\S]*CAP OK/);
  assert.ok(plan.report.held.recent.objects >= 6);
  assert.match(plan.report.capacity, /^CAP OK: weatherx-components-production holds \d+ objects/);
  assert.match(plan.report.capacity, /owner budget; R2 sets no per-bucket object or byte limit\.$/);
  // Without the pin, catalog 1-c1's roots become eligible.
  h.buckets[STAGING].delete('shared-read/pin.json');
  const unpinned = await planRetention({ io: h.io, policy: { ...policy, maximumDeletesPerRun: 10_000 }, now });
  assert.ok(unpinned.eligible.roots > plan.eligible.roots);
});

test('cap line warns and alarms against the owner budget', () => {
  const p = readPolicy();
  const line = capacityLine(p, { objects: 10_770_000, bytes: 1_394e9 }, { objects: 2_000_000, bytes: 250e9 }, { objects: 260_000, bytes: 31e9 });
  assert.match(line, /^CAP WARN: weatherx-components-production holds 10,770,000 objects \/ 1394 GB against the 12,000,000 objects \/ 1500 GB budget \(89\.8% \/ 92\.9%\)/);
  assert.match(line, /after this plan 2,000,000 \/ 250 GB; last 24 h \+260,000 objects \/ \+31 GB, byte budget reached in 3\.4 days/);
  assert.match(capacityLine(p, { objects: 13e6, bytes: 1e12 }, { objects: 0, bytes: 0 }, { objects: 0, bytes: 0 }), /^CAP ALARM/);
});

test('planning fails closed on an unproven chain, unknown layout or unreadable pin', async () => {
  for (const [name, mutate, message] of [
    ['ancestor bytes altered', h => { const key = 'catalogs/snapshots/20-c20.json'; const v = h.buckets[DATA].get(key);
      h.buckets[DATA].set(key, { ...v, body: Buffer.from(v.body.toString().replace('"rollbackEpoch":0', '"rollbackEpoch":0 ')) }); }, /hash does not match/],
    ['ancestor metadata missing', h => { const key = 'catalogs/snapshots/20-c20.json'; h.buckets[DATA].get(key).metadata = {}; }, /hash does not match/],
    ['pointer altered', h => { const v = h.buckets[DATA].get('catalogs/current.json');
      h.buckets[DATA].set('catalogs/current.json', { ...v, body: Buffer.from(v.body.toString().replace(/"catalogSha256":"[a-f0-9]+"/, `"catalogSha256":"${'0'.repeat(64)}"`)) }); }, /hash does not match/],
    ['unknown layout', h => { const e = h.component('hrrr', 0, { suffix: 1794000000, layout: { schemaVersion: 1, kind: 'mystery-v9' } }); h.promote([e], T0 + 120_000); }, /unknown object layout/],
    ['unreadable pin', h => h.put(STAGING, 'shared-read/pin.json', '{"schemaVersion":2}'), /pin is unreadable/],
  ]) {
    const h = history();
    mutate(h);
    await assert.rejects(planRetention({ io: h.io, policy, now }), message, name);
  }
});

test('execution recomputes the approved plan as promotions continue and deletes exactly it, manifest last', async () => {
  const h = history({ referenced: true });
  const plan = await planRetention({ io: h.io, policy, now });
  // Production keeps promoting HRRR between the dry run and the approved execution.
  for (let i = 1; i <= 3; i++) h.promote([h.component('hrrr', -i, { suffix: 1795000000 })], T0 + i * 600_000);
  await assert.rejects(executeRetention({ io: h.io, policy, now, deleteForPrefix: h.io.deleteForPrefix,
    baselineCatalogId: plan.baseline.catalogId, approvedPlanSha256: sha('other') }), /differs from the approved plan/);
  await assert.rejects(executeRetention({ io: h.io, policy, now, deleteForPrefix: h.io.deleteForPrefix,
    baselineCatalogId: 'nope', approvedPlanSha256: plan.planSha256 }), /not in the live catalog chain|NoSuchKey/);
  assert.equal(h.io.deletes.length, 0);
  const result = await executeRetention({ io: h.io, policy, now, deleteForPrefix: h.io.deleteForPrefix,
    baselineCatalogId: plan.baseline.catalogId, approvedPlanSha256: plan.planSha256 });
  assert.equal(result.deleted, plan.totals.objects);
  assert.equal(h.io.deletes.length, plan.totals.objects);
  for (const candidate of plan.candidates) {
    const ours = h.io.deletes.filter(key => key.startsWith(candidate.prefix));
    assert.equal(ours.length, candidate.objectCount);
    assert.equal(ours[ours.length - 1], `${candidate.prefix}component.json`);
    assert.equal([...h.buckets[COMPONENTS].keys()].filter(key => key.startsWith(candidate.prefix)).length, 0);
  }
  for (const key of h.io.deletes) assert.ok(plan.candidates.some(row => key.startsWith(row.prefix)));
  assert.ok(h.buckets[COMPONENTS].has(`${h.routed.source}component.json`));
  assert.ok(h.buckets[COMPONENTS].has('components/point-ecmwf/prod-wind100-recurring-point-ecmwf-35834279562-1/chunk.bin.gz'));
  // Replay plans only what remains, with a new digest.
  const next = await planRetention({ io: h.io, policy, now });
  assert.notEqual(next.planSha256, plan.planSha256);
  assert.ok(next.candidates.every(row => !plan.candidates.some(done => done.prefix === row.prefix)));
});

test('the guard re-reads pointers before every delete and stops on re-promotion, rollback or a pin change', async () => {
  for (const [name, change, message] of [
    ['candidate promoted again', (h, plan) => h.promote([h.components.get(plan.candidates[1].prefix)], T0 + 900_000), /was promoted again/],
    ['rollback', (h, plan) => h.promote([], T0 + 900_000, { rollbackOf: plan.baseline.catalogId }), /rollback/],
    ['pin set', h => h.put(STAGING, 'shared-read/pin.json', JSON.stringify({ schemaVersion: 1, releaseId: null, catalogId: '2-c2', expiresAt: iso(T0) })), /pin changed/],
    ['pointer replaced off-chain', h => h.put(DATA, 'catalogs/current.json', h.buckets[DATA].get('catalogs/snapshots/3-c3.json') &&
      `${JSON.stringify({ schemaVersion: 2, catalogId: '3-c3', sequence: 3, publishedAt: JSON.parse(h.buckets[DATA].get('catalogs/snapshots/3-c3.json').body).createdAt,
        catalogSha256: sha(h.buckets[DATA].get('catalogs/snapshots/3-c3.json').body), previousCatalogId: '2-c2' })}\n`), /no longer descends|exceeds its bound/],
  ]) {
    const h = history();
    const plan = await planRetention({ io: h.io, policy, now });
    assert.ok(plan.candidates.length >= 2, name);
    const reads = [];
    const realGet = h.io.get;
    let changed = false;
    h.io.get = async (bucket, key, maximum) => { if (key === 'catalogs/current.json') reads.push(h.io.deletes.length); return realGet(bucket, key, maximum); };
    const deleteForPrefix = async prefix => ({ async delete(key) {
      h.io.deletes.push(key); h.buckets[COMPONENTS].delete(key);
      if (!changed && h.io.deletes.length === 2) { changed = true; change(h, plan); }
    }, close() {} });
    await assert.rejects(executeRetention({ io: h.io, policy, now, deleteForPrefix,
      baselineCatalogId: plan.baseline.catalogId, approvedPlanSha256: plan.planSha256 }), message, name);
    assert.ok(h.io.deletes.length < plan.totals.objects, `${name}: stopped early`);
    assert.ok(h.io.deletes.length <= 2 + policy.deleteConcurrency, `${name}: at most the in-flight deletes after the change`);
    const guarded = reads.filter(count => count >= 0).length;
    assert.ok(guarded >= h.io.deletes.length, `${name}: one pointer read per delete`);
  }
});

test('an approved baseline older than maximumPlanAgeHours is refused', async () => {
  const h = history();
  const plan = await planRetention({ io: h.io, policy, now });
  h.promote([h.component('hrrr', -60, { suffix: 1796000000 })], T0 + 60 * HOUR);
  await assert.rejects(executeRetention({ io: h.io, policy, now, deleteForPrefix: h.io.deleteForPrefix,
    baselineCatalogId: plan.baseline.catalogId, approvedPlanSha256: plan.planSha256 }), /older than maximumPlanAgeHours/);
  assert.equal(h.io.deletes.length, 0);
});

test('delete credentials are DeleteObject-only, 15 minutes, one canonical root', () => {
  const root = 'components/ecmwf/ecmwf-20261009T120000Z-1791611713/';
  const credential = scopedDeleteCredentials({ accessKeyId: 'abcdefghij', secretAccessKey: 's'.repeat(64) }, root, policy, 1_800_000_000);
  const jwt = Buffer.from(credential.sessionToken, 'base64').toString().slice(4);
  const parts = jwt.split('.');
  assert.equal(parts[2], createHmac('sha256', 's'.repeat(64)).update(`${parts[0]}.${parts[1]}`).digest('base64url'));
  assert.equal(credential.secretAccessKey, sha(jwt));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  assert.equal(claims.bucket, 'weatherx-components-production');
  assert.deepEqual(claims.actions, ['DeleteObject']);
  assert.deepEqual(claims.paths.prefixPaths, [root]);
  assert.equal(claims.exp - claims.iat, 900);
  for (const bad of ['components/ecmwf/', 'components/point-ecmwf/prod-wind100-recurring-point-ecmwf-35834279562-1/',
    'components/obs-metar/obs-metar-20261009T120000Z-1791611713/', 'catalogs/'])
    assert.throws(() => scopedDeleteCredentials({ accessKeyId: 'abcdefghij', secretAccessKey: 's'.repeat(64) }, bad, policy), bad);
});

test('adapter refuses broad secrets, reads only pointers, snapshots, pins and model manifests, deletes through scoped sessions', async () => {
  class GetObjectCommand { constructor(input) { this.input = input; } }
  class ListObjectsV2Command { constructor(input) { this.input = input; } }
  class DeleteObjectCommand { constructor(input) { this.input = input; } }
  const sdk = { GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand };
  const calls = [];
  const readClient = { async send(command) { calls.push(command.input);
    return { ContentLength: 2, Body: [Buffer.from('{}')], Metadata: { sha256: 'x' }, Contents: [], CommonPrefixes: [], IsTruncated: false }; }, destroy() {} };
  const settings = { PRODUCTION_COMPONENTS_R2_ACCOUNT_ID: policy.accountId,
    PRODUCTION_COMPONENTS_GC_READ_ACCESS_KEY_ID: 'readkeyid', PRODUCTION_COMPONENTS_GC_READ_SECRET_ACCESS_KEY: 'r'.repeat(64),
    PRODUCTION_COMPONENTS_GC_DELETE_ACCESS_KEY_ID: 'deletekeyid', PRODUCTION_COMPONENTS_GC_DELETE_SECRET_ACCESS_KEY: 'd'.repeat(64) };
  for (const broad of ['R2_PRODUCTION_ACCESS_KEY_ID', 'CATALOG_PROMOTION_KEY_PRODUCTION', 'PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_ACCESS_KEY_ID'])
    await assert.rejects(createRetentionIo({ ...settings, [broad]: 'x' }, policy, sdk, readClient), broad);
  await assert.rejects(createRetentionIo({ ...settings, PRODUCTION_COMPONENTS_R2_ACCOUNT_ID: 'f'.repeat(32) }, policy, sdk, readClient));
  const sessions = [], deletes = [];
  const io = await createRetentionIo(settings, policy, sdk, readClient, credentials => { sessions.push(credentials);
    return { async send(command) { deletes.push(command.input); }, destroy() {} }; });
  const root = 'components/ecmwf/ecmwf-20261009T120000Z-1791611713/';
  await io.get(DATA, 'catalogs/current.json', 1024);
  await io.get(DATA, 'catalogs/snapshots/1788-a96a7bf6-e1ca-4ba5-8d2b-faed36cf1001.json', 1024);
  await io.get(STAGING, 'shared-read/pin.json', 1024);
  await io.get(COMPONENTS, `${root}component.json`, 1024);
  await io.get(COMPONENTS, `${root}.weatherx-object-references-v1.json`, 1024);
  const prior = calls.length;
  for (const [bucket, key] of [[DATA, 'releases/current.json'], [DATA, 'production-candidates/wind100/current-v1.json'],
    [STAGING, 'catalogs/current.json'], [COMPONENTS, `${root}f0.png`], [COMPONENTS, 'components/obs-metar/x/component.json']])
    await assert.rejects(io.get(bucket, key, 1024), `${bucket}/${key}`);
  await assert.rejects(io.listRows('components/ecmwf/', 10));
  await assert.rejects(io.listRows('components/point-ecmwf/prod-wind100-recurring-point-ecmwf-35834279562-1/', 10));
  assert.equal(calls.length, prior, 'refused reads never reach S3');
  await io.listPrefixes(''); await io.listPrefixes('components/'); await io.list('components/hrrr/', () => {});
  assert.ok(calls.every(input => !('Delete' in input)));
  const client = await io.deleteForPrefix(root);
  await client.delete(`${root}f0.png`);
  await assert.rejects(client.delete('components/ecmwf/other/f0.png'));
  assert.deepEqual(deletes, [{ Bucket: COMPONENTS, Key: `${root}f0.png` }]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].accessKeyId, 'deletekeyid');
  await assert.rejects(io.deleteForPrefix('components/ecmwf/'));
  await assert.rejects((await createRetentionIo({ ...settings, PRODUCTION_COMPONENTS_GC_DELETE_ACCESS_KEY_ID: 'readkeyid' }, policy, sdk, readClient,
    () => ({ send() {} }))).deleteForPrefix(root), 'delete and read tokens differ');
});

test('workflow defaults to a dry run, needs its own protected environment, digest and approval, and has no publisher credential', () => {
  const workflow = readFileSync(new URL('../.github/workflows/production-components-retention.yml', import.meta.url), 'utf8');
  assert.match(workflow, /dry_run:\n\s+description:[^\n]+\n\s+type: boolean\n\s+required: true\n\s+default: true/);
  assert.match(workflow, /baseline_catalog_id:\n\s+description:[^\n]+\n\s+type: string\n\s+required: false\n\s+default: ''/);
  assert.match(workflow, /if: \$\{\{ github\.ref == 'refs\/heads\/main' && vars\.PRODUCTION_COMPONENTS_GC_CALL_ENABLED == 'true' \}\}/);
  assert.match(workflow, /name: data-production-components-cleanup/);
  assert.match(workflow, /group: weatherx-production-components-retention\n\s+cancel-in-progress: false/);
  for (const name of ['PRODUCTION_COMPONENTS_GC_ENABLED', 'PRODUCTION_COMPONENTS_GC_EXECUTE_ENABLED', 'PRODUCTION_COMPONENTS_GC_CONTROLLER_SHA256',
    'PRODUCTION_COMPONENTS_GC_APPROVED_PLAN_SHA256', 'PRODUCTION_COMPONENTS_R2_ACCOUNT_ID'])
    assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`));
  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(secrets)].sort(), ['PRODUCTION_COMPONENTS_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_COMPONENTS_GC_DELETE_SECRET_ACCESS_KEY',
    'PRODUCTION_COMPONENTS_GC_READ_ACCESS_KEY_ID', 'PRODUCTION_COMPONENTS_GC_READ_SECRET_ACCESS_KEY']);
  const dry = workflow.split('      - name: Produce dry-run deletion plan for review\n')[1].split('\n      - ')[0];
  assert.match(dry, /if: \$\{\{ inputs\.dry_run == true \}\}/);
  assert.doesNotMatch(dry, /DELETE/);
  const execute = workflow.split('      - name: Delete only an approved, still-unreferenced plan with per-root temporary credentials\n')[1];
  assert.match(execute, /if: \$\{\{ inputs\.dry_run == false \}\}/);
  assert.match(execute, /INPUT_BASELINE_CATALOG_ID: \$\{\{ inputs\.baseline_catalog_id \}\}/);
  assert.doesNotMatch(workflow, /ssh-key|ATMOS_DEPLOY_KEY|R2_PRODUCTION_|CATALOG_PROMOTION|: write|schedule:/);
  assert.match(controllerDigest(), /^[a-f0-9]{64}$/);
  const registry = JSON.parse(readFileSync(new URL('../ops/workflows.json', import.meta.url), 'utf8'));
  const entry = registry.workflows.find(row => row.id === 'production-components-retention');
  assert.equal(entry.path, '.github/workflows/production-components-retention.yml');
  assert.equal(entry.runbook, 'docs/production-components-retention.md');
});
