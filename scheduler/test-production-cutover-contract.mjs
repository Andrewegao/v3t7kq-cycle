import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (name) => readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const [edge, bootstrap, drill, bake] = await Promise.all([
  read('data-edge-deploy.yml'),
  read('catalog-production-bootstrap.yml'),
  read('catalog-production-safety-drill.yml'),
  read('catalog-bake.yml'),
]);

for (const workflow of [edge, bootstrap, drill, bake]) {
  assert.doesNotMatch(workflow, /wrangler pages deploy|pages-action|cloudflare[/]pages-action/i,
    'catalog cutover workflows must never directly deploy the website');
}

for (const workflow of [bootstrap, drill, bake]) {
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN\b/,
    'production catalog publication must not reuse the Pages credential');
  assert.match(workflow, /secrets\.R2_PRODUCTION_ACCESS_KEY_ID/,
    'production catalog publication must use its bucket-scoped R2 access key');
  assert.match(workflow, /secrets\.R2_PRODUCTION_SECRET_ACCESS_KEY/,
    'production catalog publication must use its bucket-scoped R2 secret');
  assert.match(workflow, /RCLONE_CONFIG_WEATHERX_PROVIDER: Cloudflare/,
    'production catalog publication must use the bucket-scoped S3 transport');
}

assert.match(edge, /production-unrouted/, 'the first Worker deployment must have no public route');
assert.match(edge, /wrangler deploy --secrets-file "\$secret_file" --config wrangler\.data\.jsonc --env production-unrouted/,
  'a new Worker must receive required secrets atomically with its unrouted first deployment');
assert.match(edge, /production-bootstrap/, 'bootstrap must attach only catalog control routes');
assert.match(edge, /production-shadow/, 'shadow must be an explicit phase');
assert.match(edge, /production-serve/, 'serve must be an explicit phase');
assert.doesNotMatch(edge, /CLOUDFLARE_WORKERS_API_TOKEN/,
  'the Worker-only token cannot validate the production R2 bindings');
assert.doesNotMatch(edge, /secrets\.CLOUDFLARE_API_TOKEN\b/,
  'data-edge deployment must not reuse the Pages publication credential');
assert.match(edge, /secrets\.CLOUDFLARE_DATA_EDGE_API_TOKEN/,
  'data-edge deployment must use its dedicated Worker, R2-read, and route credential');
assert.match(edge, /DEPLOY-PRODUCTION-CONTROL/);
assert.match(edge, /ENABLE-PRODUCTION-SHADOW/);
assert.match(edge, /ENABLE-PRODUCTION-CATALOG/);
assert.match(edge, /x-weatherx-release/i, 'the deployment must prove the whole-release path');
assert.match(edge, /x-weatherx-catalog/i, 'serve must prove catalog authority');
assert.match(edge, /for attempt in \$\(seq 1 20\)/,
  'route verification must tolerate bounded Cloudflare propagation delay');
assert.match(edge, /did not converge[\s\S]*within 60 seconds/,
  'route verification must fail closed after its bounded propagation window');

for (const workflow of [edge, bootstrap, drill, bake]) {
  assert.match(workflow, /weatherx-data-production/, 'production catalog storage must be explicit');
  assert.match(workflow, /weatherx-components-production/, 'production component storage must be explicit');
}

assert.match(bootstrap, /BOOTSTRAP-PRODUCTION-CATALOG/);
assert.match(bootstrap, /https:\/\/weatherx\.org/);
assert.match(bootstrap, /publish-r2-release\.sh/, 'bootstrap must retain an immutable release fallback');
assert.match(bootstrap, /bootstrap-r2-catalog\.sh/, 'bootstrap must populate the component catalog');
assert.match(bootstrap, /unexpectedly accessed weatherx-data-staging/,
  'bootstrap must prove the production credential cannot access staging data');
assert.match(bootstrap, /unexpectedly accessed weatherx-components-staging/,
  'bootstrap must prove the production credential cannot access staging components');

assert.match(drill, /RUN-PRODUCTION-DRILL/);
assert.match(drill, /CATALOG_DEFAULT_TARGET/,
  'the production scheduler must remain paused while the destructive rollback drill runs');
assert.match(drill, /CATALOG_TARGET!=="staging"/,
  'the Cloudflare scheduler configuration must remain on staging during the drill');
assert.match(drill, /if: \$\{\{ always\(\) \}\}[\s\S]*?submit-catalog-mutation\.mjs rollback/,
  'the drill must attempt rollback even after a failed race');
assert.match(drill, /catalog_epoch_changed/, 'the drill must prove stale-bake fencing');
assert.match(drill, /verify-release-component\.mjs/, 'the drill must prove whole-release fallback coverage');

assert.match(bake, /default: staging/, 'production publication must remain opt-in before cutover');
assert.match(bake, /CATALOG_PROMOTION_KEY_PRODUCTION/);
assert.match(bake, /bootstrap_missing:[\s\S]*?type: boolean[\s\S]*?default: false/,
  'initial production seeding must be an explicit one-shot dispatch option');
assert.match(bake, /test "\$CATALOG_TARGET" = production[\s\S]*?test "\$REQUESTED_MODEL" = all/,
  'fallback seeding must be limited to an explicit all-model production dispatch');
assert.match(bake, /ALLOW_MISSING_COMPONENT: \$\{\{ inputs\.bootstrap_missing && '1' \|\| '0' \}\}/);
assert.match(bake, /HYDRATE_MISSING_FROM_RELEASE: \$\{\{ inputs\.bootstrap_missing && '1' \|\| '0' \}\}/,
  'a missing production component may be restored only from the verified immutable fallback');

console.log('production catalog cutover contract: ok');
