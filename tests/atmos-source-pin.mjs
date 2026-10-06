import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {ROOT, DECLARATION, readDeclaration, checkPins, setPins} from '../tools/atmos-source-pin.mjs';

const declaration = readDeclaration();
function copy() {
  const root = mkdtempSync(join(tmpdir(), 'atmos-pin-'));
  for (const path of [DECLARATION, ...declaration.pins.map(pin => pin.path)]) {
    mkdirSync(dirname(join(root, path)), {recursive: true});cpSync(join(ROOT, path), join(root, path));
  }
  return root;
}

test('every ordinary production producer pin equals the one declared Atmos source', () => {
  assert.deepEqual(checkPins(), []);
  assert.equal(declaration.atmosSha, '18fb5074d7472ffc5549704c0874f6e35516cef5', 'PR #489 GFS seal fix is the declared producer source');
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
