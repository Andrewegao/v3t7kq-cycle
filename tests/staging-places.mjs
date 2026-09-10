import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { ACCOUNT, BUCKET, LIMITS, hash, prefix, pointerKey, allowedKey, payloadPath, qualifyPlaces, preparePlaces,
  activatePlaces, inspectPlaces, validateManifest, validateCompletion, validatePointer, createPlacesS3, payloadPool } from '../tools/staging-places.mjs';
import { placeFailureDiagnostic, placeProgress } from '../tools/staging-places-diagnostics.mjs';

const pin = 'a'.repeat(40);
const encoded = value => Buffer.from(JSON.stringify(value) + '\n');
async function fixture(t, kind = 'surf') {
  const root = await mkdtemp(join(tmpdir(), 'wx-staging-places-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const write = async (path, value) => { await mkdir(join(root, path, '..'), { recursive: true }); const body = encoded(value); await writeFile(join(root, path), body); return body; };
  const now = Date.now();
  if (kind === 'surf') {
    const source = { initializedAt: new Date(now - 3600000).toISOString(), freshUntil: new Date(now + 6 * 3600000).toISOString(), runId: '2026091012' };
    const times = Array.from({ length: 73 }, (_, i) => now - 3600000 + i * 3600000), spots = [];
    for (const spotId of ['us-ca-mavericks', 'us-ca-ocean-beach']) {
      const samples = times.map(time => ({ time, waveHeight: 1, period: 12, waveDirection: 270, windSpeed: 3, windDirection: 300 }));
      const body = await write(`spots/${spotId}.json`, { schemaVersion: 1, catalogVersion: 'pilot', releaseId: 'surf-test', spotId, source, windSource: source, samples });
      spots.push({ spotId, path: `surf/spots/${spotId}.json`, bytes: body.length, sha256: hash(body), waveHeight: times.map(() => 1) });
    }
    await write('index.json', { schemaVersion: 1, catalogVersion: 'pilot', releaseId: 'surf-test', source, cadenceSeconds: 3600, times, spots });
  } else if (kind === 'paragliding') {
    const revision = 'a'.repeat(20), sites = [{ id: '1', revision }, { id: '2', revision }];
    const cell = await write(`versions/${revision}/cells/1_2.json`, { revision, sites });
    for (const site of sites) await write(`versions/${revision}/sites/${site.id}.json`, site);
    await write('index.json', { schema: 1, revision, count: sites.length, cells: [{ key: '1_2', count: 2, sha256: hash(cell) }] });
  } else {
    const datasetId = 'noaa-coops-test', source = { provider: 'NOAA CO-OPS' }, datum = { id: 'MLLW' };
    const availability = { schemaVersion: 1, kind: 'weatherx-tide-availability', scope: 'staging-only', datasetId, source, datum,
      requestedStationIds: ['1', '2'], availableStationIds: ['1'], unavailableStations: [{ id: '2', reason: 'source-no-data' }] };
    // Filename is producer canonical JSON, deliberately distinct from wire-byte SHA.
    const availabilityPath = `versions/${datasetId}/availability-${'b'.repeat(64)}.json`;
    await write(`v2/${availabilityPath}`, availability);
    const station = { id: '1', sampleCoverage: { startMs: now - 3600000, endMs: now + 9 * 86400000 }, packs: [{ path: `versions/${datasetId}/stations/1/window.json` }] };
    await write(`v2/${station.packs[0].path}`, { schemaVersion: 2, datasetId, stationId: '1', source, datum });
    await write('v2/catalog.json', { schemaVersion: 2, datasetId, source, datum, stations: [station], availability: { path: availabilityPath, requestedCount: 2, availableCount: 1, unavailableCount: 1 } });
    await write('tides.json', { stations: [{ id: '1' }] });
  }
  return { root, now, write, candidate: await qualifyPlaces({ kind, root, now }) };
}
function approval(candidate) { return { approvedSourceSha: pin, qualification: { schemaVersion: 1, kind: candidate.completion.kind, identity: candidate.completion.identity,
  sourceSha: pin, manifestSha256: hash(candidate.manifestBody), checks: { producer: true, consumer: true, coverage: true, roster: true } } }; }
function memory() {
  const objects = new Map(), writes = [];
  return { objects, writes, async get(key, max, collect = true) { allowedKey(key); const value = objects.get(key); if (!value) return null;
    assert(value.body.length <= max); return { ...value, bytes: value.body.length, sha256: hash(value.body), ...(collect ? {} : { body: undefined }) }; },
  async put(key, input, condition) { allowedKey(key); const before = objects.get(key); assert(condition.ifNoneMatch ? !before : before?.etag === condition.ifMatch, 'CAS conflict');
    const body = Buffer.isBuffer(input) ? input : await readFile(input.file); assert.equal(body.length, condition.bytes); assert.equal(hash(body), condition.sha256);
    writes.push(key); objects.set(key, { body, etag: `"${writes.length}"`, customMetadata: { sha256: condition.sha256 }, httpMetadata: {} }); } };
}

test('root allowlists reject foreign bucket paths, identities, traversal and cross-family files', () => {
  for (const key of ['releases/current.json', 'catalogs/current.json', 'shared-read/pin.json', 'shared-read/places-wind.json', 'staging-places/surf/snapshots/not-surf/index.json',
    'staging-places/surf/snapshots/surf-test/../index.json', 'staging-places/paragliding/snapshots/aaaa/cells/1_2.json']) assert.throws(() => allowedKey(key));
  assert.throws(() => payloadPath('tides', 'stations/1/other.json'));
  assert.throws(() => payloadPath('surf', 'sites/1.json'));
  assert.equal(allowedKey('staging-places/surf/snapshots/surf-test/completion.json'), 'staging-places/surf/snapshots/surf-test/completion.json');
});
for (const kind of ['surf', 'paragliding', 'tides']) test(`${kind}: exact identity and inventory prepare completion last without activation`, async t => {
  const { candidate } = await fixture(t, kind), io = memory(), before = candidate.manifest.files.map(file => file.sha256);
  const result = await preparePlaces(io, candidate, approval(candidate));
  assert.equal(result.activated, false); assert.equal(io.writes.length, candidate.manifest.files.length + 2);
  assert(io.writes.at(-2).endsWith('/manifest.json')); assert(io.writes.at(-1).endsWith('/completion.json'));
  assert(!io.objects.has(pointerKey(kind))); assert.deepEqual(candidate.manifest.files.map(file => file.sha256), before);
  await preparePlaces(io, candidate, approval(candidate)); assert.equal(io.writes.length, candidate.manifest.files.length + 2, 'idempotent immutable retry');
  if (kind === 'tides') {
    const availability = candidate.manifest.files.find(file => file.path.startsWith('availability-'));
    assert(availability); assert.equal(JSON.parse(io.objects.get(prefix(kind, candidate.completion.identity) + availability.path).body).unavailableStations[0].id, '2');
  }
});
test('no first write without pinned exact producer, consumer, roster and coverage proof', async t => {
  const { candidate } = await fixture(t); const io = memory();
  await assert.rejects(preparePlaces(io, candidate));
  for (const key of ['producer', 'consumer', 'coverage', 'roster']) { const proof = approval(candidate); proof.qualification.checks[key] = false; await assert.rejects(preparePlaces(io, candidate, proof)); }
  const wrong = approval(candidate); wrong.qualification.manifestSha256 = 'b'.repeat(64); await assert.rejects(preparePlaces(io, candidate, wrong));
  assert.equal(io.writes.length, 0);
});
test('missing, extra, corrupted, linked and mixed-identity local data fail closed', async t => {
  for (const mutation of [async f => f.write('extra.json', {}), async f => writeFile(join(f.root, 'spots/us-ca-mavericks.json'), '{}'),
    async f => rm(join(f.root, 'spots/us-ca-mavericks.json')), async f => { await rm(join(f.root, 'spots/us-ca-mavericks.json')); await symlink('us-ca-ocean-beach.json', join(f.root, 'spots/us-ca-mavericks.json')); }]) {
    const f = await fixture(t); await mutation(f); await assert.rejects(qualifyPlaces({ kind: 'surf', root: f.root }));
  }
});
test('corruption after qualification and partial remote upload never create completion', async t => {
  const f = await fixture(t), io = memory(); await writeFile(join(f.root, 'spots/us-ca-mavericks.json'), '{}');
  await assert.rejects(preparePlaces(io, f.candidate, approval(f.candidate))); assert.equal(io.writes.length, 0);
  const fresh = await fixture(t), broken = memory(), put = broken.put; let attempts = 0;
  broken.put = async (...args) => { if (++attempts === 2) throw Error('uncertain write'); return put(...args); };
  await assert.rejects(preparePlaces(broken, fresh.candidate, approval(fresh.candidate)));
  assert(!broken.writes.some(key => key.endsWith('/completion.json') || key.startsWith('shared-read/')));
});
test('completion requires matching remote SHA metadata, not merely same-size body', async t => {
  const { candidate } = await fixture(t), io = memory(); await preparePlaces(io, candidate, approval(candidate));
  const key = prefix('surf', 'surf-test') + candidate.manifest.files[0].path; io.objects.get(key).customMetadata.sha256 = '0'.repeat(64);
  await assert.rejects(preparePlaces(io, candidate, approval(candidate)), /metadata/);
});
test('activation rereads all immutable data, requires exact completion approval and CAS, preserves other families', async t => {
  const { candidate, now } = await fixture(t), io = memory(); const prepared = await preparePlaces(io, candidate, approval(candidate));
  const params = { kind: 'surf', identity: 'surf-test', expectedPointerSha256: 'absent', approvedCompletionSha256: prepared.completion.sha256, now, clock: () => now, expiresAt: new Date(now + 3600000).toISOString() };
  await assert.rejects(activatePlaces(io, { ...params, approvedCompletionSha256: 'f'.repeat(64) }));
  const result = await activatePlaces(io, params); assert.equal(result.activated, true);
  const pointer = JSON.parse(io.objects.get(pointerKey('surf')).body); validatePointer(pointer, now);
  assert.equal(pointer.completion.sha256, prepared.completion.sha256);
  await assert.rejects(activatePlaces(io, params), /pointer changed/);
  assert(!io.objects.has(pointerKey('paragliding')) && !io.objects.has(pointerKey('tides')));
  assert.equal((await inspectPlaces(io, 'surf')).pointerSha256, result.pointerSha256);
  io.objects.get(prefix('surf', 'surf-test') + candidate.manifest.files[0].path).body = Buffer.from('changed');
  await assert.rejects(activatePlaces(io, { ...params, expectedPointerSha256: result.pointerSha256 }));
});
test('lost pointer PUT response reconciles exact stored bytes without a second PUT', async t => {
  for (const existing of [false, true]) {
    const { candidate, now } = await fixture(t), io = memory(); const prepared = await preparePlaces(io, candidate, approval(candidate));
    const params = { kind: 'surf', identity: 'surf-test', expectedPointerSha256: 'absent', approvedCompletionSha256: prepared.completion.sha256, clock: () => now, expiresAt: new Date(now + 3600000).toISOString() };
    if (existing) { const before = await activatePlaces(io, params); params.expectedPointerSha256 = before.pointerSha256; params.expiresAt = new Date(now + 2 * 3600000).toISOString(); }
    const put = io.put, get = io.get; let puts = 0, reconciliations = 0;
    io.put = async (...args) => { assert.equal(args[0], pointerKey('surf')); puts++; await put(...args); throw Error('private lost response details'); };
    io.get = async (...args) => { if (args[0] === pointerKey('surf') && puts) { reconciliations++; assert.equal(args[1], LIMITS.completionBytes); assert.equal(args[2], true); } return get(...args); };
    const result = await activatePlaces(io, params);
    assert.equal(result.activated, true); assert.equal(result.reconciled, true); assert.equal(puts, 1); assert.equal(reconciliations, 1);
    assert.equal(result.pointerSha256, hash(io.objects.get(pointerKey('surf')).body));
  }
});
test('lost pointer response with absent, different, bad metadata or unreadable state is explicitly uncertain', async t => {
  for (const failure of ['absent', 'different', 'metadata', 'get-failure']) {
    const { candidate, now } = await fixture(t), io = memory(); const prepared = await preparePlaces(io, candidate, approval(candidate));
    const put = io.put, get = io.get; let puts = 0, reads = 0;
    io.put = async (...args) => { puts++; if (failure !== 'absent') await put(...args);
      if (failure === 'different') io.objects.get(pointerKey('surf')).body = Buffer.from('{"foreign":true}');
      if (failure === 'metadata') io.objects.get(pointerKey('surf')).customMetadata.sha256 = '0'.repeat(64);
      throw Error('private lost response details'); };
    io.get = async (...args) => { if (args[0] === pointerKey('surf') && puts) { reads++; if (failure === 'get-failure') throw Error('private read failure'); } return get(...args); };
    await assert.rejects(activatePlaces(io, { kind: 'surf', identity: 'surf-test', expectedPointerSha256: 'absent', approvedCompletionSha256: prepared.completion.sha256, clock: () => now, expiresAt: new Date(now + 3600000).toISOString() }),
      error => /activation outcome uncertain; inspect pointer before retry/.test(error.message) && !error.message.includes('private'));
    assert.equal(puts, 1); assert.equal(reads, 1);
  }
});
test('lease cannot relabel expired surf or outlive 48 hours; PG source expiry remains null', async t => {
  const { candidate, now } = await fixture(t), io = memory(); const prepared = await preparePlaces(io, candidate, approval(candidate));
  await assert.rejects(activatePlaces(io, { kind: 'surf', identity: 'surf-test', expectedPointerSha256: 'absent', approvedCompletionSha256: prepared.completion.sha256, now, expiresAt: new Date(now + 49 * 3600000).toISOString() }));
  const pg = await fixture(t, 'paragliding'); assert.equal(pg.candidate.completion.sourceExpiresAt, null);
  assert.throws(() => validateCompletion({ ...pg.candidate.completion, sourceExpiresAt: new Date(now + 3600000).toISOString() }));
  const tides = await fixture(t, 'tides');
  assert.throws(() => validateCompletion({ ...tides.candidate.completion, sourceExpiresAt: null }), /requires source expiry/);
});
test('availability roster evidence must preserve requested, available and unavailable station identities', async t => {
  const f = await fixture(t, 'tides');
  const file = f.candidate.manifest.files.find(row => row.path.startsWith('availability-'));
  const source = f.candidate.local.get(file.path);
  const report = JSON.parse(await readFile(source.file)); report.unavailableStations[0].id = '1';
  await f.write(source.input, report);
  await assert.rejects(qualifyPlaces({ kind: 'tides', root: f.root }));
});
test('manifest bounds reject duplicates, oversized files and total inventory excess', async t => {
  const { candidate } = await fixture(t); const manifest = structuredClone(candidate.manifest);
  manifest.files.push(manifest.files.at(-1)); assert.throws(() => validateManifest(manifest));
  const tooBig = structuredClone(candidate.manifest); tooBig.files[0].bytes = LIMITS.fileBytes + 1; assert.throws(() => validateManifest(tooBig));
  const huge = { schemaVersion: 1, kind: 'paragliding', identity: 'a'.repeat(20), index: { path: 'index.json', bytes: 1, sha256: 'a'.repeat(64) },
    files: [{ path: 'index.json', bytes: 1, sha256: 'a'.repeat(64) }, ...Array.from({ length: 17 }, (_, i) => ({ path: `sites/${100 + i}.json`, bytes: LIMITS.fileBytes, sha256: 'a'.repeat(64) }))] };
  assert.throws(() => validateManifest(huge), /total byte budget/);
});
test('S3 transport fixes staging bucket, conditional writes and SHA metadata; redacts remote errors', async () => {
  const commands = [], env = { STAGING_R2_ACCOUNT_ID: ACCOUNT, STAGING_R2_WRITE_ACCESS_KEY_ID: 'test', STAGING_R2_WRITE_SECRET_ACCESS_KEY: 'test' };
  const io = await createPlacesS3(env, { send: async command => { commands.push(command); return { ETag: '"fixture"' }; } });
  const body = Buffer.from('{}'), key = prefix('surf', 'surf-test') + 'index.json';
  await io.put(key, body, { ifNoneMatch: '*', bytes: body.length, sha256: hash(body) });
  assert.equal(commands[0].input.Bucket, BUCKET); assert.equal(commands[0].input.IfNoneMatch, '*'); assert.equal(commands[0].input.Metadata.sha256, hash(body));
  await assert.rejects(io.put(key, body, { ifMatch: '"fixture"', bytes: body.length, sha256: hash(body) }), /cannot be overwritten/);
  await assert.rejects(io.get('releases/current.json', 8192));
  await assert.rejects(createPlacesS3({ ...env, AWS_ACCESS_KEY_ID: 'foreign' }, {}));
  const failing = await createPlacesS3(env, { send: async () => { throw Error('private credential body'); } });
  await assert.rejects(failing.get(key, 8192), error => !error.message.includes('private credential'));
});
test('S3 remote reads stream with exact size and metadata instead of retaining arrays', async () => {
  const body = Buffer.from('{"ok":true}'); const env = { STAGING_R2_ACCOUNT_ID: ACCOUNT, STAGING_R2_WRITE_ACCESS_KEY_ID: 'test', STAGING_R2_WRITE_SECRET_ACCESS_KEY: 'test' };
  const io = await createPlacesS3(env, { send: async () => ({ ETag: '"fixture"', ContentLength: body.length, Metadata: { sha256: hash(body) }, Body: Readable.from([body.subarray(0, 3), body.subarray(3)]) }) });
  const result = await io.get(prefix('surf', 'surf-test') + 'index.json', body.length, false);
  assert.equal(result.body, undefined); assert.equal(result.sha256, hash(body));
  await assert.rejects(io.get(prefix('surf', 'surf-test') + 'index.json', body.length - 1, false));
});
test('CLI is dry-run only and emits hashes/counts, never raw data or remote mutations', async t => {
  const { root } = await fixture(t);
  const output = execFileSync(process.execPath, ['tools/staging-places.mjs', 'dry-run', 'surf', root], { encoding: 'utf8' });
  const summary = JSON.parse(output); assert.equal(summary.dryRun, true); assert.equal(summary.qualificationRequired, true); assert(!('files' in summary));
  assert.throws(() => execFileSync(process.execPath, ['tools/staging-places.mjs', 'activate', 'surf', root], { stdio: 'pipe' }));
});
test('mutable candidate structures cannot diverge from the proof-bound canonical bodies', async t => {
  const { candidate } = await fixture(t), proof = approval(candidate), io = memory();
  candidate.completion.objectCount += 1;
  await assert.rejects(preparePlaces(io, candidate, proof)); assert.equal(io.writes.length, 0);
});
test('source expiry during transfer prevents completion and during activation prevents pointer write', async t => {
  const { candidate, now } = await fixture(t); let time = now;
  const io = memory(), put = io.put;
  io.put = async (...args) => { await put(...args); time = now + 7 * 3600000; };
  await assert.rejects(preparePlaces(io, candidate, { ...approval(candidate), now, clock: () => time }));
  assert(!io.writes.some(key => key.endsWith('/completion.json')));
  const fresh = memory(); const prepared = await preparePlaces(fresh, candidate, approval(candidate));
  const get = fresh.get; time = now;
  fresh.get = async (...args) => { const result = await get(...args); time = now + 7 * 3600000; return result; };
  await assert.rejects(activatePlaces(fresh, { kind: 'surf', identity: 'surf-test', expectedPointerSha256: 'absent', approvedCompletionSha256: prepared.completion.sha256, now, clock: () => time, expiresAt: new Date(now + 3600000).toISOString() }));
  assert(!fresh.objects.has(pointerKey('surf')));
});
test('payload pool is bounded to eight, completes all successes, and joins failures without claiming new work', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => i); let active = 0, peak = 0; const completed = [];
  await payloadPool(rows, async row => { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; completed.push(row); });
  assert.equal(peak, 8); assert.equal(active, 0); assert.deepEqual(completed.sort((a, b) => a - b), rows);
  let release, started = 0, joined = 0; const wait = new Promise(resolve => { release = resolve; });
  const run = payloadPool(rows, async row => { started++; if (row === 0) throw Error('first failure'); await wait; joined++; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(started, 8);
  release(); await assert.rejects(run, /first failure/); assert.equal(joined, 7); assert.equal(started, 8);
});
test('failed payload publication joins concurrent work before refusing completion or pointer', async t => {
  const { candidate } = await fixture(t); const io = memory(), put = io.put; let active = 0, ended = 0;
  io.put = async (...args) => { active++; try { await new Promise(resolve => setImmediate(resolve)); if (args[0].endsWith('index.json')) throw Error('failed index'); await put(...args); }
    finally { active--; ended++; } };
  await assert.rejects(preparePlaces(io, candidate, approval(candidate)), /failed index/);
  assert.equal(active, 0); assert.equal(ended, candidate.manifest.files.length); assert(!io.writes.some(key => key.endsWith('completion.json') || key.startsWith('shared-read/')));
  const fresh = memory(); const prepared = await preparePlaces(fresh, candidate, approval(candidate)); const get = fresh.get; active = 0; ended = 0;
  fresh.get = async (...args) => { if (args[0].endsWith('manifest.json') || args[0].endsWith('completion.json')) return get(...args);
    active++; try { await new Promise(resolve => setImmediate(resolve)); if (args[0].endsWith('index.json')) throw Error('failed readback'); return get(...args); } finally { active--; ended++; } };
  await assert.rejects(activatePlaces(fresh, { kind: 'surf', identity: 'surf-test', expectedPointerSha256: 'absent', approvedCompletionSha256: prepared.completion.sha256, expiresAt: new Date(Date.now() + 3600000).toISOString() }), /failed readback/);
  assert.equal(active, 0); assert.equal(ended, candidate.manifest.files.length); assert(!fresh.objects.has(pointerKey('surf')));
});
test('diagnostics never read provider messages or expose arbitrary status, names, keys, bodies or credentials', () => {
  const malicious = { name: 'secret-name', code: 'secret-code', $metadata: { httpStatusCode: 599 }, key: 'private/key', body: 'private-body', credentials: 'private-key' };
  Object.defineProperty(malicious, 'message', { get() { throw Error('message must never be read'); } });
  assert.deepEqual(placeFailureDiagnostic(malicious), { schemaVersion: 1, kind: 'staging-place-failure', stage: 'workflow', operation: 'validate', category: 'unknown' });
  for (const [error, category] of [[{ name: 'TimeoutError' }, 'timeout'], [{ code: 'ECONNRESET' }, 'network'], [{ code: 'ERR_ASSERTION' }, 'validation']]) assert.equal(placeFailureDiagnostic(error).category, category);
  assert.equal(placeFailureDiagnostic({ $metadata: { httpStatusCode: 503 }, message: 'secret' }).httpStatus, 503);
});
test('adapter failure diagnostics preserve only whitelisted get/put status plus joined payload progress', async t => {
  for (const operation of ['get', 'put']) {
    const { candidate } = await fixture(t), calls = [], reports = [];
    const env = { STAGING_R2_ACCOUNT_ID: ACCOUNT, STAGING_R2_WRITE_ACCESS_KEY_ID: 'test', STAGING_R2_WRITE_SECRET_ACCESS_KEY: 'test' };
    const io = await createPlacesS3(env, { send: async command => {
      const action = command.input.Body ? 'put' : 'get'; calls.push(action);
      if (operation === 'put' && action === 'get') throw { $metadata: { httpStatusCode: 404 }, message: 'secret-missing-body' };
      throw { $metadata: { httpStatusCode: operation === 'put' ? 429 : 403 }, name: 'private-name', code: 'private-code', message: 'private-provider-body', Key: 'private-key', credentials: 'private-credential' };
    } });
    let failure; try { await preparePlaces(io, candidate, { ...approval(candidate), report: row => reports.push(row) }); } catch (error) { failure = error; }
    assert.deepEqual(placeFailureDiagnostic(failure), { schemaVersion: 1, kind: 'staging-place-failure', stage: 'prepare-payload', operation, category: 'http', httpStatus: operation === 'put' ? 429 : 403, completedPayloads: 0, totalPayloads: candidate.manifest.files.length });
    assert(!JSON.stringify([placeFailureDiagnostic(failure), reports]).includes('private'));
    assert.equal(calls.filter(action => action === operation).length, candidate.manifest.files.length, 'one request per scheduled payload, no retry');
  }
});
test('integrity failure identifies metadata check and final joined completed count without leaking object paths', async t => {
  const { candidate } = await fixture(t), io = memory(); await preparePlaces(io, candidate, approval(candidate));
  io.objects.get(prefix('surf', 'surf-test') + candidate.manifest.files[0].path).customMetadata.sha256 = '0'.repeat(64);
  let failure; try { await preparePlaces(io, candidate, approval(candidate)); } catch (error) { failure = error; }
  const diagnostic = placeFailureDiagnostic(failure);
  assert.equal(diagnostic.stage, 'prepare-payload'); assert.equal(diagnostic.operation, 'check-metadata'); assert.equal(diagnostic.category, 'integrity');
  assert.equal(diagnostic.completedPayloads, candidate.manifest.files.length - 1); assert.equal(diagnostic.totalPayloads, candidate.manifest.files.length);
  assert(!JSON.stringify(diagnostic).includes(candidate.manifest.files[0].path));
});
test('progress is bounded to start, each500 completions and final count; reporter failure is nonfatal', () => {
  const reports = [], progress = placeProgress('prepare-payload', 11581, row => reports.push(row));
  for (let i = 0; i < 11581; i++) progress.completed();
  assert.deepEqual(reports.map(row => row.completedPayloads), [0, ...Array.from({ length: 23 }, (_, i) => (i + 1) * 500), 11581]);
  assert(reports.every(row => Object.keys(row).sort().join(',') === 'completedPayloads,kind,schemaVersion,stage,totalPayloads'));
  const throwing = placeProgress('activate-payload', 1, () => { throw Error('sink failed'); }); assert.doesNotThrow(() => throwing.completed());
});
test('existing exact immutable objects need one GET; newly written objects still require readback', async t => {
  const { candidate } = await fixture(t), io = memory(), get = io.get, reads = [];
  io.get = async (...args) => { reads.push(args[0]); return get(...args); };
  await preparePlaces(io, candidate, approval(candidate));
  assert.equal(new Set(reads).size, candidate.manifest.files.length + 2);
  for (const key of new Set(reads)) assert.equal(reads.filter(row => row === key).length, 2, 'new PUT must be read back');
  reads.length = 0; const writes = io.writes.length;
  await preparePlaces(io, candidate, approval(candidate));
  assert.equal(reads.length, candidate.manifest.files.length + 2);
  assert.equal(new Set(reads).size, reads.length, 'verified existing objects are not read twice'); assert.equal(io.writes.length, writes);
});
const retryEnv = { STAGING_R2_ACCOUNT_ID: ACCOUNT, STAGING_R2_WRITE_ACCESS_KEY_ID: 'test', STAGING_R2_WRITE_SECRET_ACCESS_KEY: 'test' };
const retryKey = prefix('surf', 'surf-test') + 'index.json';
function throttled() { return { $metadata: { httpStatusCode: 429 }, message: 'private provider response', credentials: 'private credential' }; }
test('GET429 backs off and recovers using one overall deadline signal and the same read command', async () => {
  for (const absent of [false, true]) {
    const calls = [], signals = [], delays = [], body = Buffer.from('{}'); let time = 0;
    const io = await createPlacesS3(retryEnv, { send: async (command, options) => {
      calls.push(command); signals.push(options.abortSignal); time += 100;
      if (calls.length < 3) throw throttled();
      if (absent) throw { $metadata: { httpStatusCode: 404 } };
      return { ETag: '"fixture"', ContentLength: body.length, Metadata: { sha256: hash(body) }, Body: Readable.from([body]) };
    } }, { clock: () => time, sleep: async (ms, signal) => { delays.push(ms); assert.equal(signal, signals[0]); time += ms; } });
    const result = await io.get(retryKey, body.length);
    assert.equal(result?.sha256 ?? null, absent ? null : hash(body)); assert.deepEqual(delays, [1000, 2000]);
    assert.equal(calls.length, 3); assert(calls.every(command => command === calls[0])); assert(signals.every(signal => signal === signals[0]));
  }
});
test('GET429 exhausts at five total attempts with bounded backoff and redacted diagnostics', async () => {
  let time = 0, attempts = 0; const delays = [];
  const io = await createPlacesS3(retryEnv, { send: async () => { attempts++; throw throttled(); } },
    { clock: () => time, sleep: async ms => { delays.push(ms); time += ms; } });
  await assert.rejects(io.get(retryKey, 2), error => { const row = placeFailureDiagnostic(error);
    assert.equal(row.httpStatus, 429); assert.equal(row.operation, 'get'); assert(!JSON.stringify(row).includes('private')); return true; });
  assert.equal(attempts, 5); assert.deepEqual(delays, [1000, 2000, 4000, 8000]); assert.equal(time, 15000);
});
test('GET429 never sleeps or starts another attempt beyond the original45second deadline', async () => {
  for (const oversleep of [false, true]) {
    let time = 0, attempts = 0, sleeps = 0;
    const io = await createPlacesS3(retryEnv, { send: async () => { attempts++; time = oversleep ? 43000 : 44500; throw throttled(); } },
      { clock: () => time, sleep: async () => { sleeps++; time = 45000; } });
    await assert.rejects(io.get(retryKey, 2), error => { assert.equal(placeFailureDiagnostic(error).category, 'timeout'); return true; });
    assert.equal(attempts, 1); assert.equal(sleeps, oversleep ? 1 : 0);
  }
});
test('non429 GET errors and all PUT429 errors remain single-attempt with no backoff', async () => {
  for (const failure of [{ $metadata: { httpStatusCode: 503 } }, { name: 'TimeoutError' }, { code: 'ECONNRESET' }, { $metadata: { httpStatusCode: 403 } }]) {
    let attempts = 0, sleeps = 0;
    const io = await createPlacesS3(retryEnv, { send: async () => { attempts++; throw failure; } }, { clock: () => 0, sleep: async () => { sleeps++; } });
    await assert.rejects(io.get(retryKey, 2)); assert.equal(attempts, 1); assert.equal(sleeps, 0);
  }
  let attempts = 0, sleeps = 0; const body = Buffer.from('{}');
  const io = await createPlacesS3(retryEnv, { send: async () => { attempts++; throw throttled(); } }, { clock: () => 0, sleep: async () => { sleeps++; } });
  await assert.rejects(io.put(retryKey, body, { ifNoneMatch: '*', bytes: body.length, sha256: hash(body) }), error => { assert.equal(placeFailureDiagnostic(error).httpStatus, 429); return true; });
  assert.equal(attempts, 1); assert.equal(sleeps, 0);
});
test('GET429 honors valid Retry-After seconds or HTTP date without crossing its deadline', async () => {
  for (const [value, expected] of [['3', 3000], ['Thu, 01 Jan 1970 00:00:05 GMT', 5000], ['0', 1000], ['private-response', 1000], ['-1', 1000], ['60', null]]) {
    let time = 0, attempts = 0; const delays = [];
    const io = await createPlacesS3(retryEnv, { send: async () => {
      attempts++; if (attempts === 1) throw { ...throttled(), $response: { headers: { 'retry-after': value, authorization: 'private-credential' } } };
      throw { $metadata: { httpStatusCode: 404 } };
    } }, { clock: () => time, sleep: async ms => { delays.push(ms); time += ms; } });
    if (expected === null) { await assert.rejects(io.get(retryKey, 2), error => { assert.equal(placeFailureDiagnostic(error).category, 'timeout'); return true; }); assert.equal(attempts, 1); assert.deepEqual(delays, []); }
    else { assert.equal(await io.get(retryKey, 2), null); assert.equal(attempts, 2); assert.deepEqual(delays, [expected]); }
  }
});
