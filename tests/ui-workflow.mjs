import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const staging=read('.github/workflows/ui-staging.yml'), prod=read('.github/workflows/ui-release.yml'), source=read('tools/ui-release.mjs');
test('staging workflow leaves release-mode activation to the exact-profile controller',()=>{
  const build=staging.slice(staging.indexOf('\n  build:\n'),staging.indexOf('\n  qualify:\n'));
  assert.match(build,/VITE_MODEL_EXPANSION_QUALIFICATION: '0'/);assert.match(build,/VITE_STAGING_MODEL_ADMISSION: '0'/);
  assert.match(build,/VITE_STAGING_MODEL_SELECTION_SHA256: ''/);assert.doesNotMatch(build,/ATMOS_STAGING_EXPERIMENT_RELEASE:\s*'1'/);
  assert.match(source,/publicBuildEnvironment\(profile,selection/);
  assert.match(source,/merge-base','--is-ancestor',requiredSourceGuard\(profile\),'HEAD'/);
  assert.doesNotMatch(prod,/ATMOS_STAGING_EXPERIMENT_RELEASE|MODEL_SELECTION_SHA256|VITE_STAGING_MODEL_ADMISSION/);
});
test('guard upload adapter preserves args and disables rebundling without invoking a real CLI',()=>{
  const temp=mkdtempSync(resolve(tmpdir(),'wx-ui-adapter-test-'));
  const bin=resolve(temp,'fake-cli');writeFileSync(bin,'#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)))\n',{mode:0o700});
  const script=new URL('../tools/ui-npx.sh',import.meta.url).pathname;
  const args=['wrangler','pages','deploy','/isolated/dist','--project-name','weatherx-platform-staging','--branch','main','--commit-dirty=true'];
  const result=execFileSync('bash',[script,...args],{env:{...process.env,UI_WRANGLER_BIN:bin},encoding:'utf8'});
  assert.deepEqual(JSON.parse(result),[...args.slice(1),'--no-bundle','--upload-source-maps=false']);
  assert.notEqual(spawnSync('bash',[script,'wrangler','deploy'],{env:{...process.env,UI_WRANGLER_BIN:bin}}).status,0);
});
test('guard is pinned, both candidate verification paths are inside automatic rollback',()=>{
  assert.match(source,/guard-pages-deploy\.sh/);
  assert.match(source,/ui-verify\.sh/);
  assert.match(source,/RELEASE_GUARD_VERIFY_REQUIRED_SUCCESSES:'3'/);
  assert.match(source,/RELEASE_GUARD_VERIFY_SLEEP_SECONDS:'15'/);
  assert.match(source,/RELEASE_GUARD_PHASE !== 'rollback'/);
  assert.match(source,/weather-lab-only-runtime\.mjs/);assert.match(source,/layer-switch-tint\.mjs/);
  assert.match(source,/cwd:uploadCwd/);assert.doesNotMatch(source,/cwd:dirname\(dist\)/);
});
test('only successful staging retains encrypted output; production has no build step',()=>{
  const order=['npm test --prefix atmos/app','bash ops/weather-lab-ready.sh','ui-release.mjs build\n',
    'ui-release.mjs deploy staging','ui-release.mjs retain','path: ${{ runner.temp }}/ui-sealed/*'];
  for(let i=1;i<order.length;i++)assert.ok(staging.indexOf(order[i])>staging.indexOf(order[i-1]),order[i]);
  assert.doesNotMatch(prod,/ui-release.mjs build|npm run build|deploy-code-only.sh/);
  assert.match(prod,/ui-release.mjs download[\s\S]+ui-release.mjs deploy production/);
  assert.match(source,/if \(stage === 'production'\) \{ await auditRun\(c\); await exactStaging\(c\); \}/);
  assert.match(source,/assert.equal\(validateFiles\(readTree\(dist\)\).digest,c.artifactDigest/);
});
test('secret exposure is step-local and no implicit production key fallback exists',()=>{
  assert.doesNotMatch(staging,/secrets\.UI_PRODUCTION_PAGES_TOKEN/);
  assert.doesNotMatch(prod,/secrets\.UI_STAGING_PAGES_TOKEN/);
  for(const wf of [staging,prod]){
    assert.doesNotMatch(wf,/secrets\.CLOUDFLARE_API_TOKEN/);
    assert.doesNotMatch(wf,/^      (CLOUDFLARE_API_TOKEN|UI_CANDIDATE_KEY):/m);
    assert.match(wf,/persist-credentials: false/);
  }
});
