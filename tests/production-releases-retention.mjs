import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { controllerDigest, createRetentionIo, executeRetention, planRetention, planSummary, readPolicy,
  scopedDeleteCredentials, scopedRelease, summarizeManifest, validatePolicy } from '../tools/production-releases-retention.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-21T00:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const base = readPolicy();
const policy = { ...base, keepNewestReleases: 3, minimumAgeHours: 72, maximumDeletesPerRun: 30, deleteConcurrency: 3 };
const DATA = base.dataBucket, STAGING = base.stagingControlBucket;
const now = () => T0 + 30 * 60_000;

class GetObjectCommand { constructor(input) { this.input = input; } }
class ListObjectsV2Command { constructor(input) { this.input = input; } }
class DeleteObjectCommand { constructor(input) { this.input = input; } }
const sdk = { GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand };
const settings = { PRODUCTION_RELEASES_R2_ACCOUNT_ID: base.accountId,
  PRODUCTION_RELEASES_GC_READ_ACCESS_KEY_ID: 'readkeyid01', PRODUCTION_RELEASES_GC_READ_SECRET_ACCESS_KEY: 'r'.repeat(64),
  PRODUCTION_RELEASES_GC_DELETE_ACCESS_KEY_ID: 'deletekeyid', PRODUCTION_RELEASES_GC_DELETE_SECRET_ACCESS_KEY: 'd'.repeat(64) };

// In-memory R2 behind the real adapter. Listings are lexicographic and paginated at `pageSize`
// regardless of MaxKeys (R2 may return fewer keys than asked), so every listing walks tokens.
function world({ pageSize = 7 } = {}) {
  const buckets = { [DATA]: new Map(), [STAGING]: new Map() };
  const put = (bucket, key, body, modified = T0) => buckets[bucket].set(key, { body: Buffer.from(body), modified });
  const manifests = new Map(), calls = [], deletes = [];
  let onDelete = null;
  function release(runId, hoursAgo, { objects = 5, manifest = 'valid', createdHoursAgo = hoursAgo } = {}) {
    const releaseId = `cycle-${runId}`, prefix = `releases/${releaseId}/`, modified = T0 - hoursAgo * HOUR;
    const entries = [];
    for (let i = 0; i < objects; i++) {
      const path = `${i % 2 ? 'data-atmos' : 'data'}/ecmwf/runs/2026101${i}00/f${i}.png`;
      const body = `payload ${releaseId} ${i}`;
      put(DATA, `${prefix}${path}`, body, modified);
      entries.push({ path, bytes: Buffer.byteLength(body), sha256: sha(body) });
    }
    const value = { schemaVersion: 1, releaseId, createdAt: iso(T0 - createdHoursAgo * HOUR - 20 * 60_000), objectCount: objects, objects: entries };
    manifests.set(releaseId, value);
    if (manifest === 'valid') put(DATA, `${prefix}manifest.json`, `${JSON.stringify(value)}\n`, modified);
    if (manifest === 'invalid') put(DATA, `${prefix}manifest.json`, '{"schemaVersion":1,', modified);
    return releaseId;
  }
  function promote(releaseId, at = T0) {
    const m = manifests.get(releaseId);
    put(DATA, 'releases/current.json', `${JSON.stringify({ schemaVersion: 1, releaseId, publishedAt: iso(at),
      objectCount: m.objectCount, manifestSha256: sha(JSON.stringify(m)) })}\n`, at);
  }
  const pin = (releaseId, expiresAt = iso(T0 - 100 * HOUR)) =>
    put(STAGING, 'shared-read/pin.json', JSON.stringify({ schemaVersion: 1, releaseId, catalogId: null, expiresAt, reason: 'canary' }));
  function list(input) {
    const prefix = input.Prefix ?? '', entries = [], seen = new Set();
    for (const key of [...buckets[input.Bucket].keys()].filter(k => k.startsWith(prefix)).sort()) {
      const rest = key.slice(prefix.length);
      if (input.Delimiter && rest.includes(input.Delimiter)) {
        const common = prefix + rest.slice(0, rest.indexOf(input.Delimiter) + 1);
        if (!seen.has(common)) { seen.add(common); entries.push({ common }); }
      } else entries.push({ key });
    }
    const start = input.ContinuationToken ? Number(Buffer.from(input.ContinuationToken, 'base64url').toString()) : 0;
    const page = entries.slice(start, start + Math.min(pageSize, input.MaxKeys));
    const next = start + page.length, truncated = next < entries.length;
    return { Contents: page.filter(e => e.key).map(e => { const v = buckets[input.Bucket].get(e.key);
      return { Key: e.key, Size: v.body.length, LastModified: new Date(v.modified), ETag: `"${sha(v.body).slice(0, 32)}"` }; }),
    CommonPrefixes: page.filter(e => e.common).map(e => ({ Prefix: e.common })), IsTruncated: truncated,
    ...(truncated ? { NextContinuationToken: Buffer.from(String(next)).toString('base64url') } : {}) };
  }
  const readClient = { async send(command) {
    calls.push({ type: command.constructor.name, ...command.input });
    if (command instanceof GetObjectCommand) {
      const value = buckets[command.input.Bucket]?.get(command.input.Key);
      if (!value) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      return { ContentLength: value.body.length, Body: [value.body], Metadata: {} };
    }
    if (command instanceof ListObjectsV2Command) return list(command.input);
    throw new Error(`the read client cannot ${command.constructor.name}`);
  }, destroy() {} };
  const sessions = [];
  const deleteClientFactory = credentials => {
    const jwt = Buffer.from(credentials.sessionToken, 'base64').toString().slice(4);
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
    sessions.push(claims);
    return { async send(command) {
      assert.ok(command instanceof DeleteObjectCommand);
      assert.equal(command.input.Bucket, claims.bucket);
      assert.ok(command.input.Key.startsWith(claims.paths.prefixPaths[0]), 'R2 would deny a key outside the session prefix');
      deletes.push(command.input.Key);
      buckets[DATA].delete(command.input.Key);
      onDelete?.(deletes.length);
    }, destroy() {} };
  };
  return { buckets, put, release, promote, pin, manifests, calls, deletes, sessions, readClient, deleteClientFactory,
    setOnDelete: fn => { onDelete = fn; },
    io: () => createRetentionIo(settings, policy, sdk, readClient, deleteClientFactory) };
}

