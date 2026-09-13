import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../.github/workflows/observation-bake.yml', import.meta.url), 'utf8');
const fullBake = await readFile(new URL('../.github/workflows/bake.yml', import.meta.url), 'utf8');
const step = name => {
  const marker = `      - name: ${name}`;
  const body = source.split(marker)[1]?.split('\n      - name:')[0];
  assert.ok(body, `missing workflow step: ${name}`);
  return body;
};

assert.match(source, /name: observation-bake/);
assert.match(source, /cron: '10 2,8,14,20 \* \* \*'/);
assert.match(source, /\n  workflow_dispatch:\s*\n/);
assert.match(source, /\n      group: weatherx-data-maintenance\n      cancel-in-progress: false/);
assert.match(fullBake, /cron: '30 2,8,14,20 \* \* \*'/);
assert.match(fullBake, /\n      group: weatherx-data-maintenance\n      cancel-in-progress: false/);
assert.match(source, /\n    environment: production\n/);
assert.match(source, /\n    timeout-minutes: 60\n/);
assert.match(source, /name: pinned observation runtime[\s\S]*?python-version: '3\.12'/);
assert.match(source, /name: pinned release-manifest runtime[\s\S]*?node-version: 22/);

const approvedSha = '14a2cda498ffb499cbd0fe2410d3818e364fe4d0';
assert.match(source, new RegExp(`repository: weatherx-hq/atmos\\n\\s+ref: ${approvedSha}`));
assert.ok(source.split(approvedSha).length - 1 >= 3, 'checkout and both source guards retain the exact approved SHA');
assert.match(source, /name: checkout bounded Atmos master ancestry witness[\s\S]*?ref: master[\s\S]*?fetch-depth: 64/);
const ancestry = step('refuse an observation source absent from Atmos master');
assert.match(ancestry, /cat-file -e "\$ATMOS_SHA\^\{commit\}"/);
assert.match(ancestry, /merge-base --is-ancestor "\$ATMOS_SHA" HEAD/);
assert.match(step('verify exact immutable observation source'), /git diff --exit-code HEAD/);

const hydrate = step('hydrate and verify current production whole release');
const observe = step('refresh independent point observations without publication credentials');
const publish = step('verify, upload, and conditionally promote one immutable whole release');
assert.ok(source.indexOf('hydrate and verify current production whole release')
  < source.indexOf('refresh independent point observations without publication credentials'));
assert.ok(source.indexOf('refresh independent point observations without publication credentials')
  < source.indexOf('verify, upload, and conditionally promote one immutable whole release'));
assert.match(hydrate, /R2_REMOTE: weatherx:weatherx-data-production/);
assert.match(hydrate, /secrets\.R2_PRODUCTION_ACCESS_KEY_ID/);
assert.match(hydrate, /secrets\.R2_PRODUCTION_SECRET_ACCESS_KEY/);
assert.match(hydrate, /bash ops\/platform\/hydrate-r2-release\.sh/);
assert.doesNotMatch(hydrate, /OPENAQ|CATALOG_/);
assert.match(observe, /OPENAQ_API_KEY: \$\{\{ secrets\.OPENAQ_API_KEY \}\}/);
assert.match(observe, /OPENAQ_API_KEY:\?production OPENAQ_API_KEY is required/);
assert.match(observe, /bash ops\/bake-observation-points\.sh/);
assert.doesNotMatch(observe, /R2_|CATALOG_|publish-r2-release/);
assert.match(publish, /POINT_SERIES_REQUIRED: '1'/);
assert.match(publish, /RELEASE_ID: cycle-observations-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
assert.match(publish, /secrets\.R2_PRODUCTION_ACCESS_KEY_ID/);
assert.match(publish, /secrets\.R2_PRODUCTION_SECRET_ACCESS_KEY/);
assert.match(publish, /secrets\.CATALOG_ENDPOINT_PRODUCTION/);
assert.match(publish, /secrets\.CATALOG_PROMOTION_KEY_PRODUCTION/);
assert.match(publish, /EXPECTED_CURRENT_RELEASE_ID="\$\(bash ops\/platform\/read-current-r2-release\.sh\)"/);
assert.ok(publish.indexOf('read-current-r2-release.sh') < publish.indexOf('publish-r2-release.sh'));
assert.doesNotMatch(publish, /OPENAQ_API_KEY/);

const allowedSecrets = new Set(['ATMOS_DEPLOY_KEY', 'OPENAQ_API_KEY', 'R2_PRODUCTION_ACCESS_KEY_ID',
  'R2_PRODUCTION_SECRET_ACCESS_KEY', 'CATALOG_ENDPOINT_PRODUCTION', 'CATALOG_PROMOTION_KEY_PRODUCTION']);
for (const [, secret] of source.matchAll(/secrets\.([A-Za-z0-9_]+)/g))
  assert.ok(allowedSecrets.has(secret), `unexpected observation workflow credential: ${secret}`);
for (const [, action, version] of source.matchAll(/uses: ([^@\s]+)@([^\s]+)/g))
  assert.match(version, /^[a-f0-9]{40}$/, `${action} must use an immutable action pin`);
assert.doesNotMatch(source, /bake-weatherx\.sh|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|STAGING_|VAULT_|PAGES_|wrangler|gh workflow run|\/dispatches\b/);

console.log('observation bake workflow authority and publication contracts: ok');
