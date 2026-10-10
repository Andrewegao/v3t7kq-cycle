#!/usr/bin/env node
// Exact-source WeatherX Road (road.weatherx.org) release, split by credential:
//   build    atmos-source-read-ui: builds the public Road shell and its precompiled Pages Functions
//            exactly as Atmos ops/platform/deploy-road-shell.sh does; holds only a public key
//   transfer ui-staging: decrypts, re-validates and reseals the exact bytes; no Cloudflare credential
//   restore  ui-production: unseals and restores the exact bytes; candidate source is never executed
//   confirm  ui-production: binds Atmos guard-pages-deploy.sh's success receipt to this candidate
// The Pages deploy, last-good rollback and release fuse remain owned by the pinned Atmos guard.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants, createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  privateDecrypt, publicEncrypt, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gate, MAX_BYTES, PROFILE, readTree, validateFiles } from './ui-candidate.mjs';

export const PROJECT = 'weatherx-road';
export const ORIGIN = 'https://road.weatherx.org';
const REPOSITORY = 'Andrewegao/v3t7kq-cycle';
const WORKFLOW = `${REPOSITORY}/.github/workflows/road-production-release.yml@refs/heads/main`;
const SHA = /^[a-f0-9]{40}$/;
const ID = /^[1-9][0-9]{0,19}$/;
const BUILD_MAGIC = Buffer.from('WXRB1\0');
const CANDIDATE_MAGIC = Buffer.from('WXRC1\0');
const FUNCTIONS_COMPATIBILITY_DATE = '2026-06-23';
export const ROAD_RECEIPT_PROFILE = Object.freeze({ product: 'road', platformAccount: '0', platformDataAuth: 'public' });
// Exactly the variables Atmos deploy-road-shell.sh sets for the build, plus the ground package
// scope the Atmos preview/staging lanes use (the retained package is approved only for build lanes).
export const ROAD_BUILD_ENV = Object.freeze({ ATMOS_CODE_ONLY_BUILD: '1', ATMOS_ROAD_PUBLIC_RELEASE: '1',
  VITE_PRODUCT: 'road', VITE_APP: 'road', VITE_PLATFORM_ACCOUNT: '0', VITE_PLATFORM_DATA_AUTH: 'public',
  WX_GROUND_QUALIFICATION_SCOPE: 'staging-qualification-only' });
// deploy-road-shell.sh exports these for the receipt and for the guard's receipt re-verification.
export const ROAD_RECEIPT_ENV = Object.freeze({ VITE_PRODUCT: 'road', VITE_PLATFORM_ACCOUNT: '0',
  VITE_PLATFORM_DATA_AUTH: 'public' });
const FORBIDDEN_BUILD_CREDENTIALS = ['CLOUDFLARE_API_TOKEN', 'UI_BUILD_PRIVATE_KEY', 'UI_CANDIDATE_KEY',
  'UI_PRODUCTION_PAGES_TOKEN', 'UI_STAGING_PAGES_TOKEN', 'CLOUDFLARE_WORKERS_API_TOKEN', 'CLOUDFLARE_DATA_EDGE_API_TOKEN'];
const hash = value => createHash('sha256').update(value).digest('hex');

export function confirmation(sha) {
  assert.match(sha ?? '', SHA, 'exact 40-character Atmos SHA required');
  return `RELEASE-ROAD:${sha}`;
}

function admitted(env, job) {
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: WORKFLOW,
    GITHUB_JOB: job })) assert.equal(env[key], expected, `${key} changed`);
  assert.equal(env.CONFIRM, confirmation(env.ATMOS_SHA), 'confirmation does not bind this source');
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] ?? '', ID, `${key} invalid`);
  assert.match(env.GITHUB_SHA ?? '', SHA);
  assert.match(env.RUNNER_TEMP ?? '', /^\//);
  return { sha: env.ATMOS_SHA, runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, workflowSha: env.GITHUB_SHA };
}

