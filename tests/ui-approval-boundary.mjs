import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { gate, FREEZE_UNTIL, REPOSITORY } from '../tools/ui-candidate.mjs';

const directory = new URL('../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(readdirSync(directory).filter(n => /\.ya?ml$/.test(n))
  .map(n => [n, readFileSync(new URL(n, directory), 'utf8')]));
const executable = source => source.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
const dataKeys = ['ATMOS_DEPLOY_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY'];
const componentKeys = [...dataKeys, 'CATALOG_ENDPOINT', 'CATALOG_ENDPOINT_PRODUCTION',
  'CATALOG_PROMOTION_KEY', 'CATALOG_PROMOTION_KEY_PRODUCTION'];

function assertDataOnly(source, allowedKeys) {
  const text = executable(source);
  assert.doesNotMatch(text, /secrets\s*\[|secrets:\s*inherit/);
  for (const [, key] of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g))
    assert.ok(allowedKeys.includes(key), `data job must not receive ${key}`);
  assert.doesNotMatch(text, /(?:actions|contents|deployments):\s*write|write-all/);
  assert.doesNotMatch(text, /\bpages\s+(?:deploy|deployment)|deploy-(?:atmos|code-only)\.sh|guard-pages-deploy|ui-release\.mjs/);
  assert.doesNotMatch(text, /gh\s+(?:workflow\s+run|api)|\/dispatches\b|workflow_dispatch\s*\(/);
  assert.doesNotMatch(text, /uses:\s*[^\n]*(?:ui-release|ui-staging)/);
}

test('both data bakes and legacy backfill have no UI credential or dispatch capability', () => {
  assertDataOnly(workflows['bake.yml'], dataKeys);
  assertDataOnly(workflows['catalog-bake.yml'], componentKeys);
  assertDataOnly(workflows['verify-backfill.yml'], ['ATMOS_DEPLOY_KEY']);
  assert.match(workflows['bake.yml'], /DATA_PUBLISH_MODE: r2-release/);
  assert.match(workflows['catalog-bake.yml'], /bash ops\/bake-model-component\.sh/);
  const stagingBake=workflows['catalog-bake.yml'].slice(workflows['catalog-bake.yml'].indexOf('Bake, validate, upload, and CAS-promote one staging model'));
  assert.match(stagingBake,/CATALOG_R2_REMOTE: weatherx:weatherx-data-staging/);
  assert.match(stagingBake,/COMPONENT_R2_REMOTE: weatherx:weatherx-components-staging/);
  assert.doesNotMatch(stagingBake,/production|R2_PRODUCTION|CATALOG_ENDPOINT_PRODUCTION/);
});

test('boundary contracts reject legacy key, new UI key, dispatch, inherited secrets and direct upload', () => {
  for (const violation of ['TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    'TOKEN: ${{ secrets.UI_PRODUCTION_PAGES_TOKEN }}', 'TOKEN: ${{ secrets[inputs.key] }}',
    'secrets: inherit', 'actions: write', 'run: gh workflow run ui-release.yml',
    'run: curl https://api.github.com/repos/owner/repo/actions/workflows/ui-release.yml/dispatches',
    'run: npx wrangler pages deploy dist', 'run: bash deploy-atmos.sh']) {
    assert.throws(() => assertDataOnly(`${workflows['bake.yml']}\n${violation}`, dataKeys), violation);
  }
});

test('only the protected promotion workflow references the production UI credential', () => {
  for (const [name, source] of Object.entries(workflows)) {
    assert.doesNotMatch(source, /secrets\.CLOUDFLARE_API_TOKEN\b/, `${name}: retired repository-wide Pages credential`);
    if (name !== 'ui-release.yml') assert.doesNotMatch(source, /secrets\.UI_PRODUCTION_PAGES_TOKEN\b/, name);
  }
  assert.match(workflows['ui-release.yml'], /\n    environment:\n      name: ui-production\n/);
  assert.match(workflows['ui-release.yml'], /CLOUDFLARE_API_TOKEN: \$\{\{ secrets.UI_PRODUCTION_PAGES_TOKEN \}\}/);
  assert.match(workflows['gdacs-feed-release.yml'], /PAGES_TOKEN: \$\{\{ secrets.PAGES_READ_TOKEN \}\}/);
});

test('both UI entry points are manual only; bake completion cannot trigger promotion', () => {
  for (const name of ['ui-release.yml', 'ui-staging.yml']) {
    const source = workflows[name];
    const events = source.slice(source.indexOf('\non:\n') + 1, source.indexOf('\npermissions:'));
    assert.match(events, /^on:\n  workflow_dispatch:/);
    assert.deepEqual(events.split('\n').filter(l => /^  [a-z_]+:/.test(l)).map(l => l.trim().split(':')[0]),
      ['workflow_dispatch']);
  }
});

test('retained ground-package approval is scoped to staging and never production', () => {
  assert.match(workflows['ui-staging.yml'], /WX_GROUND_QUALIFICATION_SCOPE: staging-qualification-only/);
  assert.doesNotMatch(workflows['ui-release.yml'], /WX_GROUND_QUALIFICATION_SCOPE/);
});

test('runtime gate rejects every nonmanual event and every unprotected ref', () => {
  const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', UI_RELEASES_ENABLED: 'true', UI_ISOLATION_APPROVED: 'true',
    UI_DEPLOYMENT_HOLD_UNTIL: FREEZE_UNTIL };
  const now = Date.parse(FREEZE_UNTIL) + 1;
  gate(env, now);
  for (const event of ['schedule', 'push', 'workflow_run', 'workflow_call', 'repository_dispatch', 'pull_request', ''])
    assert.throws(() => gate({ ...env, GITHUB_EVENT_NAME: event }, now));
  for (const ref of ['refs/heads/feature', 'refs/tags/main', 'refs/pull/1/merge', ''])
    assert.throws(() => gate({ ...env, GITHUB_REF: ref }, now));
});
