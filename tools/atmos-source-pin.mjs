#!/usr/bin/env node
// One declaration of the Atmos commit that every ordinary production data producer runs.
// GitHub needs literal checkout refs before any repository file can be read, so workflow
// YAML keeps literal pins; this tool proves every listed literal equals the declaration,
// and `--set` moves all of them together. It never changes protected variables.
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join, resolve} from 'node:path';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DECLARATION = 'ops/atmos-production-source.json';
const COMMIT = /^[a-f0-9]{40}$/;

export function readDeclaration(root = ROOT) {
  const value = JSON.parse(readFileSync(resolve(root, DECLARATION), 'utf8'));
  if (value?.schemaVersion !== 1 || !COMMIT.test(value.atmosSha ?? '') || !Array.isArray(value.pins) || !value.pins.length)
    throw new Error('invalid Atmos production source declaration');
  for (const pin of value.pins) {
    if (typeof pin?.path !== 'string' || !/^(?:\.github\/workflows|tools)\/[A-Za-z0-9_.-]+\.(?:ya?ml|json)$/.test(pin.path)
      || !Number.isSafeInteger(pin.occurrences) || pin.occurrences < 1) throw new Error(`invalid pin record: ${pin?.path}`);
  }
  return value;
}

// Each listed file must contain the declared commit exactly as often as declared. A hand
// edit of one site (or a stale literal left behind) changes the count and is refused.
export function checkPins(root = ROOT, declaration = readDeclaration(root)) {
  const problems = [];
  for (const {path, occurrences} of declaration.pins) {
    const text = readFileSync(resolve(root, path), 'utf8');
    const found = text.split(declaration.atmosSha).length - 1;
    if (found !== occurrences) problems.push(`${path}: expected ${occurrences} pin(s) of ${declaration.atmosSha}, found ${found}`);
  }
  return problems;
}

