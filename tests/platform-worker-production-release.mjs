import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  admit, assertCodeOnly, assertSchedules, bindingSummary, confirmation, DATA_WORKER, HEALTH, POINT_ROUTE,
  previousSource, recoveryAction, REQUIRED_ROUTES, routeBoundary, validateLiveSelector, validateReleaseConfig,
  verifierEnvironment, WORKER,
} from '../tools/platform-worker-production-release.mjs';

const SHA = '34efee01d95942145c6dfc79732278728cef0ddf';
const VERSION = '12345678-1234-1234-1234-123456789abc';
const CRONS = ['17 3 * * *', '*/5 * * * *', '2,12,22,32,42,52 * * * *'];
const PATTERNS = ['weatherx.org/api/platform/health', 'weatherx.org/api/platform/aircraft-world',
  'weatherx.org/api/platform/production-wind100/*', 'weatherx.org/api/v1/*', 'weatherx.org/api/hazards'];
const config = { main: 'src/index.ts', compatibility_date: '2026-08-15', compatibility_flags: ['nodejs_compat'],
  triggers: { crons: CRONS },
  env: { production: { name: WORKER, workers_dev: false,
    secrets: { required: ['AUTH_HASH_KEY'] },
    vars: { APP_ORIGIN: 'https://weatherx.org', AUTH_MODE: 'observe', BILLING_MODE: 'enabled',
      BILLING_PURCHASE_MODE: 'closed', PRODUCTION_WIND100_DYNAMIC_ENABLED: '1' },
    r2_buckets: [{ binding: 'DATA_BUCKET', bucket_name: 'weatherx-data-production' }],
    routes: PATTERNS.map(pattern => ({ pattern, zone_name: 'weatherx.org' })) } } };
const reviewed = validateReleaseConfig(config);
const bindings = vars => [...Object.entries(vars).map(([name, text]) => ({ name, text, type: 'plain_text' })),
  { name: 'AUTH_HASH_KEY', type: 'secret_text' },
  { name: 'DATA_BUCKET', type: 'r2_bucket', bucket_name: 'weatherx-data-production' }];
const settings = (vars = reviewed.vars) => ({ compatibility_date: '2026-08-15', compatibility_flags: ['nodejs_compat'],
  bindings: bindings(vars) });
const id = n => n.toString(16).padStart(32, '0');
const routes = () => [...PATTERNS.map((pattern, n) => ({ id: id(n + 1), pattern, script: WORKER })),
  { id: id(90), pattern: POINT_ROUTE, script: DATA_WORKER },
  { id: id(91), pattern: 'weatherx.org/data/*', script: DATA_WORKER }];
const selector = { schemaVersion: 1, kind: 'production-native-wind100-selector',
  catalogId: 'prod-wind100-recurring-37981663696-1', runId: '2026100912', selectionSha256: 'c'.repeat(64),
  initializedAt: '2026-10-09T12:00:00Z', freshUntil: '2026-10-10T18:00:00Z' };

test('confirmation binds mode and exact source; release requires the planned active version', () => {
  assert.equal(confirmation('plan', SHA), `PLAN-PRODUCTION-PLATFORM-WORKER:${SHA}`);
  assert.equal(confirmation('release', SHA), `RELEASE-PRODUCTION-PLATFORM-WORKER:${SHA}`);
  assert.throws(() => confirmation('deploy', SHA));
  assert.throws(() => confirmation('plan', SHA.slice(0, 12)));
  const plan = { RELEASE_MODE: 'plan', ATMOS_SHA: SHA, CONFIRM: confirmation('plan', SHA) };
  assert.deepEqual(admit(plan), { mode: 'plan', sha: SHA, expected: null });
  assert.throws(() => admit({ ...plan, EXPECTED_ACTIVE_VERSION_ID: VERSION }));
  assert.throws(() => admit({ ...plan, CONFIRM: confirmation('release', SHA) }));
  const release = { RELEASE_MODE: 'release', ATMOS_SHA: SHA, CONFIRM: confirmation('release', SHA),
    EXPECTED_ACTIVE_VERSION_ID: VERSION };
  assert.equal(admit(release).expected, VERSION);
  assert.throws(() => admit({ ...release, EXPECTED_ACTIVE_VERSION_ID: '' }));
  assert.throws(() => admit({ ...release, CONFIRM: confirmation('release', 'a'.repeat(40)) }));
});

