// Runs tools/forecast-history-copy.sh against two local rclone remotes (skipped without rclone).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readPolicy, receiptCovers } from '../tools/production-releases-retention.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'forecast-history-copy.sh');
const hasRclone = spawnSync('rclone', ['version'], { encoding: 'utf8' }).status === 0;
const write = (root, path, body) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
function run(root, releaseId) {
  return spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env, RELEASE_ID: releaseId,
    RCLONE_CONFIG_LOC_TYPE: 'local', R2_REMOTE: `loc:${root}/data-production`, HISTORY_REMOTE: `loc:${root}/weatherx-forecast-history` } });
}

test('copies release-only runs, keeps newer bytes, and writes a covering receipt', { skip: !hasRclone && 'rclone not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'history-copy-'));
  try {
    const rel = `${root}/data-production/releases/cycle-42`;
    write(rel, 'manifest.json', '{}');
    write(rel, 'data/verify/runs/2026101000/a.json', 'scores v2');
    write(rel, 'data/verify/runs/2026101000/b.json', 'scores b');
    write(rel, 'data/ecmwf-brick/runs/2026101012/x.bin', 'brick');
    write(rel, 'data/ecmwf/runs/2026101012/served.png', 'served elsewhere');
    write(`${root}/weatherx-forecast-history`, 'data/verify/runs/2026101000/a.json', 'scores v1');
    write(`${root}/weatherx-forecast-history`, 'data/verify/runs/2026090100/old.json', 'kept');
    const r = run(root, 'cycle-42');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const hist = `${root}/weatherx-forecast-history`;
    assert.equal(readFileSync(`${hist}/data/verify/runs/2026101000/a.json`, 'utf8'), 'scores v2', 'newest bytes win');
    assert.equal(readFileSync(`${hist}/data/verify/runs/2026090100/old.json`, 'utf8'), 'kept', 'never deletes');
    assert.ok(existsSync(`${hist}/data/ecmwf-brick/runs/2026101012/x.bin`));
    assert.ok(!existsSync(`${hist}/data/ecmwf`), 'served families are not history');
    const body = readFileSync(`${root}/data-production/history-receipts/cycle-42.json`);
    const receipt = JSON.parse(body);
    assert.deepEqual(receipt.runs, { 'data/verify/runs/2026101000/': 2, 'data/ecmwf-brick/runs/2026101012/': 1 });
    const policy = { ...readPolicy(), historyBucket: receipt.historyBucket };
    assert.ok(receiptCovers(body, 'cycle-42', policy, receipt.runs));
    assert.ok(existsSync(`${rel}/data/verify/runs/2026101000/a.json`), 'the release is untouched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an unpublished release copies nothing and writes no receipt; a bad id refuses', { skip: !hasRclone && 'rclone not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'history-copy-'));
  try {
    write(`${root}/data-production/releases/cycle-7`, 'data/verify/runs/2026101000/a.json', 'x');
    const r = run(root, 'cycle-7');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /nothing was published/);
    assert.ok(!existsSync(`${root}/data-production/history-receipts`));
    assert.notEqual(run(root, '../cycle-7').status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
