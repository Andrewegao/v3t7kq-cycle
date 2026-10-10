#!/usr/bin/env node
// Pinned, exact-source production platform Worker release. Code only: never changes routes,
// secrets, crons, data, Pages, Stripe, purchases, or the separate data Worker.
//
//   plan     read-only preflight; records the active version a release must replace
//   release  compare-and-swap: upload one inactive version, verify it, activate, verify live
//   recover  restore only this run's predecessor if this run's candidate is still active
//   routes-before / routes-after  read-only zone route inventory with the dedicated route token
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { activeVersion, assertSettings, expectedBindings, normalizedBindings } from './consumer-refresh.mjs';
import { bindingDrift, uploadedVersion } from './platform-wind100-worker-release.mjs';
import { verifyFeedsEventually } from './platform-production-feed-routes.mjs';

const exec = promisify(execFile);
const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const ZONE = '9dc4df7c3c094ab9a11dd00d378adc26';
export const WORKER = 'weatherx-platform-edge-production';
export const DATA_WORKER = 'weatherx-data-edge-production';
export const POINT_ROUTE = 'weatherx.org/api/v1/point-series/*';
export const REQUIRED_ROUTES = Object.freeze(['weatherx.org/api/platform/health',
  'weatherx.org/api/platform/production-wind100/*']);
const ORIGIN = 'https://weatherx.org';
const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
const WORKFLOW = `${REPOSITORY}/.github/workflows/platform-worker-production-release.yml@refs/heads/main`;
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
const ROUTES_API = `https://api.cloudflare.com/client/v4/zones/${ZONE}/workers/routes`;
const SHA = /^[a-f0-9]{40}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const HEALTH = Object.freeze({ ok: true, authMode: 'observe', billingMode: 'enabled', billingPurchaseMode: 'closed' });
const RELEASE_TAG = /^(?:production|wind100)-([a-f0-9]{12})$/;
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b, message) => assert.equal(JSON.stringify(a), JSON.stringify(b), message);
const wait = ms => new Promise(done => setTimeout(done, ms));

export function confirmation(mode, sha) {
  assert.ok(['plan', 'release'].includes(mode), 'unknown release mode');
  assert.match(sha ?? '', SHA, 'exact 40-character Atmos SHA required');
  return `${mode === 'plan' ? 'PLAN' : 'RELEASE'}-PRODUCTION-PLATFORM-WORKER:${sha}`;
}

export function admit(env) {
  const mode = env.RELEASE_MODE;
  assert.equal(env.CONFIRM, confirmation(mode, env.ATMOS_SHA), 'confirmation does not bind this mode and source');
  if (mode === 'release') assert.match(env.EXPECTED_ACTIVE_VERSION_ID ?? '', UUID,
    'release requires the exact active version reported by a plan run');
  else assert.equal(env.EXPECTED_ACTIVE_VERSION_ID ?? '', '', 'plan does not accept an expected version');
  return { mode, sha: env.ATMOS_SHA, expected: env.EXPECTED_ACTIVE_VERSION_ID || null };
}

export function validateReleaseConfig(config) {
  const production = config?.env?.production;
  assert.equal(config?.main, 'src/index.ts');
  assert.equal(config?.compatibility_date, '2026-08-15');
  assert.deepEqual(config?.compatibility_flags, ['nodejs_compat']);
  assert.equal(production?.name, WORKER);
  assert.equal(production.workers_dev, false);
  assert.equal(production.vars?.APP_ORIGIN, ORIGIN);
  assert.equal(production.vars?.AUTH_MODE, 'observe');
  assert.equal(production.vars?.BILLING_MODE, 'enabled');
  assert.equal(production.vars?.BILLING_PURCHASE_MODE, 'closed');
  assert.equal(production.vars?.PRODUCTION_WIND100_DYNAMIC_ENABLED, '1');
  const patterns = (production.routes ?? []).map(route => route.pattern);
  for (const pattern of REQUIRED_ROUTES) assert.ok(patterns.includes(pattern), `${pattern} not declared`);
  // The more specific point reader route belongs to the data Worker and must never move here.
  assert.ok(!patterns.includes(POINT_ROUTE), 'platform Worker must not declare the data Worker point route');
  assert.ok(!patterns.some(pattern => /\/data(?:-atmos)?\/\*$|data-health|internal\/catalog/.test(pattern)),
    'platform Worker must not declare data Worker routes');
  assert.ok(Array.isArray(config.triggers?.crons) && config.triggers.crons.length > 0, 'reviewed crons missing');
  // Wrangler inherits these top-level runtime settings into every environment.
  return { ...production, compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags, crons: [...config.triggers.crons].sort() };
}

