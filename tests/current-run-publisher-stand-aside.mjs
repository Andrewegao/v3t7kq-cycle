import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {AEROSOL_LAYERS, CURRENT_LAYERS, DEFINITION_PATHS, NATIVE_PROFILE, NATIVE_REPRESENTATION, NATIVE_ROWS,
  PUBLISHER_STAND_ASIDE_MODELS, REQUIRED_OPTIONAL, REVIEWED_ATMOS_SHA, WAVE_DIRECTION, WAVE_FILLED, canonical,
  collectedRunReason, completenessReason, decide, eligibility, main, nativeReason, parseListing, readHandoff, summaryText}
  from '../tools/current-run-publisher-stand-aside.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const publisherWorkflow = read('.github/workflows/publish-current-model-production.yml');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const SHA = 'c'.repeat(40);
const RUN = '2026102500';
const INIT = '2026-10-25T00:00:00Z';
const OLDER = {init_time: '2026-10-24T18:00:00Z', path: 'runs/2026102418/'};
const GRID = {width: 1440, height: 721, lon0: -180, lon1: 179.75, lat0: 90, lat1: -90};
const FRAMES = [{i: 0, valid_time: INIT}, {i: 1, valid_time: '2026-10-25T01:00:00Z'}];
const prefixFor = model => `components/${model}/${model}-20261025T000000Z-1793000000/`;
const CORE = {
  ecmwf: ['wind', 'temp', 'gust', 'mslp', 'precip', 'ptype', 'cloud', 'cape', 'dewpoint'],
  gfs: ['wind', 'temp', 'gust', 'mslp', 'cape', 'rh', 'lcc', 'waves', 'wperiod', 'wpower', 'wdir'],
};
const entry = name => ({file: `${name}/{i}.png`, channels: [name], range: [0, 1], units: 'x'});

// One collected run (pack) and the slow lane's served copy of the same run after enrichment.
function world(model = 'gfs') {
  const packVariables = Object.fromEntries(CORE[model].map(name => [name, entry(name)]));
  const packManifest = {schemaVersion: 1, model, attribution: 'fixture', windReference: 'earth-relative', init_time: INIT,
    generated_at: '2026-10-25T08:48:00Z', grid: GRID, variables: packVariables, frames: FRAMES};
  const files = {};
  for (const name of CORE[model]) for (const frame of FRAMES) files[`${name}/${String(frame.i).padStart(3, '0')}.png`] = Buffer.from(`${model}:${name}:${frame.i}`);
  const served = clone(packManifest);
  served.generated_at = '2026-10-25T06:58:00Z';
  for (const name of REQUIRED_OPTIONAL[model]) served.variables[name] = entry(name);
  if (model === 'gfs') {
    for (const layer of CURRENT_LAYERS) served.variables[layer] = {...entry(layer), validTime: INIT, source: 'NOAA Global RTOFS'};
    for (const layer of [...WAVE_FILLED, WAVE_DIRECTION]) served.variables[layer].supplement = {sourceId: 'ecmwf-wave', initTime: INIT};
  }
  const listingObjects = {...files};
  for (const name of NATIVE_PROFILE[model]) {
    const directory = `${name}-native-${sha256(name).slice(0, 16)}`;
    served.variables[name].nativeViewport = {schemaVersion: 1, representation: NATIVE_REPRESENTATION,
      index: `${directory}/{i}/index.json`, rangeRequired: true, fullGridFallback: true};
    for (const frame of FRAMES) {
      const base = `${directory}/${String(frame.i).padStart(3, '0')}/`;
      listingObjects[`${base}index.json`] = Buffer.from(`${base}index`);
      for (let row = 0; row < NATIVE_ROWS; row += 1) listingObjects[`${base}row-${String(row).padStart(2, '0')}.wxb`] = Buffer.from(`${base}${row}`);
    }
  }
  const prefix = prefixFor(model);
  const component = {schemaVersion: 1, componentId: model, artifactId: prefix.split('/')[2], generationTime: '2026-10-25T00:00:00.000Z',
    completedAt: '2026-10-25T07:09:00.000Z', rootPrefix: prefix, mounts: [`data/${model}/`], objectCount: 12423,
    inventorySha256: 'a'.repeat(64), quality: {status: 'passed', checks: ['manifest', 'inventory', 'remote_bytes', 'coverage',
      'freshness', 'live_superset', 'horizon', 'cadence', 'grid', 'referenced_bytes', 'native_viewport']}};
  return {model, packManifest, served, files, listingObjects, component,
    servedIndex: {schemaVersion: 1, model, runs: [{init_time: INIT, path: `runs/${RUN}/`}, OLDER]},
    packIndex: {schemaVersion: 1, model, runs: [{init_time: INIT, path: `runs/${RUN}/`}, OLDER]}};
}
const bytesOf = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const listingText = objects => Object.entries(objects).map(([path, bytes]) => `${md5(bytes)};${bytes.length};${path}`).join('\n') + '\n';
function evidence(w = world(), changes = {}) {
  const componentBytes = Buffer.from(`${JSON.stringify(w.component)}\n`);
  const manifestBytes = bytesOf(w.served);
  const listing = parseListing(listingText({...w.listingObjects, 'manifest.json': manifestBytes}));
  return {model: w.model, forecastRun: RUN, definitionChangedAt: '2026-10-24T20:00:00Z', componentBytes, manifestBytes, listing,
    servedIndex: w.servedIndex, packIndex: w.packIndex, packManifest: w.packManifest,
    packFiles: Object.entries(w.files).map(([path, bytes]) => ({path, size: bytes.length, md5: md5(bytes)})),
    map: {EXPECTED_COMPONENT_MANIFEST_SHA256: sha256(componentBytes), EXPECTED_CATALOG_ROLLBACK_EPOCH: '0',
      ACTIVE_COMPONENT_GENERATION_TIME: '2026-10-25T00:00:00.000Z', ACTIVE_COMPONENT_MANIFEST_KEY: `${w.component.rootPrefix}component.json`,
      ACTIVE_COMPONENT_ROOT_PREFIX: w.component.rootPrefix},
    point: {EXPECTED_COMPONENT_MANIFEST_SHA256: 'b'.repeat(64), EXPECTED_CATALOG_ROLLBACK_EPOCH: '0',
      ACTIVE_COMPONENT_GENERATION_TIME: '2026-10-25T00:00:00.000Z'}, ...changes};
}
const mutate = (fn, model = 'gfs') => { const w = world(model); fn(w); return evidence(w); };

