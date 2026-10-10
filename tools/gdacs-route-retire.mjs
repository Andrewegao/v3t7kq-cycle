#!/usr/bin/env node
// Guarded, reversible retirement of the four production routes still held by the 2026-08-31
// GDACS repair Worker (delivery audit F4, 2026-10-10). Route-only: detaching them lets the
// platform Worker's declared `weatherx.org/api/gdacs/*` and `weatherx.org/api/tc/*` routes
// answer those paths, as they already do on staging. The repair Worker itself is never changed
// or deleted here; deleting it is a separate owner step after a week of clean service.
//
//   versions-before / versions-after  Worker token, read-only: both Workers' active versions,
//                                     the repair Worker's crons and bindings
//   plan                              route token, read-only: the exact route IDs to detach and
//                                     the platform route each path falls through to
//   live-before / live-after          no credential: public provenance and feed contracts
//   detach                            route token: DELETE only the four pinned route IDs
//   routes-after                      route token, read-only: the boundary is the plan minus four
//   restore                           route token: re-attach the same patterns to the same script
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeVersion } from './consumer-refresh.mjs';
import { foreignOverlaps, patternsOverlap, previousSource, settingsOf, validateReleaseConfig,
  WORKER as PLATFORM_WORKER } from './platform-worker-production-release.mjs';
import { verifyFeedsEventually } from './platform-production-feed-routes.mjs';

export { PLATFORM_WORKER };
export const REPAIR_WORKER = 'weatherx-gdacs-feed-production';
const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const ZONE = '9dc4df7c3c094ab9a11dd00d378adc26';
const ORIGIN = 'https://weatherx.org';
const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
const WORKFLOW = `${REPOSITORY}/.github/workflows/gdacs-route-retire.yml@refs/heads/main`;
const SCRIPTS_API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts`;
const ROUTES_API = `https://api.cloudflare.com/client/v4/zones/${ZONE}/workers/routes`;
const SHA = /^[a-f0-9]{40}$/;
const ROUTE_ID = /^[a-f0-9]{32}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const FEED_MARKER = 'weather-feeds-v2';
export const GDACS_KINDS = Object.freeze(['DR', 'EQ', 'FL', 'VO', 'WF']);

// Pinned from the 2026-08-31 bootstrap receipt (gdacs-list, gdacs-geom, tc-geom) and the
// 2026-09-03 maintenance receipt (tc-list), and matched in platform plan run 38025285361.
export const RETIRE = Object.freeze([
  Object.freeze({ key: 'gdacs-list', id: '09f9904da861456e8aa137519ab67c77', pattern: 'weatherx.org/api/gdacs/list*',
    fallthrough: 'weatherx.org/api/gdacs/*', probes: Object.freeze(['/api/gdacs/list', '/api/gdacs/list?guard=query']) }),
  Object.freeze({ key: 'gdacs-geom', id: '704e2f1ea00a45829008b303ae75894c', pattern: 'weatherx.org/api/gdacs/geom*',
    fallthrough: 'weatherx.org/api/gdacs/*', probes: Object.freeze(['/api/gdacs/geom']) }),
  Object.freeze({ key: 'tc-list', id: 'e5aaf75591dc428b910ba443dc76d110', pattern: 'weatherx.org/api/tc/list*',
    fallthrough: 'weatherx.org/api/tc/*', probes: Object.freeze(['/api/tc/list']) }),
  Object.freeze({ key: 'tc-geom', id: '568f224b50a3416eaee92c7a1ac14cfc', pattern: 'weatherx.org/api/tc/geom*',
    fallthrough: 'weatherx.org/api/tc/*', probes: Object.freeze(['/api/tc/geom']) }),
]);
export const PROBES = Object.freeze(RETIRE.flatMap(entry => entry.probes));
const RETIRED_PATHS = new Set(PROBES.map(path => path.split('?')[0]));

const same = (a, b, message) => assert.equal(JSON.stringify(a), JSON.stringify(b), message);
const wait = ms => new Promise(done => setTimeout(done, ms));

