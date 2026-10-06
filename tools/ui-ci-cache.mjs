// Cache keys for the candidate-domain staging jobs (build, app-tests) only.
// The publisher jobs (qualify, promote) hold Pages/candidate credentials and never
// restore any cache: an entry written by a runner that executed candidate code could
// otherwise reach them. See docs/ui-pipeline-flow-20261005.md.
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLAYWRIGHT_CACHE_LOCKFILE = 'atmos/app/package-lock.json';
const VERSION = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,6}$/;

// Browsers are versioned by playwright-core; the CLI package must agree with it.
export function lockedPlaywrightVersion(lockText) {
  assert.equal(typeof lockText, 'string');
  assert.ok(Buffer.byteLength(lockText) <= 32 * 1024 * 1024, 'lockfile too large');
  const lock = JSON.parse(lockText);
  assert.ok(lock && typeof lock === 'object' && lock.packages && typeof lock.packages === 'object', 'lockfile v2+ required');
  const core = lock.packages['node_modules/playwright-core']?.version;
  assert.match(core ?? '', VERSION, 'locked playwright-core version required');
  for (const name of ['node_modules/playwright', 'node_modules/@playwright/test']) {
    const version = lock.packages[name]?.version;
    if (version !== undefined) assert.equal(version, core, `${name} differs from playwright-core`);
  }
  return core;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, path] = process.argv.slice(2);
  assert.equal(command, 'playwright-version'); assert.equal(path, PLAYWRIGHT_CACHE_LOCKFILE);
  assert.ok(statSync(path).isFile());
  const version = lockedPlaywrightVersion(readFileSync(path, 'utf8'));
  assert.ok(process.env.GITHUB_OUTPUT, 'step output path is required');
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  console.log(`Locked Playwright ${version}`);
}
