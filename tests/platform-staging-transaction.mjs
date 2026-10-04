import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { authorizationExpiry, BACKEND_STAGES, prepareTransaction, validateDispatch } from '../tools/platform-staging-transaction.mjs';
import { parseWorkflow, ROOT } from '../tools/workflow-inventory.mjs';
import { createPublicTransactionSummary } from '../tools/platform-staging-public-summary.mjs';

const sha = 'a'.repeat(40);
const cycleSha = 'b'.repeat(40);
const environment = (overrides = {}) => ({
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
  GITHUB_SHA: cycleSha,
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '2',
  ATMOS_SHA: sha,
  TRANSACTION_STAGE: 'migration',
  EXACT_CONFIRMATION: `RUN-STAGING:migration:${sha}`,
  PLATFORM_STAGING_TRANSACTIONS_ENABLED: 'true',
  PLATFORM_STAGING_CLOUDFLARE_ACCOUNT_ID: 'a89f9a1af485021fbc60a68b163c7c6e',
  PLATFORM_STAGING_TOKEN_PROVISIONED: 'true',
  ATMOS_SOURCE_KEY_PROVISIONED: 'true',
  ROLLBACK_TARGET_VERSION_ID: '',
  ROLLBACK_EXPECTED_CURRENT_VERSION_ID: '',
  ...overrides,
});

test('dispatch gate binds Cycle main, exact stage, candidate, account and protected scopes', () => {
  const admitted = validateDispatch(environment());
  assert.equal(admitted.stage, 'migration');
  assert.deepEqual(BACKEND_STAGES, ['configuration', 'migration', 'worker-deploy', 'worker-rollback']);
  for (const overrides of [
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_REF: 'refs/heads/topic' },
    { GITHUB_REPOSITORY: 'other/repo' },
    { GITHUB_SHA: 'main' },
    { ATMOS_SHA: 'master' },
    { TRANSACTION_STAGE: 'pages-deploy', EXACT_CONFIRMATION: `RUN-STAGING:pages-deploy:${sha}` },
    { EXACT_CONFIRMATION: `RUN-STAGING:backup:${sha}` },
    { PLATFORM_STAGING_TRANSACTIONS_ENABLED: 'false' },
    { PLATFORM_STAGING_CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32) },
    { PLATFORM_STAGING_TOKEN_PROVISIONED: 'false' },
    { ATMOS_SOURCE_KEY_PROVISIONED: 'false' },
  ]) assert.throws(() => validateDispatch(environment(overrides)));
});

test('rollback requires distinct exact version IDs and other stages reject rollback arguments', () => {
  const rollback = {
    TRANSACTION_STAGE: 'worker-rollback',
    EXACT_CONFIRMATION: `RUN-STAGING:worker-rollback:${sha}`,
    ROLLBACK_TARGET_VERSION_ID: 'last-good-v1',
    ROLLBACK_EXPECTED_CURRENT_VERSION_ID: 'candidate-v2',
  };
  assert.equal(validateDispatch(environment(rollback)).rollbackTargetVersionId, 'last-good-v1');
  assert.throws(() => validateDispatch(environment({ ...rollback, ROLLBACK_EXPECTED_CURRENT_VERSION_ID: 'last-good-v1' })));
  assert.throws(() => validateDispatch(environment({ ROLLBACK_TARGET_VERSION_ID: 'unexpected' })));
});

