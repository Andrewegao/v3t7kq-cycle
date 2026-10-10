import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  admit, assertBoundary, assertRestored, confirmation, credentialBoundary, FEED_MARKER, gdacsListFacts, liveRound, main,
  PLATFORM_WORKER, PROBES, provenance, REPAIR_WORKER, restoreActions, RETIRE, retirementPlan, routeMatches,
  servingRoute, verifyAfter, versionFacts,
} from '../tools/gdacs-route-retire.mjs';
import { DATA_WORKER, POINT_ROUTE } from '../tools/platform-worker-production-release.mjs';

const SHA = '34efee01d95942145c6dfc79732278728cef0ddf';
const PLATFORM_VERSION = '4f2c9a51-0d3e-4b7a-9c1e-2a6b8d0e1f23';
const REPAIR_VERSION = '7f59fd78-1e8c-4690-8d27-c1ecc4c7cd2d';
const DECLARED = ['weatherx.org/api/platform/health', 'weatherx.org/api/platform/aircraft-world',
  'weatherx.org/api/platform/production-wind100/*', 'weatherx.org/api/platform/auth/*', 'weatherx.org/api/platform/billing/*',
  'weatherx.org/api/platform/saved-*', 'weatherx.org/api/v1/*', 'weatherx.org/cdn/*', 'weatherx.org/api/hazards',
  'weatherx.org/api/tc/*', 'weatherx.org/api/gdacs/*', 'weatherx.org/api/eonet/*', 'weatherx.org/api/usgs/*'];
const id = n => n.toString(16).padStart(32, '0');
// The production shape from plan run 38025285361 (route IDs of unrelated rows are synthetic).
const ROUTES = () => [
  ...DECLARED.map((pattern, n) => ({ id: pattern === 'weatherx.org/api/gdacs/*' ? 'f76cca2bbc6e454d88d865827aa535f5'
    : pattern === 'weatherx.org/api/tc/*' ? 'd495776b49d941cd8b27a6299e5e02c2' : id(n + 1), pattern, script: PLATFORM_WORKER })),
  ...RETIRE.map(entry => ({ id: entry.id, pattern: entry.pattern, script: REPAIR_WORKER })),
  { id: id(80), pattern: POINT_ROUTE, script: DATA_WORKER },
  { id: id(81), pattern: 'weatherx.org/data/*', script: DATA_WORKER },
  { id: id(82), pattern: 'weatherx.org/api/platform/internal/fusion-archive*', script: 'weatherx-fusion-archive-production' },
  { id: id(83), pattern: 'weatherx.org/api/platform/fusion-calibration/*', script: 'weatherx-fusion-control-production' },
  { id: id(84), pattern: 'staging.weatherx.org/api/gdacs/*', script: 'weatherx-platform-edge-staging' },
  { id: id(85), pattern: 'kz-energy-staging.weatherx.org/api/tc/*', script: 'weatherx-platform-edge-kz-energy-staging' },
];
const RETIRED = RETIRE.map(entry => entry.id);

test('confirmation binds the mode; retire binds the planned platform version and both expected versions', () => {
  assert.equal(confirmation('plan'), 'PLAN-GDACS-ROUTE-RETIREMENT');
  assert.equal(confirmation('retire', PLATFORM_VERSION), `RETIRE-GDACS-FEED-ROUTES:${PLATFORM_VERSION}`);
  assert.throws(() => confirmation('retire', 'latest'));
  assert.throws(() => confirmation('delete', PLATFORM_VERSION));
  const plan = { RETIRE_MODE: 'plan', ATMOS_SHA: SHA, CONFIRM: 'PLAN-GDACS-ROUTE-RETIREMENT' };
  assert.deepEqual(admit(plan), { mode: 'plan', sha: SHA, platformVersion: null, repairVersion: null });
  assert.throws(() => admit({ ...plan, EXPECTED_PLATFORM_VERSION: PLATFORM_VERSION }));
  assert.throws(() => admit({ ...plan, ATMOS_SHA: SHA.slice(0, 12) }));
  const retire = { RETIRE_MODE: 'retire', ATMOS_SHA: SHA, EXPECTED_PLATFORM_VERSION: PLATFORM_VERSION,
    EXPECTED_REPAIR_VERSION: REPAIR_VERSION, CONFIRM: confirmation('retire', PLATFORM_VERSION) };
  assert.equal(admit(retire).repairVersion, REPAIR_VERSION);
  assert.throws(() => admit({ ...retire, EXPECTED_REPAIR_VERSION: '' }));
  assert.throws(() => admit({ ...retire, CONFIRM: 'PLAN-GDACS-ROUTE-RETIREMENT' }));
  assert.throws(() => admit({ ...retire, CONFIRM: confirmation('retire', REPAIR_VERSION) }));
});

