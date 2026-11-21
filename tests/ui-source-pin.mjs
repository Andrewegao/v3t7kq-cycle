import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {basename, dirname, join, relative} from 'node:path';
import {ROOT, TEXT_SITES, DECLARATION, FIXTURE, DOC, RELEASE_GUARD, WRITTEN_FILES, checkSites, closurePaths, compareDigests} from '../tools/ui-source-pin.mjs';
import {PUBLIC_COMBINED_ACCOUNT_SOURCES, PUBLIC_COMBINED_ONBOARDING_SOURCES, PUBLIC_COMBINED_INTRO_SOURCE_SHA256} from '../tools/ui-public-combined.mjs';

const SITE_FILES = [...new Set([...TEXT_SITES.map(site => site.path), DECLARATION, FIXTURE])].sort();
const HAS_INVENTORY = existsSync(join(ROOT, 'tools/inventory/node_modules/yaml'));
// The other profiles' controller pins share the same ref expressions and must never move.
const OTHER_PINS = ['b9db38dd22eed1da56c6c4dd4140480da7e89153', '6fcec22638f6696be71daa2f2e974ebc4b24318e', '25c402db5149daa018e349a34a4beeba1f2dca45'];

test('every combined UI pin site agrees on main', () => {
  const {pin, sites, problems} = checkSites();
  assert.deepEqual(problems, []);
  assert.match(pin, /^[a-f0-9]{40}$/);
  assert.equal(sites.length, 18);
  assert.equal(SITE_FILES.length, 11, 'the eleven files every re-pin since #466 touched');
  assert.deepEqual(WRITTEN_FILES, SITE_FILES);
  const cli = spawnSync(process.execPath, [join(ROOT, 'tools/ui-source-pin.mjs'), '--check'], {encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`agree at 18 sites: ${pin}`));
});

const ENV = {...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_COMMITTER_DATE: '2026-11-21T02:52:09Z', GIT_AUTHOR_DATE: '2026-11-21T02:52:09Z'};
const git = (cwd, ...args) => {
  const run = spawnSync('git', args, {cwd, encoding: 'utf8', env: ENV});
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};
const commitAll = (root, message) => { git(root, 'add', '-A'); git(root, 'commit', '-q', '--allow-empty', '-m', message); };
// A clean Git copy of this repository (only the inventory's own node_modules, kept untracked).
function copyRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ui-source-pin-')));
  cpSync(ROOT, root, {recursive: true, filter: source => {
    const path = relative(ROOT, source);
    return path !== '.git' && (basename(source) !== 'node_modules' || path === 'tools/inventory/node_modules');
  }});
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.git/info/exclude'), 'node_modules/\n');
  commitAll(root, 'copy');
  return root;
}
const put = (root, path, text) => { mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), text); };
const entries = map => Object.entries(map).map(([name, digest]) => `  '${name}': '${digest}',`);
// Shaped like Atmos app/src/build/publicReleaseGuard.ts: intro constant, then the two frozen maps with comments.
function guardSource({intro = PUBLIC_COMBINED_INTRO_SOURCE_SHA256, onboarding = PUBLIC_COMBINED_ONBOARDING_SOURCES,
  account = PUBLIC_COMBINED_ACCOUNT_SOURCES, before = [], inAccount = []} = {}) {
  return [...before, `export const PRODUCTION_INTRO_SOURCE_SHA256 = '${intro}';`,
    'export const PRODUCTION_ONBOARDING_SOURCE_SHA256: Readonly<Record<string, string>> = Object.freeze({',
    '  // Reviewed mobile follow-up.', ...entries(onboarding), '});',
    'export const STAGING_ACCOUNT_SOURCE_SHA256: Readonly<Record<string, string>> = Object.freeze({',
    '  // Re-pinned 2026-09-25: UI only.', ...entries(account), ...inAccount, '});', ''].join('\n');
}
const without = (map, key) => Object.fromEntries(Object.entries(map).filter(([name]) => name !== key));
const ICON = 'onboarding/Icon.tsx';

