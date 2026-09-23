#!/usr/bin/env node
// Attach only the reviewed Wind100 route; restore only this run's owned route on failure.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZONE = '9dc4df7c3c094ab9a11dd00d378adc26';
const WORKER = 'weatherx-platform-edge-production';
const PATTERN = 'weatherx.org/api/platform/production-wind100/*';
const SOURCE = '7497b9815f1f5ca657cda8ed24ad5894afa267e0';
const WORKFLOW = 'Andrewegao/v3t7kq-cycle/.github/workflows/platform-wind100-worker-release.yml@refs/heads/main';
const URL = `https://api.cloudflare.com/client/v4/zones/${ZONE}/workers/routes`;
const ID = /^[a-f0-9]{32}$/;

export function assertAbsent(routes) {
  assert.ok(Array.isArray(routes));
  assert.ok(routes.some(route => route.pattern === 'weatherx.org/api/platform/health' && route.script === WORKER),
    'production platform route missing');
  assert.ok(!routes.some(route => route.pattern === PATTERN), 'Wind100 route already exists');
}

export function assertOwned(before, after, owned) {
  assert.match(owned.id, ID);
  assert.deepEqual({ pattern: owned.pattern, script: owned.script }, { pattern: PATTERN, script: WORKER });
  assert.ok(!before.some(route => route.id === owned.id), 'route ID was already present');
  const added = after.find(route => route.id === owned.id);
  assert.deepEqual(added && { id: added.id, pattern: added.pattern, script: added.script },
    { id: owned.id, pattern: PATTERN, script: WORKER }, 'owned route changed');
  assert.deepEqual(after.filter(route => route.id !== owned.id).sort((a, b) => a.id.localeCompare(b.id)),
    [...before].sort((a, b) => a.id.localeCompare(b.id)), 'production route boundary changed');
}

function context(env) {
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: WORKFLOW,
    GITHUB_JOB: 'release', WORKER_RELEASE_ENVIRONMENT: 'production', ATMOS_SHA: SOURCE })) {
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
  assert.ok(config.env.production.routes?.some(route => route.pattern === PATTERN));
  assert.equal(config.env.production.vars?.PRODUCTION_WIND100_DYNAMIC_ENABLED, '1');
  return env;
}

async function request(path, token, method = 'GET', body) {
  const response = await fetch(URL + path, { method, redirect: 'error',
    signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  // Cloudflare errors can contain sensitive account data; log only status.
  assert.ok(response.ok, `route API ${method} returned HTTP ${response.status}`);
  const result = await response.json();
  assert.equal(result.success, true, `route API ${method} refused request`);
  return result.result;
}

function save(path, receipt) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
}

export async function main(command, env = process.env) {
  context(env);
  const path = env.ROUTE_RECEIPT;
  const token = env.DATA_EDGE_TOKEN;
  if (command === 'attach') {
    assert.ok(!existsSync(path), 'route receipt already exists');
    const before = await request('', token);
    assertAbsent(before);
    const receipt = { schemaVersion: 1, kind: 'weatherx-production-wind100-route',
      controllerSha: env.GITHUB_SHA, sourceSha: SOURCE, runId: env.GITHUB_RUN_ID,
      attempt: env.GITHUB_RUN_ATTEMPT, before, status: 'create-intent' };
    save(path, receipt);
    const owned = await request('', token, 'POST', { pattern: PATTERN, script: WORKER });
    receipt.owned = owned; save(path, receipt);
    assertOwned(before, await request('', token), owned);
    receipt.status = 'attached'; save(path, receipt);
    return { status: 'attached', routeId: owned.id };
  }
  assert.equal(command, 'recover');
  if (!existsSync(path)) return { status: 'no-receipt' };
  const receipt = JSON.parse(readFileSync(path));
  for (const [key, expected] of Object.entries({ controllerSha: env.GITHUB_SHA,
    sourceSha: SOURCE, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT })) {
    assert.equal(receipt[key], expected, `${key} changed`);
  }
  if (!receipt.owned) {
    // A lost POST response cannot prove route ownership. Refuse speculative deletion.
    assertAbsent(await request('', token));
    receipt.recovery = 'no-owned-route'; save(path, receipt);
    return { status: receipt.recovery };
  }
  const routes = await request('', token);
  if (!routes.some(route => route.id === receipt.owned.id)) {
    assert.deepEqual([...routes].sort((a, b) => a.id.localeCompare(b.id)),
      [...receipt.before].sort((a, b) => a.id.localeCompare(b.id)),
      'route boundary changed after owned route vanished');
    receipt.recovery = 'owned-route-absent'; save(path, receipt);
    return { status: receipt.recovery };
  }
  assertOwned(receipt.before, routes, receipt.owned);
  await request('/' + receipt.owned.id, token, 'DELETE');
  assert.deepEqual((await request('', token)).sort((a, b) => a.id.localeCompare(b.id)),
    [...receipt.before].sort((a, b) => a.id.localeCompare(b.id)),
    'route boundary changed after rollback');
  receipt.recovery = 'owned-route-removed'; save(path, receipt);
  return { status: receipt.recovery };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`Wind100 route operation refused: ${error.message}`); process.exitCode = 1;
  });
}