// Ten days at four releases a day, all promoted in turn; a few broken or out-of-scope prefixes.
function history() {
  const w = world();
  const ids = [];
  for (let k = 0, h = 240; h >= 0; h -= 6, k++) ids.push(w.release(39000000000 + k * 1000, h));
  w.promote(ids[ids.length - 1]);
  const missing = w.release(38000000001, 200, { manifest: 'missing' });
  const invalid = w.release(38000000002, 200, { manifest: 'invalid' });
  const surplus = w.release(38000000003, 200);
  w.put(DATA, `releases/${surplus}/data/stray.png`, 'stray', T0 - 200 * HOUR);
  w.put(DATA, 'releases/2026-09-01-abc123/data/x.png', 'legacy', T0 - 900 * HOUR);
  w.put(DATA, 'catalogs/current.json', '{}', T0 - 900 * HOUR);
  w.put(DATA, 'runtime/hazards/latest.json', '{}', T0 - 900 * HOUR);
  return { ...w, ids, missing, invalid, surplus };
}
const execute = (h, io, plan, extra = {}) => executeRetention({ io, policy, now, deleteForPrefix: io.deleteForPrefix,
  asOf: plan.asOf, baselineReleaseId: plan.baselineReleaseId, approvedPlanSha256: plan.planSha256, ...extra });

test('policy: reviewed defaults, floors that never shrink, and only releases/cycle-<digits>/ is in scope', () => {
  assert.equal(base.keepNewestReleases, 8);
  assert.equal(base.minimumAgeHours, 168, 'seven days, the Atmos runbook minimum for pointer/manifest history');
  assert.equal(base.maximumDeletesPerRun, 500000);
  assert.throws(() => validatePolicy({ ...base, minimumAgeHours: 48 }), /72 hours/);
  assert.throws(() => validatePolicy({ ...base, keepNewestReleases: 1 }), /two last-good/);
  assert.throws(() => validatePolicy({ ...base, dataBucket: 'weatherx-components-production' }));
  assert.throws(() => validatePolicy({ ...base, releasePointerKey: 'catalogs/current.json' }));
  assert.deepEqual(base.keepReleaseIds, []);
  for (const keep of [undefined, 'cycle-1', ['cycle-1', 'cycle-1'], ['../x'], Array.from({ length: 65 }, (_, i) => `cycle-${i + 1}`)])
    assert.throws(() => validatePolicy({ ...base, keepReleaseIds: keep }), /keepReleaseIds/, JSON.stringify(keep));
  assert.ok(scopedRelease('releases/cycle-39493311523/'));
  for (const prefix of ['releases/', 'releases/current.json', 'releases/cycle-39493311523', 'releases/cycle-0123/',
    'releases/cycle-abc/', 'releases/2026-09-01-abc123/', 'releases/cycle-1/data/', 'catalogs/cycle-1/', 'components/ecmwf/cycle-1/'])
    assert.equal(scopedRelease(prefix), false, prefix);
  assert.equal(summarizeManifest(Buffer.from('nope'), 'cycle-1').status, 'manifest-invalid');
  assert.equal(summarizeManifest(Buffer.from(JSON.stringify({ schemaVersion: 1, releaseId: 'cycle-2', createdAt: iso(T0), objectCount: 1,
    objects: [{ path: 'data/a', bytes: 1 }] })), 'cycle-1').status, 'manifest-invalid', 'a manifest naming another release');
});