// Every 40-hex value in workflow and tool files (action pins on `uses:` lines excepted) must be
// classified: the declared producer source (only in its listed files), another qualified Atmos
// commit (only in its listed files), or a known non-Atmos hash. A new pin site cannot drift in.
const HEX = /(?<![0-9a-f])[a-f0-9]{40}(?![0-9a-f])/g;
export function scannedFiles(root = ROOT) {
  const out = readdirSync(join(root, '.github/workflows')).filter(name => /\.ya?ml$/.test(name)).map(name => `.github/workflows/${name}`);
  const walk = dir => {
    for (const entry of readdirSync(join(root, dir), {withFileTypes: true})) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path); }
      else if (/\.(?:mjs|js|py|sh|json|ya?ml|txt)$/.test(entry.name) && entry.name !== 'package-lock.json') out.push(path);
    }
  };
  walk('tools');
  return out.sort();
}
export function strayPins(root = ROOT, declaration = readDeclaration(root)) {
  const pinned = new Set(declaration.pins.map(pin => pin.path));
  const other = declaration.otherAtmosCommits?.commits ?? {}, known = declaration.otherHashes?.values ?? {};
  const problems = [];
  for (const path of scannedFiles(root)) {
    const lines = readFileSync(join(root, path), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(?:-\s+)?uses:\s*\S+@[a-f0-9]{40}\b/.test(line)) return;
      for (const [sha] of line.matchAll(HEX)) {
        const at = `${path}:${index + 1}`;
        // The same commit may also be an independently qualified pin (the UI profile re-pinned to the producer
        // source); it is then allowed only in that pin's own listed files, and --set never moves those.
        if (sha === declaration.atmosSha) { if (!pinned.has(path) && !other[sha]?.includes(path)) problems.push(`${at}: declared source in an unlisted pin site`); }
        else if (other[sha]) { if (!other[sha].includes(path)) problems.push(`${at}: Atmos commit ${sha} outside its listed files`); }
        else if (known[sha]) { if (!known[sha].includes(path)) problems.push(`${at}: hash ${sha} outside its listed files`); }
        else problems.push(`${at}: unclassified 40-hex value ${sha} (declare it as the producer source, another Atmos pin, or a non-Atmos hash)`);
      }
    });
  }
  return problems;
}
// One pin value. strayPins lets an independently qualified Atmos commit sit in its own listed
// files, so a producer lane could still be re-classified onto an old source (catalog-bake was,
// 10-10..10-18). Here the producer side is pinned by meaning, not by count: every workflow gated
// by a declared approval variable is a listed pin site whose *ATMOS_SHA literals equal the
// declaration, every CORE_ATMOS_SHA literal equals it, both Wind100 policies' coreSourceSha equal
// it, and every vars.CURRENT_RUN_*ATMOS_SHA a workflow reads is declared (so the variables to set
// at merge are exactly approvalVariables).
const ATMOS_LITERAL = /^\s*(?:-\s+)?((?:[A-Z][A-Z0-9_]*_)?ATMOS_SHA):\s*['"]?([a-f0-9]{40})(?![0-9a-f])/;
export const WIND100_POLICIES = ['tools/production-wind100-policy.json', 'tools/staging-wind100-policy.json'];
export function pinAgreement(root = ROOT, declaration = readDeclaration(root)) {
  const problems = [], pinned = new Set(declaration.pins.map(pin => pin.path)), names = new Set();
  const approvals = Object.entries(declaration.approvalVariables ?? {});
  if (!approvals.length) problems.push('approvalVariables must name the protected variables that approve the declared source');
  for (const [key, field] of approvals) {
    const match = /^[a-z0-9-]+\/([A-Z][A-Z0-9_]*)$/.exec(key);
    if (!match || field !== 'atmosSha') problems.push(`approval variable ${key} must map <environment>/<NAME> to "atmosSha"`);
    else names.add(match[1]);
  }
  for (const path of scannedFiles(root).filter(name => name.startsWith('.github/workflows/'))) {
    const lines = readFileSync(join(root, path), 'utf8').split('\n'), gated = new Set();
    lines.forEach((line, index) => {
      for (const [, name] of line.matchAll(/\bvars\.([A-Z][A-Z0-9_]*)/g)) {
        if (names.has(name)) gated.add(name);
        else if (/^CURRENT_RUN_[A-Z0-9_]*ATMOS_SHA$/.test(name)) problems.push(`${path}:${index + 1}: approval variable ${name} is not declared in approvalVariables`);
      }
    });
    if (gated.size && !pinned.has(path)) problems.push(`${path}: approved by ${[...gated].join(', ')} but not a declared pin site`);
    lines.forEach((line, index) => {
      const [, name, sha] = ATMOS_LITERAL.exec(line) ?? [];
      if (sha && (gated.size || name === 'CORE_ATMOS_SHA') && sha !== declaration.atmosSha)
        problems.push(`${path}:${index + 1}: ${name} ${sha} is not the declared producer source ${declaration.atmosSha}`);
    });
  }
  for (const path of WIND100_POLICIES) {
    const core = JSON.parse(readFileSync(join(root, path), 'utf8')).coreSourceSha;
    if (core !== declaration.atmosSha) problems.push(`${path}: coreSourceSha ${core} is not the declared producer source ${declaration.atmosSha}`);
  }
  return problems;
}

// With a local Atmos clone, prove the classification itself (read-only `git cat-file`).
export function verifyClassification(atmosRepo, root = ROOT, declaration = readDeclaration(root)) {
  const commit = sha => spawnSync('git', ['-C', atmosRepo, 'cat-file', '-e', `${sha}^{commit}`], {stdio: 'ignore'}).status === 0;
  const problems = [];
  for (const sha of [declaration.atmosSha, ...Object.keys(declaration.otherAtmosCommits?.commits ?? {})])
    if (!commit(sha)) problems.push(`${sha} is declared as an Atmos commit but ${atmosRepo} does not contain it`);
  for (const sha of Object.keys(declaration.otherHashes?.values ?? {}))
    if (commit(sha)) problems.push(`${sha} is an Atmos commit but is classified as a non-Atmos hash`);
  return problems;
}

export function setPins(next, root = ROOT) {
  if (!COMMIT.test(next ?? '')) throw new Error('new Atmos commit must be a full lowercase 40-character SHA');
  const declaration = readDeclaration(root);
  const problems = checkPins(root, declaration);
  if (problems.length) throw new Error(`refusing to move inconsistent pins:\n${problems.join('\n')}`);
  for (const {path} of declaration.pins) {
    const file = resolve(root, path);
    writeFileSync(file, readFileSync(file, 'utf8').replaceAll(declaration.atmosSha, next));
  }
  const file = resolve(root, DECLARATION);
  writeFileSync(file, readFileSync(file, 'utf8').replace(`"atmosSha": "${declaration.atmosSha}"`, `"atmosSha": "${next}"`));
  return checkPins(root);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, value] = process.argv.slice(2);
  try {
    const problems = operation === '--check'
      ? [...checkPins(), ...strayPins(), ...pinAgreement(), ...(value === '--atmos-repo' ? verifyClassification(process.argv[4] ?? '') : [])]
      : operation === '--set' ? setPins(value) : null;
    if (!problems) throw new Error('usage: atmos-source-pin.mjs --check [--atmos-repo DIR] | --set <40-character Atmos SHA>');
    if (problems.length) throw new Error(problems.join('\n'));
    console.log(`Atmos production source pins agree: ${readDeclaration().atmosSha}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