test('the pinned set is the four repair routes, and every probe falls through to a declared platform route', () => {
  assert.deepEqual(RETIRE.map(entry => entry.pattern), ['weatherx.org/api/gdacs/list*', 'weatherx.org/api/gdacs/geom*',
    'weatherx.org/api/tc/list*', 'weatherx.org/api/tc/geom*']);
  const plan = retirementPlan(ROUTES(), DECLARED);
  assert.deepEqual(plan.detach.map(row => row.id), RETIRED);
  assert.deepEqual(plan.fallthrough.map(row => row.pattern), ['weatherx.org/api/gdacs/*', 'weatherx.org/api/tc/*']);
  assert.ok(plan.fallthrough.every(row => row.script === PLATFORM_WORKER));
  assert.deepEqual(plan.probes.map(row => row.path), PROBES);
  for (const probe of plan.probes) {
    assert.equal(probe.before.script, REPAIR_WORKER);
    assert.equal(probe.after.script, PLATFORM_WORKER);
  }
  assert.equal(plan.remaining.length, ROUTES().length - 4);
});

test('plan refuses changed identities, extra repair routes, other foreign overlaps and a missing fallthrough', () => {
  const change = (fn) => { const rows = ROUTES(); fn(rows); return rows; };
  assert.throws(() => retirementPlan(change(rows => rows.splice(rows.findIndex(r => r.id === RETIRED[2]), 1)), DECLARED),
    /tc-list route .* is not attached/);
  assert.throws(() => retirementPlan(change(rows => { rows.find(r => r.id === RETIRED[0]).script = 'someone-else'; }), DECLARED),
    /identity changed/);
  assert.throws(() => retirementPlan(change(rows => { rows.find(r => r.id === RETIRED[1]).pattern = 'weatherx.org/api/gdacs/g*'; }), DECLARED),
    /identity changed/);
  assert.throws(() => retirementPlan(change(rows => rows.push({ id: id(90), pattern: 'weatherx.org/api/eonet/list*', script: REPAIR_WORKER })), DECLARED),
    /unreviewed route/);
  assert.throws(() => retirementPlan(change(rows => rows.push({ id: id(91), pattern: 'weatherx.org/api/usgs/list', script: 'other' })), DECLARED),
    /another foreign route overlaps/);
  assert.throws(() => retirementPlan(change(rows => { rows.find(r => r.pattern === 'weatherx.org/api/tc/*').script = 'other'; }), DECLARED));
  assert.throws(() => retirementPlan(change(rows => rows.splice(rows.findIndex(r => r.pattern === 'weatherx.org/api/gdacs/*'), 1)), DECLARED));
  assert.throws(() => retirementPlan(ROUTES(), DECLARED.filter(p => p !== 'weatherx.org/api/tc/*')));
  assert.throws(() => retirementPlan([...ROUTES(), { id: id(92), pattern: 'weatherx.org/api/gdacs/list*', script: 'x' }], DECLARED),
    /duplicate route pattern/);
});