test('dry run keeps current, newest, recent, pinned and incomplete releases and selects the oldest others within budget', async () => {
  const h = history();
  h.pin(h.ids[2]); // an expired staging pin on a nine-day-old release still keeps it
  const io = await h.io();
  const plan = await planRetention({ io, policy, now });
  const again = await planRetention({ io, policy, now });
  assert.equal(plan.planSha256, again.planSha256, 'the plan is deterministic');
  assert.equal(plan.baselineReleaseId, h.ids[h.ids.length - 1]);
  assert.equal(plan.asOf, iso(now()));
  assert.equal(plan.minimumAgeCutoff, iso(now() - 72 * HOUR));
  const kept = new Map(plan.report.kept.map(row => [row.releaseId, row.reasons]));
  assert.deepEqual(kept.get(h.ids[h.ids.length - 1]), ['current', 'live-current', 'newest', 'recent']);
  for (const id of h.ids.slice(-12)) assert.ok(kept.get(id).includes('recent'), `${id} is younger than 72 h`);
  assert.deepEqual(kept.get(h.ids[2]), ['staging-pin']);
  assert.deepEqual(kept.get(h.missing), ['incomplete']);
  assert.deepEqual(kept.get(h.invalid), ['incomplete']);
  assert.deepEqual(kept.get(h.surplus), ['inconsistent']);
  assert.deepEqual(plan.report.incomplete.map(row => [row.releaseId, row.status]).sort(),
    [[h.missing, 'manifest-missing'], [h.invalid, 'manifest-invalid'], [h.surplus, 'surplus']].sort());
  assert.deepEqual(plan.report.outOfScope.map(row => row.prefix), ['releases/2026-09-01-abc123/']);
  const selected = plan.candidates.map(row => row.releaseId);
  assert.deepEqual(selected, [h.ids[0], h.ids[1], h.ids[3], h.ids[4], h.ids[5]], 'oldest first, the pinned one skipped, 6 objects each, 30 max');
  for (const row of plan.candidates) {
    assert.equal(row.objectCount, 6);
    assert.equal(row.status, 'complete');
    assert.match(row.keysSha256, /^[a-f0-9]{64}$/);
    assert.equal(row.prefix, `releases/${row.releaseId}/`);
  }
  assert.equal(plan.eligible.releases, h.ids.length - 12 - 1, 'everything older than 72 h except the pin');
  assert.ok(plan.eligible.objects > plan.totals.objects, 'the budget bounds this run, the rest waits');
  assert.equal(plan.report.releasesPrefix.looseObjects, 1, 'releases/current.json is counted, never planned');
  assert.equal(Object.values(plan.report.held).reduce((n, v) => n + v.releases, 0) + plan.eligible.releases, plan.report.releasesPrefix.prefixes);
  assert.ok(plan.report.order.agree);
  assert.deepEqual(plan.report.protected.map(row => [row.releaseId, row.present, row.manifestCovered]).sort(),
    [h.ids[2], ...h.ids.slice(-3)].sort().map(id => [id, true, true]));
  assert.match(planSummary(plan), /planSha256 `[a-f0-9]{64}` · plan_as_of `2026-10-21T00:30:00.000Z` · baseline_release_id `cycle-\d+`[\s\S]*This run deletes: 5 releases, 30 objects/);
  assert.match(planSummary(plan), /Incomplete or inconsistent, kept and reported: .*manifest-missing/);
  // Nothing outside releases/ is listed or read, and the read client never deletes.
  for (const call of h.calls) {
    if (call.type === 'ListObjectsV2Command') assert.ok(call.Bucket === DATA && call.Prefix.startsWith('releases/'), JSON.stringify(call));
    else assert.ok(call.Key === 'releases/current.json' || /^releases\/[^/]+\/manifest\.json$/.test(call.Key) ||
      (call.Bucket === STAGING && call.Key === 'shared-read/pin.json'), JSON.stringify(call));
  }
  // Without the pin its release becomes eligible.
  h.buckets[STAGING].delete('shared-read/pin.json');
  const unpinned = await planRetention({ io, policy, now });
  assert.equal(unpinned.eligible.releases, plan.eligible.releases + 1);
  assert.ok(unpinned.candidates.some(row => row.releaseId === h.ids[2]));
});

test('when bakes stall the newest N complete releases stay, by createdAt and by run id', async () => {
  const w = world();
  const ids = [];
  for (let k = 0, hrs = 400; hrs >= 300; hrs -= 12, k++) ids.push(w.release(39100000000 + k * 1000, hrs));
  // A run id just below the current one whose manifest claims an old createdAt (a skewed clock):
  // both orders are kept.
  const skewed = w.release(39100007500, 380, { createdHoursAgo: 390 });
  w.promote(ids[ids.length - 1]);
  const io = await w.io();
  const plan = await planRetention({ io, policy, now });
  const kept = new Map(plan.report.kept.map(row => [row.releaseId, row.reasons]));
  assert.deepEqual(plan.report.order.newestByCreatedAt, ids.slice(-3).reverse());
  assert.deepEqual(plan.report.order.newestByRunId, [ids[8], skewed, ids[7]]);
  assert.equal(plan.report.order.agree, false);
  for (const id of [...ids.slice(-3), skewed]) assert.ok(kept.get(id)?.includes('newest'), id);
  assert.equal(kept.size, 4);
  assert.match(planSummary(plan), /run id DISAGREE; both kept/);
});

test('a manual rollback in effect stops planning and execution: people are in control', async () => {
  const h = history();
  const io = await h.io();
  const plan = await planRetention({ io, policy, now });
  // Rollback with activate-r2-release.sh onto a nine-day-old release.
  h.promote(h.ids[1], T0 + 5 * 60_000);
  await assert.rejects(planRetention({ io, policy, now }), /a manual rollback is in effect or a promotion is pending; refusing/);
  await assert.rejects(execute(h, io, plan), /a manual rollback is in effect/);
  // Rollback to the previous release: still not the newest by createdAt or run id.
  h.promote(h.ids[h.ids.length - 2], T0 + 6 * 60_000);
  await assert.rejects(planRetention({ io, policy, now }), new RegExp(`${h.ids[h.ids.length - 1]} is newer`));
  // A complete upload newer than current that is not promoted yet (only by run id here) also refuses.
  h.promote(h.ids[h.ids.length - 1], T0 + 7 * 60_000);
  h.release(39950000000, 300);
  await assert.rejects(planRetention({ io, policy, now }), /cycle-39950000000 is newer/);
  // A pointer naming a release outside releases/cycle-<digits>/ is refused too.
  const w = world();
  w.release(39000000000, 300);
  w.put(DATA, 'releases/production-bootstrap-1/manifest.json', JSON.stringify({ schemaVersion: 1, releaseId: 'production-bootstrap-1',
    createdAt: iso(T0), objectCount: 1, objects: [{ path: 'data/a', bytes: 1 }] }));
  w.put(DATA, 'releases/production-bootstrap-1/data/a', 'a');
  w.put(DATA, 'releases/current.json', JSON.stringify({ schemaVersion: 1, releaseId: 'production-bootstrap-1', publishedAt: iso(T0),
    objectCount: 1, manifestSha256: 'a'.repeat(64) }));
  await assert.rejects(planRetention({ io: await w.io(), policy, now }), /not a complete releases\/cycle-<digits>\/ release/);
  assert.equal(h.deletes.length, 0);
});