function rsaKey(pem, privatePart) {
  assert.ok(typeof pem === 'string' && pem.includes(privatePart ? 'BEGIN PRIVATE KEY' : 'BEGIN PUBLIC KEY'),
    'missing build transport key');
  const key = privatePart ? createPrivateKey(pem) : createPublicKey(pem);
  assert.equal(key.asymmetricKeyType, 'rsa');
  assert.ok(key.asymmetricKeyDetails.modulusLength >= 3072 && key.asymmetricKeyDetails.modulusLength <= 4096);
  return key;
}
function candidateKey(hex) {
  assert.ok(typeof hex === 'string' && /^[a-f0-9]{64}$/.test(hex), 'UI_CANDIDATE_KEY must be a 32-byte hex key');
  return Buffer.from(hex, 'hex');
}

// Road envelopes use their own magic and authenticated data, so a Road blob can never be read as a
// Lab UI build or candidate (WXUB1/WXUI1) and the reverse.
export function packBuild(envelope, publicKey) {
  validateEnvelope(envelope);
  const secret = randomBytes(32), iv = randomBytes(12);
  const wrapped = publicEncrypt({ key: rsaKey(publicKey, false), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, secret);
  const prefix = Buffer.alloc(8); BUILD_MAGIC.copy(prefix); prefix.writeUInt16BE(wrapped.length, 6);
  const aad = Buffer.concat([prefix, wrapped]), cipher = createCipheriv('aes-256-gcm', secret, iv); cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(JSON.stringify(envelope)), cipher.final()]);
  assert.ok(body.length <= MAX_BYTES * 2, 'Road build exceeds transport limit');
  return Buffer.concat([aad, iv, cipher.getAuthTag(), body]);
}
export function unpackBuild(blob, privateKey) {
  assert.ok(blob.length > 420 && blob.length <= MAX_BYTES * 2 + 1024, 'invalid Road build size');
  assert.ok(blob.subarray(0, 6).equals(BUILD_MAGIC), 'not a Road build envelope');
  const length = blob.readUInt16BE(6); assert.ok(length === 384 || length === 512);
  const start = 8 + length; assert.ok(blob.length > start + 28);
  const secret = privateDecrypt({ key: rsaKey(privateKey, true), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    blob.subarray(8, start));
  assert.equal(secret.length, 32);
  const decipher = createDecipheriv('aes-256-gcm', secret, blob.subarray(start, start + 12));
  decipher.setAAD(blob.subarray(0, start)); decipher.setAuthTag(blob.subarray(start + 12, start + 28));
  return validateEnvelope(JSON.parse(Buffer.concat([decipher.update(blob.subarray(start + 28)), decipher.final()])));
}
export function seal(envelope, hex) {
  validateEnvelope(envelope);
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', candidateKey(hex), iv);
  cipher.setAAD(CANDIDATE_MAGIC);
  const body = Buffer.concat([cipher.update(JSON.stringify(envelope)), cipher.final()]);
  return Buffer.concat([CANDIDATE_MAGIC, iv, cipher.getAuthTag(), body]);
}
export function unseal(bytes, hex) {
  assert.ok(bytes.length > 34 && bytes.length <= MAX_BYTES * 2 + 1024, 'invalid Road candidate size');
  assert.ok(bytes.subarray(0, 6).equals(CANDIDATE_MAGIC), 'not a Road candidate envelope');
  const decipher = createDecipheriv('aes-256-gcm', candidateKey(hex), bytes.subarray(6, 18));
  decipher.setAAD(CANDIDATE_MAGIC); decipher.setAuthTag(bytes.subarray(18, 34));
  return validateEnvelope(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(34)), decipher.final()])));
}

function file(files, path) {
  const row = files.find(entry => entry.path === path);
  assert.ok(row, `missing ${path}`);
  return Buffer.from(row.base64, 'base64');
}

