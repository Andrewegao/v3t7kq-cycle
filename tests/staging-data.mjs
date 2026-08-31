import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { gate, preflight, validateHealth, ORIGIN } from '../tools/staging-data.mjs';
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  STAGING_DATA_ENABLED: 'true', STAGING_DATA_ISOLATION_APPROVED: 'true', ATMOS_SHA: 'a'.repeat(40),
  STAGING_DATA_APPROVED_SHA: 'a'.repeat(40), STAGING_R2_ACCOUNT_ID: 'b'.repeat(32), MODEL: 'ecmwf' };
const platform = { ok: true, authMode: 'public', billingMode: 'disabled' };
const data = { ok: true, authMode: 'public', catalogMode: 'serve' };
test('cloud-only gate requires all activation and identity controls', () => {
  gate(env);
  for (const key of Object.keys(env)) assert.throws(() => gate({ ...env, [key]: '' }), key);
  for (const patch of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'schedule' },
    { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_REF: 'refs/heads/feature' },
    { ATMOS_SHA: 'c'.repeat(40) }, { MODEL: 'nam' }]) assert.throws(() => gate({ ...env, ...patch }));
});
test('actual old staging auth/billing modes fail before spending on collection', () => {
  validateHealth(platform, data);
  assert.throws(() => validateHealth({ ok: true, authMode: 'enforce', billingMode: 'enabled' }, data));
  assert.throws(() => validateHealth({ ...platform, billingMode: 'enabled' }, data));
  assert.throws(() => validateHealth(platform, { ...data, catalogMode: 'shadow' }));
});
test('preflight only GETs fixed staging health URLs, without credentials or redirects', async () => {
  const calls = [];
  await preflight(async (url, init) => {
    calls.push(url); assert.equal(init.redirect, 'error'); assert.equal(init.headers, undefined);
    return Response.json(url.endsWith('/data-health') ? data : platform);
  });
  assert.deepEqual(calls, [ORIGIN + '/api/platform/health', ORIGIN + '/api/platform/data-health']);
});
test('401, HTML, oversized, and malformed responses cannot qualify', async () => {
  for (const [body, init] of [['denied', { status: 401 }], ['<html>', {}],
    ['x'.repeat(8193), { headers: { 'content-type': 'application/json' } }],
    ['{', { headers: { 'content-type': 'application/json' } }]]) {
    await assert.rejects(preflight(async () => new Response(body, init)));
  }
});
test('workflow has no production/UI authority, schedule, local bake, or cross-environment cache', () => {
  const yaml = readFileSync(new URL('../.github/workflows/staging-data.yml', import.meta.url), 'utf8');
  const code = yaml.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.match(code, /environment:\n      name: data-staging/);
  assert.match(code, /runs-on: ubuntu-latest/);
  assert.match(code, /ref: \$\{\{ inputs.atmos_sha \}\}/);
  assert.match(code, /group: weatherx-component-staging-\$\{\{ matrix.model \}\}/);
  assert.match(code, /cancel-in-progress: false/);
  assert.doesNotMatch(code, /production|pages|wrangler|schedule:|workflow_run:|workflow_call:|actions\/cache|actions\/upload-artifact/i);
  const secrets = [...new Set([...code.matchAll(/secrets\.([A-Z_0-9]+)/g)].map(m => m[1]))].sort();
  assert.deepEqual(secrets, ['ATMOS_DEPLOY_KEY', 'STAGING_CATALOG_PROMOTION_KEY', 'STAGING_R2_OBJECT_TOKEN']);
  assert.doesNotMatch(code, /secrets\[|secrets:\s*inherit|(?:contents|actions|deployments):\s*write/);
  assert.ok(code.indexOf('staging-data.mjs preflight') < code.indexOf('repository: Andrewegao/atmos'));
  for (const [, action] of code.matchAll(/uses:\s*(\S+)/g)) assert.match(action, /@[a-f0-9]{40}$/);
});