test('route matching includes queries, and the most specific pattern serves a path', () => {
  assert.equal(routeMatches('weatherx.org/api/gdacs/list*', '/api/gdacs/list?guard=query'), true);
  assert.equal(routeMatches('weatherx.org/api/gdacs/list*', '/api/gdacs/geom'), false);
  assert.equal(routeMatches('weatherx.org/api/hazards', '/api/hazards'), true);
  assert.equal(routeMatches('weatherx.org/api/hazards', '/api/hazards?x=1'), false);
  assert.equal(routeMatches('staging.weatherx.org/api/gdacs/*', '/api/gdacs/list'), false);
  assert.equal(servingRoute(ROUTES(), '/api/gdacs/list').id, RETIRED[0]);
  assert.equal(servingRoute(ROUTES(), '/api/v1/point-series/ecmwf').script, DATA_WORKER);
  assert.throws(() => servingRoute(ROUTES(), '/robots.txt'), /no route/);
  assert.throws(() => servingRoute([{ id: id(1), pattern: 'weatherx.org/api/x*', script: 'a' },
    { id: id(2), pattern: '*weatherx.org/api/x', script: 'b' }], '/api/x'), /ambiguous/);
});

test('boundary checks allow only the detached IDs to leave, and restore re-attaches the same patterns', () => {
  const plan = retirementPlan(ROUTES(), DECLARED);
  assert.doesNotThrow(() => assertBoundary(ROUTES(), plan, []));
  assert.doesNotThrow(() => assertBoundary(ROUTES().filter(r => r.id !== RETIRED[0]), plan, [RETIRED[0]]));
  assert.throws(() => assertBoundary(ROUTES().filter(r => r.id !== RETIRED[1]), plan, [RETIRED[0]]));
  assert.throws(() => assertBoundary([...ROUTES(), { id: id(99), pattern: 'weatherx.org/x', script: 'y' }], plan, []));

  const receipt = { detached: plan.detach.slice(0, 3) };
  const current = ROUTES().filter(r => !RETIRED.slice(0, 3).includes(r.id));
  const actions = restoreActions(current, receipt);
  assert.deepEqual(actions.map(a => [a.key, a.action]), [['tc-list', 'reattach'], ['gdacs-geom', 'reattach'], ['gdacs-list', 'reattach']]);
  // A DELETE whose route survived is already present; a foreign owner of a detached pattern is refused.
  const survived = ROUTES().filter(r => !RETIRED.slice(1, 3).includes(r.id));
  assert.deepEqual(restoreActions(survived, receipt).map(a => a.action), ['reattach', 'reattach', 'present']);
  const stolen = [...current, { id: id(70), pattern: 'weatherx.org/api/gdacs/list*', script: 'other' }];
  assert.throws(() => restoreActions(stolen, receipt), /refuse to replace/);

  const restored = actions.map((a, n) => ({ ...a, currentId: id(60 + n) }));
  const after = [...current, ...restored.map(a => ({ id: a.currentId, pattern: a.pattern, script: REPAIR_WORKER }))];
  assert.doesNotThrow(() => assertRestored(after, plan, restored));
  assert.throws(() => assertRestored(after.filter(r => r.id !== id(60)), plan, restored));
  assert.throws(() => assertRestored([...after, { id: id(98), pattern: 'weatherx.org/y', script: 'z' }], plan, restored));
});

const worker = (active, tag, bindings = []) => ({ active, version: { id: active, annotations: { 'workers/tag': tag },
  resources: { bindings, script_runtime: {} } } });
test('version facts prove the repair Worker has no crons or bindings and nothing binds to it', () => {
  const repair = { active: REPAIR_VERSION, settings: { bindings: [], tail_consumers: [] }, schedules: { schedules: [] } };
  const facts = versionFacts(worker(PLATFORM_VERSION, `production-${SHA.slice(0, 12)}`), repair);
  assert.deepEqual(facts, { platform: { name: PLATFORM_WORKER, active: PLATFORM_VERSION, source: SHA.slice(0, 12) },
    repair: { name: REPAIR_WORKER, active: REPAIR_VERSION, crons: 0, bindings: 0, tailConsumers: 0 } });
  assert.throws(() => versionFacts(worker(PLATFORM_VERSION, 'x'), { ...repair, schedules: { schedules: [{ cron: '*/10 * * * *' }] } }), /crons/);
  assert.throws(() => versionFacts(worker(PLATFORM_VERSION, 'x'), { ...repair, settings: { bindings: [{ name: 'DATA_BUCKET', type: 'r2_bucket' }] } }), /bindings/);
  assert.throws(() => versionFacts(worker(PLATFORM_VERSION, 'x', [{ name: 'FEED', type: 'service', service: REPAIR_WORKER }]), repair), /binds the repair Worker/);
});

