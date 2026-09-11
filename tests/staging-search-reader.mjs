import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readerGate, settings, runtime, uploadMetadata, assertVersion, assertBoundary, allowedApi, transport,
  preflight, rollout, recover, digest, annotations, wind100Approval, candidateBindings, assertStagingRoutes,
  ACCOUNT, WORKER, SCRIPT, ROUTES, EXCLUSIVE, WIND100_BINDING_NAMES } from '../tools/staging-search-reader.mjs';
const OLD = '11111111-1111-1111-1111-111111111111', NEW = '22222222-2222-2222-2222-222222222222', FOREIGN = '33333333-3333-3333-3333-333333333333';
const sha = 'a'.repeat(40), source = { sha, sha256: 'c'.repeat(64), bytes: Buffer.from('source') };
const WIND100 = { catalogId: 'stage-wind100-34547542747-1', runId: '2026091100', selectionSha256: 'd'.repeat(64) };
const OLD_WIND100 = { catalogId: 'stage-wind100-34540000000-1', runId: '2026091012', selectionSha256: 'e'.repeat(64) };
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'reader',
  GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-search-reader.yml@refs/heads/main',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', STAGING_SEARCH_READER_ENABLED: 'true', STAGING_R2_ACCOUNT_ID: ACCOUNT,
  READER_SOURCE_SHA: sha, STAGING_SEARCH_READER_APPROVED_SOURCE_SHA: sha };
const wind100Env = (change = {}) => ({ STAGING_WIND100_READER_ENABLED: 'true',
  STAGING_WIND100_READER_CATALOG_ID: WIND100.catalogId, STAGING_WIND100_READER_RUN_ID: WIND100.runId,
  STAGING_WIND100_READER_SELECTION_SHA256: WIND100.selectionSha256, ...change });
