#!/usr/bin/env node
// Public projection only. Never copy internal evidence, command output, or backup bytes.
import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKEND_STAGES } from './platform-staging-transaction.mjs';

const LIMIT = 2 * 1024 * 1024;
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const NUMBER = /^[1-9][0-9]{0,19}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FILES = Object.freeze(['dispatch.json', 'lease.json', 'stage-arguments.json', 'inventory-before.json',
  'plan.json', 'inventory-current.json', 'authorization.json', 'stage-intent.json', 'stage-intent.json.result.json']);
const check = value => { if (!value) throw new Error('invalid public summary evidence'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => check(object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','));
const match = (value, pattern) => check(typeof value === 'string' && pattern.test(value));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
function instant(value) {
  check(typeof value === 'string' && value.length === 24);
  const time = Date.parse(value);
  check(Number.isFinite(time) && new Date(time).toISOString() === value);
  return time;
}
function realDirectory(path) {
  check(typeof path === 'string' && resolve(path) === path);
  const stat = lstatSync(path);
  check(stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(path) === path);
}
function readEvidence(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    check(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(LIMIT));
    const allocation = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < allocation.length) {
      const count = readSync(fd, allocation, length, allocation.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd, { bigint: true });
    check(BigInt(length) === before.size && before.dev === after.dev && before.ino === after.ino
      && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs);
    const bytes = allocation.subarray(0, length);
    let value;
    try { value = JSON.parse(bytes); } catch { throw new Error('invalid public summary evidence'); }
    // Internal writers use precisely this representation. Reject duplicate keys, alternate
    // parser forms, lossy UTF-8 and partial documents without exposing parser diagnostics.
    check(bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)));
    return { bytes, value };
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function summaryContext(env) {
  match(env.GITHUB_SHA, SHA40); match(env.ATMOS_SHA, SHA40);
  match(env.GITHUB_RUN_ID, NUMBER); match(env.GITHUB_RUN_ATTEMPT, NUMBER);
  check(env.GITHUB_REPOSITORY === 'Andrewegao/v3t7kq-cycle' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch' && BACKEND_STAGES.includes(env.TRANSACTION_STAGE));
  return { cycleSha: env.GITHUB_SHA, candidateGitSha: env.ATMOS_SHA, runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT, stage: env.TRANSACTION_STAGE };
}
function validateEvidence(name, value, context) {
  const id = `gh-${context.runId}-${context.runAttempt}-${context.stage}`;
  const identity = () => check(value.schemaVersion === 1 && value.environment === 'staging'
    && value.candidateGitSha === context.candidateGitSha);
  if (name === 'dispatch.json') {
    exact(value, ['schemaVersion','environment','cycleControlSha','candidateGitSha','stage','authorizationId',
      'cloudflareAccountId','leaseMinutes','authorizationMinutes']); identity();
    check(value.cycleControlSha === context.cycleSha && value.stage === context.stage && value.authorizationId === id
      && value.cloudflareAccountId === 'a89f9a1af485021fbc60a68b163c7c6e'
      && value.leaseMinutes === 30 && value.authorizationMinutes === 10);
  } else if (name === 'stage-arguments.json') {
    if (context.stage === 'worker-rollback') {
      exact(value, ['targetVersionId','expectedCurrentVersionId']);
      match(value.targetVersionId, VERSION); match(value.expectedCurrentVersionId, VERSION);
      check(value.targetVersionId !== value.expectedCurrentVersionId);
    } else exact(value, []);
  } else if (name === 'lease.json') {
    exact(value, ['schemaVersion','environment','candidateGitSha','leaseId','holder','issuedAt','expiresAt']); identity();
    check(value.leaseId === id && value.holder === `github:Andrewegao/v3t7kq-cycle/actions/runs/${context.runId}/attempts/${context.runAttempt}`);
    check(instant(value.expiresAt) - instant(value.issuedAt) === 30 * 60_000);
  } else if (name.startsWith('inventory-')) {
    exact(value, ['schemaVersion','environment','candidateGitSha','capturedAt','resources','observed','fingerprint']); identity();
    instant(value.capturedAt); match(value.fingerprint, SHA256); check(object(value.resources));
    exact(value.observed, ['workerDeployment','pages','d1Info','pendingMigrations','r2Buckets','secretNames']);
  } else if (name === 'plan.json') {
    exact(value, ['schemaVersion','environment','candidateGitSha','sourceRoot','workDir','createdAt','leaseId',
      'expectedCurrentFingerprint','resources','stages','planSha256']); identity();
    instant(value.createdAt); check(value.leaseId === id && object(value.resources) && object(value.stages));
    match(value.expectedCurrentFingerprint, SHA256); match(value.planSha256, SHA256);
    check(value.planSha256 === digest({ ...value, planSha256: undefined }));
  } else if (name === 'authorization.json') {
    exact(value, ['schemaVersion','environment','candidateGitSha','planSha256','stage','authorizationId','leaseId',
      'expectedCurrentFingerprint','commandSha256','issuedAt','expiresAt','arguments']); identity();
    check(value.stage === context.stage && value.authorizationId === id && value.leaseId === id);
    for (const key of ['planSha256','expectedCurrentFingerprint','commandSha256']) match(value[key], SHA256);
    const duration = instant(value.expiresAt) - instant(value.issuedAt);
    check(duration > 0 && duration <= 10 * 60_000);
    validateEvidence('stage-arguments.json', value.arguments, context);
  } else {
    const result = name.endsWith('.result.json');
    exact(value, result ? ['event','schemaVersion','environment','candidateGitSha','planSha256','stage','remote',
      'leaseId','authorizationId','expectedCurrentFingerprint','startedAt','finishedAt','intentSha256','ok','commands',
      'artifacts','artifactValidation','executionFailure'] : ['event','schemaVersion','environment','candidateGitSha',
      'planSha256','stage','remote','leaseId','authorizationId','expectedCurrentFingerprint','commandSha256','startedAt']);
    identity(); check(value.event === (result ? 'stage-result-v1' : 'authorized-stage-intent-v1')
      && value.stage === context.stage && value.remote === true && value.leaseId === id && value.authorizationId === id);
    for (const key of ['planSha256','expectedCurrentFingerprint',result ? 'intentSha256' : 'commandSha256']) match(value[key], SHA256);
    instant(value.startedAt);
    if (result) {
      check(instant(value.finishedAt) >= instant(value.startedAt) && typeof value.ok === 'boolean');
      check(Array.isArray(value.commands) && value.commands.length <= 16 && Array.isArray(value.artifacts) && !value.artifacts.length);
      const commandCount = context.stage === 'configuration' ? 0 : context.stage === 'worker-deploy' ? 2 : 1;
      check(value.commands.length <= commandCount && (!value.ok || value.commands.length === commandCount));
      for (const command of value.commands) {
        exact(command, ['commandSha256','status','stdoutSha256','stderrSha256']);
        for (const key of ['commandSha256','stdoutSha256','stderrSha256']) match(command[key], SHA256);
        check(Number.isSafeInteger(command.status) && command.status >= 0 && command.status <= 255);
      }
      exact(value.artifactValidation, ['ok','error']); check(typeof value.artifactValidation.ok === 'boolean');
      check(value.artifactValidation.error === null || typeof value.artifactValidation.error === 'string');
      if (value.executionFailure !== null) {
        exact(value.executionFailure, ['phase','message']);
        check(value.executionFailure.phase === 'pre-command-authorization' && typeof value.executionFailure.message === 'string');
      }
      check(value.ok === (value.commands.every(row => row.status === 0)
        && value.artifactValidation.ok && value.executionFailure === null));
    }
  }
}
export function createPublicTransactionSummary({ inputDir, outputDir, environment }) {
  const context = summaryContext(environment);
  check(resolve(inputDir) === inputDir && resolve(outputDir) === outputDir && inputDir !== outputDir
    && !outputDir.startsWith(`${inputDir}/`) && !inputDir.startsWith(`${outputDir}/`));
  const evidence = {}, values = {};
  let sourceReady = false;
  try { realDirectory(inputDir); sourceReady = true; } catch { /* no raw diagnostics */ }
  for (const name of FILES) {
    let commitment;
    try {
      check(sourceReady);
      const { bytes, value } = readEvidence(resolve(inputDir, name));
      commitment = { bytes: bytes.length, sha256: hash(bytes) };
      validateEvidence(name, value, context); values[name] = value;
      evidence[name] = { status: 'validated', ...commitment };
    } catch (error) {
      evidence[name] = { status: sourceReady && error?.code === 'ENOENT' ? 'absent' : 'invalid', ...commitment };
    }
  }
  let bound = Object.keys(values).length === FILES.length;
  if (bound) {
    const plan = values['plan.json'], auth = values['authorization.json'], intent = values['stage-intent.json'];
    const result = values['stage-intent.json.result.json'];
    bound = [auth,intent,result].every(value => value.planSha256 === plan.planSha256)
      && [intent,result].every(value => value.expectedCurrentFingerprint === auth.expectedCurrentFingerprint)
      && intent.commandSha256 === auth.commandSha256 && result.intentSha256 === digest(intent)
      && result.startedAt === intent.startedAt
      && digest(auth.arguments) === digest(values['stage-arguments.json'])
      && plan.expectedCurrentFingerprint === values['inventory-before.json'].fingerprint
      && auth.expectedCurrentFingerprint === values['inventory-current.json'].fingerprint;
  }
  const result = values['stage-intent.json.result.json'];
  const intent = values['stage-intent.json'];
  const resultBound = Boolean(intent && result && result.intentSha256 === digest(intent)
    && result.planSha256 === intent.planSha256 && result.expectedCurrentFingerprint === intent.expectedCurrentFingerprint
    && result.startedAt === intent.startedAt);
  const summary = { schemaVersion: 1, kind: 'public-staging-transaction-summary', environment: 'staging', ...context,
    outcome: bound && result.ok ? 'reported-success' : 'reconciliation-required',
    reconciliationRequired: !(bound && result.ok), evidence,
    transaction: intent ? { authorizationId: intent.authorizationId, leaseId: intent.leaseId,
      planSha256: intent.planSha256, expectedCurrentFingerprint: intent.expectedCurrentFingerprint,
      intentSha256: digest(intent), startedAt: intent.startedAt, resultBound,
      finishedAt: resultBound ? result.finishedAt : null,
      reportedOk: resultBound ? result.ok : null, commands: resultBound ? result.commands.map(row => ({ ...row })) : null } : null };
  // Never reuse an output directory: stale/raw files cannot join an always() upload.
  realDirectory(resolve(outputDir, '..'));
  mkdirSync(outputDir, { mode: 0o700 });
  writeFileSync(resolve(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return summary;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    check(process.argv.length === 6 && process.argv[2] === '--input-dir' && process.argv[4] === '--output-dir');
    createPublicTransactionSummary({ inputDir: process.argv[3], outputDir: process.argv[5], environment: process.env });
    console.log('Public staging transaction summary created; reconcile any missing or incomplete result before proceeding.');
  } catch {
    console.error('Public staging transaction summary refused; no internal evidence was published. Reconciliation is required.');
    process.exitCode = 1;
  }
}