const headers = owner => owner === 'repair' ? { 'x-weatherx-feed': FEED_MARKER } : owner === 'platform' ? { 'x-request-id': 'abc' } : {};
const feature = kind => ({ type: 'Feature', properties: { eventtype: kind, Class: 'Point_Centroid', eventid: 1, episodeid: 1 } });
test('provenance and the GDACS list contract tell the frozen repair bundle from the platform crawl', () => {
  assert.equal(provenance(new Headers(headers('repair'))), 'repair');
  assert.equal(provenance(new Headers(headers('platform'))), 'platform');
  assert.equal(provenance(new Headers({ 'x-weatherx-feed': FEED_MARKER, 'x-request-id': 'a' })), 'unknown');
  assert.equal(provenance(new Headers()), 'unknown');
  const platform = new Headers({ ...headers('platform'), 'x-swr-age': '12' });
  const body = { type: 'FeatureCollection', features: ['WF', 'WF', 'EQ', 'FL', 'DR', 'VO'].map(feature) };
  assert.deepEqual(gdacsListFacts(200, platform, body, 'platform'), { count: 6, ageSeconds: 12, kinds: { DR: 1, EQ: 1, FL: 1, VO: 1, WF: 2 } });
  const frozen = { type: 'FeatureCollection', features: ['EQ', 'WF', 'TC'].map(feature) };
  assert.throws(() => gdacsListFacts(200, platform, frozen, 'platform'), /TC rows/);
  assert.equal(gdacsListFacts(200, new Headers({ ...headers('repair'), 'x-swr-age': '5' }), frozen, 'repair').kinds.TC, 1);
  assert.throws(() => gdacsListFacts(200, new Headers({ ...headers('repair'), 'x-swr-age': '5' }), body, 'platform'), /not served by the platform/);
  assert.throws(() => gdacsListFacts(200, new Headers(headers('platform')), body, 'platform'), /feed age/);
  assert.throws(() => gdacsListFacts(200, new Headers({ ...headers('platform'), 'x-swr-age': '86400' }), body, 'platform'), /older/);
  assert.throws(() => gdacsListFacts(502, platform, body, 'platform'), /HTTP 502/);
});

// A public weatherx.org whose retired paths are answered by whoever the route table says.
function site(state) {
  return async (url) => {
    const { pathname } = new URL(url);
    const retired = RETIRE.find(entry => entry.probes.some(p => p.split('?')[0] === pathname));
    const owner = retired && state.routes.some(r => r.pattern === retired.pattern && r.script === REPAIR_WORKER) ? 'repair'
      : state.platformOverride?.(pathname) ?? 'platform';
    const h = { ...headers(owner), 'content-type': 'application/json', 'x-swr-age': '30' };
    if (pathname === '/api/platform/health') return Response.json({ ok: true, authMode: 'observe', billingMode: 'enabled', billingPurchaseMode: 'closed' }, { headers: h });
    if (pathname === '/api/hazards') return Response.json({ v: 1, tc: [], ev: [], bundles: [], feed: { tc: true, gdacs: true, eonet: true, usgs: true } },
      { headers: { ...h, 'x-weatherx-hazards-source': 'scheduled' } });
    if (pathname === '/api/gdacs/list') return Response.json({ type: 'FeatureCollection',
      features: (owner === 'repair' ? ['EQ', 'WF', 'TC'] : ['EQ', 'WF', 'FL', 'DR', 'VO']).map(feature) }, { headers: h });
    if (pathname.endsWith('/geom')) return Response.json({ type: 'FeatureCollection', features: [] }, { status: url.includes('?') ? 200 : 400, headers: h });
    return Response.json({ type: 'FeatureCollection', features: [] }, { headers: h });
  };
}
const verifier = async origin => {
  for (const path of ['/api/tc/list', '/api/gdacs/list', '/api/gdacs/geom?eventid=1&episodeid=1&eventtype=EQ', '/api/tc/geom?eventid=1&episodeid=1'])
    assert.equal((await fetch(origin + path)).status, 200);
  return [{ path: 'ok' }];
};

