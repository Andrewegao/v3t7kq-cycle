import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {AIFS_MAX_SERVED_AGE_HOURS, AIFS_REVIEWED_ATMOS_SHA, COLLECTOR_CALLS, DEFINITION_PATHS, HRRR_MAX_SERVED_AGE_HOURS, HRRR_REVIEWED_ATMOS_SHA,
  SAME_RUN_GUARDS, SAME_RUN_MODELS, STAND_ASIDE_MODELS, decide, eligibility, main, parsePrecondition, runFromTime, summaryText}
  from '../tools/component-bake-stand-aside.mjs';
import {componentMarkdown, PRODUCTION_BAKE_STEP, STAND_ASIDE_STEP, stoodAsideOnServedRun} from '../tools/workflow-run-summary.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const catalog = read('.github/workflows/catalog-bake.yml');
const SHA = 'c'.repeat(40);
const PREFIX = 'components/ecmwf/ecmwf-20261010T000000Z-1791660000/';
const manifestFor = (changes = {}) => Buffer.from(`${JSON.stringify({schemaVersion: 1, componentId: 'ecmwf',
  artifactId: 'ecmwf-20261010T000000Z-1791660000', generationTime: '2026-10-10T00:00:00.000Z',
  completedAt: '2026-10-10T14:58:20.123Z', rootPrefix: PREFIX, mounts: ['data/ecmwf/'], objectCount: 10535,
  inventorySha256: 'a'.repeat(64), quality: {status: 'passed', checks: ['manifest', 'inventory', 'remote_bytes',
    'coverage', 'freshness', 'live_superset', 'horizon', 'cadence', 'grid', 'referenced_bytes', 'native_viewport']},
  ...changes})}\n`);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function evidence({manifest = manifestFor(), map = {}, point = {}, ...rest} = {}) {
  return {model: 'ecmwf', upstreamRun: '2026101000', definitionChangedAt: '2026-10-10T06:28:25Z', manifestBytes: manifest,
    map: {EXPECTED_COMPONENT_MANIFEST_SHA256: sha256(manifest), EXPECTED_CATALOG_ROLLBACK_EPOCH: '0',
      ACTIVE_COMPONENT_GENERATION_TIME: '2026-10-10T00:00:00.000Z', ACTIVE_COMPONENT_MANIFEST_KEY: `${PREFIX}component.json`,
      ACTIVE_COMPONENT_ROOT_PREFIX: PREFIX, ...map},
    point: {EXPECTED_COMPONENT_MANIFEST_SHA256: 'b'.repeat(64), EXPECTED_CATALOG_ROLLBACK_EPOCH: '0',
      ACTIVE_COMPONENT_GENERATION_TIME: '2026-10-10T00:00:00.000Z', ...point}, ...rest};
}

test('only production ECMWF/GFS/HRRR/AIFS without bootstrap, re-bake or short-run selection is eligible', () => {
  const base = {model: 'ecmwf', target: 'production', bootstrapMissing: 'false', rebakeServedRun: 'false', shortRuns: ''};
  assert.equal(eligibility(base), null);
  assert.equal(eligibility({...base, model: 'gfs'}), null);
  assert.equal(eligibility({...base, model: 'hrrr'}), null);
  assert.equal(eligibility({...base, model: 'aifs'}), null);
  assert.deepEqual(STAND_ASIDE_MODELS, ['ecmwf', 'gfs', 'hrrr', 'aifs']);assert.deepEqual(SAME_RUN_MODELS, ['hrrr', 'aifs']);
  for (const [change, reason] of [[{model: 'icon'}, /not an ECMWF, GFS, HRRR or AIFS/], [{model: 'hrrr-ak'}, /not an ECMWF, GFS, HRRR or AIFS/],
    [{model: 'aifs', target: 'staging'}, /not production/], [{model: 'aifs', rebakeServedRun: 'true'}, /rebake_served_run/],
    [{model: 'aifs', bootstrapMissing: 'true'}, /bootstrap_missing/],
    [{model: 'hrrr', target: 'staging'}, /not production/], [{model: 'hrrr', rebakeServedRun: 'true'}, /rebake_served_run/],
    [{target: 'staging'}, /not production/], [{bootstrapMissing: 'true'}, /bootstrap_missing/],
    [{rebakeServedRun: 'true'}, /rebake_served_run/], [{shortRuns: '1'}, /ECMWF_SHORT_RUNS/]])
    assert.match(eligibility({...base, ...change}), reason, JSON.stringify(change));
});