// Synthetic Atmos: A (current pin) -> B (closure identical) -> C (an inventory file changed). Off B, never
// on master unless a test points origin/master there: guard variants. E: off A, never merged.
function syntheticAtmos() {
  const atmos = realpathSync(mkdtempSync(join(tmpdir(), 'ui-source-pin-atmos-')));
  git(atmos, 'init', '-q', '-b', 'master');
  const {inventory, sparse} = closurePaths(ROOT, checkSites().pin);
  for (const path of new Set([...inventory, ...sparse])) put(atmos, path, `// ${path}\n`);
  put(atmos, RELEASE_GUARD, guardSource());
  commitAll(atmos, 'Merge pull request #1 from weatherx-hq/a');
  const commit = (message, edit) => { edit(); commitAll(atmos, message); return git(atmos, 'rev-parse', 'HEAD'); };
  const A = git(atmos, 'rev-parse', 'HEAD');
  const B = commit('Merge pull request #2 from weatherx-hq/b', () => { put(atmos, 'docs/notes.md', 'outside\n'); put(atmos, 'app/src/map.ts', 'inside\n'); });
  const C = commit('Merge pull request #3 from weatherx-hq/c', () => put(atmos, inventory[0], '// reviewed bytes changed\n'));
  const off = (branch, base, guard) => { git(atmos, 'checkout', '-q', '-b', branch, base); return commit(branch, () => put(atmos, RELEASE_GUARD, guard)); };
  const guards = {
    // Icon.tsx leaves the onboarding map but survives in a comment and in the account map.
    moved: off('moved', B, guardSource({onboarding: without(PUBLIC_COMBINED_ONBOARDING_SOURCES, ICON),
      before: [`// '${ICON}': '${PUBLIC_COMBINED_ONBOARDING_SOURCES[ICON]}',`], inAccount: [`  '${ICON}': '${PUBLIC_COMBINED_ONBOARDING_SOURCES[ICON]}',`]})),
    extra: off('extra', B, guardSource({onboarding: {...PUBLIC_COMBINED_ONBOARDING_SOURCES, 'onboarding/New.ts': 'e'.repeat(64)}})),
    // Only the intro moves; the onboarding map still carries ProductionAccountIntro.tsx at the old digest.
    intro: off('intro', B, guardSource({intro: 'd'.repeat(64)})),
  };
  git(atmos, 'checkout', '-q', '-b', 'e', A);
  const E = commit('Unmerged branch', () => put(atmos, 'app/src/side.ts', 'side\n'));
  // A local branch spelled origin/master must not stand in for the remote-tracking ref.
  git(atmos, 'branch', 'origin/master', E);
  return {atmos, A, B, C, E, guards, inventory, master: ref => git(atmos, 'update-ref', 'refs/remotes/origin/master', ref)};
}
// Point the copy's pin at synthetic commit A, the way the real pin points at a real Atmos commit.
function pinCopyTo(root, sha) {
  const {pin} = checkSites();
  for (const path of SITE_FILES) writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replaceAll(pin, sha));
  assert.deepEqual(checkSites(root).problems, []);
  assert.equal(checkSites(root).pin, sha);
  commitAll(root, 'pin to synthetic A');
}
const snapshot = root => Object.fromEntries(SITE_FILES.map(path => [path, readFileSync(join(root, path), 'utf8')]));
const setPin = (root, atmos, sha, extra = [], env = process.env) => spawnSync(process.execPath,
  [join(root, 'tools/ui-source-pin.mjs'), '--set', sha, '--atmos', atmos, ...(extra.includes('--npm-ci') ? [] : ['--no-npm-ci']),
    ...extra.filter(arg => arg !== '--npm-ci')], {cwd: root, encoding: 'utf8', env});

const repo = syntheticAtmos();
const pinnedCopy = () => { const root = copyRepo(); pinCopyTo(root, repo.A); return root; };
const changedLines = (a, b) => { const x = a.split('\n'), y = b.split('\n'); assert.equal(x.length, y.length); return x.flatMap((line, i) => line === y[i] ? [] : [i]); };

test('a hand edit of one pin site is reported by --check', () => {
  const root = copyRepo(), {pin} = checkSites();
  const file = join(root, 'tests/ui-workflow.mjs');
  writeFileSync(file, readFileSync(file, 'utf8').replace(pin, 'a'.repeat(40)));
  assert.match(checkSites(root).problems.join('\n'), /tests\/ui-workflow\.mjs \(COMBINED_ATMOS_SHA\): a{40} disagrees/);
});

