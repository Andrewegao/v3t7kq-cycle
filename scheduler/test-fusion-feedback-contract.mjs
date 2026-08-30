import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
assert.doesNotMatch(issue, /path: feedback-output\/(issues|truth)/);
assert.doesNotMatch(evaluate, /path: feedback-archive/);
assert.equal((infra.match(/secrets\.FUSION_DEPLOY_API_TOKEN/g) ?? []).length, 3);
assert.doesNotMatch(infra, /secrets\.CLOUDFLARE_API_TOKEN|CLOUDFLARE_WORKERS_API_TOKEN|R2_PRODUCTION|pages deploy/);
console.log('fusion feedback authority/workflow contract: ok');