test('stands aside only when map and point serve the newest upstream run from a component newer than the lane definition', () => {
  const yes = decide(evidence());
  assert.equal(yes.standAside, true);assert.equal(yes.run, '2026101000');assert.equal(yes.rootPrefix, PREFIX);
  assert.match(summaryText('ecmwf', yes), /stood aside[\s\S]*run 2026101000[\s\S]*Nothing was hydrated, collected, uploaded or promoted[\s\S]*rebake_served_run: true/);
  for (const [name, input, reason] of [
    ['new upstream run', evidence({upstreamRun: '2026101012'}), /newest upstream run 2026101012 is not the served ecmwf run 2026101000/],
    ['probe failed', evidence({upstreamRun: ''}), /upstream run unavailable/],
    ['probe noise', evidence({upstreamRun: 'Traceback'}), /upstream run unavailable/],
    ['no map', evidence({map: {ACTIVE_COMPONENT_GENERATION_TIME: ''}}), /no ecmwf component/],
    ['no point', evidence({point: {ACTIVE_COMPONENT_GENERATION_TIME: ''}}), /no point-ecmwf component/],
    ['point behind', evidence({point: {ACTIVE_COMPONENT_GENERATION_TIME: '2026-10-09T12:00:00.000Z'}}), /served point-ecmwf run 2026100912/],
    ['catalog moved', evidence({point: {EXPECTED_CATALOG_ROLLBACK_EPOCH: '1'}}), /catalog changed/],
    ['hash mismatch', evidence({map: {EXPECTED_COMPONENT_MANIFEST_SHA256: 'd'.repeat(64)}}), /does not match the catalog hash/],
    ['missing manifest', {...evidence(), manifestBytes: null}, /does not match the catalog hash/],
    ['other component', evidence({manifest: manifestFor({componentId: 'gfs'})}), /not the catalog's passed/],
    ['other root', evidence({manifest: manifestFor({rootPrefix: 'components/ecmwf/other/'})}), /not the catalog's passed/],
    ['other run', evidence({manifest: manifestFor({generationTime: '2026-10-09T12:00:00.000Z'})}), /not the catalog's passed/],
    ['not passed', evidence({manifest: manifestFor({quality: {status: 'failed', checks: ['native_viewport']}})}), /not the catalog's passed/],
    ['no native bundles', evidence({manifest: manifestFor({quality: {status: 'passed', checks: ['manifest']}})}), /native viewport/],
    ['no completion', evidence({manifest: manifestFor({completedAt: undefined})}), /no completion time/],
    ['re-pinned since', evidence({definitionChangedAt: '2026-10-10T15:00:00Z'}), /predates this lane's definition/],
    ['no definition time', evidence({definitionChangedAt: null}), /definition change time unavailable/],
  ]) {
    const result = decide(input);
    assert.equal(result.standAside, false, name);assert.match(result.reason, reason, name);
    assert.match(summaryText('ecmwf', result), /the bake runs as before/);
  }
});

test('run ids and precondition files are read exactly as the bake reads them', () => {
  assert.equal(runFromTime('2026-10-10T06:00:00.000Z'), '2026101006');assert.equal(runFromTime('2026-10-10T06:00:00Z'), '2026101006');
  for (const bad of ['', null, '2026-10-10T06:30:00Z', '2026-10-10 06:00', '2026-10-10T06:00:00+01:00']) assert.equal(runFromTime(bad), null);
  assert.deepEqual(parsePrecondition('A_B2=1\nACTIVE_COMPONENT_GENERATION_TIME=\nACTIVE_COMPONENT_GENERATION_TIME=x\nnoise\n'),
    {A_B2: '1', ACTIVE_COMPONENT_GENERATION_TIME: 'x'});
});

function fixture({probeRun = '2026101000', manifest = manifestFor(), commitDate = '2026-10-10T06:28:25Z', collector = COLLECTOR_CALLS.ecmwf} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stand-aside-'));
  mkdirSync(join(root, 'ops/platform'), {recursive: true});mkdirSync(join(root, 'data'), {recursive: true});
  writeFileSync(join(root, 'ops/bake-model-component.sh'), `( cd "$ROOT/data" && ${collector} --float-out x )\n`);
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({command, args, env: options.env, cwd: options.cwd});
    if (command === 'bash') {
      const id = options.env.COMPONENT_ID;
      const generation = '2026-10-10T00:00:00.000Z';
      writeFileSync(options.env.GITHUB_ENV, id === 'ecmwf'
        ? `EXPECTED_COMPONENT_MANIFEST_SHA256=${sha256(manifest)}\nEXPECTED_CATALOG_ROLLBACK_EPOCH=0\nACTIVE_COMPONENT_GENERATION_TIME=${generation}\nACTIVE_COMPONENT_MANIFEST_KEY=${PREFIX}component.json\nACTIVE_COMPONENT_ROOT_PREFIX=${PREFIX}\n`
        : `EXPECTED_COMPONENT_MANIFEST_SHA256=${'b'.repeat(64)}\nEXPECTED_CATALOG_ROLLBACK_EPOCH=0\nACTIVE_COMPONENT_GENERATION_TIME=${generation}\n`);
      return {stdout: `loaded catalog precondition for ${id}\n`};
    }
    if (command === 'rclone') { writeFileSync(args[2], manifest); return {stdout: ''}; }
    if (typeof probeRun !== 'string') throw new Error('probe timed out');
    return {stdout: `${probeRun}\n`};
  };
  const requested = [];
  const fetcher = async url => { requested.push(url);
    return commitDate ? new Response(JSON.stringify([{commit: {committer: {date: commitDate}}}])) : new Response('{}', {status: 502}); };
  const output = join(root, 'out'), summary = join(root, 'summary');
  const env = {MODEL: 'ecmwf', CATALOG_TARGET: 'production', BOOTSTRAP_MISSING: 'false', REBAKE_SERVED_RUN: 'false',
    GITHUB_SHA: SHA, GH_TOKEN: 'fixture', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: root,
    GITHUB_ENV: join(root, 'job-env'), COMPONENT_R2_REMOTE: 'weatherx:weatherx-components-production'};
  return {root, calls, requested, exec, fetcher, env, output, summary,
    run: changes => main([root, join(root, 'probe.py')], {...env, ...changes}, {exec, fetcher}),
    cleanup: () => rmSync(root, {recursive: true, force: true})};
}

test('collection reads the catalog through the hydrate precondition without leaking into the job environment', async () => {
  const f = fixture();
  try {
    assert.equal(await f.run(), 0);
    assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=true\nserved_run=2026101000\n');
    assert.match(readFileSync(f.summary, 'utf8'), /ecmwf stood aside/);
    const hydrate = f.calls.filter(call => call.command === 'bash');
    assert.deepEqual(hydrate.map(call => call.env.COMPONENT_ID), ['ecmwf', 'point-ecmwf']);
    for (const call of hydrate) {
      assert.equal(call.env.PRECONDITION_ONLY, '1');assert.equal(call.env.HYDRATE_MISSING_FROM_RELEASE, '0');
      assert.notEqual(call.env.GITHUB_ENV, f.env.GITHUB_ENV, 'precondition values must not reach later steps');
      assert.ok(call.args[0].endsWith('ops/platform/hydrate-r2-component.sh'));
    }
    assert.throws(() => readFileSync(f.env.GITHUB_ENV), /ENOENT/);
    const rclone = f.calls.find(call => call.command === 'rclone');
    assert.deepEqual(rclone.args.slice(0, 2), ['copyto', `weatherx:weatherx-components-production/${PREFIX}component.json`]);
    const probe = f.calls.find(call => call.command.endsWith('data/.venv/bin/python'));
    assert.deepEqual(probe.args.slice(0, 2), ['-I', '-B']);assert.deepEqual(probe.args.slice(3), ['ecmwf', f.root]);
    assert.equal(f.requested.length, DEFINITION_PATHS.length);
    for (const url of f.requested) assert.match(url, new RegExp(`^https://api\\.github\\.com/repos/Andrewegao/v3t7kq-cycle/commits\\?sha=${SHA}&path=`));
  } finally { f.cleanup(); }
});

test('every failure leaves the bake running and the step green', async () => {
  for (const [name, options, changes, reason] of [
    ['newer upstream', {probeRun: '2026101012'}, {}, /2026101012 is not the served/],
    ['probe error', {probeRun: null}, {}, /check unavailable: probe timed out/],
    ['github unavailable', {commitDate: null}, {}, /check unavailable: github-api-502/],
    ['collector call changed', {collector: '"$PY" fetch_ecmwf.py --hours 360 --keep 2'}, {}, /collector invocation changed/],
    ['re-bake requested', {}, {REBAKE_SERVED_RUN: 'true'}, /rebake_served_run/],
    ['icon', {}, {MODEL: 'icon'}, /not an ECMWF, GFS, HRRR or AIFS/],
  ]) {
    const f = fixture(options);
    const logs = [];const original = console.log;console.log = line => logs.push(line);
    try {
      assert.equal(await f.run(changes), 0, name);
      assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=false\nserved_run=\n', name);
      assert.match(logs.join('\n'), reason, name);
      assert.match(readFileSync(f.summary, 'utf8'), /the bake runs as before/, name);
    } finally { console.log = original;f.cleanup(); }
  }
});

test('the upstream probe calls the pinned collector selectors with the bake\'s own arguments', () => {
  const root = mkdtempSync(join(tmpdir(), 'stand-aside-probe-'));
  const data = join(root, 'data');mkdirSync(data);
  const record = join(root, 'calls');
  writeFileSync(join(data, 'fetch_ecmwf.py'), `from datetime import datetime, timezone\ndef latest_run(last_step=0, start=None, short_last_step=None):\n    open(${JSON.stringify(record)}, 'a').write(f'ecmwf {last_step} {short_last_step}\\n')\n    return datetime(2026, 10, 10, 0, tzinfo=timezone.utc)\n`);
  writeFileSync(join(data, 'fetch.py'), `from datetime import datetime, timezone\nSTORE = 'store-url'\ndef pick_init(g, hours, start=None):\n    open(${JSON.stringify(record)}, 'a').write(f'gfs {g} {hours} {start}\\n')\n    return 7, datetime(2026, 10, 10, 6, tzinfo=timezone.utc)\n`);
  writeFileSync(join(data, 'zarr.py'), `def open_group(url, mode):\n    assert mode == 'r'\n    return 'group:' + url\n`);
  const probe = new URL('../tools/component-upstream-probe.py', import.meta.url).pathname;
  const run = model => spawnSync('python3', ['-I', '-B', probe, model, root], {encoding: 'utf8'});
  try {
    assert.equal(run('ecmwf').stdout, '2026101000\n');
    assert.equal(run('gfs').stdout, '2026101006\n');
    assert.equal(readFileSync(record, 'utf8'), 'ecmwf 336 None\ngfs group:store-url 72 None\n');
    assert.notEqual(run('icon').status, 0);
    writeFileSync(join(data, 'fetch_ecmwf.py'), 'def latest_run(last_step=0, start=None):\n    raise AssertionError("not reached")\n');
    const changed = run('ecmwf');
    assert.notEqual(changed.status, 0);assert.match(changed.stderr, /selector signature changed/);assert.equal(changed.stdout, '');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('collector call strings still match the pinned bake script shape', () => {
  // The pinned script (Atmos 30a211be7) is not in this repository; these are the reviewed lines.
  assert.equal(COLLECTOR_CALLS.ecmwf, '"$PY" fetch_ecmwf.py --hours 336 --keep 2 ${ecmwf_run_args[@]+"${ecmwf_run_args[@]}"}');
  assert.equal(COLLECTOR_CALLS.gfs, '"$PY" fetch.py --hours 72 --point-hours 336 --keep 2 ');
  assert.equal(COLLECTOR_CALLS.hrrr, '"$PY" fetch_hrrr.py --hours 48 --keep 2 --point-out "$ROOT/data/.hrrr-point" )');
  assert.equal(COLLECTOR_CALLS.aifs, '"$PY" fetch_aifs.py --hours 360 --keep 1 --float-out "$ROOT/data/.aifs-float" --point-out "$ROOT/data/.aifs-point" )');
  assert.deepEqual(DEFINITION_PATHS, ['.github/workflows/catalog-bake.yml', 'tools/component-bake-stand-aside.mjs', 'tools/component-upstream-probe.py']);
});

const job = catalog.split('\n  model:\n')[1].split('\n  summary:\n')[0];
const step = name => job.split(`      - name: ${name}\n`)[1].split('\n      - ')[0];

test('workflow: the check runs before hydrate, fails open and guards only the production hydrate and bake', () => {
  const order = ['Verify approved immutable component collector', 'Checkout the stand-aside check', 'Install decode dependencies',
    'Reject an unknown publication target', 'Stand aside when production already serves the newest upstream run',
    "Restore only this model's last-known-good production component", 'Bake, validate, upload, and CAS-promote one production model',
    'retain aggregate point costs only after successful production publication'];
  const positions = order.map(name => job.indexOf(`      - name: ${name}\n`));
  assert.ok(positions.every(position => position > 0), JSON.stringify(positions));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  const check = step('Stand aside when production already serves the newest upstream run');
  assert.match(check, /^        id: live_run$/m);
  assert.match(check, /^        continue-on-error: true$/m);
  assert.match(check, /^        timeout-minutes: 8$/m);
  assert.match(check, /if: \$\{\{ env\.CATALOG_TARGET == 'production' && \(matrix\.model == 'ecmwf' \|\| matrix\.model == 'gfs' \|\| matrix\.model == 'hrrr' \|\| matrix\.model == 'aifs'\) && inputs\.bootstrap_missing != true && inputs\.rebake_served_run != true \}\}/);
  assert.match(step('Checkout the stand-aside check'), /if: \$\{\{ env\.CATALOG_TARGET == 'production' && \(matrix\.model == 'ecmwf' \|\| matrix\.model == 'gfs' \|\| matrix\.model == 'hrrr' \|\| matrix\.model == 'aifs'\) \}\}/);
  assert.match(check, /node "\$GITHUB_WORKSPACE\/cycle\/tools\/component-bake-stand-aside\.mjs" "\$GITHUB_WORKSPACE\/atmos"/);
  for (const key of [...check.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]))
    assert.ok(['R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY'].includes(key), key);
  assert.doesNotMatch(check, /CATALOG_PROMOTION_KEY|CATALOG_ENDPOINT|GITHUB_ENV|weatherx-data-staging/);
  assert.match(check, /COMPONENT_R2_REMOTE: weatherx:weatherx-components-production/);
  for (const name of ["Restore only this model's last-known-good production component", 'Bake, validate, upload, and CAS-promote one production model'])
    assert.match(step(name), /^        if: \$\{\{ env\.CATALOG_TARGET == 'production' && steps\.live_run\.outputs\.stand_aside != 'true' \}\}$/m, name);
  for (const name of ["Restore only this model's last-known-good staging component", 'Bake, validate, upload, and CAS-promote one staging model'])
    assert.doesNotMatch(step(name), /live_run/, name);
  assert.equal((catalog.match(/steps\.live_run\.outputs\.stand_aside/g) || []).length, 2);
  const checkout = step('Checkout the stand-aside check');
  assert.match(checkout, /persist-credentials: false/);assert.match(checkout, /path: cycle/);assert.doesNotMatch(checkout, /secrets\.|ssh-key|repository:/);
  assert.match(checkout, /tools\/component-bake-stand-aside\.mjs\n\s+tools\/component-upstream-probe\.py/);
  assert.match(catalog, /rebake_served_run:\n\s+description: [^\n]+\n\s+type: boolean\n\s+required: false\n\s+default: false/);
});

test('summary reports a stand-aside as unchanged, never as a refresh', () => {
  const NOW = Date.parse('2026-10-10T08:10:00Z');
  const steps = (aside, bake) => [{name: STAND_ASIDE_STEP, conclusion: aside}, {name: PRODUCTION_BAKE_STEP, conclusion: bake}];
  const jobs = [{name: 'model (ecmwf)', conclusion: 'success', completed_at: '2026-10-10T08:09:00Z', steps: steps('success', 'skipped')},
    {name: 'model (gfs)', conclusion: 'success', completed_at: '2026-10-10T08:00:00Z', steps: steps('success', 'success')},
    {name: 'model (aifs)', conclusion: 'success', completed_at: '2026-10-10T08:05:00Z', steps: [{name: PRODUCTION_BAKE_STEP, conclusion: 'success'}]}];
  assert.equal(stoodAsideOnServedRun(jobs[0]), true);assert.equal(stoodAsideOnServedRun(jobs[1]), false);assert.equal(stoodAsideOnServedRun(jobs[2]), false);
  assert.equal(stoodAsideOnServedRun({...jobs[0], conclusion: 'failure'}), false);
  const {text} = componentMarkdown({jobs, target: 'production', event: 'workflow_dispatch', holders: [], now: NOW});
  assert.match(text, /\| ecmwf \| unchanged \| stood aside: production already serves the newest upstream run; nothing collected or uploaded/);
  assert.match(text, /\| gfs \| refreshed \| published 10 min ago \|/);
  assert.match(text, /\| aifs \| refreshed \| published 5 min ago \|/);
  // The step names the summary looks for are the workflow's own step names.
  assert.ok(catalog.includes(`      - name: ${STAND_ASIDE_STEP}\n`));assert.ok(catalog.includes(`      - name: ${PRODUCTION_BAKE_STEP}\n`));
});

// HRRR: the 10-minute lane. The pinned bake publishes HRRR only when the run id moves, so a served
// pair at the newest upstream init is exactly the bake's "unchanged" outcome.
const HRRR_PREFIX = 'components/hrrr/hrrr-20261010T060000Z-1791684000/';
const HRRR_GENERATION = '2026-10-10T06:00:00.000Z';
const HRRR_NOW = Date.parse('2026-10-10T09:40:00Z');
const hrrrManifest = (changes = {}) => Buffer.from(`${JSON.stringify({schemaVersion: 1, componentId: 'hrrr',
  artifactId: 'hrrr-20261010T060000Z-1791684000', generationTime: HRRR_GENERATION, completedAt: '2026-10-10T08:12:00.000Z',
  rootPrefix: HRRR_PREFIX, mounts: ['data/hrrr/'], objectCount: 789, inventorySha256: 'a'.repeat(64),
  quality: {status: 'passed', checks: ['manifest', 'inventory', 'remote_bytes', 'coverage', 'freshness', 'live_superset',
    'horizon', 'cadence', 'grid', 'referenced_bytes']}, ...changes})}\n`);
function hrrrEvidence({manifest = hrrrManifest(), map = {}, point = {}, ...rest} = {}) {
  return {model: 'hrrr', upstreamRun: '2026101006', definitionChangedAt: '2026-10-10T07:00:00Z', manifestBytes: manifest, now: HRRR_NOW,
    map: {EXPECTED_COMPONENT_MANIFEST_SHA256: sha256(manifest), EXPECTED_CATALOG_ROLLBACK_EPOCH: '3',
      ACTIVE_COMPONENT_GENERATION_TIME: HRRR_GENERATION, ACTIVE_COMPONENT_MANIFEST_KEY: `${HRRR_PREFIX}component.json`,
      ACTIVE_COMPONENT_ROOT_PREFIX: HRRR_PREFIX, ...map},
    point: {EXPECTED_COMPONENT_MANIFEST_SHA256: 'b'.repeat(64), EXPECTED_CATALOG_ROLLBACK_EPOCH: '3',
      ACTIVE_COMPONENT_GENERATION_TIME: HRRR_GENERATION, ...point}, ...rest};
}
// The reviewed lines of the pinned bake script (Atmos 30a211be7), in order, as the fixture script.
const hrrrScript = (collector = COLLECTOR_CALLS.hrrr, guards = SAME_RUN_GUARDS, extra = '') =>
  `${guards[0]}  hrrr) ( cd "$ROOT/data" && ${collector} ;;\n${guards[1]}  NATIVE_JSON=x\n${guards[2]}${extra}${guards[3]}  fi\n`;

test('hrrr: stands aside only for the served pair at the newest upstream init, fresh, without native bundles', () => {
  const yes = decide(hrrrEvidence());
  assert.equal(yes.standAside, true);assert.equal(yes.run, '2026101006');assert.equal(yes.rootPrefix, HRRR_PREFIX);
  assert.match(summaryText('hrrr', yes), /hrrr stood aside[\s\S]*run 2026101006[\s\S]*Nothing was hydrated/);
  const hour = 3600000;
  for (const [name, input, reason] of [
    ['new upstream init', hrrrEvidence({upstreamRun: '2026101012'}), /newest upstream run 2026101012 is not the served hrrr run 2026101006/],
    ['upstream behind the served run', hrrrEvidence({upstreamRun: '2026101000'}), /2026101000 is not the served hrrr run/],
    ['malformed probe output', hrrrEvidence({upstreamRun: '2026-10-10T06'}), /upstream run unavailable/],
    ['probe printed nothing', hrrrEvidence({upstreamRun: undefined}), /upstream run unavailable/],
    ['point behind', hrrrEvidence({point: {ACTIVE_COMPONENT_GENERATION_TIME: '2026-10-10T00:00:00.000Z'}}), /served point-hrrr run 2026101000/],
    ['no point', hrrrEvidence({point: {ACTIVE_COMPONENT_GENERATION_TIME: ''}}), /no point-hrrr component/],
    ['catalog moved', hrrrEvidence({point: {EXPECTED_CATALOG_ROLLBACK_EPOCH: '4'}}), /catalog changed/],
    ['hash mismatch', hrrrEvidence({map: {EXPECTED_COMPONENT_MANIFEST_SHA256: 'd'.repeat(64)}}), /does not match the catalog hash/],
    ['manifest not JSON', (() => { const bad = Buffer.from('{'); return hrrrEvidence({manifest: bad}); })(), /not JSON/],
    ['ecmwf manifest under hrrr', hrrrEvidence({manifest: hrrrManifest({componentId: 'ecmwf'})}), /not the catalog's passed/],
    ['failed quality', hrrrEvidence({manifest: hrrrManifest({quality: {status: 'failed', checks: []}})}), /not the catalog's passed/],
    ['near the 12 h freshness gate', hrrrEvidence({now: Date.parse(HRRR_GENERATION) + (HRRR_MAX_SERVED_AGE_HOURS + 0.1) * hour}), /not within 10 h/],
    ['future init', hrrrEvidence({now: Date.parse(HRRR_GENERATION) - 60000}), /not within 10 h/],
    ['no clock', hrrrEvidence({now: NaN}), /not within 10 h/],
    ['re-pinned since', hrrrEvidence({definitionChangedAt: '2026-10-10T09:00:00Z'}), /predates this lane's definition/],
  ]) {
    const result = decide(input);
    assert.equal(result.standAside, false, name);assert.match(result.reason, reason, name);
  }
  assert.equal(decide(hrrrEvidence({now: Date.parse(HRRR_GENERATION) + HRRR_MAX_SERVED_AGE_HOURS * hour})).standAside, true);
  assert.equal(HRRR_MAX_SERVED_AGE_HOURS, 10);
});

function hrrrFixture({probe = {stdout: '2026101006\n'}, script = hrrrScript(), commitDate = '2026-10-10T07:00:00Z',
  head = {stdout: `${HRRR_REVIEWED_ATMOS_SHA}\n`}} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stand-aside-hrrr-'));
  mkdirSync(join(root, 'ops/platform'), {recursive: true});mkdirSync(join(root, 'data'), {recursive: true});
  writeFileSync(join(root, 'ops/bake-model-component.sh'), script);
  const manifest = hrrrManifest();
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({command, args, env: options.env, cwd: options.cwd});
    if (command === 'git') { if (head instanceof Error) throw head; return head; }
    if (command === 'bash') {
      const id = options.env.COMPONENT_ID;
      writeFileSync(options.env.GITHUB_ENV, id === 'hrrr'
        ? `EXPECTED_COMPONENT_MANIFEST_SHA256=${sha256(manifest)}\nEXPECTED_CATALOG_ROLLBACK_EPOCH=3\nACTIVE_COMPONENT_GENERATION_TIME=${HRRR_GENERATION}\nACTIVE_COMPONENT_MANIFEST_KEY=${HRRR_PREFIX}component.json\nACTIVE_COMPONENT_ROOT_PREFIX=${HRRR_PREFIX}\n`
        : `EXPECTED_COMPONENT_MANIFEST_SHA256=${'b'.repeat(64)}\nEXPECTED_CATALOG_ROLLBACK_EPOCH=3\nACTIVE_COMPONENT_GENERATION_TIME=${HRRR_GENERATION}\n`);
      return {stdout: ''};
    }
    if (command === 'rclone') { writeFileSync(args[2], manifest); return {stdout: ''}; }
    if (probe instanceof Error) throw probe;
    return probe;
  };
  const fetcher = async () => commitDate ? new Response(JSON.stringify([{commit: {committer: {date: commitDate}}}])) : new Response('{}', {status: 502});
  const output = join(root, 'out'), summary = join(root, 'summary');
  const env = {MODEL: 'hrrr', CATALOG_TARGET: 'production', BOOTSTRAP_MISSING: 'false', REBAKE_SERVED_RUN: 'false',
    GITHUB_SHA: SHA, GH_TOKEN: 'fixture', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: root,
    GITHUB_ENV: join(root, 'job-env'), COMPONENT_R2_REMOTE: 'weatherx:weatherx-components-production'};
  return {calls, output, summary,
    run: changes => main([root, join(root, 'probe.py')], {...env, ...changes}, {exec, fetcher, clock: () => HRRR_NOW}),
    cleanup: () => rmSync(root, {recursive: true, force: true})};
}

test('hrrr: same run stands aside; reads only the precondition, the served manifest and the probe', async () => {
  const f = hrrrFixture();
  try {
    assert.equal(await f.run(), 0);
    assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=true\nserved_run=2026101006\n');
    assert.match(readFileSync(f.summary, 'utf8'), /### Component bake: hrrr stood aside/);
    assert.deepEqual(f.calls.filter(call => call.command === 'bash').map(call => call.env.COMPONENT_ID), ['hrrr', 'point-hrrr']);
    for (const call of f.calls.filter(call => call.command === 'bash'))
      assert.equal(call.env.PRECONDITION_ONLY, '1');
    assert.deepEqual(f.calls.find(call => call.command === 'rclone').args.slice(0, 2),
      ['copyto', `weatherx:weatherx-components-production/${HRRR_PREFIX}component.json`]);
    assert.deepEqual(f.calls.find(call => call.command.endsWith('data/.venv/bin/python')).args.slice(3, 4), ['hrrr']);
    assert.deepEqual(f.calls[0].args, ['rev-parse', 'HEAD']);assert.equal(f.calls[0].command, 'git');
    assert.equal(f.calls.length, 5);
  } finally { f.cleanup(); }
});

test('hrrr: a new run, any doubt or a changed pinned bake leaves the bake running', async () => {
  const guards = [...SAME_RUN_GUARDS];
  for (const [name, options, reason] of [
    ['new upstream init', {probe: {stdout: '2026101012\n'}}, /2026101012 is not the served hrrr run/],
    ['atmos re-pinned', {head: {stdout: `${'e'.repeat(40)}\n`}}, new RegExp(`atmos checkout e{40} is not the reviewed HRRR pin ${HRRR_REVIEWED_ATMOS_SHA}`)],
    ['atmos head short sha', {head: {stdout: '30a211be7\n'}}, /atmos checkout unknown is not the reviewed HRRR pin/],
    ['atmos head empty', {head: {stdout: ''}}, /atmos checkout unknown is not the reviewed HRRR pin/],
    ['atmos head unreadable', {head: new Error('git failed: not a git repository')}, /check unavailable: git failed/],
    ['probe failed', {probe: new Error('python failed: no init with complete data through +48h')}, /check unavailable: python failed/],
    ['probe noise', {probe: {stdout: 'lead_time not hourly\n'}}, /upstream run unavailable/],
    ['empty probe', {probe: {stdout: ''}}, /upstream run unavailable/],
    ['github unavailable', {commitDate: null}, /check unavailable: github-api-502/],
    ['collector changed', {script: hrrrScript('"$PY" fetch_hrrr.py --hours 36 --keep 2 --point-out "$ROOT/data/.hrrr-point" )')}, /collector invocation changed/],
    ['native backfill reaches hrrr', {script: hrrrScript(undefined, [guards[0], 'NATIVE_CHANGED=0\nif true; then\n', guards[2], guards[3]])}, /same-run decision changed/],
    ['extra same-run trigger', {script: hrrrScript(undefined, guards, '[ "$MODEL" != hrrr ] || NATIVE_CHANGED=1\n')}, /same-run decision changed/],
    ['unchanged exit changed', {script: hrrrScript(undefined, [guards[0], guards[1], guards[2], '  if [ "$ACTIVE_MODEL_RUN" = "$RUN_ID" ]; then\n'])}, /same-run decision changed/],
    ['point not paired', {script: hrrrScript(undefined, ['case "$MODEL" in ecmwf|gfs|aifs|icon) HAS_POINT=1 ;; *) HAS_POINT=0 ;; esac\n', guards[1], guards[2], guards[3]])}, /same-run decision changed/],
  ]) {
    const f = hrrrFixture(options);
    const logs = [];const original = console.log;console.log = line => logs.push(line);
    try {
      assert.equal(await f.run(), 0, name);
      assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=false\nserved_run=\n', name);
      assert.match(logs.join('\n'), reason, name);
      assert.match(readFileSync(f.summary, 'utf8'), /hrrr: the bake runs as before/, name);
    } finally { console.log = original;f.cleanup(); }
  }
  for (const [name, changes, reason] of [['re-bake requested', {REBAKE_SERVED_RUN: 'true'}, /rebake_served_run/],
    ['bootstrap', {BOOTSTRAP_MISSING: 'true'}, /bootstrap_missing/], ['staging', {CATALOG_TARGET: 'staging'}, /not production/]]) {
    const f = hrrrFixture();
    const logs = [];const original = console.log;console.log = line => logs.push(line);
    try {
      assert.equal(await f.run(changes), 0, name);
      assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=false\nserved_run=\n', name);
      assert.match(logs.join('\n'), reason, name);assert.equal(f.calls.length, 0, name);
    } finally { console.log = original;f.cleanup(); }
  }
});

test('hrrr: the probe asserts hourly leads and calls fetch_hrrr.pick_init(zarr, 48) like the bake', () => {
  const root = mkdtempSync(join(tmpdir(), 'stand-aside-hrrr-probe-'));
  const data = join(root, 'data');mkdirSync(data);
  const record = join(root, 'calls');
  // Minimal numpy/zarr stand-ins so the probe runs without the Atmos venv.
  writeFileSync(join(data, 'numpy.py'), 'class A(list):\n    def __mul__(self, k):\n        return A(x * k for x in self)\n    def __eq__(self, other):\n        return B(len(self) == len(other) and all(a == b for a, b in zip(self, other)))\nclass B:\n    def __init__(self, v):\n        self.v = v\n    def all(self):\n        return self.v\ndef arange(n):\n    return A(range(n))\n');
  writeFileSync(join(data, 'zarr.py'), `import os\ndef open_group(url, mode):\n    assert mode == 'r'\n    step = int(os.environ.get('LEAD_STEP', '3600'))\n    return {'url': url, 'lead_time': [h * step for h in range(49)]}\n`);
  writeFileSync(join(data, 'fetch_hrrr.py'), `from datetime import datetime, timezone\nSTORE = 'hrrr-store'\ndef pick_init(g, hours, want=None):\n    open(${JSON.stringify(record)}, 'a').write(f"hrrr {g['url']} {hours} {want}\\n")\n    return 41, datetime(2026, 10, 10, 6, tzinfo=timezone.utc)\n`);
  const probe = new URL('../tools/component-upstream-probe.py', import.meta.url).pathname;
  const run = (env = {}) => spawnSync('python3', ['-I', '-B', probe, 'hrrr', root], {encoding: 'utf8', env: {...process.env, ...env}});
  try {
    const ok = run();
    assert.equal(ok.stdout, '2026101006\n', ok.stderr);
    assert.equal(readFileSync(record, 'utf8'), 'hrrr hrrr-store 48 None\n');
    const lead = run({LEAD_STEP: '1800'});
    assert.notEqual(lead.status, 0);assert.match(lead.stderr, /lead_time not hourly/);assert.equal(lead.stdout, '');
    writeFileSync(join(data, 'fetch_hrrr.py'), "STORE = 'x'\ndef pick_init(g, hours, want=None, start=None):\n    raise AssertionError('not reached')\n");
    const changed = run();
    assert.notEqual(changed.status, 0);assert.match(changed.stderr, /selector signature changed/);assert.equal(changed.stdout, '');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('hrrr: the reviewed same-run lines are the pinned bake script\'s own', () => {
  // The pinned script (Atmos 30a211be7) is not in this repository; these are the reviewed lines.
  assert.deepEqual(SAME_RUN_GUARDS, [
    'case "$MODEL" in ecmwf|gfs|aifs|icon|hrrr) HAS_POINT=1 ;; *) HAS_POINT=0 ;; esac\n',
    'NATIVE_CHANGED=0\nif [ "$MODEL" = ecmwf ] || [ "$MODEL" = gfs ]; then\n',
    '  NATIVE_CHANGED="$(node -e \'process.stdout.write(JSON.parse(process.argv[1]).changed ? "1" : "0")\' "$NATIVE_JSON")"\nfi\n',
    '  if [ "$ACTIVE_MODEL_RUN" = "$RUN_ID" ] && [ "$ACTIVE_POINT_RUN" = "$RUN_ID" ] && [ "$NATIVE_CHANGED" = 0 ]; then\n' +
      '    echo "$MODEL and point-$MODEL unchanged ($RUN_ID) — no upload or pointer mutation"\n    exit 0\n']);
  assert.match(catalog, /ATMOS_SHA: 30a211be7692868f36380b809cd9b2bb01011e6a/);
  assert.equal(HRRR_REVIEWED_ATMOS_SHA, '30a211be7692868f36380b809cd9b2bb01011e6a');
});

test('hrrr: a re-pinned atmos checkout reads nothing else and the bake runs', async () => {
  const f = hrrrFixture({head: {stdout: `${'0'.repeat(40)}\n`}});
  const original = console.log;console.log = () => {};
  try {
    assert.equal(await f.run(), 0);
    assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=false\nserved_run=\n');
    assert.deepEqual(f.calls.map(call => call.command), ['git'], 'no precondition, manifest or probe read after a pin mismatch');
  } finally { console.log = original;f.cleanup(); }
});

test('ecmwf/gfs do not consult the HRRR or AIFS reviewed pin', async () => {
  const f = fixture();
  try {
    assert.equal(await f.run(), 0);
    assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=true\nserved_run=2026101000\n');
    assert.ok(!f.calls.some(call => call.command === 'git'));
  } finally { f.cleanup(); }
});

// AIFS: the hourly slow lane. fetch_aifs.py --keep 1 leaves one run, RUN_ID is that run, and the pinned
// bake publishes AIFS only when the run id moves (no native backfill, no enrichment), so a served pair
// at the init fetch_aifs.latest_run(360) returns is exactly the bake's "unchanged" outcome.
const AIFS_PREFIX = 'components/aifs/aifs-20261020T000000Z-1792477278/';
const AIFS_GENERATION = '2026-10-20T00:00:00.000Z';
const AIFS_NOW = Date.parse('2026-10-20T09:08:00Z');
const aifsManifest = (changes = {}) => Buffer.from(`${JSON.stringify({schemaVersion: 1, componentId: 'aifs',
  artifactId: 'aifs-20261020T000000Z-1792477278', generationTime: AIFS_GENERATION, completedAt: '2026-10-20T06:21:34.000Z',
  rootPrefix: AIFS_PREFIX, mounts: ['data/aifs/'], objectCount: 369, inventorySha256: 'a'.repeat(64),
  quality: {status: 'passed', checks: ['manifest', 'inventory', 'remote_bytes', 'coverage', 'freshness', 'live_superset',
    'horizon', 'cadence', 'grid', 'referenced_bytes']}, ...changes})}\n`);
function aifsEvidence({manifest = aifsManifest(), map = {}, point = {}, ...rest} = {}) {
  return {model: 'aifs', upstreamRun: '2026102000', definitionChangedAt: '2026-10-20T05:00:00Z', manifestBytes: manifest, now: AIFS_NOW,
    map: {EXPECTED_COMPONENT_MANIFEST_SHA256: sha256(manifest), EXPECTED_CATALOG_ROLLBACK_EPOCH: '7',
      ACTIVE_COMPONENT_GENERATION_TIME: AIFS_GENERATION, ACTIVE_COMPONENT_MANIFEST_KEY: `${AIFS_PREFIX}component.json`,
      ACTIVE_COMPONENT_ROOT_PREFIX: AIFS_PREFIX, ...map},
    point: {EXPECTED_COMPONENT_MANIFEST_SHA256: 'b'.repeat(64), EXPECTED_CATALOG_ROLLBACK_EPOCH: '7',
      ACTIVE_COMPONENT_GENERATION_TIME: AIFS_GENERATION, ...point}, ...rest};
}
const aifsScript = (collector = COLLECTOR_CALLS.aifs, guards = SAME_RUN_GUARDS, extra = '') =>
  `${guards[0]}  aifs) ( cd "$ROOT/data" && ${collector} ;;\n${guards[1]}  NATIVE_JSON=x\n${guards[2]}${extra}${guards[3]}  fi\n`;

test('aifs: stands aside only for the served pair at the newest upstream init, at most 16 h old, without native bundles', () => {
  const yes = decide(aifsEvidence());
  assert.equal(yes.standAside, true);assert.equal(yes.run, '2026102000');assert.equal(yes.rootPrefix, AIFS_PREFIX);
  assert.match(summaryText('aifs', yes), /aifs stood aside[\s\S]*run 2026102000[\s\S]*Nothing was hydrated[\s\S]*rebake_served_run: true/);
  const hour = 3600000;
  for (const [name, input, reason] of [
    ['new upstream cycle', aifsEvidence({upstreamRun: '2026102006'}), /newest upstream run 2026102006 is not the served aifs run 2026102000/],
    ['upstream walked back below the served run', aifsEvidence({upstreamRun: '2026101918'}), /2026101918 is not the served aifs run/],
    ['probe failed', aifsEvidence({upstreamRun: ''}), /upstream run unavailable/],
    ['partial-run noise as last line', aifsEvidence({upstreamRun: 'run 2026102006 step 360h still partial'}), /upstream run unavailable/],
    ['no map', aifsEvidence({map: {ACTIVE_COMPONENT_GENERATION_TIME: ''}}), /no aifs component/],
    ['point behind', aifsEvidence({point: {ACTIVE_COMPONENT_GENERATION_TIME: '2026-10-19T18:00:00.000Z'}}), /served point-aifs run 2026101918/],
    ['no point', aifsEvidence({point: {ACTIVE_COMPONENT_GENERATION_TIME: ''}}), /no point-aifs component/],
    ['catalog moved', aifsEvidence({point: {EXPECTED_CATALOG_ROLLBACK_EPOCH: '8'}}), /catalog changed/],
    ['hash mismatch', aifsEvidence({map: {EXPECTED_COMPONENT_MANIFEST_SHA256: 'd'.repeat(64)}}), /does not match the catalog hash/],
    ['missing manifest', {...aifsEvidence(), manifestBytes: null}, /does not match the catalog hash/],
    ['hrrr manifest under aifs', aifsEvidence({manifest: aifsManifest({componentId: 'hrrr'})}), /not the catalog's passed/],
    ['other root', aifsEvidence({manifest: aifsManifest({rootPrefix: 'components/ecmwf/x/'})}), /not the catalog's passed/],
    ['other run in manifest', aifsEvidence({manifest: aifsManifest({generationTime: '2026-10-19T18:00:00.000Z'})}), /not the catalog's passed/],
    ['failed quality', aifsEvidence({manifest: aifsManifest({quality: {status: 'failed', checks: []}})}), /not the catalog's passed/],
    ['near the 18 h freshness gate', aifsEvidence({now: Date.parse(AIFS_GENERATION) + (AIFS_MAX_SERVED_AGE_HOURS + 0.1) * hour}), /served aifs run 2026102000 is not within 16 h/],
    ['future init', aifsEvidence({now: Date.parse(AIFS_GENERATION) - 60000}), /not within 16 h/],
    ['no clock', aifsEvidence({now: NaN}), /not within 16 h/],
    ['no completion', aifsEvidence({manifest: aifsManifest({completedAt: undefined})}), /no completion time/],
    ['re-pinned since', aifsEvidence({definitionChangedAt: '2026-10-20T07:00:00Z'}), /predates this lane's definition/],
  ]) {
    const result = decide(input);
    assert.equal(result.standAside, false, name);assert.match(result.reason, reason, name);
  }
  assert.equal(decide(aifsEvidence({now: Date.parse(AIFS_GENERATION) + AIFS_MAX_SERVED_AGE_HOURS * hour})).standAside, true);
  // Below the bake's gate (validate-model-component.py MAX_AGE_HOURS.aifs = 18), above the 14.2 h a served run reached at a tick (10-17..10-23).
  assert.equal(AIFS_MAX_SERVED_AGE_HOURS, 16);assert.equal(HRRR_MAX_SERVED_AGE_HOURS, 10);
  // ECMWF/GFS still need native bundles; AIFS and HRRR never do.
  assert.match(decide(evidence({manifest: manifestFor({quality: {status: 'passed', checks: ['manifest']}})})).reason, /native viewport/);
});

function aifsFixture({probe = {stdout: 'AIFS origin failover -> x\n2026102000\n'}, script = aifsScript(), commitDate = '2026-10-20T05:00:00Z',
  head = {stdout: `${AIFS_REVIEWED_ATMOS_SHA}\n`}} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'stand-aside-aifs-'));
  mkdirSync(join(root, 'ops/platform'), {recursive: true});mkdirSync(join(root, 'data'), {recursive: true});
  writeFileSync(join(root, 'ops/bake-model-component.sh'), script);
  const manifest = aifsManifest();
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({command, args, env: options.env, cwd: options.cwd});
    if (command === 'git') { if (head instanceof Error) throw head; return head; }
    if (command === 'bash') {
      const id = options.env.COMPONENT_ID;
      writeFileSync(options.env.GITHUB_ENV, id === 'aifs'
        ? `EXPECTED_COMPONENT_MANIFEST_SHA256=${sha256(manifest)}\nEXPECTED_CATALOG_ROLLBACK_EPOCH=7\nACTIVE_COMPONENT_GENERATION_TIME=${AIFS_GENERATION}\nACTIVE_COMPONENT_MANIFEST_KEY=${AIFS_PREFIX}component.json\nACTIVE_COMPONENT_ROOT_PREFIX=${AIFS_PREFIX}\n`
        : `EXPECTED_COMPONENT_MANIFEST_SHA256=${'b'.repeat(64)}\nEXPECTED_CATALOG_ROLLBACK_EPOCH=7\nACTIVE_COMPONENT_GENERATION_TIME=${AIFS_GENERATION}\n`);
      return {stdout: ''};
    }
    if (command === 'rclone') { writeFileSync(args[2], manifest); return {stdout: ''}; }
    if (probe instanceof Error) throw probe;
    return probe;
  };
  const fetcher = async () => commitDate ? new Response(JSON.stringify([{commit: {committer: {date: commitDate}}}])) : new Response('{}', {status: 502});
  const output = join(root, 'out'), summary = join(root, 'summary');
  const env = {MODEL: 'aifs', CATALOG_TARGET: 'production', BOOTSTRAP_MISSING: 'false', REBAKE_SERVED_RUN: 'false',
    GITHUB_SHA: SHA, GH_TOKEN: 'fixture', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: root,
    GITHUB_ENV: join(root, 'job-env'), COMPONENT_R2_REMOTE: 'weatherx:weatherx-components-production'};
  return {calls, output, summary, env,
    run: changes => main([root, join(root, 'probe.py')], {...env, ...changes}, {exec, fetcher, clock: () => AIFS_NOW}),
    cleanup: () => rmSync(root, {recursive: true, force: true})};
}

test('aifs: same run stands aside; reads only the pin, the precondition, the served manifest and the probe', async () => {
  const f = aifsFixture();
  try {
    assert.equal(await f.run(), 0);
    assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=true\nserved_run=2026102000\n');
    assert.match(readFileSync(f.summary, 'utf8'), /### Component bake: aifs stood aside/);
    assert.deepEqual(f.calls.map(call => call.command).slice(0, 4), ['git', 'bash', 'bash', 'rclone']);
    assert.deepEqual(f.calls[0].args, ['rev-parse', 'HEAD']);
    const hydrate = f.calls.filter(call => call.command === 'bash');
    assert.deepEqual(hydrate.map(call => call.env.COMPONENT_ID), ['aifs', 'point-aifs']);
    for (const call of hydrate) {
      assert.equal(call.env.PRECONDITION_ONLY, '1');assert.equal(call.env.HYDRATE_MISSING_FROM_RELEASE, '0');
      assert.notEqual(call.env.GITHUB_ENV, f.env.GITHUB_ENV, 'precondition values must not reach later steps');
    }
    assert.deepEqual(f.calls.find(call => call.command === 'rclone').args.slice(0, 2),
      ['copyto', `weatherx:weatherx-components-production/${AIFS_PREFIX}component.json`]);
    const probe = f.calls.find(call => call.command.endsWith('data/.venv/bin/python'));
    assert.deepEqual(probe.args.slice(0, 2), ['-I', '-B']);assert.deepEqual(probe.args.slice(3, 4), ['aifs']);
    assert.equal(f.calls.length, 5);
  } finally { f.cleanup(); }
});

test('aifs: a new cycle, any doubt or a changed pinned bake leaves the bake running', async () => {
  const guards = [...SAME_RUN_GUARDS];
  for (const [name, options, reason] of [
    ['new upstream cycle', {probe: {stdout: '2026102006\n'}}, /2026102006 is not the served aifs run/],
    ['atmos re-pinned', {head: {stdout: `${'e'.repeat(40)}\n`}}, new RegExp(`atmos checkout e{40} is not the reviewed AIFS pin ${AIFS_REVIEWED_ATMOS_SHA}`)],
    ['atmos head short sha', {head: {stdout: '30a211be7\n'}}, /atmos checkout unknown is not the reviewed AIFS pin/],
    ['atmos head unreadable', {head: new Error('git failed: not a git repository')}, /check unavailable: git failed/],
    ['no complete run upstream', {probe: new Error('python failed: no complete AIFS-single open-data run found in the last 2 days')}, /check unavailable: python failed/],
    ['empty probe', {probe: {stdout: ''}}, /upstream run unavailable/],
    ['github unavailable', {commitDate: null}, /check unavailable: github-api-502/],
    ['keep changed', {script: aifsScript('"$PY" fetch_aifs.py --hours 360 --keep 2 --float-out "$ROOT/data/.aifs-float" --point-out "$ROOT/data/.aifs-point" )')}, /collector invocation changed/],
    ['horizon changed', {script: aifsScript('"$PY" fetch_aifs.py --hours 240 --keep 1 --float-out "$ROOT/data/.aifs-float" --point-out "$ROOT/data/.aifs-point" )')}, /collector invocation changed/],
    ['native backfill reaches aifs', {script: aifsScript(undefined, [guards[0], 'NATIVE_CHANGED=0\nif [ "$MODEL" != hrrr ]; then\n', guards[2], guards[3]])}, /AIFS check not reviewed/],
    ['extra same-run trigger', {script: aifsScript(undefined, guards, '[ "$MODEL" != aifs ] || NATIVE_CHANGED=1\n')}, /same-run decision changed/],
    ['unchanged exit changed', {script: aifsScript(undefined, [guards[0], guards[1], guards[2], '  if [ "$ACTIVE_MODEL_RUN" = "$RUN_ID" ]; then\n'])}, /same-run decision changed/],
    ['point not paired', {script: aifsScript(undefined, ['case "$MODEL" in ecmwf|gfs|icon|hrrr) HAS_POINT=1 ;; *) HAS_POINT=0 ;; esac\n', guards[1], guards[2], guards[3]])}, /same-run decision changed/],
  ]) {
    const f = aifsFixture(options);
    const logs = [];const original = console.log;console.log = line => logs.push(line);
    try {
      assert.equal(await f.run(), 0, name);
      assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=false\nserved_run=\n', name);
      assert.match(logs.join('\n'), reason, name);
      assert.match(readFileSync(f.summary, 'utf8'), /aifs: the bake runs as before/, name);
    } finally { console.log = original;f.cleanup(); }
  }
  for (const [name, changes, reason] of [['re-bake requested', {REBAKE_SERVED_RUN: 'true'}, /rebake_served_run/],
    ['bootstrap', {BOOTSTRAP_MISSING: 'true'}, /bootstrap_missing/], ['staging', {CATALOG_TARGET: 'staging'}, /not production/]]) {
    const f = aifsFixture();
    const logs = [];const original = console.log;console.log = line => logs.push(line);
    try {
      assert.equal(await f.run(changes), 0, name);
      assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=false\nserved_run=\n', name);
      assert.match(logs.join('\n'), reason, name);assert.equal(f.calls.length, 0, name);
    } finally { console.log = original;f.cleanup(); }
  }
});

test('aifs: a re-pinned atmos checkout reads nothing else and the bake runs', async () => {
  const f = aifsFixture({head: {stdout: `${'0'.repeat(40)}\n`}});
  const original = console.log;console.log = () => {};
  try {
    assert.equal(await f.run(), 0);
    assert.equal(readFileSync(f.output, 'utf8'), 'stand_aside=false\nserved_run=\n');
    assert.deepEqual(f.calls.map(call => call.command), ['git'], 'no precondition, manifest or probe read after a pin mismatch');
  } finally { console.log = original;f.cleanup(); }
});

test('aifs: the probe calls fetch_aifs.latest_run(360) like the bake and prints the init last', () => {
  const root = mkdtempSync(join(tmpdir(), 'stand-aside-aifs-probe-'));
  const data = join(root, 'data');mkdirSync(data);
  const record = join(root, 'calls');
  // latest_run prints its walk-back to stdout; the caller reads the probe's last line only.
  writeFileSync(join(data, 'fetch_aifs.py'), `import os, sys\nfrom datetime import datetime, timezone\ndef latest_run(last_step=0, start=None):\n    open(${JSON.stringify(record)}, 'a').write(f'aifs {last_step} {start} {os.getcwd()}\\n')\n    if os.environ.get('NO_RUN'):\n        sys.exit('no complete AIFS-single open-data run found in the last 2 days')\n    print('  run 2026102006 step 360h still partial (1 < 2 bytes), falling back', flush=True)\n    return datetime(2026, 10, 20, 0, tzinfo=timezone.utc)\n`);
  const probe = new URL('../tools/component-upstream-probe.py', import.meta.url).pathname;
  const run = (env = {}) => spawnSync('python3', ['-I', '-B', probe, 'aifs', root], {encoding: 'utf8', env: {...process.env, ...env}});
  try {
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim().split('\n').slice(-1)[0], '2026102000');
    assert.match(readFileSync(record, 'utf8'), /^aifs 360 None .*\/data\n$/);
    const none = run({NO_RUN: '1'});
    assert.notEqual(none.status, 0);assert.match(none.stderr, /no complete AIFS-single/);assert.equal(none.stdout, '');
    writeFileSync(join(data, 'fetch_aifs.py'), "def latest_run(last_step=0, start=None, short_last_step=None):\n    raise AssertionError('not reached')\n");
    const changed = run();
    assert.notEqual(changed.status, 0);assert.match(changed.stderr, /selector signature changed/);assert.equal(changed.stdout, '');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('aifs: the reviewed pin, collector call and guard set are the ones reviewed at Atmos 30a211be7', () => {
  assert.equal(AIFS_REVIEWED_ATMOS_SHA, '30a211be7692868f36380b809cd9b2bb01011e6a');
  assert.match(catalog, /ATMOS_SHA: 30a211be7692868f36380b809cd9b2bb01011e6a/);
  // HAS_POINT pairs aifs; NATIVE_CHANGED is reset and only set inside the ECMWF/GFS block.
  assert.match(SAME_RUN_GUARDS[0], /ecmwf\|gfs\|aifs\|icon\|hrrr\) HAS_POINT=1/);
  assert.match(SAME_RUN_GUARDS[1], /if \[ "\$MODEL" = ecmwf \] \|\| \[ "\$MODEL" = gfs \]; then/);
  assert.match(COLLECTOR_CALLS.aifs, /--hours 360 --keep 1 /);
});
