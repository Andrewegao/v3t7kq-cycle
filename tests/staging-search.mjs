import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { candidate, validateIndex, prepareSearch, activateSearch, renewSearch, revokeSearch, inspectSearch,
  verifyV4Staging, validateV4SourceEvidence, hash, POINTER_KEY, searchGate,
  allowedSearchKey } from '../tools/staging-search.mjs';
import { ATMOS_SHA, SEARCH_V4_READER_CLOSURE, STAGING_ORIGIN } from '../tools/staging-search-source.mjs';
const time = '2026-09-10T04:00:00Z';
const UI_SHA = 'f'.repeat(40);
const point = { n: 1, disp: 'San Francisco\tKSFO SFO\t', ll: [37619, -122375],
  rgv: ['San Francisco'], rgi: [0], ccv: ['US'], cci: [0] };
const files = () => ({
  'core.json': Buffer.from(JSON.stringify({ v: 2, baked_at: time, families: { airport: point, storm: { n: 1, disp: '甲\tA\t2026\t9\t50\tjia', ll: [0, 0] } } })),
  'more.json': Buffer.from(JSON.stringify({ v: 2, baked_at: time, families: {
    station: { n: 1, disp: 'San Francisco\tKSFO', ll: [37619, -122375], ap: [0] },
    tide: { n: 1, disp: 'San Francisco Tide\t9414290', ll: [37807, -122465] },
    sonde: { n: 1, disp: 'Oakland\t72493', ll: [37720, -122220] },
  } })),
});
const legacyFiles = () => ({
  'core.json': Buffer.from(JSON.stringify({ v: 1, baked_at: time, families: {
    airport: { n: 1, disp: 'San Francisco\tKSFO SFO', ll: [37619, -122375] },
    storm: { n: 1, disp: '甲\tA\t2026\t9\t50\tjia', ll: [0, 0] },
  } })),
  'more.json': Buffer.from(JSON.stringify({ v: 1, baked_at: time, families: {
    station: { n: 1, disp: 'San Francisco\tKSFO', ll: [37619, -122375] },
    tide: { n: 1, disp: 'San Francisco Tide\t9414290', ll: [37807, -122465] },
    sonde: { n: 1, disp: 'Oakland\t72493', ll: [37720, -122220] },
  } })),
});
const v2Ready = async () => {};
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
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.equal((workflow.match(/secrets\.ATMOS_DEPLOY_KEY/g) ?? []).length, 1);
  assert.match(workflow, /actions\/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065/);
  assert.match(workflow, /python-version: '3\.12'/);
  assert.doesNotMatch(workflow, /pip install|requirements\.txt/);
  const writer = workflow.indexOf('      - name: Write staging search');
  const source = workflow.indexOf('      - name: Verify the exact reviewed Search V4 reader source');
  const compatibility = workflow.indexOf('      - name: Verify the reviewed V4 shell');
  assert.ok(writer > 0);
  assert.ok(source > 0 && source < compatibility && compatibility < writer);
  assert.ok(workflow.indexOf('secrets.STAGING_R2_WRITE_ACCESS_KEY_ID') > writer);
  assert.ok(workflow.indexOf('secrets.STAGING_R2_WRITE_SECRET_ACCESS_KEY') > writer);
  assert.ok(!/^0{40}$/.test(ATMOS_SHA) && workflow.includes(`'${ATMOS_SHA}'`));
  assert.match(workflow, /vars\.STAGING_SEARCH_V4_APPROVED_UI_SOURCE_SHA/);
  assert.match(workflow, /if: inputs\.action == 'prepare' \|\| inputs\.action == 'activate'/);
  assert.match(workflow, /ref: \$\{\{ inputs\.action == 'prepare' && '[a-f0-9]{40}' \|\| vars\.STAGING_SEARCH_V4_APPROVED_UI_SOURCE_SHA \}\}/);
  assert.doesNotMatch(workflow, /ref: \$\{\{ (?:github\.sha|github\.ref)/);
  assert.match(workflow, /node cycle\/tools\/staging-search\.mjs source-compatibility/);
  assert.match(workflow, /repository: weatherx-hq\/atmos\n\s+fetch-depth: 0\n/,
    'the ancestry gate needs the reviewed base in the exact UI checkout history');
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
function seedLegacy(io, now = Date.parse(time)) {
  const f = legacyFiles(), receipts = Object.fromEntries(Object.entries(f).map(([name, body]) =>
    [name, { bytes: body.length, sha256: hash(body) }]));
  const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, kind: 'search', files: receipts })}\n`);
  const candidateId = hash(manifest), root = `staging-candidates/${candidateId}/search/`;
  for (const [name, body] of Object.entries(f)) io.objects.set(`${root}${name}`,
    { body, etag: `"legacy-${name}"`, customMetadata: { sha256: hash(body) } });
  io.objects.set(`${root}manifest.json`, { body: manifest, etag: '"legacy-manifest"',
    customMetadata: { sha256: candidateId } });
  const pointer = { schemaVersion: 1, kind: 'search', candidateId,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 24 * 3600000).toISOString(), files: receipts };
  const body = Buffer.from(`${JSON.stringify(pointer)}\n`);
  io.objects.set(POINTER_KEY, { body, etag: '"legacy-pointer"', customMetadata: { sha256: hash(body) } });
  return { candidateId, pointer, body };
}
test('validates the complete matched V2 pair, transfer limits and SFO anchor', () => {
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

test('rejects V1, mismatched generations and non-canonical timestamps', () => {
  for (const issue of ['v1', 'mismatch', 'fractional', 'timezone']) {
    const f = files();
    const core = JSON.parse(f['core.json']), more = JSON.parse(f['more.json']);
    if (issue === 'v1') core.v = 1;
    if (issue === 'mismatch') more.baked_at = '2026-09-10T04:00:01Z';
    if (issue === 'fractional') core.baked_at = '2026-09-10T04:00:00.000Z';
    if (issue === 'timezone') core.baked_at = '2026-09-10T04:00:00+00:00';
    f['core.json'] = Buffer.from(JSON.stringify(core));
    f['more.json'] = Buffer.from(JSON.stringify(more));
    assert.throws(() => candidate(f), issue);
  }
});

test('rejects malformed V2 columns and station links outside the paired core', () => {
  for (const mutate of [
    ({ core }) => { core.families.airport.rgi = [1]; },
    ({ core }) => { delete core.families.airport.rgv; },
    ({ core }) => { core.families.airport.ccv = ['US', 'US']; },
    ({ core }) => { core.families.airport.extra = []; },
    ({ more }) => { more.families.tide.ap = [-1]; },
    ({ more }) => { more.families.station.ap = [1]; },
  ]) {
    const f = files(), pair = { core: JSON.parse(f['core.json']), more: JSON.parse(f['more.json']) };
    mutate(pair);
    f['core.json'] = Buffer.from(JSON.stringify(pair.core));
    f['more.json'] = Buffer.from(JSON.stringify(pair.more));
    assert.throws(() => candidate(f));
  }
});

test('uses the producer V4 150 KiB transfer budget for each decoded index', () => {
  const largeCore = n => {
    const lines = ['San Francisco\tKSFO SFO\t'], ll = [37619, -122375];
    for (let i = 1; i < n; i++) {
      lines.push(`${hash(Buffer.from(String(i)))}\tK${String(i).padStart(5, '0')}\t`);
      ll.push(0, 0);
    }
    return Buffer.from(JSON.stringify({ v: 2, baked_at: time, families: {
      airport: { n, disp: lines.join('\n'), ll },
      storm: { n: 1, disp: '甲\tA\t2026\t9\t50\tjia', ll: [0, 0] },
    } }));
  };
  const accepted = files(); accepted['core.json'] = largeCore(3500);
  assert.ok(gzipSync(accepted['core.json'], { level: 9 }).length > 130 * 1024);
  assert.match(candidate(accepted).candidateId, /^[a-f0-9]{64}$/);
  const rejected = files(); rejected['core.json'] = largeCore(4000);
  assert.ok(gzipSync(rejected['core.json'], { level: 9 }).length > 150 * 1024);
  assert.throws(() => candidate(rejected));
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
  await assert.rejects(activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent' }),
    /compatible staging shell/);
  assert.ok(!io.objects.has(POINTER_KEY));
  let compatibilityChecks = 0;
  const result = await activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent',
    now: Date.parse(time), ensureV2Compatible: async () => { compatibilityChecks++; } });
  assert.equal(compatibilityChecks, 1);
  assert.equal(result.pointer.files['core.json'].sha256, hash(files()['core.json']));
  await assert.rejects(activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent',
    ensureV2Compatible: v2Ready }));
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
    await assert.rejects(activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent',
      ensureV2Compatible: v2Ready }));
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
  const activate = { ...env, CANDIDATE_SHA256: 'a'.repeat(64), STAGING_SEARCH_APPROVED_CANDIDATE_SHA256: 'a'.repeat(64),
    EXPECTED_POINTER_SHA256: 'absent', STAGING_SEARCH_V4_APPROVED_UI_SOURCE_SHA: UI_SHA,
    STAGING_SEARCH_V4_APPROVED_RELEASE_ID: `git-${UI_SHA.slice(0, 12)}-run-123` };
  searchGate(activate, 'activate');
  for (const key of ['STAGING_SEARCH_APPROVED_CANDIDATE_SHA256', 'STAGING_SEARCH_V4_APPROVED_UI_SOURCE_SHA',
    'STAGING_SEARCH_V4_APPROVED_RELEASE_ID']) assert.throws(() => searchGate({ ...activate, [key]: '' }, 'activate'));
  for (const path of ['releases/current.json', 'catalogs/current.json', 'shared-read/pin.json',
    `staging-candidates/${'a'.repeat(64)}/search/../weather.json`]) assert.throws(() => allowedSearchKey(path));
});

test('V4 source proof binds an exact protected descendant and nine-file reader closure', () => {
  assert.equal(Object.keys(SEARCH_V4_READER_CLOSURE).length, 9);
  assert.equal(SEARCH_V4_READER_CLOSURE['app/src/chrome/Search.tsx'],
    '0a24339be80ca6f964624e7b554639d31014e67dc73acae63f094aaf03489faf');
  const env = { STAGING_SEARCH_V4_APPROVED_UI_SOURCE_SHA: UI_SHA };
  const evidence = { head: UI_SHA, clean: true, includesSearchV4Base: true,
    files: { ...SEARCH_V4_READER_CLOSURE } };
  assert.deepEqual(validateV4SourceEvidence(env, evidence), {
    uiSourceSha: UI_SHA, searchV4BaseSha: ATMOS_SHA, files: 9,
  });
  for (const mutate of [
    value => { value.head = ATMOS_SHA; },
    value => { value.clean = false; },
    value => { value.includesSearchV4Base = false; },
    value => { value.files['app/src/chrome/Search.tsx'] = '0'.repeat(64); },
    value => { delete value.files['app/src/chrome/searchIndex.ts']; },
    value => { value.files['app/src/chrome/extra.ts'] = '0'.repeat(64); },
    value => { value.extra = true; },
  ]) {
    const bad = structuredClone(evidence); mutate(bad);
    assert.throws(() => validateV4SourceEvidence(env, bad));
  }
  assert.throws(() => validateV4SourceEvidence({}, evidence));
});

test('V2 activation accepts only the approved canonical V4 staging release', async () => {
  const releaseId = `git-${UI_SHA.slice(0, 12)}-run-123`;
  const html = Buffer.from('<!doctype html><title>WeatherX</title><div id="root"></div>');
  const env = { STAGING_SEARCH_V4_APPROVED_UI_SOURCE_SHA: UI_SHA,
    STAGING_SEARCH_V4_APPROVED_RELEASE_ID: releaseId };
  const baseProfile = { product: 'lab', platformAccount: '1', platformDataAuth: 'public' };
  const wind100 = { catalogId: 'stage-wind100-34547542747-1', runId: '2026091000',
    selectionSha256: 'e'.repeat(64) };
  const receipt = { releaseId, gitSha: UI_SHA, shellSha256: 'b'.repeat(64), indexSha256: hash(html),
    buildProfile: { ...baseProfile, wind100 } };
  const fetcherFor = candidateReceipt => async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'omit'); assert.ok(init.signal);
    assert.deepEqual(init.headers, { 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache' });
    if (url === `${STAGING_ORIGIN}/health/release.json?search_v4_compatibility=1`) return Response.json(candidateReceipt);
    assert.equal(url, `${STAGING_ORIGIN}/?search_v4_compatibility=1`);
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  assert.deepEqual(await verifyV4Staging(env, fetcherFor(receipt)), { releaseId, sourceSha: UI_SHA });
  assert.deepEqual(await verifyV4Staging(env, fetcherFor({...receipt,
    buildProfile:{...baseProfile,wind100:{...wind100,dynamic:true}}})), { releaseId, sourceSha: UI_SHA });
  assert.deepEqual(await verifyV4Staging(env, fetcherFor({ ...receipt, buildProfile: baseProfile })),
    { releaseId, sourceSha: UI_SHA });
  for (const change of [
    { env: { ...env, STAGING_SEARCH_V4_APPROVED_UI_SOURCE_SHA: 'a'.repeat(40) } },
    { env: { ...env, STAGING_SEARCH_V4_APPROVED_RELEASE_ID: 'other' } },
    { value: { ...receipt, gitSha: ATMOS_SHA } },
    { value: { ...receipt, releaseId: 'other' } },
    { value: { ...receipt, buildProfile: { ...receipt.buildProfile, product: 'road' } } },
    { value: { ...receipt, buildProfile: { ...receipt.buildProfile, extra: true } } },
    { value: { ...receipt, buildProfile: { ...receipt.buildProfile,
      wind100: { ...wind100, extra: true } } } },
    { value: { ...receipt, buildProfile: { ...receipt.buildProfile,
      wind100: { ...wind100, dynamic: false } } } },
    { value: { ...receipt, buildProfile: { ...receipt.buildProfile,
      wind100: { ...wind100, dynamic: 'true' } } } },
    { value: { ...receipt, buildProfile: { ...receipt.buildProfile,
      wind100: { ...wind100, dynamic: true, extra: true } } } },
    { value: { ...receipt, buildProfile: { ...receipt.buildProfile,
      wind100: { ...wind100, catalogId: 'stage-wind100-other' } } } },
    { value: { ...receipt, buildProfile: { ...receipt.buildProfile,
      wind100: { ...wind100, runId: '2026093124' } } } },
    { value: { ...receipt, buildProfile: { ...receipt.buildProfile,
      wind100: { ...wind100, selectionSha256: 'E'.repeat(64) } } } },
    { value: { ...receipt, buildProfile: { ...receipt.buildProfile, wind100: null } } },
    { response: new Response('{}', { status: 302 }) },
    { response: new Response('{}', { headers: { 'content-length': '9000' } }) },
  ]) {
    await assert.rejects(verifyV4Staging(change.env ?? env,
      change.response ? async (url) => url.includes('/health/release.json') ? change.response :
        new Response(html, { headers: { 'content-type': 'text/html' } }) : fetcherFor(change.value ?? receipt)));
  }
  await assert.rejects(verifyV4Staging(env, fetcherFor({ ...receipt, indexSha256: 'c'.repeat(64) })));
});

test('renewal revalidates approved live bytes without changing source provenance', async () => {
  const io = memory(), f = files(), c = await prepareSearch(io, f), now = Date.parse(time);
  const first = await activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent',
    now, ensureV2Compatible: v2Ready });
  let compatibilityChecks = 0;
  const renewed = await renewSearch(io, { approvedCandidateId: c.candidateId,
    clock: () => now + 3600000, ensureV2Compatible: async () => { compatibilityChecks++; } });
  assert.equal(compatibilityChecks, 1);
  assert.equal(renewed.previousPointerSha256, first.pointerSha256);
  assert.equal(renewed.pointer.expiresAt, new Date(now + 25 * 3600000).toISOString());
  assert.deepEqual(renewed.pointer.files, first.pointer.files);
  assert.deepEqual(io.objects.get(`staging-candidates/${c.candidateId}/search/core.json`).body, f['core.json']);
});

test('V2 renewal never restores a candidate after exact UI compatibility is withdrawn', async () => {
  const io = memory(), c = await prepareSearch(io, files()), now = Date.parse(time);
  await activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent',
    now, ensureV2Compatible: v2Ready });
  const writes = io.writes.length;
  await assert.rejects(renewSearch(io, { approvedCandidateId: c.candidateId,
    clock: () => now + 3600000, ensureV2Compatible: async () => { throw Error('UI approval withdrawn'); } }));
  assert.equal(io.writes.length, writes);
});

test('renewal preserves the existing immutable V1 pointer without requiring V4 activation', async () => {
  const io = memory(), now = Date.parse(time), legacy = seedLegacy(io, now);
  let compatibilityChecks = 0;
  const renewed = await renewSearch(io, { approvedCandidateId: legacy.candidateId,
    clock: () => now + 3600000, ensureV2Compatible: async () => { compatibilityChecks++; } });
  assert.equal(compatibilityChecks, 0);
  assert.equal(renewed.pointer.candidateId, legacy.candidateId);
  assert.deepEqual(renewed.pointer.files, legacy.pointer.files);
});

test('renewal never revives absent, revoked, expired, malformed, foreign or corrupt state', async () => {
  for (const issue of ['absent', 'revoked', 'expired', 'future', 'malformed', 'array-time', 'non-iso', 'foreign', 'corrupt', 'receipt', 'files', 'race']) {
    const io = memory(), c = await prepareSearch(io, files()), now = Date.parse(time);
    const active = await activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent',
      now, ensureV2Compatible: v2Ready });
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
      clock: () => now + (issue === 'expired' ? 24 * 3600000 : issue === 'future' ? -3600000 : 3600000),
      ensureV2Compatible: v2Ready }), issue);
    assert.equal(io.writes.length, writes, issue);
  }
});

test('renewal refuses a lease that expires during validation or pre-write read', async () => {
  for (const expireOn of ['manifest.json', POINTER_KEY]) {
    const io = memory(), c = await prepareSearch(io, files()), start = Date.parse(time);
    await activateSearch(io, { candidateId: c.candidateId, expectedPointerSha256: 'absent',
      now: start, ensureV2Compatible: v2Ready });
    let now = start + 23 * 3600000, pointerReads = 0;
    const get = io.get;
    io.get = async (key, max) => {
      const result = await get(key, max);
      if (key === POINTER_KEY) pointerReads++;
      if (key.endsWith(expireOn) && (expireOn !== POINTER_KEY || pointerReads === 2)) now = start + 24 * 3600000;
      return result;
    };
    const writes = io.writes.length;
    await assert.rejects(renewSearch(io, { approvedCandidateId: c.candidateId,
      clock: () => now, ensureV2Compatible: v2Ready }));
    assert.equal(io.writes.length, writes);
  }
});
