import test from 'node:test';
import assert from 'node:assert/strict';
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {basename, dirname, join, relative} from 'node:path';
import {ROOT, TEXT_SITES, DECLARATION, FIXTURE, DOC, RELEASE_GUARD, checkSites, closurePaths} from '../tools/ui-source-pin.mjs';
import {PUBLIC_COMBINED_ACCOUNT_SOURCES, PUBLIC_COMBINED_ONBOARDING_SOURCES, PUBLIC_COMBINED_INTRO_SOURCE_SHA256} from '../tools/ui-public-combined.mjs';

const SITE_FILES = [...new Set([...TEXT_SITES.map(site => site.path), DECLARATION, FIXTURE])].sort();
const HAS_INVENTORY = existsSync(join(ROOT, 'tools/inventory/node_modules/yaml'));

test('every combined UI pin site agrees on main', () => {
  const {pin, sites, problems} = checkSites();
  assert.deepEqual(problems, []);
  assert.match(pin, /^[a-f0-9]{40}$/);
  assert.equal(sites.length, 18);
  assert.equal(SITE_FILES.length, 11, 'the eleven files every re-pin since #466 touched');
  const cli = spawnSync(process.execPath, [join(ROOT, 'tools/ui-source-pin.mjs'), '--check'], {encoding: 'utf8'});
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, new RegExp(`agree at 18 sites: ${pin}`));
});

test('a hand edit of one pin site is reported by --check', () => {
  const root = copyRepo(), {pin} = checkSites();
  const file = join(root, 'tests/ui-workflow.mjs');
  writeFileSync(file, readFileSync(file, 'utf8').replace(pin, 'a'.repeat(40)));
  assert.match(checkSites(root).problems.join('\n'), /tests\/ui-workflow\.mjs \(COMBINED_ATMOS_SHA\): a{40} disagrees/);
});

// A temp copy of this repository (no .git; only the inventory's own node_modules).
function copyRepo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ui-source-pin-')));
  cpSync(ROOT, root, {recursive: true, filter: source => {
    const path = relative(ROOT, source);
    return path !== '.git' && (basename(source) !== 'node_modules' || path === 'tools/inventory/node_modules');
  }});
  return root;
}
const git = (cwd, ...args) => {
  const run = spawnSync('git', args, {cwd, encoding: 'utf8', env: {...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_COMMITTER_DATE: '2026-11-21T02:52:09Z', GIT_AUTHOR_DATE: '2026-11-21T02:52:09Z'}});
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};
const put = (root, path, text) => { mkdirSync(dirname(join(root, path)), {recursive: true}); writeFileSync(join(root, path), text); };
const guardSource = (omit = '') => [`export const PRODUCTION_INTRO_SOURCE_SHA256 = '${PUBLIC_COMBINED_INTRO_SOURCE_SHA256}';`,
  ...Object.entries({...PUBLIC_COMBINED_ACCOUNT_SOURCES, ...PUBLIC_COMBINED_ONBOARDING_SOURCES})
    .filter(([name]) => name !== omit).map(([name, digest]) => `  '${name}': '${digest}',`), ''].join('\n');

// Synthetic Atmos: A (current pin) -> B (closure identical) -> C (an inventory file changed); D (from B, a
// digest dropped from the release guard); E (from A, never merged).
function syntheticAtmos() {
  const atmos = realpathSync(mkdtempSync(join(tmpdir(), 'ui-source-pin-atmos-')));
  git(atmos, 'init', '-q', '-b', 'master');
  const {inventory, sparse} = closurePaths(ROOT, checkSites().pin);
  for (const path of new Set([...inventory, ...sparse])) put(atmos, path, `// ${path}\n`);
  put(atmos, RELEASE_GUARD, guardSource());
  git(atmos, 'add', '-A'); git(atmos, 'commit', '-q', '-m', 'Merge pull request #1 from weatherx-hq/a');
  const commit = (message, edit) => { edit(); git(atmos, 'add', '-A'); git(atmos, 'commit', '-q', '-m', message); return git(atmos, 'rev-parse', 'HEAD'); };
  const A = git(atmos, 'rev-parse', 'HEAD');
  const B = commit('Merge pull request #2 from weatherx-hq/b', () => { put(atmos, 'docs/notes.md', 'outside\n'); put(atmos, 'app/src/map.ts', 'inside\n'); });
  const C = commit('Merge pull request #3 from weatherx-hq/c', () => put(atmos, inventory[0], '// reviewed bytes changed\n'));
  git(atmos, 'checkout', '-q', '-b', 'd', B);
  const D = commit('Merge pull request #4 from weatherx-hq/d', () => put(atmos, RELEASE_GUARD, guardSource('onboarding/Icon.tsx')));
  git(atmos, 'checkout', '-q', '-b', 'e', A);
  const E = commit('Unmerged branch', () => put(atmos, 'app/src/side.ts', 'side\n'));
  return {atmos, A, B, C, D, E, inventory, master: ref => git(atmos, 'update-ref', 'refs/remotes/origin/master', ref)};
}
// Point the copy's pin at synthetic commit A, the way the real pin points at a real Atmos commit.
function pinCopyTo(root, sha) {
  const {pin} = checkSites();
  for (const path of SITE_FILES) writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replaceAll(pin, sha));
  assert.deepEqual(checkSites(root).problems, []);
  assert.equal(checkSites(root).pin, sha);
}
const snapshot = root => Object.fromEntries(SITE_FILES.map(path => [path, readFileSync(join(root, path), 'utf8')]));
const setPin = (root, atmos, sha, ...extra) => spawnSync(process.execPath,
  [join(root, 'tools/ui-source-pin.mjs'), '--set', sha, '--atmos', atmos, '--no-npm-ci', ...extra], {cwd: root, encoding: 'utf8'});