export function validateRoadReceipt(receipt, { sourceSha, runId, indexSha256 }) {
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt.gitSha, sourceSha, 'receipt source differs');
  assert.equal(String(receipt.workflowRunId), runId, 'receipt run differs');
  assert.equal(receipt.releaseId, `git-${sourceSha.slice(0, 12)}-run-${runId}`);
  assert.equal(receipt.indexSha256, indexSha256, 'receipt index digest differs');
  assert.match(receipt.shellSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(receipt.buildProfile, ROAD_RECEIPT_PROFILE, 'not a public account-off Road receipt');
  return receipt;
}

export function validateEnvelope(envelope) {
  assert.equal(envelope?.schemaVersion, 1);
  assert.equal(envelope.kind, 'weatherx-road-release');
  assert.equal(envelope.project, PROJECT);
  for (const key of ['sourceSha', 'workflowSha', 'liveSourceSha']) assert.match(envelope[key] ?? '', SHA, `${key} invalid`);
  for (const key of ['runId', 'attempt']) assert.match(envelope[key] ?? '', ID, `${key} invalid`);
  const { digest } = validateFiles(envelope.files, PROFILE);
  assert.equal(digest, envelope.artifactDigest, 'Road inventory digest differs');
  const routes = JSON.parse(file(envelope.files, '_routes.json'));
  assert.equal(routes?.version, 1); assert.deepEqual(routes.include, ['/*'], 'Road routes must be the reviewed Road routes');
  for (const forbidden of ['data/', 'data-atmos/']) assert.ok(!envelope.files.some(entry => entry.path.startsWith(forbidden)),
    `${forbidden} leaked into the Road shell`);
  validateRoadReceipt(JSON.parse(file(envelope.files, 'health/release.json')), { sourceSha: envelope.sourceSha,
    runId: envelope.runId, indexSha256: hash(file(envelope.files, 'index.html')) });
  return envelope;
}

export function bindRun(envelope, context) {
  for (const key of ['sourceSha', 'runId', 'attempt', 'workflowSha'])
    assert.equal(envelope[key], context[key === 'sourceSha' ? 'sha' : key], `Road ${key} differs from this run`);
  return envelope;
}

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

function run(command, args, options) { execFileSync(command, args, { stdio: 'inherit', ...options }); }

export function buildEnvironment(base, extra) {
  // A clean environment: no inherited VITE_/ATMOS_ flag may change the Road build.
  return { PATH: base.PATH, HOME: base.HOME, CI: 'true', GITHUB_RUN_ID: base.GITHUB_RUN_ID, ...extra };
}