test('a promotion that lands while planning is picked up by one pointer re-read; a failed promotion clears with the next bake', async () => {
  const h = history();
  const io = await h.io();
  const fresh = h.release(39900000000, -0.1);
  let reads = 0;
  const get = io.get;
  io.get = async (bucket, key, maximum) => {
    const got = await get(bucket, key, maximum);
    if (key === 'releases/current.json' && ++reads === 1) h.promote(fresh, T0 + 10 * 60_000); // lands after the first read
    return got;
  };
  const plan = await planRetention({ io, policy, now });
  assert.equal(plan.baselineReleaseId, fresh);
  assert.ok(reads >= 3, 'first read, the re-read, and the restarted plan');
  // A complete upload that never got promoted blocks planning only until a newer release is promoted.
  io.get = get;
  const stuck = h.release(39950000000, -0.15);
  await assert.rejects(planRetention({ io, policy, now }), new RegExp(`${stuck} is newer`));
  const next = h.release(39960000000, -0.2);
  h.promote(next, T0 + 20 * 60_000);
  assert.equal((await planRetention({ io, policy, now })).baselineReleaseId, next);
});

test('a rollback target rolled forward again is protected only by keepReleaseIds, which the plan records', async () => {
  const h = history();
  h.promote(h.ids[1], T0 - 2 * HOUR); // rolled back two hours ago
  const fix = h.release(39950000000, -0.2);
  h.promote(fix, T0 - HOUR); // and forward again by a fix bake
  const io = await h.io();
  const unprotected = await planRetention({ io, policy, now });
  assert.ok(unprotected.candidates.some(row => row.releaseId === h.ids[1]), 'the pointer keeps no history: without keepReleaseIds it is eligible');
  const kept = { ...policy, keepReleaseIds: [h.ids[1]] };
  const plan = await planRetention({ io, policy: kept, now });
  assert.deepEqual(plan.keepReleaseIds, [h.ids[1]]);
  assert.notEqual(plan.planSha256, unprotected.planSha256);
  assert.deepEqual(plan.report.kept.find(row => row.releaseId === h.ids[1]).reasons, ['owner-keep']);
  assert.ok(!plan.candidates.some(row => row.releaseId === h.ids[1]));
  assert.ok(plan.report.protected.some(row => row.releaseId === h.ids[1] && row.present && row.manifestCovered));
  assert.match(planSummary(plan), new RegExp(`keepReleaseIds \\(${h.ids[1]}\\)`));
  // An execution under a policy without the keep refuses the plan approved with it.
  await assert.rejects(executeRetention({ io, policy, now, deleteForPrefix: io.deleteForPrefix, asOf: plan.asOf,
    baselineReleaseId: plan.baselineReleaseId, approvedPlanSha256: plan.planSha256 }), /differs from the approved plan/);
  const result = await executeRetention({ io, policy: kept, now, deleteForPrefix: io.deleteForPrefix, asOf: plan.asOf,
    baselineReleaseId: plan.baselineReleaseId, approvedPlanSha256: plan.planSha256 });
  assert.equal(result.releasesConfirmedEmpty, plan.candidates.length);
  assert.ok(h.buckets[DATA].has(`releases/${h.ids[1]}/manifest.json`));
});

test('a release with any object newer than the minimum age is kept, whatever its manifest says', async () => {
  const h = history();
  h.put(DATA, `releases/${h.ids[0]}/data/late-write.png`, 'late', T0 - 1 * HOUR);
  const plan = await planRetention({ io: await h.io(), policy, now });
  const row = plan.report.kept.find(r => r.releaseId === h.ids[0]);
  assert.deepEqual(row.reasons, ['inconsistent', 'recent']);
  assert.ok(!plan.candidates.some(r => r.releaseId === h.ids[0]));
});

test('planning fails closed on an unreadable pointer or pin, a pointer that disagrees with its manifest, or a missing current release', async () => {
  for (const [name, mutate, message] of [
    ['pointer garbage', h => h.put(DATA, 'releases/current.json', 'not json'), /not a valid release pointer/],
    ['pointer missing', h => h.buckets[DATA].delete('releases/current.json'), /NoSuchKey/],
    ['pin unreadable', h => h.put(STAGING, 'shared-read/pin.json', '{"schemaVersion":2}'), /pin is unreadable/],
    ['pointer digest', h => { const p = JSON.parse(h.buckets[DATA].get('releases/current.json').body); p.manifestSha256 = '0'.repeat(64);
      h.put(DATA, 'releases/current.json', JSON.stringify(p)); }, /disagree/],
    ['current absent', h => { const p = JSON.parse(h.buckets[DATA].get('releases/current.json').body); p.releaseId = 'cycle-1';
      h.put(DATA, 'releases/current.json', JSON.stringify(p)); }, /lists no objects/],
  ]) {
    const h = history();
    mutate(h);
    await assert.rejects(planRetention({ io: await h.io(), policy, now }), message, name);
  }
});

