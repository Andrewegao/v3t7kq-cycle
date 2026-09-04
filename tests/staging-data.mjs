import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { preflight, validateHealth, ORIGIN } from '../tools/staging-data.mjs';
const platform = { ok: true, authMode: 'public', billingMode: 'disabled' };
const data = { ok: true, authMode: 'public', catalogMode: 'serve' };
test('actual old staging auth/billing modes fail before spending on collection', () => {
  validateHealth(platform, data);
  assert.throws(() => validateHealth({ ok: true, authMode: 'enforce', billingMode: 'enabled' }, data));
  assert.throws(() => validateHealth({ ...platform, billingMode: 'enabled' }, data));
  assert.throws(() => validateHealth(platform, { ...data, catalogMode: 'shadow' }));
  validateHealth(platform, { ...data, dataSource: 'shared', sharedReadConfigured: true, pin: null });
  assert.throws(() => validateHealth(platform, { ...data, dataSource: 'shared', sharedReadConfigured: false }), /credential/);
  assert.throws(() => validateHealth(platform, { ...data, dataSource: 'shared' }), /credential/);
  assert.throws(() => validateHealth(platform, { ...data, dataSource: 'mirror' }));
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
test('shared snapshot workflow never bakes, processes, promotes, or deploys UI', () => {
  const yaml = readFileSync(new URL('../.github/workflows/staging-data.yml', import.meta.url), 'utf8');
  const code = yaml.split('\n').filter(line => !/^\s*#/.test(line)).join('\n');
  assert.match(code, /environment:\n      name: data-staging/);
  assert.match(code, /runs-on: ubuntu-latest/);
  assert.match(code, /ref: dbc97a26bc239398ffa9ec157a094148961b6451/);
  assert.match(code, /group: weatherx-shared-staging-preparation/);
  assert.match(code, /cancel-in-progress: false/);
  assert.doesNotMatch(code, /production|pages|wrangler|schedule:|workflow_run:|workflow_call:|actions\/cache|actions\/upload-artifact|bake-model|pip install|setup-python|catalog-mutation/i);
  const secrets = [...new Set([...code.matchAll(/secrets\.([A-Z_0-9]+)/g)].map(m => m[1]))].sort();
  assert.deepEqual(secrets, ['ATMOS_DEPLOY_KEY','SHARED_R2_READ_ACCESS_KEY_ID','SHARED_R2_READ_SECRET_ACCESS_KEY','STAGING_R2_WRITE_ACCESS_KEY_ID','STAGING_R2_WRITE_SECRET_ACCESS_KEY']);
  assert.doesNotMatch(code, /secrets\[|secrets:\s*inherit|(?:contents|actions|deployments):\s*write/);
  assert.ok(code.indexOf('shared-data.mjs gate') < code.indexOf('repository: Andrewegao/atmos'));
  assert.match(code,/shared-data.mjs prepare/);
  for (const [, action] of code.matchAll(/uses:\s*(\S+)/g)) assert.match(action, /@[a-f0-9]{40}$/);
});
