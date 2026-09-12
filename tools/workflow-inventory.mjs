#!/usr/bin/env node
// Read-only configuration inventory. Only --write changes the generated Markdown.
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('./inventory/package.json', import.meta.url));
const { parseDocument, LineCounter } = require('yaml');
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const OUTPUT = 'docs/WORKFLOWS.md';
const FAMILIES = ['models', 'maintenance', 'archives', 'staging', 'releases', 'control-plane'];
const LIFECYCLES = ['recurring', 'manual-supported', 'diagnostic', 'legacy-needs-review'];
const FIELDS = ['id', 'path', 'family', 'purpose', 'subsystem', 'lifecycle', 'runbook'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const cell = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('`', '&#96;').replaceAll('\n', '<br>');
const code = value => `<code>${cell(typeof value === 'string' ? value : JSON.stringify(value))}</code>`;
const format = value => value === undefined ? 'not declared' : code(value);
const link = (path, line = 1, label = path) => `[${cell(label).replaceAll('[', '\\[').replaceAll(']', '\\]')}](../${path}#L${line})`;

async function safeFile(root, path) {
  check(typeof path === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(path)
    && !path.split('/').some(part => part === '.' || part === '..'), `unsafe repository path: ${path}`);
  const base = await realpath(root);
  const actual = await realpath(resolve(base, path));
  check(actual.startsWith(base + sep), `path escapes repository: ${path}`);
  check(actual === resolve(base, path), `symlink is not an inventory source: ${path}`);
  return readFile(actual, 'utf8');
}

export function validateRegistry(registry, paths) {
  check(exactKeys(registry, ['schemaVersion', 'workflows']) && registry.schemaVersion === 1
    && Array.isArray(registry.workflows), 'invalid workflow registry schema');
  const ids = new Set(), entries = new Set();
  for (const row of registry.workflows) {
    check(exactKeys(row, FIELDS), 'registry records contain only metadata fields');
    for (const field of FIELDS) check(typeof row[field] === 'string' && row[field].trim() === row[field]
      && row[field].length > 0 && row[field].length <= 280 && !/[\x00-\x1f]/.test(row[field]), `invalid ${field}`);
    check(/^[a-z][a-z0-9-]*$/.test(row.id) && !ids.has(row.id), `invalid or duplicate id: ${row.id}`);
    check(/^\.github\/workflows\/[a-z0-9-]+\.ya?ml$/.test(row.path)
      && !entries.has(row.path), `invalid or duplicate workflow path: ${row.path}`);
    check(FAMILIES.includes(row.family), `unknown family: ${row.family}`);
    check(LIFECYCLES.includes(row.lifecycle), `unknown lifecycle: ${row.lifecycle}`);
    check(/^(?:docs\/|scheduler\/|README\.md$|CONSUMER_REFRESH\.md$)/.test(row.runbook)
      && row.runbook.endsWith('.md'), `invalid runbook: ${row.runbook}`);
    ids.add(row.id); entries.add(row.path);
  }
  const missing = paths.filter(path => !entries.has(path));
  const stale = [...entries].filter(path => !paths.includes(path));
  check(!missing.length && !stale.length,
    `workflow coverage drift: missing=${missing.join(',') || 'none'} stale=${stale.join(',') || 'none'}`);
  return [...registry.workflows].sort((a, b) => compare(a.path, b.path));
}

export function parseWorkflow(source, path) {
  const counter = new LineCounter();
  const document = parseDocument(source, { lineCounter: counter, uniqueKeys: true, strict: true });
  check(!document.errors.length, `invalid workflow YAML: ${path}: ${document.errors[0]?.message}`);
  const data = document.toJS({ maxAliasCount: 50 });
  check(object(data) && object(data.jobs), `workflow jobs must be a mapping: ${path}`);
  const line = keys => {
    const node = document.getIn(keys, true);
    return node?.range ? counter.linePos(node.range[0]).line : 1;
  };
  // References are labels only. Neither expressions nor scripts are evaluated.
  const variables = new Map();
  for (const match of source.matchAll(/\bvars(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\])/g)) {
    const name = match[1] || match[2];
    if (!variables.has(name)) variables.set(name, counter.linePos(match.index).line);
  }
  return { path, source, data, line, variables: [...variables].sort(([a], [b]) => compare(a, b)) };
}

function triggerRows(workflow) {
  const trigger = workflow.data.on;
  if (typeof trigger === 'string') return [code(trigger)];
  if (Array.isArray(trigger)) return trigger.map(code);
  check(object(trigger), `workflow triggers must be declared: ${workflow.path}`);
  return Object.entries(trigger).map(([event, options]) => {
    let detail = '';
    if (event === 'schedule') detail = ` ${code(options.map(row => row.cron))}`;
    else if (event === 'workflow_dispatch' || event === 'workflow_call') {
      if (options?.inputs) detail = `; input names ${code(Object.keys(options.inputs))}`;
    } else if (options !== null) detail = ` ${code(options)}`;
    return `${link(workflow.path, workflow.line(['on', event]), event)}${detail}`;
  });
}