export function confirmation(mode, platformVersion) {
  if (mode === 'plan') return 'PLAN-GDACS-ROUTE-RETIREMENT';
  assert.equal(mode, 'retire', 'unknown retirement mode');
  assert.match(platformVersion ?? '', UUID, 'retire binds the planned platform Worker version');
  return `RETIRE-GDACS-FEED-ROUTES:${platformVersion}`;
}

export function admit(env) {
  const mode = env.RETIRE_MODE;
  assert.match(env.ATMOS_SHA ?? '', SHA, 'exact 40-character Atmos SHA required');
  if (mode === 'retire') {
    for (const key of ['EXPECTED_PLATFORM_VERSION', 'EXPECTED_REPAIR_VERSION'])
      assert.match(env[key] ?? '', UUID, `retire requires ${key} from a plan run`);
  } else {
    assert.equal(mode, 'plan', 'unknown retirement mode');
    assert.equal(`${env.EXPECTED_PLATFORM_VERSION ?? ''}${env.EXPECTED_REPAIR_VERSION ?? ''}`, '',
      'plan does not accept expected versions');
  }
  assert.equal(env.CONFIRM, confirmation(mode, env.EXPECTED_PLATFORM_VERSION), 'confirmation does not bind this mode');
  return { mode, sha: env.ATMOS_SHA, platformVersion: env.EXPECTED_PLATFORM_VERSION || null,
    repairVersion: env.EXPECTED_REPAIR_VERSION || null };
}

