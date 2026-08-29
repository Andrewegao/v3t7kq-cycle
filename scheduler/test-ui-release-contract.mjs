import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const readWorkflow = (name) => readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const [bake, ui] = await Promise.all([
  readWorkflow('bake.yml'),
  readWorkflow('ui-release.yml'),
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
assert.match(ui, /atmos_sha:[\s\S]*?required: true/,
  'UI releases must name an immutable Atmos commit');
assert.match(ui, /environment:[\s\S]*?name: production/,
  'the Pages credential must be gated by the production environment');
assert.match(ui, /repository: Andrewegao\/atmos/);
assert.match(ui, /ref: \$\{\{ inputs\.atmos_sha \}\}/,
  'the UI artifact must be checked out from the requested immutable commit');
assert.match(ui, /test "\$ATMOS_SHA" = "\$\(git rev-parse origin\/master\)"/,
  'the requested commit must be the current Atmos master head');
assert.match(ui, /RELEASE_GUARD_EXPECTED_GIT_SHA: \$\{\{ inputs\.atmos_sha \}\}/,
  'the release guard must bind the live receipt to the requested source commit');
assert.match(ui, /RELEASE_GUARD_VERIFY_REQUIRED_SUCCESSES: '3'/,
  'production acceptance must require a bounded healthy soak');
assert.match(ui, /bash ops\/platform\/deploy-code-only\.sh/,
  'the UI lane must deploy the data-free application shell');
assert.match(ui, /PLATFORM_EDGE_CONFIRMED: '1'/,
  'the UI lane must explicitly require the production data edge');
assert.match(ui, /secrets\.CLOUDFLARE_API_TOKEN/,
  'the UI lane alone owns the guarded Pages credential');
assert.doesNotMatch(ui, /R2_PRODUCTION_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|publish-r2-release|bake-weatherx/,
  'the UI lane must not mutate model, ledger, or R2 release state');
assert.match(ui, /node ops\/platform\/test-independent-ui-release\.mjs/);
assert.match(ui, /name: full application test gate[\s\S]*?npm test --prefix app/,
  'the release job must independently rerun the complete application tests');
assert.match(ui, /name: Weather Lab release gate[\s\S]*?LIVE_DATA: '1'[\s\S]*?bash ops\/weather-lab-ready\.sh/,
  'the independent UI gate must exercise the live data edge without mirroring data into Pages');
assert.match(ui, /bash ops\/weather-lab-ready\.sh/);
assert.match(ui, /actions\/upload-artifact@[a-f0-9]{40}[\s\S]*?release-guard/,
  'rollback evidence must survive a failed UI release');
assert.doesNotMatch(ui, /uses:\s+[^\n#]+@v[0-9]/,
  'production workflows must pin every action to an immutable commit SHA');

console.log('independent UI release workflow contract: ok');