test('only bake.yml core ECMWF/GFS publications with an authenticated handoff are eligible', () => {
  const base = {model: 'ecmwf', kind: 'core', handoffStatus: 'ready', retainedRunId: ''};
  assert.equal(eligibility(base), null);assert.equal(eligibility({...base, model: 'gfs'}), null);
  assert.deepEqual(PUBLISHER_STAND_ASIDE_MODELS, ['ecmwf', 'gfs']);
  for (const [change, reason] of [[{model: 'hrrr'}, /not ECMWF or GFS/], [{model: 'aifs'}, /not ECMWF or GFS/],
    [{model: 'nam'}, /not ECMWF or GFS/], [{kind: 'regional'}, /not a core/], [{handoffStatus: 'withheld'}, /no authenticated/],
    [{handoffStatus: ''}, /no authenticated/], [{retainedRunId: '34000676897'}, /retained-run recovery/]])
    assert.match(eligibility({...base, ...change}), reason, JSON.stringify(change));
});

test('stands aside for ECMWF and GFS only when production serves the collected run complete', () => {
  for (const model of ['ecmwf', 'gfs']) {
    const result = decide(evidence(world(model)));
    assert.equal(result.standAside, true, `${model}: ${result.reason}`);
    assert.equal(result.run, RUN);assert.equal(result.rootPrefix, prefixFor(model));
    assert.match(summaryText(model, result), /stood aside[\s\S]*run 2026102500 complete[\s\S]*byte-identical[\s\S]*reports `unchanged`/);
  }
});