test('preparation creates exclusive lease, arguments and non-secret manifest', async t => {
  const root = join(tmpdir(), `weatherx-platform-staging-${process.pid}-${Date.now()}`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = new Date('2026-09-16T12:00:00.000Z');
  const result = prepareTransaction({ environment: environment(), outputDir: root, now });
  assert.equal(result.lease.expiresAt, '2026-09-16T12:30:00.000Z');
  assert.deepEqual(result.stageArguments, {});
  assert.equal(result.manifest.authorizationMinutes, 10);
  assert.equal(result.manifest.stage, 'migration');
  const bytes = await Promise.all(Object.values(result.paths).map(path => readFile(path, 'utf8')));
  assert.doesNotMatch(bytes.join(''), /API_TOKEN|PRIVATE KEY|secret value/i);
  assert.throws(() => prepareTransaction({ environment: environment(), outputDir: root, now }), /already exists/);
});

test('hosted backup rejects stale callers before creating any transaction files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'weatherx-backup-refusal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = join(root, 'transaction');
  const env = environment({ TRANSACTION_STAGE: 'backup', EXACT_CONFIRMATION: `RUN-STAGING:backup:${sha}` });
  assert.throws(() => prepareTransaction({ environment: env, outputDir }), /backups are disabled/);
  assert.equal(existsSync(outputDir), false);
  const run = spawnSync(process.execPath, [join(ROOT, 'tools/platform-staging-transaction.mjs'),
    'prepare', '--output-dir', outputDir], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(run.status, 1); assert.match(run.stderr, /backups are disabled/);
  assert.equal(existsSync(outputDir), false);
});

test('preparation preserves every remaining hosted stage and exact rollback arguments', async t => {
  const root = await mkdtemp(join(tmpdir(), 'weatherx-staging-controls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const stage of BACKEND_STAGES) {
    const rollback = stage === 'worker-rollback'
      ? { ROLLBACK_TARGET_VERSION_ID: 'last-good-v1', ROLLBACK_EXPECTED_CURRENT_VERSION_ID: 'candidate-v2' } : {};
    const result = prepareTransaction({ environment: environment({ TRANSACTION_STAGE: stage,
      EXACT_CONFIRMATION: `RUN-STAGING:${stage}:${sha}`, ...rollback }), outputDir: join(root, stage) });
    assert.equal(result.manifest.stage, stage);
    assert.deepEqual(result.stageArguments, stage === 'worker-rollback'
      ? { targetVersionId: 'last-good-v1', expectedCurrentVersionId: 'candidate-v2' } : {});
  }
});

test('authorization expiry is exactly ten minutes and safely below the packet maximum', () => {
  assert.equal(authorizationExpiry(new Date('2026-09-16T12:00:00.000Z')), '2026-09-16T12:10:00.000Z');
  assert.throws(() => authorizationExpiry(new Date('invalid')));
});

test('workflow is a protected manual main-only one-stage controller with scoped credentials', async () => {
  const path = '.github/workflows/platform-staging-transaction.yml';
  const source = await readFile(join(ROOT, path), 'utf8');
  const { data } = parseWorkflow(source, path);
  assert.deepEqual(Object.keys(data.on), ['workflow_dispatch']);
  assert.deepEqual(data.on.workflow_dispatch.inputs.stage.options, BACKEND_STAGES);
  assert.deepEqual(data.permissions, { contents: 'read' });
  assert.deepEqual(data.concurrency, { group: 'weatherx-platform-staging-transaction', 'cancel-in-progress': false });
  const job = data.jobs.transact;
  assert.equal(job.environment.name, 'platform-staging');
  assert.equal(job['timeout-minutes'], 30);
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(job.if, /github\.repository == 'Andrewegao\/v3t7kq-cycle'/);
  assert.equal(job.env, undefined);
  const named = Object.fromEntries(job.steps.filter(step => step.name).map(step => [step.name, step]));
  assert.equal(named['Checkout exact Atmos candidate'].with.ref, '${{ inputs.atmos_sha }}');
  assert.equal(named['Checkout exact Atmos candidate'].with['persist-credentials'], false);
  assert.match(named['Prove candidate is the current Atmos master and source is clean'].run, /origin\/master/);
  assert.match(named['Authorize the selected stage for ten minutes'].run, /authorization-expiry/);
  assert.match(named['Execute exactly one authorized backend staging stage'].run, /staging-rehearsal\.mjs run/);
  assert.equal((source.match(/staging-rehearsal\.mjs run/g) ?? []).length, 1);
  const credentialSteps = job.steps.filter(step => step.env?.CLOUDFLARE_API_TOKEN);
  assert.deepEqual(credentialSteps.map(step => step.name), [
    'Capture exact staging inventory for the plan',
    'Capture fresh expected-current staging state',
    'Execute exactly one authorized backend staging stage',
  ]);
  const projection = named['Project public staging transaction summary'];
  assert.equal(projection.id, 'public_summary');
  assert.equal(projection.if, '${{ always() }}');
  assert.match(projection.run, /platform-staging-public-summary\.mjs/);
  assert.match(projection.run, /--input-dir "\$RUNNER_TEMP\/platform-staging-transaction"/);
  assert.match(projection.run, /--output-dir "\$RUNNER_TEMP\/platform-staging-public"/);
  assert.equal(projection.env.CLOUDFLARE_API_TOKEN, undefined);
  const upload = named['Retain public staging transaction summary'];
  assert.equal(upload.if, "${{ always() && steps.public_summary.outcome == 'success' }}");
  assert.equal(upload.with.path, '${{ runner.temp }}/platform-staging-public/summary.json');
  assert.ok(job.steps.indexOf(projection) < job.steps.indexOf(upload));
  assert.match(upload.with.name, /github\.run_id.*github\.run_attempt/);
  assert.equal(upload.with.overwrite, undefined);
  assert.doesNotMatch(source, /weatherx-platform-edge-production|weatherx-platform-production|pages-deploy/);
});

const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => hash(JSON.stringify(canonical(value)));
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const privateText = 'SYNTHETIC_PRIVATE_TOKEN_DO_NOT_PUBLISH';
async function summaryFixture(t, stage = 'migration') {
  const temporary = await mkdtemp(join(tmpdir(), 'weatherx-public-summary-'));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const inputDir = join(root, 'internal'), outputDir = join(root, 'public');
  await mkdir(inputDir);
  const env = environment({ TRANSACTION_STAGE: stage, EXACT_CONFIRMATION: `RUN-STAGING:${stage}:${sha}` });
  const id = `gh-12345-2-${stage}`, now = '2026-09-16T12:00:00.000Z';
  const identity = { schemaVersion: 1, environment: 'staging', candidateGitSha: sha };
  const args = stage === 'worker-rollback' ? { targetVersionId: 'last-good-v1', expectedCurrentVersionId: 'candidate-v2' } : {};
  const fingerprint = 'c'.repeat(64), commandSha256 = 'd'.repeat(64);
  const inventory = { ...identity, capturedAt: now, resources: { privateText }, fingerprint,
    observed: { workerDeployment: {}, pages: {}, d1Info: { privateText }, pendingMigrations: privateText,
      r2Buckets: {}, secretNames: [privateText] } };
  const plan = { ...identity, sourceRoot: `/private/${privateText}`, workDir: `/private/work/${privateText}`,
    createdAt: now, leaseId: id, expectedCurrentFingerprint: fingerprint, resources: { privateText }, stages: { privateText } };
  plan.planSha256 = digest(plan);
  const auth = { ...identity, planSha256: plan.planSha256, stage, authorizationId: id, leaseId: id,
    expectedCurrentFingerprint: fingerprint, commandSha256, issuedAt: now, expiresAt: '2026-09-16T12:10:00.000Z', arguments: args };
  const intent = { event: 'authorized-stage-intent-v1', ...identity, planSha256: plan.planSha256, stage, remote: true,
    leaseId: id, authorizationId: id, expectedCurrentFingerprint: fingerprint, commandSha256, startedAt: now };
  const commands = Array.from({ length: stage === 'configuration' ? 0 : stage === 'worker-deploy' ? 2 : 1 }, () => ({
    commandSha256, status: 0, stdoutSha256: hash(privateText), stderrSha256: hash(privateText) }));
  const result = { event: 'stage-result-v1', ...identity, planSha256: plan.planSha256, stage, remote: true,
    leaseId: id, authorizationId: id, expectedCurrentFingerprint: fingerprint, startedAt: now,
    finishedAt: '2026-09-16T12:01:00.000Z', intentSha256: digest(intent), ok: true, commands,
    artifacts: [], artifactValidation: { ok: true, error: null }, executionFailure: null };
  const documents = {
    'dispatch.json': { ...identity, cycleControlSha: cycleSha, stage, authorizationId: id,
      cloudflareAccountId: 'a89f9a1af485021fbc60a68b163c7c6e', leaseMinutes: 30, authorizationMinutes: 10 },
    'lease.json': { ...identity, leaseId: id, holder: `github:Andrewegao/v3t7kq-cycle/actions/runs/12345/attempts/2`,
      issuedAt: now, expiresAt: '2026-09-16T12:30:00.000Z' },
    'stage-arguments.json': args, 'inventory-before.json': inventory, 'inventory-current.json': inventory,
    'plan.json': plan, 'authorization.json': auth, 'stage-intent.json': intent, 'stage-intent.json.result.json': result,
  };
  await Promise.all(Object.entries(documents).map(([name, value]) => writeFile(join(inputDir, name), json(value))));
  return { root, inputDir, outputDir, env, documents,
    project: () => createPublicTransactionSummary({ inputDir, outputDir, environment: env }) };
}

test('only generated metadata crosses the upload boundary despite SQL, secrets, source, logs and unknown files', async t => {
  const fixture = await summaryFixture(t);
  for (const path of ['d1-before.sql', 'partial-export.sql', 'unknown.json', 'source.js', 'stderr.log']) {
    await writeFile(join(fixture.inputDir, path), privateText);
  }
  await mkdir(join(fixture.inputDir, 'work'));
  await writeFile(join(fixture.inputDir, 'work', 'private.js'), privateText);
  await symlink(join(fixture.inputDir, 'd1-before.sql'), join(fixture.inputDir, 'unknown-link.json'));
  const before = await readFile(join(fixture.inputDir, 'plan.json'));
  const summary = fixture.project();
  assert.equal(summary.outcome, 'reported-success'); assert.equal(summary.reconciliationRequired, false);
  assert.deepEqual(await readdir(fixture.outputDir), ['summary.json']);
  const publicBytes = await readFile(join(fixture.outputDir, 'summary.json'), 'utf8');
  assert.doesNotMatch(publicBytes, new RegExp(privateText));
  assert.doesNotMatch(publicBytes, /d1-before|partial-export|source\.js|stderr\.log|unknown|\/private\//);
  assert.deepEqual(Object.keys(summary), ['schemaVersion','kind','environment','cycleSha','candidateGitSha','runId',
    'runAttempt','stage','outcome','reconciliationRequired','evidence','transaction']);
  for (const [name, value] of Object.entries(fixture.documents)) {
    assert.deepEqual(summary.evidence[name], { status: 'validated', bytes: Buffer.byteLength(json(value)), sha256: hash(json(value)) });
  }
  assert.deepEqual(await readFile(join(fixture.inputDir, 'plan.json')), before);
  assert.equal(summary.transaction.intentSha256, digest(fixture.documents['stage-intent.json']));
  assert.throws(fixture.project);
  assert.equal(await readFile(join(fixture.outputDir, 'summary.json'), 'utf8'), publicBytes);
});

test('all non-backup stages retain valid summaries and rollback argument constraints', async t => {
  for (const stage of BACKEND_STAGES) {
    const fixture = await summaryFixture(t, stage);
    assert.equal(fixture.project().outcome, 'reported-success');
  }
  for (const args of [{ targetVersionId: 'same', expectedCurrentVersionId: 'same' },
    { targetVersionId: privateText + '\n', expectedCurrentVersionId: 'valid' }, { extra: privateText }]) {
    const fixture = await summaryFixture(t, 'worker-rollback');
    await writeFile(join(fixture.inputDir, 'stage-arguments.json'), json(args));
    assert.equal(fixture.project().reconciliationRequired, true);
  }
});

test('authorization summaries allow process skew within the hosted ten-minute cap', async t => {
  for (const delayMs of [0, 1, 325]) {
    const fixture = await summaryFixture(t);
    const authorization = fixture.documents['authorization.json'];
    const intent = fixture.documents['stage-intent.json'];
    const result = fixture.documents['stage-intent.json.result.json'];
    authorization.expiresAt = authorizationExpiry(new Date(authorization.issuedAt));
    authorization.issuedAt = new Date(Date.parse(authorization.issuedAt) + delayMs).toISOString();
    intent.startedAt = new Date(Date.parse(authorization.issuedAt) + 575).toISOString();
    result.startedAt = intent.startedAt;
    result.intentSha256 = digest(intent);
    for (const name of ['authorization.json', 'stage-intent.json', 'stage-intent.json.result.json']) {
      await writeFile(join(fixture.inputDir, name), json(fixture.documents[name]));
    }
    const summary = fixture.project();
    assert.equal(summary.evidence['authorization.json'].status, 'validated', `process delay ${delayMs}ms`);
    assert.equal(summary.transaction.resultBound, true);
    assert.equal(summary.outcome, 'reported-success');
    assert.equal(summary.reconciliationRequired, false);
  }
});

test('invalid, expired and over-cap authorization times require reconciliation', async t => {
  for (const [issuedAt, expiresAt] of [
    ['2026-09-16T12:00:00.000Z', '2026-09-16T12:00:00.000Z'],
    ['2026-09-16T12:00:00.000Z', '2026-09-16T11:59:59.999Z'],
    ['2026-09-16T12:00:00.000Z', '2026-09-16T12:10:00.001Z'],
    ['2026-02-30T12:00:00.000Z', '2026-09-16T12:10:00.000Z'],
    ['2026-09-16T12:00:00.000Z', '2026-02-30T12:10:00.000Z'],
    ['2026-09-16T12:00:00Z', '2026-09-16T12:10:00.000Z'],
    ['2026-09-16T12:00:00.000Z', '2026-09-16T12:10:00Z'],
  ]) {
    const fixture = await summaryFixture(t);
    await writeFile(join(fixture.inputDir, 'authorization.json'), json({
      ...fixture.documents['authorization.json'], issuedAt, expiresAt,
    }));
    const summary = fixture.project();
    assert.equal(summary.evidence['authorization.json'].status, 'invalid', `${issuedAt} -> ${expiresAt}`);
    assert.equal(summary.reconciliationRequired, true);
    assert.equal(summary.outcome, 'reconciliation-required');
    assert.equal(summary.transaction.resultBound, true);
  }
});

test('missing, partial, mismatched and failed results require reconciliation without raw failure details', async t => {
  for (const mode of ['absent','partial','mismatch','failed','invalid-status','invalid-time','extra-command-field']) {
    const fixture = await summaryFixture(t);
    const path = join(fixture.inputDir, 'stage-intent.json.result.json');
    const result = fixture.documents['stage-intent.json.result.json'];
    if (mode === 'absent') await rm(path);
    else if (mode === 'partial') await writeFile(path, `{"error":"${privateText}`);
    else {
      if (mode === 'mismatch') result.intentSha256 = 'e'.repeat(64);
      if (mode === 'failed') { result.ok = false; result.commands[0].status = 1; result.artifactValidation = { ok: false, error: privateText }; }
      if (mode === 'invalid-status') result.commands[0].status = privateText;
      if (mode === 'invalid-time') result.finishedAt = privateText;
      if (mode === 'extra-command-field') result.commands[0].stderr = privateText;
      await writeFile(path, json(result));
    }
    const summary = fixture.project();
    assert.equal(summary.reconciliationRequired, true, mode); assert.equal(summary.outcome, 'reconciliation-required');
    assert.equal(summary.transaction.intentSha256, digest(fixture.documents['stage-intent.json']));
    if (mode !== 'failed') { assert.equal(summary.transaction.resultBound, false); assert.equal(summary.transaction.reportedOk, null); }
    else { assert.equal(summary.transaction.resultBound, true); assert.equal(summary.transaction.reportedOk, false); }
    assert.doesNotMatch(await readFile(join(fixture.outputDir, 'summary.json'), 'utf8'), new RegExp(privateText));
  }
});

test('known symlinks, hard links, directories, oversized and alternate JSON forms cannot become trusted evidence', async t => {
  for (const mode of ['symlink','hardlink','directory','oversized','duplicate','compact','trailing','invalid-utf8']) {
    const fixture = await summaryFixture(t);
    const path = join(fixture.inputDir, 'dispatch.json');
    if (mode === 'symlink') { await rm(path); await symlink(join(fixture.inputDir, 'plan.json'), path); }
    if (mode === 'hardlink') await link(path, join(fixture.inputDir, 'linked-dispatch.json'));
    if (mode === 'directory') { await rm(path); await mkdir(path); }
    if (mode === 'oversized') await writeFile(path, 'x'.repeat(2 * 1024 * 1024 + 1));
    if (mode === 'duplicate') await writeFile(path, json(fixture.documents['dispatch.json']).replace('"schemaVersion": 1,', '"schemaVersion": 0,\n  "schemaVersion": 1,'));
    if (mode === 'compact') await writeFile(path, JSON.stringify(fixture.documents['dispatch.json']));
    if (mode === 'trailing') await writeFile(path, json(fixture.documents['dispatch.json']) + privateText);
    if (mode === 'invalid-utf8') await writeFile(path, Buffer.from([0xff, 0xfe]));
    const summary = fixture.project();
    assert.equal(summary.evidence['dispatch.json'].status, 'invalid', mode); assert.equal(summary.reconciliationRequired, true);
  }
});

test('missing input and existing or symlinked output never publish stale internal bytes', async t => {
  const fixture = await summaryFixture(t);
  await rm(fixture.inputDir, { recursive: true });
  assert.equal(fixture.project().reconciliationRequired, true);
  assert.deepEqual(await readdir(fixture.outputDir), ['summary.json']);
  const other = await summaryFixture(t);
  await mkdir(other.outputDir); await writeFile(join(other.outputDir, 'summary.json'), privateText);
  assert.throws(other.project);
  assert.equal(await readFile(join(other.outputDir, 'summary.json'), 'utf8'), privateText);
  const linked = await summaryFixture(t);
  await symlink(linked.inputDir, linked.outputDir);
  assert.throws(linked.project);
});

test('CLI parser and JSON failures use fixed messages without private parser strings', async t => {
  const fixture = await summaryFixture(t);
  const command = join(ROOT, 'tools/platform-staging-public-summary.mjs');
  for (const args of [[privateText], ['--output-dir', fixture.outputDir, '--input-dir', fixture.inputDir],
    ['--input-dir', fixture.inputDir, '--output-dir', fixture.outputDir, privateText]]) {
    const result = spawnSync(process.execPath, [command, ...args], { env: fixture.env, encoding: 'utf8' });
    assert.equal(result.status, 1); assert.doesNotMatch(result.stderr, new RegExp(privateText));
    assert.equal(result.stderr.trim(), 'Public staging transaction summary refused; no internal evidence was published. Reconciliation is required.');
  }
});
