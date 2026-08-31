import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const workflow=readFileSync(new URL('../.github/workflows/model-inputs.yml',import.meta.url),'utf8');
test('model collector is manual, bounded parallel and staging-only',()=>{
  assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/^  (push|schedule|workflow_run|repository_dispatch|pull_request):/m);
  assert.match(workflow,/name: data-staging/);assert.match(workflow,/max-parallel: 3/);assert.match(workflow,/fail-fast: false/);
  assert.match(workflow,/cancel-in-progress: false/);assert.match(workflow,/timeout-minutes: 90/);
  assert.match(workflow,/model: \[icon, hrrr-ak, hrdps, nam, nam-hi, nam-ak, arome-antilles\]/);
  for(const use of workflow.matchAll(/uses:\s+([^\s]+)@([^\s]+)/g))assert.match(use[2],/^[a-f0-9]{40}$/);
});
test('only exact approved source runs; no R2 credential reaches acquisition or dependencies',()=>{
  assert.ok(workflow.indexOf('model-inputs.mjs gate')<workflow.indexOf('repository: Andrewegao/atmos'));
  assert.match(workflow,/ref: \$\{\{ inputs.source_sha \}\}/);assert.match(workflow,/fetch-depth: 0/);
  assert.match(workflow,/git -C atmos rev-parse HEAD/);assert.match(workflow,/git -C atmos diff --quiet HEAD/);
  const archive=workflow.indexOf('- name: Encrypt and immutably archive');assert.ok(archive>0);
  assert.doesNotMatch(workflow.slice(0,archive),/secrets\.(?:STAGING_R2_WRITE|MODEL_INPUT_ARCHIVE)/);
  assert.doesNotMatch(workflow,/CLOUDFLARE_API_TOKEN|PAGES|WRANGLER|wrangler|SHARED_R2|PRODUCTION.*KEY|R2_ACCESS_KEY_ID|upload-artifact|actions\/cache|publish-r2|bake-weatherx|ui-release/);
  assert.equal((workflow.match(/persist-credentials: false/g)||[]).length,2);
});
