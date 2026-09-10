import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readerGate, settings, runtime, uploadMetadata, assertVersion, assertBoundary, allowedApi, transport,
  preflight, rollout, recover, digest, annotations, ACCOUNT, WORKER, SCRIPT, ROUTES, EXCLUSIVE } from '../tools/staging-search-reader.mjs';
const OLD = '11111111-1111-1111-1111-111111111111', NEW = '22222222-2222-2222-2222-222222222222', FOREIGN = '33333333-3333-3333-3333-333333333333';
const sha = 'a'.repeat(40), source = { sha, sha256: 'c'.repeat(64), bytes: Buffer.from('source') };
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'reader',
  GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-search-reader.yml@refs/heads/main',
  GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', STAGING_SEARCH_READER_ENABLED: 'true', STAGING_R2_ACCOUNT_ID: ACCOUNT,
  READER_SOURCE_SHA: sha, STAGING_SEARCH_READER_APPROVED_SOURCE_SHA: sha };
function boundary() {
  const vars = { APP_ORIGIN: 'https://staging.weatherx.org', AUTH_MODE: 'public', BILLING_MODE: 'enabled',
    STRIPE_ENVIRONMENT: 'test', AI_AUTH_POLICY: 'staging-account-v1', DATA_SOURCE_MODE: 'shared', DATA_CATALOG_MODE: 'serve',
    EXTRA_REVIEWED_VARIABLE: 'retain exactly' };
  const bindings = [...Object.entries(vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
    { name: 'SECRET', type: 'secret_text' }, { name: 'DATA_BUCKET', type: 'r2_bucket', bucket_name: 'weatherx-data-staging' },
    { name: 'COMPONENT_BUCKET', type: 'r2_bucket', bucket_name: 'weatherx-components-staging' },
    { name: 'PLATFORM_DB', type: 'd1', id: '9501827a-7e4c-4249-806b-d45d5857d9e5' }];
  const rt = { compatibility_date: '2026-08-15', compatibility_flags: ['nodejs_compat'], limits: { cpu_ms: 50 }, usage_model: 'standard' };
  return { settings: settings({ bindings, ...rt, placement: { mode: 'smart' }, cache_options: { enabled: true }, observability: { enabled: true },
    annotations: { 'workers/tag': 'before' }, tags: ['keep'] }), runtime: rt, schedules: { schedules: [{ cron: '17 3 * * *' }] },
    subdomain: { enabled: false, previews_enabled: false }, routes: [{ pattern: 'staging.weatherx.org/data/*', script: WORKER }] };
}
function memory() {
  let active = OLD, state = boundary(), history = [{ id: OLD, number: 8 }];
  const versions = new Map([[OLD, { id: OLD, number: 8, resources: { bindings: state.settings.bindings,
    script_runtime: state.runtime, script: { etag: 'e'.repeat(64) } }, annotations: state.settings.annotations }]]);
  const calls = [], ops = {
    active: async () => active, boundary: async () => structuredClone(state), history: async () => structuredClone(history),
    version: async id => structuredClone(versions.get(id)), pause: async () => {}, probe: async () => { calls.push('probe'); },
    upload: async (bytes, metadata) => {
      calls.push('upload'); assert.ok(Buffer.isBuffer(bytes));
      assert.ok(metadata.bindings.every(b => b.type === 'inherit' && b.version_id === 'latest' && !('text' in b)));
      const v = { id: NEW, number: 9, resources: { bindings: state.settings.bindings, script_runtime: state.runtime,
        script: { etag: 'f'.repeat(64) } }, annotations: metadata.annotations };
      versions.set(NEW, structuredClone(v)); history.unshift({ id: NEW, number: 9 });
      state.settings.annotations = metadata.annotations; return structuredClone(v);
    }, deploy: async id => { calls.push(`deploy:${id}`); active = id; },
  };
  return { ops, calls, versions, mutate: fn => fn({ state, history, versions }), foreign: () => { active = FOREIGN; } };
}
async function ready(m) {
  const r = await preflight(m.ops, source, { run: '123' });
  return [r, { version: r.beforeVersion, digest: r.boundarySha256 }];
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
test('preserves every admitted setting; refuses assets, future fields, unknown bindings and foreign resources', () => {
  const b = boundary();
  same(settings(b.settings), b.settings);
  for (const extra of [{ assets: { jwt: 'DO NOT DROP' } }, { future_setting: true }]) assert.throws(() => settings({ ...b.settings, ...extra }));
  assert.throws(() => settings({ ...b.settings, bindings: [...b.settings.bindings, { name: 'NEW', type: 'future' }] }));
  assert.throws(() => settings({ ...b.settings, bindings: b.settings.bindings.map(b => b.name === 'DATA_BUCKET' ? { ...b, bucket_name: 'weatherx-data-production' } : b) }));
  assert.throws(() => runtime({ ...b.runtime, future: 'unsupported' }));
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
test('stale approval, expired preflight and changed source prevent any upload', async () => {
  for (const issue of ['approval', 'expiry', 'source']) {
    const m = memory(), [r, a] = await ready(m);
    await assert.rejects(rollout(m.ops, issue === 'source' ? { ...source, sha256: 'd'.repeat(64) } : source, r,
      issue === 'approval' ? { ...a, digest: 'b'.repeat(64) } : a, () => {}, issue === 'expiry' ? Date.parse(r.createdAt) + 900001 : Date.now()));
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
test('failed post-activation readiness restores only reviewed previous version', async () => {
  const m = memory(), [r, a] = await ready(m); let probes = 0;
  m.ops.probe = async () => { if (++probes === 1) throw Error('unhealthy'); };
  await assert.rejects(rollout(m.ops, source, r, a));
  assert.equal(r.recovery, 'prior-version-restored');
  assert.deepEqual(m.calls.filter(c => c.startsWith('deploy:')), [`deploy:${NEW}`, `deploy:${OLD}`]);
});
test('lost activation response observes success without second deployment', async () => {
  const m = memory(), [r, a] = await ready(m), deploy = m.ops.deploy;
  m.ops.deploy = async id => { await deploy(id); throw Error('lost response'); };
  await rollout(m.ops, source, r, a); assert.equal(r.status, 'passed');
  assert.equal(m.calls.filter(c => c.startsWith('deploy:')).length, 1);
});
test('lost upload response does not retry or infer ownership', async () => {
  const m = memory(), [r, a] = await ready(m), upload = m.ops.upload;
  m.ops.upload = async (...args) => { await upload(...args); throw Error('lost'); };
  await assert.rejects(rollout(m.ops, source, r, a));
  assert.equal(m.calls.filter(c => c === 'upload').length, 1); assert.ok(!m.calls.some(c => c.startsWith('deploy:')));
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
  assert.match(yaml, /STAGING_SEARCH_READER_ENABLED: \$\{\{ vars\.STAGING_SEARCH_READER_ENABLED \}\}/);
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
