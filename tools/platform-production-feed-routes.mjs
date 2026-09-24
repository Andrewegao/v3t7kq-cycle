#!/usr/bin/env node
// Attach only the two missing production feed routes to the already active Platform Worker.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZONE = '9dc4df7c3c094ab9a11dd00d378adc26';
const WORKER = 'weatherx-platform-edge-production';
const SOURCE = '7497b9815f1f5ca657cda8ed24ad5894afa267e0';
const WORKFLOW = 'Andrewegao/v3t7kq-cycle/.github/workflows/platform-production-feed-routes.yml@refs/heads/main';
const URL = `https://api.cloudflare.com/client/v4/zones/${ZONE}/workers/routes`;
const PATTERNS = Object.freeze(['weatherx.org/api/usgs/*', 'weatherx.org/api/hazards']);
const ID = /^[a-f0-9]{32}$/;

const ordered = routes => routes.map(({ id, pattern, script }) => ({ id, pattern, script }))
  .sort((a, b) => a.id.localeCompare(b.id));

export function assertRouteBoundary(before, current, owned = []) {
  assert.ok(Array.isArray(before) && Array.isArray(current));
  assert.ok(before.some(route => route.pattern === 'weatherx.org/api/platform/health' && route.script === WORKER),
    'live production Platform Worker boundary missing');
  assert.ok(before.some(route => route.pattern === 'weatherx.org/api/platform/production-wind100/*' && route.script === WORKER),
    'verified Wind100 route missing');
  for (const pattern of PATTERNS) assert.ok(!before.some(route => route.pattern === pattern),
    `${pattern} already owned; refuse to replace it`);
  for (const route of owned) {
    assert.match(route.id, ID);
    assert.ok(PATTERNS.includes(route.pattern) && route.script === WORKER, 'unreviewed owned route');
    assert.ok(!before.some(row => row.id === route.id), 'route ID predates this run');
  }
  assert.deepEqual(ordered(current), ordered([...before, ...owned]), 'unrelated route boundary changed');
}

function context(env) {
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: WORKFLOW,
    GITHUB_JOB: 'routes', ROUTE_RELEASE_ENVIRONMENT: 'production', ATMOS_SHA: SOURCE })) {
    assert.equal(env[key], expected, `${key} changed`);
  }
  assert.ok(env.DATA_EDGE_TOKEN, 'dedicated route token required');
  assert.ok(!env.PLATFORM_EDGE_TOKEN && !env.UI_PRODUCTION_PAGES_TOKEN,
    'unrelated release credentials forbidden');
  assert.match(env.ROUTE_RECEIPT ?? '', /^\//);
  assert.match(env.ATMOS_ROOT ?? '', /^\//);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'],
    { cwd: env.ATMOS_ROOT, encoding: 'utf8' }).trim(), SOURCE);
  const config = JSON.parse(readFileSync(resolve(env.ATMOS_ROOT, 'platform/edge/wrangler.jsonc')));
  assert.equal(config.env?.production?.name, WORKER);
  for (const pattern of PATTERNS) assert.ok(config.env.production.routes?.some(route => route.pattern === pattern),
    `${pattern} not declared in reviewed Worker source`);
  assert.equal(config.env.production.vars?.BILLING_PURCHASE_MODE, 'closed');
}

async function request(path, token, method = 'GET', body) {
  const response = await fetch(URL + path, { method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `route API ${method} returned HTTP ${response.status}`);
  const result = await response.json();
  assert.equal(result.success, true, `route API ${method} refused request`);
  return result.result;
}

function save(path, receipt) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
}