test('a live round holds every retired path, list contract and the release verifier to one owner', async () => {
  const before = { routes: ROUTES() };
  const round = await liveRound('repair', { fetchImpl: site(before), verifyWeatherFeeds: verifier, sleep: async () => {} });
  assert.ok(Object.values(round.owners).every(owner => owner === 'repair'));
  assert.equal(round.gdacsList['/api/gdacs/list'].kinds.TC, 1);
  await assert.rejects(liveRound('platform', { fetchImpl: site(before), verifyWeatherFeeds: verifier, sleep: async () => {} }), /answered by repair/);
  // A verifier request that reaches the other owner mid-round fails the round.
  const after = { routes: ROUTES().filter(r => !RETIRED.includes(r.id)) };
  let calls = 0;
  const flapping = { ...after, platformOverride: path => path === '/api/tc/geom' && ++calls > 1 ? 'repair' : 'platform' };
  await assert.rejects(liveRound('platform', { fetchImpl: site(flapping), verifyWeatherFeeds: verifier, sleep: async () => {} }), /provenance changed/);
});

test('after detach: bounded propagation wait, then three rounds fifteen seconds apart', async () => {
  const state = { routes: ROUTES().filter(r => !RETIRED.includes(r.id)) };
  let probes = 0;
  const lagging = { ...state, platformOverride: () => (probes++ < 10 ? 'repair' : 'platform') };
  const sleeps = [];
  const proof = await verifyAfter({ fetchImpl: site(lagging), verifyWeatherFeeds: verifier, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(proof.rounds.length, 3);
  assert.deepEqual(sleeps.filter(ms => ms === 15_000).length, 2);
  assert.ok(sleeps.filter(ms => ms === 5_000).length >= 1);
  await assert.rejects(verifyAfter({ fetchImpl: site({ routes: ROUTES() }), verifyWeatherFeeds: verifier, sleep: async () => {}, propagation: 3 }),
    /still not served by the platform/);
});

test('each command holds exactly its own credential, and public checks hold none', () => {
  assert.equal(credentialBoundary('versions-before', { PLATFORM_EDGE_TOKEN: 'w' }), 'worker');
  assert.throws(() => credentialBoundary('versions-before', { PLATFORM_EDGE_TOKEN: 'w', DATA_EDGE_TOKEN: 'r' }));
  for (const command of ['plan', 'detach', 'routes-after', 'restore']) {
    assert.equal(credentialBoundary(command, { DATA_EDGE_TOKEN: 'r' }), 'routes');
    assert.throws(() => credentialBoundary(command, { DATA_EDGE_TOKEN: 'r', PLATFORM_EDGE_TOKEN: 'w' }));
    assert.throws(() => credentialBoundary(command, {}));
  }
  for (const command of ['live-before', 'live-after']) {
    assert.equal(credentialBoundary(command, {}), 'public');
    assert.throws(() => credentialBoundary(command, { DATA_EDGE_TOKEN: 'r' }));
  }
  assert.throws(() => credentialBoundary('delete-worker', {}));
  assert.throws(() => credentialBoundary('plan', { DATA_EDGE_TOKEN: 'r', CLOUDFLARE_API_TOKEN: 'x' }));
});

// End to end through main(): a temporary Atmos checkout and a fake Cloudflare + weatherx.org.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gdacs-retire-'));
  const atmos = join(root, 'atmos');
  mkdirSync(join(atmos, 'platform/edge'), { recursive: true });
  mkdirSync(join(atmos, 'ops/release'), { recursive: true });
  writeFileSync(join(atmos, 'platform/edge/wrangler.jsonc'), JSON.stringify({ main: 'src/index.ts', compatibility_date: '2026-08-15',
    compatibility_flags: ['nodejs_compat'], triggers: { crons: ['*/5 * * * *'] },
    env: { production: { name: PLATFORM_WORKER, workers_dev: false, vars: { APP_ORIGIN: 'https://weatherx.org', AUTH_MODE: 'observe',
      BILLING_MODE: 'enabled', BILLING_PURCHASE_MODE: 'closed', PRODUCTION_WIND100_DYNAMIC_ENABLED: '1' },
    routes: DECLARED.map(pattern => ({ pattern, zone_name: 'weatherx.org' })) } } }));
  writeFileSync(join(atmos, 'ops/release/verify-weather-feeds.mjs'), `export async function verifyWeatherFeeds(origin) {
  for (const path of ['/api/tc/list', '/api/gdacs/list', '/api/gdacs/geom?eventid=1&episodeid=1&eventtype=EQ'])
    if ((await fetch(origin + path)).status !== 200) throw new Error(path);
  return [{ path: 'ok' }];
}\n`);
  const git = (...args) => execFileSync('git', args, { cwd: atmos, encoding: 'utf8' }).trim();
  git('init', '-q'); git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/master', sha);
  return { root, atmos, sha };
}

function cloudflare(state, sha, { loseDelete = false, failPublicAfterDetach = false } = {}) {
  const publicSite = site(state);
  let next = 0x500;
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    if (url.startsWith('https://weatherx.org')) {
      if (failPublicAfterDetach && !state.routes.some(r => r.script === REPAIR_WORKER) && new URL(url).pathname === '/api/gdacs/list')
        return new Response('upstream', { status: 503, headers: { 'x-request-id': 'a' } });
      return publicSite(url, init);
    }
    const ok = result => Response.json({ success: true, result });
    const routeMatch = url.match(/\/zones\/[a-f0-9]+\/workers\/routes(?:\/([a-f0-9]{32}))?$/);
    if (routeMatch) {
      state.calls.push(`${method} routes${routeMatch[1] ? '/' + routeMatch[1] : ''}`);
      if (method === 'GET') return ok(structuredClone(state.routes));
      if (method === 'DELETE') {
        state.routes = state.routes.filter(r => r.id !== routeMatch[1]);
        if (loseDelete) throw new TypeError('socket hang up');
        return ok({ id: routeMatch[1] });
      }
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        const route = { id: id(next++), pattern: body.pattern, script: body.script };
        state.routes.push(route); return ok(route);
      }
    }
    const script = url.match(/\/workers\/scripts\/([a-z0-9-]+)\/(deployments|settings|schedules|versions\/([a-f0-9-]+))$/);
    assert.ok(script && method === 'GET', `unexpected Cloudflare call ${method} ${url}`);
    state.calls.push(`GET ${script[1]}/${script[2].split('/')[0]}`);
    const active = script[1] === PLATFORM_WORKER ? PLATFORM_VERSION : REPAIR_VERSION;
    if (script[2] === 'deployments') return ok({ deployments: [{ created_on: '2026-10-10T04:55:00Z', versions: [{ version_id: active, percentage: 100 }] }] });
    if (script[2] === 'settings') return ok({ bindings: [], tail_consumers: [] });
    if (script[2] === 'schedules') return ok({ schedules: [] });
    return ok({ id: script[3], annotations: { 'workers/tag': script[1] === PLATFORM_WORKER ? `production-${sha.slice(0, 12)}` : 'gdacs-x' },
      resources: { bindings: [], script_runtime: {} } });
  };
}