const repo = syntheticAtmos();

test('--set rewrites every site when the closure is identical, records the old pin, and regenerates the inventory',
  {skip: !HAS_INVENTORY && 'needs npm ci --ignore-scripts --prefix tools/inventory'}, () => {
    const root = copyRepo();pinCopyTo(root, repo.A);repo.master(repo.C);
    const before = snapshot(root);
    const run = setPin(root, repo.atmos, repo.B, '--note', 'Atmos #2 adds a map module.', '--history', 'qualified in run 1');
    assert.equal(run.status, 0, run.stderr);
    const {pin, problems} = checkSites(root);
    assert.deepEqual(problems, []);
    assert.equal(pin, repo.B);
    const after = snapshot(root);
    assert.deepEqual(Object.keys(after).filter(path => after[path] !== before[path]).sort(), SITE_FILES);
    const tree = git(repo.atmos, 'rev-parse', `${repo.B}^{tree}`);
    const provenance = JSON.parse(after[FIXTURE]).stagingBuild.provenance;
    assert.ok(provenance.startsWith(`Merged Atmos source ${repo.B}, tree ${tree}, committed 2026-11-21T02:52:09Z; Merge pull request #2 from weatherx-hq/b. Supersedes ${repo.A}. Between pins, 1 commits and 2 files changed, 1 of them inside the UI closure. Atmos #2 adds a map module.`), provenance);
    assert.ok(after[DOC].includes(`Pin (fresh staging qualification pending): ${provenance}\n\nHistorical pin (qualified in run 1): Merged Atmos source ${repo.A},`));
    assert.ok(after[DOC].includes(before[DOC].match(/^Pin \([^)\n]*\): (Merged Atmos source [^\n]*)$/m)[1]), 'the old Pin line moves verbatim');
    const declaration = JSON.parse(after[DECLARATION]).otherAtmosCommits.commits;
    assert.ok(declaration[repo.B] && !declaration[repo.A]);
    assert.match(after['tools/ui-combined-source-guard.mjs'], /\/\/ Reviewed merged source: Merge pull request #2 from weatherx-hq\/b; fresh staging qualification remains required\.\nexport const UI_SOURCE/);
    assert.match(run.stdout, /^Pin the combined UI source to reviewed Atmos /);
    assert.match(run.stdout, /byte-identical/);
    const inventory = spawnSync(process.execPath, ['tools/workflow-inventory.mjs', '--check'], {cwd: root, encoding: 'utf8'});
    assert.equal(inventory.status, 0, inventory.stderr);
    // Only the provenance ("Supersedes <old>") and the Historical line may still name the old pin.
    for (const path of SITE_FILES.filter(path => path !== DOC && path !== FIXTURE)) assert.ok(!after[path].includes(repo.A), `${path} still names the old pin`);
    const fixture = JSON.parse(after[FIXTURE]);
    assert.ok(!JSON.stringify({...fixture, stagingBuild: {...fixture.stagingBuild, provenance: ''}}).includes(repo.A), 'fixture pins moved');
  });

for (const [name, target, ref, message] of [
  ['a changed controller closure', 'C', 'C', /controller closure changed[\s\S]*a human must review/],
  ['a reviewed digest missing from the release guard', 'D', 'D', /not declared in Atmos app\/src\/build\/publicReleaseGuard\.ts[\s\S]*onboarding\/Icon\.tsx 5eeaba1d/],
  ['a commit that is not an ancestor of origin/master', 'E', 'C', /is not an ancestor of origin\/master/],
]) test(`--set refuses ${name} and changes nothing`, () => {
  const root = copyRepo();pinCopyTo(root, repo.A);repo.master(repo[ref]);
  const before = snapshot(root);
  const run = setPin(root, repo.atmos, repo[target]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, message);
  if (target === 'C') assert.match(run.stderr, new RegExp(repo.inventory[0].replaceAll('.', '\\.')));
  assert.deepEqual(snapshot(root), before);
});

test('--set refuses malformed input before reading Atmos', () => {
  const root = copyRepo();pinCopyTo(root, repo.A);
  assert.match(setPin(root, repo.atmos, 'not-a-sha').stderr, /full lowercase 40-character/);
  assert.match(setPin(root, repo.atmos, repo.A).stderr, /already pinned/);
  assert.match(setPin(root, join(repo.atmos, 'missing'), repo.B).stderr, /--atmos needs/);
});
