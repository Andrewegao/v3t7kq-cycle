// A same-attempt receipt for the staging app-test evidence. Public metadata only;
// neither this output nor a successful test job grants publication authority.
//
// Two evidence paths exist (owner decision B, 2026-10-05):
//   atmos-ci   Atmos's own `ci` workflow already ran the complete suite for this exact
//              source SHA (verified read-only through the GitHub API, before any
//              candidate code runs here), plus a shorter local gate in this trust domain.
//   full-local The complete `npm test` suite runs here, exactly as before. This is the
//              fallback whenever the read token is absent or the evidence is not proven,
//              so misconfiguration can never make the pipeline weaker.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { profileFor, publicLocaleBetaProfile } from './ui-staging-models.mjs';

export const APP_TEST_JOB = 'app-tests';
export const APP_TEST_STEP = 'full application test gate';
export const APP_TEST_COMMAND = 'npm test --prefix atmos/app';
export const EVIDENCE_STEP = 'verify Atmos CI evidence for the exact source';
export const LOCAL_GATE_STEP = 'local certification and visual gate';
export const LOCAL_GATE_COMMANDS = Object.freeze(['npm run test:certify --prefix atmos/app', 'npx playwright test']);
export const ATMOS_REPOSITORY = 'weatherx-hq/atmos';
export const ATMOS_CI_WORKFLOW = '.github/workflows/ci.yml';
export const ATMOS_CI_VERDICT_JOB = 'ci-verdict';
export const ATMOS_API_MAX_BYTES = 2 * 1024 * 1024;
const BETA = 'public-beta-ci-lab-road-security-v1';
const PATHS = ['atmos-ci', 'full-local'];
const sha = value => assert.match(value ?? '', /^[a-f0-9]{40}$/);
const numeric = value => assert.match(value ?? '', /^[1-9][0-9]{0,19}$/);

export function appTestEvidence({ path, runId, attempt } = {}) {
  assert.ok(PATHS.includes(path), 'unknown app test evidence path');
  if (path === 'full-local') {
    assert.ok(!runId && !attempt, 'full-local evidence cannot name an Atmos run');
    return { path, commands: [APP_TEST_COMMAND] };
  }
  numeric(runId); numeric(attempt);
  return { path, repository: ATMOS_REPOSITORY, workflow: ATMOS_CI_WORKFLOW, job: ATMOS_CI_VERDICT_JOB,
    runId, attempt, commands: [...LOCAL_GATE_COMMANDS] };
}

// Job outputs written by the evidence step, which runs before any candidate code.
export function appTestEvidenceFromEnvironment(env) {
  return appTestEvidence({ path: env.UI_APP_TEST_EVIDENCE_PATH,
    runId: env.UI_APP_TEST_ATMOS_RUN_ID || undefined, attempt: env.UI_APP_TEST_ATMOS_RUN_ATTEMPT || undefined });
}

export function appTestReceipt(context) {
  const { sourceSha, workflowSha, runId, attempt, selection } = context;
  sha(sourceSha); sha(workflowSha); numeric(runId); numeric(attempt);
  assert.equal(typeof selection, 'string');
  const profile = profileFor(selection);
  const ciProfile = publicLocaleBetaProfile(profile) ? BETA : '';
  const evidence = appTestEvidence(context.evidence);
  assert.ok(evidence.path === 'full-local' || atmosEvidenceEligible(ciProfile), 'CI profile requires the complete local suite');
  return { schemaVersion: 2, sourceSha, workflowSha, runId, attempt, profile, ciProfile, evidence };
}

// Atmos master CI selects its own CI profile from the commit; the API cannot prove which one
// ran. Only the default profile may rely on Atmos evidence; beta profiles keep the full suite.
export const atmosEvidenceEligible = ciProfile => ciProfile === '';

function oneStep(steps, name) {
  const matches = steps?.filter(step => step.name === name) ?? [];
  assert.equal(matches.length, 1, `one "${name}" step required`);
  assert.equal(matches[0].status, 'completed', `${name} has not completed`);
  return matches[0];
}

