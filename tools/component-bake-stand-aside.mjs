#!/usr/bin/env node
// Stand-aside check for the production ECMWF/GFS/AIFS (hourly) and HRRR (10-minute) component bakes
// (catalog-bake.yml).
//
// The slow lane runs every hour, but ECMWF publishes a new complete run twice a day and GFS and
// AIFS four times. The HRRR lane runs every ten minutes, but the 48-hour HRRR store gains a new init
// four times a day. The pinned bake publishes HRRR and AIFS only when the run id moves (it never
// publishes a same-run update for them: no native backfill, no enrichment; see SAME_RUN_GUARDS).
// Before collection, this check asks the pinned Atmos collector's own run selector which
// upstream run it would bake now, and reads the production catalog the publisher reads. When
// production already serves that run for both the map and the point component, and the served
// map component was completed after this lane's definition last changed (so a source re-pin still
// re-bakes once), the job stands aside: no hydrate, no collection, no upload, no catalog mutation.
//
// Fail open: any missing evidence, unexpected shape, API or R2 error, timeout or changed collector
// contract leaves `stand_aside=false`, and the job runs exactly the steps it ran before this check.
// It only reads (R2 GETs through the existing hydrate precondition, two upstream HEAD/zarr probes,
// GitHub commit metadata). It writes nothing into the Atmos checkout or the job environment.
import {appendFileSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const STAND_ASIDE_MODELS = Object.freeze(['ecmwf', 'gfs', 'hrrr', 'aifs']);
// The exact collector invocations in the pinned ops/bake-model-component.sh that the probe mirrors.
// A re-pin that changes any one turns the check off (the bake runs) until the probe is reviewed.
export const COLLECTOR_CALLS = Object.freeze({
  ecmwf: '"$PY" fetch_ecmwf.py --hours 336 --keep 2 ${ecmwf_run_args[@]+"${ecmwf_run_args[@]}"}',
  gfs: '"$PY" fetch.py --hours 72 --point-hours 336 --keep 2 ',
  hrrr: '"$PY" fetch_hrrr.py --hours 48 --keep 2 --point-out "$ROOT/data/.hrrr-point" )',
  aifs: '"$PY" fetch_aifs.py --hours 360 --keep 1 --float-out "$ROOT/data/.aifs-float" --point-out "$ROOT/data/.aifs-point" )',
});
// HRRR and AIFS have no viewport-native backfill, so the pinned bake's only publication decision for
// them is "map run or point run differs from RUN_ID". These reviewed lines of the pinned
// ops/bake-model-component.sh prove that: point is paired, NATIVE_CHANGED is assigned only in its
// reset and inside the ECMWF/GFS block, and an equal pair exits without upload. A re-pin that changes
// any of them turns the HRRR and AIFS checks off (the bake runs) until they are reviewed again.
export const SAME_RUN_GUARDS = Object.freeze([
  'case "$MODEL" in ecmwf|gfs|aifs|icon|hrrr) HAS_POINT=1 ;; *) HAS_POINT=0 ;; esac\n',
  'NATIVE_CHANGED=0\nif [ "$MODEL" = ecmwf ] || [ "$MODEL" = gfs ]; then\n',
  '  NATIVE_CHANGED="$(node -e \'process.stdout.write(JSON.parse(process.argv[1]).changed ? "1" : "0")\' "$NATIVE_JSON")"\nfi\n',
  '  if [ "$ACTIVE_MODEL_RUN" = "$RUN_ID" ] && [ "$ACTIVE_POINT_RUN" = "$RUN_ID" ] && [ "$NATIVE_CHANGED" = 0 ]; then\n' +
    '    echo "$MODEL and point-$MODEL unchanged ($RUN_ID) — no upload or pointer mutation"\n    exit 0\n',
]);
export const SAME_RUN_MODELS = Object.freeze(['hrrr', 'aifs']);
// The bake's component gate (validate-model-component.py MAX_AGE_HOURS hrrr 12, aifs 18) fails a
// served run older than that. Bake well before it, so a stalled upstream still turns the job red.
// AIFS: from 10-17 to 10-23 each cycle reached the hourly lane 6.2 h (to 10-20) or 8.2 h (since)
// after its init, so a served run was at most 14.2 h old at a tick when no cycle was missed; 16 h
// keeps HRRR's 2 h margin below the gate.
export const HRRR_MAX_SERVED_AGE_HOURS = 10;
export const AIFS_MAX_SERVED_AGE_HOURS = 16;
const MAX_SERVED_AGE_HOURS = Object.freeze({hrrr: HRRR_MAX_SERVED_AGE_HOURS, aifs: AIFS_MAX_SERVED_AGE_HOURS});
// The only Atmos commit whose HRRR run selection (fetch_hrrr.main/pick_init/update_index) and bake
// publication path were reviewed for the HRRR stand-aside. The text guards above cannot prove that a
// later pin keeps the run-id derivation or adds no other same-run publish, so any other checkout HEAD
// turns the HRRR check off (the bake runs as before) until this constant is re-reviewed. ECMWF/GFS
// keep their existing collector-call guard only.
export const HRRR_REVIEWED_ATMOS_SHA = '30a211be7692868f36380b809cd9b2bb01011e6a';
// The same for AIFS: the only Atmos commit whose AIFS run selection (fetch_aifs.main/latest_run/
// update_index with --keep 1) and bake publication path were reviewed for the AIFS stand-aside.
// Re-reviewed on its own; a pin bump turns the AIFS check off until this constant moves.
export const AIFS_REVIEWED_ATMOS_SHA = '30a211be7692868f36380b809cd9b2bb01011e6a';
const REVIEWED_ATMOS_SHA = Object.freeze({hrrr: HRRR_REVIEWED_ATMOS_SHA, aifs: AIFS_REVIEWED_ATMOS_SHA});
// Changing any of these files can change what the lane would publish, so a served component that
// predates the newest of them is re-baked once.
export const DEFINITION_PATHS = Object.freeze(['.github/workflows/catalog-bake.yml',
  'tools/component-bake-stand-aside.mjs', 'tools/component-upstream-probe.py']);
const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
const RUN = /^\d{10}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MAX_MANIFEST_BYTES = 64 * 1024;

export function runFromTime(value) {
  if (typeof value !== 'string' || !ISO.test(value)) return null;
  const at = new Date(value);
  if (!Number.isFinite(at.valueOf()) || at.getUTCMinutes() || at.getUTCSeconds() || at.getUTCMilliseconds()) return null;
  return `${at.getUTCFullYear()}${String(at.getUTCMonth() + 1).padStart(2, '0')}${String(at.getUTCDate()).padStart(2, '0')}${String(at.getUTCHours()).padStart(2, '0')}`;
}

// hydrate-r2-component.sh PRECONDITION_ONLY=1 appends KEY=value lines; the bake reads the last one.
export function parsePrecondition(text) {
  const values = {};
  for (const line of String(text ?? '').split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

export function eligibility({model, target, bootstrapMissing, rebakeServedRun, shortRuns}) {
  if (target !== 'production') return 'target is not production';
  if (!STAND_ASIDE_MODELS.includes(model)) return `${model} is not an ECMWF, GFS, HRRR or AIFS model`;
  if (bootstrapMissing === 'true') return 'bootstrap_missing was requested';
  if (rebakeServedRun === 'true') return 'rebake_served_run was requested';
  if (shortRuns && shortRuns !== '0') return 'ECMWF_SHORT_RUNS changes the collector selection';
  return null;
}

// Pure decision. Every condition must hold to stand aside; the first one that does not is the reason to run.
export function decide({model, upstreamRun, map, point, manifestBytes, definitionChangedAt, now = Date.now()}) {
  const run = reason => ({standAside: false, reason});
  if (!RUN.test(upstreamRun ?? '')) return run('upstream run unavailable');
  const mapRun = runFromTime(map?.ACTIVE_COMPONENT_GENERATION_TIME);
  const pointRun = runFromTime(point?.ACTIVE_COMPONENT_GENERATION_TIME);
  if (!mapRun) return run(`production catalog has no ${model} component`);
  if (!pointRun) return run(`production catalog has no point-${model} component`);
  if (map.EXPECTED_CATALOG_ROLLBACK_EPOCH !== point.EXPECTED_CATALOG_ROLLBACK_EPOCH)
    return run('catalog changed between the two precondition reads');
  if (mapRun !== upstreamRun) return run(`newest upstream run ${upstreamRun} is not the served ${model} run ${mapRun}`);
  if (pointRun !== upstreamRun) return run(`newest upstream run ${upstreamRun} is not the served point-${model} run ${pointRun}`);
  const expected = map.EXPECTED_COMPONENT_MANIFEST_SHA256;
  const key = map.ACTIVE_COMPONENT_MANIFEST_KEY;
  if (!SHA256.test(expected ?? '') || !Buffer.isBuffer(manifestBytes) || !manifestBytes.length ||
      manifestBytes.length > MAX_MANIFEST_BYTES || createHash('sha256').update(manifestBytes).digest('hex') !== expected)
    return run(`served ${model} component manifest does not match the catalog hash`);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { return run(`served ${model} component manifest is not JSON`); }
  if (![1, 2].includes(manifest?.schemaVersion) || manifest.componentId !== model ||
      typeof manifest.rootPrefix !== 'string' || `${manifest.rootPrefix}component.json` !== key ||
      !manifest.rootPrefix.startsWith(`components/${model}/`) || runFromTime(manifest.generationTime) !== mapRun ||
      manifest.quality?.status !== 'passed')
    return run(`served ${model} component manifest is not the catalog's passed ${mapRun} component`);
  // bake-model-component.sh backfills viewport-native bundles into a current ECMWF/GFS run that lacks them.
  if (!SAME_RUN_MODELS.includes(model) && (!Array.isArray(manifest.quality.checks) || !manifest.quality.checks.includes('native_viewport')))
    return run(`served ${model} component lacks native viewport bundles (the bake would backfill them)`);
  const maxAgeHours = MAX_SERVED_AGE_HOURS[model];
  if (maxAgeHours !== undefined) {
    const ageHours = (now - Date.parse(map.ACTIVE_COMPONENT_GENERATION_TIME)) / 3600000;
    if (!Number.isFinite(ageHours) || ageHours < 0 || ageHours > maxAgeHours)
      return run(`served ${model} run ${mapRun} is not within ${maxAgeHours} h of now (the bake's freshness gate decides)`);
  }
  const completed = typeof manifest.completedAt === 'string' && ISO.test(manifest.completedAt) ? Date.parse(manifest.completedAt) : NaN;
  const changed = typeof definitionChangedAt === 'string' && ISO.test(definitionChangedAt) ? Date.parse(definitionChangedAt) : NaN;
  if (!Number.isFinite(completed)) return run(`served ${model} component has no completion time`);
  if (!Number.isFinite(changed)) return run('lane definition change time unavailable');
  if (completed <= changed)
    return run(`served ${model} component (completed ${manifest.completedAt}) predates this lane's definition (changed ${definitionChangedAt})`);
  return {standAside: true, reason: 'production already serves the newest upstream run', run: upstreamRun,
    rootPrefix: manifest.rootPrefix, completedAt: manifest.completedAt, definitionChangedAt};
}

export function summaryText(model, decision) {
  if (!decision.standAside)
    return `### Component bake: ${model} runs\n\n${model}: the bake runs as before (${decision.reason}).\n`;
  return [`### Component bake: ${model} stood aside`, '',
    `Production already serves ${model} run ${decision.run}, and the pinned collector's own run selector finds no newer complete run upstream. ` +
    `Served component \`${decision.rootPrefix}\` (map and point at ${decision.run}) completed ${decision.completedAt}, after this lane's definition last changed (${decision.definitionChangedAt}).`,
    '', 'Nothing was hydrated, collected, uploaded or promoted; the served component stays. The next upstream run is collected by the first scheduled run that finds it. ' +
    'To re-bake the served run anyway, dispatch this workflow with `rebake_served_run: true`.', ''].join('\n');
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
    execFile(command, args, {maxBuffer: 1024 * 1024, ...options}, (error, stdout, stderr) =>
      error ? reject(Object.assign(new Error(`${command} failed: ${String(stderr).trim().split('\n').slice(-1)[0] || error.message}`), {stdout}))
        : resolveRun({stdout: String(stdout), stderr: String(stderr)}));
  });
}

// Gathers the evidence for decide(). Runs inside the pinned Atmos checkout (working directory).
export async function collect({env, atmosRoot, probePath, exec = defaultExec, fetcher = fetch, workDir, clock = Date.now}) {
  const model = env.MODEL;
  const reviewed = REVIEWED_ATMOS_SHA[model];
  if (reviewed) {
    const head = String((await exec('git', ['rev-parse', 'HEAD'], {cwd: atmosRoot, timeout: 30000, env: process.env}))?.stdout ?? '').trim();
    if (head !== reviewed)
      throw new Error(`atmos checkout ${/^[a-f0-9]{40}$/.test(head) ? head : 'unknown'} is not the reviewed ${model.toUpperCase()} pin ${reviewed}`);
  }
  const script = readFileSync(join(atmosRoot, 'ops/bake-model-component.sh'), 'utf8');
  if (!script.includes(COLLECTOR_CALLS[model])) throw new Error('pinned collector invocation changed; probe not reviewed for it');
  if (SAME_RUN_MODELS.includes(model) && (!SAME_RUN_GUARDS.every(line => script.includes(line)) ||
      script.split('NATIVE_CHANGED=').length !== 3))
    throw new Error(`pinned bake same-run decision changed; ${model.toUpperCase()} check not reviewed for it`);
  const precondition = async componentId => {
    const file = join(workDir, `${componentId}.env`);
    await exec('bash', [join(atmosRoot, 'ops/platform/hydrate-r2-component.sh')], {cwd: atmosRoot, timeout: 120000,
      env: {...process.env, ...env, GITHUB_ENV: file, COMPONENT_ID: componentId, PRECONDITION_ONLY: '1',
        ALLOW_MISSING_COMPONENT: '1', HYDRATE_MISSING_FROM_RELEASE: '0', ALLOW_EMPTY_CATALOG: '0'}});
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { text = ''; }
    return parsePrecondition(text);
  };
  const map = await precondition(model);
  const point = await precondition(`point-${model}`);
  let manifestBytes = null;
  if (/^components\/[a-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/component\.json$/.test(map.ACTIVE_COMPONENT_MANIFEST_KEY ?? '')) {
    const file = join(workDir, 'component.json');
    await exec('rclone', ['copyto', `${env.COMPONENT_R2_REMOTE}/${map.ACTIVE_COMPONENT_MANIFEST_KEY}`, file, '--s3-no-check-bucket'],
      {cwd: workDir, timeout: 60000, env: {...process.env, ...env}});
    manifestBytes = readFileSync(file);
  }
  // -I: isolated (no PYTHON* env, no user site); -B: no __pycache__ written into the checkout.
  const probe = await exec(join(atmosRoot, 'data/.venv/bin/python'), ['-I', '-B', probePath, model, atmosRoot],
    {cwd: join(atmosRoot, 'data'), timeout: 300000, env: {...process.env, ...env}});
  const upstreamRun = probe.stdout.trim().split('\n').slice(-1)[0];
  const definitionChangedAt = await newestDefinitionChange({sha: env.GITHUB_SHA, token: env.GH_TOKEN, fetcher});
  return {model, upstreamRun, map, point, manifestBytes, definitionChangedAt, now: clock()};
}

export async function main(argv, env = process.env, deps = {}) {
  const [atmosRoot = '.', probePath = fileURLToPath(new URL('./component-upstream-probe.py', import.meta.url))] = argv;
  const model = env.MODEL ?? '';
  let decision;
  const ineligible = eligibility({model, target: env.CATALOG_TARGET, bootstrapMissing: env.BOOTSTRAP_MISSING,
    rebakeServedRun: env.REBAKE_SERVED_RUN, shortRuns: env.ECMWF_SHORT_RUNS});
  if (ineligible) decision = {standAside: false, reason: ineligible};
  else {
    const workDir = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'component-stand-aside-'));
    try {
      decision = decide(await collect({env, atmosRoot: resolve(atmosRoot), probePath: resolve(probePath), workDir, ...deps}));
    } catch (error) {
      decision = {standAside: false, reason: `check unavailable: ${String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 300)}`};
    } finally { rmSync(workDir, {recursive: true, force: true}); }
  }
  const text = summaryText(model.replace(/[^a-z-]/g, ''), decision);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `stand_aside=${decision.standAside}\nserved_run=${decision.run ?? ''}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  console.log(decision.standAside ? `${model}: stood aside — ${decision.reason} (${decision.run}); no upload` : `${model}: bake runs — ${decision.reason}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; },
    error => { console.log(`stand-aside check unavailable (${error?.message}); the bake runs`); process.exitCode = 0; });
}