async function runFlow(commands, options = {}) {
  const { root, atmos, sha } = fixture();
  const state = { routes: ROUTES(), calls: [] };
  const original = globalThis.fetch;
  globalThis.fetch = cloudflare(state, sha, options);
  const base = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/gdacs-route-retire.yml@refs/heads/main',
    GITHUB_JOB: 'retire', RETIRE_ENVIRONMENT: 'production', GITHUB_SHA: 'c'.repeat(40), GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1',
    RETIRE_DIR: join(root, 'out'), ATMOS_ROOT: atmos, ATMOS_SHA: sha, PATH: process.env.PATH,
    ...(options.mode === 'plan' ? { RETIRE_MODE: 'plan', CONFIRM: 'PLAN-GDACS-ROUTE-RETIREMENT' }
      : { RETIRE_MODE: 'retire', EXPECTED_PLATFORM_VERSION: PLATFORM_VERSION, EXPECTED_REPAIR_VERSION: REPAIR_VERSION,
        CONFIRM: `RETIRE-GDACS-FEED-ROUTES:${PLATFORM_VERSION}` }), ...options.env };
  const results = {};
  try {
    for (const command of commands) {
      const kind = credentialBoundary(command, command.startsWith('versions') ? { PLATFORM_EDGE_TOKEN: 'w' }
        : ['live-before', 'live-after'].includes(command) ? {} : { DATA_EDGE_TOKEN: 'r' });
      const env = { ...base, ...(kind === 'worker' ? { PLATFORM_EDGE_TOKEN: 'w' } : kind === 'routes' ? { DATA_EDGE_TOKEN: 'r' } : {}) };
      results[command] = await main(command, env, { sleep: async () => {} }).catch(error => ({ error: error.message }));
    }
    const read = name => JSON.parse(readFileSync(join(root, 'out', `${name}.json`)));
    return { state, results, read };
  } finally { globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); }
}