export function verifyAppTestReceipt(raw, jobs, context) {
  assert.equal(typeof raw, 'string', 'app test receipt is missing');
  assert.ok(Buffer.byteLength(raw) > 0 && Buffer.byteLength(raw) <= 4096, 'invalid app test receipt size');
  const receipt = JSON.parse(raw);
  assert.deepEqual(receipt, appTestReceipt(context), 'app tests source/profile/run/attempt/evidence differs');
  const matches = jobs.filter(job => job.name === APP_TEST_JOB);
  assert.equal(matches.length, 1, 'one app test job required');
  const job = matches[0];
  assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
  assert.equal(job.head_sha, context.workflowSha);
  assert.equal(String(job.run_id), context.runId);
  assert.equal(String(job.run_attempt), context.attempt);
  // GitHub, not the candidate-reachable receipt, reports that the selected gate actually ran.
  assert.equal(oneStep(job.steps, EVIDENCE_STEP).conclusion, 'success', 'evidence step did not succeed');
  const gate = receipt.evidence.path === 'full-local' ? APP_TEST_STEP : LOCAL_GATE_STEP;
  assert.equal(oneStep(job.steps, gate).conclusion, 'success', `${gate} did not succeed`);
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
    runId: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, selection: env.MODEL_SELECTION_SHA256,
    evidence: appTestEvidenceFromEnvironment(env) });
  assert.equal(env.WX_CI_PROFILE ?? '', receipt.ciProfile, 'app test profile differs');
  return receipt;
}

// ---- Atmos CI evidence (read-only GitHub API; token only in a request header) ----

// Bounded JSON over HTTPS. Redirects, non-200, oversized or non-object bodies are refused.
export async function boundedJson(url, token, { fetcher = fetch, limit = ATMOS_API_MAX_BYTES, timeoutMs = 20000 } = {}) {
  assert.equal(new URL(url).origin, 'https://api.github.com', 'unexpected API origin');
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  assert.ok(response.type !== 'opaqueredirect' && response.redirected !== true, 'redirected API response');
  assert.equal(response.status, 200, `API read refused (${response.status})`);
  const declared = Number(response.headers?.get?.('content-length') ?? NaN);
  assert.ok(!(declared > limit), 'API response too large');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length; assert.ok(size <= limit, 'API response too large'); chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'API response is not an object');
  return value;
}

// Pure decision over the API records. Returns the exact run/attempt or throws a reason.
export function selectAtmosCiRun(listing, sourceSha) {
  sha(sourceSha);
  assert.ok(Number.isSafeInteger(listing?.total_count) && listing.total_count >= 0 && listing.total_count <= 20, 'run history exceeds bound');
  assert.ok(Array.isArray(listing.workflow_runs) && listing.workflow_runs.length === listing.total_count, 'incomplete run history');
  const ids = new Set();
  for (const run of listing.workflow_runs) {
    assert.ok(Number.isSafeInteger(run?.id) && run.id > 0 && !ids.has(run.id), 'invalid run id'); ids.add(run.id);
    assert.equal(run.head_sha, sourceSha, 'API returned a run for a different source');
    assert.equal(run.path, ATMOS_CI_WORKFLOW, 'API returned a different workflow');
    assert.equal(run.repository?.full_name, ATMOS_REPOSITORY, 'API returned a different repository');
  }
  assert.ok(listing.workflow_runs.length > 0, 'no Atmos ci run for this source');
  // The newest run for the source decides; an older success never outvotes a newer failure.
  const run = listing.workflow_runs.reduce((a, b) => (b.id > a.id ? b : a));
  assert.equal(run.head_repository?.full_name, ATMOS_REPOSITORY, 'fork run is not evidence');
  assert.equal(run.event, 'push', 'only a master push run tests exactly this commit');
  assert.equal(run.head_branch, 'master', 'only a master push run is evidence');
  assert.equal(run.status, 'completed', 'Atmos ci run has not completed');
  assert.equal(run.conclusion, 'success', 'Atmos ci run did not succeed');
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'invalid run attempt');
  return { runId: String(run.id), attempt: String(run.run_attempt) };
}