export function routeRows(routes) {
  assert.ok(Array.isArray(routes), 'route inventory missing');
  const rows = routes.map(({ id, pattern, script }) => ({ id, pattern, script: script ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const row of rows) assert.match(row.id ?? '', ROUTE_ID, 'invalid route identity');
  assert.equal(new Set(rows.map(row => row.pattern)).size, rows.length, 'duplicate route pattern');
  return rows;
}

export function routeMatches(pattern, path) {
  return patternsOverlap(pattern, `weatherx.org${path}`) && !`weatherx.org${path}`.includes('*');
}

// Cloudflare serves the most specific matching pattern. Refuse to guess between equals.
export function servingRoute(rows, path) {
  const literal = row => row.pattern.replace(/^https?:\/\//i, '').replaceAll('*', '').length;
  const matches = rows.filter(row => routeMatches(row.pattern, path)).sort((a, b) => literal(b) - literal(a));
  assert.ok(matches.length, `no route serves ${path}`);
  assert.ok(matches.length === 1 || literal(matches[0]) > literal(matches[1]), `ambiguous route for ${path}`);
  return matches[0];
}

export function retirementPlan(routes, declared) {
  const rows = routeRows(routes);
  const ids = new Set(RETIRE.map(entry => entry.id));
  for (const entry of RETIRE) {
    const row = rows.find(item => item.id === entry.id);
    assert.ok(row, `${entry.key} route ${entry.id} is not attached; nothing to retire or a foreign change`);
    same(row, { id: entry.id, pattern: entry.pattern, script: REPAIR_WORKER }, `${entry.key} route identity changed`);
  }
  same(rows.filter(row => row.script === REPAIR_WORKER).map(row => row.id).sort(), [...ids].sort(),
    'repair Worker owns an unreviewed route');
  // The flag the platform release now raises must name exactly these four, nothing else.
  same(foreignOverlaps(rows, declared).map(row => row.id).sort(), [...ids].sort(),
    'another foreign route overlaps the platform Worker; review it first');
  const remaining = rows.filter(row => !ids.has(row.id));
  const detach = [], fallthrough = [], probes = [];
  for (const entry of RETIRE) {
    assert.ok(declared.includes(entry.fallthrough), `${entry.fallthrough} is not declared by the platform Worker source`);
    const owner = remaining.find(row => row.pattern === entry.fallthrough);
    assert.ok(owner && owner.script === PLATFORM_WORKER, `${entry.fallthrough} is not attached to the platform Worker`);
    detach.push({ key: entry.key, id: entry.id, pattern: entry.pattern, script: REPAIR_WORKER });
    if (!fallthrough.some(row => row.id === owner.id)) fallthrough.push(owner);
    for (const path of entry.probes) {
      same(servingRoute(rows, path), rows.find(row => row.id === entry.id), `${path} is not served by the repair route`);
      same(servingRoute(remaining, path), owner, `${path} would not fall through to ${entry.fallthrough}`);
      probes.push({ path, before: { id: entry.id, script: REPAIR_WORKER }, after: { id: owner.id, script: owner.script } });
    }
  }
  return { rows, detach, fallthrough, probes, remaining };
}

export function assertBoundary(current, plan, detached) {
  const gone = new Set(detached);
  same(routeRows(current), plan.rows.filter(row => !gone.has(row.id)), 'production route boundary drifted');
}

// Restore re-attaches exactly the detached patterns to the repair Worker. Foreign owners of a
// detached pattern are never replaced: that is a manual inspection, not a rollback.
export function restoreActions(current, receipt) {
  const rows = routeRows(current);
  return [...receipt.detached].reverse().map(entry => {
    const row = rows.find(item => item.pattern === entry.pattern);
    if (!row) return { ...entry, action: 'reattach' };
    assert.equal(row.script, REPAIR_WORKER, `${entry.pattern} now belongs to ${row.script}; refuse to replace it`);
    return { ...entry, action: 'present', currentId: row.id };
  });
}

export function assertRestored(current, plan, restored) {
  const rows = routeRows(current);
  const byPattern = new Map(restored.map(entry => [entry.pattern, entry]));
  const expected = plan.rows.map(row => byPattern.has(row.pattern) ? { ...row, id: byPattern.get(row.pattern).currentId } : row)
    .sort((a, b) => a.id.localeCompare(b.id));
  same(rows, expected, 'restored route boundary differs from the plan');
}

export function versionFacts(platform, repair) {
  const platformBindings = settingsOf(platform.version).bindings;
  assert.ok(!platformBindings.some(binding => binding.type === 'service' && binding.service === REPAIR_WORKER),
    'the platform Worker binds the repair Worker; retirement would break it');
  const crons = (repair.schedules?.schedules ?? []).map(row => row.cron);
  const bindings = repair.settings?.bindings ?? [];
  // A Worker with no bindings cannot write R2/KV/D1 and with no crons does nothing unrequested.
  assert.equal(crons.length, 0, 'the repair Worker has crons; review that dependency first');
  assert.equal(bindings.length, 0, 'the repair Worker has bindings; review that dependency first');
  return { platform: { name: PLATFORM_WORKER, active: platform.active, source: previousSource(platform.version) },
    repair: { name: REPAIR_WORKER, active: repair.active, crons: crons.length, bindings: bindings.length,
      tailConsumers: (repair.settings?.tail_consumers ?? []).length } };
}

export function provenance(headers) {
  const marker = headers.get('x-weatherx-feed') === FEED_MARKER;
  const request = headers.has('x-request-id');
  return marker && !request ? 'repair' : request && !marker ? 'platform' : 'unknown';
}

// The platform Worker crawls GDACS SEARCH for the five non-cyclone kinds; the repair Worker's
// frozen EVENTS4APP list also carries TC rows. A TC row on /api/gdacs/list is the old bundle.
export function gdacsListFacts(status, headers, body, expected) {
  assert.equal(status, 200, `/api/gdacs/list returned HTTP ${status}`);
  assert.equal(provenance(headers), expected, `/api/gdacs/list is not served by the ${expected} Worker`);
  const age = headers.get('x-swr-age');
  assert.match(age ?? '', /^\d+$/, '/api/gdacs/list has no feed age');
  assert.ok(Number(age) < 86_400, '/api/gdacs/list is older than a day');
  assert.equal(body?.type, 'FeatureCollection');
  assert.ok(Array.isArray(body.features), '/api/gdacs/list has no features');
  const kinds = {};
  for (const feature of body.features) {
    const kind = String(feature?.properties?.eventtype ?? 'unknown');
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  if (expected === 'platform') for (const kind of Object.keys(kinds))
    assert.ok(GDACS_KINDS.includes(kind), `/api/gdacs/list carries ${kind} rows from the retired bundle`);
  return { count: body.features.length, ageSeconds: Number(age),
    kinds: Object.fromEntries(Object.entries(kinds).sort()) };
}

async function get(fetchImpl, path, timeout = 40_000) {
  const response = await fetchImpl(`${ORIGIN}${path}`, { redirect: 'manual', cache: 'no-store',
    signal: AbortSignal.timeout(timeout) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text };
}

export async function probeOwners(fetchImpl = fetch) {
  const owners = {};
  for (const path of PROBES) owners[path] = provenance((await get(fetchImpl, path, 25_000)).headers);
  return owners;
}

// One complete public round. `expected` is who must answer the four retired paths.
export async function liveRound(expected, { fetchImpl = fetch, verifyWeatherFeeds, sleep = wait } = {}) {
  const owners = await probeOwners(fetchImpl);
  for (const [path, owner] of Object.entries(owners)) assert.equal(owner, expected, `${path} answered by ${owner}`);
  const lists = {};
  for (const path of RETIRE[0].probes) {
    const response = await get(fetchImpl, path);
    assert.equal(response.status, 200, `${path} returned HTTP ${response.status}`);
    lists[path] = gdacsListFacts(response.status, response.headers, JSON.parse(response.text), expected);
  }
  const cyclones = await get(fetchImpl, '/api/tc/list', 55_000);
  assert.equal(cyclones.status, 200, '/api/tc/list failed');
  assert.equal(provenance(cyclones.headers), expected, '/api/tc/list provenance changed');
  const tc = JSON.parse(cyclones.text);
  assert.ok(tc?.type === 'FeatureCollection' && Array.isArray(tc.features), '/api/tc/list contract failed');
  // The unchanged Atmos release verifier, with every retired path held to the same owner.
  const original = globalThis.fetch;
  let feeds;
  try {
    globalThis.fetch = async (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, ORIGIN, 'verifier escaped the production origin');
      const response = await fetchImpl(url, init);
      if (RETIRED_PATHS.has(parsed.pathname))
        assert.equal(provenance(response.headers), expected, `${parsed.pathname} provenance changed mid-verification`);
      return response;
    };
    feeds = await verifyWeatherFeeds(ORIGIN);
  } finally { globalThis.fetch = original; }
  const platform = await verifyFeedsEventually(fetchImpl, sleep, 3);
  return { owners, gdacsList: lists, tcList: { count: tc.features.length, ageSeconds: Number(cyclones.headers.get('x-swr-age')) },
    feeds, platform };
}

// After detach: wait (bounded) for the route change to reach the edge, then require three
// consecutive complete platform rounds, fifteen seconds apart.
export async function verifyAfter({ fetchImpl = fetch, verifyWeatherFeeds, sleep = wait, propagation = 36 } = {}) {
  let owners;
  for (let attempt = 1; ; attempt++) {
    owners = await probeOwners(fetchImpl).catch(() => ({}));
    if (PROBES.every(path => owners[path] === 'platform')) break;
    assert.ok(attempt < propagation, `retired paths still not served by the platform Worker: ${JSON.stringify(owners)}`);
    await sleep(5_000);
  }
  const rounds = [];
  for (let round = 1; round <= 3; round++) {
    if (round > 1) await sleep(15_000);
    rounds.push({ round, at: new Date().toISOString(), ...await liveRound('platform', { fetchImpl, verifyWeatherFeeds, sleep }) });
  }
  return { propagationOwners: owners, rounds };
}

export async function verifyRestored({ fetchImpl = fetch, sleep = wait, attempts = 36 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const owners = await probeOwners(fetchImpl).catch(() => ({}));
    if (PROBES.every(path => owners[path] === 'repair')) return owners;
    if (attempt >= attempts) throw Error(`restored routes not yet serving the repair Worker: ${JSON.stringify(owners)}`);
    await sleep(5_000);
  }
}

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

const COMMANDS = Object.freeze({
  'versions-before': 'worker', 'versions-after': 'worker', plan: 'routes', 'routes-after': 'routes',
  detach: 'routes', restore: 'routes', 'live-before': 'public', 'live-after': 'public',
});

export function credentialBoundary(command, env) {
  const kind = COMMANDS[command];
  assert.ok(kind, 'unknown command');
  assert.ok(!env.UI_PRODUCTION_PAGES_TOKEN && !env.CLOUDFLARE_API_TOKEN && !env.CLOUDFLARE_DATA_EDGE_API_TOKEN,
    'unrelated release credentials are forbidden');
  if (kind === 'worker') {
    assert.ok(env.PLATFORM_EDGE_TOKEN, 'Worker read token required');
    assert.ok(!env.DATA_EDGE_TOKEN, 'route credential is forbidden in a Worker step');
  } else if (kind === 'routes') {
    assert.ok(env.DATA_EDGE_TOKEN, 'dedicated route token required');
    assert.ok(!env.PLATFORM_EDGE_TOKEN, 'Worker credential is forbidden in a route step');
  } else assert.ok(!env.DATA_EDGE_TOKEN && !env.PLATFORM_EDGE_TOKEN, 'public verification holds no Cloudflare credential');
  return kind;
}

function context(env, command) {
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: WORKFLOW,
    GITHUB_JOB: 'retire', RETIRE_ENVIRONMENT: 'production' })) assert.equal(env[key], expected, `${key} changed`);
  const admitted = admit(env);
  const kind = credentialBoundary(command, env);
  if (['detach', 'live-after', 'routes-after', 'restore', 'versions-after'].includes(command))
    assert.equal(admitted.mode, 'retire', `${command} runs only in retire mode`);
  for (const key of ['RETIRE_DIR', 'ATMOS_ROOT']) assert.match(env[key] ?? '', /^\//, `${key} must be absolute`);
  assert.equal(git(env.ATMOS_ROOT, ['rev-parse', 'HEAD']), admitted.sha, 'source checkout changed');
  git(env.ATMOS_ROOT, ['diff', '--exit-code', 'HEAD']);
  git(env.ATMOS_ROOT, ['merge-base', '--is-ancestor', admitted.sha, 'refs/remotes/origin/master']);
  const config = validateReleaseConfig(JSON.parse(readFileSync(resolve(env.ATMOS_ROOT, 'platform/edge/wrangler.jsonc'))));
  return { env, kind, ...admitted, declared: config.routes.map(route => route.pattern).sort() };
}

async function cf(url, token, method = 'GET', body) {
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  // Cloudflare errors can contain account data; report status only.
  assert.ok(response.ok, `Cloudflare ${method} returned HTTP ${response.status}`);
  const value = await response.json();
  assert.equal(value?.success, true, `Cloudflare rejected ${method}`);
  return value.result;
}

const routesNow = ctx => cf(ROUTES_API, ctx.env.DATA_EDGE_TOKEN);

async function workerState(ctx, name) {
  const token = ctx.env.PLATFORM_EDGE_TOKEN, base = `${SCRIPTS_API}/${name}`;
  const [deployments, settings, schedules] = await Promise.all([cf(`${base}/deployments`, token),
    cf(`${base}/settings`, token), cf(`${base}/schedules`, token)]);
  const active = activeVersion(deployments);
  const version = await cf(`${base}/versions/${active}`, token);
  assert.equal(version.id, active, 'active version readback mismatch');
  return { active, version, settings, schedules };
}

const file = (ctx, name) => resolve(ctx.env.RETIRE_DIR, `${name}.json`);
const load = (ctx, name) => JSON.parse(readFileSync(file(ctx, name)));
function save(ctx, name, value, replace = false) {
  const path = file(ctx, name);
  assert.ok(replace || !existsSync(path), `${name} already recorded`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ schemaVersion: 1, kind: `weatherx-gdacs-route-retire-${name}`,
    sourceSha: ctx.sha, controllerSha: ctx.env.GITHUB_SHA, runId: ctx.env.GITHUB_RUN_ID,
    attempt: ctx.env.GITHUB_RUN_ATTEMPT, mode: ctx.mode, ...value }, null, 2)}\n`, { mode: 0o600 });
}
function own(ctx, name) {
  const value = load(ctx, name);
  for (const [key, expected] of Object.entries({ sourceSha: ctx.sha, controllerSha: ctx.env.GITHUB_SHA,
    runId: ctx.env.GITHUB_RUN_ID, attempt: ctx.env.GITHUB_RUN_ATTEMPT })) assert.equal(value[key], expected, `${name} ${key} changed`);
  return value;
}
function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, { flag: 'a' });
}

async function versions(ctx, command) {
  const facts = versionFacts(await workerState(ctx, PLATFORM_WORKER), await workerState(ctx, REPAIR_WORKER));
  // The verifier and the fallthrough declaration come from the source the platform Worker runs.
  assert.equal(facts.platform.source, ctx.sha.slice(0, 12), 'the active platform Worker was not released from this Atmos SHA');
  if (ctx.mode === 'retire') {
    assert.equal(facts.platform.active, ctx.platformVersion, 'platform Worker differs from the plan');
    assert.equal(facts.repair.active, ctx.repairVersion, 'repair Worker differs from the plan');
  }
  if (command === 'versions-after') same(facts, own(ctx, 'versions-before').facts, 'a Worker changed during retirement');
  save(ctx, command, { facts });
  return { status: 'recorded', ...facts };
}

async function plan(ctx) {
  const facts = own(ctx, 'versions-before').facts;
  const planned = retirementPlan(await routesNow(ctx), ctx.declared);
  save(ctx, 'plan', { platformVersion: facts.platform.active, repairVersion: facts.repair.active, ...planned });
  const retire = confirmation('retire', facts.platform.active);
  summary(['## GDACS route retirement plan', '',
    `- Platform Worker \`${PLATFORM_WORKER}\` active \`${facts.platform.active}\` (source \`${facts.platform.source}\`)`,
    `- Repair Worker \`${REPAIR_WORKER}\` active \`${facts.repair.active}\`: ${facts.repair.crons} crons, ${facts.repair.bindings} bindings (no R2 writes)`,
    '', '| Detach route ID | Pattern | Falls through to |', '| --- | --- | --- |',
    ...planned.detach.map(row => {
      const owner = planned.fallthrough.find(item => item.pattern === RETIRE.find(entry => entry.id === row.id).fallthrough);
      return `| \`${row.id}\` | \`${row.pattern}\` | \`${owner.pattern}\` (\`${owner.id}\`, ${owner.script}) |`;
    }),
    '', 'Retire with:', '', '```sh',
    `gh workflow run gdacs-route-retire.yml -R ${REPOSITORY} --ref main -f atmos_sha=${ctx.sha} -f mode=retire \\`,
    `  -f expected_platform_version=${facts.platform.active} -f expected_repair_version=${facts.repair.active} \\`,
    `  -f confirm=${retire}`, '```']);
  return { status: 'planned', detach: planned.detach.map(row => `${row.id} ${row.pattern}`),
    fallthrough: planned.fallthrough.map(row => `${row.id} ${row.pattern}`), confirm: retire };
}

