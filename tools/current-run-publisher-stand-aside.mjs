#!/usr/bin/env node
// Stand-aside check for bake.yml's ECMWF production publisher (publish-current-model-production.yml).
//
// The bake.yml publisher queues on the same per-model lock as the catalog-bake slow lane and
// usually runs minutes after the slow lane promoted the very run its collector fetched. Its sealed
// collector input has no viewport-native sidecars, so the pinned ops/bake-model-component.sh
// rebuilds them (NATIVE_CHANGED=1) and re-uploads the whole ECMWF map component (about 10.5 k
// objects) for a run production already serves.
//
// Before hydrate, this check stands aside only when production already serves that run complete,
// so a same-run publication could not change anything a reader uses:
//   1. map and point components are both at the collected run (one catalog epoch), the served map
//      component.json matches the catalog hash, passed, and declares native_viewport (the workflow
//      runs the check only when the publisher would reuse the served point component);
//   2. the served run is complete: no absence receipt (retiredVariables) and all six upper-air
//      layers present (fetch_upperair.py merges them only when every frame baked);
//   3. every viewport-native bundle the pinned bake builds is declared and present for every frame;
//   4. every collected file of the run is byte-identical (size and MD5) to the served object, and
//      the collected manifest and index entry are the served ones apart from generated_at and the
//      native descriptors, so the rebuilt natives (content-addressed from those frames) would be
//      the served ones;
//   5. the Atmos checkout is the reviewed commit, the slow lane is pinned to it, and the served
//      component completed after this lane's definition last changed.
//
// GFS is deliberately not covered: its enrichment rewrites collected frames in place (the ECMWF
// wave fill on waves/wperiod/wpower/wdir), so condition 4 can never hold for it, and some of its
// add-ons can degrade without a manifest trace.
//
// Fail open: any missing evidence, unexpected shape, API or R2 error or timeout leaves
// `stand_aside=false`, and the job runs exactly the steps it ran before this check. It only reads
// (R2 GETs and one bounded listing, GitHub commit metadata, the local handoff). It writes nothing
// into the Atmos checkout or the job environment.
import {appendFileSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parsePrecondition, runFromTime} from './component-bake-stand-aside.mjs';

export const PUBLISHER_STAND_ASIDE_MODELS = Object.freeze(['ecmwf']);
// The only Atmos commit whose ECMWF publication path (ops/bake-model-component.sh,
// core_model_artifact.py install-component, fetch_upperair.py, build_native_wind_bundles.py,
// data/optional_variables.json) was reviewed for this check. Any other checkout HEAD turns the check
// off (the publisher runs as before) until this constant is re-reviewed.
export const REVIEWED_ATMOS_SHA = '30a211be7692868f36380b809cd9b2bb01011e6a';
// Optional layers the pinned bake can add to an ECMWF run (data/optional_variables.json at the
// reviewed commit). A served run missing any of them could gain it from a same-run bake.
export const REQUIRED_OPTIONAL = Object.freeze({
  ecmwf: Object.freeze(['gh500', 'gh850', 'gh925', 'wind500', 'wind850', 'wind925']),
});
// build_native_wind_bundles.py WEATHER_LAB_SURFACE_VARIABLES and its row layout at the reviewed commit.
export const NATIVE_PROFILE = Object.freeze({
  ecmwf: Object.freeze(['wind', 'temp', 'gust', 'mslp', 'precip', 'cloud', 'dewpoint']),
});
export const NATIVE_REPRESENTATION = 'native-rgba128-halo-l2-t2-r3-b3-row-v1';
export const NATIVE_ROWS = 6; // ceil(721 / 128)
// The only key the pinned ECMWF enrichment adds to a variable the collector already declared.
const ENRICHMENT_KEYS = Object.freeze(['nativeViewport']);
// Top-level manifest keys a same-run bake rewrites (bake clock) or that completeness forbids.
const MUTABLE_TOP_LEVEL = Object.freeze(['generated_at', 'variables', 'retiredVariables']);
// Changing any of these can change what this publisher, this check or the slow lane that produced
// the served component would do, so a served component that predates the newest of them is
// re-published once.
export const DEFINITION_PATHS = Object.freeze(['.github/workflows/publish-current-model-production.yml',
  '.github/workflows/catalog-bake.yml', '.github/workflows/collect-core-model.yml',
  'tools/current-run-publisher-stand-aside.mjs', 'tools/component-bake-stand-aside.mjs', 'tools/current-model-artifact.py']);
