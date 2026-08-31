import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const readWorkflow = (name) => readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const [bake, ui, staging, backfill] = await Promise.all([
  readWorkflow('bake.yml'),
  readWorkflow('ui-release.yml'),
  readWorkflow('ui-staging.yml'),
  readWorkflow('verify-backfill.yml'),
]);
const workflowDirectory = new URL('../.github/workflows/', import.meta.url);
const workflowNames = (await readdir(workflowDirectory)).filter((name) => name.endsWith('.yml'));
for (const workflowName of workflowNames) {
  const workflow = await readWorkflow(workflowName);
  for (const line of workflow.split('\n').filter((candidate) => /\buses:/.test(candidate))) {
    assert.match(line, /@[a-f0-9]{40}(?:\s+#.*)?$/,
      `${workflowName} must pin every external action to a full commit SHA: ${line.trim()}`);
  }
  if (/secrets\./.test(workflow)) {
    assert.match(workflow, /\n\s{4}environment:\s*(?:production|staging|\n)/,
      `${workflowName} must place secret-bearing jobs behind a protected environment`);
  }
}

assert.match(bake, /group: weatherx-data-maintenance/,
  'the multi-hour data bake must not occupy the UI release lane');
assert.match(bake, /DATA_PUBLISH_MODE: r2-release/,
  'the multi-hour bake must publish an immutable R2 release instead of Pages');
assert.match(bake, /R2_REMOTE: weatherx:weatherx-data-production/);
assert.match(bake, /R2_PRODUCTION_ACCESS_KEY_ID/);
assert.match(bake, /R2_PRODUCTION_SECRET_ACCESS_KEY/);
assert.doesNotMatch(bake, /CLOUDFLARE_API_TOKEN\b|deploy-atmos\.sh|deploy-code-only\.sh|code_only/,
  'the data-maintenance workflow must have no Pages deployment capability');

assert.match(ui, /group: weatherx-ui-production/,
  'UI releases need their own short production serialization boundary');
assert.match(ui, /environment:[\s\S]*?name: ui-production/);
assert.match(staging, /environment:[\s\S]*?name: ui-staging/);
for (const workflow of [ui, staging]) {
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  (push|schedule|workflow_run|repository_dispatch|workflow_call|pull_request):/m);
  assert.match(workflow, /UI_RELEASES_ENABLED: \$\{\{ vars.UI_RELEASES_ENABLED \}\}/);
  assert.match(workflow, /UI_DEPLOYMENT_HOLD_UNTIL:/);
  assert.match(workflow, /UI_ISOLATION_APPROVED:/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN\b/,'legacy repo-wide Pages key must not bypass environment boundaries');
  assert.match(workflow, /persist-credentials: false/);
}
for (const input of ['atmos_sha','staging_run_id','candidate_digest']) assert.ok(ui.includes(`${input}:`));
assert.match(ui, /node cycle\/tools\/ui-release.mjs download/);
assert.match(ui, /node cycle\/tools\/ui-release.mjs deploy production/);
assert.doesNotMatch(ui, /deploy-code-only|deploy-atmos|npm (?:run )?build|ref: \$\{\{ inputs\.atmos_sha/,
  'production must not rebuild or check out the candidate source');
assert.match(staging, /test "\$ATMOS_SHA" = "\$\(git rev-parse origin\/master\)"/);
assert.match(staging, /ref: \$\{\{ inputs\.atmos_sha \}\}/);
assert.match(staging, /npm test --prefix atmos\/app/);
assert.match(staging, /LIVE_DATA: '1'[\s\S]*?bash ops\/weather-lab-ready.sh/);
assert.match(staging, /VITE_PLATFORM_ACCOUNT: '0'/);
assert.match(staging, /VITE_MODEL_EXPANSION_QUALIFICATION: '0'/);
assert.match(staging, /secrets.UI_STAGING_PAGES_TOKEN/);
assert.doesNotMatch(staging, /UI_PRODUCTION_PAGES_TOKEN/);
assert.match(ui, /secrets.UI_PRODUCTION_PAGES_TOKEN/);
assert.doesNotMatch(ui, /UI_STAGING_PAGES_TOKEN/);
assert.match(staging, /ui-sealed\/\*/);
assert.doesNotMatch(staging, /path:.*(?:app\/dist|app\/functions|control\/|atmos\/)/);
assert.doesNotMatch(backfill, /CLOUDFLARE_API_TOKEN|deploy-atmos|deploy-code-only/,'archive backfill must not publish UI');
assert.doesNotMatch(ui, /R2_PRODUCTION_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|publish-r2-release|bake-weatherx/,
  'the UI lane must not mutate model, ledger, or R2 release state');
assert.match(staging, /node ops\/platform\/test-independent-ui-release\.mjs/);
assert.match(staging, /name: full application test gate[\s\S]*?npm test --prefix atmos\/app/,
  'the release job must independently rerun the complete application tests');
assert.match(staging, /name: Weather Lab release gate[\s\S]*?LIVE_DATA: '1'[\s\S]*?bash ops\/weather-lab-ready\.sh/,
  'the independent UI gate must exercise the live data edge without mirroring data into Pages');
assert.match(ui, /actions\/upload-artifact@[a-f0-9]{40}[\s\S]*?ui-incidents/,
  'rollback evidence must survive a failed UI release');
assert.doesNotMatch(ui, /uses:\s+[^\n#]+@v[0-9]/,
  'production workflows must pin every action to an immutable commit SHA');

console.log('independent UI release workflow contract: ok');