export function requireAtmosVerdict(jobsListing, sourceSha, { runId, attempt }) {
  assert.ok(Number.isSafeInteger(jobsListing?.total_count) && jobsListing.total_count <= 100, 'job listing exceeds bound');
  assert.ok(Array.isArray(jobsListing.jobs) && jobsListing.jobs.length === jobsListing.total_count, 'incomplete job listing');
  const verdicts = jobsListing.jobs.filter(job => job.name === ATMOS_CI_VERDICT_JOB);
  assert.equal(verdicts.length, 1, 'one ci-verdict job required');
  const job = verdicts[0];
  assert.equal(job.status, 'completed', 'ci-verdict has not completed');
  assert.equal(job.conclusion, 'success', 'ci-verdict did not succeed');
  assert.equal(job.head_sha, sourceSha, 'ci-verdict tested a different source');
  assert.equal(String(job.run_id), runId); assert.equal(String(job.run_attempt), attempt);
  return { path: 'atmos-ci', runId, attempt };
}

export async function atmosCiEvidence(sourceSha, token, options = {}) {
  sha(sourceSha); assert.ok(typeof token === 'string' && token.length > 0, 'read token absent');
  const base = `https://api.github.com/repos/${ATMOS_REPOSITORY}/actions`;
  const listing = await boundedJson(`${base}/workflows/ci.yml/runs?head_sha=${sourceSha}&event=push&branch=master&exclude_pull_requests=true&per_page=20`, token, options);
  const run = selectAtmosCiRun(listing, sourceSha);
  const jobs = await boundedJson(`${base}/runs/${run.runId}/attempts/${run.attempt}/jobs?per_page=100`, token, options);
  return requireAtmosVerdict(jobs, sourceSha, run);
}

// Never weaker than before: anything short of proven evidence selects the complete local suite.
export async function decideEvidence(env, options = {}) {
  sha(env.ATMOS_SHA);
  if (!env.ATMOS_CI_READ_TOKEN) return { path: 'full-local', reason: 'ATMOS_CI_READ_TOKEN is not provisioned' };
  if (!atmosEvidenceEligible(env.WX_CI_PROFILE ?? '')) return { path: 'full-local', reason: `CI profile ${env.WX_CI_PROFILE} requires the complete local suite` };
  try { return await atmosCiEvidence(env.ATMOS_SHA, env.ATMOS_CI_READ_TOKEN, options); }
  catch (error) { return { path: 'full-local', reason: `Atmos CI evidence not proven: ${String(error?.message ?? 'error').split('\n')[0].slice(0, 160)}` }; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  assert.equal(process.argv.length, 3);
  assert.ok(process.env.GITHUB_OUTPUT, 'job output path is required');
  if (command === 'evidence') {
    assert.equal(process.env.GITHUB_JOB, APP_TEST_JOB);
    const decision = await decideEvidence(process.env);
    const evidence = appTestEvidence(decision);
    const token = process.env.ATMOS_CI_READ_TOKEN;
    const reason = token ? (decision.reason ?? '').replaceAll(token, '***') : decision.reason;
    console.log(evidence.path === 'atmos-ci'
      ? `App test evidence path: atmos-ci (${ATMOS_REPOSITORY} ${ATMOS_CI_WORKFLOW} run ${evidence.runId} attempt ${evidence.attempt}, job ${ATMOS_CI_VERDICT_JOB}); local gate: ${LOCAL_GATE_COMMANDS.join(' && ')}`
      : `App test evidence path: full-local (${reason}); running ${APP_TEST_COMMAND}`);
    appendFileSync(process.env.GITHUB_OUTPUT, `path=${evidence.path}\natmos_run_id=${evidence.runId ?? ''}\natmos_run_attempt=${evidence.attempt ?? ''}\n`);
  } else {
    assert.equal(command, 'emit');
    const actual = execFileSync('git', ['-C', 'atmos', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const workflow = execFileSync('git', ['-C', 'cycle', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const receipt = receiptForEnvironment(process.env, actual, workflow);
    appendFileSync(process.env.GITHUB_OUTPUT, `receipt=${JSON.stringify(receipt)}\n`);
  }
}