test('execution recomputes the approved plan while bakes keep promoting and deletes exactly it, manifest last, proving the kept set whole', async () => {
  const h = history();
  const io = await h.io();
  const plan = await planRetention({ io, policy, now });
  // A bake uploads and promotes a new release between the dry run and the approved execution.
  const fresh = h.release(39900000000, -0.2);
  h.promote(fresh, T0 + 20 * 60_000);
  const before = new Map([...h.buckets[DATA]].filter(([key]) => !plan.candidates.some(row => key.startsWith(row.prefix))));
  const pointerBefore = h.buckets[DATA].get('releases/current.json').body;
  await assert.rejects(execute(h, io, plan, { approvedPlanSha256: sha('other') }), /differs from the approved plan/);
  await assert.rejects(execute(h, io, plan, { asOf: iso(now() - 25 * HOUR) }), /older than maximumPlanAgeHours/);
  await assert.rejects(execute(h, io, plan, { baselineReleaseId: '' }), /baseline_release_id/);
  await assert.rejects(execute(h, io, plan, { asOf: '' }), /plan_as_of/);
  assert.equal(h.deletes.length, 0);
  const result = await execute(h, io, plan);
  assert.equal(result.deleteRequestsByThisRun, plan.totals.objects);
  assert.equal(result.releasesConfirmedEmpty, plan.candidates.length);
  assert.equal(result.plannedObjects, 30);
  assert.ok(!('deleted' in result), 'no "objects deleted" claim a concurrent run could double');
  assert.equal(h.deletes.length, 30);
  for (const candidate of plan.candidates) {
    const ours = h.deletes.filter(key => key.startsWith(candidate.prefix));
    assert.equal(ours.length, candidate.objectCount);
    assert.equal(ours[ours.length - 1], `${candidate.prefix}manifest.json`);
    assert.equal([...h.buckets[DATA].keys()].filter(key => key.startsWith(candidate.prefix)).length, 0);
  }
  for (const [key, value] of before) assert.deepEqual(h.buckets[DATA].get(key), value, `${key} untouched`);
  assert.ok(h.buckets[DATA].get('releases/current.json').body.equals(pointerBefore), 'the pointer bytes are unchanged');
  assert.equal(result.proof.pointerChangedByAPromotion, false);
  assert.equal(result.proof.protected.length, 3, "baseline, the fresh live release and the newest by both orders");
  assert.ok(result.proof.protected.every(row => row.unchanged && row.present && row.manifestCovered));
  assert.ok(result.proof.protected.some(row => row.releaseId === fresh), 'the release promoted after the dry run is protected too');
  assert.equal(h.sessions.length, plan.candidates.length, 'one scoped credential per release');
  for (const claims of h.sessions) {
    assert.equal(claims.bucket, DATA); assert.deepEqual(claims.actions, ['DeleteObject']);
    assert.ok(scopedRelease(claims.paths.prefixPaths[0]));
  }
  // Replay plans only what remains.
  const next = await planRetention({ io, policy, now });
  assert.notEqual(next.planSha256, plan.planSha256);
  assert.ok(next.candidates.every(row => !plan.candidates.some(done => done.releaseId === row.releaseId)));
});

test('the guard re-reads the pointer and pin before every delete: a candidate pointer or any pin change stops, a new release does not', async () => {
  for (const [name, change, message] of [
    ['pointer rolled back to a candidate', (h, plan) => h.promote(plan.candidates[2].releaseId, T0 + 60_000), /now names candidate/],
    ['pin set on a candidate', (h, plan) => h.pin(plan.candidates[3].releaseId), /pin changed/],
    ['pin cleared', h => h.buckets[STAGING].delete('shared-read/pin.json'), /pin changed/],
    ['pointer garbage', h => h.put(DATA, 'releases/current.json', '{"schemaVersion":1}'), /not a valid release pointer/],
  ]) {
    const h = history();
    if (name === 'pin cleared') h.pin(h.ids[2]);
    const io = await h.io();
    const plan = await planRetention({ io, policy, now });
    let reads = 0;
    const get = io.get;
    io.get = async (bucket, key, maximum) => { if (key === 'releases/current.json') reads += 1; return get(bucket, key, maximum); };
    let changed = false;
    h.setOnDelete(count => { if (!changed && count === 2) { changed = true; change(h, plan); } });
    await assert.rejects(execute(h, io, plan), message, name);
    assert.ok(h.deletes.length < plan.totals.objects, `${name}: stopped early`);
    assert.ok(h.deletes.length <= 2 + policy.deleteConcurrency, `${name}: at most the in-flight deletes after the change`);
    assert.ok(reads >= h.deletes.length, `${name}: one pointer read per delete`);
  }
  // A bake promoting a release that is not a candidate does not stop the run.
  const h = history();
  const io = await h.io();
  const plan = await planRetention({ io, policy, now });
  h.setOnDelete(count => { if (count === 3) h.promote(h.release(39900000000, -0.1), T0 + 40 * 60_000); });
  const result = await execute(h, io, plan);
  assert.equal(result.deleteRequestsByThisRun, plan.totals.objects);
  assert.equal(result.proof.pointerChangedByAPromotion, true);
});