async function liveRoadSource() {
  const response = await fetch(`${ORIGIN}/health/release.json?road_release=${Date.now()}`,
    { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200, `live Road receipt returned HTTP ${response.status}`);
  const value = await response.json();
  assert.match(value?.gitSha ?? '', SHA, 'live Road receipt has no source');
  return value.gitSha;
}

function sourceIdentity(atmos, sha) {
  assert.equal(git(atmos, ['rev-parse', 'HEAD']), sha, 'Atmos checkout differs');
  git(atmos, ['diff', '--exit-code', 'HEAD']);
  git(atmos, ['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/master']);
}

export function installPagesWorker(workerOut, dist) {
  assert.deepEqual(readdirSync(workerOut), ['index.js'], 'Pages Functions build emitted unexpected modules');
  const source = readFileSync(resolve(workerOut, 'index.js'));
  assert.ok(source.length > 0, 'Pages Functions build emitted an empty Worker');
  assert.doesNotMatch(source.subarray(0, 1024).toString('utf8'), /Content-Disposition:\s*form-data/i,
    'Pages Functions build emitted a multipart upload bundle instead of JavaScript');
  const probe = resolve(workerOut, 'syntax-probe.mjs');
  writeFileSync(probe, source, { flag: 'wx', mode: 0o600 });
  try { run(process.execPath, ['--check', probe]); } finally { unlinkSync(probe); }
  writeFileSync(resolve(dist, '_worker.js'), source, { flag: 'wx', mode: 0o600 });
}

async function build(env) {
  const ctx = admitted(env, 'build');
  assert.equal(env.UI_BUILDS_ENABLED, 'true', 'isolated builds are not enabled');
  for (const key of FORBIDDEN_BUILD_CREDENTIALS) assert.equal(env[key], undefined, `${key} is forbidden in the build`);
  const atmos = resolve(env.ATMOS_ROOT), app = resolve(atmos, 'app');
  sourceIdentity(atmos, ctx.sha);
  // Never move production behind the source road.weatherx.org already serves.
  const live = await liveRoadSource();
  git(atmos, ['merge-base', '--is-ancestor', live, ctx.sha]);
  assert.match(readFileSync(resolve(app, 'wrangler.toml'), 'utf8'), new RegExp(`^compatibility_date = "${FUNCTIONS_COMPATIBILITY_DATE}"$`, 'm'),
    'Road Functions compatibility date changed; review the release controller');
  const temp = resolve(env.RUNNER_TEMP, 'road-release'); mkdirSync(temp, { mode: 0o700 });
  const shell = resolve(temp, 'public-shell');
  run('rsync', ['-a', '--exclude', '/data/', '--exclude', '/data-atmos/', `${resolve(app, 'public')}/`, `${shell}/`]);
  const dist = resolve(app, 'dist');
  assert.equal(existsSync(dist), false, 'stale Road dist');
  run('npm', ['run', 'build'], { cwd: app, env: buildEnvironment(env, { ...ROAD_BUILD_ENV,
    ATMOS_PUBLIC_SHELL_DIR: shell, NODE_OPTIONS: '--max-old-space-size=4096' }) });
  for (const leaked of ['data', 'data-atmos']) assert.equal(existsSync(resolve(dist, leaked)), false, `${leaked} archive leaked into Road shell`);
  assert.equal(existsSync(resolve(dist, '_worker.js')), false, 'build emitted an unreviewed Worker');
  // Compile Functions once here; production uploads these exact bytes and never rebuilds them.
  const workerOut = resolve(temp, 'pages-worker'); mkdirSync(workerOut, { mode: 0o700 });
  run(resolve(atmos, 'platform/edge/node_modules/.bin/wrangler'), ['pages', 'functions', 'build', resolve(app, 'functions'),
    '--project-directory', app, '--outdir', workerOut, '--compatibility-date', FUNCTIONS_COMPATIBILITY_DATE,
    '--minify', '--sourcemap=false'], { cwd: app, env: buildEnvironment(env, { NO_COLOR: '1' }) });
  installPagesWorker(workerOut, dist);
  writeFileSync(resolve(dist, '_routes.json'), readFileSync(resolve(app, 'pages-routes.road.json')), { mode: 0o600 });
  run(process.execPath, [resolve(atmos, 'ops/release/build-release-receipt.mjs'), dist, resolve(dist, 'health/release.json')],
    { env: buildEnvironment(env, ROAD_RECEIPT_ENV), stdio: ['ignore', 'ignore', 'inherit'] });
  const files = readTree(dist, PROFILE);
  const envelope = validateEnvelope({ schemaVersion: 1, kind: 'weatherx-road-release', project: PROJECT,
    sourceSha: ctx.sha, liveSourceSha: live, runId: ctx.runId, attempt: ctx.attempt, workflowSha: ctx.workflowSha,
    artifactDigest: validateFiles(files, PROFILE).digest, files });
  const out = resolve(env.RUNNER_TEMP, 'road-build'); mkdirSync(out, { mode: 0o700 });
  writeFileSync(resolve(out, 'build.wxrb'), packBuild(envelope, env.UI_BUILD_PUBLIC_KEY), { flag: 'wx', mode: 0o600 });
  return { status: 'built', sourceSha: ctx.sha, liveSourceSha: live, artifactDigest: envelope.artifactDigest,
    files: files.length, bytes: files.reduce((sum, row) => sum + row.bytes, 0) };
}

function onlyFile(dir, name) {
  assert.deepEqual(readdirSync(dir), [name], `expected exactly ${name}`);
  const path = resolve(dir, name), stat = lstatSync(path);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES * 2 + 1024);
  return readFileSync(path);
}