test('plan mode is read-only: no route or Worker write, exact IDs and fallthrough recorded', async () => {
  const { state, results } = await runFlow(['versions-before', 'plan', 'live-before'], { mode: 'plan' });
  assert.equal(results.plan.status, 'planned', JSON.stringify(results));
  assert.deepEqual(results.plan.detach, RETIRE.map(e => `${e.id} ${e.pattern}`));
  assert.deepEqual(results.plan.fallthrough, ['f76cca2bbc6e454d88d865827aa535f5 weatherx.org/api/gdacs/*', 'd495776b49d941cd8b27a6299e5e02c2 weatherx.org/api/tc/*']);
  assert.equal(results.plan.confirm, `RETIRE-GDACS-FEED-ROUTES:${PLATFORM_VERSION}`);
  assert.equal(results['live-before'].status, 'recorded');
  assert.ok(state.calls.every(call => call.startsWith('GET ')), state.calls.join());
  assert.deepEqual(state.routes, ROUTES());
});

test('retire detaches exactly the four IDs, verifies the platform owner, and leaves both Workers', async () => {
  const { state, results } = await runFlow(['versions-before', 'plan', 'live-before', 'detach', 'live-after', 'routes-after', 'versions-after']);
  for (const command of Object.keys(results)) assert.ok(!results[command].error, `${command}: ${results[command].error}`);
  assert.deepEqual(state.calls.filter(call => !call.startsWith('GET ')), RETIRED.map(r => `DELETE routes/${r}`));
  assert.deepEqual(state.routes, ROUTES().filter(r => !RETIRED.includes(r.id)));
  assert.deepEqual(results['live-after'].gdacsList.kinds, { DR: 1, EQ: 1, FL: 1, VO: 1, WF: 1 });
});

test('a lost DELETE response is reconciled by reading, never by a second DELETE', async () => {
  const { state, results } = await runFlow(['versions-before', 'plan', 'live-before', 'detach'], { loseDelete: true });
  assert.equal(results.detach.status, 'detached', JSON.stringify(results.detach));
  assert.equal(state.calls.filter(call => call.startsWith('DELETE')).length, 4);
});

test('failed live proof restores the same four patterns to the repair Worker', async () => {
  const { state, results } = await runFlow(['versions-before', 'plan', 'live-before', 'detach', 'live-after', 'restore', 'versions-after'],
    { failPublicAfterDetach: true });
  assert.match(results['live-after'].error, /HTTP 503|still not served|gdacs\/list/);
  assert.equal(results.restore.status, 'routes-restored-and-verified', JSON.stringify(results.restore));
  assert.ok(!results['versions-after'].error);
  const restored = state.routes.filter(r => r.script === REPAIR_WORKER).map(r => r.pattern).sort();
  assert.deepEqual(restored, RETIRE.map(e => e.pattern).sort());
  assert.ok(state.routes.filter(r => r.script === REPAIR_WORKER).every(r => !RETIRED.includes(r.id)), 'new route identities');
  assert.deepEqual(state.calls.filter(call => call.startsWith('POST')).length, 4);
  assert.deepEqual(state.routes.filter(r => r.script !== REPAIR_WORKER), ROUTES().filter(r => r.script !== REPAIR_WORKER));
});