const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
const RUN = /^\d{10}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_COMPONENT_BYTES = 64 * 1024;
const MAX_INDEX_BYTES = 64 * 1024;
const MAX_RUN_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_LISTING_OBJECTS = 20000;

// Canonical JSON (sorted keys) for structural equality.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sameTime = (left, right) => typeof left === 'string' && typeof right === 'string' &&
  Number.isFinite(Date.parse(left)) && Date.parse(left) === Date.parse(right);
const without = (object, keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
const parseJson = bytes => { try { return JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { return undefined; } };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const md5 = bytes => createHash('md5').update(bytes).digest('hex');

export function eligibility({model, kind, handoffStatus, retainedRunId, pointReuse}) {
  if (!PUBLISHER_STAND_ASIDE_MODELS.includes(model)) return `${model} is not ECMWF`;
  if (kind !== 'core') return 'not a core model publication';
  if (handoffStatus !== 'ready') return 'no authenticated collector handoff';
  if (retainedRunId) return 'retained-run recovery publishes as before';
  if (pointReuse !== '1') return 'point reuse is off, so the publisher would rebuild the point component';
  return null;
}

// `rclone lsf --format hsp --separator ';'` lines: md5;size;path. Returns null on any doubt.
export function parseListing(text) {
  const listing = new Map();
  for (const line of String(text ?? '').split('\n')) {
    if (!line) continue;
    const match = /^([a-f0-9]{32});(\d+);([^;]+)$/.exec(line);
    if (!match || match[3].split('/').some(part => !part || part === '.' || part === '..') || listing.has(match[3])) return null;
    listing.set(match[3], {md5: match[1], size: Number(match[2])});
    if (listing.size > MAX_LISTING_OBJECTS) return null;
  }
  return listing;
}

function servedComponentReason({model, forecastRun, map, point, componentBytes}) {
  const mapRun = runFromTime(map?.ACTIVE_COMPONENT_GENERATION_TIME);
  const pointRun = runFromTime(point?.ACTIVE_COMPONENT_GENERATION_TIME);
  if (!mapRun) return `production catalog has no ${model} component`;
  if (!pointRun) return `production catalog has no point-${model} component`;
  if (map.EXPECTED_CATALOG_ROLLBACK_EPOCH !== point.EXPECTED_CATALOG_ROLLBACK_EPOCH)
    return 'catalog changed between the two precondition reads';
  if (mapRun !== forecastRun) return `collected run ${forecastRun} is not the served ${model} run ${mapRun}`;
  if (pointRun !== forecastRun) return `collected run ${forecastRun} is not the served point-${model} run ${pointRun}`;
  const expected = map.EXPECTED_COMPONENT_MANIFEST_SHA256;
  if (!SHA256.test(expected ?? '') || !Buffer.isBuffer(componentBytes) || !componentBytes.length ||
      componentBytes.length > MAX_COMPONENT_BYTES || sha256(componentBytes) !== expected)
    return `served ${model} component manifest does not match the catalog hash`;
  const component = parseJson(componentBytes);
  if (![1, 2].includes(component?.schemaVersion) || component.componentId !== model ||
      typeof component.rootPrefix !== 'string' || !/^components\/[a-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/$/.test(component.rootPrefix) ||
      !component.rootPrefix.startsWith(`components/${model}/`) || `${component.rootPrefix}component.json` !== map.ACTIVE_COMPONENT_MANIFEST_KEY ||
      runFromTime(component.generationTime) !== forecastRun || component.quality?.status !== 'passed')
    return `served ${model} component manifest is not the catalog's passed ${forecastRun} component`;
  if (!Array.isArray(component.quality.checks) || !component.quality.checks.includes('native_viewport'))
    return `served ${model} component lacks native viewport bundles`;
  return {component};
}

// Condition 2: nothing a same-run bake could add is missing from the served run.
export function completenessReason(model, manifest) {
  const receipts = manifest.retiredVariables;
  if (receipts !== undefined && (!isObject(receipts) || Object.keys(receipts).length))
    return `served ${model} run carries absence receipts (${isObject(receipts) ? Object.keys(receipts).sort().join(', ') : 'invalid'})`;
  const missing = REQUIRED_OPTIONAL[model].filter(name => !isObject(manifest.variables[name]));
  if (missing.length) return `served ${model} run lacks optional layers ${missing.join(', ')}`;
  return null;
}

// Condition 3: every viewport-native bundle the pinned bake builds is declared and present.
export function nativeReason(model, manifest, listing) {
  for (const variable of NATIVE_PROFILE[model]) {
    const descriptor = manifest.variables[variable]?.nativeViewport;
    if (!isObject(descriptor) || descriptor.schemaVersion !== 1 || descriptor.representation !== NATIVE_REPRESENTATION ||
        descriptor.rangeRequired !== true || descriptor.fullGridFallback !== true)
      return `served ${model} ${variable} has no viewport-native descriptor`;
    const match = new RegExp(`^(${variable}-native-[a-f0-9]{16})/\\{i\\}/index\\.json$`).exec(descriptor.index ?? '');
    if (!match) return `served ${model} ${variable} native index template is not canonical`;
    for (const frame of manifest.frames) {
      if (!Number.isInteger(frame?.i) || frame.i < 0) return `served ${model} run frames are not indexed`;
      const base = `${match[1]}/${String(frame.i).padStart(3, '0')}/`;
      const names = ['index.json', ...Array.from({length: NATIVE_ROWS}, (_, row) => `row-${String(row).padStart(2, '0')}.wxb`)];
      if (!names.every(name => listing.get(base + name)?.size > 0))
        return `served ${model} ${variable} native bundle for frame ${frame.i} is incomplete`;
    }
  }
  return null;
}

// Condition 4: the collected run is the served run byte for byte, apart from enrichment.
export function collectedRunReason({model, forecastRun, servedIndex, packIndex, servedManifest, packManifest, packFiles, listing, manifestBytes}) {
  const path = `runs/${forecastRun}/`;
  const servedEntry = servedIndex?.runs?.[0];
  const packEntry = Array.isArray(packIndex?.runs) ? packIndex.runs.find(entry => entry?.path === path) : undefined;
  if (!isObject(servedIndex) || !Array.isArray(servedIndex.runs) || servedEntry?.path !== path || !packEntry ||
      canonical(servedEntry) !== canonical(packEntry) ||
      canonical(without(servedIndex, ['runs'])) !== canonical(without(packIndex, ['runs'])))
    return `served ${model} index does not lead with the collected run ${forecastRun}`;
  if (!isObject(servedManifest) || !isObject(servedManifest.variables) || !Array.isArray(servedManifest.frames) ||
      !isObject(packManifest) || !isObject(packManifest.variables) || servedManifest.model !== model ||
      !sameTime(servedManifest.init_time, `${forecastRun.slice(0, 4)}-${forecastRun.slice(4, 6)}-${forecastRun.slice(6, 8)}T${forecastRun.slice(8)}:00:00Z`))
    return `served ${model} run manifest is not the ${forecastRun} manifest`;
  const listed = listing.get('manifest.json');
  if (!listed || listed.size !== manifestBytes.length || listed.md5 !== md5(manifestBytes))
    return `served ${model} run manifest differs from its listed object`;
  const servedKeys = Object.keys(servedManifest).filter(key => !MUTABLE_TOP_LEVEL.includes(key)).sort();
  const packKeys = Object.keys(packManifest).filter(key => !MUTABLE_TOP_LEVEL.includes(key)).sort();
  if (canonical(servedKeys) !== canonical(packKeys) ||
      packKeys.some(key => canonical(servedManifest[key]) !== canonical(packManifest[key])))
    return `served ${model} run manifest differs from the collected one outside enrichment`;
  for (const [name, entry] of Object.entries(packManifest.variables))
    if (!isObject(servedManifest.variables[name]) ||
        canonical(without(servedManifest.variables[name], ENRICHMENT_KEYS)) !== canonical(entry))
      return `served ${model} ${name} differs from the collected declaration`;
  const expected = new Set([...Object.keys(packManifest.variables), ...REQUIRED_OPTIONAL[model]]);
  const extra = Object.keys(servedManifest.variables).filter(name => !expected.has(name));
  if (extra.length) return `served ${model} run carries layers this check was not reviewed for (${extra.sort().join(', ')})`;
  if (!Array.isArray(packFiles) || !packFiles.length) return `collected ${model} run has no files`;
  for (const file of packFiles) {
    const served = listing.get(file.path);
    if (!served || served.size !== file.size || served.md5 !== file.md5)
      return `collected ${model} ${file.path} is not byte-identical to the served object`;
  }
  return null;
}

// Pure decision. Every condition must hold to stand aside; the first one that does not is the reason to publish.
export function decide(evidence) {
  const publish = reason => ({standAside: false, reason});
  const {model, forecastRun, definitionChangedAt} = evidence;
  if (!PUBLISHER_STAND_ASIDE_MODELS.includes(model)) return publish(`${model} is not ECMWF`);
  if (!RUN.test(forecastRun ?? '')) return publish('collected run unavailable');
  const served = servedComponentReason(evidence);
  if (typeof served === 'string') return publish(served);
  const {component} = served;
  const completed = typeof component.completedAt === 'string' && ISO.test(component.completedAt) ? Date.parse(component.completedAt) : NaN;
  const changed = typeof definitionChangedAt === 'string' && ISO.test(definitionChangedAt) ? Date.parse(definitionChangedAt) : NaN;
  if (!Number.isFinite(completed)) return publish(`served ${model} component has no completion time`);
  if (!Number.isFinite(changed)) return publish('lane definition change time unavailable');
  if (completed <= changed)
    return publish(`served ${model} component (completed ${component.completedAt}) predates this lane's definition (changed ${definitionChangedAt})`);
  if (!(evidence.listing instanceof Map) || !evidence.listing.size) return publish(`served ${model} run listing unavailable`);
  if (!Buffer.isBuffer(evidence.manifestBytes) || !evidence.manifestBytes.length || evidence.manifestBytes.length > MAX_RUN_MANIFEST_BYTES)
    return publish(`served ${model} run manifest unavailable`);
  const servedManifest = parseJson(evidence.manifestBytes);
  const collected = collectedRunReason({...evidence, servedManifest});
  if (collected) return publish(collected);
  const complete = completenessReason(model, servedManifest);
  if (complete) return publish(complete);
  const native = nativeReason(model, servedManifest, evidence.listing);
  if (native) return publish(native);
  return {standAside: true, reason: 'production already serves the collected run complete', run: forecastRun,
    rootPrefix: component.rootPrefix, completedAt: component.completedAt, definitionChangedAt};
}

export function summaryText(model, decision) {
  if (!decision.standAside)
    return `### Component publisher: ${model} runs\n\n${model}: the publisher runs as before (${decision.reason}).\n`;
  return [`### Component publisher: ${model} stood aside`, '',
    `Production already serves ${model} run ${decision.run} complete: map and point at that run, no absence receipt, all six upper-air layers, ` +
    'every viewport-native bundle present, and every collected file byte-identical to the served object. ' +
    `Served component \`${decision.rootPrefix}\` completed ${decision.completedAt}, after this lane's definition last changed (${decision.definitionChangedAt}).`,
    '', 'Nothing was hydrated, uploaded or promoted; the served component stays and this publisher reports `unchanged`.', ''].join('\n');
}

async function newestDefinitionChange({sha, token, fetcher}) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '') || !token) throw new Error('commit identity unavailable');
  let newest = null;
  for (const path of DEFINITION_PATHS) {
    const query = new URLSearchParams({sha, path, per_page: '1'});
    const response = await fetcher(`https://api.github.com/repos/${REPOSITORY}/commits?${query}`, {
      headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28'},
      signal: AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error(`github-api-${response.status}`);
    const date = (await response.json())?.[0]?.commit?.committer?.date;
    if (typeof date !== 'string' || !ISO.test(date)) throw new Error(`no commit for ${path}`);
    if (!newest || Date.parse(date) > Date.parse(newest)) newest = date;
  }
  return newest;
}

function defaultExec(command, args, options) {
  return new Promise((resolveRun, reject) => {
    execFile(command, args, {maxBuffer: 8 * 1024 * 1024, ...options}, (error, stdout, stderr) =>
      error ? reject(new Error(`${command} failed: ${String(stderr).trim().split('\n').slice(-1)[0] || error.message}`))
        : resolveRun({stdout: String(stdout), stderr: String(stderr)}));
  });
}

// The authenticated handoff: the sealed pack the publisher would install, checked against the
// receipt hash the handoff step authenticated.
export function readHandoff(handoffDir, model, {payload: withPayload = true} = {}) {
  const handoff = JSON.parse(readFileSync(join(handoffDir, 'handoff.json'), 'utf8'));
  const pack = handoff?.pack;
  const forecastRun = pack?.forecastRun;
  if (!RUN.test(forecastRun ?? '') || pack.receipt !== `${model}/manifest.json` || !SHA256.test(pack.receiptSha256 ?? ''))
    throw new Error('handoff pack identity is not a core pack');
  const packs = join(handoffDir, 'packs');
  const receiptBytes = readFileSync(join(packs, pack.receipt));
  if (sha256(receiptBytes) !== pack.receiptSha256) throw new Error('pack receipt differs from the authenticated handoff');
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  if (receipt?.model !== model || receipt.forecastRun !== forecastRun || !Array.isArray(receipt.files))
    throw new Error('pack receipt identity mismatch');
  if (!withPayload) return {forecastRun};
  const payload = join(packs, model, 'payload');
  const read = path => {
    const absolute = resolve(payload, path);
    if (!absolute.startsWith(payload + sep)) throw new Error('unsafe pack path');
    return readFileSync(absolute);
  };
  const root = `app/public/data/${model}/`;
  const runPrefix = `${root}runs/${forecastRun}/`;
  const rows = receipt.files.filter(row => typeof row?.path === 'string' && row.path.startsWith(runPrefix));
  const packFiles = [];
  let packManifest;
  for (const row of rows) {
    const bytes = read(row.path);
    if (bytes.length !== row.size || sha256(bytes) !== row.sha256) throw new Error('pack payload differs from its receipt');
    const path = row.path.slice(runPrefix.length);
    if (path === 'manifest.json') packManifest = JSON.parse(bytes.toString('utf8'));
    else packFiles.push({path, size: bytes.length, md5: md5(bytes)});
  }
  const indexRow = receipt.files.find(row => row?.path === `${root}index.json`);
  const indexBytes = indexRow ? read(indexRow.path) : null;
  if (!indexBytes || indexBytes.length !== indexRow.size || sha256(indexBytes) !== indexRow.sha256 || !packManifest)
    throw new Error('pack lacks the run manifest or index');
  return {forecastRun, packFiles, packManifest, packIndex: JSON.parse(indexBytes.toString('utf8'))};
}

// Gathers the evidence for decide(). Runs inside the pinned Atmos checkout (working directory).
export async function collect({env, atmosRoot, controllerRoot, handoffDir, exec = defaultExec, fetcher = fetch, workDir}) {
  const model = env.MODEL;
  const head = String((await exec('git', ['rev-parse', 'HEAD'], {cwd: atmosRoot, timeout: 30000, env: process.env}))?.stdout ?? '').trim();
  if (head !== REVIEWED_ATMOS_SHA || env.ATMOS_SHA !== REVIEWED_ATMOS_SHA)
    throw new Error(`atmos checkout ${/^[a-f0-9]{40}$/.test(head) ? head : 'unknown'} is not the reviewed pin ${REVIEWED_ATMOS_SHA}`);
  const slowLane = readFileSync(join(controllerRoot, '.github/workflows/catalog-bake.yml'), 'utf8');
  if (!slowLane.includes(`ATMOS_SHA: ${REVIEWED_ATMOS_SHA}\n`) || !slowLane.includes(`ref: ${REVIEWED_ATMOS_SHA}\n`))
    throw new Error('catalog-bake.yml is not pinned to the reviewed Atmos commit');
  const {forecastRun} = readHandoff(handoffDir, model, {payload: false});
  const remoteEnv = {...process.env, ...env};
  const precondition = async componentId => {
    const file = join(workDir, `${componentId}.env`);
    await exec('bash', [join(atmosRoot, 'ops/platform/hydrate-r2-component.sh')], {cwd: atmosRoot, timeout: 120000,
      env: {...remoteEnv, GITHUB_ENV: file, COMPONENT_ID: componentId, PRECONDITION_ONLY: '1',
        ALLOW_MISSING_COMPONENT: '1', HYDRATE_MISSING_FROM_RELEASE: '0', ALLOW_EMPTY_CATALOG: '0'}});
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { text = ''; }
    return parsePrecondition(text);
  };
  const map = await precondition(model);
  const point = await precondition(`point-${model}`);
  const evidence = {model, forecastRun, map, point};
  // Read nothing more when production does not serve this run yet (a first publication) or the epochs differ.
  if (runFromTime(map.ACTIVE_COMPONENT_GENERATION_TIME) !== forecastRun || runFromTime(point.ACTIVE_COMPONENT_GENERATION_TIME) !== forecastRun ||
      map.EXPECTED_CATALOG_ROLLBACK_EPOCH !== point.EXPECTED_CATALOG_ROLLBACK_EPOCH)
    return evidence;
  const key = map.ACTIVE_COMPONENT_MANIFEST_KEY ?? '';
  const prefix = map.ACTIVE_COMPONENT_ROOT_PREFIX ?? '';
  if (!/^components\/[a-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/component\.json$/.test(key) || key !== `${prefix}component.json`)
    return evidence;
  const copy = async (object, name) => {
    const file = join(workDir, name);
    await exec('rclone', ['copyto', `${env.COMPONENT_R2_REMOTE}/${object}`, file, '--s3-no-check-bucket'],
      {cwd: workDir, timeout: 60000, env: remoteEnv});
    return readFileSync(file);
  };
  evidence.componentBytes = await copy(key, 'component.json');
  // The served run objects live under the component root the catalog hash authenticates.
  if (typeof servedComponentReason(evidence) === 'string') return evidence;
  Object.assign(evidence, readHandoff(handoffDir, model));
  const indexBytes = await copy(`${prefix}index.json`, 'index.json');
  if (indexBytes.length > MAX_INDEX_BYTES) throw new Error('served index exceeds its bound');
  evidence.servedIndex = parseJson(indexBytes);
  evidence.manifestBytes = await copy(`${prefix}runs/${forecastRun}/manifest.json`, 'run-manifest.json');
  const listed = await exec('rclone', ['lsf', `${env.COMPONENT_R2_REMOTE}/${prefix}runs/${forecastRun}/`, '--recursive', '--files-only',
    '--fast-list', '--format', 'hsp', '--hash', 'MD5', '--separator', ';', '--s3-no-check-bucket'],
  {cwd: workDir, timeout: 180000, env: remoteEnv});
  evidence.listing = parseListing(listed.stdout);
  evidence.definitionChangedAt = await newestDefinitionChange({sha: env.GITHUB_SHA, token: env.GH_TOKEN, fetcher});
  return evidence;
}

export async function main(argv, env = process.env, deps = {}) {
  const [atmosRoot = '.', controllerRoot = '..', handoffDir = join(env.RUNNER_TEMP ?? tmpdir(), 'model-handoff')] = argv;
  const model = env.MODEL ?? '';
  let decision;
  const ineligible = eligibility({model, kind: env.COMPONENT_KIND, handoffStatus: env.HANDOFF_STATUS, retainedRunId: env.RETAINED_RUN_ID,
    pointReuse: env.POINT_REUSE_ENABLED});
  if (ineligible) decision = {standAside: false, reason: ineligible};
  else {
    const workDir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'publisher-stand-aside-'));
    try {
      decision = decide(await collect({env, atmosRoot: resolve(atmosRoot), controllerRoot: resolve(controllerRoot),
        handoffDir: resolve(handoffDir), workDir, ...deps}));
    } catch (error) {
      decision = {standAside: false, reason: `check unavailable: ${String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 300)}`};
    } finally { rmSync(workDir, {recursive: true, force: true}); }
  }
  const text = summaryText(model.replace(/[^a-z-]/g, ''), decision);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `stand_aside=${decision.standAside}\nserved_run=${decision.run ?? ''}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  console.log(decision.standAside ? `${model}: stood aside, ${decision.reason} (${decision.run}); no upload` : `${model}: publisher runs, ${decision.reason}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; },
    error => { console.log(`publisher stand-aside check unavailable (${error?.message}); the publisher runs`); process.exitCode = 0; });
}
