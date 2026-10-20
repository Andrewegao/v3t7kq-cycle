// Every Wind100 CLI entry and module loads in a fresh process and exits. #439: a top-level await
// in a CLI entry plus an import cycle deadlocked `production-wind100.mjs reclaim` (exit 13 after
// ~50 ms with no IO). In-process tests import modules as dependencies and cannot see that, so this
// runs each one as a real entry point and in every import order, and checks the import graph.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const MODULES = ['production-wind100.mjs', 'production-wind100-retention.mjs', 'staging-wind100.mjs',
  'staging-wind100-retention.mjs', 'wind100-retention.mjs', 'wind100-bounded-step.mjs'];
const path = name => fileURLToPath(new URL(`../tools/${name}`, import.meta.url));
// A fresh process with no inherited credentials or workflow context.
const node = args => spawnSync(process.execPath, args, { env: { PATH: process.env.PATH }, encoding: 'utf8',
  timeout: 60_000 });

function settled(run, label) {
  assert.equal(run.error, undefined, `${label}: ${run.error?.message}`);
  assert.equal(run.signal, null, `${label} was killed (timed out?)`);
  assert.notEqual(run.status, 13, `${label} exited 13 (unsettled top-level await)`);
  assert.doesNotMatch(run.stderr, /unsettled top-level await|ERR_|SyntaxError|ReferenceError/, label);
}

test('every Wind100 CLI entry point loads, runs its command and exits', () => {
  const cases = [
    ['production-wind100.mjs', ['digest'], 0, /^\{"sha256":"[a-f0-9]{64}"\}\n$/, /^$/],
    ['staging-wind100.mjs', ['digest'], 0, /^\{"sha256":"[a-f0-9]{64}"\}\n$/, /^$/],
    // Outside the protected workflow both retention entries refuse before any IO.
    ['production-wind100-retention.mjs', ['dry-run', '/nonexistent'], 1, /^$/, /^Production Wind100 retention refused: /],
    ['staging-wind100-retention.mjs', ['reclaim', '/nonexistent'], 1, /^$/, /^Staging Wind100 refused: /],
    ['production-wind100.mjs', ['reclaim', '/nonexistent'], 1, /^$/, /^Production Wind100 refused: /],
    // Library modules: loading them as an entry point does nothing and exits cleanly.
    ['wind100-retention.mjs', [], 0, /^$/, /^$/],
    ['wind100-bounded-step.mjs', [], 0, /^$/, /^$/],
  ];
  for (const [name, args, status, stdout, stderr] of cases) {
    const label = `node tools/${name} ${args.join(' ')}`;
    const run = node([path(name), ...args]);
    settled(run, label);
    assert.equal(run.status, status, `${label}: ${run.stderr}`);
    assert.match(run.stdout, stdout, label);
    assert.match(run.stderr, stderr, label);
  }
  for (const name of MODULES) assert.ok(cases.some(([entry]) => entry === name), `${name} has no entry-point case`);
});

test('every Wind100 module loads in a fresh process in every import order', () => {
  for (let start = 0; start < MODULES.length; start++) {
    const order = [...MODULES.slice(start), ...MODULES.slice(0, start)];
    const driver = `for (const href of ${JSON.stringify(order.map(name => new URL(`../tools/${name}`, import.meta.url).href))})`
      + ' await import(href); process.stdout.write("loaded");';
    const run = node(['--input-type=module', '-e', driver]);
    settled(run, order.join(' -> '));
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, 'loaded');
  }
});

test('the shared modules add no import cycle: the only one is the pre-existing production pair', () => {
  const edges = new Map(MODULES.map(name => {
    const code = readFileSync(path(name), 'utf8');
    const targets = [...code.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]\.\/([a-z0-9-]+\.mjs)['"]/g)].map(match => match[1]);
    return [name, [...new Set(targets.filter(target => MODULES.includes(target)))]];
  }));
  // The two shared modules are leaves: they import no Wind100 module at all.
  assert.deepEqual(edges.get('wind100-retention.mjs'), []);
  assert.deepEqual(edges.get('wind100-bounded-step.mjs'), []);
  // The staging controller never imports its retention module (that has its own CLI entry).
  assert.ok(!edges.get('staging-wind100.mjs').includes('staging-wind100-retention.mjs'));
  const cycles = new Set();
  const visit = (name, stack) => {
    if (stack.includes(name)) { cycles.add(stack.slice(stack.indexOf(name)).sort().join(' <-> ')); return; }
    for (const next of edges.get(name)) visit(next, [...stack, name]);
  };
  for (const name of MODULES) visit(name, []);
  // production-wind100.mjs dynamically imports its retention module, which statically imports it
  // back (#439); its CLI entry therefore never uses top-level await.
  assert.deepEqual([...cycles], ['production-wind100-retention.mjs <-> production-wind100.mjs']);
  for (const name of ['production-wind100.mjs', 'staging-wind100-retention.mjs']) {
    const code = readFileSync(path(name), 'utf8');
    const entry = code.slice(code.lastIndexOf('if (process.argv[1] && import.meta.url'));
    assert.doesNotMatch(entry, /\bawait\b/, `${name} CLI entry uses top-level await`);
  }
});