async function liveBefore(ctx) {
  const { verifyWeatherFeeds } = await import(pathToFileURL(resolve(ctx.env.ATMOS_ROOT, 'ops/release/verify-weather-feeds.mjs')));
  // Production must be healthy and the four paths must still be on the repair Worker.
  const live = await liveRound('repair', { verifyWeatherFeeds, sleep: ctx.sleep });
  save(ctx, 'live-before', { live });
  return { status: 'recorded', gdacsList: live.gdacsList['/api/gdacs/list'] };
}

async function detach(ctx) {
  const planned = own(ctx, 'plan');
  own(ctx, 'versions-before');
  assert.equal(planned.platformVersion, ctx.platformVersion);
  assert.equal(planned.repairVersion, ctx.repairVersion);
  same(planned.detach.map(row => row.id), RETIRE.map(entry => entry.id), 'plan detaches unreviewed routes');
  assertBoundary(await routesNow(ctx), planned, []);
  const receipt = { status: 'detaching', before: planned.rows, detached: [] };
  save(ctx, 'receipt', receipt);
  for (const row of planned.detach) {
    // Durable intent first: restore re-attaches every pattern recorded here if it is missing.
    receipt.detached.push({ ...row, intentAt: new Date().toISOString() }); save(ctx, 'receipt', receipt, true);
    try { await cf(`${ROUTES_API}/${row.id}`, ctx.env.DATA_EDGE_TOKEN, 'DELETE'); }
    catch { receipt.detached.at(-1).responseLost = true; save(ctx, 'receipt', receipt, true); } // reconcile by read, never retry
    assertBoundary(await routesNow(ctx), planned, receipt.detached.map(item => item.id));
    receipt.detached.at(-1).confirmedAt = new Date().toISOString(); save(ctx, 'receipt', receipt, true);
  }
  receipt.status = 'detached'; save(ctx, 'receipt', receipt, true);
  return { status: 'detached', routes: receipt.detached.map(row => row.id) };
}

