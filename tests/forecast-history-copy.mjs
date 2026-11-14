// Runs tools/forecast-history-copy.mjs against local rclone remotes (skipped without rclone).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readPolicy, receiptCovers, summarizeManifest } from '../tools/production-releases-retention.mjs';
import { componentIdOf } from '../tools/forecast-history-copy.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'forecast-history-copy.mjs');
const hasRclone = spawnSync('rclone', ['version'], { encoding: 'utf8' }).status === 0;
const sha = s => createHash('sha256').update(s).digest('hex');
const write = (root, path, body) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); };
function release(root, id, files) {
  const rel = `${root}/weatherx-data-production/releases/${id}`;
  for (const [path, body] of Object.entries(files)) write(rel, path, body);
  const m = { schemaVersion: 1, releaseId: id, createdAt: '2026-11-14T00:00:00.000Z', objectCount: Object.keys(files).length,
    objects: Object.entries(files).map(([path, body]) => ({ path, bytes: Buffer.byteLength(body), sha256: sha(body) })) };
  write(rel, 'manifest.json', `${JSON.stringify(m)}\n`);
  return m;
}
const run = (root, id) => spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { ...process.env, RELEASE_ID: id,
  RCLONE_CONFIG_LOC_TYPE: 'local', R2_REMOTE: `loc:${root}/weatherx-data-production`,
  COMPONENT_REMOTE: `loc:${root}/weatherx-components-production`, HISTORY_REMOTE: `loc:${root}/weatherx-forecast-history` } });

test('component ids for served run directories', () => {
  assert.equal(componentIdOf('data/gfs/runs/2026101806/'), 'gfs');
  assert.equal(componentIdOf('point-series/v2/hrrr-ak/2026110612/'), 'point-hrrr-ak');
  assert.equal(componentIdOf('data/verify/runs/2026101000/'), 'verify');
  assert.equal(componentIdOf('data-atmos/air/runs/2026101000/'), null);
  assert.equal(componentIdOf('data/replay/bebinca-2024/air/runs/2024091500/'), null);
});

test('matches complete components, copies everything else, writes a receipt that covers the manifest', { skip: !hasRclone && 'rclone not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'history-copy-'));
  try {
    const m = release(root, 'cycle-42', {
      'data/gfs/runs/2026101806/wind/0.png': 'served gfs', 'data/gfs/runs/2026101812/wind/0.png': 'gfs no component',
      'point-series/v2/gfs/2026101806/chunks/c.bin': 'point', 'data/verify/runs/2026101000/a.json': 'scores v2',
      'data/replay/bebinca-2024/air/runs/2024091500/x.bin': 'replay', 'data/x.json': 'state',
      'data-atmos/jetwind/000.png': 'jet frame', 'data/verify/index.json': 'run index' });
    write(`${root}/weatherx-components-production`, 'components/gfs/gfs-20261018T060000Z-1700/component.json', '{}');
    write(`${root}/weatherx-components-production`, 'components/gfs/gfs-20261018T120000Z-1701/frame.png', 'incomplete root');
    write(`${root}/weatherx-components-production`, 'components/point-gfs/point-gfs-20261018T060000Z-9/component.json', '{}');
    write(`${root}/weatherx-forecast-history`, 'data/verify/runs/2026101000/a.json', 'scores v1');
    write(`${root}/weatherx-forecast-history`, 'data/verify/runs/2026090100/old.json', 'kept');
    const r = run(root, 'cycle-42');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const hist = `${root}/weatherx-forecast-history`;
    assert.equal(readFileSync(`${hist}/data/verify/runs/2026101000/a.json`, 'utf8'), 'scores v2', 'the newest release overwrites');
    assert.equal(readFileSync(`${hist}/data/verify/runs/2026090100/old.json`, 'utf8'), 'kept', 'never deletes');
    assert.ok(existsSync(`${hist}/data/gfs/runs/2026101812/wind/0.png`), 'a run whose component is incomplete is copied');
    assert.ok(existsSync(`${hist}/data/replay/bebinca-2024/air/runs/2024091500/x.bin`));
    assert.ok(!existsSync(`${hist}/data/gfs/runs/2026101806`), 'a run with a complete component is not copied');
    assert.ok(!existsSync(`${hist}/data/x.json`), 'state is not history');
    const body = readFileSync(`${root}/weatherx-data-production/history-receipts/cycle-42.json`);
    const receipt = JSON.parse(body);
    assert.deepEqual(receipt.runs['data/gfs/runs/2026101806/'], { objects: 1, copy: 'component', component: 'components/gfs/gfs-20261018T060000Z-1700/' });
    assert.equal(receipt.runs['point-series/v2/gfs/2026101806/'].copy, 'component');
    assert.equal(receipt.runs['data/gfs/runs/2026101812/'].copy, 'history');
    const summary = summarizeManifest(readFileSync(`${root}/weatherx-data-production/releases/cycle-42/manifest.json`, 'utf8'), 'cycle-42');
    assert.ok(receiptCovers(body, 'cycle-42', readPolicy(), summary), 'retention accepts the receipt');
    assert.equal(readFileSync(`${hist}/snapshots/cycle-42/data-atmos/jetwind/000.png`, 'utf8'), 'jet frame');
    assert.ok(existsSync(`${hist}/snapshots/cycle-42/data/verify/index.json`));
    assert.deepEqual(receipt.runs['@snapshot/'], { objects: 2, copy: 'history', historyPrefix: 'snapshots/cycle-42/' });
    assert.equal(Object.keys(receipt.runs).length, 6);
    assert.equal(m.objects.length, 8);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an older release, an unpublished one and an unrecognized layout write no receipt', { skip: !hasRclone && 'rclone not installed' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'history-copy-'));
  try {
    release(root, 'cycle-7', { 'data/verify/runs/2026101000/a.json': 'old bytes' });
    release(root, 'cycle-9', { 'data/verify/runs/2026101000/a.json': 'new bytes' });
    const older = run(root, 'cycle-7');
    assert.equal(older.status, 0, older.stderr);
    assert.match(older.stdout, /stands aside/);
    assert.ok(!existsSync(`${root}/weatherx-forecast-history`), 'an old re-run never writes history');
    write(`${root}/weatherx-data-production/releases/cycle-11`, 'data/verify/runs/2026101000/a.json', 'x');
    assert.match(run(root, 'cycle-11').stdout, /nothing was published/);
    release(root, 'cycle-12', { 'data/odd/runs/latest/x.json': 'x' });
    const odd = run(root, 'cycle-12');
    assert.notEqual(odd.status, 0);
    assert.match(odd.stderr, /unrecognized/);
    assert.ok(!existsSync(`${root}/weatherx-data-production/history-receipts`));
    assert.notEqual(run(root, '../cycle-7').status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