test('two executions of one plan delete only planned keys, and each reports only its own requests', async () => {
  const h = history();
  const io = await h.io();
  const plan = await planRetention({ io, policy, now });
  const untouched = new Map([...h.buckets[DATA]].filter(([key]) => !plan.candidates.some(row => key.startsWith(row.prefix))));
  const results = await Promise.allSettled([execute(h, io, plan), execute(h, io, plan)]);
  for (const key of h.deletes) assert.ok(plan.candidates.some(row => key.startsWith(row.prefix)));
  for (const [key, value] of untouched) assert.deepEqual(h.buckets[DATA].get(key), value);
  const sent = results.filter(r => r.status === 'fulfilled').reduce((n, r) => n + r.value.deleteRequestsByThisRun, 0) +
    results.filter(r => r.status === 'rejected').reduce((n, r) => n + (r.reason.deleted ?? 0), 0);
  assert.equal(sent, h.deletes.length, 'the two reports add up to the requests actually sent');
});

test('a release written back into after its deletion (a re-run of its old bake) stops the run', async () => {
  const h = history();
  const io = await h.io();
  const plan = await planRetention({ io, policy, now });
  h.setOnDelete(count => { if (count === 6) h.put(DATA, `${plan.candidates[0].prefix}data/rerun.png`, 'rerun', T0); });
  await assert.rejects(execute(h, io, plan), /still lists 1 objects after its deletion: something wrote into it/);
  assert.equal(h.deletes.length, 6);
});

test('a candidate that grew is refused: before execution by the digest, during execution by the re-list', async () => {
  const h = history();
  const io = await h.io();
  const plan = await planRetention({ io, policy, now });
  h.put(DATA, `${plan.candidates[0].prefix}data/late.png`, 'late', T0 - 100 * HOUR);
  await assert.rejects(execute(h, io, plan), /differs from the approved plan/);
  assert.equal(h.deletes.length, 0);
  h.buckets[DATA].delete(`${plan.candidates[0].prefix}data/late.png`);
  h.setOnDelete(count => { if (count === 1) h.put(DATA, `${plan.candidates[1].prefix}data/late.png`, 'late', T0 - 100 * HOUR); });
  await assert.rejects(execute(h, io, plan), /grew from 6 to 7 objects since the dry run/);
  assert.equal(h.deletes.length, 6, 'only the first release, already re-listed, was deleted');
  assert.ok(h.buckets[DATA].has(`${plan.candidates[1].prefix}manifest.json`));
});

test('an interrupted run leaves a partial release that the next plan finishes', async () => {
  const h = history();
  const io = await h.io();
  const plan = await planRetention({ io, policy, now });
  h.setOnDelete(count => { if (count === 3) h.pin(h.ids[30]); });
  await assert.rejects(execute(h, io, plan), /pin changed/);
  h.setOnDelete(null);
  const first = plan.candidates[0];
  assert.ok(h.buckets[DATA].has(`${first.prefix}manifest.json`), 'the manifest goes last');
  const next = await planRetention({ io, policy, now });
  assert.equal(next.candidates[0].releaseId, first.releaseId);
  assert.equal(next.candidates[0].status, 'partial');
  assert.deepEqual(next.report.partial, [first.releaseId]);
  await execute(h, io, next);
  assert.equal([...h.buckets[DATA].keys()].filter(key => key.startsWith(first.prefix)).length, 0);
});

test('listing follows every continuation token: 76 release folders on 7-key pages are all found', async () => {
  const w = world({ pageSize: 7 });
  const ids = [];
  for (let k = 0; k < 76; k++) ids.push(w.release(37000000000 + k * 7919, 400 - k * 4, { objects: 9 }));
  w.promote(ids[ids.length - 1]);
  const io = await w.io();
  const plan = await planRetention({ io, policy: { ...policy, maximumDeletesPerRun: 100_000 }, now });
  assert.equal(plan.report.releasesPrefix.prefixes, 76);
  assert.equal(plan.report.releasesPrefix.objects, 76 * 10 + 1);
  assert.ok(w.calls.filter(call => call.type === 'ListObjectsV2Command' && call.Delimiter === '/').length >= 11, 'the folder listing paged');
  assert.ok(plan.candidates.every(row => row.objectCount === 10), 'each release listed whole across pages');
  // A listing whose truncation flag and token disagree is refused.
  const broken = { ...w.readClient, async send(command) {
    const page = await w.readClient.send(command);
    return command instanceof ListObjectsV2Command ? { ...page, NextContinuationToken: undefined } : page;
  } };
  const bad = await createRetentionIo(settings, policy, sdk, broken, w.deleteClientFactory);
  await assert.rejects(planRetention({ io: bad, policy, now }), /truncation and continuation token disagree/);
});

test('delete credentials are DeleteObject-only, 15 minutes, one releases/cycle-<digits>/ prefix of the production data bucket', () => {
  const prefix = 'releases/cycle-39493311523/';
  const credential = scopedDeleteCredentials({ accessKeyId: 'abcdefghij', secretAccessKey: 's'.repeat(64) }, prefix, base, 1_800_000_000);
  const jwt = Buffer.from(credential.sessionToken, 'base64').toString().slice(4);
  const parts = jwt.split('.');
  assert.equal(parts[2], createHmac('sha256', 's'.repeat(64)).update(`${parts[0]}.${parts[1]}`).digest('base64url'));
  assert.equal(credential.secretAccessKey, sha(jwt));
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  assert.equal(claims.bucket, 'weatherx-data-production');
  assert.deepEqual(claims.actions, ['DeleteObject']);
  assert.deepEqual(claims.paths.prefixPaths, [prefix]);
  assert.equal(claims.exp - claims.iat, 900);
  for (const bad of ['releases/', 'releases/current.json', 'releases/2026-09-01-abc123/', 'catalogs/', ''])
    assert.throws(() => scopedDeleteCredentials({ accessKeyId: 'abcdefghij', secretAccessKey: 's'.repeat(64) }, bad, base), bad || 'empty');
});

