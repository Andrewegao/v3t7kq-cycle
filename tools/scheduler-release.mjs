#!/usr/bin/env node
// Manual, compare-and-swap release of the Cloudflare model scheduler Worker
// (`weatherx-model-scheduler`): its code, its plain-text vars and its cron triggers. No route,
// secret, data, Pages or other Worker is touched.
//
//   plan     read-only; prints declared vs live crons and vars, records the active version and the
//            declaration digest a release must carry, and refuses when the live Worker has no
//            dispatch secret or a mixed deployment
//   release  refuses unless the live active version is the planned one and the checked-out
//            declaration is the planned one; uploads one inactive version, checks its bindings,
//            activates it, applies the declared triggers, and requires the live readback
//            (active version, crons, vars, secret name) to equal the declaration
//   recover  restores only this run's predecessor version and the predecessor's cron set
//
// Cron triggers are not part of a Worker version, so `wrangler rollback` alone would leave the new
// trigger set behind; recovery also writes the previous trigger set through the schedules API.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { activeVersion } from './consumer-refresh.mjs';
import { uploadedVersion } from './platform-wind100-worker-release.mjs';
import {
  assertExactDispatchBindings, assertExactSchedules, assertExactTarget, loadSchedulerConfig,
} from '../scheduler/scripts/live-schedules.mjs';

const exec = promisify(execFile);
export const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
export const WORKER = 'weatherx-model-scheduler';
const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
const WORKFLOW = `${REPOSITORY}/.github/workflows/scheduler-deploy.yml@refs/heads/main`;
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const CYCLE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const wait = ms => new Promise(done => setTimeout(done, ms));

// The reviewed declaration a release applies: identity, sorted triggers, vars and secret names.
export function declaration(config) {
  assert.equal(config.accountId, ACCOUNT, 'scheduler account changed');
  assert.equal(config.workerName, WORKER, 'scheduler Worker name changed');
  return {
    account: config.accountId,
    worker: config.workerName,
    crons: [...config.expectedCrons].sort(),
    vars: Object.fromEntries(Object.entries(config.expectedVars).sort(([a], [b]) => a.localeCompare(b))),
    secrets: [...config.requiredSecrets].sort(),
  };
}

export const declarationSha256 = decl => sha256(decl);

export function confirmation(mode, digest) {
  assert.ok(['plan', 'release'].includes(mode), 'unknown release mode');
  if (mode === 'plan') return 'PLAN-SCHEDULER';
  assert.match(digest ?? '', DIGEST, 'release requires the planned declaration digest');
  return `RELEASE-SCHEDULER:${digest}`;
}

export function admit(env, digest) {
  const mode = env.RELEASE_MODE;
  assert.ok(['plan', 'release'].includes(mode), 'unknown release mode');
  if (mode === 'plan') {
    assert.equal(env.CONFIRM, 'PLAN-SCHEDULER', 'plan confirmation is PLAN-SCHEDULER');
    assert.equal(env.EXPECTED_ACTIVE_VERSION_ID ?? '', '', 'plan does not accept an expected version');
    return { mode, expected: null };
  }
  // The digest in the confirmation is the one the plan printed; a declaration changed since the plan
  // (a later merge to scheduler/) has a different digest and is refused.
  assert.equal(env.CONFIRM, confirmation('release', digest),
    'release confirmation does not carry the declaration being deployed; run plan again');
  assert.match(env.EXPECTED_ACTIVE_VERSION_ID ?? '', UUID, 'release requires the active version reported by a plan run');
  return { mode, expected: env.EXPECTED_ACTIVE_VERSION_ID };
}

export function cronDiff(declared, live) {
  const want = new Set(declared), have = new Set(live);
  return {
    keep: [...want].filter(cron => have.has(cron)).sort(),
    add: [...want].filter(cron => !have.has(cron)).sort(),
    remove: [...have].filter(cron => !want.has(cron)).sort(),
  };
}

// Plain-text vars by name and secret names only; secret values are never readable.
export function liveBindings(bindings) {
  assert.ok(Array.isArray(bindings), 'live bindings missing');
  const vars = {}, secrets = [];
  for (const binding of bindings) {
    if (binding?.type === 'plain_text') vars[binding.name] = binding.text;
    else if (binding?.type === 'secret_text') secrets.push(binding.name);
  }
  return { vars, secrets: secrets.sort() };
}

export function varDiff(declared, live) {
  const names = [...new Set([...Object.keys(declared), ...Object.keys(live)])].sort();
  return names.filter(name => declared[name] !== live[name])
    .map(name => ({ name, live: live[name] ?? null, declared: declared[name] ?? null }));
}

export function planReport(decl, live) {
  const bindings = liveBindings(live.bindings);
  const missingSecrets = decl.secrets.filter(name => !bindings.secrets.includes(name));
  // A release keeps the existing secret (versions inherit secrets); it cannot create one.
  assert.deepEqual(missingSecrets, [], `live Worker lacks required secret(s): ${missingSecrets.join(', ')}`);
  return {
    activeVersionId: live.active,
    crons: { declared: decl.crons, live: [...live.crons].sort(), ...cronDiff(decl.crons, live.crons) },
    vars: varDiff(decl.vars, bindings.vars),
    secrets: decl.secrets,
  };
}

