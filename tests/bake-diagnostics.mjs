import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = await readFile(new URL('../.github/workflows/bake.yml', import.meta.url), 'utf8');

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
    'model-input resource icon peak-rss-kib=2345 elapsed-seconds=67.8',
    '[2026-08-30T19:13:00+00:00] model-input start icon',
    '[2026-08-30T19:40:00+00:00] model-input end icon exit=1',
    ...Array.from({ length: 240 }, (_, i) => `browser detail ${i}`),
    'WEATHER LAB GATE FAILED',
  ].join('\n'));
  const result = spawnSync('bash', ['-e', '-c', diagnosticScript], { cwd: fixture, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const expected of [resource, checkpoint, 'model-input start ecmwf', 'model-input end ecmwf exit=0',
    'model-input resource icon peak-rss-kib=2345', 'model-input start icon', 'model-input end icon exit=1', 'WEATHER LAB GATE FAILED']) {
    assert.ok(result.stdout.includes(expected), `retained diagnostic: ${expected}`);
  }
  assert.ok(!result.stdout.includes(privateMarker), 'do not dump all old internal log content');
  await rm(join(fixture, 'ops/logs/bake-20260830.log'));
  const missing = spawnSync('bash', ['-e', '-c', diagnosticScript], { cwd: fixture, encoding: 'utf8' });
  assert.equal(missing.status, 0, 'missing log must not hide the original workflow failure');
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log('bake diagnostic retention contracts: ok');