test('retire refuses before any write when either Worker moved since the plan', async () => {
  const other = '11111111-2222-4333-8444-555555555555';
  for (const [override, message] of [[{ EXPECTED_PLATFORM_VERSION: other, CONFIRM: `RETIRE-GDACS-FEED-ROUTES:${other}` }, /platform Worker differs/],
    [{ EXPECTED_REPAIR_VERSION: other }, /repair Worker differs/]]) {
    const { state, results } = await runFlow(['versions-before', 'plan', 'live-before', 'detach'], { env: override });
    assert.match(results['versions-before'].error, message);
    assert.match(results.detach.error, /ENOENT|no such file/);
    assert.ok(state.calls.every(call => call.startsWith('GET ')), state.calls.join());
    assert.deepEqual(state.routes, ROUTES());
  }
});

test('controller writes only DELETE of pinned route IDs and POST of the same patterns to the repair Worker', () => {
  const source = readFileSync(new URL('../tools/gdacs-route-retire.mjs', import.meta.url), 'utf8');
  const writes = [...source.matchAll(/cf\(([^)]*?),\s*'(POST|PUT|PATCH|DELETE)'/g)].map(m => `${m[2]} ${m[1].trim()}`);
  assert.deepEqual(writes, ['DELETE `${ROUTES_API}/${row.id}`, ctx.env.DATA_EDGE_TOKEN', 'POST ROUTES_API, ctx.env.DATA_EDGE_TOKEN']);
  assert.match(source, /\{ pattern: entry\.pattern, script: REPAIR_WORKER \}/);
  assert.equal(source.match(/'(?:POST|PUT|PATCH|DELETE)'/g).length, 2);
  assert.doesNotMatch(source, /runWrangler|wrangler\.js\b|wrangler\/bin|versions deploy|\/content\/v2/);
});

test('workflow is manual, main-only, production-gated, serialized, and isolates each credential', () => {
  const source = readFileSync(new URL('../.github/workflows/gdacs-route-retire.yml', import.meta.url), 'utf8');
  assert.match(source, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(source, /^\s+(?:push|schedule|workflow_run|pull_request|repository_dispatch|workflow_call):/m);
  assert.match(source, /group: weatherx-production-data-edge\n  cancel-in-progress: false/);
  assert.match(source, /environment:\n      name: production\n/);
  assert.match(source, /github\.ref == 'refs\/heads\/main'/);
  assert.match(source, /git -C atmos merge-base --is-ancestor "\$ATMOS_SHA" refs\/remotes\/origin\/master/);
  assert.match(source, /options: \[plan, retire\]/);
  assert.doesNotMatch(source, /wrangler|pages deploy|secret put|UI_PRODUCTION_PAGES_TOKEN|secrets\.CLOUDFLARE_API_TOKEN/);
  const steps = source.split(/\n      - /).slice(1);
  const commands = [];
  for (const step of steps) {
    const worker = step.includes('secrets.CLOUDFLARE_WORKERS_API_TOKEN');
    const routes = step.includes('secrets.CLOUDFLARE_DATA_EDGE_API_TOKEN');
    assert.ok(!(worker && routes), 'one step holds both Cloudflare credentials');
    const command = step.match(/tools\/gdacs-route-retire\.mjs ([a-z-]+)/)?.[1];
    if (command) {
      commands.push(command);
      const kind = credentialBoundary(command, worker ? { PLATFORM_EDGE_TOKEN: 'w' } : routes ? { DATA_EDGE_TOKEN: 'r' } : {});
      assert.equal(kind, worker ? 'worker' : routes ? 'routes' : 'public', `${command} step credential`);
    }
  }
  assert.deepEqual(commands, ['versions-before', 'plan', 'live-before', 'detach', 'live-after', 'routes-after', 'restore', 'versions-after']);
  const step = name => steps.find(s => s.includes(`tools/gdacs-route-retire.mjs ${name}`));
  assert.match(step('detach'), /if: \$\{\{ inputs\.mode == 'retire' \}\}/);
  for (const outcome of ['detach', 'live_after', 'routes_after'])
    for (const result of ['failure', 'cancelled']) assert.ok(step('restore').includes(`steps.${outcome}.outcome == '${result}'`));
  assert.match(step('restore'), /always\(\) && inputs\.mode == 'retire'/);
  assert.match(step('versions-after'), /always\(\) && inputs\.mode == 'retire'/);
});