export function renderInventory(rows, workflows, registrySource) {
  const byPath = new Map(workflows.map(workflow => [workflow.path, workflow]));
  const digest = hash(JSON.stringify([JSON.parse(registrySource), ...workflows.map(({ path, source }) => [path, source])]));
  const out = [
    '# Workflow inventory', '',
    'Generated by `node tools/workflow-inventory.mjs --write`. Do not edit this file by hand.', '',
    'This is a navigation index of **declared configuration**, not a release or recovery menu. Workflow YAML and guarded helpers remain the execution authority. Expressions are shown without evaluation. Observed activation, deployed scheduler state, last execution, and last publication are **unknown** here. A source pin or a recurring label does not prove that a workflow is enabled or deployed.', '',
    'Metadata describes purpose and support intent only. `legacy-needs-review` entries are not recommended recovery paths. Historical runbook narratives do not override the linked executable declarations. See [operation and recovery guidance](WORKFLOW_OPERATIONS.md).', '',
    `Source digest (registry and workflow bytes): \`${digest}\`.`, '',
    `${rows.length} workflows. Ordering and output are deterministic; no API request or clock is used.`, '',
    '| Workflow | Family / subsystem | Lifecycle | Purpose | Runbook |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of rows) out.push(`| [${row.id}](#${row.id}) | ${cell(row.family)} / ${cell(row.subsystem)} | ${row.lifecycle} | ${cell(row.purpose)} | [guide](../${row.runbook}) |`);
  for (const row of rows) {
    const workflow = byPath.get(row.path);
    check(workflow, `missing parsed workflow: ${row.path}`);
    const { data, line } = workflow;
    out.push('', `## ${row.id}`, '', `${link(row.path)} · ${format(data.name)}`, '',
      `Declared triggers: ${triggerRows(workflow).join('; ')}.`, '',
      `Workflow permissions: ${format(data.permissions)}. Workflow concurrency: ${format(data.concurrency)}.`, '',
      '| Job / dependency graph | Runner or reusable workflow | Environment | Timeout (minutes) | Concurrency | Matrix / parallelism | Permissions |',
      '| --- | --- | --- | --- | --- | --- | --- |');
    for (const [id, job] of Object.entries(data.jobs)) {
      check(object(job), `invalid job ${row.path}:${id}`);
      out.push(`| ${link(row.path, line(['jobs', id]), id)} ← ${job.needs === undefined ? 'no needs' : code(job.needs)} | ${format(job.uses ?? job['runs-on'])} | ${format(job.environment)} | ${format(job['timeout-minutes'])} | ${job.concurrency === undefined ? 'no job group; workflow-wide limit still applies if declared' : code(job.concurrency)} | ${format(job.strategy)} | ${job.permissions === undefined ? 'inherits workflow/default policy' : code(job.permissions)} |`);
    }
    const conditions = Object.entries(data.jobs).filter(([, job]) => job.if !== undefined);
    if (conditions.length) {
      out.push('', 'Declared job conditions (additional step/helper checks may apply):', '');
      for (const [id, job] of conditions) out.push(`- ${link(row.path, line(['jobs', id, 'if']), id)}: ${format(job.if)}`);
    }
    out.push('', 'Checkout declarations (not a claim of approval or checkout success):', '',
      '| Job / checkout step | Repository | Ref |', '| --- | --- | --- |');
    let checkouts = 0;
    for (const [id, job] of Object.entries(data.jobs)) for (const [index, step] of (job.steps ?? []).entries()) {
      if (!/^actions\/checkout@/.test(step.uses ?? '')) continue;
      checkouts++;
      out.push(`| ${link(row.path, line(['jobs', id, 'steps', index]), `${id} / ${step.name ?? `step ${index + 1}`}`)} | ${step.with?.repository === undefined ? 'caller repository (implicit)' : code(step.with.repository)} | ${step.with?.ref === undefined ? 'implicit event/default ref; no explicit pin here' : code(step.with.ref)} |`);
    }
    if (!checkouts) out.push('| No direct checkout; inspect linked reusable jobs | — | — |');
    out.push('', 'Variable references (declared names only; values and activation unknown): ' +
      (workflow.variables.length ? workflow.variables.map(([name, position]) => link(row.path, position, name)).join(', ') : 'none detected') + '.', '');
  }
  return out.join('\n');
}

export async function generateInventory(root = ROOT) {
  const entries = await readdir(resolve(root, '.github/workflows'), { withFileTypes: true });
  const paths = entries.filter(entry => /\.ya?ml$/.test(entry.name)).map(entry => `.github/workflows/${entry.name}`).sort(compare);
  const registrySource = await safeFile(root, 'ops/workflows.json');
  const rows = validateRegistry(JSON.parse(registrySource), paths);
  for (const path of new Set(rows.map(row => row.runbook))) await safeFile(root, path);
  const workflows = [];
  for (const path of paths) workflows.push(parseWorkflow(await safeFile(root, path), path));
  return renderInventory(rows, workflows, registrySource);
}

export async function checkInventory(root = ROOT) {
  const expected = await generateInventory(root);
  const actual = await safeFile(root, OUTPUT);
  check(actual === expected, 'generated workflow inventory is stale; run node tools/workflow-inventory.mjs --write');
  return expected;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 3 && ['--check', '--write'].includes(process.argv[2]),
      'usage: node tools/workflow-inventory.mjs --check|--write');
    if (process.argv[2] === '--check') await checkInventory();
    else await writeFile(resolve(ROOT, OUTPUT), await generateInventory(ROOT));
    console.log(`workflow inventory ${process.argv[2] === '--check' ? 'matches declared configuration' : 'written'}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