test('adapter refuses other credentials, reads only the pointer, manifests and pin, lists only releases/, deletes only through scoped sessions', async () => {
  const w = history();
  for (const broad of ['R2_PRODUCTION_ACCESS_KEY_ID', 'CATALOG_PROMOTION_KEY_PRODUCTION', 'CATALOG_PROMOTION_KEY', 'CLOUDFLARE_API_TOKEN',
    'RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID', 'RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY', 'RCLONE_CONFIG_OTHER_ENDPOINT', 'AWS_ACCESS_KEY_ID', 'CATALOG_ENDPOINT',
    'PRODUCTION_COMPONENTS_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_ACCESS_KEY_ID'])
    await assert.rejects(createRetentionIo({ ...settings, [broad]: 'x' }, policy, sdk, w.readClient), new RegExp(broad));
  await assert.rejects(createRetentionIo({ ...settings, PRODUCTION_RELEASES_R2_ACCOUNT_ID: 'f'.repeat(32) }, policy, sdk, w.readClient));
  await assert.rejects(createRetentionIo({ ...settings, PRODUCTION_RELEASES_GC_READ_ACCESS_KEY_ID: '' }, policy, sdk, w.readClient));
  const io = await w.io();
  const prior = w.calls.length;
  for (const [bucket, key] of [[DATA, 'catalogs/current.json'], [DATA, `releases/${w.ids[0]}/data/ecmwf/runs/2026101000/f0.png`],
    [DATA, 'production-candidates/wind100/current-v1.json'], [STAGING, 'releases/current.json'], ['weatherx-components-production', 'catalogs/current.json']])
    await assert.rejects(io.get(bucket, key, 1024), /may not read/);
  for (const prefix of ['', 'catalogs/', 'components/'])
    await assert.rejects(io.listPrefixes(prefix), /may not list/);
  for (const prefix of ['catalogs/', 'releases/', 'runtime/hazards/'])
    await assert.rejects(io.listRows(prefix, 10), /may not list/);
  assert.equal(w.calls.length, prior, 'refused reads never reach S3');
  for (const prefix of ['releases/', 'releases/2026-09-01-abc123/', 'catalogs/cycle-1/', 'releases/current.json'])
    await assert.rejects(io.deleteForPrefix(prefix), /may not delete/);
  const client = await io.deleteForPrefix(`releases/${w.ids[0]}/`);
  await assert.rejects(client.delete('releases/current.json'));
  await assert.rejects(client.delete(`releases/${w.ids[1]}/manifest.json`));
  await client.delete(`releases/${w.ids[0]}/manifest.json`);
  assert.deepEqual(w.deletes, [`releases/${w.ids[0]}/manifest.json`]);
  assert.ok(w.calls.every(call => call.type !== 'DeleteObjectCommand'), 'the read client never deletes');
  const same = await createRetentionIo({ ...settings, PRODUCTION_RELEASES_GC_DELETE_ACCESS_KEY_ID: settings.PRODUCTION_RELEASES_GC_READ_ACCESS_KEY_ID },
    policy, sdk, w.readClient, w.deleteClientFactory);
  await assert.rejects(same.deleteForPrefix(`releases/${w.ids[0]}/`), /must differ/);
});

test('an oversized manifest marks its release incomplete and kept', async () => {
  const w = world();
  const ids = [];
  for (let k = 0, hrs = 200; hrs >= 0; hrs -= 24, k++) ids.push(w.release(39300000000 + k * 1000, hrs));
  w.promote(ids[ids.length - 1]);
  w.put(DATA, `releases/${ids[0]}/manifest.json`, `${JSON.stringify(w.manifests.get(ids[0]))}${' '.repeat(5000)}`, T0 - 200 * HOUR);
  const small = { ...policy, maximumManifestBytes: 4096 };
  const plan = await planRetention({ io: await createRetentionIo(settings, small, sdk, w.readClient, w.deleteClientFactory), policy: small, now });
  assert.deepEqual(plan.report.incomplete.map(row => [row.releaseId, row.status, row.reason]), [[ids[0], 'manifest-invalid', 'oversized']]);
  assert.ok(!plan.candidates.some(row => row.releaseId === ids[0]));
});