test('--set rewrites only the pin swap at every site, records the old pin, and regenerates the inventory',
  {skip: !HAS_INVENTORY && 'needs npm ci --ignore-scripts --prefix tools/inventory'}, () => {
    const root = pinnedCopy();repo.master(repo.C);
    const before = snapshot(root), swapped = path => before[path].replaceAll(repo.A, repo.B);
    const run = setPin(root, repo.atmos, repo.B, ['--note', 'Atmos #2 adds a map module.', '--history', 'qualified in run 1']);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(checkSites(root).problems, []);
    assert.equal(checkSites(root).pin, repo.B);
    const after = snapshot(root);
    assert.deepEqual(SITE_FILES.filter(path => after[path] !== before[path]), SITE_FILES);
    // Pure swaps: workflows, UI tests and the declaration change by the SHA alone.
    for (const path of ['.github/workflows/ui-release.yml', '.github/workflows/ui-staging.yml', 'tests/ui-controller-checkout.mjs',
      'tests/ui-public-combined.mjs', 'tests/ui-workflow.mjs', DECLARATION]) assert.equal(after[path], swapped(path), path);
    for (const path of ['.github/workflows/ui-release.yml', '.github/workflows/ui-staging.yml', 'tests/ui-controller-checkout.mjs', 'docs/WORKFLOWS.md'])
      for (const other of OTHER_PINS) {
        const count = text => text.split(other).length - 1;
        assert.ok(count(before[path]) > 0 && count(after[path]) === count(before[path]), `${path}: ${other} untouched`);
      }
    // The two constants also get their one comment line; WORKFLOWS.md also gets its source digest line.
    for (const [path, line] of [['tools/ui-combined-source-guard.mjs', /^\/\/ Reviewed merged source: Merge pull request #2 from weatherx-hq\/b; fresh staging/],
      ['tools/ui-public-combined.mjs', /^\/\/ Reviewed merged source: Merge pull request #2 from weatherx-hq\/b; new-source staging/],
      ['docs/WORKFLOWS.md', /^Source digest \(registry and workflow bytes\): `[a-f0-9]{64}`\.$/]]) {
      const lines = changedLines(swapped(path), after[path]);
      assert.equal(lines.length, 1, path);
      assert.match(after[path].split('\n')[lines[0]], line, path);
    }
    const tree = git(repo.atmos, 'rev-parse', `${repo.B}^{tree}`), master = git(repo.atmos, 'rev-parse', 'refs/remotes/origin/master');
    const fixture = JSON.parse(after[FIXTURE]), provenance = fixture.stagingBuild.provenance;
    assert.ok(provenance.startsWith(`Merged Atmos source ${repo.B}, tree ${tree}, committed 2026-11-21T02:52:09Z; Merge pull request #2 from weatherx-hq/b. Supersedes ${repo.A}. Between pins, 1 commits and 2 files changed, 1 of them inside the UI closure. Atmos #2 adds a map module. It is an ancestor of Atmos refs/remotes/origin/master (${master});`), provenance);
    const expectedFixture = JSON.parse(swapped(FIXTURE));expectedFixture.stagingBuild.provenance = provenance;
    assert.deepEqual(fixture, expectedFixture);
    const expectedDoc = before[DOC].replace(`reviewed merged \`${repo.A}\``, `reviewed merged \`${repo.B}\``)
      .replace(/^Pin \([^)\n]*\): (Merged Atmos source [^\n]*)$/m, (_, old) => `Pin (fresh staging qualification pending): ${provenance}\n\nHistorical pin (qualified in run 1): ${old}`);
    assert.equal(after[DOC], expectedDoc, 'the old Pin line moves verbatim below the new one');
    assert.match(run.stdout, /^Pin the combined UI source to reviewed Atmos /);
    assert.match(run.stdout, new RegExp(`ancestor of Atmos refs/remotes/origin/master \\(${master}\\)`));
    const inventory = spawnSync(process.execPath, ['tools/workflow-inventory.mjs', '--check'], {cwd: root, encoding: 'utf8'});
    assert.equal(inventory.status, 0, inventory.stderr);
  });

for (const [name, target, master, message] of [
  ['a changed controller closure', () => repo.C, () => repo.C, /controller closure changed[\s\S]*a human must review/],
  ['a reviewed digest missing from its map (present only in a comment and the wrong map)', () => repo.guards.moved, () => repo.guards.moved,
    [/PRODUCTION_ONBOARDING_SOURCE_SHA256: onboarding\/Icon\.tsx 5eeaba1d\w+ missing in Atmos/, /STAGING_ACCOUNT_SOURCE_SHA256: onboarding\/Icon\.tsx \w+ declared in Atmos but not/]],
  ['an extra digest in an Atmos map', () => repo.guards.extra, () => repo.guards.extra, /PRODUCTION_ONBOARDING_SOURCE_SHA256: onboarding\/New\.ts e{64} declared in Atmos but not/],
  ['intro-only drift', () => repo.guards.intro, () => repo.guards.intro, /PRODUCTION_INTRO_SOURCE_SHA256 is d{64} in Atmos, 8f9d8a33\w+ in tools/],
  ['a commit that is not an ancestor of origin/master', () => repo.E, () => repo.C, /is not an ancestor of refs\/remotes\/origin\/master/],
]) test(`--set refuses ${name} and changes nothing`, () => {
  const root = pinnedCopy();repo.master(master());
  const before = snapshot(root);
  const run = setPin(root, repo.atmos, target());
  assert.notEqual(run.status, 0);
  for (const each of [message].flat()) assert.match(run.stderr, each);
  if (target() === repo.C) assert.match(run.stderr, new RegExp(repo.inventory[0].replaceAll('.', '\\.')));
  assert.deepEqual(snapshot(root), before);
});

test('the intro check reads the PRODUCTION_INTRO_SOURCE_SHA256 declaration, not any occurrence of the digest', () => {
  assert.deepEqual(compareDigests(guardSource()), []);
  // ProductionAccountIntro.tsx in the onboarding map carries the same digest; that alone must not satisfy the intro.
  assert.equal(PUBLIC_COMBINED_ONBOARDING_SOURCES['onboarding/ProductionAccountIntro.tsx'], PUBLIC_COMBINED_INTRO_SOURCE_SHA256);
  assert.match(compareDigests(guardSource().replace(/^export const PRODUCTION_INTRO_SOURCE_SHA256 = .*\n/m, '')).join('\n'), /exactly once, found 0/);
  assert.match(compareDigests(guardSource({inAccount: ["  'client.ts' + 'x': 'y',"]})).join('\n'), /unrecognised line/);
});

test('--master-ref is gone: master is always refs/remotes/origin/master, even with a local branch named origin/master', () => {
  const root = pinnedCopy();repo.master(repo.C);
  assert.equal(git(repo.atmos, 'rev-parse', 'refs/heads/origin/master'), repo.E);
  assert.match(setPin(root, repo.atmos, repo.E, ['--master-ref', repo.E]).stderr, /unknown or incomplete argument: --master-ref/);
  assert.match(setPin(root, repo.atmos, repo.E).stderr, new RegExp(`not an ancestor of refs/remotes/origin/master \\(${repo.C}\\)`));
});

test('--set refuses an empty controller inventory or sparse path list', () => {
  for (const edit of [fixture => { fixture.controllers.find(row => row.pin === repo.A).files = []; },
    fixture => { fixture.stagingBuild.paths = []; }]) {
    const root = pinnedCopy();repo.master(repo.C);
    const fixture = JSON.parse(readFileSync(join(root, FIXTURE), 'utf8'));edit(fixture);
    writeFileSync(join(root, FIXTURE), `${JSON.stringify(fixture, null, 2)}\n`);commitAll(root, 'empty');
    const before = snapshot(root), run = setPin(root, repo.atmos, repo.B);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /must both be non-empty/);
    assert.deepEqual(snapshot(root), before);
  }
});

