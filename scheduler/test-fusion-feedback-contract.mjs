import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const read = (name) => readFile(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
const [issue, evaluate, promote, infra] = await Promise.all(['fusion-issue.yml', 'fusion-evaluate.yml', 'fusion-promote.yml', 'fusion-infra.yml'].map(read));
for (const workflow of [issue, evaluate, promote, infra]) {
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /ref: \$\{\{ vars.FUSION_ENGINE_SHA \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /contents: write|pull_request_target/);
}
for (const workflow of [issue, evaluate, promote]) {
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_.*TOKEN|FUSION_DEPLOY_API_TOKEN|R2_.*KEY|wrangler|deploy-code-only|bake-weatherx/);
}
assert.match(issue, /secrets.FUSION_ISSUANCE_KEY/);
assert.doesNotMatch(issue, /secrets.FUSION_PROMOTION_KEY|secrets.FUSION_ARCHIVE_READ_KEY/);
assert.match(evaluate, /secrets.FUSION_ARCHIVE_READ_KEY/);
assert.doesNotMatch(evaluate, /secrets.FUSION_PROMOTION_KEY|secrets.FUSION_ISSUANCE_KEY/);
assert.match(evaluate, /BUILD FROZEN FUSION CANDIDATE/);
assert.match(evaluate, /test "\$mode" != build/);
assert.match(promote, /secrets.FUSION_PROMOTION_KEY/);
assert.doesNotMatch(promote, /schedule:|secrets.FUSION_ISSUANCE_KEY|secrets.FUSION_ARCHIVE_READ_KEY/);
assert.match(promote, /PROMOTE VERIFIED FUSION/);
assert.match(promote, /ROLLBACK FUSION/);
assert.match(promote, /download-evaluation.sh/);
assert.match(promote, /EVIDENCE_MODE: promote/);
assert.match(issue, /vars.FUSION_FEEDBACK_ENABLED == 'true'/);
assert.match(evaluate, /vars.FUSION_FEEDBACK_ENABLED == 'true'/);
assert.doesNotMatch(issue, /needs:|workflow_run:/,
  'issuance failure must remain isolated from every weather publication workflow');
assert.doesNotMatch(evaluate, /needs:|workflow_run:/,
  'scoring failure must remain isolated from every weather publication workflow');
assert.match(issue, /id: collect/);
assert.match(issue, /Validate the compact issuance receipt/);
assert.match(issue, /Record a bounded issuance gap/);
assert.match(issue, /steps\.collect\.outcome/);
assert.match(issue, /failure\(\) \|\| cancelled\(\)/);
assert.match(issue, /job\.status/);
assert.match(issue, /feedback-output\/issuance-gap\.json/);
assert.match(issue, /if-no-files-found: error/);
assert.match(evaluate, /id: score/);
assert.match(evaluate, /Record a bounded evaluation gap/);
assert.match(evaluate, /steps\.score\.outcome/);
assert.match(evaluate, /failure\(\) \|\| cancelled\(\)/);
assert.match(evaluate, /job\.status/);
assert.match(evaluate, /feedback-output\/evaluation-gap\.json/);
assert.match(issue, /\$RUNNER_TEMP\/weatherx-fusion-evidence\/candidate\.json/);
assert.match(issue, /git status --porcelain --untracked-files=normal/);
assert.doesNotMatch(issue, /--candidate feedback-evidence\/candidate\.json/);
assert.doesNotMatch(issue, /path: feedback-output\/(issues|truth)/);
assert.doesNotMatch(evaluate, /path: feedback-archive/);
assert.equal((infra.match(/secrets\.FUSION_DEPLOY_API_TOKEN/g) ?? []).length, 3);
assert.doesNotMatch(infra, /secrets\.CLOUDFLARE_API_TOKEN|CLOUDFLARE_WORKERS_API_TOKEN|R2_PRODUCTION|pages deploy/);

const validation = issue.match(
  /\/\/ BEGIN WEATHERX COMPACT ISSUANCE RECEIPT VALIDATION\n([\s\S]*?)\n\s*\/\/ END WEATHERX COMPACT ISSUANCE RECEIPT VALIDATION/
);
assert.ok(validation, 'compact issuance receipt validation must remain executable in the workflow');
const validationScript = validation[1].split('\n').map((line) => line.replace(/^\s{10}/, '')).join('\n');
const engineSha = 'a'.repeat(40);
const validReceipt = {
  schemaVersion: 1,
  sourceGitSha: engineSha,
  sourceTreeClean: true,
  generatedAt: '2026-09-13T08:00:00.000Z',
  releaseId: 'cycle-123',
  verifyRunId: '2026091200',
  issued: 64,
  failed: 0,
  truthCount: 128,
  baselineId: 'builtin-v1',
  networkSha256: 'b'.repeat(64),
  published: true,
};
function validateReceipt(receipt, expectedSha = engineSha) {
  const root = mkdtempSync(join(tmpdir(), 'weatherx-fusion-receipt-'));
  try {
    mkdirSync(join(root, 'feedback-output'));
    writeFileSync(join(root, 'feedback-output', 'collection-receipt.json'), JSON.stringify(receipt));
    return spawnSync(process.execPath, ['--input-type=module'], {
      cwd: root,
      input: validationScript,
      encoding: 'utf8',
      env: { ...process.env, EXPECTED_ENGINE_SHA: expectedSha },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
assert.equal(validateReceipt(validReceipt).status, 0, 'canonical receipt must pass');
for (const [name, receipt, expectedSha] of [
  ['wrong engine', { ...validReceipt, sourceGitSha: 'c'.repeat(40) }],
  ['dirty source', { ...validReceipt, sourceTreeClean: false }],
  ['bad verification run', { ...validReceipt, verifyRunId: 'latest' }],
  ['bad baseline', { ...validReceipt, baselineId: 'candidate-latest' }],
  ['unknown field', { ...validReceipt, unbound: true }],
  ['bad expected engine', validReceipt, 'main'],
]) {
  assert.notEqual(validateReceipt(receipt, expectedSha).status, 0, `${name} must fail`);
}
console.log('fusion feedback authority/workflow contract: ok');
