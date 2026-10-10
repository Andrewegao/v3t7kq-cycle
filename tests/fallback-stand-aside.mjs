// GitHub cron fallbacks stand aside when the scheduler Worker already ran the lane.
// The Worker dispatches every on-time lane; the GitHub `schedule` on the same workflow stays as a
// fallback, but GitHub delivers it hours late (2026-10-10: bake cron run 38077160747 at 18:46Z
// repeated the 14:35Z dispatch 38060223583, a full three-hour whole bake). Each workflow that has
// both gets one read-only first job, `fallback-gate`, that runs only on `schedule`: it lists this
// workflow's workflow_dispatch runs in the lane's window and outputs run=false when one succeeded
// or is still queued/running, so every other job skips. A dispatched run skips the gate, and the
// appended condition is then true, so dispatched runs behave exactly as before. The gate is
// fail-open: any API, parse or job failure leaves the fallback running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseWorkflow } from '../tools/workflow-inventory.mjs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const GATE = "needs.fallback-gate.outputs.run != 'false'";
const STATUS = /\b(?:always|cancelled|failure|success)\(\)/;

// window: minutes looked back; title: the run title of an equivalent dispatched run ('' = any).
// runName: the run-name fragment that yields that title for the Worker's dispatch inputs.
const LANES = {
  'bake.yml': { window: 330, title: 'bake: all models + whole-data maintenance',
    runName: "|| 'bake: all models + whole-data maintenance' }}" },
  'fusion-issue.yml': { window: 330, title: '' },
  'staging-search.yml': { window: 330, title: '' },
  'glofas-ingest.yml': { window: 90, title: 'energy glofas: dispatched (today)',
    runName: "format('energy glofas: dispatched ({0})', inputs.date || 'today')" },
  'cams-ingest.yml': { window: 90, title: 'energy cams: dispatched (newest published run)',
    runName: "format('energy cams: dispatched ({0})', inputs.run || 'newest published run')" },
};
// Worker-dispatched workflows with a GitHub schedule that deliberately carry no gate.
const EXEMPT = {
  // Its own switch already turns the fallback off (every job requires it), and the workflow is a
  // component-bake definition path: editing it re-bakes served ECMWF/GFS components once.
  'catalog-bake.yml': source => {
    const { jobs } = parseWorkflow(source, 'catalog-bake.yml').data;
    for (const job of Object.values(jobs)) assert.match(job.if, /vars\.CATALOG_GITHUB_FALLBACK_DISABLED != 'true'/);
    assert.match(read('tools/component-bake-stand-aside.mjs'), /DEFINITION_PATHS = Object\.freeze\(\['\.github\/workflows\/catalog-bake\.yml'/);
  },
  // Disabled lane (SATELLITE_ARCHIVE_ENABLED); revisit with the gate when it is re-enabled.
  'satellite-archive.yml': source => {
    assert.match(parseWorkflow(source, 'satellite-archive.yml').data.jobs.hourly.if, /vars\.SATELLITE_ARCHIVE_ENABLED == '1'/);
  },
  // The workflow is inside the reviewed controller closure (STAGING_PLACES_RENEWAL_CONTROLLER_SHA256),
  // and the run list cannot tell a surf dispatch from an all-families one (no run-name).
  'staging-place-renewal.yml': source => {
    assert.match(read('tools/staging-place-renewal.mjs'), /export const CLOSURE = \['\.github\/workflows\/staging-place-renewal\.yml'/);
    assert.doesNotMatch(source, /^run-name:/m);
  },
  // A scheduled run already stands aside when production serves a tide dataset under 20 h old,
  // and the workflow is inside PRODUCTION_PLACES_RENEWAL_CONTROLLER_SHA256's closure.
  'production-place-renewal.yml': () => {
    const tool = read('tools/production-place-renewal.mjs');
    assert.match(tool, /if \(env\.GITHUB_EVENT_NAME === 'schedule'\) \{\n[^\n]*\n\s+run = true; standAside = true;/);
    assert.match(tool, /export const CLOSURE = \[WORKFLOW,/);
  },
};

const workflowFiles = readdirSync(new URL('../.github/workflows/', import.meta.url)).filter(name => /\.ya?ml$/.test(name));
const workflows = Object.fromEntries(workflowFiles.map(name => {
  const source = read(`.github/workflows/${name}`);
  return [name, { source, data: parseWorkflow(source, name).data }];
}));

function workerWorkflows() {
  const index = read('scheduler/src/index.ts');
  const wrangler = read('scheduler/wrangler.jsonc');
  const names = new Set([...index.matchAll(/'([a-z0-9-]+\.yml)'/g)].map(match => match[1]));
  for (const [, name] of wrangler.matchAll(/"[A-Z_]*WORKFLOW":\s*"([a-z0-9-]+\.yml)"/g)) names.add(name);
  return [...names].sort();
}

function slotMinutes(cron) {
  const [minute, hour, ...rest] = cron.split(/\s+/);
  assert.deepEqual(rest, ['*', '*', '*'], cron);
  assert.match(minute, /^\d+$/, cron);
  const hours = hour === '*' ? [...Array(24).keys()] : hour.startsWith('*/')
    ? [...Array(24).keys()].filter(h => h % Number(hour.slice(2)) === 0) : hour.split(',').map(Number);
  return hours.map(h => h * 60 + Number(minute));
}

// The existing expression is kept verbatim; one with a top-level || is wrapped in one pair of
// parentheses, so the appended && can never bind into one of its alternatives.
function assertKept(expression, label) {
  let depth = 0;
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === '(') depth++;
    else if (expression[i] === ')') depth--;
    else assert.ok(depth > 0 || !expression.startsWith('||', i), `${label}: unwrapped top-level ||`);
  }
  assert.equal(depth, 0, label);
}

function gatedJobs(jobs) {
  const memo = new Map();
  const gated = id => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, false);
    const job = jobs[id];
    const needs = [job.needs ?? []].flat();
    const condition = String(job.if ?? '');
    const value = (needs.includes('fallback-gate') && condition.includes(GATE)) ||
      (!STATUS.test(condition) && needs.some(gated));
    memo.set(id, value);
    return value;
  };
  return gated;
}

test('every Worker-dispatched workflow with a GitHub schedule is gated or exempt for a pinned reason', () => {
  const scheduled = workerWorkflows().filter(name => {
    assert.ok(workflows[name], `scheduler names a missing workflow ${name}`);
    return Boolean(workflows[name].data.on?.schedule);
  });
  assert.deepEqual(scheduled, [...Object.keys(LANES), ...Object.keys(EXEMPT)].sort());
  for (const [name, check] of Object.entries(EXEMPT)) {
    check(workflows[name].source);
    assert.equal(workflows[name].data.jobs['fallback-gate'], undefined, name);
  }
  // No other workflow carries the gate.
  for (const name of workflowFiles) {
    if (!LANES[name]) assert.doesNotMatch(workflows[name].source, /fallback-gate/, name);
  }
});

test('the gate is one read-only first job that runs only on the GitHub schedule', () => {
  const scripts = new Set();
  for (const [name, lane] of Object.entries(LANES)) {
    const { data } = workflows[name];
    assert.equal(Object.keys(data.jobs)[0], 'fallback-gate', name);
    const gate = data.jobs['fallback-gate'];
    assert.equal(gate.name, 'fallback gate');
    assert.equal(gate.if, "${{ github.event_name == 'schedule' }}", `${name}: a dispatched run never consults the gate`);
    assert.deepEqual(gate.permissions, { actions: 'read' }, name);
    assert.ok(gate['timeout-minutes'] <= 3, name);
    assert.equal(gate.needs, undefined);
    assert.equal(gate.environment, undefined);
    assert.equal(gate.concurrency, undefined);
    assert.deepEqual(gate.outputs, { run: '${{ steps.gate.outputs.run }}' });
    assert.doesNotMatch(JSON.stringify(gate), /secrets|write|\/dispatches|workflow run/);
    assert.equal(gate.steps.length, 1, `${name}: no checkout, one step`);
    const [step] = gate.steps;
    assert.equal(step.id, 'gate');
    assert.equal(step.uses, undefined);
    assert.equal(step.shell, undefined);
    assert.deepEqual(step.env, { GH_TOKEN: '${{ github.token }}', WINDOW_MINUTES: String(lane.window), DISPATCH_TITLE: lane.title }, name);
    scripts.add(step.run);
    if (lane.title) assert.ok(String(data['run-name']).includes(lane.runName), `${name}: dispatch title comes from its run-name`);
    else assert.equal(data['run-name'], undefined, `${name}: without a run-name any dispatched run counts`);
    assert.ok(data.on.workflow_dispatch !== undefined && data.on.schedule, name);
  }
  assert.equal(scripts.size, 1, 'every lane runs the same gate script byte for byte');
  const [script] = scripts;
  assert.equal(script.match(/gh api/g).length, 1);
  assert.match(script, /gh api --method GET "repos\/\$GITHUB_REPOSITORY\/actions\/workflows\/\$workflow\/runs"/);
  assert.match(script, /-f event=workflow_dispatch -f branch=main/);
});

test('each window holds this slot\'s dispatch but never the previous slot\'s', () => {
  for (const [name, lane] of Object.entries(LANES)) {
    const slots = [workflows[name].data.on.schedule].flat().flatMap(({ cron }) => slotMinutes(cron)).sort((a, b) => a - b);
    const gaps = slots.map((slot, i) => (i + 1 < slots.length ? slots[i + 1] : slots[0] + 1440) - slot);
    const shortest = Math.min(...gaps);
    // 30 min margin: an on-time fallback (at or before the Worker tick) never sees the previous
    // slot's dispatch, so it still runs and the Worker's own dedupe stands aside instead.
    assert.ok(lane.window + 30 <= shortest, `${name}: window ${lane.window} vs shortest gap ${shortest}`);
    assert.ok(lane.window >= shortest / 2, `${name}: window must cover a late fallback`);
  }
});

test('every other job depends on the gate, and dispatched runs keep their conditions', () => {
  for (const name of Object.keys(LANES)) {
    const { jobs } = workflows[name].data;
    const gated = gatedJobs(jobs);
    for (const [id, job] of Object.entries(jobs)) {
      if (id === 'fallback-gate') continue;
      assert.ok(gated(id), `${name}: ${id} would still run when the fallback stands aside`);
      const needs = [job.needs ?? []].flat();
      if (!needs.includes('fallback-gate')) continue;
      const condition = String(job.if);
      const bare = condition.replace(/^\$\{\{ ([^]*) \}\}$/, '$1');
      if (needs.length === 1) {
        // A first job: only the gate precedes it, so !cancelled() is its former implicit success().
        const shape = new RegExp(`^(?:([^]*) && )?!cancelled\\(\\) && ${GATE.replace(/[.()]/g, '\\$&')}$`).exec(bare);
        assert.ok(shape, `${name}: ${id}`);
        assertKept(shape[1] ?? '', `${name}: ${id}`);
        assert.ok(!STATUS.test(shape[1] ?? ''), `${name}: ${id} already had a status function`);
      } else {
        // A reporting job that already runs after failures keeps its status function unchanged.
        assert.ok(bare.endsWith(` && ${GATE}`), `${name}: ${id}`);
        assertKept(bare.slice(0, -` && ${GATE}`.length), `${name}: ${id}`);
        assert.ok(STATUS.test(bare.slice(0, -` && ${GATE}`.length)), `${name}: ${id}`);
        assert.equal(needs.at(-1), 'fallback-gate');
      }
    }
  }
});

test('bake keeps its job names, model conditions and whole-maintenance join', () => {
  const { jobs } = workflows['bake.yml'].data;
  const models = ['core-ecmwf', 'core-gfs', 'core-hrrr', 'core-aifs', 'regional-icon', 'regional-hrdps',
    'regional-arome-antilles', 'regional-hrrr-ak', 'regional-nam', 'regional-nam-hi', 'regional-nam-ak'];
  for (const id of models) {
    assert.deepEqual([jobs[id].needs].flat(), ['fallback-gate'], id);
    const model = id.replace(/^(?:core|regional)-/, '');
    assert.ok(jobs[id].if.includes(`(inputs.model == '' || inputs.model == 'all' || inputs.model == '${model}')`), id);
  }
  for (const id of ['staging-wind100', 'production-wind100', ...models.map(id => `publish-${id.replace(/^(?:core|regional)-/, '')}`)]) {
    assert.ok(![jobs[id].needs].flat().includes('fallback-gate'), `${id} follows its collector`);
    assert.doesNotMatch(jobs[id].if, /fallback-gate/);
  }
  assert.deepEqual(Object.keys(jobs), ['fallback-gate', 'core-ecmwf', 'staging-wind100', 'production-wind100', ...models.slice(1),
    ...models.map(id => `publish-${id.replace(/^(?:core|regional)-/, '')}`), 'component-publish-status', 'bake', 'model-status', 'run-summary']);
});

// Runs the shared gate script exactly as a GitHub `run:` step (bash -eo pipefail) against a fake gh.
function runGate(t, { body, ghFails = false, title = 'bake: all models + whole-data maintenance', window = '330' }) {
  const dir = mkdtempSync(join(tmpdir(), 'fallback-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = workflows['bake.yml'].data.jobs['fallback-gate'].steps[0].run;
  writeFileSync(join(dir, 'step.sh'), script);
  writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "$FAKE_GH_ARGS"\n${ghFails ? 'echo "HTTP 502" >&2; exit 1' : 'cat "$FAKE_GH_BODY"'}\n`);
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'body.json'), typeof body === 'string' ? body : JSON.stringify(body ?? {}));
  const env = {
    PATH: `${dir}:${process.env.PATH}`, FAKE_GH_ARGS: join(dir, 'args'), FAKE_GH_BODY: join(dir, 'body.json'),
    GITHUB_OUTPUT: join(dir, 'output'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
    GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/bake.yml@refs/heads/main',
    GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_RUN_ID: '999', GH_TOKEN: 'fixture',
    WINDOW_MINUTES: window, DISPATCH_TITLE: title,
  };
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(dir, 'step.sh')], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const read = file => { try { return readFileSync(join(dir, file), 'utf8'); } catch { return ''; } };
  return { output: read('output'), summary: read('summary'), args: read('args').split('\n'), stdout: result.stdout };
}

const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dispatched = (extra = {}) => ({ id: 101, event: 'workflow_dispatch', head_branch: 'main', created_at: ago(240),
  display_title: 'bake: all models + whole-data maintenance', status: 'completed', conclusion: 'success', ...extra });

test('a schedule run stands aside for a successful or still active scheduler run in its window', t => {
  const aside = runGate(t, { body: { workflow_runs: [dispatched()] } });
  assert.equal(aside.output, 'run=false\n');
  assert.match(aside.summary, /stood aside: dispatched run 101/);
  assert.match(aside.stdout, /::notice::Stood aside: dispatched run 101/);
  // One read-only GET of this workflow's own dispatched runs on main, since the window opened.
  assert.deepEqual(aside.args.slice(0, 4), ['api', '--method', 'GET', 'repos/Andrewegao/v3t7kq-cycle/actions/workflows/bake.yml/runs']);
  assert.ok(aside.args.includes('event=workflow_dispatch') && aside.args.includes('branch=main'));
  const since = aside.args.find(arg => arg.startsWith('created=>='));
  assert.ok(Math.abs(Date.parse(since.slice(10)) - (Date.now() - 330 * 60_000)) < 120_000, since);
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested'])
    assert.equal(runGate(t, { body: { workflow_runs: [dispatched({ status, conclusion: null })] } }).output, 'run=false\n', status);
  // Without a run-name every dispatched run counts.
  assert.equal(runGate(t, { title: '', body: { workflow_runs: [dispatched({ display_title: 'WeatherX fusion issuance' })] } }).output, 'run=false\n');
});

test('the fallback runs when nothing equivalent ran from the scheduler', t => {
  for (const [why, runs] of [
    ['no dispatched run', []],
    ['failed dispatch', [dispatched({ conclusion: 'failure' })]],
    ['cancelled dispatch', [dispatched({ conclusion: 'cancelled' })]],
    ['outside the window', [dispatched({ created_at: ago(331) })]],
    ['different run title', [dispatched({ display_title: 'bake: staging Wind100 only (whole-data maintenance skipped)' })]],
    ['single-model run', [dispatched({ display_title: 'bake: gfs only (whole-data maintenance skipped)' })]],
    ['this run', [dispatched({ id: 999 })]],
    ['another schedule run', [dispatched({ event: 'schedule' })]],
    ['another branch', [dispatched({ head_branch: 'feature' })]],
    ['missing creation time', [dispatched({ created_at: null })]],
  ]) {
    const result = runGate(t, { body: { workflow_runs: runs } });
    assert.equal(result.output, 'run=true\n', why);
    assert.match(result.summary, /Fallback schedule runs: .*\(none\)/, why);
  }
});

test('the gate fails open: an unreadable run list leaves the fallback running', t => {
  for (const [why, options] of [
    ['API error', { ghFails: true }],
    ['not JSON', { body: '<html>rate limited</html>' }],
    ['no run list', { body: { message: 'Not Found' } }],
    ['run list is not an array', { body: { workflow_runs: 'x' } }],
    ['bad window', { window: 'five hours', body: { workflow_runs: [dispatched()] } }],
  ]) {
    const result = runGate(t, options);
    assert.equal(result.output, 'run=true\n', why);
    assert.match(result.stdout, /::warning::Could not read this workflow's dispatched runs; the fallback runs\./, why);
    assert.match(result.summary, /\(unreadable\)/, why);
  }
});
