import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {ROOT, DECLARATION, readDeclaration, checkPins, setPins, strayPins, scannedFiles} from '../tools/atmos-source-pin.mjs';

const declaration = readDeclaration();
function copy() {
  const root = mkdtempSync(join(tmpdir(), 'atmos-pin-'));
  for (const path of [DECLARATION, ...scannedFiles()]) {
    mkdirSync(dirname(join(root, path)), {recursive: true});cpSync(join(ROOT, path), join(root, path));
  }
  return root;
}

test('every ordinary production producer pin equals the one declared Atmos source', () => {
  assert.deepEqual(checkPins(), []);
  assert.equal(declaration.atmosSha, 'e5fd5758aab079c32c6b077857e641ba40970d04', 'master merge of PR #501 (GFS point-tail banded read) is the declared producer source');
  const paths = declaration.pins.map(pin => pin.path);
  for (const path of ['.github/workflows/bake.yml', '.github/workflows/collect-core-model.yml', '.github/workflows/collect-regional-model.yml',
    '.github/workflows/publish-current-model-production.yml', '.github/workflows/observation-refresh.yml',
    '.github/workflows/staging-wind100-recurring.yml', '.github/workflows/production-wind100-recurring.yml',
    'tools/staging-wind100-policy.json', 'tools/production-wind100-policy.json']) assert.ok(paths.includes(path), path);
  for (const tool of ['tools/five-feed-recovery.mjs', 'tools/five-feed-collect.py', 'tools/staging-wind100.mjs'])
    assert.ok(readFileSync(join(ROOT, tool), 'utf8').includes('ops/atmos-production-source.json'), `${tool} reads the declaration`);
});

test('a hand edit of one site or a stale literal is refused, and --set moves every site together', () => {
  const root = copy();
  const file = join(root, '.github/workflows/collect-core-model.yml');
  writeFileSync(file, readFileSync(file, 'utf8').replace(declaration.atmosSha, 'a'.repeat(40)));
  assert.match(checkPins(root).join('\n'), /collect-core-model\.yml: expected 2 pin\(s\)/);
  assert.throws(() => setPins('b'.repeat(40), root), /inconsistent pins/);
  const clean = copy();
  assert.throws(() => setPins('not-a-sha', clean));
  assert.deepEqual(setPins('c'.repeat(40), clean), []);
  assert.equal(readDeclaration(clean).atmosSha, 'c'.repeat(40));
  for (const {path} of declaration.pins) assert.ok(!readFileSync(join(clean, path), 'utf8').includes(declaration.atmosSha), path);
});

test('every 40-hex value in workflows and tools is classified, so a new or stray pin site cannot drift in', () => {
  assert.deepEqual(strayPins(), []);
  const old = '5e68af94c24517eaaaf6a9d25aec0cadc3d9b135';
  for (const [path, line, code] of [
    ['.github/workflows/hydrology.yml', `          ref: ${old}\n`, /unclassified 40-hex value 5e68af94/],
    ['.github/workflows/hydrology.yml', `      ATMOS_SHA: ${declaration.atmosSha}\n`, /declared source in an unlisted pin site/],
    ['.github/workflows/hydrology.yml', '          ref: 9174329db6ca8527569e67f14ef70406dedefb69\n', /Atmos commit 9174329d\w+ outside its listed files/],
    ['tools/five-feed-recovery.mjs', `const SOURCE='${'e'.repeat(40)}';\n`, /tools\/five-feed-recovery\.mjs:\d+: unclassified/]]) {
    const root = copy();const file = join(root, path);
    writeFileSync(file, readFileSync(file, 'utf8') + line);
    assert.match(strayPins(root).join('\n'), code, path);
  }
  const root = copy();const file = join(root, '.github/workflows/hydrology.yml');
  writeFileSync(file, readFileSync(file, 'utf8') + `      - uses: actions/checkout@${'f'.repeat(40)} # v4\n`);
  assert.deepEqual(strayPins(root), [], 'action pins on uses: lines are not Atmos pins');
});
