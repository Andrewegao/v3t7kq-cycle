import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
const workflow=readFileSync(new URL('../.github/workflows/model-inputs.yml',import.meta.url),'utf8');
const independent=workflow.slice(workflow.indexOf('  collect-independent:'),workflow.indexOf('\n  collect:'));
const noaa=workflow.slice(workflow.indexOf('\n  collect:'));
test('model collector is manual, provider-aware, bounded and staging-only',()=>{
  assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/^  (push|schedule|workflow_run|repository_dispatch|pull_request):/m);
  assert.ok(independent.length>0&&noaa.length>0);assert.match(workflow,/cancel-in-progress: false/);
  assert.match(independent,/name: data-staging/);assert.match(independent,/max-parallel: 3/);assert.match(independent,/fail-fast: false/);
  assert.match(independent,/timeout-minutes: 90/);assert.match(independent,/model: \[icon, hrdps, arome-antilles\]/);
  assert.doesNotMatch(independent,/hrrr-ak|nam-hi|nam-ak/);
  assert.match(noaa,/name: data-staging/);assert.match(noaa,/timeout-minutes: 120/);assert.doesNotMatch(noaa,/matrix:|max-parallel:/);
  assert.equal((noaa.match(/for model in hrrr-ak nam nam-hi nam-ak/g)||[]).length,1);
  assert.match(noaa,/id: collect_noaa[\s\S]*continue-on-error: true[\s\S]*model-inputs-noaa\.sh collect/);
  assert.match(noaa,/id: archive_noaa[\s\S]*if: \$\{\{ always\(\) && steps\.collect_noaa\.outputs\.completed != '' \}\}[\s\S]*continue-on-error: true[\s\S]*model-inputs-noaa\.sh archive/);
  assert.match(noaa,/NOAA_COLLECTION_OUTCOME: \$\{\{ steps\.collect_noaa\.outcome \}\}[\s\S]*NOAA_ARCHIVE_OUTCOME: \$\{\{ steps\.archive_noaa\.outcome \}\}/);
  assert.match(noaa,/test "\$NOAA_COMPLETED_MODELS" = "hrrr-ak nam nam-hi nam-ak"/);
  assert.equal((noaa.match(/--workers 2/g)||[]).length,0);
  assert.equal((independent.match(/--workers 2/g)||[]).length,1);
  for(const use of workflow.matchAll(/uses:\s+([^\s]+)@([^\s]+)/g))assert.match(use[2],/^[a-f0-9]{40}$/);
});
test('only exact approved source runs; package caches are pinned and no weather input is cached',()=>{
  assert.ok(workflow.indexOf('model-inputs.mjs gate')<workflow.indexOf('repository: Andrewegao/atmos'));
  assert.equal((workflow.match(/ref: \$\{\{ inputs.source_sha \}\}/g)||[]).length,2);
  assert.equal((workflow.match(/fetch-depth: 0/g)||[]).length,2);
  assert.equal((workflow.match(/git -C atmos rev-parse HEAD/g)||[]).length,2);
  assert.equal((workflow.match(/git -C atmos diff --quiet HEAD/g)||[]).length,2);
  assert.equal((workflow.match(/cache: npm/g)||[]).length,2);
  assert.equal((workflow.match(/cache-dependency-path: cycle\/staging-controller\/package-lock\.json/g)||[]).length,2);
  assert.equal((workflow.match(/cache: pip/g)||[]).length,2);
  assert.equal((workflow.match(/cache-dependency-path: atmos\/data\/requirements\.txt/g)||[]).length,2);
  for(const job of [independent,noaa]){
    const archive=job.indexOf('- name: Encrypt and immutably archive');assert.ok(archive>0);
    assert.doesNotMatch(job.slice(0,archive),/secrets\.(?:STAGING_R2_WRITE|MODEL_INPUT_ARCHIVE)/);
  }
  assert.doesNotMatch(workflow,/CLOUDFLARE_API_TOKEN|PAGES|WRANGLER|wrangler|SHARED_R2|PRODUCTION.*KEY|R2_ACCESS_KEY_ID|upload-artifact|actions\/cache|publish-r2|bake-weatherx|ui-release/);
  assert.doesNotMatch(workflow,/weatherx-model-inputs.*cache|cache-dependency-path:.*weather|\.cache-rivers|\.verify_cache/);
  assert.equal((workflow.match(/persist-credentials: false/g)||[]).length,4);
});
