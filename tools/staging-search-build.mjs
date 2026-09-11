// Run the already-reviewed Atmos search producer against metadata from one published release.
// No weather collection, provider key, source-code artifact or publication occurs here.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { candidate, hash } from './staging-search.mjs';
import { ATMOS_SHA } from './staging-search-source.mjs';

export { ATMOS_SHA };
export const INPUTS = {
  airports: 'airports/airports.json', metar: 'stations/metar.json', tides: 'tides/tides.json',
  sondes: 'radiosondes/stations.json', storms: 'footprints/swath_storms.json',
};
export function sourceURL(release, family) {
  assert.match(release ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/);
  assert.ok(!release.includes('..') && Object.hasOwn(INPUTS, family), 'unapproved metadata source');
  return `https://staging.weatherx.org/data-atmos/_release/${release}/${INPUTS[family]}`;
}
export async function fetchInput(release, family, fetchImpl = fetch) {
  const url = sourceURL(release, family);
  const response = await fetchImpl(url, { redirect: 'error', credentials: 'omit',
    headers: { 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(30_000) });
  const max = 4 * 1024 * 1024;
  const declared = response.headers.get('content-length');
  if (response.status !== 200 || response.headers.get('x-weatherx-release') !== release ||
      (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max))) {
    await response.body?.cancel(); throw new Error('published metadata source refused or oversized');
  }
  assert.ok(response.body, 'metadata body missing');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; assert.ok(size <= max, 'metadata exceeds streamed budget'); chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  assert.ok(size > 0 && (declared === null || Number(declared) === size), 'metadata truncated');
  return Buffer.concat(chunks);
}
const PRODUCE = `
import importlib.util, sys
from pathlib import Path
root, inputs = map(Path, sys.argv[1:])
spec = importlib.util.spec_from_file_location('search_bake', root / 'data/build_search_index.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
for key, name in {'AIRPORTS_REAL':'airports','METAR_REAL':'metar','TIDES_REAL':'tides','SONDES_REAL':'sondes','STORMS_REAL':'storms'}.items():
    setattr(module, key, inputs / (name + '.json'))
module.CORE_OUT = inputs / 'candidate/core.json'
module.MORE_OUT = inputs / 'candidate/more.json'
module.cmd_bake()
`;
async function main() {
  assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_WORKSPACE);
  const root = resolve(process.env.GITHUB_WORKSPACE, 'control');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), ATMOS_SHA);
  const directory = resolve(process.env.RUNNER_TEMP, 'staging-search'); mkdirSync(directory, { recursive: true });
  const evidence = [];
  for (const family of Object.keys(INPUTS)) {
    const bytes = await fetchInput(process.env.SOURCE_RELEASE, family);
    writeFileSync(resolve(directory, `${family}.json`), bytes, { flag: 'wx' });
    evidence.push({ family, source: sourceURL(process.env.SOURCE_RELEASE, family), bytes: bytes.length, sha256: hash(bytes) });
  }
  execFileSync('python3', ['-c', PRODUCE, root, directory], { stdio: 'pipe', timeout: 60_000, maxBuffer: 64 * 1024 });
  const files = Object.fromEntries(['core.json', 'more.json'].map(name => [name, readFileSync(resolve(directory, 'candidate', name))]));
  const c = candidate(files);
  console.log(JSON.stringify({ generatorSha: ATMOS_SHA, sourceRelease: process.env.SOURCE_RELEASE,
    inputReceipts: evidence, candidateId: c.candidateId, generation: c.generation, files: c.files }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('staging search build withheld; no publication attempted'); process.exitCode = 1; });
}