const wind100Bindings = value => WIND100_BINDING_NAMES.map(name => ({ name, type: 'plain_text', text: {
  STAGING_WIND100_CATALOG_ID: value.catalogId, STAGING_WIND100_RUN_ID: value.runId,
  STAGING_WIND100_SELECTION_SHA256: value.selectionSha256,
}[name] }));
function boundary(existingWind100 = null, extraBindings = [], routes = [{ pattern: 'staging.weatherx.org/data/*', script: WORKER }]) {
  const vars = { APP_ORIGIN: 'https://staging.weatherx.org', AUTH_MODE: 'public', BILLING_MODE: 'enabled',
    STRIPE_ENVIRONMENT: 'test', AI_AUTH_POLICY: 'staging-account-v1', DATA_SOURCE_MODE: 'shared', DATA_CATALOG_MODE: 'serve',
    EXTRA_REVIEWED_VARIABLE: 'retain exactly' };
  const bindings = [...Object.entries(vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
    { name: 'SECRET', type: 'secret_text' }, { name: 'DATA_BUCKET', type: 'r2_bucket', bucket_name: 'weatherx-data-staging' },
    { name: 'COMPONENT_BUCKET', type: 'r2_bucket', bucket_name: 'weatherx-components-staging' },
    { name: 'PLATFORM_DB', type: 'd1', id: '9501827a-7e4c-4249-806b-d45d5857d9e5' },
    ...(existingWind100 ? wind100Bindings(existingWind100) : []), ...extraBindings];
  const rt = { compatibility_date: '2026-08-15', compatibility_flags: ['nodejs_compat'], limits: { cpu_ms: 50 }, usage_model: 'standard' };
  return { settings: settings({ bindings, ...rt, placement: { mode: 'smart' }, cache_options: { enabled: true }, observability: { enabled: true },
    annotations: { 'workers/tag': 'before' }, tags: ['keep'] }), runtime: rt, schedules: { schedules: [{ cron: '17 3 * * *' }] },
    subdomain: { enabled: false, previews_enabled: false }, routes };
}
function memory({ existingWind100 = null } = {}) {
  let active = OLD, state = boundary(existingWind100), history = [{ id: OLD, number: 8 }];
  const versions = new Map([[OLD, { id: OLD, number: 8, resources: { bindings: state.settings.bindings,
    script_runtime: state.runtime, script: { etag: 'e'.repeat(64) } }, annotations: state.settings.annotations }]]);
  const calls = [], ops = {
    active: async () => active, boundary: async () => structuredClone(state), history: async () => structuredClone(history),
    version: async id => structuredClone(versions.get(id)), pause: async () => {}, probe: async () => { calls.push('probe'); },
    upload: async (bytes, metadata) => {
      calls.push('upload'); assert.ok(Buffer.isBuffer(bytes));
      const inherited = new Map(state.settings.bindings.map(binding => [binding.name, binding]));
      const resolvedBindings = metadata.bindings.map(binding => {
        if (binding.type !== 'inherit') return binding;
        assert.equal(binding.version_id, 'latest'); assert.ok(!('text' in binding));
        assert.ok(inherited.has(binding.name)); return inherited.get(binding.name);
      });
      const number = history[0].number + 1;
      const v = { id: NEW, number, resources: { bindings: settings({ ...state.settings, bindings: resolvedBindings }).bindings, script_runtime: state.runtime,
        script: { etag: 'f'.repeat(64) } }, annotations: metadata.annotations };
      versions.set(NEW, structuredClone(v)); history.unshift({ id: NEW, number });
      state.settings.bindings = structuredClone(v.resources.bindings);
      state.settings.annotations = metadata.annotations; return structuredClone(v);
    }, deploy: async id => { calls.push(`deploy:${id}`); active = id; },
  };
  return { ops, calls, versions, mutate: fn => fn({ state, history, versions }), foreign: () => { active = FOREIGN; } };
}
async function ready(m, wind100 = null) {
  const r = await preflight(m.ops, source, { run: '123' }, Date.now(), wind100);
  return [r, { version: r.beforeVersion, digest: r.boundarySha256, ...(wind100 ? { wind100 } : {}) }];
}
test('exact main/manual workflow and source/gates required; execution needs reviewed boundary and edit freeze', () => {
  readerGate(env, 'inspect');
  for (const delta of [{ GITHUB_JOB: 'other' }, { GITHUB_WORKFLOW_REF: 'other' }, { GITHUB_REF: 'refs/heads/test' },
    { STAGING_SEARCH_READER_ENABLED: '' }, { STAGING_SEARCH_READER_APPROVED_SOURCE_SHA: 'b'.repeat(40) }, { DATA_EDGE_TOKEN: 'secret' }]) {
    assert.throws(() => readerGate({ ...env, ...delta }, 'inspect'));
  }
  assert.throws(() => readerGate(env, 'rollout'));
  readerGate({ ...env, EXCLUSIVE_WINDOW_CONFIRMATION: EXCLUSIVE, STAGING_SEARCH_READER_APPROVED_VERSION: OLD,
    STAGING_SEARCH_READER_APPROVED_BOUNDARY_SHA256: 'a'.repeat(64) }, 'rollout');
});
test('Wind100 Worker intent is a distinct exact data-staging approval and refuses partial, malformed, or unknown approval state', () => {
  assert.equal(wind100Approval(env), null);
  assert.deepEqual(wind100Approval({ ...env, ...wind100Env() }), WIND100);
  for (const delta of [
    { STAGING_WIND100_READER_ENABLED: 'false' },
    { STAGING_WIND100_READER_ENABLED: '', STAGING_WIND100_READER_CATALOG_ID: WIND100.catalogId },
    { STAGING_WIND100_READER_RUN_ID: '' },
    { STAGING_WIND100_READER_RUN_ID: '2026093124' },
    { STAGING_WIND100_READER_SELECTION_SHA256: 'D'.repeat(64) },
    { STAGING_WIND100_READER_EXTRA: 'unexpected' },
  ]) assert.throws(() => readerGate({ ...env, ...wind100Env(), ...delta }, 'inspect'));
  for (const key of ['STAGING_WIND100_READER_CATALOG_ID', 'STAGING_WIND100_READER_RUN_ID', 'STAGING_WIND100_READER_SELECTION_SHA256']) {
    assert.throws(() => readerGate({ ...env, [key]: wind100Env()[key] }, 'inspect'));
  }
});
test('preserves every admitted setting; refuses assets, future fields, unknown bindings and foreign resources', () => {
  const b = boundary();
  same(settings(b.settings), b.settings);
  for (const extra of [{ assets: { jwt: 'DO NOT DROP' } }, { future_setting: true }]) assert.throws(() => settings({ ...b.settings, ...extra }));
  assert.throws(() => settings({ ...b.settings, bindings: [...b.settings.bindings, { name: 'NEW', type: 'future' }] }));
  assert.throws(() => settings({ ...b.settings, bindings: b.settings.bindings.map(b => b.name === 'DATA_BUCKET' ? { ...b, bucket_name: 'weatherx-data-production' } : b) }));
  assert.throws(() => runtime({ ...b.runtime, future: 'unsupported' }));
});
test('live Wind100 state is either absent or one exact public tuple; partial, unknown, secret, and invalid tuples refuse', () => {
  assert.doesNotThrow(() => boundary(WIND100));
  for (const bindings of [
    wind100Bindings(WIND100).slice(0, 2),
    [...wind100Bindings(WIND100), { name: 'STAGING_WIND100_UNKNOWN', type: 'plain_text', text: 'value' }],
    wind100Bindings(WIND100).map(binding => binding.name === 'STAGING_WIND100_RUN_ID' ? { name: binding.name, type: 'secret_text' } : binding),
    wind100Bindings({ ...WIND100, runId: '2026093124' }),
  ]) assert.throws(() => boundary(null, bindings));
});
function same(a, b) { assert.equal(digest(a), digest(b)); }
test('inspect is read-only, metadata inherits values and preserves runtime limits and placement', async () => {
  const m = memory(), [r] = await ready(m), metadata = uploadMetadata(r);
  assert.ok(!m.calls.includes('upload') && !m.calls.some(c => c.startsWith('deploy:')));
  same(metadata.limits, r.before.runtime.limits); same(metadata.placement, r.before.settings.placement);
  assert.equal(metadata.bindings.length, r.before.settings.bindings.length);
  assert.ok(!JSON.stringify(metadata).includes('retain exactly'));
});
test('healthy owned upload activates once and preserves settings/secret names', async () => {
  const m = memory(), [r, approved] = await ready(m);
  await rollout(m.ops, source, r, approved);
  assert.equal(r.status, 'passed'); assert.deepEqual(m.calls.filter(c => c.startsWith('deploy:')), [`deploy:${NEW}`]);
  assertVersion(await m.ops.version(NEW), r); assertBoundary(await m.ops.boundary(), r);
});
test('approved Wind100 upload replaces only the exact public tuple while inheriting every unrelated binding', async () => {
  for (const existingWind100 of [null, OLD_WIND100]) {
    const m = memory({ existingWind100 }), [r, approved] = await ready(m, WIND100), before = r.before.settings.bindings;
    const metadata = uploadMetadata(r), direct = metadata.bindings.filter(binding => binding.type !== 'inherit');
    assert.deepEqual(direct, wind100Bindings(WIND100));
    assert.deepEqual(metadata.bindings.filter(binding => binding.type === 'inherit').map(binding => binding.name).sort(),
      before.filter(binding => !WIND100_BINDING_NAMES.includes(binding.name)).map(binding => binding.name).sort());
    assert.ok(metadata.bindings.filter(binding => binding.type === 'inherit').every(binding => binding.version_id === 'latest'));
    assert.deepEqual(metadata.bindings.find(binding => binding.name === 'SECRET'),
      { name: 'SECRET', type: 'inherit', version_id: 'latest' });
    await rollout(m.ops, source, r, approved);
    const candidate = await m.ops.version(NEW), previous = await m.ops.version(OLD);
    same(candidate.resources.bindings, candidateBindings(r));
    same(previous.resources.bindings, before);
    const unrelatedBefore = before.filter(binding => !WIND100_BINDING_NAMES.includes(binding.name));
    const unrelatedAfter = candidate.resources.bindings.filter(binding => !WIND100_BINDING_NAMES.includes(binding.name));
    same(unrelatedAfter, unrelatedBefore);
  }
});
test('disabled rollout remains inherit-only and preserves an already active exact Wind100 tuple byte-for-policy', async () => {
  const m = memory({ existingWind100: OLD_WIND100 }), [r, approved] = await ready(m);
  const metadata = uploadMetadata(r);
  assert.ok(metadata.bindings.every(binding => binding.type === 'inherit' && binding.version_id === 'latest'));
  assert.equal(metadata.annotations['workers/message'], 'Staging search reader code-only qualification');
  await rollout(m.ops, source, r, approved);
  same((await m.ops.version(NEW)).resources.bindings, r.before.settings.bindings);
});
test('stale approval, changed Wind100 intent, expired preflight and changed source prevent any upload', async () => {
  for (const issue of ['approval', 'wind100', 'expiry', 'source']) {
    const m = memory(), [r, a] = await ready(m);
    await assert.rejects(rollout(m.ops, issue === 'source' ? { ...source, sha256: 'd'.repeat(64) } : source, r,
      issue === 'approval' ? { ...a, digest: 'b'.repeat(64) } : issue === 'wind100' ? { ...a, wind100: WIND100 } : a,
      () => {}, issue === 'expiry' ? Date.parse(r.createdAt) + 900001 : Date.now()));
    assert.ok(!m.calls.includes('upload'));
  }
});
test('inactive upload with binding/runtime drift never activates', async () => {
  for (const issue of ['binding', 'runtime', 'assets']) {
    const m = memory(), [r, a] = await ready(m), upload = m.ops.upload;
    m.ops.upload = async (...args) => {
      const result = await upload(...args);
      if (issue === 'binding') result.resources.bindings[0].text = 'secret mismatch';
      if (issue === 'runtime') result.resources.script_runtime.limits.cpu_ms++;
      if (issue === 'assets') result.resources.assets = { existing: true };
      return result;
    };
    await assert.rejects(rollout(m.ops, source, r, a));
    assert.ok(!m.calls.some(c => c.startsWith('deploy:')));
  }
});
test('foreign history/settings/activation never overwritten', async () => {
  for (const issue of ['history', 'settings', 'active']) {
    const m = memory(), [r, a] = await ready(m), upload = m.ops.upload;
    m.ops.upload = async (...args) => {
      const result = await upload(...args);
      m.mutate(({ state, history }) => {
        if (issue === 'history') history.unshift({ id: FOREIGN, number: 10 });
        if (issue === 'settings') state.settings.logpush = true;
      });
      if (issue === 'active') m.foreign();
      return result;
    };
    await assert.rejects(rollout(m.ops, source, r, a)); assert.ok(!m.calls.some(c => c.startsWith('deploy:')));
  }
});
test('a concurrent latest version before candidate upload is rejected even when its binding values happen to match', async () => {
  const m = memory(), [r, approved] = await ready(m, WIND100), upload = m.ops.upload;
  m.ops.upload = async (...args) => {
    m.mutate(({ state, history, versions }) => {
      const foreign = { id: FOREIGN, number: history[0].number + 1, resources: { bindings: state.settings.bindings,
        script_runtime: state.runtime, script: { etag: '9'.repeat(64) } }, annotations: state.settings.annotations };
      versions.set(FOREIGN, foreign); history.unshift({ id: FOREIGN, number: foreign.number });
    });
    return upload(...args);
  };
  await assert.rejects(rollout(m.ops, source, r, approved));
  assert.ok(!m.calls.some(call => call.startsWith('deploy:')));
});
test('failed post-activation readiness restores only reviewed previous version', async () => {
  const m = memory(), [r, a] = await ready(m, WIND100); let probes = 0;
  m.ops.probe = async () => { if (++probes === 1) throw Error('unhealthy'); };
  await assert.rejects(rollout(m.ops, source, r, a));
  assert.equal(r.recovery, 'prior-version-restored');
  assert.deepEqual(m.calls.filter(c => c.startsWith('deploy:')), [`deploy:${NEW}`, `deploy:${OLD}`]);
  same((await m.ops.version(OLD)).resources.bindings, r.before.settings.bindings);
  assert.equal(await m.ops.active(), OLD);
});
test('lost activation response observes success without second deployment', async () => {
  const m = memory(), [r, a] = await ready(m, WIND100), deploy = m.ops.deploy;
  m.ops.deploy = async id => { await deploy(id); throw Error('lost response'); };
  await rollout(m.ops, source, r, a); assert.equal(r.status, 'passed');
  assert.equal(m.calls.filter(c => c.startsWith('deploy:')).length, 1);
});
test('lost upload response does not retry or infer ownership', async () => {
  const m = memory(), [r, a] = await ready(m, WIND100), upload = m.ops.upload;
  m.ops.upload = async (...args) => { await upload(...args); throw Error('lost'); };
  await assert.rejects(rollout(m.ops, source, r, a));
  assert.equal(m.calls.filter(c => c === 'upload').length, 1); assert.ok(!m.calls.some(c => c.startsWith('deploy:')));
});
test('the platform Worker route boundary rejects any production route while allowing unrelated Worker routes', () => {
  assertStagingRoutes([{ pattern: 'staging.weatherx.org/api/v1/*', script: WORKER },
    { pattern: 'weatherx.org/api/v1/*', script: 'weatherx-platform-edge-production' }]);
  assert.throws(() => assertStagingRoutes([{ pattern: 'weatherx.org/api/v1/*', script: 'weatherx-platform-edge-production' }]));
  assert.throws(() => assertStagingRoutes([{ pattern: 'weatherx.org/api/v1/*', script: WORKER }]));
});
test('recovery refuses foreign current deployment and changed rollback bytes', async () => {
  for (const issue of ['foreign', 'old-bytes']) {
    const m = memory(), [r, a] = await ready(m);
    await rollout(m.ops, source, r, a); r.status = 'failed';
    if (issue === 'foreign') m.foreign(); else m.versions.get(OLD).resources.script.etag = '0'.repeat(64);
    await assert.rejects(recover(m.ops, r)); assert.equal(r.recovery, 'manual-repair-required');
    assert.ok(!m.calls.includes(`deploy:${OLD}`));
  }
});
test('transport allowlist excludes settings/routes/crons and every foreign Worker mutation', async () => {
  allowedApi(`${SCRIPT}/versions?bindings_inherit=strict`, 'POST'); allowedApi(ROUTES, 'GET');
  for (const [path, method] of [[`${SCRIPT}/settings`, 'PATCH'], [ROUTES, 'POST'], [`${SCRIPT}/schedules`, 'PUT'],
    [SCRIPT.replace('-staging', '-production') + '/deployments', 'POST'], [`${SCRIPT}/versions`, 'POST']]) assert.throws(() => allowedApi(path, method));
  let calls = 0;
  const io = transport('PRIVATE_TOKEN', async (url, init) => {
    calls++; assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    return new Response(JSON.stringify({ success: false, errors: [{ message: 'PRIVATE_TOKEN PRIVATE_RESPONSE' }] }), { status: 403 });
  });
  await assert.rejects(io.api(`${SCRIPT}/settings`), error => !String(error).includes('PRIVATE'));
  await assert.rejects(io.api(`${SCRIPT}/settings`, { method: 'PATCH' })); assert.equal(calls, 1);
  assert.throws(() => io.publicGet('/api/platform/billing/checkout'));
});
test('workflow has default-off gates, no schedule, no credential-bearing install or public receipts', () => {
  const yaml = readFileSync(new URL('../.github/workflows/staging-search-reader.yml', import.meta.url), 'utf8');
  assert.match(yaml, /environment:\s+name: data-staging/);
  assert.match(yaml, /STAGING_SEARCH_READER_ENABLED: \$\{\{ vars\.STAGING_SEARCH_READER_ENABLED \}\}/);
  for (const name of ['ENABLED', 'CATALOG_ID', 'RUN_ID', 'SELECTION_SHA256']) {
    assert.match(yaml, new RegExp(`STAGING_WIND100_READER_${name}: \\$\\{\\{ vars\\.STAGING_WIND100_READER_${name} \\}\\}`));
  }
  assert.ok(!yaml.includes('schedule:') && !yaml.includes('upload-artifact'));
  assert.match(yaml, /cancel-in-progress: false/); assert.match(yaml, /weatherx-staging-publication/);
  assert.match(yaml, /STAGING_WORKER_API_TOKEN: \$\{\{ secrets\.STAGING_WORKER_API_TOKEN \}\}/);
  assert.ok(!yaml.includes('CLOUDFLARE_API_TOKEN') && !yaml.includes('deploy:production'));
});
test('transport bounds response memory and redacts thrown network/timeout errors', async () => {
  const oversized = transport('PRIVATE_TOKEN', async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)));
  await assert.rejects(oversized.api(`${SCRIPT}/settings`), error => error.message === 'bounded staging request failed');
  const timedOut = transport('PRIVATE_TOKEN', async () => { throw new DOMException('PRIVATE_TOKEN', 'TimeoutError'); });
  await assert.rejects(timedOut.api(`${SCRIPT}/settings`), error => !String(error).includes('PRIVATE'));
});