async function liveAfter(ctx) {
  const { verifyWeatherFeeds } = await import(pathToFileURL(resolve(ctx.env.ATMOS_ROOT, 'ops/release/verify-weather-feeds.mjs')));
  const proof = await verifyAfter({ verifyWeatherFeeds, sleep: ctx.sleep });
  save(ctx, 'live-after', proof);
  const list = proof.rounds.at(-1).gdacsList['/api/gdacs/list'];
  summary(['## GDACS routes retired and verified', '',
    `- \`/api/gdacs/list\`: ${list.count} events ${JSON.stringify(list.kinds)}, x-swr-age ${list.ageSeconds}s, platform Worker`,
    '- Three consecutive rounds passed: provenance, list contract, Atmos feed verifier, health, USGS, composed hazards']);
  return { status: 'verified', gdacsList: list };
}

async function routesAfter(ctx) {
  const planned = own(ctx, 'plan');
  assertBoundary(await routesNow(ctx), planned, RETIRE.map(entry => entry.id));
  save(ctx, 'routes-after', { rows: routeRows(await routesNow(ctx)) });
  return { status: 'recorded' };
}

async function restore(ctx) {
  if (!existsSync(file(ctx, 'receipt'))) return { status: 'no-receipt' };
  const receipt = own(ctx, 'receipt'), planned = own(ctx, 'plan');
  try {
    const restored = [];
    for (const entry of restoreActions(await routesNow(ctx), receipt)) {
      if (entry.action === 'reattach') {
        let created = null;
        try { created = await cf(ROUTES_API, ctx.env.DATA_EDGE_TOKEN, 'POST', { pattern: entry.pattern, script: REPAIR_WORKER }); }
        catch { /* reconcile by read below; never repeat a POST */ }
        const row = routeRows(await routesNow(ctx)).find(item => item.pattern === entry.pattern);
        assert.ok(row && row.script === REPAIR_WORKER, `${entry.pattern} was not re-attached`);
        if (created?.id) assert.equal(row.id, created.id, 'unexpected route identity after re-attach');
        restored.push({ ...entry, currentId: row.id });
      } else restored.push(entry);
      receipt.restored = restored; save(ctx, 'receipt', receipt, true);
    }
    assertRestored(await routesNow(ctx), planned, restored);
    receipt.recovery = 'routes-restored'; save(ctx, 'receipt', receipt, true);
    try { receipt.restoredOwners = await verifyRestored({ sleep: ctx.sleep }); receipt.recovery = 'routes-restored-and-verified'; }
    catch { receipt.recovery = 'routes-restored-verification-failed'; }
  } catch (error) {
    receipt.recovery = 'manual-inspection-required'; receipt.recoveryFailure = error.message.slice(0, 300);
  }
  save(ctx, 'receipt', receipt, true);
  summary(['## GDACS route retirement restored', '', `- Recovery: \`${receipt.recovery}\``,
    ...(receipt.restored ?? []).map(row => `- \`${row.pattern}\` -> \`${REPAIR_WORKER}\` as \`${row.currentId}\` (${row.action})`)]);
  assert.notEqual(receipt.recovery, 'manual-inspection-required', 'route restore incomplete; inspect the receipt');
  return { status: receipt.recovery };
}

export async function main(command, env = process.env, { sleep = wait } = {}) {
  const ctx = { ...context(env, command), sleep };
  if (command.startsWith('versions-')) return versions(ctx, command);
  return { plan, 'live-before': liveBefore, detach, 'live-after': liveAfter, 'routes-after': routesAfter, restore }[command](ctx);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`GDACS route retirement ${process.argv[2] ?? ''} refused: ${error.message}${error.cause?.message ? ` (${error.cause.message})` : ''}`);
    process.exitCode = 1;
  });
}