test('reviewed production config keeps purchases closed, Wind100 on and data routes out', () => {
  assert.deepEqual(reviewed.crons, [...CRONS].sort());
  assert.equal(reviewed.compatibility_date, '2026-08-15');
  for (const [key, value] of [['BILLING_PURCHASE_MODE', 'public'], ['BILLING_MODE', 'disabled'],
    ['AUTH_MODE', 'public'], ['PRODUCTION_WIND100_DYNAMIC_ENABLED', '0'], ['APP_ORIGIN', 'https://staging.weatherx.org']]) {
    const changed = structuredClone(config); changed.env.production.vars[key] = value;
    assert.throws(() => validateReleaseConfig(changed), key);
  }
  for (const pattern of [POINT_ROUTE, 'weatherx.org/data/*', 'weatherx.org/api/platform/data-health*']) {
    const changed = structuredClone(config); changed.env.production.routes.push({ pattern });
    assert.throws(() => validateReleaseConfig(changed), pattern);
  }
  for (const pattern of REQUIRED_ROUTES) {
    const changed = structuredClone(config);
    changed.env.production.routes = changed.env.production.routes.filter(route => route.pattern !== pattern);
    assert.throws(() => validateReleaseConfig(changed), pattern);
  }
  const noCrons = structuredClone(config); delete noCrons.triggers;
  assert.throws(() => validateReleaseConfig(noCrons));
  const otherWorker = structuredClone(config); otherWorker.env.production.name = DATA_WORKER;
  assert.throws(() => validateReleaseConfig(otherWorker));
});

test('code-only preflight requires active and latest settings to equal the reviewed config', () => {
  assert.doesNotThrow(() => assertCodeOnly(reviewed, settings(), settings()));
  const drift = settings({ ...reviewed.vars, BILLING_PURCHASE_MODE: 'public' });
  assert.throws(() => assertCodeOnly(reviewed, drift, settings()), /active Worker settings differ/);
  assert.throws(() => assertCodeOnly(reviewed, settings(), drift), /latest Worker settings differ/);
  const missingSecret = settings(); missingSecret.bindings = missingSecret.bindings.filter(b => b.type !== 'secret_text');
  assert.throws(() => assertCodeOnly(reviewed, missingSecret, settings()));
  const extraSecret = settings(); extraSecret.bindings.push({ name: 'SURPRISE', type: 'secret_text' });
  assert.throws(() => assertCodeOnly(reviewed, extraSecret, settings()));
  assert.throws(() => assertCodeOnly(reviewed, { ...settings(), compatibility_date: '2026-10-01' }, settings()));
  const summary = bindingSummary(settings().bindings);
  assert.deepEqual(Object.keys(summary), ['count', 'sha256']);
  assert.ok(!JSON.stringify(summary).includes('AUTH_HASH_KEY'));
});

test('cron boundary is exact and order independent', () => {
  assert.doesNotThrow(() => assertSchedules(reviewed, { schedules: [...CRONS].reverse().map(cron => ({ cron })) }));
  assert.throws(() => assertSchedules(reviewed, { schedules: CRONS.slice(1).map(cron => ({ cron })) }));
  assert.throws(() => assertSchedules(reviewed, { schedules: [...CRONS, '0 * * * *'].map(cron => ({ cron })) }));
});

test('route boundary keeps the point reader on the data Worker and reports unattached routes', () => {
  const boundary = routeBoundary(routes(), reviewed);
  assert.deepEqual(boundary.platform, [...PATTERNS].sort());
  assert.deepEqual(boundary.declaredNotAttached, []);
  assert.deepEqual(boundary.attachedNotDeclared, []);
  const partial = routes().filter(route => route.pattern !== 'weatherx.org/api/hazards');
  assert.deepEqual(routeBoundary(partial, reviewed).declaredNotAttached, ['weatherx.org/api/hazards']);
  const moved = routes().map(route => route.pattern === POINT_ROUTE ? { ...route, script: WORKER } : route);
  assert.throws(() => routeBoundary(moved, reviewed), /point reader route left the data Worker/);
  assert.throws(() => routeBoundary(routes().filter(route => route.pattern !== POINT_ROUTE), reviewed));
  for (const pattern of REQUIRED_ROUTES)
    assert.throws(() => routeBoundary(routes().filter(route => route.pattern !== pattern), reviewed));
  assert.throws(() => routeBoundary([...routes(), { id: id(99), pattern: PATTERNS[0], script: WORKER }], reviewed));
  assert.throws(() => routeBoundary([...routes(), { id: 'not-a-route', pattern: 'x', script: WORKER }], reviewed));
});

test('live selector must be a valid production selector and never regress', () => {
  assert.equal(validateLiveSelector(selector), selector);
  assert.equal(validateLiveSelector(selector, selector), selector);
  const next = { ...selector, catalogId: 'prod-wind100-recurring-38000000000-1', runId: '2026100918',
    selectionSha256: 'd'.repeat(64) };
  assert.equal(validateLiveSelector(next, selector), next);
  assert.throws(() => validateLiveSelector(selector, next), /regressed/);
  assert.throws(() => validateLiveSelector({ ...selector, selectionSha256: 'e'.repeat(64) }, selector));
  for (const changed of [{ kind: 'staging-native-wind100-selector' }, { catalogId: 'staging-1' },
    { runId: '20261009' }, { selectionSha256: 'x' }, { freshUntil: 'soon' }, { schemaVersion: 2 }])
    assert.throws(() => validateLiveSelector({ ...selector, ...changed }), JSON.stringify(changed));
  assert.deepEqual(HEALTH, { ok: true, authMode: 'observe', billingMode: 'enabled', billingPurchaseMode: 'closed' });
});