test('condition 1: the served map and point components must be at the collected run, from one catalog epoch, hash-checked', () => {
  const componentWith = changes => mutate(w => Object.assign(w.component, changes));
  for (const [name, input, reason] of [
    ['first publication', evidence(world(), {map: {...evidence().map, ACTIVE_COMPONENT_GENERATION_TIME: '2026-10-24T18:00:00.000Z'}}), /collected run 2026102500 is not the served gfs run 2026102418/],
    ['point behind', evidence(world(), {point: {...evidence().point, ACTIVE_COMPONENT_GENERATION_TIME: '2026-10-24T18:00:00.000Z'}}), /served point-gfs run 2026102418/],
    ['no map', evidence(world(), {map: {}}), /no gfs component/],
    ['no point', evidence(world(), {point: {}}), /no point-gfs component/],
    ['epoch moved', evidence(world(), {point: {...evidence().point, EXPECTED_CATALOG_ROLLBACK_EPOCH: '1'}}), /catalog changed/],
    ['no collected run', evidence(world(), {forecastRun: ''}), /collected run unavailable/],
    ['hash mismatch', evidence(world(), {map: {...evidence().map, EXPECTED_COMPONENT_MANIFEST_SHA256: 'd'.repeat(64)}}), /does not match the catalog hash/],
    ['component unread', evidence(world(), {componentBytes: null}), /does not match the catalog hash/],
    ['other component', componentWith({componentId: 'ecmwf'}), /not the catalog's passed/],
    ['other run', componentWith({generationTime: '2026-10-24T18:00:00.000Z'}), /not the catalog's passed/],
    ['not passed', componentWith({quality: {status: 'failed', checks: ['native_viewport']}}), /not the catalog's passed/],
    ['root is not the catalog key', (() => { const e = componentWith({rootPrefix: 'components/gfs/other/'});
      return {...e, map: {...e.map, ACTIVE_COMPONENT_MANIFEST_KEY: `${prefixFor('gfs')}component.json`}}; })(), /not the catalog's passed/],
    ['root outside the model', componentWith({rootPrefix: 'components/ecmwf/other/'}), /not the catalog's passed/],
    ['no native check', componentWith({quality: {status: 'passed', checks: ['manifest']}}), /lacks native viewport/],
    ['other model', evidence(world(), {model: 'hrrr'}), /not ECMWF or GFS/],
  ]) {
    const result = decide(input);
    assert.equal(result.standAside, false, name);assert.match(result.reason, reason, name);
    assert.match(summaryText('gfs', result), /the publisher runs as before/, name);
  }
});

test('condition 2: an absence receipt, a missing optional layer or a carried or stale add-on makes the publisher run', () => {
  const cases = [
    ['derivation-rejected receipt', w => { delete w.served.variables.sst; w.served.retiredVariables = {sst: {reason: 'derivation-rejected', source: 'NOAA GFS', initTime: INIT, detail: 'x'}}; }, /absence receipts \(sst\)/],
    ['currents dropped', w => { for (const l of CURRENT_LAYERS) delete w.served.variables[l]; w.served.retiredVariables = Object.fromEntries(CURRENT_LAYERS.map(l => [l, {reason: 'source-unavailable', source: 'NOAA Global RTOFS', initTime: INIT}])); }, /absence receipts \(currents, currents_uv\)/],
    ['GEOS-CF source-stale receipt', w => { delete w.served.variables.so2; w.served.retiredVariables = {so2: {reason: 'source-stale', source: 'NASA GEOS-CF', valid: '2026-10-20', maxAgeDays: 3}}; }, /absence receipts \(so2\)/],
    ['empty-looking but invalid receipts', w => { w.served.retiredVariables = []; }, /absence receipts \(invalid\)/],
    ['optional layer silently absent', w => { delete w.served.variables.dust; }, /lacks optional layers dust/],
    ['GEOS-CF absent', w => { delete w.served.variables.no2; }, /lacks optional layers no2/],
    ['currents carried', w => { for (const l of CURRENT_LAYERS) w.served.variables[l].validTime = '2026-10-24T18:00:00Z'; }, /currents is not this run's own RTOFS snapshot/],
    ['currents vector carried', w => { w.served.variables.currents_uv.validTime = '2026-10-24T18:00:00Z'; }, /currents_uv is not this run's own/],
    ['wave fill from the previous ECMWF cycle', w => { for (const l of [...WAVE_FILLED, WAVE_DIRECTION]) w.served.variables[l].supplement.initTime = '2026-10-24T18:00:00Z'; }, /waves wave fill is not from the ECMWF cycle at the GFS init/],
    ['wave fill skipped', w => { for (const l of [...WAVE_FILLED, WAVE_DIRECTION]) delete w.served.variables[l].supplement; }, /wave fill is not from the ECMWF cycle at the GFS init \(none\)/],
    ['direction fill stale', w => { w.served.variables.wdir.supplement.initTime = '2026-10-24T18:00:00Z'; }, /wdir wave fill/],
    ['PM2.5 hours without a lead', w => { for (const l of AEROSOL_LAYERS) w.served.variables[l].semantics = {missingEncoding: {kind: 'gray-alpha-validity'}}; }, /pm25 has hours without a GEFS-Aerosols lead/],
    ['AQI hours without a lead', w => { w.served.variables.aqi.semantics = {missingEncoding: {}}; }, /aqi has hours without/],
  ];
  for (const [name, fn, reason] of cases) {
    const result = decide(mutate(fn));
    assert.equal(result.standAside, false, name);assert.match(result.reason, reason, name);
  }
  for (const layer of REQUIRED_OPTIONAL.ecmwf) {
    const result = decide(mutate(w => { delete w.served.variables[layer]; }, 'ecmwf'));
    assert.equal(result.standAside, false, layer);assert.match(result.reason, new RegExp(`lacks optional layers ${layer}`), layer);
  }
  // A GFS run without a wdir (the bake omits it when DIRPW was absent) needs only the three filled layers.
  const noDirection = mutate(w => { delete w.served.variables.wdir; delete w.packManifest.variables.wdir;
    for (const frame of FRAMES) delete w.files[`wdir/${String(frame.i).padStart(3, '0')}.png`]; });
  assert.equal(decide(noDirection).standAside, true, decide(noDirection).reason);
  assert.equal(completenessReason('gfs', world().served), null);
});

test('condition 3: every viewport-native bundle must be declared and present for every frame', () => {
  for (const model of ['ecmwf', 'gfs']) for (const variable of NATIVE_PROFILE[model]) {
    for (const [name, fn, reason] of [
      ['descriptor missing', w => { delete w.served.variables[variable].nativeViewport; }, /has no viewport-native descriptor|differs from the collected declaration/],
      ['other representation', w => { w.served.variables[variable].nativeViewport.representation = 'native-v0'; }, /has no viewport-native descriptor/],
      ['no full-grid fallback', w => { w.served.variables[variable].nativeViewport.fullGridFallback = false; }, /has no viewport-native descriptor/],
      ['odd template', w => { w.served.variables[variable].nativeViewport.index = `${variable}-native-zz/{i}/index.json`; }, /index template is not canonical/],
      ['row missing', w => { const key = Object.keys(w.listingObjects).find(k => k.startsWith(`${variable}-native-`) && k.endsWith('/001/row-05.wxb')); delete w.listingObjects[key]; }, /native bundle for frame 1 is incomplete/],
      ['index missing', w => { const key = Object.keys(w.listingObjects).find(k => k.startsWith(`${variable}-native-`) && k.endsWith('/000/index.json')); delete w.listingObjects[key]; }, /native bundle for frame 0 is incomplete/],
    ]) {
      const result = decide(mutate(fn, model));
      assert.equal(result.standAside, false, `${model} ${variable} ${name}`);assert.match(result.reason, reason, `${model} ${variable} ${name}`);
    }
  }
  assert.deepEqual(NATIVE_PROFILE, {ecmwf: ['wind', 'temp', 'gust', 'mslp', 'precip', 'cloud', 'dewpoint'], gfs: ['wind', 'temp', 'gust', 'mslp', 'cape', 'rh']});
  assert.equal(NATIVE_ROWS, Math.ceil(721 / 128));
  assert.equal(nativeReason('gfs', world().served, evidence().listing), null);
});

test('condition 4: the collected run must be the served run byte for byte apart from enrichment', () => {
  for (const [name, input, reason] of [
    ['frame bytes differ', mutate(w => { w.listingObjects['wind/001.png'] = Buffer.from('other'); }), /wind\/001\.png is not byte-identical/],
    ['frame missing', mutate(w => { delete w.listingObjects['temp/000.png']; }), /temp\/000\.png is not byte-identical/],
    ['collected file the served run lacks', mutate(w => { w.files['extra/000.png'] = Buffer.from('x'); }), /extra\/000\.png is not byte-identical/],
    ['frames differ', mutate(w => { w.served.frames = [FRAMES[0]]; }), /differs from the collected one outside enrichment/],
    ['grid differs', mutate(w => { w.packManifest.grid = {...GRID, width: 720}; }), /outside enrichment/],
    ['unknown top-level key', mutate(w => { w.served.provenance = 'x'; }), /outside enrichment/],
    ['core declaration changed', mutate(w => { w.served.variables.wind.range = [0, 2]; }), /wind differs from the collected declaration/],
    ['core layer dropped', mutate(w => { delete w.served.variables.lcc; }), /lcc differs from the collected declaration/],
    ['unreviewed layer', mutate(w => { w.served.variables.jetwind = entry('jetwind'); }), /not reviewed for \(jetwind\)/],
    ['index leads with another run', mutate(w => { w.servedIndex.runs.reverse(); }), /index does not lead with the collected run/],
    ['index entry differs', mutate(w => { w.packIndex.runs[0].init_time = '2026-10-25T00:00:00.000Z'; }), /index does not lead/],
    ['index envelope differs', mutate(w => { w.servedIndex.schemaVersion = 2; }), /index does not lead/],
    ['collector lacks the run', mutate(w => { w.packIndex.runs = [OLDER]; }), /index does not lead/],
    ['manifest of another run', mutate(w => { w.served.init_time = '2026-10-24T18:00:00Z'; }), /not the 2026102500 manifest/],
    ['manifest of another model', mutate(w => { w.served.model = 'ecmwf'; }), /not the 2026102500 manifest/],
    ['no collected files', evidence(world(), {packFiles: []}), /collected gfs run has no files/],
    ['listing unavailable', evidence(world(), {listing: null}), /listing unavailable/],
    ['manifest unread', evidence(world(), {manifestBytes: null}), /run manifest unavailable/],
    ['manifest not JSON', (() => { const e = evidence(); e.manifestBytes = Buffer.from('{'); e.listing.set('manifest.json', {md5: md5(e.manifestBytes), size: 1}); return e; })(), /not the 2026102500 manifest/],
  ]) {
    const result = decide(input);
    assert.equal(result.standAside, false, name);assert.match(result.reason, reason, name);
  }
  const listed = evidence();listed.listing.set('manifest.json', {md5: 'f'.repeat(32), size: listed.manifestBytes.length});
  assert.match(decide(listed).reason, /differs from its listed object/);
  const e = evidence();
  assert.equal(collectedRunReason({...e, servedManifest: JSON.parse(e.manifestBytes)}), null);
});

test('condition 5: the served component must postdate the lane definition', () => {
  for (const [name, input, reason] of [
    ['definition changed after the served component', evidence(world(), {definitionChangedAt: '2026-10-25T07:30:00Z'}), /predates this lane's definition/],
    ['definition time unknown', evidence(world(), {definitionChangedAt: undefined}), /definition change time unavailable/],
    ['no completion time', mutate(w => { delete w.component.completedAt; }), /no completion time/],
  ]) {
    const result = decide(input);
    assert.equal(result.standAside, false, name);assert.match(result.reason, reason, name);
  }
  assert.deepEqual(DEFINITION_PATHS, ['.github/workflows/publish-current-model-production.yml', '.github/workflows/catalog-bake.yml',
    '.github/workflows/collect-core-model.yml', 'tools/current-run-publisher-stand-aside.mjs']);
});

test('listings are parsed strictly: a missing hash, a duplicate or an unsafe path is no listing', () => {
  const good = parseListing(`${'a'.repeat(32)};12;wind/000.png\n${'b'.repeat(32)};3;wind-native-0123456789abcdef/000/row-00.wxb\n`);
  assert.deepEqual([...good.entries()], [['wind/000.png', {md5: 'a'.repeat(32), size: 12}],
    ['wind-native-0123456789abcdef/000/row-00.wxb', {md5: 'b'.repeat(32), size: 3}]]);
  for (const bad of [`;12;wind/000.png\n`, `${'a'.repeat(31)};12;x\n`, `${'a'.repeat(32)};12;../x\n`, `${'a'.repeat(32)};x;y\n`,
    `${'a'.repeat(32)};1;x\n${'a'.repeat(32)};1;x\n`, `${'a'.repeat(32)};1;a//b\n`]) assert.equal(parseListing(bad), null, bad);
  assert.equal(parseListing('').size, 0);
  assert.equal(canonical({b: 1, a: [2, {d: 3, c: 4}]}), canonical({a: [2, {c: 4, d: 3}], b: 1}));
});

test('reviewed constants match the pinned Atmos contract and the declaration file', () => {
  assert.equal(REVIEWED_ATMOS_SHA, '30a211be7692868f36380b809cd9b2bb01011e6a');
  const declaration = JSON.parse(read('ops/atmos-production-source.json'));
  assert.ok(declaration.otherAtmosCommits.commits[REVIEWED_ATMOS_SHA].includes('tools/current-run-publisher-stand-aside.mjs'));
  // data/optional_variables.json at 30a211be7: 6 ECMWF optional; 32 GFS less dfm10, uv and drought (no pinned producer).
  assert.equal(REQUIRED_OPTIONAL.ecmwf.length, 6);assert.equal(REQUIRED_OPTIONAL.gfs.length, 29);
  for (const absent of ['dfm10', 'uv', 'drought']) assert.ok(!REQUIRED_OPTIONAL.gfs.includes(absent), absent);
  assert.equal(NATIVE_REPRESENTATION, 'native-rgba128-halo-l2-t2-r3-b3-row-v1');
});

// --- collection (handoff, R2 reads, GitHub) through main() -----------------------------------------
function fixture({model = 'gfs', head = REVIEWED_ATMOS_SHA, commitDate = '2026-10-24T20:00:00Z', w = world(model), slowLanePin = REVIEWED_ATMOS_SHA,
  tamperPayload = false, tamperReceipt = false, lsfFails = false} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'publisher-stand-aside-'));
  const atmos = join(root, 'atmos'), controller = join(root, 'controller'), handoff = join(root, 'handoff');
  mkdirSync(join(atmos, 'ops/platform'), {recursive: true});
  mkdirSync(join(controller, '.github/workflows'), {recursive: true});
  writeFileSync(join(controller, '.github/workflows/catalog-bake.yml'), `      ATMOS_SHA: ${slowLanePin}\n          ref: ${slowLanePin}\n`);
  const payload = join(handoff, 'packs', model, 'payload');
  const base = `app/public/data/${model}/`;
  const rows = [];
  const put = (path, bytes) => { const file = join(payload, path); mkdirSync(dirname(file), {recursive: true}); writeFileSync(file, bytes);
    rows.push({path, size: bytes.length, sha256: sha256(bytes)}); };
  put(`${base}index.json`, bytesOf(w.packIndex));
  put(`${base}runs/${RUN}/manifest.json`, bytesOf(w.packManifest));
  for (const [path, bytes] of Object.entries(w.files)) put(`${base}runs/${RUN}/${path}`, bytes);
  put(`${base}runs/2026102418/manifest.json`, Buffer.from('{}'));
  put(`data/.${model}-point/meta.json`, Buffer.from('{}'));
  if (tamperPayload) writeFileSync(join(payload, `${base}runs/${RUN}/wind/000.png`), 'tampered');
  const receipt = Buffer.from(JSON.stringify({schemaVersion: 1, status: 'unqualified-core-inputs', model, sourceSha: REVIEWED_ATMOS_SHA,
    runId: '40177243129', forecastRun: RUN, files: rows}));
  writeFileSync(join(handoff, 'packs', model, 'manifest.json'), receipt);
  writeFileSync(join(handoff, 'handoff.json'), JSON.stringify({schemaVersion: 1, status: 'ready', model,
    pack: {receipt: `${model}/manifest.json`, receiptSha256: tamperReceipt ? 'e'.repeat(64) : sha256(receipt), forecastRun: RUN}}));
  const componentBytes = Buffer.from(`${JSON.stringify(w.component)}\n`);
  const manifestBytes = bytesOf(w.served);
  const remote = 'weatherx:weatherx-components-production';
  const objects = {[`${remote}/${w.component.rootPrefix}component.json`]: componentBytes,
    [`${remote}/${w.component.rootPrefix}index.json`]: bytesOf(w.servedIndex),
    [`${remote}/${w.component.rootPrefix}runs/${RUN}/manifest.json`]: manifestBytes};
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({command, args, env: options.env, cwd: options.cwd});
    if (command === 'git') return {stdout: `${head}\n`};
    if (command === 'bash') {
      const id = options.env.COMPONENT_ID;
      writeFileSync(options.env.GITHUB_ENV, id === model
        ? `EXPECTED_COMPONENT_MANIFEST_SHA256=${sha256(componentBytes)}\nEXPECTED_CATALOG_ROLLBACK_EPOCH=0\nACTIVE_COMPONENT_GENERATION_TIME=${w.component.generationTime}\nACTIVE_COMPONENT_MANIFEST_KEY=${w.component.rootPrefix}component.json\nACTIVE_COMPONENT_ROOT_PREFIX=${w.component.rootPrefix}\n`
        : `EXPECTED_COMPONENT_MANIFEST_SHA256=${'b'.repeat(64)}\nEXPECTED_CATALOG_ROLLBACK_EPOCH=0\nACTIVE_COMPONENT_GENERATION_TIME=${w.component.generationTime}\n`);
      return {stdout: ''};
    }
    if (command === 'rclone' && args[0] === 'copyto') {
      if (!objects[args[1]]) throw new Error(`rclone failed: not found ${args[1]}`);
      writeFileSync(args[2], objects[args[1]]);return {stdout: ''};
    }
    if (command === 'rclone' && args[0] === 'lsf') {
      if (lsfFails) throw new Error('rclone failed: listing timed out');
      return {stdout: listingText({...w.listingObjects, 'manifest.json': manifestBytes})};
    }
    throw new Error(`unexpected ${command}`);
  };
  const requested = [];
  const fetcher = async url => { requested.push(url);
    return commitDate ? new Response(JSON.stringify([{commit: {committer: {date: commitDate}}}])) : new Response('{}', {status: 502}); };
  const output = join(root, 'out'), summary = join(root, 'summary');
  const env = {MODEL: model, COMPONENT_KIND: 'core', HANDOFF_STATUS: 'ready', RETAINED_RUN_ID: '', ATMOS_SHA: REVIEWED_ATMOS_SHA,
    GITHUB_SHA: SHA, GH_TOKEN: 'fixture', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: root,
    GITHUB_ENV: join(root, 'job-env'), COMPONENT_R2_REMOTE: remote, CATALOG_R2_REMOTE: 'weatherx:weatherx-data-production'};
  return {root, handoff, calls, requested, output, summary, env, w,
    run: changes => main([atmos, controller, handoff], {...env, ...changes}, {exec, fetcher}),
    cleanup: () => rmSync(root, {recursive: true, force: true})};
}
async function quietly(fn) {
  const logs = [];const original = console.log;console.log = line => logs.push(line);
  try { await fn(); } finally { console.log = original; }
  return logs.join('\n');
}

test('collection reads the catalog, the served run and one listing, and stands aside without touching the job environment', async () => {
  for (const model of ['ecmwf', 'gfs']) {
    const f = fixture({model});
    try {
      const logs = await quietly(async () => assert.equal(await f.run(), 0));
      assert.equal(readFileSync(f.output, 'utf8'), `stand_aside=true\nserved_run=${RUN}\n`, logs);
      assert.match(readFileSync(f.summary, 'utf8'), new RegExp(`${model} stood aside`));
      const hydrate = f.calls.filter(call => call.command === 'bash');
      assert.deepEqual(hydrate.map(call => call.env.COMPONENT_ID), [model, `point-${model}`]);
      for (const call of hydrate) {
        assert.equal(call.env.PRECONDITION_ONLY, '1');assert.equal(call.env.HYDRATE_MISSING_FROM_RELEASE, '0');
        assert.notEqual(call.env.GITHUB_ENV, f.env.GITHUB_ENV, 'precondition values must not reach later steps');
        assert.ok(call.args[0].endsWith('ops/platform/hydrate-r2-component.sh'));
      }
      assert.throws(() => readFileSync(f.env.GITHUB_ENV), /ENOENT/);
      const prefix = `weatherx:weatherx-components-production/${prefixFor(model)}`;
      const rclone = f.calls.filter(call => call.command === 'rclone');
      assert.deepEqual(rclone.map(call => call.args.slice(0, 2)), [['copyto', `${prefix}component.json`], ['copyto', `${prefix}index.json`],
        ['copyto', `${prefix}runs/${RUN}/manifest.json`], ['lsf', `${prefix}runs/${RUN}/`]]);
      assert.ok(rclone.every(call => !call.args.some(arg => /^(copy|sync|move|delete|purge|deletefile|rcat|touch|mkdir)$/.test(arg) && arg !== 'copyto')));
      assert.deepEqual(rclone[3].args.slice(2), ['--recursive', '--files-only', '--fast-list', '--format', 'hsp', '--hash', 'MD5', '--separator', ';', '--s3-no-check-bucket']);
      assert.equal(f.calls[0].command, 'git');
      assert.equal(f.requested.length, DEFINITION_PATHS.length);
      for (const url of f.requested) assert.match(url, new RegExp(`^https://api\\.github\\.com/repos/Andrewegao/v3t7kq-cycle/commits\\?sha=${SHA}&path=`));
    } finally { f.cleanup(); }
  }
});

test('a first publication reads only the two catalog preconditions and publishes', async () => {
  const w = world();w.component.generationTime = '2026-10-24T18:00:00.000Z';
  const f = fixture({w});
  try {
    const logs = await quietly(async () => assert.equal(await f.run(), 0));
    assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=false\nserved_run=\n');
    assert.match(logs, /collected run 2026102500 is not the served gfs run 2026102418/);
    assert.deepEqual(f.calls.map(call => call.command), ['git', 'bash', 'bash']);assert.equal(f.requested.length, 0);
  } finally { f.cleanup(); }
});

test('every failure leaves the publisher running and the step green', async () => {
  for (const [name, options, changes, reason, maxCalls] of [
    ['other Atmos checkout', {head: 'd'.repeat(40)}, {}, /is not the reviewed pin/, 1],
    ['publisher pinned elsewhere', {}, {ATMOS_SHA: 'd'.repeat(40)}, /is not the reviewed pin/, 1],
    ['slow lane pinned elsewhere', {slowLanePin: 'd'.repeat(40)}, {}, /catalog-bake\.yml is not pinned/, 1],
    ['handoff receipt hash differs', {tamperReceipt: true}, {}, /pack receipt differs from the authenticated handoff/, 1],
    ['pack payload tampered', {tamperPayload: true}, {}, /pack payload differs from its receipt/, 4],
    ['listing fails', {lsfFails: true}, {}, /check unavailable: rclone failed: listing timed out/, 99],
    ['github unavailable', {commitDate: null}, {}, /check unavailable: github-api-502/, 99],
    ['definition changed since', {commitDate: '2026-10-25T08:00:00Z'}, {}, /predates this lane's definition/, 99],
    ['served run incomplete', {w: (() => { const w = world(); for (const l of CURRENT_LAYERS) w.served.variables[l].validTime = '2026-10-24T18:00:00Z'; return w; })()}, {}, /not this run's own RTOFS snapshot/, 99],
    ['hrrr', {}, {MODEL: 'hrrr'}, /not ECMWF or GFS/, 0],
    ['regional', {}, {COMPONENT_KIND: 'regional'}, /not a core/, 0],
    ['withheld handoff', {}, {HANDOFF_STATUS: 'withheld'}, /no authenticated collector handoff/, 0],
    ['retained recovery', {}, {RETAINED_RUN_ID: '34000676897'}, /retained-run recovery/, 0],
  ]) {
    const f = fixture(options);
    try {
      const logs = await quietly(async () => assert.equal(await f.run(changes), 0, name));
      assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=false\nserved_run=\n', name);
      assert.match(logs, reason, name);
      assert.match(readFileSync(f.summary, 'utf8'), /the publisher runs as before/, name);
      assert.ok(f.calls.length <= maxCalls, `${name}: ${f.calls.length} calls`);
    } finally { f.cleanup(); }
  }
});

test('the handoff reader takes only the collected run, checked against the authenticated receipt', () => {
  const f = fixture();
  try {
    const pack = readHandoff(f.handoff, 'gfs');
    assert.equal(pack.forecastRun, RUN);
    assert.deepEqual(pack.packFiles.map(file => file.path).sort(), Object.keys(f.w.files).sort());
    assert.equal(canonical(pack.packManifest), canonical(f.w.packManifest));
    assert.equal(canonical(pack.packIndex), canonical(f.w.packIndex));
    assert.throws(() => readHandoff(f.handoff, 'ecmwf'), /not a core pack/);
  } finally { f.cleanup(); }
});

// --- workflow wiring -------------------------------------------------------------------------------
const steps = publisherWorkflow.split('\n    steps:\n')[1];
const step = name => steps.split(`      - name: ${name}\n`)[1].split('\n      - ')[0];
const STAND_ASIDE = 'stand aside when production already serves this collected run complete';

test('workflow: the check runs after the handoff and before hydrate, fails open, and gates only hydrate and publish', () => {
  const order = ['authenticate and copy only this completed collector artifact', STAND_ASIDE,
    'hydrate authenticated current production component baseline', 'validate and publish only the selected production data component',
    'retain aggregate point costs only after successful publication', 'record truthful per-model outcome'];
  const positions = order.map(name => steps.indexOf(`      - name: ${name}\n`));
  assert.ok(positions.every(position => position > 0), JSON.stringify(positions));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  const check = step(STAND_ASIDE);
  assert.match(check, /^        id: stand_aside$/m);
  assert.match(check, /^        if: \$\{\{ steps\.handoff\.outputs\.status == 'ready' && inputs\.kind == 'core' && \(inputs\.model == 'ecmwf' \|\| inputs\.model == 'gfs'\) && inputs\.retained_run_id == '' \}\}$/m);
  assert.match(check, /^        continue-on-error: true$/m);assert.match(check, /^        timeout-minutes: 8$/m);
  assert.match(check, /^        working-directory: atmos$/m);
  assert.match(check, /node "\$GITHUB_WORKSPACE\/cycle-controller\/tools\/current-run-publisher-stand-aside\.mjs" "\$GITHUB_WORKSPACE\/atmos" "\$GITHUB_WORKSPACE\/cycle-controller" "\$RUNNER_TEMP\/model-handoff"/);
  assert.match(check, /COMPONENT_R2_REMOTE: weatherx:weatherx-components-production/);
  assert.match(check, /CATALOG_R2_REMOTE: weatherx:weatherx-data-production/);
  assert.doesNotMatch(check, /CATALOG_PROMOTION_KEY|CATALOG_ENDPOINT|PUBLISH:|GITHUB_ENV/);
  assert.deepEqual([...check.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]), ['R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY']);
  for (const name of ['hydrate authenticated current production component baseline', 'validate and publish only the selected production data component'])
    assert.match(step(name), /^        if: \$\{\{ steps\.handoff\.outputs\.status == 'ready' && steps\.stand_aside\.outputs\.stand_aside != 'true' \}\}$/m, name);
  assert.match(step('retain aggregate point costs only after successful publication'), /if: \$\{\{ steps\.publish\.outputs\.status == 'published' \}\}/);
  assert.equal((publisherWorkflow.match(/repository: weatherx-hq\/atmos/g) || []).length, 1);
});

test('workflow: a stand-aside reports unchanged through the existing outcome path; everything else is unchanged', () => {
  const result = step('record truthful per-model outcome');
  assert.match(result, /STAND_ASIDE: \$\{\{ steps\.stand_aside\.outputs\.stand_aside \}\}/);
  const script = result.split('        run: |\n')[1].split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  const root = mkdtempSync(join(tmpdir(), 'publisher-outcome-'));
  try {
    for (const [handoff, standAside, publish, expected, code] of [
      ['ready', 'true', '', 'unchanged', 0], ['ready', '', 'published', 'published', 0], ['ready', 'false', 'unchanged', 'unchanged', 0],
      ['ready', '', '', 'failed', 1], ['withheld', '', '', 'withheld', 0], ['withheld', 'true', '', 'withheld', 0],
      ['ready', 'true', 'published', 'published', 0], ['', 'true', '', 'failed', 1]]) {
      const output = join(root, `out-${handoff}-${standAside}-${publish}`);writeFileSync(output, '');
      const run = spawnSync('bash', ['-e', '-c', script], {encoding: 'utf8',
        env: {...process.env, HANDOFF_STATUS: handoff, STAND_ASIDE: standAside, PUBLISH_STATUS: publish, GITHUB_OUTPUT: output}});
      assert.equal(readFileSync(output, 'utf8'), `status=${expected}\n`, `${handoff}/${standAside}/${publish}`);
      assert.equal(run.status, code, `${handoff}/${standAside}/${publish}`);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
  // bake.yml's component summary and run summary already accept `unchanged` from this publisher.
  const bake = read('.github/workflows/bake.yml');
  assert.match(bake, /case "\$\{row#\*:\}" in published\|unchanged\|withheld\|failed\) ;;/);
  assert.match(read('tools/workflow-run-summary.mjs'), /published === 'unchanged'\) \{ outcome = 'unchanged'; detail = 'collected run already published'; \}/);
});
