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

console.log('bake workflow data persistence contracts: ok');
