import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ACCOUNT, hash, qualifyPlaces, allowedKey, pointerKey } from '../tools/staging-places.mjs';
import { renewalGate, controllerDigest, CLOSURE, isolatedPythonArguments, renewQualified, readPriorPointer, verifyLive,
  parseCollectorSuccess, collectorProcessFailure } from '../tools/staging-place-renewal.mjs';
const policy = JSON.parse(await readFile('tools/staging-place-renewal-policy.json'));
const encode = value => Buffer.from(JSON.stringify(value) + '\n');
function environment() { return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
  GITHUB_REF: 'refs/heads/main', GITHUB_JOB: 'renew', GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-place-renewal.yml@refs/heads/main',
  STAGING_PLACES_RENEWAL_ENABLED: 'true', STAGING_DATA_ISOLATION_APPROVED: 'true', STAGING_R2_ACCOUNT_ID: ACCOUNT,
  GITHUB_EVENT_NAME: 'workflow_dispatch', PLACES_KIND: 'surf', REQUESTED_FAMILY: 'all', ATMOS_SHA: policy.sourceSha,
  STAGING_PLACES_RENEWAL_CONTROLLER_SHA256: 'a'.repeat(64), RUNNER_TEMP: '/tmp', GITHUB_WORKSPACE: '/workspace' }; }
