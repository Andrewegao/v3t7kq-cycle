import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readWorkflow = (name) => readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const [bake, ui] = await Promise.all([
  readWorkflow('bake.yml'),
  readWorkflow('ui-release.yml'),
]);

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
assert.match(ui, /repository: Andrewegao\/atmos/);
assert.match(ui, /bash ops\/platform\/deploy-code-only\.sh/,
  'the UI lane must deploy the data-free application shell');
assert.match(ui, /PLATFORM_EDGE_CONFIRMED: '1'/,
  'the UI lane must explicitly require the production data edge');
assert.match(ui, /secrets\.CLOUDFLARE_API_TOKEN/,
  'the UI lane alone owns the guarded Pages credential');
assert.doesNotMatch(ui, /R2_PRODUCTION_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|publish-r2-release|bake-weatherx/,
  'the UI lane must not mutate model, ledger, or R2 release state');
assert.match(ui, /node ops\/platform\/test-independent-ui-release\.mjs/);
assert.match(ui, /name: Weather Lab release gate[\s\S]*?LIVE_DATA: '1'[\s\S]*?bash ops\/weather-lab-ready\.sh/,
  'the independent UI gate must exercise the live data edge without mirroring data into Pages');
assert.match(ui, /bash ops\/weather-lab-ready\.sh/);
assert.match(ui, /actions\/upload-artifact@v4[\s\S]*?release-guard/,
  'rollback evidence must survive a failed UI release');

console.log('independent UI release workflow contract: ok');
