#!/usr/bin/env node
// One-source, one-Worker release. Never changes data, secrets, routes, or purchases.
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { activeVersion, assertSettings, expectedBindings, normalizedBindings } from './consumer-refresh.mjs';

const exec = promisify(execFile);
const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const WORKER = 'weatherx-platform-edge-production';
const SOURCE = '7497b9815f1f5ca657cda8ed24ad5894afa267e0';
const CATALOG = 'prod-wind100-recurring-35921335025-1';
const WORKFLOW = 'Andrewegao/v3t7kq-cycle/.github/workflows/platform-wind100-worker-release.yml@refs/heads/main';
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function validateReleaseConfig(config) {
  const production = config?.env?.production;
  assert.equal(config?.compatibility_date, '2026-08-15');
  assert.deepEqual(config?.compatibility_flags, ['nodejs_compat']);
  assert.equal(production?.name, WORKER);
  assert.equal(production.vars?.APP_ORIGIN, 'https://weatherx.org');
  assert.equal(production.vars?.AUTH_MODE, 'observe');
  assert.equal(production.vars?.BILLING_MODE, 'enabled');
  assert.equal(production.vars?.BILLING_PURCHASE_MODE, 'closed');
  assert.equal(production.vars?.PRODUCTION_WIND100_DYNAMIC_ENABLED, '1');
  assert.ok(production.routes?.some(row => row.pattern === 'weatherx.org/api/platform/production-wind100/*'));
  // Wrangler inherits these top-level runtime settings into every environment.
  return { ...production, compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags };
}

export function uploadedVersion(output) {
  const id = output.match(/Worker Version ID:\s*([a-f0-9-]{36})/)?.[1];
  assert.match(id ?? '', UUID, 'Wrangler did not return one candidate version');
  return id;
}

export function validateLiveSelector(value) {
  assert.equal(value?.schemaVersion, 1);
  assert.equal(value.kind, 'production-native-wind100-selector');
  assert.equal(value.catalogId, CATALOG);
  assert.equal(value.runId, '2026092312');
  assert.match(value.selectionSha256 ?? '', /^[a-f0-9]{64}$/);
  return value;
}

export function bindingDrift(config, liveBindings) {
  // Never log binding values or unexpected names: either may contain private data.
  const expected = expectedBindings(config);
  const actual = normalizedBindings(liveBindings);
  const byName = new Map(actual.map(binding => [binding.name, binding]));
  const expectedNames = new Set(expected.map(binding => binding.name));
  return {
    missingOrChangedExpectedNames: expected.filter(binding =>
      JSON.stringify(binding) !== JSON.stringify(byName.get(binding.name))).map(binding => binding.name),
    unexpectedCount: actual.filter(binding => !expectedNames.has(binding.name)).length,
  };
}

export function disabledPreviousConfig(config, liveBindings) {
  const previous = structuredClone(config);
  const flagName = 'PRODUCTION_WIND100_DYNAMIC_ENABLED';
  const matches = liveBindings.filter(binding => binding.name === flagName);
  assert.ok(matches.length <= 1, 'duplicate production Wind100 flag');
  if (matches.length === 0) {
    // Older live versions omit the optional flag; the Worker treats absence as disabled.
    delete previous.vars[flagName];
  } else {
    assert.deepEqual(matches[0], { name: flagName, type: 'plain_text', text: '0' },
      'live production Wind100 flag is not disabled');
    previous.vars[flagName] = '0';
  }
  return previous;
}

function context(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_WORKFLOW_REF, WORKFLOW);
  assert.equal(env.GITHUB_JOB, 'release');
  assert.equal(env.WORKER_RELEASE_ENVIRONMENT, 'production');
  assert.equal(env.ATMOS_SHA, SOURCE);
  assert.ok(env.PLATFORM_EDGE_TOKEN, 'dedicated Worker token required');
  assert.ok(!env.CLOUDFLARE_DATA_EDGE_API_TOKEN && !env.UI_PRODUCTION_PAGES_TOKEN,
    'unrelated release credentials are forbidden');
  assert.match(env.RECEIPT ?? '', /^\//);
  assert.match(env.ATMOS_ROOT ?? '', /^\//);
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: env.ATMOS_ROOT, encoding: 'utf8' }).trim();
  assert.equal(actual, SOURCE, 'source checkout changed');
  const config = JSON.parse(readFileSync(resolve(env.ATMOS_ROOT, 'platform/edge/wrangler.jsonc')));
  return { env, config: validateReleaseConfig(config),
    wrangler: resolve(env.ATMOS_ROOT, 'platform/edge/node_modules/wrangler/bin/wrangler.js'),
    cwd: resolve(env.ATMOS_ROOT, 'platform/edge') };
}

