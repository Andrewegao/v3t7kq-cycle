#!/usr/bin/env node
// Build the reviewed combined UI only from the exact current Atmos master.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const UI_SOURCE = 'c257ef903462518b0c257b1e2d0a52ca8fd61873';
export const REVIEWED_MASTER = UI_SOURCE;
export const EDGE_ONLY_DIFF = Object.freeze([]);

export function assertReviewedMaster(master, changedPaths) {
  assert.equal(master, REVIEWED_MASTER, 'Atmos master changed; review a fresh source boundary');
  assert.deepEqual(changedPaths, EDGE_ONLY_DIFF,
    'changes since UI pin are not empty');
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
