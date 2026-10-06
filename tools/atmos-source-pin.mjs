#!/usr/bin/env node
// One declaration of the Atmos commit that every ordinary production data producer runs.
// GitHub needs literal checkout refs before any repository file can be read, so workflow
// YAML keeps literal pins; this tool proves every listed literal equals the declaration,
// and `--set` moves all of them together. It never changes protected variables.
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

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
    const problems = operation === '--check' ? checkPins() : operation === '--set' ? setPins(value) : null;
    if (!problems) throw new Error('usage: atmos-source-pin.mjs --check | --set <40-character Atmos SHA>');
    if (problems.length) throw new Error(problems.join('\n'));
    console.log(`Atmos production source pins agree: ${readDeclaration().atmosSha}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
