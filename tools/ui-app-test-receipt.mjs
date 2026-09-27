// A same-attempt receipt for the complete staging app gate. Public metadata only;
// neither this output nor a successful test job grants publication authority.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileFor, publicLocaleBetaProfile } from './ui-staging-models.mjs';

export const APP_TEST_JOB = 'app-tests';
export const APP_TEST_STEP = 'full application test gate';
export const APP_TEST_COMMAND = 'npm test --prefix atmos/app';
const BETA = 'public-beta-ci-lab-road-security-v1';
const sha = value => assert.match(value ?? '', /^[a-f0-9]{40}$/);
const numeric = value => assert.match(value ?? '', /^[1-9][0-9]{0,19}$/);

export function appTestReceipt(context) {
  const { sourceSha, workflowSha, runId, attempt, selection } = context;
  sha(sourceSha); sha(workflowSha); numeric(runId); numeric(attempt);
  assert.equal(typeof selection, 'string');
  const profile = profileFor(selection);
  return { schemaVersion: 1, sourceSha, workflowSha, runId, attempt, profile,
    ciProfile: publicLocaleBetaProfile(profile) ? BETA : '', command: APP_TEST_COMMAND };
}

export function verifyAppTestReceipt(raw, jobs, context) {
  assert.equal(typeof raw, 'string', 'full app test receipt is missing');
  assert.ok(Buffer.byteLength(raw) > 0 && Buffer.byteLength(raw) <= 4096, 'invalid app test receipt size');
  const receipt = JSON.parse(raw);
  assert.deepEqual(receipt, appTestReceipt(context), 'app tests source/profile/run/attempt differs');
  const matches = jobs.filter(job => job.name === APP_TEST_JOB);
  assert.equal(matches.length, 1, 'one full app test job required');
  const job = matches[0];
  assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
  assert.equal(job.head_sha, context.workflowSha);
  assert.equal(String(job.run_id), context.runId);
  assert.equal(String(job.run_attempt), context.attempt);
  const steps = job.steps?.filter(step => step.name === APP_TEST_STEP) ?? [];
  assert.equal(steps.length, 1, 'complete app gate step required');
  assert.equal(steps[0].status, 'completed'); assert.equal(steps[0].conclusion, 'success');
  return receipt;
}

export function receiptForEnvironment(env, actualSourceSha, actualWorkflowSha) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.UI_BUILDS_ENABLED, 'true');
  assert.equal(actualWorkflowSha, env.GITHUB_SHA, 'test controller differs from workflow revision');
  assert.equal(env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_JOB, APP_TEST_JOB);
  assert.equal(actualSourceSha, env.ATMOS_SHA, 'tested checkout differs from requested source');
  const receipt = appTestReceipt({ sourceSha: env.ATMOS_SHA, workflowSha: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, selection: env.MODEL_SELECTION_SHA256 });
  assert.equal(env.WX_CI_PROFILE ?? '', receipt.ciProfile, 'app test profile differs');
  return receipt;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.deepEqual(process.argv.slice(2), ['emit']);
  const actual = execFileSync('git', ['-C', 'atmos', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const workflow = execFileSync('git', ['-C', 'cycle', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const receipt = receiptForEnvironment(process.env, actual, workflow);
  assert.ok(process.env.GITHUB_OUTPUT, 'job output path is required');
  appendFileSync(process.env.GITHUB_OUTPUT, `receipt=${JSON.stringify(receipt)}\n`);
}
