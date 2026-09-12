import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkInventory, generateInventory, OUTPUT, parseWorkflow, ROOT, validateRegistry } from '../tools/workflow-inventory.mjs';
import { deployPlan, schedulerChanged } from '../tools/scheduler-deploy-plan.mjs';

const path = '.github/workflows/example.yml';
const row = { id: 'example', path, family: 'models', purpose: 'Example navigation.',
  subsystem: 'Models', lifecycle: 'recurring', runbook: 'docs/guide.md' };
const registry = () => ({ schemaVersion: 1, workflows: [{ ...row }] });
const source = `name: Example
on:
  workflow_dispatch:
    inputs:
      model: {type: string}
  schedule:
    - cron: '7 * * * *'
permissions: {contents: read}
concurrency: {group: shared, cancel-in-progress: false}
jobs:
  collect:
    if: \${{ vars.ENABLED == 'true' }}
    runs-on: ubuntu-latest
    environment: production
    timeout-minutes: 7
    strategy: {matrix: {model: [ecmwf, gfs]}, max-parallel: 2, fail-fast: false}
    steps:
      - uses: actions/checkout@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
        with: {repository: example/source, ref: \"\${{ inputs.source }}\"}
      - run: echo must-not-execute > forbidden.txt
  publish:
    needs: collect
    uses: ./.github/workflows/other.yml
    if: \${{ vars['PUBLISH_ENABLED'] == 'true' }}
`;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'weatherx-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['ops', '.github/workflows', 'docs']) await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, 'ops/workflows.json'), JSON.stringify(registry()));
  await writeFile(join(root, path), source);
  await writeFile(join(root, 'docs/guide.md'), '# Fixture runbook\n');
  return root;
}

test('metadata has complete coverage, unique identities and no executable-policy fields', () => {
  assert.equal(validateRegistry(registry(), [path]).length, 1);
  for (const mutate of [
    value => value.workflows.push({ ...row }),
    value => value.workflows.push({ ...row, id: 'other' }),
    value => value.workflows.push({ ...row, path: '.github/workflows/other.yml' }),
    value => value.workflows[0].approved_sha = 'a'.repeat(40),
    value => value.workflows[0].family = 'unknown',
    value => value.workflows[0].lifecycle = 'enabled',
    value => value.workflows[0].purpose = '',
    value => value.workflows[0].purpose = 'line\nbreak',
    value => value.workflows[0].runbook = 'https://external.invalid/guide.md',
    value => value.schemaVersion = 2,
    value => value.extra = true,
  ]) {
    const value = registry(); mutate(value);
    assert.throws(() => validateRegistry(value, [path]));
  }
  assert.throws(() => validateRegistry(registry(), []), /coverage drift/);
  assert.throws(() => validateRegistry(registry(), [path, '.github/workflows/new.yml']), /coverage drift/);
});

test('YAML parser preserves on, expressions, strategy and source locations without evaluation', () => {
  const value = parseWorkflow(source, path);
  assert.equal(value.data.on.schedule[0].cron, '7 * * * *');
  assert.equal(value.data.jobs.collect.strategy['max-parallel'], 2);
  assert.equal(value.data.jobs.publish.needs, 'collect');
  assert.equal(value.line(['jobs', 'collect']), source.split('\n').findIndex(line => line.includes('if:')) + 1);
  assert.deepEqual(value.variables.map(([name]) => name), ['ENABLED', 'PUBLISH_ENABLED']);
  assert.equal(value.data.jobs.collect.steps[0].with.ref, '${{ inputs.source }}');
});

test('invalid YAML and duplicate mapping keys fail instead of hiding executable declarations', () => {
  assert.throws(() => parseWorkflow('jobs: [', path), /invalid workflow YAML/);
  assert.throws(() => parseWorkflow(source.replace('environment: production', 'environment: production\n    environment: staging'), path), /invalid workflow YAML/);
  assert.throws(() => parseWorkflow('on: push\njobs: null', path), /jobs must be a mapping/);
});

test('generation is deterministic, derives declared facts, and never executes workflow scripts', async t => {
  const root = await fixture(t);
  const first = await generateInventory(root);
  assert.equal(first, await generateInventory(root));
  assert.match(first, /activation.*unknown/i);
  assert.match(first, /caller|Repository/);
  assert.match(first, /inputs.source/);
  assert.match(first, /max-parallel/);
  assert.match(first, /publish.*←.*collect/);
  assert.match(first, /PUBLISH_ENABLED/);
  assert.match(first, /production/);
  assert.ok(!(await readdir(root)).includes('forbidden.txt'));
  assert.equal(await readFile(join(root, path), 'utf8'), source);
});

test('check detects workflow, metadata and generated-document drift without writing', async t => {
  const root = await fixture(t);
  const original = await generateInventory(root);
  await writeFile(join(root, OUTPUT), original);
  await checkInventory(root);
  await writeFile(join(root, path), source.replace('max-parallel: 2', 'max-parallel: 3'));
  await assert.rejects(checkInventory(root), /inventory is stale/);
  assert.equal(await readFile(join(root, OUTPUT), 'utf8'), original);
  await writeFile(join(root, path), source);
  const modified = registry(); modified.workflows[0].purpose = 'Revised purpose.';
  await writeFile(join(root, 'ops/workflows.json'), JSON.stringify(modified));
  await assert.rejects(checkInventory(root), /inventory is stale/);
  await writeFile(join(root, OUTPUT), await generateInventory(root));
  await checkInventory(root);
  await writeFile(join(root, OUTPUT), 'manually edited');
  await assert.rejects(checkInventory(root), /inventory is stale/);
});

