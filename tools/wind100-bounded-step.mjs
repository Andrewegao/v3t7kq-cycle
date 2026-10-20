// Bounded steps shared by the production and staging Wind100 inline reclaim. This module is a
// leaf: it imports only Node built-ins, so neither controller nor retention module can form an
// import cycle through it (#439: a cycle plus a top-level await deadlocked the reclaim CLI).
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

// Bounds one awaited step with a referenced timer: a step that never settles becomes an error
// naming it instead of letting the event loop drain. Nothing is retried. The inline reclaim
// bound sits above the SDK's own 120-second request abort so a transport error surfaces first.
export const RECLAIM_IO_TIMEOUT_MS = 150_000;
// Inline reclaim's own wall-clock budget, measured from the start of the command. No delete is
// dispatched after it; in-flight deletes settle within one IO bound, so the command returns a
// partial count well inside the step's 30-minute timeout and the capacity check still decides.
export const RECLAIM_BUDGET_MS = 20 * 60_000;

export async function settleWithin(label, promise, timeoutMs) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error(`${label} did not settle within ${timeoutMs} ms;`
      + ' no further deletion was attempted')), timeoutMs);
  });
  try { return await Promise.race([promise, deadline]); }
  finally { clearTimeout(timer); }
}

export function reclaimProgress() {
  return { stage: 'start', gets: 0, lists: 0, deleteCredentials: 0, deletes: 0 };
}

export function describeProgress(progress) {
  return `stage ${progress.stage}; completed gets ${progress.gets}, lists ${progress.lists},`
    + ` delete credentials ${progress.deleteCredentials}, deletes ${progress.deletes}`;
}

// Wraps a retention IO so each get, list, credential mint and delete settles or times out with a
// clear error; `progress` counts completed calls for the failure report. No retries. Optional
// methods (`getIfPresent`, `listNamespace`) are wrapped only when the IO provides them.
export function boundedReclaimIo(io, progress, timeoutMs = RECLAIM_IO_TIMEOUT_MS) {
  const bounded = {
    async get(bucket, key, maximum) {
      const value = await settleWithin(`get ${key}`, io.get(bucket, key, maximum), timeoutMs);
      progress.gets++; return value;
    },
    async listPrefix(prefix, maximum) {
      const value = await settleWithin(`list ${prefix}`, io.listPrefix(prefix, maximum), timeoutMs);
      progress.lists++; return value;
    },
    async deleteForPrefix(prefix) {
      const client = await settleWithin(`delete credential for ${prefix}`,
        Promise.resolve().then(() => io.deleteForPrefix(prefix)), timeoutMs);
      progress.deleteCredentials++;
      return { async delete(key) {
        await settleWithin(`delete ${key}`, Promise.resolve().then(() => client.delete(key)), timeoutMs);
        progress.deletes++;
      }, close: () => client.close?.() };
    },
    close: () => io.close?.(),
  };
  if (typeof io.getIfPresent === 'function') {
    bounded.getIfPresent = async (bucket, key, maximum) => {
      const value = await settleWithin(`get ${key}`, io.getIfPresent(bucket, key, maximum), timeoutMs);
      progress.gets++; return value;
    };
  }
  if (typeof io.listNamespace === 'function') {
    bounded.listNamespace = async maximum => {
      const value = await settleWithin('list component namespace', io.listNamespace(maximum), timeoutMs);
      progress.lists++; return value;
    };
  }
  return bounded;
}

// One inline reclaim: load, create IO, load the catalog validator, then plan and delete. Every
// setup step is bounded, the IO is bounded, and a failure names the stage and completed IO
// counts. `reclaim` receives the loaded module, the bounded IO and the validator.
export async function runInlineReclaim({ timeoutMs = RECLAIM_IO_TIMEOUT_MS, loadModule = () => ({}),
  createIo, loadValidator, reclaim }) {
  const progress = reclaimProgress();
  const step = (stage, start) => {
    progress.stage = stage;
    return settleWithin(stage, Promise.resolve().then(start), timeoutMs);
  };
  try {
    const module = await step('load-retention-module', loadModule);
    const io = boundedReclaimIo(await step('create-io', () => createIo(module)), progress, timeoutMs);
    try {
      const validator = await step('load-catalog-validator', loadValidator);
      try {
        progress.stage = 'plan-and-delete';
        return await reclaim({ module, io, validator });
      } finally { validator.close(); }
    } finally { io.close(); }
  } catch (error) {
    throw Error(`inline reclaim failed (${describeProgress(progress)}): ${error.message}`, { cause: error });
  }
}

// Workflow notices for a reclaim result: one `::warning::` per notice and a step-summary line.
export function reportReclaim(result, notices, env = process.env, log = console.log, label = 'Production Wind100') {
  const { warnings, summary } = notices(result);
  for (const warning of warnings) log(`::warning title=${label} reclaim::${warning}`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  return { warnings, summary };
}

// A CLI entry must not use top-level await (see production-wind100.mjs). A command that still
// leaves the event loop with nothing to wait for is reported here and exits 1, never 13.
export function runBoundedCli(label, command, invoke) {
  let settled = false;
  const unsettled = () => {
    if (settled) return;
    settled = true;
    console.error(`${label} refused: ${command} never settled; the event loop drained`
      + ' with the command still pending');
    process.exitCode = 1;
  };
  process.once('beforeExit', unsettled);
  return Promise.resolve().then(invoke).then(
    result => { process.stdout.write(`${JSON.stringify(result)}\n`); },
    error => { console.error(`${label} refused: ${error.message}`); process.exitCode = 1; },
  ).finally(() => { settled = true; process.off('beforeExit', unsettled); });
}