export function validateLiveSelector(value, previous = null) {
  assert.equal(value?.schemaVersion, 1);
  assert.equal(value.kind, 'production-native-wind100-selector');
  assert.match(value.catalogId ?? '', /^prod-wind100-[a-z0-9-]{1,96}$/);
  assert.match(value.runId ?? '', /^\d{10}$/);
  assert.match(value.selectionSha256 ?? '', /^[a-f0-9]{64}$/);
  for (const key of ['initializedAt', 'freshUntil']) assert.ok(Number.isFinite(Date.parse(value[key])), `invalid ${key}`);
  if (previous) {
    // Recurring publication may advance during a release; a Worker release must never regress it.
    assert.ok(Number(value.runId) >= Number(previous.runId), 'Wind100 selector regressed');
    if (value.runId === previous.runId) same(value, previous, 'Wind100 selector changed within one run');
  }
  return value;
}

export function previousSource(version) {
  const tag = version?.annotations?.['workers/tag'];
  return typeof tag === 'string' && RELEASE_TAG.exec(tag)?.[1] || null;
}

export function routeBoundary(routes, config) {
  assert.ok(Array.isArray(routes), 'route inventory missing');
  const rows = routes.map(({ id, pattern, script }) => ({ id, pattern, script: script ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const row of rows) assert.match(row.id ?? '', /^[a-f0-9]{32}$/, 'invalid route identity');
  assert.equal(new Set(rows.map(row => row.pattern)).size, rows.length, 'duplicate route pattern');
  const owned = rows.filter(row => row.script === WORKER).map(row => row.pattern).sort();
  for (const pattern of REQUIRED_ROUTES) assert.ok(owned.includes(pattern), `${pattern} is not attached to the platform Worker`);
  const point = rows.filter(row => row.pattern === POINT_ROUTE);
  assert.equal(point.length, 1, 'point reader route missing');
  assert.equal(point[0].script, DATA_WORKER, 'point reader route left the data Worker');
  const declared = config.routes.map(route => route.pattern).sort();
  return { rows, platform: owned,
    declaredNotAttached: declared.filter(pattern => !owned.includes(pattern)),
    attachedNotDeclared: owned.filter(pattern => !declared.includes(pattern)) };
}

export function settingsOf(version) {
  return { ...version?.resources?.script_runtime, bindings: version?.resources?.bindings ?? [] };
}

// Names and a digest only: the cycle repository and its artifacts are public.
export function bindingSummary(bindings) {
  const normalized = normalizedBindings(bindings);
  return { count: normalized.length, sha256: sha256(normalized) };
}

export function assertCodeOnly(config, active, latest) {
  // A code-only release keeps every binding, secret name, and runtime setting byte-identical.
  for (const [label, settings] of [['active', active], ['latest', latest]]) {
    try { assertSettings(config, settings); }
    catch (error) {
      if (error.message === 'live bindings differ from reviewed configuration') {
        console.error(`${label} binding drift (names/count only): ${JSON.stringify(bindingDrift(config, settings.bindings))}`);
      }
      throw Error(`${label} Worker settings differ from the reviewed production configuration`, { cause: error });
    }
  }
}

export function assertSchedules(config, schedules) {
  same((schedules?.schedules ?? []).map(row => row.cron).sort(), config.crons, 'production cron boundary differs');
}

export function recoveryAction(active, receipt) {
  if (active === receipt.previous) return 'already-restored';
  assert.equal(active, receipt.candidate, 'a different publisher changed the Worker; refuse rollback');
  return 'restore-owned-candidate';
}

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

function context(env, command) {
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: WORKFLOW,
    GITHUB_JOB: 'release', WORKER_RELEASE_ENVIRONMENT: 'production' })) assert.equal(env[key], expected, `${key} changed`);
  const admitted = admit(env);
  assert.ok(!env.UI_PRODUCTION_PAGES_TOKEN && !env.CLOUDFLARE_API_TOKEN, 'unrelated release credentials are forbidden');
  if (command.startsWith('routes-')) {
    assert.ok(env.DATA_EDGE_TOKEN, 'dedicated route token required');
    assert.ok(!env.PLATFORM_EDGE_TOKEN, 'Worker credential is forbidden in the route inventory step');
  } else {
    assert.ok(env.PLATFORM_EDGE_TOKEN, 'dedicated Worker token required');
    assert.ok(!env.DATA_EDGE_TOKEN && !env.CLOUDFLARE_DATA_EDGE_API_TOKEN, 'route credential is forbidden in the Worker step');
  }
  for (const key of ['RELEASE_DIR', 'ATMOS_ROOT']) assert.match(env[key] ?? '', /^\//, `${key} must be absolute`);
  assert.equal(git(env.ATMOS_ROOT, ['rev-parse', 'HEAD']), admitted.sha, 'source checkout changed');
  git(env.ATMOS_ROOT, ['diff', '--exit-code', 'HEAD']);
  git(env.ATMOS_ROOT, ['merge-base', '--is-ancestor', admitted.sha, 'refs/remotes/origin/master']);
  const config = validateReleaseConfig(JSON.parse(readFileSync(resolve(env.ATMOS_ROOT, 'platform/edge/wrangler.jsonc'))));
  return { env, ...admitted, config, cwd: resolve(env.ATMOS_ROOT, 'platform/edge'),
    wrangler: resolve(env.ATMOS_ROOT, 'platform/edge/node_modules/wrangler/bin/wrangler.js') };
}

