// Invariant: no lock is held across an unbounded wait. A job that holds a concurrency group (its own
// or its workflow's) and names an environment without required reviewers waits at that gate while
// holding the group, and timeout-minutes does not tick during an environment wait: after the
// 2026-10-12 Actions incident two such jobs held production writer locks for six days. Every such
// job must be listed in ops/lock-environment-allowlist.json; the list may only shrink (W6 moves the
// environments off the lock-holding jobs and takes it to zero). Needs `npm ci --prefix tools/inventory`.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {parseWorkflow} from '../tools/workflow-inventory.mjs';

const ALLOWLIST_PATH = 'ops/lock-environment-allowlist.json';
// The 2026-10-18 seed. Lower it when W6 removes entries; raising it is an explicit, reviewed test edit.
const ALLOWLIST_MAX = 68;
const allowlist = JSON.parse(readFileSync(new URL(`../${ALLOWLIST_PATH}`, import.meta.url), 'utf8'));
const directory = new URL('../.github/workflows/', import.meta.url);
const sources = () => Object.fromEntries(readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).sort()
  .map(name => [name, readFileSync(new URL(name, directory), 'utf8')]));

const environmentName = value => typeof value === 'string' ? value : value && typeof value === 'object' ? String(value.name ?? '') : '';
const lockGroup = value => typeof value === 'string' ? value : value && typeof value === 'object' ? String(value.group ?? '') : '';

// Every job that holds a concurrency group while naming an environment that is not known to have
// required reviewers. An environment named by an expression cannot be proven reviewed, so it counts.
// A caller job (`uses: ./.github/workflows/x.yml`) holding a group counts for each environment its
// callee's jobs name, because the caller keeps the group while the callee waits at the gate.
function lockedEnvironmentJobs(workflows, reviewed) {
  const parsed = Object.fromEntries(Object.entries(workflows).map(([name, source]) => [name, parseWorkflow(source, name).data]));
  const rows = [];
  for (const [workflow, data] of Object.entries(parsed)) for (const [job, spec] of Object.entries(data.jobs)) {
    const scope = spec.concurrency !== undefined ? 'job' : data.concurrency !== undefined ? 'workflow' : null;
    if (!scope) continue;
    const lock = lockGroup(spec.concurrency ?? data.concurrency);
    const callee = /^\.\/\.github\/workflows\/([^/@]+\.ya?ml)$/.exec(spec.uses ?? '')?.[1];
    const environments = spec.environment !== undefined ? [environmentName(spec.environment)]
      : callee ? Object.values(parsed[callee]?.jobs ?? {}).filter(row => row.environment !== undefined).map(row => environmentName(row.environment)) : [];
    for (const environment of new Set(environments)) if (!reviewed.includes(environment)) rows.push({workflow, job, environment, scope, lock});
  }
  return rows.sort((a, b) => `${a.workflow}#${a.job}#${a.environment}`.localeCompare(`${b.workflow}#${b.job}#${b.environment}`));
}
const key = row => `${row.workflow}#${row.job} (environment ${row.environment}, ${row.scope} lock ${row.lock})`;

test('every job that holds a lock while naming a reviewer-free environment is an explicit, shrinking allowlist entry', () => {
  assert.ok(Array.isArray(allowlist.offenders) && Array.isArray(allowlist.environmentsWithRequiredReviewers?.names));
  const found = lockedEnvironmentJobs(sources(), allowlist.environmentsWithRequiredReviewers.names).map(key);
  const listed = allowlist.offenders.map(key);
  const added = found.filter(row => !listed.includes(row));
  const fixed = listed.filter(row => !found.includes(row));
  assert.deepEqual(added, [], `new job(s) hold a concurrency group while naming an environment without required reviewers; move the environment off the lock-holding job (or the lock off the gated job) instead of adding to ${ALLOWLIST_PATH}`);
  assert.deepEqual(fixed, [], `these ${ALLOWLIST_PATH} entries no longer match a workflow; remove them (the list only shrinks)`);
  assert.equal(new Set(listed).size, listed.length, 'no duplicate entries');
  assert.ok(listed.length <= ALLOWLIST_MAX, `${ALLOWLIST_PATH} has ${listed.length} entries, more than the pinned ${ALLOWLIST_MAX}; the list only shrinks`);
});

test('the invariant flags a new offender, including a lock held by a reusable-workflow caller and an expression environment', () => {
  const workflows = {
    'new-writer.yml': 'name: New\non: workflow_dispatch\njobs:\n  write:\n    runs-on: ubuntu-latest\n    environment: production\n    concurrency: {group: new-lock, cancel-in-progress: false}\n    steps: [{run: echo}]\n',
    'caller.yml': 'name: Caller\non: workflow_dispatch\nconcurrency: caller-lock\njobs:\n  call:\n    uses: ./.github/workflows/callee.yml\n',
    'callee.yml': 'name: Callee\non: workflow_call\njobs:\n  gated:\n    runs-on: ubuntu-latest\n    environment: {name: production}\n    steps: [{run: echo}]\n',
    'expression.yml': "name: Expr\non: workflow_dispatch\nconcurrency: {group: x}\njobs:\n  go:\n    runs-on: ubuntu-latest\n    environment: ${{ inputs.target }}\n    steps: [{run: echo}]\n",
    'reviewed.yml': 'name: Reviewed\non: workflow_dispatch\nconcurrency: {group: r}\njobs:\n  go:\n    runs-on: ubuntu-latest\n    environment: {name: ui-production}\n    steps: [{run: echo}]\n',
    'free.yml': 'name: Free\non: workflow_dispatch\njobs:\n  plan:\n    runs-on: ubuntu-latest\n    concurrency: plan\n    steps: [{run: echo}]\n  gated:\n    needs: plan\n    runs-on: ubuntu-latest\n    environment: production\n    steps: [{run: echo}]\n',
  };
  assert.deepEqual(lockedEnvironmentJobs(workflows, ['ui-production']).map(key), [
    'caller.yml#call (environment production, workflow lock caller-lock)',
    'expression.yml#go (environment ${{ inputs.target }}, workflow lock x)',
    'new-writer.yml#write (environment production, job lock new-lock)',
  ]);
});

test('the allowlist names the two incident jobs, records where the reviewer list came from, and says W6 shrinks it to zero', () => {
  const listed = allowlist.offenders.map(row => `${row.workflow}#${row.job}`);
  for (const job of ['catalog-bake.yml#model', 'observation-refresh.yml#refresh', 'five-feed-recovery.yml#recover', 'publish-current-model-production.yml#publisher'])
    assert.ok(listed.includes(job), job);
  assert.match(allowlist.note, /W6/);assert.match(allowlist.note, /zero/);
  assert.match(allowlist.environmentsWithRequiredReviewers.source, /GET \/repos\/Andrewegao\/v3t7kq-cycle\/environments/);
});