async function api(path, token) {
  const response = await fetch(`${API}${path}`, { redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200, 'Worker API read failed');
  const value = await response.json();
  assert.equal(value?.success, true, 'Worker API rejected read');
  return value.result;
}
const current = token => api('/deployments', token).then(activeVersion);

async function runWrangler(ctx, args) {
  try {
    const result = await exec(process.execPath, [ctx.wrangler, ...args, '--config', 'wrangler.jsonc', '--env', 'production'],
      { cwd: ctx.cwd, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true', NO_COLOR: '1',
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: ctx.env.PLATFORM_EDGE_TOKEN } });
    return result.stdout;
  } catch { throw Error(`Wrangler ${args[0]} failed`); }
}

function save(path, receipt) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

async function verifyLive(candidate, token) {
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      assert.equal(await current(token), candidate, 'candidate is not the active Worker');
      const health = await fetch('https://weatherx.org/api/platform/health',
        { redirect: 'error', signal: AbortSignal.timeout(10_000), cache: 'no-store' });
      assert.equal(health.status, 200, `health returned HTTP ${health.status}`);
      assert.deepEqual(await health.json(), { ok: true, authMode: 'observe',
        billingMode: 'enabled', billingPurchaseMode: 'closed' });
      const selector = await fetch('https://weatherx.org/api/platform/production-wind100/current',
        { redirect: 'error', signal: AbortSignal.timeout(10_000), cache: 'no-store' });
      assert.equal(selector.status, 200, `Wind100 selector returned HTTP ${selector.status}`);
      validateLiveSelector(await selector.json());
      return;
    } catch (error) {
      if (attempt === 11) throw Error('production Worker did not pass bounded live verification', { cause: error });
      await new Promise(done => setTimeout(done, 5000));
    }
  }
}

async function recover(ctx, receipt) {
  if (!receipt?.previous || !receipt?.candidate) return 'nothing-to-restore';
  const active = await current(ctx.env.PLATFORM_EDGE_TOKEN);
  if (active === receipt.previous) return 'prior-worker-already-active';
  assert.equal(active, receipt.candidate, 'a different publisher changed the Worker; refuse rollback');
  await runWrangler(ctx, ['rollback', receipt.previous, '--yes', '--message', 'Restore prior Worker after Wind100 release failure']);
  assert.equal(await current(ctx.env.PLATFORM_EDGE_TOKEN), receipt.previous, 'Worker rollback readback failed');
  return 'prior-worker-restored';
}

export async function main(command, env = process.env) {
  const ctx = context(env);
  if (command === 'recover') {
    if (!existsSync(env.RECEIPT)) return { status: 'no-receipt' };
    const receipt = JSON.parse(readFileSync(env.RECEIPT));
    const status = await recover(ctx, receipt);
    save(env.RECEIPT, { ...receipt, recovery: status });
    return { status };
  }
  assert.equal(command, 'release');
  const liveSettings = await api('/settings', env.PLATFORM_EDGE_TOKEN);
  const beforeConfig = disabledPreviousConfig(ctx.config, liveSettings.bindings);
  try { assertSettings(beforeConfig, liveSettings); }
  catch (error) {
    if (error.message === 'live bindings differ from reviewed configuration') {
      console.error(`Binding preflight (names/count only): ${JSON.stringify(bindingDrift(beforeConfig, liveSettings.bindings))}`);
    }
    throw error;
  }
  const previous = await current(env.PLATFORM_EDGE_TOKEN);
  const receipt = { schemaVersion: 1, kind: 'weatherx-platform-wind100-worker-release',
    sourceSha: SOURCE, controllerSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT, previous, status: 'preflight-passed' };
  save(env.RECEIPT, receipt);
  try {
    const output = await runWrangler(ctx, ['versions', 'upload', '--keep-vars', '--tag', `wind100-${SOURCE.slice(0, 12)}`,
      '--message', 'Enable verified production Wind100 selector']);
    receipt.candidate = uploadedVersion(output);
    save(env.RECEIPT, receipt);
    const version = await api(`/versions/${receipt.candidate}`, env.PLATFORM_EDGE_TOKEN);
    assert.equal(version.id, receipt.candidate);
    assertSettings(ctx.config, { ...version.resources.script_runtime, bindings: version.resources.bindings });
    assert.equal(await current(env.PLATFORM_EDGE_TOKEN), previous, 'Worker changed during candidate upload');
    await runWrangler(ctx, ['versions', 'deploy', `${receipt.candidate}@100%`, '--yes',
      '--message', 'Verified production Wind100 release']);
    receipt.status = 'activation-requested'; save(env.RECEIPT, receipt);
    await verifyLive(receipt.candidate, env.PLATFORM_EDGE_TOKEN);
    receipt.status = 'passed'; save(env.RECEIPT, receipt);
    return { status: 'passed', previous, candidate: receipt.candidate, sourceSha: SOURCE };
  } catch (error) {
    receipt.status = 'failed'; save(env.RECEIPT, receipt);
    try { receipt.recovery = await recover(ctx, receipt); save(env.RECEIPT, receipt); }
    catch { receipt.recovery = 'manual-inspection-required'; save(env.RECEIPT, receipt); }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`Platform Wind100 Worker release refused: ${error.message}${error.cause?.message ? ` (${error.cause.message})` : ''}`);
    process.exitCode = 1;
  });
}
