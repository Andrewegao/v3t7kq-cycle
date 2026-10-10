import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {COLLECTOR_CALLS, DEFINITION_PATHS, decide, eligibility, main, parsePrecondition, runFromTime, summaryText}
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

test('only production ECMWF/GFS without bootstrap, re-bake or short-run selection is eligible', () => {
  const base = {model: 'ecmwf', target: 'production', bootstrapMissing: 'false', rebakeServedRun: 'false', shortRuns: ''};
  assert.equal(eligibility(base), null);
  assert.equal(eligibility({...base, model: 'gfs'}), null);
  for (const [change, reason] of [[{model: 'hrrr'}, /not an ECMWF\/GFS/], [{model: 'aifs'}, /not an ECMWF\/GFS/],
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
    ['hrrr', {}, {MODEL: 'hrrr'}, /not an ECMWF\/GFS/],
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
    assert.notEqual(run('hrrr').status, 0);
    writeFileSync(join(data, 'fetch_ecmwf.py'), 'def latest_run(last_step=0, start=None):\n    raise AssertionError("not reached")\n');
    const changed = run('ecmwf');
    assert.notEqual(changed.status, 0);assert.match(changed.stderr, /selector signature changed/);assert.equal(changed.stdout, '');
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test('collector call strings still match the pinned bake script shape', () => {
  // The pinned script (Atmos 81e061dae0) is not in this repository; these are the reviewed lines.
  assert.equal(COLLECTOR_CALLS.ecmwf, '"$PY" fetch_ecmwf.py --hours 336 --keep 2 ${ecmwf_run_args[@]+"${ecmwf_run_args[@]}"}');
  assert.equal(COLLECTOR_CALLS.gfs, '"$PY" fetch.py --hours 72 --point-hours 336 --keep 2 ');
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
  assert.match(check, /if: \$\{\{ env\.CATALOG_TARGET == 'production' && \(matrix\.model == 'ecmwf' \|\| matrix\.model == 'gfs'\) && inputs\.bootstrap_missing != true && inputs\.rebake_served_run != true \}\}/);
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