test('missing, escaping or symlinked runbooks are refused', async t => {
  const root = await fixture(t);
  await rm(join(root, 'docs/guide.md'));
  await assert.rejects(generateInventory(root), /ENOENT/);
  await symlink(join(root, path), join(root, 'docs/guide.md'));
  await assert.rejects(generateInventory(root), /symlink/);
  const modified = registry(); modified.workflows[0].runbook = 'docs/../../outside.md';
  await writeFile(join(root, 'ops/workflows.json'), JSON.stringify(modified));
  await assert.rejects(generateInventory(root), /unsafe repository path/);
});

test('checkout defaults remain explicitly unresolved; values are Markdown escaped', async t => {
  const root = await fixture(t);
  await writeFile(join(root, path), source.replace('        with: {repository: example/source, ref: "${{ inputs.source }}"}\n', '')
    .replace('environment: production', 'environment: "<not-html>|value"'));
  const output = await generateInventory(root);
  assert.match(output, /implicit event\/default ref; no explicit pin here/);
  assert.match(output, /&lt;not-html&gt;&#124;value/);
});

test('repository inventory covers every workflow and keeps legacy recovery visibly unqualified', async () => {
  const value = JSON.parse(await readFile(join(ROOT, 'ops/workflows.json'), 'utf8'));
  const paths = (await readdir(join(ROOT, '.github/workflows'))).filter(name => /\.ya?ml$/.test(name)).map(name => `.github/workflows/${name}`);
  assert.equal(validateRegistry(value, paths).length, paths.length);
  assert.equal(value.workflows.find(row => row.id === 'catalog-promote-existing').lifecycle, 'legacy-needs-review');
  const before = await Promise.all(paths.map(path => readFile(join(ROOT, path), 'utf8')));
  const output = await generateInventory();
  assert.match(output, /weatherx-data-maintenance/);
  assert.match(output, /weatherx-component-production-/);
  assert.match(output, /core-ecmwf.*no needs/);
  assert.match(output, /publish-ecmwf.*←.*core-ecmwf/);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(join(ROOT, path), 'utf8'))), before);
});

test('scheduler CI runs inventory checks and selects all workflow changes and metadata', async () => {
  const source = await readFile(join(ROOT, '.github/workflows/scheduler-ci.yml'), 'utf8');
  const { data } = parseWorkflow(source, 'scheduler-ci.yml');
  for (const path of ['.github/workflows/**', 'ops/workflows.json', 'docs/WORKFLOWS.md']) assert.ok(data.on.push.paths.includes(path));
  const index = data.jobs.scheduler.steps.findIndex(step => step.name === 'Declared workflow inventory and metadata contracts');
  assert.ok(index > data.jobs.scheduler.steps.findIndex(step => step.run === 'npm ci --prefix scheduler'));
  assert.ok(index > data.jobs.scheduler.steps.findIndex(step => step.run === 'npm ci --ignore-scripts --prefix tools/inventory'));
  assert.equal(data.jobs.scheduler.steps[index].run.trim(), 'node --test tests/workflow-inventory.mjs tests/workflow-timing.mjs\nnode tools/workflow-inventory.mjs --check');
  assert.equal(data.jobs.scheduler.steps.find(step => step.run === 'npm run check --prefix scheduler').run, 'npm run check --prefix scheduler');
});

test('actual inventory paths and its isolated dependency package leave the scheduler deployment classifier false', async t => {
  const root = await mkdtemp(join(tmpdir(), 'weatherx-inventory-deploy-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = () => { git('add', '-A'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); };
  const copy = async path => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), await readFile(join(ROOT, path)));
  };
  git('init', '-q');
  for (const path of ['scheduler/package.json', 'scheduler/package-lock.json', 'scheduler/src/index.ts', 'scheduler/wrangler.jsonc']) await copy(path);
  const before = commit();
  const metadataPaths = ['ops/workflows.json', 'tools/workflow-inventory.mjs', 'tools/workflow-timing.mjs',
    'tools/inventory/package.json', 'tools/inventory/package-lock.json', 'tools/inventory/.gitignore',
    'tests/workflow-inventory.mjs', 'tests/workflow-timing.mjs',
    'docs/WORKFLOWS.md', 'docs/WORKFLOW_OPERATIONS.md', 'README.md', '.github/workflows/scheduler-ci.yml'];
  for (const path of metadataPaths) await copy(path);
  const after = commit();
  assert.equal(schedulerChanged(before, after, root), false);
  assert.equal(deployPlan('push', { ref: 'refs/heads/main', before, after }, after,
    (a, b) => schedulerChanged(a, b, root)).deploy, false);
  const tooling = JSON.parse(await readFile(join(ROOT, 'tools/inventory/package.json'), 'utf8'));
  const scheduler = JSON.parse(await readFile(join(ROOT, 'scheduler/package.json'), 'utf8'));
  assert.equal(tooling.devDependencies.yaml, '2.9.1');
  assert.equal(scheduler.devDependencies.yaml, undefined, 'inventory parser must not change the deployed scheduler dependency tree');
  const deploy = parseWorkflow(await readFile(join(ROOT, '.github/workflows/scheduler-deploy.yml'), 'utf8'), 'scheduler-deploy.yml').data;
  assert.deepEqual(deploy.on.push.paths, ['.github/workflows/catalog-bake.yml', '.github/workflows/scheduler-deploy.yml', 'scheduler/**']);
  // Recreate the reviewed regression: the same parser dependency placed in the
  // scheduler package must still trigger the unchanged deployment classifier.
  scheduler.devDependencies.yaml = tooling.devDependencies.yaml;
  await writeFile(join(root, 'scheduler/package.json'), JSON.stringify(scheduler));
  const unsafe = commit();
  assert.equal(schedulerChanged(after, unsafe, root), true);
});
