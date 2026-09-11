// Staging code rollout with one optional, exact public Wind100 selector tuple. No routes,
// schedules, secrets, assets or data writes; every unrelated binding is inherited unchanged.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical, saveReceipt } from './gdacs-feed-release.mjs';
import { normalizedBindings, activeVersion } from './consumer-refresh.mjs';
import { normalizeHistory } from './data-reader-refresh.mjs';

export const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
export const WORKER = 'weatherx-platform-edge-staging';
export const SCRIPT = `/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
export const ROUTES = '/zones/9dc4df7c3c094ab9a11dd00d378adc26/workers/routes';
export const ORIGIN = 'https://staging.weatherx.org';
export const EXCLUSIVE = 'EXCLUSIVE-STAGING-WORKER-CODE-ONLY';
export const WIND100_BINDING_NAMES = Object.freeze([
  'STAGING_WIND100_CATALOG_ID', 'STAGING_WIND100_RUN_ID', 'STAGING_WIND100_SELECTION_SHA256',
]);
const WIND100_APPROVAL_NAMES = Object.freeze([
  'STAGING_WIND100_READER_ENABLED', 'STAGING_WIND100_READER_CATALOG_ID',
  'STAGING_WIND100_READER_RUN_ID', 'STAGING_WIND100_READER_SELECTION_SHA256',
]);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const WIND100_CATALOG = /^stage-wind100-[1-9]\d{0,19}-[1-9]\d{0,5}$/;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const digest = value => hash(canonical(value));
const same = (a, b, message) => assert.ok(canonical(a) === canonical(b), message);
const sorted = rows => [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
const validKeys = (value, names, message) => assert.ok(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => names.includes(k)), message);

function validateWind100(value) {
  validKeys(value, ['catalogId', 'runId', 'selectionSha256'], 'invalid staging Wind100 selector');
  assert.ok(Object.keys(value).length === 3, 'incomplete staging Wind100 selector');
  assert.match(value.catalogId ?? '', WIND100_CATALOG, 'invalid staging Wind100 catalog identity');
  assert.match(value.runId ?? '', /^\d{10}$/, 'invalid staging Wind100 run identity');
  const runIso = `${value.runId.slice(0, 4)}-${value.runId.slice(4, 6)}-${value.runId.slice(6, 8)}T${value.runId.slice(8)}:00:00.000Z`;
  const runTime = Date.parse(runIso);
  assert.ok(Number.isFinite(runTime) && new Date(runTime).toISOString() === runIso, 'invalid staging Wind100 run time');
  assert.match(value.selectionSha256 ?? '', HASH, 'invalid staging Wind100 selection digest');
  return JSON.parse(canonical(value));
}

export function wind100Approval(env) {
  for (const key of Object.keys(env)) {
    if (key.startsWith('STAGING_WIND100_READER_')) assert.ok(WIND100_APPROVAL_NAMES.includes(key), 'unknown staging Wind100 approval');
  }
  const enabled = env.STAGING_WIND100_READER_ENABLED ?? '';
  assert.ok(typeof enabled === 'string', 'invalid staging Wind100 approval');
  const values = [env.STAGING_WIND100_READER_CATALOG_ID ?? '', env.STAGING_WIND100_READER_RUN_ID ?? '',
    env.STAGING_WIND100_READER_SELECTION_SHA256 ?? ''];
  if (enabled === '') {
    assert.ok(values.every(value => value === ''), 'staging Wind100 approval must be empty while disabled');
    return null;
  }
  assert.ok(enabled === 'true', 'staging Wind100 reader approval must be exactly true');
  return validateWind100({ catalogId: values[0], runId: values[1], selectionSha256: values[2] });
}

const wind100BindingRows = value => {
  const selected = validateWind100(value);
  return WIND100_BINDING_NAMES.map(name => ({ name, type: 'plain_text', text: {
    STAGING_WIND100_CATALOG_ID: selected.catalogId,
    STAGING_WIND100_RUN_ID: selected.runId,
    STAGING_WIND100_SELECTION_SHA256: selected.selectionSha256,
  }[name] }));
};

function validateLiveWind100(bindings) {
  const rows = bindings.filter(binding => binding.name.startsWith('STAGING_WIND100_'));
  assert.ok(rows.every(binding => WIND100_BINDING_NAMES.includes(binding.name)), 'unknown staging Wind100 binding');
  if (rows.length === 0) return null;
  assert.ok(rows.length === WIND100_BINDING_NAMES.length && rows.every(binding => binding.type === 'plain_text'),
    'staging Wind100 binding tuple is incomplete');
  const values = Object.fromEntries(rows.map(binding => [binding.name, binding.text]));
  return validateWind100({ catalogId: values.STAGING_WIND100_CATALOG_ID, runId: values.STAGING_WIND100_RUN_ID,
    selectionSha256: values.STAGING_WIND100_SELECTION_SHA256 });
}

export function readerGate(env, action) {
  assert.ok(['inspect', 'rollout', 'recover'].includes(action), 'unsupported reader action');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_JOB: 'reader', GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-search-reader.yml@refs/heads/main',
    STAGING_SEARCH_READER_ENABLED: 'true', STAGING_R2_ACCOUNT_ID: ACCOUNT })) assert.ok(env[key] === value, 'reader environment gate refused');
  assert.match(env.READER_SOURCE_SHA ?? '', SHA);
  assert.ok(env.READER_SOURCE_SHA === env.STAGING_SEARCH_READER_APPROVED_SOURCE_SHA, 'source is not approved');
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] ?? '', /^[1-9][0-9]*$/);
  for (const key of Object.keys(env)) if (/^(?:AWS_|RCLONE_|CLOUDFLARE_|CF_API_|R2_ACCESS_|R2_SECRET_|SHARED_R2_|STAGING_R2_WRITE_|SHARED_READ_ACCESS_KEY|SHARED_READ_SECRET_ACCESS|UI_PRODUCTION_|UI_STAGING_.*TOKEN|ATMOS_DEPLOY_KEY|DATA_EDGE_TOKEN|PLATFORM_EDGE_TOKEN|PAGES_TOKEN)/.test(key)) assert.ok(!env[key], 'unrelated credential refused');
  if (action === 'rollout') {
    assert.ok(env.EXCLUSIVE_WINDOW_CONFIRMATION === EXCLUSIVE, 'exclusive staging edit window required');
    assert.match(env.STAGING_SEARCH_READER_APPROVED_VERSION ?? '', UUID);
    assert.match(env.STAGING_SEARCH_READER_APPROVED_BOUNDARY_SHA256 ?? '', HASH);
  }
  return wind100Approval(env);
}

export function settings(value) {
  validKeys(value, ['bindings', 'compatibility_date', 'compatibility_flags', 'usage_model', 'limits', 'placement',
    'cache_options', 'observability', 'logpush', 'tail_consumers', 'tags', 'annotations'], 'unsupported live setting; no upload permitted');
  const result = JSON.parse(canonical({ ...value, bindings: normalizedBindings(value.bindings),
    compatibility_flags: sorted(value.compatibility_flags ?? []) }));
  assert.ok(new Set(result.bindings.map(b => b.name)).size === result.bindings.length, 'duplicate binding');
  validateLiveWind100(result.bindings);
  const vars = Object.fromEntries(result.bindings.filter(b => b.type === 'plain_text').map(b => [b.name, b.text]));
  for (const [name, expected] of Object.entries({ APP_ORIGIN: ORIGIN, AUTH_MODE: 'public', BILLING_MODE: 'enabled',
    STRIPE_ENVIRONMENT: 'test', AI_AUTH_POLICY: 'staging-account-v1', DATA_SOURCE_MODE: 'shared', DATA_CATALOG_MODE: 'serve' })) {
    assert.ok(vars[name] === expected, 'current staging policy differs; separate owner review required');
  }
  same(result.bindings.filter(b => b.type === 'r2_bucket').map(b => b.bucket_name).sort(),
    ['weatherx-components-staging', 'weatherx-data-staging'], 'foreign storage binding');
  assert.ok(result.bindings.filter(b => b.type === 'd1').every(b => b.id === '9501827a-7e4c-4249-806b-d45d5857d9e5'), 'foreign database binding');
  return result;
}
export function runtime(value) {
  validKeys(value, ['compatibility_date', 'compatibility_flags', 'usage_model', 'limits'], 'unsupported runtime; no upload permitted');
  assert.ok(typeof value.compatibility_date === 'string' && Array.isArray(value.compatibility_flags), 'runtime identity missing');
  return JSON.parse(canonical(value));
}
const userAnnotations = value => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => key !== 'workers/triggered_by'));
export function annotations(receipt) {
  return { ...userAnnotations(receipt.before.settings.annotations), 'workers/tag': receipt.tag,
    'workers/commit_sha': receipt.sha, 'workers/message': receipt.wind100
      ? 'Staging search reader and exact Wind100 selector qualification'
      : 'Staging search reader code-only qualification' };
}
export function candidateBindings(receipt) {
  if (!receipt.wind100) return receipt.before.settings.bindings;
  const kept = receipt.before.settings.bindings.filter(binding => !WIND100_BINDING_NAMES.includes(binding.name));
  return normalizedBindings([...kept, ...wind100BindingRows(receipt.wind100)]);
}
export function uploadMetadata(receipt) {
  const before = receipt.before.settings;
  const replacements = new Set(receipt.wind100 ? WIND100_BINDING_NAMES : []);
  const metadata = { main_module: 'stagingReader.mjs', compatibility_date: before.compatibility_date,
    compatibility_flags: before.compatibility_flags,
    bindings: [
      ...before.bindings.filter(binding => !replacements.has(binding.name))
        .map(binding => ({ name: binding.name, type: 'inherit', version_id: 'latest' })),
      ...(receipt.wind100 ? wind100BindingRows(receipt.wind100) : []),
    ], annotations: annotations(receipt) };
  for (const key of ['placement', 'limits', 'cache_options', 'usage_model']) if (Object.hasOwn(before, key)) metadata[key] = before[key];
  if (metadata.placement && Object.keys(metadata.placement).length === 0) delete metadata.placement;
  for (const key of ['limits', 'usage_model']) if (Object.hasOwn(receipt.before.runtime, key)) metadata[key] = receipt.before.runtime[key];
  return metadata;
}
export function assertVersion(version, receipt, owned = true) {
  assert.match(version?.id ?? '', UUID, 'version identity missing');
  validKeys(version.resources, ['bindings', 'script', 'script_runtime'], 'unsupported version resources (including assets); refuse rather than discard');
  same(normalizedBindings(version.resources.bindings), owned ? candidateBindings(receipt) : receipt.before.settings.bindings,
    'version bindings changed');
  same(runtime(version.resources.script_runtime), receipt.before.runtime, 'version runtime changed');
  assert.match(version.resources.script?.etag ?? '', HASH, 'version content identity absent');
  if (owned) {
    same(userAnnotations(version.annotations), annotations(receipt), 'candidate ownership changed');
    assert.ok(version.number === receipt.history[0].number + 1, 'candidate sequence changed');
    if (receipt.uploaded) assert.ok(version.id === receipt.uploaded && version.resources.script.etag === receipt.uploadedEtag, 'candidate content identity changed');
  }
}
export function assertBoundary(current, receipt) {
  const observed = structuredClone(current);
  if (observed.settings.annotations?.['workers/tag'] === receipt.tag) {
    same(userAnnotations(observed.settings.annotations), annotations(receipt), 'owned annotation drift');
    if (receipt.wind100) {
      same(observed.settings.bindings, candidateBindings(receipt), 'owned Wind100 binding drift');
      observed.settings.bindings = receipt.before.settings.bindings;
    }
    if (Object.hasOwn(receipt.before.settings, 'annotations')) observed.settings.annotations = receipt.before.settings.annotations;
    else delete observed.settings.annotations;
  }
  same(observed, receipt.before, 'protected staging boundary changed');
}
export function assertHistory(rows, receipt) {
  const expected = receipt.uploaded ? [{ id: receipt.uploaded, number: receipt.history[0].number + 1 }, ...receipt.history].slice(0, 10) : receipt.history;
  same(rows, expected, 'foreign or missing Worker version history');
}
async function guard(ops, receipt, active) {
  assertBoundary(await ops.boundary(), receipt);
  assertHistory(await ops.history(), receipt);
  assert.ok(await ops.active() === active, 'foreign deployment active');
  if (receipt.uploaded) assertVersion(await ops.version(receipt.uploaded), receipt);
}
export async function preflight(ops, source, identity, now = Date.now(), wind100 = null) {
  const beforeVersion = await ops.active(), history = await ops.history(), before = await ops.boundary();
  assert.ok(history[0].id === beforeVersion, 'latest version is not active; secret inheritance unsafe');
  const receipt = { schemaVersion: 1, worker: WORKER, sha: source.sha, bundleSha256: source.sha256,
    identity, beforeVersion, history, before, createdAt: new Date(now).toISOString(), tag: `wx-search-${randomUUID()}`, status: 'preflight-passed' };
  if (wind100) receipt.wind100 = validateWind100(wind100);
  assertVersion(await ops.version(beforeVersion), receipt, false);
  await ops.probe(); await guard(ops, receipt, beforeVersion);
  receipt.boundarySha256 = digest({ beforeVersion, before });
  return receipt;
}
export async function recover(ops, receipt, persist = () => {}) {
  if (receipt.status === 'passed' || !receipt.activationIntent) return;
  ops.resetRecovery?.();
  try {
    assertHistory(await ops.history(), receipt); assertBoundary(await ops.boundary(), receipt);
    const active = await ops.active();
    if (active === receipt.beforeVersion) { receipt.recovery = 'prior-version-still-active'; persist(); return; }
    assert.ok(active === receipt.uploaded, 'foreign deployment; recovery refused');
    assertVersion(await ops.version(receipt.uploaded), receipt);
    const old = await ops.version(receipt.beforeVersion); assertVersion(old, receipt, false);
    assert.ok(old.resources.script.etag === receipt.beforeEtag, 'rollback bytes changed');
    await guard(ops, receipt, active);
    try { await ops.deploy(receipt.beforeVersion); } catch { /* Observe response-loss; never blindly retry. */ }
    await guard(ops, receipt, receipt.beforeVersion); await ops.probe();
    receipt.recovery = 'prior-version-restored'; persist();
  } catch { receipt.recovery = 'manual-repair-required'; persist(); throw Error('staging reader recovery refused; concurrent state preserved'); }
}
export async function rollout(ops, source, receipt, approved, persist = () => {}, now = Date.now()) {
  assert.ok(receipt.status === 'preflight-passed' && now >= Date.parse(receipt.createdAt) && now - Date.parse(receipt.createdAt) < 15 * 60_000, 'preflight expired');
  assert.ok(receipt.sha === source.sha && receipt.bundleSha256 === source.sha256, 'source changed after preflight');
  assert.ok(receipt.beforeVersion === approved.version && receipt.boundarySha256 === approved.digest, 'live boundary not approved');
  same(receipt.wind100 ?? null, approved.wind100 ?? null, 'staging Wind100 operator intent changed');
  assert.ok(receipt.boundarySha256 === digest({ beforeVersion: receipt.beforeVersion, before: receipt.before }), 'receipt boundary changed');
  try {
    await guard(ops, receipt, receipt.beforeVersion);
    receipt.beforeEtag = (await ops.version(receipt.beforeVersion)).resources.script.etag;
    receipt.uploadIntent = true; persist();
    const uploaded = await ops.upload(source.bytes, uploadMetadata(receipt));
    assertVersion(uploaded, receipt);
    receipt.uploaded = uploaded.id; receipt.uploadedEtag = uploaded.resources.script.etag; persist();
    await guard(ops, receipt, receipt.beforeVersion);
    receipt.activationIntent = true; persist();
    try { await ops.deploy(receipt.uploaded); } catch { /* Inspect actual active version below. */ }
    for (let round = 0; round < 3; round++) {
      if (round) await ops.pause(2000);
      await guard(ops, receipt, receipt.uploaded); await ops.probe(); await guard(ops, receipt, receipt.uploaded);
    }
    receipt.status = 'passed'; persist(); return receipt;
  } catch {
    receipt.status = 'failed'; persist(); await recover(ops, receipt, persist);
    throw Error('staging reader rollout refused; inspect safe receipt status');
  }
}

export function allowedApi(path, method) {
  const reads = [`${SCRIPT}/settings`, `${SCRIPT}/schedules`, `${SCRIPT}/subdomain`, `${SCRIPT}/deployments`, `${SCRIPT}/versions?page=1&per_page=10`, ROUTES];
  assert.ok(method === 'GET' ? reads.includes(path) || new RegExp(`^${SCRIPT}/versions/[a-f0-9-]{36}$`).test(path) :
    method === 'POST' && [ `${SCRIPT}/versions?bindings_inherit=strict`, `${SCRIPT}/deployments` ].includes(path), 'API target/method outside staging code-only allowlist');
}
export function assertStagingRoutes(routes) {
  const owned = routes.filter(route => route.script === WORKER);
  assert.ok(owned.length > 0 && owned.every(route => route.pattern.startsWith('staging.weatherx.org/')), 'foreign route binding');
}
export function transport(token, fetchImpl = fetch) {
  assert.ok(typeof token === 'string' && token.length > 0, 'staging Worker credential missing');
  let deadline = Date.now() + 8 * 60_000;
  async function request(url, init = {}) {
    try {
      assert.ok(deadline > Date.now(), 'deadline');
      const response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(Math.min(20_000, deadline - Date.now())) });
      const chunks = []; let size = 0;
      try { for await (const chunk of response.body ?? []) { size += chunk.length; assert.ok(size <= 2 * 1024 * 1024); chunks.push(Buffer.from(chunk)); } }
      finally { await response.body?.cancel().catch(() => {}); }
      return { status: response.status, body: Buffer.concat(chunks), headers: response.headers };
    } catch { throw Error('bounded staging request failed'); }
  }
  return {
    resetRecovery: () => { deadline = Date.now() + 5 * 60_000; },
    async api(path, { method = 'GET', body } = {}) {
      allowedApi(path, method);
      const headers = { Authorization: `Bearer ${token}` };
      if (body && !(body instanceof FormData)) { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
      const result = await request(`https://api.cloudflare.com/client/v4${path}`, { method, body, headers });
      try { const value = JSON.parse(result.body); assert.ok(result.status === 200 && value.success === true); return value.result; }
      catch { throw Error('staging API refused; response body redacted'); }
    },
    publicGet(path) {
      assert.ok(['/api/platform/health', '/api/platform/data-health', '/api/platform/auth/me', '/data/ecmwf/index.json'].includes(path), 'public probe path refused');
      return request(ORIGIN + path, { headers: { Origin: ORIGIN } });
    },
  };
}
export function operations(io) {
  const version = id => { assert.match(id, UUID); return io.api(`${SCRIPT}/versions/${id}`); };
  const active = async () => activeVersion(await io.api(`${SCRIPT}/deployments`));
  return { version, active, resetRecovery: () => io.resetRecovery?.(), history: async () => normalizeHistory(await io.api(`${SCRIPT}/versions?page=1&per_page=10`)),
    async boundary() {
      const [raw, schedules, subdomain, routes] = await Promise.all(['/settings', '/schedules', '/subdomain'].map(p => io.api(SCRIPT + p)).concat(io.api(ROUTES)));
      const configured = settings(raw), detail = await version(await active());
      validKeys(detail.resources, ['bindings', 'script', 'script_runtime'], 'assets or unknown resources require separate reviewed preservation');
      assert.ok(subdomain.enabled === false && subdomain.previews_enabled === false, 'development URL policy differs');
      assertStagingRoutes(routes);
      return { settings: configured, runtime: runtime(detail.resources.script_runtime), schedules, subdomain, routes: sorted(routes) };
    },
    async upload(bytes, metadata) {
      const body = new FormData(); body.set('metadata', JSON.stringify(metadata));
      body.set('stagingReader.mjs', new Blob([bytes], { type: 'application/javascript+module' }), 'stagingReader.mjs');
      return io.api(`${SCRIPT}/versions?bindings_inherit=strict`, { method: 'POST', body });
    },
    deploy: id => { assert.match(id, UUID); return io.api(`${SCRIPT}/deployments`, { method: 'POST', body: { strategy: 'percentage', versions: [{ version_id: id, percentage: 100 }] } }); },
    async probe() {
      const read = async path => { const r = await io.publicGet(path); assert.ok(r.status === 200, 'readiness status failed'); return JSON.parse(r.body); };
      const health = await read('/api/platform/health');
      assert.ok(health.ok === true && health.authMode === 'public' && health.billingMode === 'enabled', 'platform modes changed');
      const data = await read('/api/platform/data-health');
      assert.ok(data.ok === true && data.dataSource === 'shared' && data.sharedReadConfigured === true && data.catalogMode === 'serve' && data.catalog?.status === 'available', 'weather reader unavailable');
      const me = await read('/api/platform/auth/me');
      assert.ok(me.authenticated === false && me.user === null && me.billingMode === 'enabled', 'anonymous account policy changed');
      const weather = await read('/data/ecmwf/index.json'); assert.ok(weather && typeof weather === 'object' && Object.keys(weather).length > 0, 'weather index missing');
    }, pause: ms => new Promise(done => setTimeout(done, ms)),
  };
}
export async function buildSource(atmos, sha) {
  assert.match(sha, SHA);
  const git = args => execFileSync('git', args, { cwd: atmos, encoding: 'utf8', timeout: 30_000 });
  assert.ok(git(['rev-parse', 'HEAD']).trim() === sha, 'source HEAD differs');
  const clean = () => assert.ok(!git(['status', '--porcelain=v1', '--untracked-files=all', '--', 'platform/edge', 'app/functions']).trim(), 'source must be clean and committed');
  clean();
  const tree = git(['ls-tree', '-r', 'HEAD']).trim().split('\n');
  const files = new Set(tree.filter(row => /^100(?:644|755) blob [a-f0-9]{40}\t/.test(row)).map(row => row.split('\t')[1]));
  assert.ok(tree.filter(row => /\t(?:platform\/edge|app\/functions)\//.test(row)).every(row => /^100(?:644|755) blob [a-f0-9]{40}\t/.test(row)), 'source symlink or submodule refused');
  const config = JSON.parse(readFileSync(resolve(atmos, 'platform/edge/wrangler.jsonc')));
  assert.ok(config.main === 'src/index.ts' && config.env?.staging?.name === WORKER, 'wrong source target');
  assert.ok(!config.assets && !config.env.staging.assets, 'assets need a separate preservation design');
  const esbuild = await import(pathToFileURL(resolve(atmos, 'platform/edge/node_modules/esbuild/lib/main.js')));
  const lock = JSON.parse(readFileSync(resolve(atmos, 'platform/edge/package-lock.json')));
  assert.ok(esbuild.version === lock.packages['node_modules/esbuild'].version, 'build tool differs from lock');
  const out = await esbuild.build({ absWorkingDir: resolve(atmos, 'platform/edge'), entryPoints: ['src/index.ts'], bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], write: false, metafile: true, tsconfigRaw: {} });
  assert.ok(out.outputFiles.length === 1 && out.outputFiles[0].contents.length < 3 * 1024 * 1024, 'bundle shape/budget differs');
  for (const input of Object.keys(out.metafile.inputs)) {
    const path = relative(atmos, resolve(atmos, 'platform/edge', input));
    assert.ok(!path.startsWith('../') && files.has(path), 'uncommitted or dependency source in bundle');
  }
  const output = Object.values(out.metafile.outputs)[0];
  same(output.exports.sort(), ['StagingAiAdmission', 'default'], 'account AI entrypoint must survive');
  assert.ok(output.imports.every(i => i.external && i.path === 'cloudflare:workers'), 'unsupported external import');
  clean(); const bytes = Buffer.from(out.outputFiles[0].contents);
  return { sha, bytes, sha256: hash(bytes) };
}
async function main() {
  const action = process.env.READER_ACTION;
  const wind100 = readerGate(process.env, action);
  if (process.argv[2] === 'gate') return;
  const file = resolve(process.env.RUNNER_TEMP, 'staging-search-reader', 'receipt.json');
  const identity = { controller: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT };
  const ops = operations(transport(process.env.STAGING_WORKER_API_TOKEN));
  if (action === 'recover') {
    const receipt = JSON.parse(readFileSync(file)); same(receipt.identity, identity, 'receipt belongs to another run');
    assert.ok(receipt.worker === WORKER && receipt.sha === process.env.READER_SOURCE_SHA &&
      receipt.boundarySha256 === digest({ beforeVersion: receipt.beforeVersion, before: receipt.before }), 'recovery receipt identity differs');
    same(receipt.wind100 ?? null, wind100, 'recovery Wind100 operator intent changed');
    await recover(ops, receipt, () => saveReceipt(file, receipt)); return;
  }
  const source = await buildSource(resolve(process.env.GITHUB_WORKSPACE, 'control'), process.env.READER_SOURCE_SHA);
  const receipt = await preflight(ops, source, identity, Date.now(), wind100);
  saveReceipt(file, receipt);
  console.log(JSON.stringify({ worker: WORKER, sourceSha: source.sha, bundleSha256: source.sha256,
    version: receipt.beforeVersion, boundarySha256: receipt.boundarySha256, bindingNames: receipt.before.settings.bindings.map(b => b.name), deployed: false }));
  if (action === 'rollout') {
    await rollout(ops, source, receipt, { version: process.env.STAGING_SEARCH_READER_APPROVED_VERSION,
      digest: process.env.STAGING_SEARCH_READER_APPROVED_BOUNDARY_SHA256, ...(wind100 ? { wind100 } : {}) },
    () => saveReceipt(file, receipt));
    console.log(JSON.stringify({ worker: WORKER, status: receipt.status, version: receipt.uploaded }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => {
  console.error('staging search reader refused; no provider response, binding values or credentials are logged'); process.exitCode = 1;
});