function transfer(env) {
  const ctx = admitted(env, 'transfer');
  for (const key of FORBIDDEN_BUILD_CREDENTIALS.filter(key => key !== 'UI_BUILD_PRIVATE_KEY' && key !== 'UI_CANDIDATE_KEY'))
    assert.equal(env[key], undefined, `${key} is forbidden in the transfer`);
  const envelope = bindRun(unpackBuild(onlyFile(resolve(env.RUNNER_TEMP, 'road-build-download'), 'build.wxrb'),
    env.UI_BUILD_PRIVATE_KEY), ctx);
  const out = resolve(env.RUNNER_TEMP, 'road-candidate'); mkdirSync(out, { mode: 0o700 });
  writeFileSync(resolve(out, 'candidate.wxrc'), seal(envelope, env.UI_CANDIDATE_KEY), { flag: 'wx', mode: 0o600 });
  return { status: 'sealed', sourceSha: ctx.sha, artifactDigest: envelope.artifactDigest };
}

async function restore(env) {
  const ctx = admitted(env, 'release');
  gate(env);
  for (const key of ['CLOUDFLARE_API_TOKEN', 'UI_PRODUCTION_PAGES_TOKEN', 'UI_BUILD_PRIVATE_KEY'])
    assert.equal(env[key], undefined, `${key} is forbidden while restoring`);
  sourceIdentity(resolve(env.ATMOS_ROOT), ctx.sha);
  const envelope = bindRun(unseal(onlyFile(resolve(env.RUNNER_TEMP, 'road-candidate-download'), 'candidate.wxrc'),
    env.UI_CANDIDATE_KEY), ctx);
  // Refuse if another publisher changed road.weatherx.org since the build checked its source.
  assert.equal(await liveRoadSource(), envelope.liveSourceSha, 'road.weatherx.org changed since this build');
  const dist = resolve(env.RUNNER_TEMP, 'road-dist');
  assert.ok(lstatSync(dirname(dist)).isDirectory()); mkdirSync(dist, { mode: 0o700 });
  for (const row of envelope.files) {
    const full = resolve(dist, row.path);
    mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
    writeFileSync(full, Buffer.from(row.base64, 'base64'), { flag: 'wx', mode: 0o600 });
  }
  assert.equal(validateFiles(readTree(dist, PROFILE), PROFILE).digest, envelope.artifactDigest, 'restored bytes differ');
  const receipt = JSON.parse(readFileSync(resolve(dist, 'health/release.json')));
  writeFileSync(resolve(env.RUNNER_TEMP, 'road-release-expected.json'), `${JSON.stringify({ sourceSha: ctx.sha,
    releaseId: receipt.releaseId, indexSha256: receipt.indexSha256, artifactDigest: envelope.artifactDigest,
    liveSourceSha: envelope.liveSourceSha })}\n`, { flag: 'wx', mode: 0o600 });
  return { status: 'restored', sourceSha: ctx.sha, releaseId: receipt.releaseId, artifactDigest: envelope.artifactDigest };
}

export function validateGuardSuccess(success, expected) {
  assert.equal(success?.schemaVersion, 1);
  assert.equal(success.project, PROJECT);
  for (const key of ['sourceSha', 'releaseId', 'indexSha256']) assert.equal(success[key], expected[key], `guard ${key} differs`);
  for (const key of ['previousDeploymentId', 'candidateDeploymentId'])
    assert.match(success[key] ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, `guard ${key} invalid`);
  assert.notEqual(success.previousDeploymentId, success.candidateDeploymentId);
  return success;
}

