import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {ROOT, DECLARATION, WIND100_POLICIES, readDeclaration, checkPins, setPins, strayPins, scannedFiles, pinAgreement} from '../tools/atmos-source-pin.mjs';

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
  assert.equal(declaration.atmosSha, '30a211be7692868f36380b809cd9b2bb01011e6a', 'master merge of PR #589 (W19 GEOS-CF outage receipts, with W17 optional-layer receipts and W16 Fusion v2 absentLayers) is the declared producer source');
  const paths = declaration.pins.map(pin => pin.path);
  for (const path of ['.github/workflows/bake.yml', '.github/workflows/collect-core-model.yml', '.github/workflows/collect-regional-model.yml',
    '.github/workflows/publish-current-model-production.yml', '.github/workflows/observation-refresh.yml',
    '.github/workflows/staging-wind100-recurring.yml', '.github/workflows/production-wind100-recurring.yml', '.github/workflows/catalog-bake.yml',
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
  // A separately qualified pin that equals the producer source stays confined to its own listed files.
  const shared = copy();const value = JSON.parse(readFileSync(join(shared, DECLARATION), 'utf8'));
  value.otherAtmosCommits.commits[value.atmosSha] = ['tools/ui-public-combined.mjs'];
  writeFileSync(join(shared, DECLARATION), JSON.stringify(value));
  for (const [path, ok] of [['tools/ui-public-combined.mjs', true], ['.github/workflows/hydrology.yml', false]]) {
    const file = join(shared, path);const before = readFileSync(file, 'utf8');
    writeFileSync(file, before + `// ${value.atmosSha}\n`);
    assert.equal(strayPins(shared).some(p => p.startsWith(`${path}:`) && /declared source in an unlisted pin site/.test(p)), !ok, path);
    writeFileSync(file, before);
  }
});

test('one pin value: approval-gated lanes, CORE_ATMOS_SHA and both Wind100 policies cannot drift from the declaration', () => {
  assert.deepEqual(pinAgreement(), []);
  assert.deepEqual(declaration.approvalVariables, {
    'production/CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA': 'atmosSha', 'production/CURRENT_RUN_CATALOG_BAKE_ATMOS_SHA': 'atmosSha'});
  for (const path of WIND100_POLICIES) assert.equal(JSON.parse(readFileSync(join(ROOT, path), 'utf8')).coreSourceSha, declaration.atmosSha, path);
  const old = '81e061dae0a03cc39e014dc08586bbd144823108';
  const edit = (root, path, change) => { const file = join(root, path); writeFileSync(file, change(readFileSync(file, 'utf8'))); };
  const declare = (root, change) => { const value = JSON.parse(readFileSync(join(root, DECLARATION), 'utf8')); change(value); writeFileSync(join(root, DECLARATION), JSON.stringify(value)); };
  // The 10-10..10-18 shape: the hourly lane left on an earlier source, classified away as another Atmos pin.
  const stale = copy();
  edit(stale, '.github/workflows/catalog-bake.yml', text => text.replaceAll(declaration.atmosSha, old));
  declare(stale, value => { value.pins = value.pins.filter(pin => pin.path !== '.github/workflows/catalog-bake.yml'); value.otherAtmosCommits.commits[old] = ['.github/workflows/catalog-bake.yml']; });
  assert.deepEqual([...checkPins(stale), ...strayPins(stale)], [], 'counts and classification alone accept it');
  const problems = pinAgreement(stale).join('\n');
  assert.match(problems, /catalog-bake\.yml: approved by CURRENT_RUN_CATALOG_BAKE_ATMOS_SHA but not a declared pin site/);
  assert.match(problems, new RegExp(`catalog-bake\\.yml:\\d+: ATMOS_SHA ${old} is not the declared producer source`));
  for (const [label, change, code] of [
    ['wind100 core', root => edit(root, '.github/workflows/production-wind100-recurring.yml', text => text.replace(`CORE_ATMOS_SHA: ${declaration.atmosSha}`, `CORE_ATMOS_SHA: ${old}`)), /CORE_ATMOS_SHA 81e061/],
    ['production policy', root => edit(root, 'tools/production-wind100-policy.json', text => text.replace(`"coreSourceSha": "${declaration.atmosSha}"`, `"coreSourceSha": "${old}"`)), /production-wind100-policy\.json: coreSourceSha 81e061/],
    ['staging policy', root => edit(root, 'tools/staging-wind100-policy.json', text => text.replace(`"coreSourceSha": "${declaration.atmosSha}"`, `"coreSourceSha": "${old}"`)), /staging-wind100-policy\.json: coreSourceSha 81e061/],
    ['undeclared approval variable', root => edit(root, '.github/workflows/hydrology.yml', text => `${text}      APPROVED_SHA: \${{ vars.CURRENT_RUN_HYDROLOGY_ATMOS_SHA }}\n`), /hydrology\.yml:\d+: approval variable CURRENT_RUN_HYDROLOGY_ATMOS_SHA is not declared/],
    ['malformed approval map', root => declare(root, value => { value.approvalVariables = {CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA: 'atmosSha'}; }), /must map <environment>\/<NAME>/]]) {
    const root = copy(); change(root);
    assert.match(pinAgreement(root).join('\n'), code, label);
  }
  // A separately qualified source in an ungated workflow (the Wind100 augmenter) is not the producer pin.
  assert.ok(readFileSync(join(ROOT, '.github/workflows/production-wind100-recurring.yml'), 'utf8').includes('ATMOS_SHA: 9174329db6ca8527569e67f14ef70406dedefb69'));
});