test('downgrade guard reads only reviewed release tags; rollback refuses a foreign publisher', () => {
  assert.equal(previousSource({ annotations: { 'workers/tag': 'wind100-7497b9815f1f' } }), '7497b9815f1f');
  assert.equal(previousSource({ annotations: { 'workers/tag': 'production-34efee01d959' } }), '34efee01d959');
  for (const tag of [undefined, '', 'manual', 'production-34EFEE01D959', 'production-34efee01d9'])
    assert.equal(previousSource({ annotations: { 'workers/tag': tag } }), null);
  const receipt = { previous: VERSION, candidate: '87654321-4321-4321-4321-cba987654321' };
  assert.equal(recoveryAction(receipt.previous, receipt), 'already-restored');
  assert.equal(recoveryAction(receipt.candidate, receipt), 'restore-owned-candidate');
  assert.throws(() => recoveryAction('11111111-1111-1111-1111-111111111111', receipt), /different publisher/);
});

test('site verifier receives no Cloudflare credential', () => {
  const env = verifierEnvironment('candidate', 3, { PATH: '/bin', HOME: '/h', PLATFORM_EDGE_TOKEN: 'secret',
    DATA_EDGE_TOKEN: 'secret', CLOUDFLARE_API_TOKEN: 'secret' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', RELEASE_GUARD_PHASE: 'candidate',
    RELEASE_GUARD_VERIFY_REQUIRED_SUCCESSES: '3', RELEASE_GUARD_VERIFY_SLEEP_SECONDS: '15',
    EDGE_DATA_PROBE_PATH: '/data-atmos/airports/airports.json' });
  assert.equal(verifierEnvironment('rollback', 1, {}).RELEASE_GUARD_VERIFY_SLEEP_SECONDS, '5');
  assert.throws(() => verifierEnvironment('preflight', 1, {}));
});

test('controller can only upload, activate and roll back Worker versions; it never writes routes', () => {
  const source = readFileSync(new URL('../tools/platform-worker-production-release.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /method:\s*'(?:POST|PUT|PATCH|DELETE)'/);
  assert.doesNotMatch(source, /'secret'|'pages'|'triggers'|'d1'|'r2'|'deploy',\s*'--/);
  const wrangler = [...source.matchAll(/runWrangler\(ctx, \['([a-z]+)'(?:, '([a-z]+)')?/g)].map(m => m.slice(1).filter(Boolean).join(' '));
  assert.deepEqual([...new Set(wrangler)].sort(), ['rollback', 'versions deploy', 'versions upload']);
});

test('workflow is manual, main-only, production-gated and isolates each credential to its step', () => {
  const source = readFileSync(new URL('../.github/workflows/platform-worker-production-release.yml', import.meta.url), 'utf8');
  assert.match(source, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(source, /^\s+(?:push|schedule|workflow_run|pull_request|repository_dispatch|workflow_call):/m);
  assert.match(source, /group: weatherx-production-data-edge\n  cancel-in-progress: false/);
  assert.match(source, /environment:\n      name: production\n/);
  assert.match(source, /github\.ref == 'refs\/heads\/main'/);
  assert.match(source, /git -C atmos merge-base --is-ancestor "\$ATMOS_SHA" refs\/remotes\/origin\/master/);
  assert.match(source, /npx wrangler deploy --dry-run --env production/);
  assert.equal(source.match(/wrangler deploy/g).length, 1);
  assert.doesNotMatch(source, /pages deploy|secret put|UI_PRODUCTION_PAGES_TOKEN|WX_GROUND_QUALIFICATION_SCOPE/);
  const steps = source.split(/\n      - /).slice(1);
  for (const step of steps) {
    const worker = step.includes('secrets.CLOUDFLARE_WORKERS_API_TOKEN');
    const routes = step.includes('secrets.CLOUDFLARE_DATA_EDGE_API_TOKEN');
    assert.ok(!(worker && routes), 'one step holds both Cloudflare credentials');
    if (routes) assert.match(step, /platform-worker-production-release\.mjs routes-(?:before|after)/);
    if (worker) assert.match(step, /platform-worker-production-release\.mjs (?:"\$RELEASE_MODE"|recover)/);
  }
  assert.match(source, /if: \$\{\{ always\(\) && inputs\.mode == 'release' && \(steps\.release_worker\.outcome == 'failure' \|\| steps\.release_worker\.outcome == 'cancelled'\) \}\}/);
  assert.match(source, /if: \$\{\{ always\(\) && steps\.routes_before\.outcome == 'success' \}\}/);
});
