import { readFile, mkdtemp, mkdir, writeFile, rm, cp } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = await readFile(new URL('../.github/workflows/bake.yml', import.meta.url), 'utf8');
const joinedBake = workflow.split('      - name: bake → gate → publish immutable data release\n')[1]?.split('      - name:')[0];
assert.ok(joinedBake, 'joined publisher step remains present');
assert.match(joinedBake, /^          WEATHERX_BAKE_LIVE_PROGRESS: '1'$/m);
assert.match(joinedBake, /run: bash ops\/bake-weatherx\.sh/);
assert.doesNotMatch(joinedBake, /\btee\b|tail -f|tail --follow/, 'reviewed FD9 fixed progress remains the only live output');

const checkout = workflow.split('      - name: checkout exact public bake diagnostic controller\n')[1]?.split('      - name:')[0];
assert.ok(checkout, 'exact public controller checkout remains present');
assert.match(checkout, /continue-on-error: true/, 'diagnostic checkout cannot gate the publisher');
assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/);
assert.match(checkout, /persist-credentials: false/);
const relocation = workflow.split('      - name: relocate verified public diagnostic outside the private source\n')[1]?.split('      - name:')[0];
assert.ok(relocation, 'diagnostic relocation remains present');
assert.match(relocation, /continue-on-error: true/, 'diagnostic relocation cannot gate the publisher');
const verifyController='test "$(git -C public-diagnostic-controller rev-parse HEAD)" = "$GITHUB_SHA"';
const moveController='mv public-diagnostic-controller "$RUNNER_TEMP/public-diagnostic-controller"';
assert.ok(relocation.indexOf(verifyController)>=0&&relocation.indexOf(verifyController)<relocation.indexOf(moveController),
  'only the exact current controller can move to the executable path');

const diagnosticBlock = workflow.split('      - name: cycle log\n')[1]?.split('      - name: retain encrypted bake diagnostic receipt')[0];
assert.ok(diagnosticBlock, 'always-run cycle diagnostic step remains present');
assert.match(diagnosticBlock, /if: always\(\)/);
assert.match(diagnosticBlock, /bake-public-diagnostic\.mjs" scan-latest/);
assert.match(diagnosticBlock, /\|\|\s+echo "bake diagnostic projection unavailable"/,
  'missing or refused controller emits only one fixed fallback');
assert.doesNotMatch(diagnosticBlock, /\bawk\b|\btail\b|\bcat\b|substr\(/,
  'the final public diagnostic is projected by the schema validator only');
assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/weatherx-bake-diagnostic\/receipt\.json/);
assert.match(workflow, /bake-public-diagnostic\.mjs" retain/);
assert.match(workflow, /continue-on-error: true[\s\S]*?ATMOS_SHA: 7a50f19714f22e04dc610a5aa33d311b7d1dc673/);
const uploadBlock=workflow.split('      - name: upload encrypted bake diagnostic receipt\n')[1]?.split('\n  # Reporting')[0];
assert.match(uploadBlock,/continue-on-error: true/,'diagnostic artifact outages never change the bake result');

// Run the actual final workflow shell with the exact controller layout Actions creates.
const diagnosticScript = diagnosticBlock.split('        run: |\n')[1]
  .split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
const fixture = await mkdtemp(join(tmpdir(), 'weatherx-bake-diagnostic-'));
try {
  await mkdir(join(fixture, 'ops/logs'), { recursive: true });
  const runner = join(fixture, 'runner');
  const controller = join(runner, 'public-diagnostic-controller');
  await mkdir(join(controller, 'tools'), {recursive:true});
  for (const name of ['bake-public-diagnostic.mjs','nam-hi-diagnostic.mjs']) {
    await cp(new URL(`../tools/${name}`, import.meta.url), join(controller, 'tools', name));
  }
  const secret = 'SYNTHETIC_PRIVATE_SOURCE_SENTINEL';
  const timing = '[2026-09-05T07:00:00Z] bake-stage name=data-verify-observations event=end status=1 elapsed_seconds=120';
  const regional = `[2026-09-05T07:01:00Z] regional-model install nam-hi status=absent init=- reason=${secret}`;
  await writeFile(join(fixture, 'ops/logs/bake-20260905.log'), [timing, regional, `checkpoint: ${secret}`,
    `[2026-09-05T07:02:00Z] bake-stage name=native-gfs event=end status=0 elapsed_seconds=5 PRIVATE=${secret}`,
    ...Array.from({ length: 240 }, (_, index) => `private detail ${index} ${secret}`)].join('\n'));
  const result = spawnSync('bash', ['-e', '-c', diagnosticScript], { cwd: fixture, encoding: 'utf8', env: {...process.env,RUNNER_TEMP:runner} });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(timing),JSON.stringify(result));
  assert.ok(result.stdout.includes('[2026-09-05T07:01:00Z] regional-model install nam-hi status=absent init=-'),JSON.stringify(result));
  assert.ok(!result.stdout.includes(secret));
  await rm(join(fixture, 'ops/logs/bake-20260905.log'));
  const missing = spawnSync('bash', ['-e', '-c', diagnosticScript], {cwd:fixture,encoding:'utf8',env:{...process.env,RUNNER_TEMP:runner}});
  assert.equal(missing.status,0,'missing log must not hide the original workflow failure');
} finally { await rm(fixture, { recursive: true, force: true }); }

console.log('bake diagnostic workflow contracts: ok');
