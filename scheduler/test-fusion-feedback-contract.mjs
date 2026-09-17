import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = name => readFile(new URL('../.github/workflows/' + name, import.meta.url), 'utf8');
const [issue, evaluate, promote, infra, staging] = await Promise.all(
  ['fusion-issue.yml', 'fusion-evaluate.yml', 'fusion-promote.yml', 'fusion-infra.yml', 'fusion-staging-evidence.yml'].map(read));
for (const workflow of [issue, evaluate, promote, infra, staging]) {
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /contents: write|pull_request_target/);
}
for (const workflow of [issue, evaluate, promote]) {
  assert.match(workflow, /environment: production/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_.*TOKEN|FUSION_DEPLOY_API_TOKEN|R2_.*KEY|wrangler|deploy-code-only|bake-weatherx\//);
}
assert.match(issue, /repository: weatherx-hq\/atmos/);
assert.match(issue, /ref: \$\{\{ env\.ENGINE_SHA \}\}/);
assert.match(issue, /secrets\.FUSION_ISSUANCE_KEY/);
assert.match(issue, /secrets\.FUSION_ARCHIVE_READ_KEY/);
assert.doesNotMatch(issue, /secrets\.FUSION_PROMOTION_KEY|--candidate|FUSION_SHADOW/);
assert.match(issue, /options: \[canary, full\]/);
assert.match(issue, /RECORD FUSION EVIDENCE/);
assert.match(issue, /canary\) stations=1/);
assert.match(issue, /full\) stations=64/);
assert.match(issue, /FUSION_CALIBRATION_RUNTIME_ENABLED: 'false'/);
assert.match(issue, /verify-readback/);
assert.match(issue, /fusion-production-evidence\.mjs receipt/);
assert.match(issue, /fusion-production-evidence\.mjs readback/);
assert.match(issue, /vars\.FUSION_ISSUANCE_ENABLED == 'true'/);
assert.doesNotMatch(issue, /vars\.FUSION_FEEDBACK_ENABLED/);
assert.match(issue, /github\.event_name == 'workflow_dispatch'/);
assert.doesNotMatch(issue, /needs:|workflow_run:/,
  'issuance failure must remain isolated from every weather publication workflow');
assert.doesNotMatch(issue, /path: .*\/(issues|truth)(?:\/|$)/,
  'private forecast and truth bodies must not be uploaded as workflow artifacts');
assert.match(issue, /failure\(\) \|\| cancelled\(\)/);
assert.match(issue, /collection-status\.json/);
assert.match(issue, /run-status\.json/);
assert.match(issue, /readback-receipt\.json/);
assert.match(issue, /if-no-files-found: error/);

assert.match(evaluate, /secrets\.FUSION_ARCHIVE_READ_KEY/);
assert.doesNotMatch(evaluate, /secrets\.FUSION_PROMOTION_KEY|secrets\.FUSION_ISSUANCE_KEY/);
assert.match(evaluate, /BUILD FROZEN FUSION CANDIDATE/);
assert.match(evaluate, /test "\$mode" != build/);
assert.match(evaluate, /vars\.FUSION_FEEDBACK_ENABLED == 'true'/);
assert.doesNotMatch(evaluate, /needs:|workflow_run:/,
  'scoring failure must remain isolated from every weather publication workflow');
assert.match(evaluate, /Record a bounded evaluation gap/);
assert.doesNotMatch(evaluate, /path: feedback-archive/);

assert.match(promote, /secrets\.FUSION_PROMOTION_KEY/);
assert.doesNotMatch(promote, /schedule:|secrets\.FUSION_ISSUANCE_KEY|secrets\.FUSION_ARCHIVE_READ_KEY/);
assert.match(promote, /PROMOTE VERIFIED FUSION/);
assert.match(promote, /ROLLBACK FUSION/);
assert.match(promote, /download-evaluation\.sh/);
assert.match(promote, /EVIDENCE_MODE: promote/);

assert.match(infra, /options: \[archive, all\]/);
assert.match(infra, /DEPLOY FUSION ARCHIVE PRODUCTION/);
assert.match(infra, /inputs\.component == 'all'/);
assert.match(infra, /wrangler deploy --env "\$TARGET" -c wrangler\.fusion-archive\.jsonc/);
assert.match(infra, /wrangler deploy --env "\$TARGET" -c wrangler\.fusion-control\.jsonc/);
assert.equal((infra.match(/wrangler\.fusion-control\.jsonc/g) ?? []).length, 1);
assert.doesNotMatch(infra, /secrets\.CLOUDFLARE_API_TOKEN|CLOUDFLARE_WORKERS_API_TOKEN|R2_PRODUCTION|pages deploy/);
const productionArchiveSmoke = infra.match(/- name: Verify the production archive with read-only authority[\s\S]*?(?=\n\s+- name:)/)?.[0] ?? '';
const stagingArchiveSmoke = infra.match(/- name: Verify the staging archive with discovery and read-only authority[\s\S]*?(?=\n\s+- name:)/)?.[0] ?? '';
assert.match(productionArchiveSmoke, /secrets\.FUSION_ARCHIVE_READ_KEY/);
assert.doesNotMatch(productionArchiveSmoke, /FUSION_DEPLOY_API_TOKEN|FUSION_ISSUANCE_KEY|FUSION_PROMOTION_KEY/);
assert.match(stagingArchiveSmoke, /secrets\.FUSION_ARCHIVE_READ_KEY/);
assert.match(stagingArchiveSmoke, /secrets\.FUSION_DEPLOY_API_TOKEN/);
assert.doesNotMatch(stagingArchiveSmoke, /FUSION_ISSUANCE_KEY|FUSION_PROMOTION_KEY/);

assert.doesNotMatch(staging, /schedule:|FUSION_STAGING_EVIDENCE_ENABLED/,
  'the fixed-catalog staging recorder must remain manual-only');
console.log('fusion feedback authority/workflow contract: ok');
