import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { candidate, validateIndex, prepareSearch, activateSearch, renewSearch, revokeSearch, inspectSearch, hash, POINTER_KEY, searchGate, allowedSearchKey } from '../tools/staging-search.mjs';
const time = '2026-09-10T04:00:00Z';
const point = { n: 1, disp: 'San Francisco\tKSFO SFO', ll: [37619, -122375] };
const files = () => ({
  'core.json': Buffer.from(JSON.stringify({ v: 1, baked_at: time, families: { airport: point, storm: { n: 1, disp: '甲\tA\t2026\t9\t50\tjia', ll: [0, 0] } } })),
  'more.json': Buffer.from(JSON.stringify({ v: 1, baked_at: time, families: { station: point, tide: point, sonde: point } })),
});
test('manual staging workflow keeps writer secrets out of checkout, build and tests', () => {
  const workflow = readFileSync(new URL('../.github/workflows/staging-search.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n  (?:push|pull_request|workflow_run):/);
  assert.match(workflow, /cron: '17 \*\/6 \* \* \*'/);
  assert.match(workflow, /github.event_name == 'schedule' && 'renew'/);
  assert.match(workflow, /name: data-staging/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.doesNotMatch(workflow, /upload-artifact|UI_PRODUCTION|STAGING_WORKER_API_TOKEN|wrangler/);
  const writer = workflow.indexOf('      - name: Write staging search');
  assert.ok(writer > 0);
  assert.ok(workflow.indexOf('secrets.STAGING_R2_WRITE_ACCESS_KEY_ID') > writer);
  assert.ok(workflow.indexOf('secrets.STAGING_R2_WRITE_SECRET_ACCESS_KEY') > writer);
  const builder = readFileSync(new URL('../tools/staging-search-build.mjs', import.meta.url), 'utf8');
  const sha = builder.match(/ATMOS_SHA = '([a-f0-9]{40})'/)?.[1];
  assert.ok(sha && workflow.includes(`ref: ${sha}`));
  const ci = readFileSync(new URL('../.github/workflows/scheduler-ci.yml', import.meta.url), 'utf8');
  assert.ok(ci.includes('.github/workflows/staging-search.yml'));
});
function memory() {
  const objects = new Map(), writes = [];
  return { objects, writes, async get(key, max) {
    const value = objects.get(key); if (!value) return null;
    assert.ok(value.body.length <= max); return { ...value, sha256: hash(value.body) };
  }, async put(key, body, condition) {
    allowedSearchKey(key);
    const previous = objects.get(key);
    assert.ok(condition.ifNoneMatch ? !previous : previous?.etag === condition.ifMatch, 'CAS conflict');
    writes.push(key); objects.set(key, { body, etag: `"${writes.length}"`, customMetadata: { sha256: condition.sha256 } });
  } };
}
test('validates the complete typed pair, transfer limits and SFO anchor', () => {
  const f = files(); assert.match(candidate(f).candidateId, /^[a-f0-9]{64}$/);
  for (const mutation of [v => { delete v.families.airport; }, v => v.families.airport.n++,
    v => v.families.airport.ll[0] = 100000, v => v.families.airport.disp = 'None\tNONE',
    v => v.families.airport.w = [1, 2]]) {
    const v = JSON.parse(f['core.json']); mutation(v);
    assert.throws(() => validateIndex(Buffer.from(JSON.stringify(v)), 'core.json'));
  }
  assert.throws(() => candidate({ 'core.json': f['core.json'] }));
  assert.throws(() => validateIndex(Buffer.alloc(1048577), 'core.json'));
});
test('prepare is immutable, idempotent and never activates', async () => {
  const io = memory(), result = await prepareSearch(io, files());
  assert.equal(io.writes.length, 3); assert.equal(io.writes.at(-1), `staging-candidates/${result.candidateId}/search/manifest.json`);
  assert.ok(!io.objects.has(POINTER_KEY));
  await prepareSearch(io, files()); assert.equal(io.writes.length, 3);
});
test('inspect reports the exact current digest without leaking pointer contents or writing', async () => {
  const io = memory(); assert.deepEqual(await inspectSearch(io), { pointerSha256: 'absent', bytes: 0 });
  const body = Buffer.from('untrusted sensitive content');
  io.objects.set(POINTER_KEY, { body, etag: '"existing"' });
  assert.deepEqual(await inspectSearch(io), { pointerSha256: hash(body), bytes: body.length });
  assert.equal(io.writes.length, 0);
});
test('invalid pair and partial write cannot leave a completion receipt or pointer', async () => {
  const io = memory(); await assert.rejects(prepareSearch(io, { ...files(), 'more.json': Buffer.from('{}') }));
  assert.equal(io.writes.length, 0);
  const put = io.put; io.put = async (...args) => { if (io.writes.length === 1) throw Error('network'); return put(...args); };
  await assert.rejects(prepareSearch(io, files()));
  assert.equal(io.writes.length, 1); assert.ok(!io.objects.has(POINTER_KEY));
});
test('activation revalidates remote bytes and uses exact CAS; revocation is recoverable', async () => {
  const io = memory(), c = await prepareSearch(io, files());
  const result = await activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent', now: Date.parse(time) });
  assert.equal(result.pointer.files['core.json'].sha256, hash(files()['core.json']));
  await assert.rejects(activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent' }));
  const revoked = await revokeSearch(io, result.pointerSha256);
  assert.equal(revoked.pointer.candidateId, null); assert.equal(io.objects.size, 4);
});
test('corrupt bytes, missing receipt and concurrent pointer writer withhold activation', async () => {
  for (const issue of ['corrupt', 'missing', 'race']) {
    const io = memory(), c = await prepareSearch(io, files()), root = `staging-candidates/${c.candidateId}/search/`;
    if (issue === 'corrupt') io.objects.get(`${root}core.json`).body = Buffer.from('{}');
    if (issue === 'missing') io.objects.delete(`${root}manifest.json`);
    if (issue === 'race') {
      const put = io.put; io.put = async (...args) => { if (args[0] === POINTER_KEY) io.objects.set(POINTER_KEY, {body: Buffer.from('{}'), etag: '"other"'}); return put(...args); };
    }
    await assert.rejects(activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent' }));
    assert.ok(!io.writes.includes(POINTER_KEY));
  }
});
test('gate refuses local/unreviewed execution, foreign credentials and weather writes', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'search',
    GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-search.yml@refs/heads/main', STAGING_SEARCH_ENABLED: 'true',
    STAGING_DATA_ISOLATION_APPROVED: 'true', STAGING_R2_ACCOUNT_ID: 'a89f9a1af485021fbc60a68b163c7c6e' };
  searchGate(env, 'prepare');
  const scheduled = { ...env, GITHUB_EVENT_NAME: 'schedule', STAGING_SEARCH_RENEWAL_ENABLED: 'true', STAGING_SEARCH_APPROVED_CANDIDATE_SHA256: 'a'.repeat(64) };
  searchGate(scheduled, 'renew');
  for (const action of ['inspect', 'prepare', 'activate', 'revoke']) assert.throws(() => searchGate(scheduled, action));
  assert.throws(() => searchGate({ ...scheduled, STAGING_SEARCH_RENEWAL_ENABLED: '' }, 'renew'));
  assert.throws(() => searchGate({ ...scheduled, STAGING_SEARCH_APPROVED_CANDIDATE_SHA256: '' }, 'renew'));
  for (const change of [{ GITHUB_ACTIONS: '' }, { GITHUB_REF: 'refs/heads/test' }, { STAGING_SEARCH_ENABLED: '' },
    { R2_ACCESS_KEY_ID: 'secret' }, { STAGING_WORKER_API_TOKEN: 'secret' }, { GITHUB_JOB: 'foreign' },
    { GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/other.yml@refs/heads/main' }]) assert.throws(() => searchGate({ ...env, ...change }, 'prepare'));
  assert.throws(() => searchGate(env, 'activate'));
  for (const path of ['releases/current.json', 'catalogs/current.json', 'shared-read/pin.json',
    `staging-candidates/${'a'.repeat(64)}/search/../weather.json`]) assert.throws(() => allowedSearchKey(path));
});

test('renewal revalidates approved live bytes without changing source provenance', async () => {
  const io = memory(), f = files(), c = await prepareSearch(io, f), now = Date.parse(time);
  const first = await activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent', now });
  const renewed = await renewSearch(io, { approvedCandidateId: c.candidateId, clock: () => now + 3600000 });
  assert.equal(renewed.previousPointerSha256, first.pointerSha256);
  assert.equal(renewed.pointer.expiresAt, new Date(now + 25 * 3600000).toISOString());
  assert.deepEqual(renewed.pointer.files, first.pointer.files);
  assert.deepEqual(io.objects.get(`staging-candidates/${c.candidateId}/search/core.json`).body, f['core.json']);
});

test('renewal never revives absent, revoked, expired, malformed, foreign or corrupt state', async () => {
  for (const issue of ['absent', 'revoked', 'expired', 'future', 'malformed', 'array-time', 'non-iso', 'foreign', 'corrupt', 'receipt', 'files', 'race']) {
    const io = memory(), c = await prepareSearch(io, files()), now = Date.parse(time);
    const active = await activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent', now });
    const p = io.objects.get(POINTER_KEY);
    if (issue === 'absent') io.objects.delete(POINTER_KEY);
    if (issue === 'revoked') await revokeSearch(io, active.pointerSha256);
    if (issue === 'malformed') p.body = Buffer.from('{}');
    if (issue === 'array-time' || issue === 'non-iso') { const v = JSON.parse(p.body); v.createdAt = issue === 'array-time' ? [v.createdAt] : 'September 10, 2026 04:00:00 UTC'; p.body = Buffer.from(JSON.stringify(v)); }
    if (issue === 'files') { const v = JSON.parse(p.body); v.files['core.json'].bytes++; p.body = Buffer.from(JSON.stringify(v)); }
    if (issue === 'corrupt') io.objects.get(`staging-candidates/${c.candidateId}/search/core.json`).body = Buffer.from('{}');
    if (issue === 'receipt') io.objects.delete(`staging-candidates/${c.candidateId}/search/manifest.json`);
    if (issue === 'race') {
      const put = io.put;
      io.put = async (...args) => { if (args[0] === POINTER_KEY) io.objects.set(POINTER_KEY, { body: Buffer.from('{}'), etag: '"other"' }); return put(...args); };
    }
    const writes = io.writes.length;
    await assert.rejects(renewSearch(io, { approvedCandidateId: issue === 'foreign' ? 'a'.repeat(64) : c.candidateId,
      clock: () => now + (issue === 'expired' ? 24 * 3600000 : issue === 'future' ? -3600000 : 3600000) }), issue);
    assert.equal(io.writes.length, writes, issue);
  }
});

test('renewal refuses a lease that expires during validation or pre-write read', async () => {
  for (const expireOn of ['manifest.json', POINTER_KEY]) {
    const io = memory(), c = await prepareSearch(io, files()), start = Date.parse(time);
    await activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent', now: start });
    let now = start + 23 * 3600000, pointerReads = 0;
    const get = io.get;
    io.get = async (key, max) => {
      const result = await get(key, max);
      if (key === POINTER_KEY) pointerReads++;
      if (key.endsWith(expireOn) && (expireOn !== POINTER_KEY || pointerReads === 2)) now = start + 24 * 3600000;
      return result;
    };
    const writes = io.writes.length;
    await assert.rejects(renewSearch(io, { approvedCandidateId: c.candidateId, clock: () => now }));
    assert.equal(io.writes.length, writes);
  }
});
