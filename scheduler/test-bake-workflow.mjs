import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

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

// Run the actual final diagnostic step against a long failed-cycle fixture.
// Early checkpoint/resource evidence must survive the existing 200-line tail,
// without uploading the full internal bake log or dumping arbitrary old lines.
const diagnosticBlock = workflow.split('      - name: cycle log\n')[1];
assert.ok(diagnosticBlock, 'always-run cycle diagnostic step remains present');
assert.match(diagnosticBlock, /if: always\(\)/);
const diagnosticScript = diagnosticBlock.split('        run: |\n')[1]
  .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
const fixture = await mkdtemp(join(tmpdir(), 'weatherx-bake-diagnostic-'));
try {
  await mkdir(join(fixture, 'ops/logs'), { recursive: true });
  const resource = 'model-input resource ecmwf peak-rss-kib=12345 elapsed-seconds=456.78';
  const checkpoint = 'checkpoint: uncommitted input producer changes';
  const privateMarker = 'DO_NOT_DUMP_UNRELATED_EARLY_LOG_CONTENT';
  await writeFile(join(fixture, 'ops/logs/bake-20260830.log'), [
    privateMarker, resource, checkpoint,
    '[2026-08-30T18:12:00+00:00] model-input start ecmwf',
    '[2026-08-30T19:12:00+00:00] model-input end ecmwf exit=0',
    ...Array.from({ length: 240 }, (_, i) => `browser detail ${i}`),
    'WEATHER LAB GATE FAILED',
  ].join('\n'));
  const result = spawnSync('bash', ['-e', '-c', diagnosticScript], { cwd: fixture, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const expected of [resource, checkpoint, 'model-input start ecmwf', 'model-input end ecmwf exit=0', 'WEATHER LAB GATE FAILED']) {
    assert.ok(result.stdout.includes(expected), `retained diagnostic: ${expected}`);
  }
  assert.ok(!result.stdout.includes(privateMarker), 'do not dump all old internal log content');
  await rm(join(fixture, 'ops/logs/bake-20260830.log'));
  const missing = spawnSync('bash', ['-e', '-c', diagnosticScript], { cwd: fixture, encoding: 'utf8' });
  assert.equal(missing.status, 0, 'missing log must not hide the original workflow failure');
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log('bake workflow data persistence contracts: ok');