export async function verifyFeeds(fetchImpl = fetch) {
  const health = await fetchImpl('https://weatherx.org/api/platform/health',
    { redirect: 'error', signal: AbortSignal.timeout(15_000), cache: 'no-store' });
  assert.equal(health.status, 200, 'production Platform health failed');
  assert.deepEqual(await health.json(), { ok: true, authMode: 'observe', billingMode: 'enabled', billingPurchaseMode: 'closed' });
  const usgs = await fetchImpl('https://weatherx.org/api/usgs/list',
    { redirect: 'error', signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  assert.match(usgs.headers.get('content-type') ?? '', /^application\/json(?:;|$)/i, 'USGS route returned non-JSON');
  const usgsBody = await usgs.json();
  assert.ok((usgs.status === 200 && usgsBody?.type === 'FeatureCollection' && Array.isArray(usgsBody.features))
    || (usgs.status === 502 && usgsBody?.error === 'upstream unavailable'), 'USGS route contract failed');
  const hazards = await fetchImpl('https://weatherx.org/api/hazards',
    { redirect: 'error', signal: AbortSignal.timeout(55_000), cache: 'no-store' });
  assert.equal(hazards.status, 200, 'composed hazard route failed');
  assert.equal(hazards.headers.get('x-weatherx-hazards-source') !== null, true,
    'composed hazard request did not reach the scheduled Worker');
  const document = await hazards.json();
  assert.equal(document?.v, 1);
  assert.ok(Array.isArray(document.tc) && Array.isArray(document.ev) && Array.isArray(document.bundles));
  assert.ok(['tc', 'gdacs', 'eonet', 'usgs'].every(key => typeof document.feed?.[key] === 'boolean'));
  assert.ok(['tc', 'gdacs', 'eonet', 'usgs'].some(key => document.feed[key]));
  return { status: 'verified', usgsStatus: usgs.status, hazardsSource: hazards.headers.get('x-weatherx-hazards-source') };
}

export async function verifyFeedsEventually(fetchImpl = fetch,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 24) {
  assert.ok(Number.isInteger(attempts) && attempts >= 1 && attempts <= 24);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await verifyFeeds(fetchImpl); }
    catch (error) {
      if (attempt === attempts) throw error;
      await sleep(5_000);
    }
  }
  throw new Error('unreachable feed verification state');
}

export async function main(command, env = process.env) {
  context(env);
  const path = env.ROUTE_RECEIPT;
  const token = env.DATA_EDGE_TOKEN;
  if (command === 'attach') {
    assert.ok(!existsSync(path), 'route receipt already exists');
    const before = await request('', token);
    assertRouteBoundary(before, before);
    const receipt = { schemaVersion: 1, kind: 'weatherx-production-feed-routes', controllerSha: env.GITHUB_SHA,
      sourceSha: SOURCE, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
      before, owned: [], status: 'create-intent' };
    save(path, receipt);
    for (const pattern of PATTERNS) {
      receipt.intent = pattern; save(path, receipt);
      const route = await request('', token, 'POST', { pattern, script: WORKER });
      receipt.owned.push(route); save(path, receipt);
      assertRouteBoundary(before, await request('', token), receipt.owned);
    }
    receipt.status = 'attached'; save(path, receipt);
    // The two exact routes are now in production. A failed live check rolls back only these IDs.
    const verified = await verifyFeedsEventually();
    receipt.status = 'verified'; receipt.live = verified; save(path, receipt);
    return { status: receipt.status, ownedRouteIds: receipt.owned.map(route => route.id), live: verified };
  }
  assert.equal(command, 'recover');
  if (!existsSync(path)) return { status: 'no-receipt' };
  const receipt = JSON.parse(readFileSync(path));
  for (const [key, expected] of Object.entries({ controllerSha: env.GITHUB_SHA, sourceSha: SOURCE,
    runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT })) assert.equal(receipt[key], expected, `${key} changed`);
  let current = await request('', token);
  assertRouteBoundary(receipt.before, current, receipt.owned);
  for (const route of [...receipt.owned].reverse()) {
    await request('/' + route.id, token, 'DELETE');
    current = await request('', token);
    receipt.owned.pop(); save(path, receipt);
    assertRouteBoundary(receipt.before, current, receipt.owned);
  }
  receipt.recovery = 'owned-routes-removed'; save(path, receipt);
  return { status: receipt.recovery };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`production feed route operation refused: ${error.message}`); process.exitCode = 1;
  });
}