test('--summary, --note and --history must be one line without control characters', () => {
  const root = pinnedCopy();repo.master(repo.C);
  const before = snapshot(root);
  for (const [flag, value] of [['--summary', 'ok\nexport const UI_SOURCE = 1;'], ['--note', 'tab\there'], ['--history', 'x\r']]) {
    const run = setPin(root, repo.atmos, repo.B, [flag, value]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, new RegExp(`${flag} must be one line`));
  }
  assert.deepEqual(snapshot(root), before);
});

test('--set refuses a dirty working tree, and fails before writing when npm ci fails', () => {
  const root = pinnedCopy();repo.master(repo.C);
  writeFileSync(join(root, 'README.md'), 'local edit\n');
  assert.match(setPin(root, repo.atmos, repo.B).stderr, /uncommitted changes:\n {2}README\.md/);
  git(root, 'checkout', '--', 'README.md');
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'ui-source-pin-bin-')));
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "npm unavailable" >&2\nexit 1\n');chmodSync(join(bin, 'npm'), 0o755);
  const before = snapshot(root);
  const run = setPin(root, repo.atmos, repo.B, ['--npm-ci'], {...process.env, PATH: `${bin}:${process.env.PATH}`});
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /npm ci --ignore-scripts --prefix tools\/inventory failed[\s\S]*npm unavailable/);
  assert.deepEqual(snapshot(root), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('a failure after the first write restores every pin file', () => {
  const root = pinnedCopy();repo.master(repo.C);
  writeFileSync(join(root, 'ops/workflows.json'), '{ not json');commitAll(root, 'break the inventory');
  const before = snapshot(root), run = setPin(root, repo.atmos, repo.B);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /workflow-inventory\.mjs --write failed[\s\S]*every pin file was restored/);
  assert.deepEqual(snapshot(root), before);
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('--set refuses malformed input before reading Atmos', () => {
  const root = pinnedCopy();
  assert.match(setPin(root, repo.atmos, 'not-a-sha').stderr, /full lowercase 40-character/);
  assert.match(setPin(root, repo.atmos, repo.A).stderr, /already pinned/);
  assert.match(setPin(root, join(repo.atmos, 'missing'), repo.B).stderr, /--atmos needs/);
});