async function cf(url, token) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}` } });
  // Cloudflare errors can contain account data; report status only.
  assert.equal(response.status, 200, `Cloudflare read returned HTTP ${response.status}`);
  const value = await response.json();
  assert.equal(value?.success, true, 'Cloudflare rejected read');
  return value.result;
}

async function publicJson(path) {
  const response = await fetch(`${ORIGIN}${path}`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200, `${path} returned HTTP ${response.status}`);
  return response.json();
}

async function publicBoundary(previousSelector = null) {
  const [health, selector] = await Promise.all([publicJson('/api/platform/health'),
    publicJson('/api/platform/production-wind100/current')]);
  same(health, HEALTH, 'production platform health contract changed');
  return { health, selector: validateLiveSelector(selector, previousSelector) };
}

async function workerBoundary(ctx) {
  const token = ctx.env.PLATFORM_EDGE_TOKEN;
  const [deployments, latest, schedules] = await Promise.all([cf(`${API}/deployments`, token),
    cf(`${API}/settings`, token), cf(`${API}/schedules`, token)]);
  const active = activeVersion(deployments);
  const version = await cf(`${API}/versions/${active}`, token);
  assert.equal(version.id, active, 'active version readback mismatch');
  return { active, version, latest, schedules };
}

async function runWrangler(ctx, args) {
  try {
    const { stdout } = await exec(process.execPath, [ctx.wrangler, ...args, '--config', 'wrangler.jsonc', '--env', 'production'],
      { cwd: ctx.cwd, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', NO_COLOR: '1',
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: ctx.env.PLATFORM_EDGE_TOKEN } });
    return stdout;
  } catch { throw Error(`Wrangler ${args[0]} ${args[1] ?? ''} failed`.trim()); }
}

// The pinned whole-site verifier never receives a Cloudflare credential.
export function verifierEnvironment(phase, successes, base = process.env) {
  assert.ok(['candidate', 'rollback'].includes(phase));
  return { PATH: base.PATH, HOME: base.HOME, RELEASE_GUARD_PHASE: phase,
    RELEASE_GUARD_VERIFY_REQUIRED_SUCCESSES: String(successes),
    RELEASE_GUARD_VERIFY_SLEEP_SECONDS: successes > 1 ? '15' : '5' };
}

async function siteVerifier(ctx, phase, successes) {
  try {
    await exec('bash', [resolve(ctx.env.ATMOS_ROOT, 'ops/release/verify-platform-production.sh'), ORIGIN],
      { timeout: 20 * 60_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
        env: verifierEnvironment(phase, successes) });
  } catch (error) {
    throw Error(`platform production verifier (${phase}, ${successes}x) failed`, { cause: error });
  }
  return `${phase}:${successes}`;
}

function save(path, receipt) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, { flag: 'a' });
}

async function preflight(ctx) {
  const before = await workerBoundary(ctx);
  assertCodeOnly(ctx.config, settingsOf(before.version), before.latest);
  assertSchedules(ctx.config, before.schedules);
  const source = previousSource(before.version);
  if (source) {
    // Never move production behind the source it already runs.
    const full = git(ctx.env.ATMOS_ROOT, ['rev-parse', '--verify', `${source}^{commit}`]);
    git(ctx.env.ATMOS_ROOT, ['merge-base', '--is-ancestor', full, ctx.sha]);
  }
  const live = await publicBoundary();
  const feeds = await verifyFeedsEventually(fetch, wait, 6);
  const baseline = await siteVerifier(ctx, 'candidate', 1);
  return { before, source, live, feeds, baseline };
}

async function verifyLive(ctx, receipt) {
  let live;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const current = await workerBoundary(ctx);
      assert.equal(current.active, receipt.candidate, 'candidate is not the active Worker');
      assertSettings(ctx.config, settingsOf(current.version));
      assertSchedules(ctx.config, current.schedules);
      live = await publicBoundary(receipt.public.selector);
      break;
    } catch (error) {
      if (attempt === 11) throw Error('candidate did not pass bounded Worker verification', { cause: error });
      await wait(5000);
    }
  }
  const site = await siteVerifier(ctx, 'candidate', 3);
  const feeds = await verifyFeedsEventually();
  const final = await workerBoundary(ctx);
  assert.equal(final.active, receipt.candidate, 'candidate was replaced during verification');
  return { selector: live.selector, site, feeds };
}

async function recover(ctx, receipt) {
  if (!receipt?.previous || !receipt?.candidate) return 'nothing-to-restore';
  const current = await workerBoundary(ctx);
  if (recoveryAction(current.active, receipt) === 'restore-owned-candidate') {
    await runWrangler(ctx, ['rollback', receipt.previous, '--yes', '--message',
      `Restore prior platform Worker after failed release run ${receipt.runId}`]);
    assert.equal((await workerBoundary(ctx)).active, receipt.previous, 'Worker rollback readback failed');
  }
  try { await siteVerifier(ctx, 'rollback', 1); return 'prior-worker-restored-and-verified'; }
  catch { return 'prior-worker-restored-verification-failed'; }
}

async function routes(ctx, command) {
  const path = resolve(ctx.env.RELEASE_DIR, `${command}.json`);
  const boundary = routeBoundary(await cf(ROUTES_API, ctx.env.DATA_EDGE_TOKEN), ctx.config);
  if (command === 'routes-after') {
    const before = JSON.parse(readFileSync(resolve(ctx.env.RELEASE_DIR, 'routes-before.json')));
    same(boundary.rows, before.rows, 'production route boundary changed during the Worker release');
  }
  assert.ok(!existsSync(path), `${command} already recorded`);
  save(path, { schemaVersion: 1, kind: 'weatherx-platform-worker-production-routes', command,
    sourceSha: ctx.sha, controllerSha: ctx.env.GITHUB_SHA, runId: ctx.env.GITHUB_RUN_ID,
    attempt: ctx.env.GITHUB_RUN_ATTEMPT, ...boundary });
  return { status: 'recorded', platformRoutes: boundary.platform.length, declaredNotAttached: boundary.declaredNotAttached,
    attachedNotDeclared: boundary.attachedNotDeclared };
}

export async function main(command, env = process.env) {
  assert.ok(['plan', 'release', 'recover', 'routes-before', 'routes-after'].includes(command), 'unknown command');
  const ctx = context(env, command);
  if (command.startsWith('routes-')) return routes(ctx, command);
  const path = resolve(env.RELEASE_DIR, 'receipt.json');
  if (command === 'recover') {
    assert.equal(ctx.mode, 'release', 'only a release run can recover');
    if (!existsSync(path)) return { status: 'no-receipt' };
    const receipt = JSON.parse(readFileSync(path));
    for (const [key, value] of Object.entries({ sourceSha: ctx.sha, controllerSha: env.GITHUB_SHA,
      runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT })) assert.equal(receipt[key], value, `receipt ${key} changed`);
    let recovery;
    try { recovery = await recover(ctx, receipt); } catch { recovery = 'manual-inspection-required'; }
    save(path, { ...receipt, recovery });
    return { status: recovery };
  }
  assert.equal(command, ctx.mode, 'command does not match the admitted mode');
  assert.ok(!existsSync(path), 'receipt already exists');
  const checked = await preflight(ctx);
  const receipt = { schemaVersion: 1, kind: 'weatherx-platform-worker-production-release', mode: ctx.mode,
    sourceSha: ctx.sha, previousSource: checked.source, controllerSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT, previous: checked.before.active,
    bindings: bindingSummary(settingsOf(checked.before.version).bindings),
    expectedBindingsSha256: sha256(expectedBindings(ctx.config)), crons: ctx.config.crons,
    public: checked.live, baseline: { site: checked.baseline, feeds: checked.feeds }, status: 'preflight-passed' };
  save(path, receipt);
  if (ctx.mode === 'plan') {
    summary(['## Production platform Worker plan', '',
      `- Atmos source: \`${ctx.sha}\` (active version built from \`${checked.source ?? 'untagged'}\`)`,
      `- Active version: \`${checked.before.active}\``,
      `- Release confirmation: \`${confirmation('release', ctx.sha)}\``]);
    return { status: 'planned', expectedActiveVersionId: checked.before.active, previousSource: checked.source };
  }
  assert.equal(checked.before.active, ctx.expected, 'active Worker differs from the planned predecessor');
  try {
    const output = await runWrangler(ctx, ['versions', 'upload', '--keep-vars', '--tag', `production-${ctx.sha.slice(0, 12)}`,
      '--message', `Platform Worker ${ctx.sha.slice(0, 12)} cycle run ${env.GITHUB_RUN_ID}`]);
    receipt.candidate = uploadedVersion(output); receipt.status = 'uploaded'; save(path, receipt);
    const version = await cf(`${API}/versions/${receipt.candidate}`, env.PLATFORM_EDGE_TOKEN);
    assert.equal(version.id, receipt.candidate);
    assertSettings(ctx.config, settingsOf(version));
    const afterUpload = await workerBoundary(ctx);
    assert.equal(afterUpload.active, receipt.previous, 'inactive upload changed the active Worker');
    await runWrangler(ctx, ['versions', 'deploy', `${receipt.candidate}@100%`, '--yes',
      '--message', `Verified platform Worker ${ctx.sha.slice(0, 12)}`]);
    receipt.status = 'activation-requested'; save(path, receipt);
    receipt.proof = await verifyLive(ctx, receipt);
    receipt.status = 'passed'; receipt.completedAt = new Date().toISOString(); save(path, receipt);
    summary(['## Production platform Worker release passed', '',
      `- Atmos source: \`${ctx.sha}\``, `- Previous version: \`${receipt.previous}\``,
      `- Active version: \`${receipt.candidate}\``]);
    return { status: 'passed', previous: receipt.previous, candidate: receipt.candidate, sourceSha: ctx.sha };
  } catch (error) {
    receipt.status = 'failed'; receipt.failure = error.message.slice(0, 300); save(path, receipt);
    try { receipt.recovery = await recover(ctx, receipt); } catch { receipt.recovery = 'manual-inspection-required'; }
    save(path, receipt);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`Production platform Worker ${process.argv[2] ?? ''} refused: ${error.message}${error.cause?.message ? ` (${error.cause.message})` : ''}`);
    process.exitCode = 1;
  });
}