function confirm(env) {
  const ctx = admitted(env, 'release');
  const expected = JSON.parse(readFileSync(resolve(env.RUNNER_TEMP, 'road-release-expected.json')));
  assert.equal(expected.sourceSha, ctx.sha);
  const success = validateGuardSuccess(JSON.parse(readFileSync(resolve(env.RUNNER_TEMP, 'road-release-receipts/guard-success.json'))), expected);
  assert.equal(validateFiles(readTree(resolve(env.RUNNER_TEMP, 'road-dist'), PROFILE), PROFILE).digest, expected.artifactDigest,
    'deployment modified the candidate');
  const receipt = { schemaVersion: 1, kind: 'weatherx-road-production-release', project: PROJECT, ...expected,
    controllerSha: ctx.workflowSha, runId: ctx.runId, attempt: ctx.attempt,
    previousDeploymentId: success.previousDeploymentId, candidateDeploymentId: success.candidateDeploymentId, status: 'passed' };
  writeFileSync(resolve(env.RUNNER_TEMP, 'road-release-receipts/release.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, ['## Road production release passed', '',
    `- Atmos source: \`${ctx.sha}\` (was \`${expected.liveSourceSha}\`)`, `- Release: \`${expected.releaseId}\``,
    `- Pages deployment: \`${success.candidateDeploymentId}\` (previous \`${success.previousDeploymentId}\`)`, ''].join('\n'), { flag: 'a' });
  return { status: 'passed', candidateDeploymentId: success.candidateDeploymentId };
}

// Read-only: records the Road project's stored production config by name. The upload runs from an
// empty directory like the Lab release, so it neither reads app/wrangler.toml nor changes this config.
export function projectSummary(project) {
  assert.equal(project?.name, PROJECT, 'unexpected Pages project');
  const production = project.deployment_configs?.production ?? {};
  const names = value => Object.keys(value ?? {}).sort();
  assert.match(production.compatibility_date ?? '', /^\d{4}-\d{2}-\d{2}$/, 'Road production config has no compatibility date');
  return { compatibilityDate: production.compatibility_date, compatibilityFlags: [...(production.compatibility_flags ?? [])].sort(),
    environmentVariables: names(production.env_vars), d1: names(production.d1_databases), kv: names(production.kv_namespaces),
    r2: names(production.r2_buckets), analyticsEngine: names(production.analytics_engine_datasets),
    services: names(production.services), productionBranch: project.production_branch ?? null,
    gitProductionDeploymentsEnabled: project.source?.config?.production_deployments_enabled === true };
}

async function project(env) {
  admitted(env, 'release');
  assert.ok(env.CLOUDFLARE_API_TOKEN, 'Pages token required');
  assert.match(env.CLOUDFLARE_ACCOUNT_ID ?? '', /^[a-f0-9]{32}$/);
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${PROJECT}`,
    { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } });
  assert.equal(response.status, 200, `Pages project read returned HTTP ${response.status}`);
  const payload = await response.json();
  assert.equal(payload?.success, true, 'Pages project read rejected');
  const summary = projectSummary(payload.result);
  assert.equal(summary.productionBranch, 'main', 'Road production branch is not main');
  assert.equal(summary.gitProductionDeploymentsEnabled, false, 'Git-triggered production deploys can bypass the guard');
  const out = resolve(env.RUNNER_TEMP, 'road-release-receipts'); mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(resolve(out, 'project-before.json'), `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { status: 'recorded', ...summary };
}

export async function main(command, env = process.env) {
  if (command === 'project') return project(env);
  if (command === 'build') return build(env);
  if (command === 'transfer') return transfer(env);
  if (command === 'restore') return restore(env);
  if (command === 'confirm') return confirm(env);
  throw Error('unknown Road release command');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv[2]).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(`Road release ${process.argv[2] ?? ''} refused: ${error.message}`);
    process.exitCode = 1;
  });
}
