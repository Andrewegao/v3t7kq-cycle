import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {catalogPrecondition, checkTree, FAMILIES, publisherEnv} from '../tools/energy-ingest.mjs';

// Fixtures: the real producer output of `fetch_glofas.py --dry-run` and `fetch_cams.py --dry-run`
// (Atmos data/, SYNTHETIC values, marked fixture: true). Live output is the same tree without the mark.
const FIXTURES = new URL('./fixtures/energy-ingest/', import.meta.url);
const workflow = name => readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  : JSON.stringify(value);

function tree(t, family, {live = true, mutate} = {}) {
  const dir = mkdtempSync(join(tmpdir(), `energy-${family}-`));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  cpSync(new URL(`${family}/`, FIXTURES), dir, {recursive: true});
  const pointer = JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8'));
  delete pointer.map;
  if (live) {
    const doc = JSON.parse(readFileSync(join(dir, pointer.path), 'utf8'));
    delete doc.fixture; delete doc.note;
    mutate?.(doc, pointer);
    const body = Buffer.from(`${canonical(doc)}\n`);
    writeFileSync(join(dir, pointer.path), body);
    delete pointer.fixture;
    Object.assign(pointer, {bytes: body.length, sha256: sha(body)});
  }
  writeFileSync(join(dir, 'current.json'), `${canonical(pointer)}\n`);
  return dir;
}

test('a live producer tree is exactly the pointer and the dated document it hashes', t => {
  for (const family of Object.keys(FAMILIES)) {
    const {pointer, files} = checkTree(family, tree(t, family));
    assert.equal(files.length, 2);
    assert.match(pointer.path, FAMILIES[family].dated);
  }
});

test('fixture output, stray files, hash drift and a foreign attribution are refused', t => {
  assert.throws(() => checkTree('glofas', tree(t, 'glofas', {live: false})), /pointer-contract/);
  const stray = tree(t, 'cams');
  writeFileSync(join(stray, 'extra.json'), '{}\n');
  assert.throws(() => checkTree('cams', stray), /tree-is-exactly/);
  const drift = tree(t, 'glofas');
  const pointer = JSON.parse(readFileSync(join(drift, 'current.json'), 'utf8'));
  writeFileSync(join(drift, pointer.path), readFileSync(join(drift, pointer.path), 'utf8').replace('"members":51', '"members":50'));
  assert.throws(() => checkTree('glofas', drift), /dated-file-hash/);
  assert.throws(() => checkTree('cams', tree(t, 'cams', {mutate: (doc, p) => { doc.attribution = 'x'; p.attribution = 'x'; }})), /pointer-contract/);
  assert.throws(() => checkTree('rivers', tree(t, 'glofas')), /unknown-family/);
});

test('catalog precondition: first publication, CAS on the served component, mount conflicts', () => {
  const mount = FAMILIES.glofas.mount;
  assert.deepEqual(catalogPrecondition('glofas', {components: {}, rollbackEpoch: 3}, {objects: []}),
    {previousManifestSha256: '', rollbackEpoch: 3});
  const served = {componentId: 'energy-glofas', manifestSha256: 'a'.repeat(64), mounts: [mount]};
  const broad = {componentId: 'whole', manifestSha256: 'b'.repeat(64), mounts: ['data-atmos/']};
  assert.equal(catalogPrecondition('glofas', {components: {'energy-glofas': served, whole: broad}}, null).previousManifestSha256, 'a'.repeat(64));
  assert.throws(() => catalogPrecondition('glofas', {components: {other: {...served, componentId: 'other'}}}, null), /mount-claimed/);
  assert.throws(() => catalogPrecondition('glofas', {components: {deep: {componentId: 'deep', mounts: [`${mount}x/`]}}}, null), /mount-claimed/);
  assert.throws(() => catalogPrecondition('cams', {components: {}}, {objects: [{path: 'data-atmos/energy/cams/current.json'}]}), /whole-release-shadows/);
});

test('publisher environment: one immutable promoted component per run, compare-and-swap on the served sha', () => {
  const pointer = {newest_init: '2026-10-08T12:00:00Z'};
  const env = publisherEnv('cams', '/tmp/x', pointer, {previousManifestSha256: 'c'.repeat(64), rollbackEpoch: 2}, {id: '42', attempt: '1'});
  assert.equal(env.COMPONENT_ID, 'energy-cams');
  assert.equal(env.MOUNT, 'data-atmos/energy/cams/');
  assert.equal(env.ARTIFACT_ID, 'energy-cams-2026100812-42-1');
  assert.equal(env.PROMOTE, '1');
  assert.equal(env.EXPECTED_COMPONENT_MANIFEST_SHA256, 'c'.repeat(64));
  assert.equal(env.EXPECTED_CATALOG_ROLLBACK_EPOCH, '2');
  assert.equal(env.COMPONENT_R2_REMOTE, 'weatherx:weatherx-components-production');
  assert.throws(() => publisherEnv('cams', '/tmp/x', pointer, {previousManifestSha256: '', rollbackEpoch: 0}, {id: '', attempt: '1'}), /run-identity/);
});

test('workflows: approved source, stand-aside before credentials, secrets only where used', () => {
  for (const [name, family, key] of [['glofas-ingest.yml', 'glofas', 'EWDS_API_KEY'], ['cams-ingest.yml', 'cams', 'ADS_API_KEY']]) {
    const text = workflow(name);
    assert.match(text, /test "\$APPROVED_SHA" = "\$ATMOS_SHA"/);
    assert.match(text, /environment: production/);
    assert.match(text, new RegExp(`concurrency:\\n  group: weatherx-energy-${family}-production\\n  cancel-in-progress: false`));
    assert.match(text, /--require-hashes --only-binary=:all: --no-deps -r cycle\/tools\/energy-ingest-requirements\.txt/);
    assert.match(text, new RegExp(`energy-ingest\\.mjs check-tree ${family}`));
    assert.match(text, new RegExp(`energy-ingest\\.mjs publish ${family}`));
    assert.match(text, new RegExp(`energy-ingest\\.mjs readback ${family}`));
    // The data-store key reaches only the producer step; R2 and catalog keys only the publish step.
    assert.equal(text.split(`${key}: \${{ secrets.${key} }}`).length - 1, 1, `${name}: ${key} in exactly one step`);
    assert.equal(text.split('CATALOG_PROMOTION_KEY: ${{ secrets.CATALOG_PROMOTION_KEY_PRODUCTION }}').length - 1, 1);
    assert.ok(text.indexOf('Stand aside until the owner actions exist') < text.indexOf('secrets.R2_PRODUCTION_ACCESS_KEY_ID'));
    assert.doesNotMatch(text, /open[-_ ]?meteo/i);
  }
});
