import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ACCOUNT, hash, qualifyPlaces, allowedKey, pointerKey } from '../tools/staging-places.mjs';
import { renewalGate, controllerDigest, CLOSURE, isolatedPythonArguments, renewQualified, readPriorPointer, verifyLive } from '../tools/staging-place-renewal.mjs';
const policy = JSON.parse(await readFile('tools/staging-place-renewal-policy.json'));
const encode = value => Buffer.from(JSON.stringify(value) + '\n');
function environment() { return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
  GITHUB_REF: 'refs/heads/main', GITHUB_JOB: 'renew', GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-place-renewal.yml@refs/heads/main',
  STAGING_PLACES_RENEWAL_ENABLED: 'true', STAGING_DATA_ISOLATION_APPROVED: 'true', STAGING_R2_ACCOUNT_ID: ACCOUNT,
  GITHUB_EVENT_NAME: 'workflow_dispatch', PLACES_KIND: 'surf', REQUESTED_FAMILY: 'all', ATMOS_SHA: policy.sourceSha,
  STAGING_PLACES_RENEWAL_CONTROLLER_SHA256: 'a'.repeat(64), RUNNER_TEMP: '/tmp', GITHUB_WORKSPACE: '/workspace' }; }
test('renewal requires exact main hosted job, reviewed closure/source and explicit staging permission', () => {
  const env = environment(); assert.equal(renewalGate(env, policy, 'a'.repeat(64)).run, true);
  for (const [key, value] of Object.entries({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/heads/dev',
    GITHUB_JOB: 'places', GITHUB_REPOSITORY: 'weatherx-hq/atmos', RUNNER_ENVIRONMENT: 'self-hosted',
    GITHUB_WORKFLOW_REF: 'foreign', STAGING_PLACES_RENEWAL_ENABLED: 'false', STAGING_DATA_ISOLATION_APPROVED: 'false',
    STAGING_R2_ACCOUNT_ID: 'foreign', ATMOS_SHA: '0'.repeat(40), STAGING_PLACES_RENEWAL_CONTROLLER_SHA256: '0'.repeat(64),
    PLACES_KIND: 'weather', REQUESTED_FAMILY: 'prod', UI_SECRET: 'secret', AWS_ACCESS_KEY_ID: 'secret', RUNNER_TEMP: 'relative' })) {
    assert.throws(() => renewalGate({ ...env, [key]: value }, policy, 'a'.repeat(64)), key);
  }
});
test('independent schedules and family dispatch never select the wrong feed', () => {
  for (const kind of ['surf', 'paragliding', 'tides']) {
    const env = { ...environment(), PLACES_KIND: kind, GITHUB_EVENT_NAME: 'schedule' };
    assert.equal(renewalGate({ ...env, RENEWAL_SCHEDULE: policy.surfSchedule }, policy, 'a'.repeat(64)).run, kind === 'surf');
    assert.equal(renewalGate({ ...env, RENEWAL_SCHEDULE: policy.directoryTideSchedule }, policy, 'a'.repeat(64)).run, kind !== 'surf');
    assert.throws(() => renewalGate({ ...env, RENEWAL_SCHEDULE: '* * * * *' }, policy, 'a'.repeat(64)));
    assert.equal(renewalGate({ ...environment(), PLACES_KIND: kind, REQUESTED_FAMILY: 'tides' }, policy, 'a'.repeat(64)).run, kind === 'tides');
  }
});
test('controller fingerprint covers workflow, private source policy, all transitive local code and locked dependencies', async t => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'wx-renewal-closure-'))); t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of CLOSURE) { await mkdir(resolve(root, file, '..'), { recursive: true }); await writeFile(resolve(root, file), await readFile(file)); }
  const original = await controllerDigest(); assert.equal(await controllerDigest(root), original);
  await writeFile(resolve(root, 'unrelated.md'), 'unrelated main commit'); assert.equal(await controllerDigest(root), original);
  for (const file of CLOSURE) {
    const content = await readFile(resolve(root, file)); await writeFile(resolve(root, file), Buffer.concat([content, Buffer.from('\n')]));
    assert.notEqual(await controllerDigest(root), original, file); await writeFile(resolve(root, file), content);
  }
});
test('collection and qualifier Python cannot import an arbitrary sibling shadow module', async t => {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'wx-renewal-python-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const probe = resolve(root, 'probe.py');
  await writeFile(resolve(root, 'json.py'), "raise RuntimeError('unreviewed sibling module executed')\n");
  await writeFile(probe, "import json; print(json.__name__)\n");
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8' };
  assert.equal(execFileSync('python3', isolatedPythonArguments(probe), { cwd: root, env, encoding: 'utf8' }).trim(), 'json');
  assert.equal(execFileSync(resolve('tools/staging-place-python'), ['-c', "import json; print(json.__name__)"],
    { cwd: root, env, encoding: 'utf8' }).trim(), 'json');
  assert.match(await readFile('tools/staging-place-renewal.mjs', 'utf8'), /safeExecute\('python3', isolatedPythonArguments\(/);
  assert.match(await readFile('tools/staging-places-workflow.mjs', 'utf8'), /'--python', ISOLATED_PYTHON/);
});
async function fixture(t, kind = 'surf') {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'wx-renewal-test-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const write = async (path, value) => { await mkdir(resolve(root, path, '..'), { recursive: true }); const b = encode(value); await writeFile(resolve(root, path), b); return b; };
  if (kind === 'surf') {
    const identity = 'surf-test', source = { runId: '2026091018', initializedAt: new Date(now - 3600000).toISOString(), freshUntil: new Date(now + 10 * 3600000).toISOString() };
    const times = Array.from({ length: 73 }, (_, i) => now + i * 3600000), samples = times.map(time => ({ time, waveHeight: 1 }));
    const b = await write('spots/test.json', { releaseId: identity, catalogVersion: 'test', spotId: 'test', source, windSource: source, samples });
    await write('index.json', { schemaVersion: 1, releaseId: identity, catalogVersion: 'test', source, cadenceSeconds: 3600, times,
      spots: [{ spotId: 'test', path: 'surf/spots/test.json', bytes: b.length, sha256: hash(b), waveHeight: times.map(() => 1) }] });
  } else if (kind === 'paragliding') {
    const identity = 'a'.repeat(20), b = await write(`versions/${identity}/cells/1_2.json`, { sites: [{ id: 1 }] });
    await write(`versions/${identity}/sites/1.json`, { id: 1, revision: identity });
    await write('index.json', { schema: 1, revision: identity, count: 1, cells: [{ key: '1_2', sha256: hash(b) }] });
  } else {
    const identity = 'noaa-coops-20260910T180000Z', source = { provider: 'NOAA CO-OPS' }, datum = { id: 'MLLW' };
    const path = `versions/${identity}/stations/1/window.json`;
    await write(`v2/${path}`, { schemaVersion: 2, datasetId: identity, stationId: '1', source, datum });
    await write('v2/catalog.json', { schemaVersion: 2, datasetId: identity, source, datum,
      stations: [{ id: '1', eventCoverage: { startMs: now - 6 * 3600000, endMs: now + 8 * 86400000 },
        sampleCoverage: { startMs: now - 86400000, endMs: now + 8 * 86400000 }, packs: [{ path }] }] });
    await write('tides.json', { stations: [] });
  }
  const candidate = await qualifyPlaces({ kind, root, now });
  const proof = { schemaVersion: 1, kind, identity: candidate.completion.identity, sourceSha: policy.sourceSha,
    manifestSha256: hash(candidate.manifestBody), checks: { producer: true, consumer: true, coverage: true, roster: true } };
  const p = { ...policy, paragliding: { ...policy.paragliding, identity: candidate.completion.identity, manifestSha256: hash(candidate.manifestBody) } };
  const objects = new Map(), writes = [];
  const putObject = (key, body) => objects.set(key, { body, etag: `"${writes.length}"`, customMetadata: { sha256: hash(body) }, httpMetadata: {} });
  const io = { async get(key, max, collect = true) { allowedKey(key); const o = objects.get(key); if (!o) return null;
    assert(o.body.length <= max); return { ...o, sha256: hash(o.body), bytes: o.body.length, ...(collect ? {} : { body: undefined }) }; },
  async put(key, input, condition) { allowedKey(key); const o = objects.get(key); assert(condition.ifNoneMatch ? !o : o?.etag === condition.ifMatch);
    const b = Buffer.isBuffer(input) ? input : await readFile(input.file); writes.push(key); putObject(key, b); } };
  return { now, candidate, proof, policy: p, objects, writes, io, putObject };
}
for (const kind of ['surf', 'paragliding']) test(`${kind}: real primitives verify all bytes and activate only own pointer`, async t => {
  const f = await fixture(t, kind); const options = { clock: () => f.now };
  const result = await renewQualified(f.io, f.candidate, f.proof, f.policy, options); assert.equal(result.activated, true);
  const pointer = JSON.parse(f.objects.get(pointerKey(kind)).body);
  assert.equal(pointer.sourceExpiresAt, f.candidate.completion.sourceExpiresAt);
  assert.equal(pointer.expiresAt, new Date(f.now + (kind === 'surf' ? 10 : 24) * 3600000).toISOString());
  assert(f.writes.every(key => key === pointerKey(kind) || key.startsWith(`staging-places/${kind}/`)));
  f.writes.length = 0;
  await renewQualified(f.io, f.candidate, f.proof, f.policy, { clock: () => f.now + 3600000 });
  assert.deepEqual(f.writes, [pointerKey(kind)], 'retained immutable files are never overwritten');
});
test('bad proof and insufficient freshness fail before any write', async t => {
  const f = await fixture(t);
  for (const key of Object.keys(f.proof.checks)) await assert.rejects(renewQualified(f.io, f.candidate,
    { ...f.proof, checks: { ...f.proof.checks, [key]: false } }, f.policy));
  await assert.rejects(renewQualified(f.io, f.candidate, f.proof, f.policy, { clock: () => f.now + 5 * 3600000 }));
  assert.equal(f.writes.length, 0);
});
test('renewal retains the six-hour source horizon through activation readback and final pointer CAS', async t => {
  const f = await fixture(t); let now = f.now, activating = false;
  const get = f.io.get;
  f.io.get = async (key, ...args) => {
    const result = await get(key, ...args);
    if (key.endsWith('/completion.json') && result?.body) activating = true;
    else if (activating && key.includes('/spots/')) now = f.now + 5 * 3600000;
    return result;
  };
  await assert.rejects(renewQualified(f.io, f.candidate, f.proof, f.policy, { clock: () => now }), /minimum activation horizon/);
  assert(!f.objects.has(pointerKey('surf')), 'activation must not write a pointer below the final freshness horizon');
});
test('upload failure leaves all old pointers unchanged and cannot activate partial inventory', async t => {
  const f = await fixture(t), sentinel = encode({ unaffected: true }); f.putObject(pointerKey('tides'), sentinel);
  let calls = 0; const put = f.io.put; f.io.put = async (...args) => { if (++calls === 2) throw Error('upload failed'); return put(...args); };
  await assert.rejects(renewQualified(f.io, f.candidate, f.proof, f.policy));
  assert(!f.objects.has(pointerKey('surf'))); assert.deepEqual(f.objects.get(pointerKey('tides')).body, sentinel);
});
test('concurrent pointer writer is not overwritten and no PUT retry is attempted', async t => {
  const f = await fixture(t); await renewQualified(f.io, f.candidate, f.proof, f.policy, { clock: () => f.now });
  const before = f.objects.get(pointerKey('surf')).body, get = f.io.get; let changed = false;
  f.io.get = async (key, ...args) => { const result = await get(key, ...args);
    if (!changed && key === pointerKey('surf')) { changed = true; f.putObject(key, encode({ ...JSON.parse(before), createdAt: new Date(f.now + 1).toISOString() })); }
    return result; };
  f.writes.length = 0;
  await assert.rejects(renewQualified(f.io, f.candidate, f.proof, f.policy, { clock: () => f.now + 3600000 }), /pointer changed/);
  assert.equal(f.writes.length, 0);
});
test('tides cannot replace a newer same-coverage dataset with an older collection', async t => {
  const f = await fixture(t, 'tides');
  await renewQualified(f.io, f.candidate, f.proof, f.policy, { clock: () => f.now });
  const current = JSON.parse(f.objects.get(pointerKey('tides')).body);
  const identity = 'noaa-coops-20260910T190000Z';
  const base = { ...current, identity };
  delete base.createdAt; delete base.expiresAt; delete base.completion;
  const completionBody = encode(base);
  f.putObject(pointerKey('tides'), encode({ ...base, createdAt: current.createdAt, expiresAt: current.expiresAt,
    completion: { path: 'completion.json', bytes: completionBody.length, sha256: hash(completionBody) } }));
  f.writes.length = 0;
  await assert.rejects(renewQualified(f.io, f.candidate, f.proof, f.policy, { clock: () => f.now + 1000 }), /newer tide/);
  assert.equal(f.writes.length, 0);
});
test('prior pointer corruption is rejected, not treated as absent', () => {
  assert.equal(readPriorPointer(null, 'surf', Date.now()), null);
  assert.throws(() => readPriorPointer({ body: encode({}), bytes: 3, sha256: '0'.repeat(64) }, 'surf', Date.now()));
});
test('live verification bounds bytes, checks own staging identity, never contacts production, retries only reads', async t => {
  const f = await fixture(t); let calls = 0; const urls = [];
  const fetcher = async url => { urls.push(String(url)); calls++;
    if (calls === 1) return new Response('old', { status: 503 });
    const path = url.pathname.endsWith('/index.json') ? 'index.json' : 'spots/test.json';
    return new Response(await readFile(f.candidate.local.get(path).file), { headers: { 'content-type': 'application/json',
      'x-weatherx-data-source': 'own', 'x-weatherx-release': f.candidate.completion.identity, 'x-content-type-options': 'nosniff' } }); };
  const result = await verifyLive(f.candidate, fetcher, async () => {}); assert(result.liveVerified); assert.equal(calls, 3);
  assert(urls.every(url => new URL(url).origin === 'https://staging.weatherx.org'));
  await assert.rejects(verifyLive(f.candidate, async () => new Response('wrong'), async () => {}));
});
test('workflow isolates credentials, disables fail-fast, schedules real collection and preserves manual lane', async () => {
  const text = await readFile('.github/workflows/staging-place-renewal.yml', 'utf8');
  assert(text.includes('fail-fast: false') && text.includes('group: weatherx-staging-publication'));
  assert(text.includes(policy.surfSchedule) && text.includes(policy.directoryTideSchedule));
  assert(!/upload-artifact|contents: write|wrangler|weatherx-data-production/.test(text));
  for (const step of text.split(/\n      - /)) {
    if (step.includes('STAGING_R2_WRITE_ACCESS_KEY_ID:')) assert(step.includes('mjs publish') && !step.includes('SEED_KEY'));
    if (step.includes('STAGING_PLACES_SEED_KEY:')) assert(step.includes('mjs decrypt') && !step.includes('STAGING_R2_WRITE_'));
  }
  assert(text.indexOf('mjs qualify') < text.indexOf('STAGING_R2_WRITE_ACCESS_KEY_ID:'));
  for (const match of text.matchAll(/uses: ([^\s]+)@([^\s]+)/g)) assert(/^[a-f0-9]{40}$/.test(match[2]));
  assert(!(await readFile('.github/workflows/staging-places.yml', 'utf8')).includes('schedule:'));
});
