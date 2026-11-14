#!/usr/bin/env node
// After a whole bake publishes releases/<RELEASE_ID>/, give every forecast run it carries a copy
// outside the whole releases, then record that in history-receipts/<RELEASE_ID>.json.
//
// For each run directory of the release's immutable manifest (runDirsOf in
// production-releases-retention.mjs, the same classifier retention uses):
//   - a complete component root of the same model run (`data/<model>/runs/<run>/` → `<model>`,
//     `point-series/v2/<model>/<run>/` → `point-<model>`) is recorded as `copy: component`;
//     components retention keeps one complete root per model run for good;
//   - anything else (bricks, China crops, air, verification, replays, a run whose component
//     publication failed) is copied server-side into the forecast history bucket and checked.
// Releases retention deletes a release only with a receipt bound to its manifest that covers every
// run directory, so any failure here holds releases and loses nothing.
//
// Only the newest release writes: a re-run of an old bake (same run id, older bytes) stands aside,
// so older bytes never overwrite newer ones in history. Copy only: it never deletes anything and
// never writes under releases/.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { RECEIPT_KIND, summarizeManifest } from './production-releases-retention.mjs';

const { RELEASE_ID, R2_REMOTE, COMPONENT_REMOTE, HISTORY_REMOTE } = process.env;
const FLAGS = ['--s3-no-check-bucket'];
const rclone = (...args) => execFileSync('rclone', [...args, ...FLAGS], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'inherit'] });
const lines = text => text.split('\n').filter(Boolean);
const bucketOf = remote => remote.replace(/^[^:]*:/, '').replace(/\/+$/, '').split('/').pop();

export function componentIdOf(dir) {
  let m = /^data\/([a-z][a-z0-9-]{0,39})\/runs\/\d{10}\/$/.exec(dir);
  if (m) return m[1];
  m = /^point-series\/v2\/([a-z][a-z0-9-]{0,33})\/\d{10}\/$/.exec(dir);
  return m ? `point-${m[1]}` : null;
}

function main() {
  if (!/^cycle-[1-9]\d{0,19}$/.test(RELEASE_ID ?? '')) throw new Error(`unexpected RELEASE_ID ${RELEASE_ID}`);
  for (const [name, value] of Object.entries({ R2_REMOTE, COMPONENT_REMOTE, HISTORY_REMOTE }))
    if (!/^[A-Za-z0-9_-]+:/.test(value ?? '')) throw new Error(`${name} must be an rclone remote`);
  const prefix = `${R2_REMOTE}/releases/${RELEASE_ID}`;
  let body;
  try { body = execFileSync('rclone', ['cat', `${prefix}/manifest.json`, ...FLAGS], { maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { console.log(`releases/${RELEASE_ID} has no manifest (nothing was published): no copy`); return; }
  if (!body.length) { console.log(`releases/${RELEASE_ID} has no manifest: no copy`); return; }
  const releases = lines(rclone('lsf', `${R2_REMOTE}/releases/`, '--dirs-only'))
    .map(d => /^cycle-(\d+)\/$/.exec(d)?.[1]).filter(Boolean).map(BigInt);
  const mine = BigInt(RELEASE_ID.slice('cycle-'.length));
  if (releases.some(id => id > mine)) { console.log(`a newer release exists: ${RELEASE_ID} stands aside (no copy, no receipt)`); return; }
  const summary = summarizeManifest(body.toString('utf8'), RELEASE_ID);
  if (summary.status !== 'manifest-valid') throw new Error(`releases/${RELEASE_ID}/manifest.json is ${summary.status}`);
  if (summary.unrecognized.length) throw new Error(`unrecognized run-keyed paths, no receipt: ${summary.unrecognized.slice(0, 5).join(', ')}`);
  const roots = new Map();
  const rootsOf = id => {
    if (!roots.has(id)) {
      let listed = [];
      try { listed = lines(rclone('lsf', `${COMPONENT_REMOTE}/components/${id}/`, '--dirs-only')); } catch { listed = []; }
      roots.set(id, listed);
    }
    return roots.get(id);
  };
  const runs = {};
  let copied = 0, matched = 0;
  for (const [dir, objects] of Object.entries(summary.runs).sort()) {
    const id = componentIdOf(dir), run = /(\d{10})\/$/.exec(dir)[1];
    let component = null;
    if (id) {
      const stamp = `${id}-${run.slice(0, 8)}T${run.slice(8)}0000Z-`;
      for (const root of rootsOf(id).filter(r => r.startsWith(stamp)).sort().reverse()) {
        const found = lines(rclone('lsf', `${COMPONENT_REMOTE}/components/${id}/${root}`, '--files-only', '--max-depth', '1', '--include', 'component.json'));
        if (found.includes('component.json')) { component = `components/${id}/${root}`; break; }
      }
    }
    if (component) { runs[dir] = { objects, copy: 'component', component }; matched += 1; continue; }
    // Server-side copy; --checksum re-copies a file whose bytes changed (this release is the newest).
    rclone('copy', `${prefix}/${dir}`, `${HISTORY_REMOTE}/${dir}`, '--checksum', '--transfers', '32', '--checkers', '64');
    rclone('check', `${prefix}/${dir}`, `${HISTORY_REMOTE}/${dir}`, '--one-way');
    runs[dir] = { objects, copy: 'history' };
    copied += 1;
  }
  const receipt = { schemaVersion: 2, kind: RECEIPT_KIND, releaseId: RELEASE_ID, manifestSha256: summary.manifestSha256,
    historyBucket: bucketOf(HISTORY_REMOTE), componentBucket: bucketOf(COMPONENT_REMOTE), writtenAt: new Date().toISOString(),
    writer: 'tools/forecast-history-copy.mjs', runs };
  const text = `${JSON.stringify(receipt)}\n`;
  execFileSync('rclone', ['rcat', `${R2_REMOTE}/history-receipts/${RELEASE_ID}.json`, ...FLAGS], { input: text });
  console.log(`history receipt history-receipts/${RELEASE_ID}.json: ${matched} runs matched to components, ${copied} copied to history ` +
    `(sha256 ${createHash('sha256').update(text).digest('hex').slice(0, 12)})`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try { main(); } catch (error) { console.error(`forecast history copy refused: ${error.message}`); process.exitCode = 1; }
}