export function recoveryAction(active, receipt) {
  if (active === receipt.previous) return 'restore-triggers-only';
  assert.equal(active, receipt.candidate, 'a different publisher changed the Worker; refuse rollback');
  return 'restore-owned-candidate';
}

export function releaseCommand(active, digest) {
  return `gh workflow run scheduler-deploy.yml -R ${REPOSITORY} --ref main -f mode=release `
    + `-f expected_active_version_id=${active} -f confirm=${confirmation('release', digest)}`;
}

export function summaryLines(report, digest, mode) {
  const list = values => values.length ? values.map(value => `\`${value}\``).join(', ') : 'none';
  const lines = [`## Scheduler Worker ${mode}`, '',
    `- Worker: \`${WORKER}\`, active version \`${report.activeVersionId}\``,
    `- Declaration digest: \`${digest}\``, '',
    '| Cron (UTC) | Live | Declared |', '|---|---|---|'];
  for (const cron of [...new Set([...report.crons.live, ...report.crons.declared])].sort()) {
    lines.push(`| \`${cron}\` | ${report.crons.live.includes(cron) ? 'yes' : 'no'} | ${report.crons.declared.includes(cron) ? 'yes' : 'no'} |`);
  }
  lines.push('', `- Crons added: ${list(report.crons.add)}; removed: ${list(report.crons.remove)}`);
  lines.push(`- Vars changing: ${report.vars.length ? report.vars.map(row => `\`${row.name}\` ${row.live ?? '(absent)'} → ${row.declared ?? '(removed)'}`).join('; ') : 'none'}`);
  if (mode === 'plan') lines.push('', 'Release with:', '', '```sh', releaseCommand(report.activeVersionId, digest), '```');
  return lines;
}

function context(env) {
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: WORKFLOW,
    GITHUB_JOB: 'release', WORKER_RELEASE_ENVIRONMENT: 'production' })) assert.equal(env[key], expected, `${key} changed`);
  assert.ok(env.SCHEDULER_WORKER_TOKEN, 'dedicated Workers token required');
  assert.ok(!env.CLOUDFLARE_API_TOKEN && !env.UI_PRODUCTION_PAGES_TOKEN && !env.CLOUDFLARE_DATA_EDGE_API_TOKEN,
    'unrelated release credentials are forbidden');
  assert.match(env.RELEASE_DIR ?? '', /^\//, 'RELEASE_DIR must be absolute');
  return env;
}

async function cf(url, token, init = {}) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) } });
  // Cloudflare errors can contain account data; report status only.
  assert.equal(response.status, 200, `Cloudflare ${init.method ?? 'GET'} returned HTTP ${response.status}`);
  const value = await response.json();
  assert.equal(value?.success, true, 'Cloudflare rejected the request');
  return value;
}

export async function readLive(token, request = cf) {
  const [deployments, schedules, settings] = await Promise.all([
    request(`${API}/deployments`, token), request(`${API}/schedules`, token), request(`${API}/settings`, token)]);
  const active = activeVersion(deployments.result);
  const crons = (schedules.result?.schedules ?? []).map(row => row?.cron);
  assert.ok(crons.every(cron => typeof cron === 'string' && cron), 'invalid live cron');
  return { active, crons, bindings: settings.result?.bindings, schedules, settings };
}

export async function writeCrons(token, crons, request = cf) {
  const payload = await request(`${API}/schedules`, token,
    { method: 'PUT', body: JSON.stringify(crons.map(cron => ({ cron }))) });
  assertExactSchedules(payload, crons);
}

export async function verifyLive(token, decl, candidate, target, { request = cf, attempts = 12, delay = 5000 } = {}) {
  let last;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const live = await readLive(token, request);
      assert.equal(live.active, candidate, 'candidate is not the active Worker version');
      assertExactSchedules(live.schedules, decl.crons);
      assertExactDispatchBindings(live.settings, decl.vars, decl.secrets);
      assertExactTarget(live.settings, target);
      return { active: live.active, crons: [...live.crons].sort() };
    } catch (error) {
      last = error;
      if (attempt < attempts - 1) await wait(delay);
    }
  }
  throw Error('live scheduler did not match the declaration', { cause: last });
}

async function wrangler(env, args) {
  try {
    const { stdout } = await exec(process.execPath, [resolve(CYCLE, 'scheduler/node_modules/wrangler/bin/wrangler.js'),
      ...args, '--config', 'wrangler.jsonc'], { cwd: resolve(CYCLE, 'scheduler'), timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, CI: 'true',
        NO_COLOR: '1', CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: env.SCHEDULER_WORKER_TOKEN } });
    return stdout;
  } catch { throw Error(`Wrangler ${args[0]} ${args[1] ?? ''} failed`.trim()); }
}

function save(path, receipt) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, { flag: 'a' });
}

async function recover(env, receipt) {
  if (!receipt?.previous || !Array.isArray(receipt.previousCrons)) return 'nothing-to-restore';
  const token = env.SCHEDULER_WORKER_TOKEN;
  const live = await readLive(token);
  if (recoveryAction(live.active, receipt) === 'restore-owned-candidate') {
    await wrangler(env, ['rollback', receipt.previous, '--yes', '--message',
      `Restore prior scheduler after failed release run ${receipt.runId}`]);
  }
  await writeCrons(token, receipt.previousCrons);
  const after = await readLive(token);
  assert.equal(after.active, receipt.previous, 'scheduler rollback readback failed');
  assertExactSchedules(after.schedules, receipt.previousCrons);
  return 'prior-version-and-triggers-restored';
}

export async function main(command, env = process.env) {
  assert.ok(['plan', 'release', 'recover'].includes(command), 'unknown command');
  context(env);
  const config = await loadSchedulerConfig(pathToFileURL(resolve(CYCLE, 'scheduler/wrangler.jsonc')));
  const decl = declaration(config);
  const digest = declarationSha256(decl);
  const admitted = admit(env, digest);
  const path = resolve(env.RELEASE_DIR, 'receipt.json');
  const token = env.SCHEDULER_WORKER_TOKEN;

  if (command === 'recover') {
    assert.equal(admitted.mode, 'release', 'only a release run can recover');
    if (!existsSync(path)) return { status: 'no-receipt' };
    const receipt = JSON.parse(readFileSync(path));
    for (const [key, value] of Object.entries({ declarationSha256: digest, controllerSha: env.GITHUB_SHA,
      runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT })) assert.equal(receipt[key], value, `receipt ${key} changed`);
    if (receipt.status === 'passed') return { status: 'passed-nothing-to-restore' };
    let recovery;
    try { recovery = await recover(env, receipt); } catch { recovery = 'manual-inspection-required'; }
    save(path, { ...receipt, recovery });
    return { status: recovery };
  }

  assert.equal(command, admitted.mode, 'command does not match the admitted mode');
  assert.ok(!existsSync(path), 'receipt already exists');
  const live = await readLive(token);
  const report = planReport(decl, live);
  const receipt = { schemaVersion: 1, kind: 'weatherx-model-scheduler-release', mode: admitted.mode,
    declarationSha256: digest, declaration: decl, controllerSha: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT, previous: live.active, previousCrons: [...live.crons].sort(),
    plan: report, status: 'preflight-passed' };
  save(path, receipt);
  console.log(JSON.stringify({ declared: report.crons.declared, live: report.crons.live, add: report.crons.add,
    remove: report.crons.remove, vars: report.vars }, null, 2));
  if (admitted.mode === 'plan') {
    summary(summaryLines(report, digest, 'plan'));
    return { status: 'planned', expectedActiveVersionId: live.active, declarationSha256: digest,
      release: releaseCommand(live.active, digest) };
  }

  assert.equal(live.active, admitted.expected, 'active scheduler version differs from the planned predecessor');
  try {
    const output = await wrangler(env, ['versions', 'upload', '--tag', `scheduler-${env.GITHUB_SHA.slice(0, 12)}`,
      '--message', `Scheduler ${env.GITHUB_SHA.slice(0, 12)} cycle run ${env.GITHUB_RUN_ID}`]);
    receipt.candidate = uploadedVersion(output); receipt.status = 'uploaded'; save(path, receipt);
    const version = await cf(`${API}/versions/${receipt.candidate}`, token);
    assert.equal(version.result?.id, receipt.candidate, 'candidate version readback mismatch');
    assertExactDispatchBindings({ success: true, result: { bindings: version.result?.resources?.bindings } },
      decl.vars, decl.secrets);
    assert.equal((await readLive(token)).active, receipt.previous, 'inactive upload changed the active Worker');
    await wrangler(env, ['versions', 'deploy', `${receipt.candidate}@100%`, '--yes',
      '--message', `Scheduler ${env.GITHUB_SHA.slice(0, 12)} declaration ${digest.slice(0, 12)}`]);
    receipt.status = 'activated'; save(path, receipt);
    await writeCrons(token, decl.crons);
    receipt.status = 'triggers-applied'; save(path, receipt);
    receipt.live = await verifyLive(token, decl, receipt.candidate, config.expectedTarget);
    receipt.status = 'passed'; receipt.completedAt = new Date().toISOString(); save(path, receipt);
    summary(summaryLines(report, digest, 'release passed'));
    return { status: 'passed', previous: receipt.previous, candidate: receipt.candidate, crons: receipt.live.crons };
  } catch (error) {
    receipt.status = 'failed'; receipt.failure = error.message.slice(0, 300); save(path, receipt);
    try { receipt.recovery = await recover(env, receipt); } catch { receipt.recovery = 'manual-inspection-required'; }
    save(path, receipt);
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`Scheduler Worker ${process.argv[2] ?? ''} refused: ${error.message}${error.cause?.message ? ` (${error.cause.message})` : ''}`);
    process.exitCode = 1;
  });
}
