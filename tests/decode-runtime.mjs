import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const paths = ['collect-core-model.yml', 'collect-regional-model.yml', 'publish-current-model-production.yml', 'catalog-bake.yml', 'bake.yml'];
export function validateDecodeRuntime(text, name) {
  assert.doesNotMatch(text, /apt-get|libeccodes-dev|dpkg --configure/, `${name}: decoding must not wait for the unrelated Ubuntu development-package tree`);
  const install = text.indexOf('/bin/pip install --only-binary=eccodes,eccodeslib,eckitlib -r ');
  const check = text.indexOf('/bin/python -m eccodes selfcheck');
  assert.ok(install >= 0 && check > install, `${name}: check the installed native wheels before producer work`);
  assert.match(text, /assert sys.platform == "linux" and sys.version_info\[:2\] == \(3, 12\)/);
  assert.match(text, /assert version\("eccodeslib"\) == "2.48.2.27"/);
  assert.match(text, /assert version\("eckitlib"\) == "2.2.0.27"/);
  assert.match(text, /assert eccodes.codes_get_api_version\(\) == "2.48.2"/);
  assert.match(text, /for packing in \("grid_simple", "grid_ccsds", "grid_jpeg"\):/);
  assert.match(text, /assert list\(eccodes.codes_get_values\(decoded\)\) == values/);
  assert.match(text, /finally:\n\s+eccodes.codes_release\(decoded\)\n\s+finally:\n\s+eccodes.codes_release\(handle\)/);
  assert.doesNotMatch(text.slice(install, text.indexOf('\n          PYCODE', check)), /\|\| true|continue-on-error/);
}
for (const name of paths) {
  test(`${name} provisions and verifies the native wheel runtime without apt`, () => {
    validateDecodeRuntime(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'), name);
  });
}
test('dependency regression and a missing native probe fail the contract', () => {
  const text = readFileSync(new URL('../.github/workflows/collect-core-model.yml', import.meta.url), 'utf8');
  for (const candidate of [text + '\nsudo apt-get install -y libeccodes-dev\n',
    text.replace('/bin/python -m eccodes selfcheck', '/bin/python -V'),
    text.replace('assert list(eccodes.codes_get_values(decoded)) == values', 'pass')]) {
    assert.throws(() => validateDecodeRuntime(candidate, 'mutated'));
  }
});
