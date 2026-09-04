import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const workflow = await readFile(new URL('../.github/workflows/bake.yml', import.meta.url), 'utf8');

assert.match(workflow, /actions\/setup-python@[a-f0-9]{40} # v5\n\s+if: \$\{\{ steps\.bake_plan\.outputs\.skip != 'true' \}\}/);
assert.doesNotMatch(workflow, /code_only|Road crop deps/,
  'UI preparation must not extend or add deployment authority to the data lane');
assert.match(workflow,
  /name: save rolling verification cache\n\s+if: \$\{\{ always\(\) && steps\.bake_plan\.outputs\.skip != 'true'/,
  'failed bakes must still preserve newly downloaded verification/truth inputs');
for (const rawPath of ['data/.verify_cache', 'data/.ens_points', 'data/.ecmwf-float',
  'data/.gfs-float', 'data/.aifs-float']) {
  assert.ok(workflow.includes(rawPath), `Actions cache must preserve ${rawPath}`);
}
assert.match(workflow, /name: Retry restored fusion-input vault before new downloads/,
  'a prior R2 outage must be retried before fixed local sidecar paths are overwritten');
assert.match(workflow, /name: Archive irreplaceable fusion inputs even after a failed release gate/);
assert.match(workflow, /VAULT_REMOTE: weatherx:weatherx-data-staging\/vault/,
  'the already-proven bucket-scoped staging credential must activate the raw-input vault');
assert.match(workflow, /RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID: \$\{\{ secrets\.R2_ACCESS_KEY_ID \}\}/);
assert.match(workflow, /if: \$\{\{ always\(\) && steps\.bake_plan\.outputs\.skip != 'true'[\s\S]*?bash ops\/vault-archive\.sh/,
  'vault retry must run independently of the bake/release step result');
assert.match(workflow, /name: hydrate and verify current production R2 release[\s\S]*?R2_REMOTE: weatherx:weatherx-data-production[\s\S]*?bash ops\/platform\/hydrate-r2-release\.sh/,
  'fresh runners must hydrate the verified immutable production release before baking');
assert.match(workflow, /name: hydrate and verify current production R2 release[\s\S]*?secrets\.R2_PRODUCTION_ACCESS_KEY_ID[\s\S]*?secrets\.R2_PRODUCTION_SECRET_ACCESS_KEY/,
  'release hydration must use the bucket-scoped production R2 credential');
assert.doesNotMatch(workflow, /mirror-live-data\.sh/,
  'the retired Pages data mirror must not return to the production data lane');

assert.match(workflow, /fetch-depth: 32/,
  'checkpoint source ancestry must be verifiable across reviewed gate-only commits');
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /name: pinned ground verifier runtime[\s\S]*?python-version: '3.11'/);
assert.match(workflow, /run: python3\.11 -m pip install pillow/);
assert.ok(workflow.indexOf('name: ground verifier image dependency') < workflow.indexOf("with: { python-version: '3.12' }", workflow.indexOf('\n  bake:')),
  'data preparation still uses Python3.12 after installing the pinned ground verifier');
const buildPreflight = workflow.split('      - name: preflight temporary browser-test bundle before weather downloads')[1]?.split('      - name:')[0];
assert.ok(buildPreflight, 'build errors must surface before expensive weather processing');
assert.match(buildPreflight, /WX_GROUND_QUALIFICATION_SCOPE: staging-qualification-only/);
assert.match(buildPreflight, /mktemp -d/);
assert.match(buildPreflight, /npx vite build --outDir "\$gate_build\/dist"/);
assert.doesNotMatch(buildPreflight, /secrets\.|wrangler|deploy|publish|R2_/);
assert.ok(workflow.indexOf('name: preflight temporary browser-test bundle before weather downloads') < workflow.indexOf('name: hydrate and verify current production R2 release'));
assert.match(workflow, /python3 ops\/maintenance_checkpoint\.py fingerprint/);
assert.match(workflow, /name: restore unqualified maintenance checkpoint[\s\S]*?actions\/cache\/restore@[a-f0-9]{40}/);
assert.match(workflow, /maintenance-inputs-v1-\$\{\{ steps\.maintenance_checkpoint\.outputs\.producer \}\}/,
  'different data producer versions must not share completed-input checkpoint keys');
assert.match(workflow, /MAINTENANCE_CHECKPOINT_ENABLED: '1'/);
assert.match(workflow, /MAINTENANCE_MODEL_PARALLELISM: '2'/,
  'model concurrency on a shared maintenance runner must be explicitly bounded');
assert.ok(workflow.indexOf('name: hydrate and verify current production R2 release')
  < workflow.indexOf('name: bake → gate → publish immutable data release'),
  'checkpoint validation must compare against freshly hydrated production bytes');
assert.match(workflow, /name: save unqualified maintenance checkpoint\n\s+if: \$\{\{ always\(\)/,
  'a late failed gate must retain completed inputs without retaining gate authority');
assert.match(workflow, /path: ops\/\.maintenance-checkpoint/);
assert.doesNotMatch(workflow, /resume.*(?:skip.gate|skip.validation)|QUALIFIED_CACHE/i);

console.log('bake workflow data persistence contracts: ok');
