#!/usr/bin/env node
// One tool for the reviewed combined UI source pin (profile production-account-ru-kk-wind100-onboarding-v2).
// GitHub needs literal checkout refs, so the pin lives in many files. `--check` proves every pin site
// names the same Atmos commit. `--set <sha> --atmos <dir>` re-pins only when Atmos Git itself shows the move is
// mechanical: the new commit is an ancestor of origin/master, every controller-inventory file and sparse
// staging-build path is the same blob at both pins, and every reviewed account/onboarding digest is still
// declared in app/src/build/publicReleaseGuard.ts at the new commit. A changed closure needs a human review,
// so it is refused and listed. Read-only toward Atmos: git rev-parse, ls-tree, cat-file, rev-list, diff only.
// It refuses a dirty bake checkout, writes nothing until every check has passed, and restores every pin file if
// anything fails after the first write.
import {existsSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {driftTolerated} from './ui-combined-source-guard.mjs';
import {PUBLIC_COMBINED_ACCOUNT_SOURCES, PUBLIC_COMBINED_ONBOARDING_SOURCES, PUBLIC_COMBINED_INTRO_SOURCE_SHA256} from './ui-public-combined.mjs';
import {checkPins, strayPins} from './atmos-source-pin.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PROFILE = 'production-account-ru-kk-wind100-onboarding-v2';
export const FIXTURE = 'tests/fixtures/ui-controller-dependencies.json';
export const DECLARATION = 'ops/atmos-production-source.json';
export const DOC = 'docs/ui-public-combined.md';
export const RELEASE_GUARD = 'app/src/build/publicReleaseGuard.ts';
const COMMIT = /^[a-f0-9]{40}$/;
const H = '([a-f0-9]{40})';
const esc = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const read = (root, path) => readFileSync(resolve(root, path), 'utf8');
// Files that carry the pin literal; ops/atmos-production-source.json must list exactly these under the pin.
export const LISTED_FILES = ['.github/workflows/ui-release.yml', '.github/workflows/ui-staging.yml',
  'tools/ui-combined-source-guard.mjs', 'tools/ui-public-combined.mjs'];

// Text pin sites: each regex captures the pin in group 1 and must match exactly `count` times.
export const TEXT_SITES = [
  {path: 'tools/ui-combined-source-guard.mjs', label: 'UI_SOURCE', re: new RegExp(`^export const UI_SOURCE = '${H}';$`, 'gm'), count: 1},
  {path: 'tools/ui-public-combined.mjs', label: 'PUBLIC_COMBINED_ATMOS_SHA', re: new RegExp(`^export const PUBLIC_COMBINED_ATMOS_SHA = '${H}';$`, 'gm'), count: 1},
  {path: '.github/workflows/ui-staging.yml', label: 'build and qualify controller refs', re: new RegExp(`== '${esc(PROFILE)}' && '${H}'`, 'g'), count: 2},
  {path: '.github/workflows/ui-release.yml', label: 'promote controller ref', re: new RegExp(`== '${esc(PROFILE)}' && '${H}'`, 'g'), count: 1},
  {path: 'tests/ui-controller-checkout.mjs', label: 'combined inventory lookup', re: new RegExp(`row\\.pin==='${H}'`, 'g'), count: 1},
  {path: 'tests/ui-controller-checkout.mjs', label: 'controllerRefs entry', re: new RegExp(`\\['${esc(PROFILE)}','${H}'\\]`, 'g'), count: 1},
  {path: 'tests/ui-public-combined.mjs', label: 'PUBLIC_COMBINED_ATMOS_SHA assertion', re: new RegExp(`assert\\.equal\\(PUBLIC_COMBINED_ATMOS_SHA,'${H}'\\)`, 'g'), count: 1},
  {path: 'tests/ui-workflow.mjs', label: 'COMBINED_ATMOS_SHA', re: new RegExp(`^const COMBINED_ATMOS_SHA='${H}';$`, 'gm'), count: 1},
  {path: DOC, label: 'current Pin line', re: new RegExp(`^Pin \\([^)\\n]*\\): Merged Atmos source ${H},`, 'gm'), count: 1, moved: true},
  {path: DOC, label: 'source guard paragraph', re: new RegExp(`requires a clean candidate checkout at the reviewed merged \`${H}\` commit`, 'g'), count: 1},
  // Generated from the workflows; --set regenerates it instead of editing it.
  {path: 'docs/WORKFLOWS.md', label: 'generated checkout rows', re: new RegExp(`== '${esc(PROFILE)}' &amp;&amp; '${H}'`, 'g'), count: 3, generated: true},
];

// Every pin site as [where, sha]; a site that cannot be found is reported with sha null.
export function pinSites(root = ROOT) {
  const sites = [];
  for (const {path, label, re, count} of TEXT_SITES) {
    const found = [...read(root, path).matchAll(re)].map(match => match[1]);
    if (found.length !== count) sites.push([`${path} (${label}): expected ${count} site(s), found ${found.length}`, null]);
    for (const sha of found) sites.push([`${path} (${label})`, sha]);
  }
  const declaration = JSON.parse(read(root, DECLARATION));
  const keys = Object.entries(declaration.otherAtmosCommits?.commits ?? {})
    .filter(([, files]) => files.includes('tools/ui-combined-source-guard.mjs'));
  if (keys.length !== 1) sites.push([`${DECLARATION}: expected one otherAtmosCommits key listing the guard, found ${keys.length}`, null]);
  for (const [sha, files] of keys) {
    const missing = LISTED_FILES.filter(file => !files.includes(file));
    sites.push([`${DECLARATION} (otherAtmosCommits key)`, missing.length ? null : sha]);
    if (missing.length) sites.push([`${DECLARATION}: key ${sha} does not list ${missing.join(', ')}`, null]);
  }
  const fixture = JSON.parse(read(root, FIXTURE));
  const staging = fixture.stagingBuild ?? {};
  if (staging.profile !== PROFILE) sites.push([`${FIXTURE}: stagingBuild.profile is not ${PROFILE}`, null]);
  sites.push([`${FIXTURE} (stagingBuild.pin)`, COMMIT.test(staging.pin ?? '') ? staging.pin : null]);
  const provenance = /^Merged Atmos source ([a-f0-9]{40}),/.exec(staging.provenance ?? '')?.[1] ?? null;
  sites.push([`${FIXTURE} (stagingBuild.provenance)`, provenance]);
  const records = (fixture.controllers ?? []).filter(row => row.pin === staging.pin);
  sites.push([`${FIXTURE} (controllers[].pin, the combined inventory)`, records.length === 1 ? records[0].pin : null]);
  return sites;
}

export function checkSites(root = ROOT) {
  const sites = pinSites(root);
  const problems = sites.filter(([, sha]) => !sha).map(([where]) => `${where}: pin site missing or malformed`);
  const values = [...new Set(sites.map(([, sha]) => sha).filter(Boolean))];
  if (values.length > 1) {
    const counts = values.map(value => [value, sites.filter(([, sha]) => sha === value).length]).sort((a, b) => b[1] - a[1]);
    for (const [where, sha] of sites) if (sha && sha !== counts[0][0]) problems.push(`${where}: ${sha} disagrees with ${counts[0][0]} (${counts[0][1]} sites)`);
  }
  return {pin: values.length === 1 ? values[0] : null, sites, problems};
}

function git(atmos, args, {allowFail = false} = {}) {
  const run = spawnSync('git', ['-C', atmos, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  if (run.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed in the Atmos repository: ${(run.stderr || '').trim()}`);
  return run.status === 0 ? run.stdout : null;
}
const blobs = (atmos, sha, paths) => {
  const map = new Map();
  const out = git(atmos, ['ls-tree', '-r', '-z', '--full-tree', sha, '--', ...paths]);
  for (const entry of out.split('\0').filter(Boolean)) {
    const [meta, path] = entry.split('\t');
    map.set(path, meta);
  }
  return map;
};

export function closurePaths(root = ROOT, pin) {
  const fixture = JSON.parse(read(root, FIXTURE));
  const record = fixture.controllers.find(row => row.pin === pin);
  if (!record) throw new Error(`${FIXTURE} has no controller inventory for ${pin}`);
  return {inventory: [...record.files], sparse: [...fixture.stagingBuild.paths]};
}

// Atmos master is always the remote-tracking ref, spelled in full so a local branch named
// "origin/master" cannot stand in for it.
export const MASTER_REF = 'refs/remotes/origin/master';
export const GUARD_MAPS = {account: 'STAGING_ACCOUNT_SOURCE_SHA256', onboarding: 'PRODUCTION_ONBOARDING_SOURCE_SHA256'};
export const GUARD_INTRO = 'PRODUCTION_INTRO_SOURCE_SHA256';

// One `export const NAME ... = Object.freeze({ ... });` map from publicReleaseGuard.ts, parsed strictly:
// every non-comment line inside it must be a `'name': '<sha256>',` entry, so nothing is inferred.
export function guardMap(source, name) {
  const start = new RegExp(`^export const ${name}\\b[^=\\n]*= Object\\.freeze\\(\\{\\s*$`, 'm').exec(source);
  if (!start) throw new Error(`${RELEASE_GUARD} declares no ${name} map`);
  const body = source.slice(start.index + start[0].length);
  const end = body.search(/^\}\);\s*$/m);
  if (end < 0) throw new Error(`${RELEASE_GUARD}: ${name} map is not closed`);
  const map = {};
  for (const raw of body.slice(0, end).replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
    const line = raw.replace(/^\s*\/\/.*$/, '').trim();
    if (!line) continue;
    const entry = /^'([^'\n]+)':\s*'([a-f0-9]{64})',?(?:\s*\/\/.*)?$/.exec(line);
    if (!entry) throw new Error(`${RELEASE_GUARD}: unrecognised line in ${name}: ${line}`);
    if (Object.hasOwn(map, entry[1])) throw new Error(`${RELEASE_GUARD}: duplicate ${name} entry ${entry[1]}`);
    map[entry[1]] = entry[2];
  }
  return map;
}
export function guardIntro(source) {
  const found = [...source.matchAll(new RegExp(`^export const ${GUARD_INTRO}\\b[^=\\n]*= '([a-f0-9]{64})';\\s*$`, 'gm'))];
  if (found.length !== 1) throw new Error(`${RELEASE_GUARD} must declare ${GUARD_INTRO} exactly once, found ${found.length}`);
  return found[0][1];
}
// Exact equality both ways: a missing, extra or different entry is listed.
export function compareDigests(source) {
  const problems = [];
  const pairs = [[GUARD_MAPS.account, PUBLIC_COMBINED_ACCOUNT_SOURCES], [GUARD_MAPS.onboarding, PUBLIC_COMBINED_ONBOARDING_SOURCES]];
  for (const [name, bake] of pairs) {
    let atmos;
    try { atmos = guardMap(source, name); } catch (error) { problems.push(error.message); continue; }
    for (const key of new Set([...Object.keys(bake), ...Object.keys(atmos)])) {
      if (!Object.hasOwn(atmos, key)) problems.push(`${name}: ${key} ${bake[key]} missing in Atmos`);
      else if (!Object.hasOwn(bake, key)) problems.push(`${name}: ${key} ${atmos[key]} declared in Atmos but not in tools/ui-public-combined.mjs`);
      else if (atmos[key] !== bake[key]) problems.push(`${name}: ${key} is ${atmos[key]} in Atmos, ${bake[key]} in tools/ui-public-combined.mjs`);
    }
  }
  try {
    const intro = guardIntro(source);
    if (intro !== PUBLIC_COMBINED_INTRO_SOURCE_SHA256) problems.push(`${GUARD_INTRO} is ${intro} in Atmos, ${PUBLIC_COMBINED_INTRO_SOURCE_SHA256} in tools/ui-public-combined.mjs`);
  } catch (error) { problems.push(error.message); }
  return problems;
}

// All refusals at once, so one run lists everything a reviewer must look at.
export function verifyAtmos(atmos, from, to, root = ROOT) {
  const problems = [];
  for (const sha of [from, to]) if (git(atmos, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], {allowFail: true}) === null)
    problems.push(`${sha} is not a commit in the Atmos repository`);
  if (problems.length) return {problems};
  const master = git(atmos, ['rev-parse', '--verify', '--quiet', `${MASTER_REF}^{commit}`], {allowFail: true})?.trim();
  if (!master) problems.push(`${MASTER_REF} does not resolve in the Atmos repository (git fetch origin master first)`);
  else if (spawnSync('git', ['-C', atmos, 'merge-base', '--is-ancestor', to, master]).status !== 0)
    problems.push(`${to} is not an ancestor of ${MASTER_REF} (${master}): only merged Atmos master can be pinned`);
  const {inventory, sparse} = closurePaths(root, from);
  if (!inventory.length || !sparse.length)
    problems.push(`${FIXTURE}: the combined controller inventory (${inventory.length} files) and stagingBuild.paths (${sparse.length}) must both be non-empty`);
  const paths = [...new Set([...inventory, ...sparse])];
  if (paths.length) {
    const before = blobs(atmos, from, paths), after = blobs(atmos, to, paths);
    const changed = paths.filter(path => !before.has(path) || !after.has(path) || before.get(path) !== after.get(path));
    if (changed.length) problems.push(`controller closure changed between ${from} and ${to}; a human must review these before re-pinning:\n  ${changed.join('\n  ')}`);
  }
  const guard = git(atmos, ['cat-file', 'blob', `${to}:${RELEASE_GUARD}`], {allowFail: true});
  const digests = Object.keys(PUBLIC_COMBINED_ACCOUNT_SOURCES).length + Object.keys(PUBLIC_COMBINED_ONBOARDING_SOURCES).length;
  if (guard === null) problems.push(`${RELEASE_GUARD} does not exist at ${to}`);
  else {
    const differ = compareDigests(guard);
    if (differ.length) problems.push(`reviewed digests in tools/ui-public-combined.mjs differ from Atmos ${RELEASE_GUARD} at ${to}:\n  ${differ.join('\n  ')}`);
  }
  return {problems, master, inventory: inventory.length, sparse: sparse.length, digests};
}

export function describe(atmos, from, to) {
  const [tree, time, ...subject] = git(atmos, ['log', '-1', '--format=%T%n%ct%n%s', to]).trim().split('\n');
  const changed = git(atmos, ['diff', '--name-only', from, to]).split('\n').filter(Boolean);
  return {
    tree, subject: subject.join(' ').replace(/\.$/, ''),
    committed: new Date(Number(time) * 1000).toISOString().replace('.000Z', 'Z'),
    commits: Number(git(atmos, ['rev-list', '--count', `${from}..${to}`]).trim()),
    files: changed.length, closureFiles: changed.filter(path => !driftTolerated(path)).length,
  };
}

const replaceSite = (text, re, from, to) => text.replace(re, match => match.replace(from, to));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
function replaceComment(text, declaration, comment) {
  const lines = text.split('\n'), index = lines.findIndex(line => line.startsWith(declaration));
  if (index > 0 && lines[index - 1].startsWith('// ')) lines[index - 1] = comment;
  else lines.splice(index, 0, comment);
  return lines.join('\n');
}

// Every file --set may write (docs/WORKFLOWS.md is written by the inventory generator).
export const WRITTEN_FILES = [...new Set([...TEXT_SITES.map(site => site.path), DECLARATION, FIXTURE])].sort();

// New contents for every pin site, computed in memory; nothing touches disk here.
export function rewrite(files, from, to, {provenance, history, summary}) {
  const out = {...files};
  // The Pin line is not edited in place: it becomes the Historical line below with its old SHA intact.
  for (const {path, re, generated, moved} of TEXT_SITES) if (!generated && !moved) out[path] = replaceSite(out[path], re, from, to);
  out['tools/ui-combined-source-guard.mjs'] = replaceComment(out['tools/ui-combined-source-guard.mjs'], 'export const UI_SOURCE = ',
    `// ${summary}; fresh staging qualification remains required.`);
  out['tools/ui-public-combined.mjs'] = replaceComment(out['tools/ui-public-combined.mjs'], 'export const PUBLIC_COMBINED_ATMOS_SHA = ',
    `// ${summary}; new-source staging acceptance remains pending.`);
  // Rename the key in place (order kept); merge if the new commit is already an Atmos pin elsewhere.
  const declaration = JSON.parse(out[DECLARATION]), commits = {};
  for (const [sha, list] of Object.entries(declaration.otherAtmosCommits.commits)) {
    if (sha === to) continue;
    commits[sha === from ? to : sha] = sha === from
      ? [...new Set([...list, ...(declaration.otherAtmosCommits.commits[to] ?? [])])].sort() : list;
  }
  declaration.otherAtmosCommits.commits = commits;
  out[DECLARATION] = json(declaration);
  const fixture = JSON.parse(out[FIXTURE]);
  fixture.controllers.find(row => row.pin === from).pin = to;
  fixture.stagingBuild.pin = to;
  fixture.stagingBuild.provenance = provenance;
  out[FIXTURE] = json(fixture);
  // The current Pin line becomes the first Historical pin line, the way each re-pin since #466 recorded it.
  out[DOC] = out[DOC].replace(/^Pin \([^)\n]*\): (Merged Atmos source [^\n]*)$/m,
    (_, old) => `Pin (fresh staging qualification pending): ${provenance}\n\nHistorical pin (${history}): ${old}`);
  return out;
}

const run = (root, command, args) => {
  const result = spawnSync(command, args, {cwd: root, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.error?.message ?? ''}${result.stderr || result.stdout}`);
  return result.stdout;
};
// Untracked inventory dependencies are expected (npm ci installs them); anything else must be committed.
export function assertClean(root) {
  const status = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '-z'], {encoding: 'utf8'});
  if (status.status !== 0) throw new Error(`${root} is not a Git working tree; --set needs a clean checkout of this repository`);
  const dirty = status.stdout.split('\0').filter(Boolean).map(entry => entry.slice(3))
    .filter(path => !path.startsWith('tools/inventory/node_modules'));
  if (dirty.length) throw new Error(`refusing to re-pin over uncommitted changes:\n  ${dirty.join('\n  ')}`);
}
const TEXT_OPTION = /^[^\x00-\x1f\x7f]*$/;

export function setPin({to, atmos, root = ROOT, note = '', history, summary, npmCi = true}) {
  if (!COMMIT.test(to ?? '')) throw new Error('--set needs a full lowercase 40-character Atmos SHA');
  if (!atmos || !existsSync(atmos)) throw new Error('--atmos needs a path to an Atmos checkout or bare Git directory');
  for (const [name, value] of [['--note', note], ['--history', history], ['--summary', summary]])
    if (value !== undefined && (typeof value !== 'string' || !TEXT_OPTION.test(value)))
      throw new Error(`${name} must be one line of text without newlines or control characters`);
  assertClean(root);
  const current = checkSites(root);
  if (current.problems.length) throw new Error(`refusing to move inconsistent pins:\n${current.problems.join('\n')}`);
  const from = current.pin;
  if (from === to) throw new Error(`the combined UI source is already pinned to ${to}`);
  const others = JSON.parse(read(root, FIXTURE)).controllers.filter(row => row.pin !== from).map(row => row.pin);
  if (others.includes(to)) throw new Error(`${to} is another profile's controller pin; the combined inventory must stay distinct`);
  const verified = verifyAtmos(atmos, from, to, root);
  if (verified.problems.length) throw new Error(`refusing to re-pin ${from} -> ${to}:\n${verified.problems.join('\n')}`);
  const facts = {...describe(atmos, from, to), masterRef: MASTER_REF, master: verified.master};
  const provenance = [`Merged Atmos source ${to}, tree ${facts.tree}, committed ${facts.committed}; ${facts.subject}.`,
    `Supersedes ${from}.`,
    `Between pins, ${facts.commits} commits and ${facts.files} files changed, ${facts.closureFiles} of them inside the UI closure.`,
    note.trim(),
    `It is an ancestor of Atmos ${MASTER_REF} (${verified.master}); all ${verified.inventory} controller inventory files and ${verified.sparse} sparse build paths are the same Git blobs as at the prior pin, and the intro digest and all ${verified.digests} account/onboarding source digests equal ${GUARD_INTRO}, ${GUARD_MAPS.account} and ${GUARD_MAPS.onboarding} in Atmos ${RELEASE_GUARD} at this commit (tools/ui-source-pin.mjs).`,
    'Fresh controller CI, clean exact-source admission and a new guarded staging run remain required.'].filter(Boolean).join(' ');
  const date = new Date().toISOString().slice(0, 10);
  // Dependencies first: nothing is written until every step that can fail without writing has passed.
  if (npmCi) run(root, 'npm', ['ci', '--ignore-scripts', '--prefix', 'tools/inventory']);
  const originals = Object.fromEntries([...WRITTEN_FILES].map(path => [path, read(root, path)]));
  const next = rewrite(originals, from, to, {provenance, history: history || `superseded on ${date} by ${to}`,
    summary: summary || `Reviewed merged source: ${facts.subject}`});
  try {
    for (const path of WRITTEN_FILES) if (next[path] !== originals[path]) writeFileSync(resolve(root, path), next[path]);
    run(root, process.execPath, ['tools/workflow-inventory.mjs', '--write']);
    run(root, process.execPath, ['tools/workflow-inventory.mjs', '--check']);
    const after = checkSites(root);
    const problems = [...after.problems, ...checkPins(root), ...strayPins(root)];
    if (after.pin !== to) problems.push(`pin sites name ${after.pin} after the rewrite, not ${to}`);
    if (problems.length) throw new Error(`rewrite left inconsistent pins:\n${problems.join('\n')}`);
  } catch (error) {
    for (const [path, text] of Object.entries(originals)) writeFileSync(resolve(root, path), text);
    throw new Error(`${error.message}\nevery pin file was restored; nothing changed`);
  }
  return {from, to, facts, verified, files: WRITTEN_FILES};
}

export function prSummary({from, to, facts, verified, files}) {
  return [`Pin the combined UI source to reviewed Atmos ${to.slice(0, 8)}`, '',
    `Moves every reviewed combined-UI pin (profile \`${PROFILE}\`) from ${from.slice(0, 8)} to Atmos master ${to} (${facts.subject}), using \`node tools/ui-source-pin.mjs --set\`.`, '',
    `Checked from Git blobs: ${to.slice(0, 8)} is an ancestor of Atmos ${facts.masterRef} (${facts.master}); the ${verified.inventory} controller inventory files and ${verified.sparse} sparse build paths are byte-identical between ${from.slice(0, 8)} and ${to.slice(0, 8)}; the intro digest and all ${verified.digests} account and onboarding digests in tools/ui-public-combined.mjs equal ${GUARD_INTRO}, ${GUARD_MAPS.account} and ${GUARD_MAPS.onboarding} in Atmos ${RELEASE_GUARD} at ${to.slice(0, 8)}, with no extra or missing entries.`, '',
    `Between pins: ${facts.commits} commits, ${facts.files} files, ${facts.closureFiles} inside the UI closure. Tree ${facts.tree}, committed ${facts.committed}.`, '',
    `Files: ${files.join(', ')}.`, '',
    'Fresh staging qualification remains required.'].join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (['--check', '--no-npm-ci'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--set', '--atmos', '--note', '--history', '--summary'].includes(arg) && index + 1 < argv.length) options[arg.slice(2)] = argv[++index];
    else throw new Error(`unknown or incomplete argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const usage = 'usage: ui-source-pin.mjs --check\n       ui-source-pin.mjs --set <40-hex Atmos SHA> --atmos <Atmos checkout or bare Git dir>'
    + ' [--note "<what the new source changes>"] [--history "<outcome of the old pin>"] [--summary "<one-line code comment>"] [--no-npm-ci]';
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.check && !options.set) {
      const {pin, sites, problems} = checkSites();
      if (problems.length) throw new Error(problems.join('\n'));
      console.log(`combined UI source pins agree at ${sites.length} sites: ${pin}`);
    } else if (options.set && !options.check) {
      const result = setPin({to: options.set, atmos: options.atmos, note: options.note, history: options.history,
        summary: options.summary, npmCi: !options['no-npm-ci']});
      console.log(prSummary(result));
    } else throw new Error(usage);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