test('renewal requires exact main hosted job, reviewed closure/source and explicit staging permission', () => {
  const env = environment(); assert.equal(renewalGate(env, policy, 'a'.repeat(64)).run, true);
  assert.throws(() => renewalGate(env, { ...policy, tideRequestsPerSecond: 4 }, 'a'.repeat(64)), 'tide rate');
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
const emptyRequestCounts = { http2xx: 0, http403: 0, http429: 0, http5xx: 0, httpOther: 0,
  timeouts: 0, overlongRetryAfter: 0, pacerStopped: false };
test('collector success exposes only exact validated bounded counts', () => {
  const surf = { schemaVersion: 1, kind: 'staging-place-collection', status: 'succeeded', family: 'surf',
    spotCount: 49, leadCount: 73, requestCounts: { ...emptyRequestCounts, http2xx: 74 } };
  assert.deepEqual(parseCollectorSuccess(`${JSON.stringify(surf)}\n`, 'surf'), surf);
  const tides = { schemaVersion: 1, kind: 'staging-place-collection', status: 'succeeded', family: 'tides',
    rosterStationCount: 1256, requiredStationCount: 1251, availableStationCount: 1251, resumeAttempts: 1,
    firstPassAvailableStationCount: 1169,
    firstPassRequestCounts: { ...emptyRequestCounts, http2xx: 1169, http5xx: 1 },
    requestCounts: { ...emptyRequestCounts, http2xx: 1251, http5xx: 1 } };
  assert.deepEqual(parseCollectorSuccess(JSON.stringify(tides), 'tides'), tides);
  for (const corrupt of [
    { ...tides, privateMessage: '/private/provider?token=DO-NOT-PRINT' },
    { ...tides, availableStationCount: 1250 },
    { ...tides, requestCounts: { ...tides.requestCounts, privateUrl: 'https://private.invalid' } },
  ]) assert.throws(() => parseCollectorSuccess(JSON.stringify(corrupt), 'tides'));
  assert.throws(() => parseCollectorSuccess(`${JSON.stringify(tides)}\nPRIVATE`, 'tides'));
});
test('collector failure accepts only its exact safe schema and otherwise classifies the process', () => {
  const receipt = { schemaVersion: 1, kind: 'staging-place-collection', status: 'failed', family: 'tides',
    phase: 'fetch', class: 'minimum-availability', rosterStationCount: 1256, availableStationCount: 1250,
    requiredStationCount: 1251, resumeAttempts: 1, firstPassAvailableStationCount: 1169,
    firstPassRequestCounts: { ...emptyRequestCounts, http2xx: 1169, http5xx: 1 },
    requestCounts: { ...emptyRequestCounts, http2xx: 1250, http5xx: 2 } };
  const exact = Object.assign(new Error('outer private path'), { status: 1, stdout: '', stderr: `${JSON.stringify(receipt)}\n` });
  assert.deepEqual(collectorProcessFailure(exact, 'tides'), receipt);
  const secret = '/private/provider?token=DO-NOT-PRINT';
  for (const stderr of [secret, `${JSON.stringify(receipt)}\n${secret}`,
    JSON.stringify({ ...receipt, privateMessage: secret }), JSON.stringify({ ...receipt, family: 'surf' })]) {
    const projected = collectorProcessFailure(Object.assign(new Error(secret), { status: 17, stdout: '', stderr }), 'tides');
    assert.deepEqual(projected, { schemaVersion: 1, kind: 'staging-place-collection', status: 'failed', family: 'tides',
      phase: 'process', class: 'process-exit', returnCode: 17 });
    assert(!JSON.stringify(projected).includes(secret));
  }
  const withStdout = collectorProcessFailure({ status: 1, stdout: secret, stderr: JSON.stringify(receipt) }, 'tides');
  assert.equal(withStdout.class, 'process-exit');
});
test('collector preserves the exact stopped-pacer receipt without claiming a resume', () => {
  const counts = { ...emptyRequestCounts, http429: 1, overlongRetryAfter: 1, pacerStopped: true };
  const receipt = { schemaVersion: 1, kind: 'staging-place-collection', status: 'failed', family: 'tides',
    phase: 'fetch', class: 'provider-cooldown', rosterStationCount: 1256, availableStationCount: 1169,
    requiredStationCount: 1251, resumeAttempts: 0, firstPassAvailableStationCount: 1169,
    firstPassRequestCounts: counts, requestCounts: counts };
  assert.deepEqual(collectorProcessFailure({ status: 1, stdout: '', stderr: `${JSON.stringify(receipt)}\n` }, 'tides'), receipt);
  assert.equal(collectorProcessFailure({ status: 1, stdout: '', stderr: JSON.stringify({
    ...receipt, firstPassAvailableStationCount: 1168 }) }, 'tides').class, 'process-exit');
});
test('collector subprocess return code and timeout never expose command paths or output', () => {
  const secret = '/private/source/fetch_tides.py?key=DO-NOT-PRINT';
  const exited = collectorProcessFailure({ status: 23, path: secret, stdout: secret, stderr: secret }, 'tides');
  assert.deepEqual(exited, { schemaVersion: 1, kind: 'staging-place-collection', status: 'failed', family: 'tides',
    phase: 'process', class: 'process-exit', returnCode: 23 });
  const timedOut = collectorProcessFailure({ code: 'ETIMEDOUT', signal: 'SIGTERM', path: secret,
    stdout: secret, stderr: secret }, 'tides');
  assert.deepEqual(timedOut, { schemaVersion: 1, kind: 'staging-place-collection', status: 'failed', family: 'tides',
    phase: 'process', class: 'process-timeout' });
  assert(!JSON.stringify([exited, timedOut]).includes(secret));
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
function legacyTidePointer(f, { identity = 'noaa-coops-20260910T170000Z',
  sourceExpiresAt = new Date(f.now + 2 * 86400000).toISOString() } = {}) {
  const completion = { ...f.candidate.completion, identity, sourceExpiresAt };
  const completionBody = encode(completion);
  return { ...completion, createdAt: new Date(f.now - 3600000).toISOString(), expiresAt: new Date(f.now + 3600000).toISOString(),
    completion: { path: 'completion.json', bytes: completionBody.length, sha256: hash(completionBody) } };
}
function correctionFor(pointer, correctedSourceExpiresAt) {
  return { kind: pointer.kind, identity: pointer.identity, sourceExpiresAt: pointer.sourceExpiresAt, correctedSourceExpiresAt,
    completion: structuredClone(pointer.completion), manifest: structuredClone(pointer.manifest) };
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
test('one exact legacy tide metadata correction changes only the comparison baseline', async t => {
  const f = await fixture(t, 'tides'), prior = legacyTidePointer(f);
  const corrected = new Date(f.now + 12 * 3600000).toISOString();
  const migrationPolicy = { ...f.policy, tidePriorFreshnessCorrection: correctionFor(prior, corrected) };
  f.putObject(pointerKey('tides'), encode(prior)); f.writes.length = 0;
  const result = await renewQualified(f.io, f.candidate, f.proof, migrationPolicy, { clock: () => f.now });
  assert(result.activated);
  assert.equal(JSON.parse(f.objects.get(pointerKey('tides')).body).identity, f.candidate.completion.identity);
  assert(f.writes.every(key => key === pointerKey('tides') || key.includes(`/snapshots/${f.candidate.completion.identity}/`)));
  assert(!f.writes.some(key => key.includes(`/snapshots/${prior.identity}/`)), 'legacy immutable objects must not be rewritten');
});
test('every legacy tide correction pin is exact and a normal newer prior still rejects', async t => {
  const mutations = [
    value => { value.kind = 'surf'; },
    value => { value.identity = 'noaa-coops-20260910T165959Z'; },
    value => { value.sourceExpiresAt = new Date(Date.parse(value.sourceExpiresAt) + 1000).toISOString(); },
    value => { value.correctedSourceExpiresAt = value.sourceExpiresAt; },
    value => { value.completion.path = 'other.json'; },
    value => { value.completion.bytes += 1; },
    value => { value.completion.sha256 = '0'.repeat(64); },
    value => { value.manifest.path = 'other.json'; },
    value => { value.manifest.bytes += 1; },
    value => { value.manifest.sha256 = '0'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t, 'tides'), prior = legacyTidePointer(f);
    const correction = correctionFor(prior, new Date(f.now + 12 * 3600000).toISOString()); mutate(correction);
    f.putObject(pointerKey('tides'), encode(prior)); f.writes.length = 0;
    await assert.rejects(renewQualified(f.io, f.candidate, f.proof,
      { ...f.policy, tidePriorFreshnessCorrection: correction }, { clock: () => f.now }));
    assert.equal(f.writes.length, 0);
  }
  const f = await fixture(t, 'tides'), newer = legacyTidePointer(f, { identity: 'noaa-coops-20260910T190000Z' });
  const correction = correctionFor(legacyTidePointer(f), new Date(f.now + 12 * 3600000).toISOString());
  f.putObject(pointerKey('tides'), encode(newer)); f.writes.length = 0;
  await assert.rejects(renewQualified(f.io, f.candidate, f.proof,
    { ...f.policy, tidePriorFreshnessCorrection: correction }, { clock: () => f.now }), /freshness rollback/);
  assert.equal(f.writes.length, 0);
});
test('migration policy pins the independently verified legacy tide receipts and corrected expiry', () => {
  assert.deepEqual(policy.tidePriorFreshnessCorrection, {
    kind: 'tides', identity: 'noaa-coops-20260910T171959Z',
    sourceExpiresAt: '2026-09-11T23:54:00.000Z', correctedSourceExpiresAt: '2026-09-11T08:12:00.000Z',
    completion: { path: 'completion.json', bytes: 414, sha256: 'b77bdaefe79374c46bee90ab905865dab585e2e2f5649c7072d9f3141da19715' },
    manifest: { path: 'manifest.json', bytes: 164453, sha256: '2dc0c5d3201842a8eed1230c938f1c46a699422987b75f2834824d8c54abee97' },
  });
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
  assert.match(await readFile('tools/staging-place-renewal.mjs', 'utf8'), /45 \* 60000/);
  assert.equal(policy.tideRequestsPerSecond, 2);
  for (const match of text.matchAll(/uses: ([^\s]+)@([^\s]+)/g)) assert(/^[a-f0-9]{40}$/.test(match[2]));
  assert(!(await readFile('.github/workflows/staging-places.yml', 'utf8')).includes('schedule:'));
});