test('CLI admission: cloud-only, its own workflow, environment and digest, and the dry run never holds the delete token', () => {
  const script = fileURLToPath(new URL('../tools/production-releases-retention.mjs', import.meta.url));
  const admitted = { PATH: process.env.PATH, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/production-releases-retention.yml@refs/heads/main',
    GITHUB_JOB: 'retention', RELEASES_GC_ENVIRONMENT: 'production-releases-retention', PRODUCTION_RELEASES_GC_ENABLED: 'true',
    PRODUCTION_RELEASES_GC_CONTROLLER_SHA256: controllerDigest() };
  const run = (command, env) => spawnSync(process.execPath, [script, command], { env, encoding: 'utf8' });
  for (const [env, command] of [[{ ...admitted, GITHUB_ACTIONS: '' }, 'dry-run'],
    [{ ...admitted, GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/production-components-retention.yml@refs/heads/main' }, 'dry-run'],
    [{ ...admitted, PRODUCTION_RELEASES_GC_CONTROLLER_SHA256: '0'.repeat(64) }, 'dry-run'],
    [{ ...admitted, PRODUCTION_RELEASES_GC_ENABLED: 'false' }, 'dry-run'],
    [{ ...admitted, PRODUCTION_RELEASES_GC_DELETE_ACCESS_KEY_ID: 'deletekeyid' }, 'dry-run'],
    [admitted, 'execute'], [admitted, 'delete-everything']]) {
    const result = run(command, env);
    assert.equal(result.status, 1, `${command} ${JSON.stringify(env).slice(0, 80)}`);
    assert.match(result.stderr, /^Production release retention refused:/);
  }
  assert.match(run('dry-run', { ...admitted, PRODUCTION_RELEASES_GC_DELETE_ACCESS_KEY_ID: 'x' }).stderr, /never holds the delete token/);
  assert.match(run('execute', admitted).stderr, /Expected values to be strictly equal|EXECUTE/i);
});

test('workflow: dispatch-only, dry run by default, its own environment, digest and approval, no lock and no publisher credential', () => {
  const workflow = readFileSync(new URL('../.github/workflows/production-releases-retention.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /^\s*(?:schedule|push|pull_request|pull_request_target|workflow_call|workflow_run|repository_dispatch):/m);
  assert.match(workflow, /dry_run:\n\s+description:[^\n]+\n\s+type: boolean\n\s+required: true\n\s+default: true/);
  for (const input of ['plan_as_of', 'baseline_release_id'])
    assert.match(workflow, new RegExp(`${input}:\\n\\s+description:[^\\n]+\\n\\s+type: string\\n\\s+required: false\\n\\s+default: ''`));
  assert.match(workflow, /if: \$\{\{ github\.ref == 'refs\/heads\/main' && vars\.PRODUCTION_RELEASES_GC_CALL_ENABLED == 'true' \}\}/);
  assert.match(workflow, /environment:\n\s+name: production-releases-retention/);
  assert.doesNotMatch(workflow, /^\s*concurrency:/m, 'no lock held across the environment gate');
  assert.match(workflow, /^permissions:\n {2}contents: read\n {2}actions: read\n(?! )/m);
  const active = workflow.split('      - name: Refuse while a re-run of an old bake or a release bootstrap is queued or running\n')[1].split('\n      - ')[0];
  assert.match(active, /if: \$\{\{ inputs\.dry_run == false \}\}/);
  assert.match(active, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(active, /for workflow in bake\.yml catalog-production-bootstrap\.yml/);
  assert.match(active, /minimumAgeHours/);
  assert.ok(workflow.indexOf('Refuse while a re-run') < workflow.indexOf('Delete only an approved'), 'the active-run check precedes deletion');
  for (const name of ['PRODUCTION_RELEASES_GC_ENABLED', 'PRODUCTION_RELEASES_GC_EXECUTE_ENABLED', 'PRODUCTION_RELEASES_GC_CONTROLLER_SHA256',
    'PRODUCTION_RELEASES_GC_APPROVED_PLAN_SHA256', 'PRODUCTION_RELEASES_R2_ACCOUNT_ID'])
    assert.match(workflow, new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`));
  const secrets = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(secrets)].sort(), ['PRODUCTION_RELEASES_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_RELEASES_GC_DELETE_SECRET_ACCESS_KEY',
    'PRODUCTION_RELEASES_GC_READ_ACCESS_KEY_ID', 'PRODUCTION_RELEASES_GC_READ_SECRET_ACCESS_KEY']);
  const dry = workflow.split('      - name: Produce dry-run release deletion plan for review\n')[1].split('\n      - ')[0];
  assert.match(dry, /if: \$\{\{ inputs\.dry_run == true \}\}/);
  assert.doesNotMatch(dry, /DELETE/);
  const execute = workflow.split('      - name: Delete only an approved, still-unreferenced release plan with per-release temporary credentials\n')[1];
  assert.match(execute, /if: \$\{\{ inputs\.dry_run == false \}\}/);
  assert.match(execute, /INPUT_PLAN_AS_OF: \$\{\{ inputs\.plan_as_of \}\}/);
  assert.match(execute, /INPUT_BASELINE_RELEASE_ID: \$\{\{ inputs\.baseline_release_id \}\}/);
  assert.doesNotMatch(workflow, /ssh-key|ATMOS_DEPLOY_KEY|R2_PRODUCTION_|CATALOG_PROMOTION|COMPONENTS_GC|WIND100|: write/);
  assert.match(controllerDigest(), /^[a-f0-9]{64}$/);
  const registry = JSON.parse(readFileSync(new URL('../ops/workflows.json', import.meta.url), 'utf8'));
  const entry = registry.workflows.find(row => row.id === 'production-releases-retention');
  assert.equal(entry.path, '.github/workflows/production-releases-retention.yml');
  assert.equal(entry.runbook, 'docs/production-releases-retention.md');
  const doc = readFileSync(new URL('../docs/production-releases-retention.md', import.meta.url), 'utf8');
  for (const name of ['production-releases-retention', ...secrets, 'PRODUCTION_RELEASES_GC_CALL_ENABLED', 'PRODUCTION_RELEASES_GC_ENABLED',
    'PRODUCTION_RELEASES_GC_EXECUTE_ENABLED', 'PRODUCTION_RELEASES_GC_CONTROLLER_SHA256', 'PRODUCTION_RELEASES_GC_APPROVED_PLAN_SHA256',
    'PRODUCTION_RELEASES_R2_ACCOUNT_ID'])
    assert.ok(doc.includes(name), `the runbook names ${name}`);
});
