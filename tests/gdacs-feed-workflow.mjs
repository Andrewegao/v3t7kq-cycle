import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/gdacs-feed-release.yml', import.meta.url), 'utf8');
const source = readFileSync(new URL('../tools/gdacs-feed-release.mjs', import.meta.url), 'utf8');
assert.match(workflow, /workflow_dispatch:/);
assert.doesNotMatch(workflow, /^  (?:schedule|push|pull_request):/m);
assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
assert.match(workflow, /environment: production/);
assert.match(workflow, /group: weatherx-ui-production\s+cancel-in-progress: false/);
assert.match(workflow, /REPAIR-GDACS-LIST-ONLY/);
assert.match(workflow, /ref: \$\{\{ inputs\.atmos_sha \}\}/);
assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
assert.match(workflow, /merge-base --is-ancestor/);
assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
assert.match(workflow, /npm ci/);
assert.match(workflow, /npm run check/);
for (const operation of ['preflight', 'execute', 'recover']) {
  assert.match(workflow, new RegExp(`gdacs-feed-release\\.mjs ${operation}`));
}
assert.match(workflow, /always\(\).*steps\.repair\.outcome == 'failure'.*steps\.repair\.outcome == 'cancelled'/);
assert.ok(workflow.indexOf('Run complete platform') < workflow.indexOf('gdacs-feed-release.mjs preflight'));
assert.ok(workflow.indexOf('gdacs-feed-release.mjs preflight') < workflow.indexOf('gdacs-feed-release.mjs execute'));
assert.equal((workflow.match(/--expected-release "\$EXPECTED_RELEASE"/g) ?? []).length, 3);
assert.equal((workflow.match(/FEED_RECEIPT: \$\{\{ runner\.temp \}\}\/gdacs-feed\/receipt\.json/g) ?? []).length, 3);
assert.equal((workflow.match(/PAGES_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/g) ?? []).length, 3);
assert.equal((workflow.match(/path: \$\{\{ runner\.temp \}\}\/gdacs-feed\/receipt\.json/g) ?? []).length, 1);
assert.doesNotMatch(workflow, /wrangler deploy|pages deploy|bake\.sh|consumer-refresh\.mjs execute|secrets-file|secret bulk|VITE_PLATFORM_ACCOUNT/);
assert.match(source, /weatherx-gdacs-feed-production/);
assert.match(source, /weatherx\.org\/api\/gdacs\/list\*/);
console.log('GDACS workflow immutable source, serialized publication, existing gates and always-recovery contracts passed');
