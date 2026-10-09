#!/usr/bin/env node
// Build the reviewed combined UI only from the exact reviewed Atmos pin, which must be an ancestor
// of the current Atmos master. Master may have moved on since the pin, but only in areas that never
// enter the UI candidate: the candidate is checked out, tested and built from the pin itself, and
// promotion uploads that sealed artifact. Drift anywhere inside the UI closure (app/, the
// non-commercial platform edge, release and platform tooling, test registries, lockfiles) still
// refuses the pin until a fresh source boundary is reviewed and re-pinned.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Reviewed merged master head (2026-10-09 04:16Z, PR #521), first production-bound pin since the 2026-09-27 release.
export const UI_SOURCE = '34efee01d95942145c6dfc79732278728cef0ddf';
export const REVIEWED_MASTER = UI_SOURCE;
/** Exact extra paths allowed to differ between the pin and master (none at this pin). */
export const EDGE_ONLY_DIFF = Object.freeze([]);
/**
 * Master drift the UI candidate never contains. Deny by default: a path is tolerated only when it
 * starts with one of these prefixes or matches one of these commercial-API file patterns under
 * platform/edge. Everything else (app/, platform/edge/src outside commercialApi, wrangler.jsonc,
 * wrangler.data.jsonc, package files, ops/release, ops/platform, testing/, tools/, scripts/,
 * .gitignore) keeps the exact-master rule.
 */
export const DRIFT_ALLOWED_PREFIXES = Object.freeze([
  'docs/', 'data/', 'clients/', 'experiments/', '.codex/', '.claude/', '.github/workflows/',
  'ops/commercial/', 'ops/fusion/',
  'platform/edge/src/commercialApi/', 'platform/edge/commercial-portal/', 'platform/edge/commercial-sandbox/',
  'platform/edge/commercial-recovery-drill/', 'platform/edge/commercial-qualification-v2/',
  'platform/edge/commercial-realdata-qualification/',
]);
export const DRIFT_ALLOWED_PATTERNS = Object.freeze([
  /^platform\/edge\/wrangler\.commercial-[A-Za-z0-9._-]+\.jsonc$/,
  /^platform\/edge\/test\/commercial[A-Za-z0-9._-]*\.ts$/,
  /^platform\/edge\/test\/commercialApi\/[A-Za-z0-9._/-]+\.ts$/,
  /^platform\/edge\/scripts\/[A-Za-z0-9._-]*commercial[A-Za-z0-9._-]*\.(mjs|ts)$/,
  /^platform\/edge\/docs\/[A-Za-z0-9._/-]+$/,
  /^ops\/test_[A-Za-z0-9_]+\.py$/,
]);

export function driftTolerated(path) {
  if (typeof path !== 'string' || !path || path.includes('..') || path.startsWith('/')) return false;
  if (EDGE_ONLY_DIFF.includes(path)) return true;
  return DRIFT_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix))
    || DRIFT_ALLOWED_PATTERNS.some((pattern) => pattern.test(path));
}

export function assertReviewedMaster(master, changedPaths) {
  assert.match(master ?? '', /^[a-f0-9]{40}$/, 'invalid Atmos master identity');
  assert.ok(Array.isArray(changedPaths), 'changed paths must be a list');
  if (master === REVIEWED_MASTER) {
    assert.deepEqual(changedPaths, [...EDGE_ONLY_DIFF], 'changes since UI pin are not empty');
    return;
  }
  const refused = changedPaths.filter((path) => !driftTolerated(path));
  assert.equal(refused.length, 0,
    `Atmos master changed inside the UI closure since the reviewed pin; review a fresh source boundary: ${refused.slice(0, 12).join(', ')}`);
}

export function assertCombinedSource(cwd, expected = UI_SOURCE) {
  assert.equal(expected, UI_SOURCE, 'combined UI source pin changed');
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  assert.equal(git(['rev-parse', 'HEAD']), UI_SOURCE, 'UI checkout differs from reviewed pin');
  const master = git(['rev-parse', 'origin/master']);
  git(['merge-base', '--is-ancestor', UI_SOURCE, 'origin/master']);
  assertReviewedMaster(master,
    git(['diff', '--name-only', UI_SOURCE, 'origin/master']).split('\n').filter(Boolean));
  git(['diff', '--exit-code', 'HEAD']);
  return UI_SOURCE;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(assertCombinedSource(resolve(process.argv[2]), process.argv[3])); }
  catch (error) { console.error(`combined UI source guard refused: ${error.message}`); process.exitCode = 1; }
}
