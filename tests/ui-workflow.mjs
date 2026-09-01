import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const staging=read('.github/workflows/ui-staging.yml'), prod=read('.github/workflows/ui-release.yml'), source=read('tools/ui-release.mjs');
const {installPagesWorker}=await import('../tools/ui-release.mjs');
test('staging workflow leaves release-mode activation to the exact-profile controller',()=>{
  const build=staging.slice(staging.indexOf('\n  build:\n'),staging.indexOf('\n  qualify:\n'));
  assert.match(build,/VITE_MODEL_EXPANSION_QUALIFICATION: '0'/);assert.match(build,/VITE_STAGING_MODEL_ADMISSION: '0'/);
  assert.match(build,/VITE_STAGING_MODEL_SELECTION_SHA256: ''/);assert.doesNotMatch(build,/ATMOS_STAGING_EXPERIMENT_RELEASE:\s*'1'/);
  assert.match(source,/publicBuildEnvironment\(profile,selection/);
  assert.match(source,/merge-base','--is-ancestor',requiredSourceGuard\(profile\),'HEAD'/);
  assert.doesNotMatch(prod,/ATMOS_STAGING_EXPERIMENT_RELEASE|MODEL_SELECTION_SHA256|VITE_STAGING_MODEL_ADMISSION/);
  const stagedController="ref: ${{ inputs.model_selection_sha256 == 'none' && 'dbc97a26bc239398ffa9ec157a094148961b6451' || '58eab1895966c547227bf8440565b4c94a7a0c89' }}";
  assert.equal(staging.split(stagedController).length-1,2);
  assert.match(prod,/ref: dbc97a26bc239398ffa9ec157a094148961b6451/);
  assert.doesNotMatch(prod,/58eab1895966c547227bf8440565b4c94a7a0c89/);
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
test('Pages Functions build installs executable JavaScript and rejects upload envelopes or extra modules',()=>{
  const temp=mkdtempSync(resolve(tmpdir(),'wx-ui-worker-build-'));
  const workerOut=resolve(temp,'worker'),dist=resolve(temp,'dist');mkdirSync(workerOut);mkdirSync(dist);
  writeFileSync(resolve(workerOut,'index.js'),'export default { fetch(){ return new Response("ok") } };\n');
  installPagesWorker(workerOut,dist);
  assert.match(readFileSync(resolve(dist,'_worker.js'),'utf8'),/export default/);

  const multipart=resolve(temp,'multipart'),multipartDist=resolve(temp,'multipart-dist');mkdirSync(multipart);mkdirSync(multipartDist);
  writeFileSync(resolve(multipart,'index.js'),'------formdata\r\nContent-Disposition: form-data; name="metadata"\r\n');
  assert.throws(()=>installPagesWorker(multipart,multipartDist),/multipart upload bundle/);

  const modules=resolve(temp,'modules'),modulesDist=resolve(temp,'modules-dist');mkdirSync(modules);mkdirSync(modulesDist);
  writeFileSync(resolve(modules,'index.js'),'export default {};\n');writeFileSync(resolve(modules,'extra.js'),'export {};\n');
  assert.throws(()=>installPagesWorker(modules,modulesDist),/unexpected modules/);
});
test('Pages Functions compilation uses module output, never deprecated multipart outfile',()=>{
  assert.match(source,/pages','functions','build'[\s\S]*?'--outdir',workerOut/);
  assert.doesNotMatch(source,/pages','functions','build'[\s\S]{0,300}?'--outfile'/);
  assert.match(source,/installPagesWorker\(workerOut,dist\)/);
});
test('guard is pinned, both candidate verification paths are inside automatic rollback',()=>{
  assert.match(source,/guard-pages-deploy\.sh/);
  assert.match(source,/ui-verify\.sh/);
  assert.match(source,/RELEASE_GUARD_VERIFY_REQUIRED_SUCCESSES:'3'/);
  assert.match(source,/RELEASE_GUARD_VERIFY_SLEEP_SECONDS:'15'/);
  assert.match(source,/const phase=process\.env\.RELEASE_GUARD_PHASE==='rollback'\?'rollback':'candidate'/);
  assert.match(source,/standaloneWeatherFeedVerificationRequired\(stage, 'preflight'\)/);
  assert.doesNotMatch(source,/if \(standaloneWeatherFeedVerificationRequired\(stage, phase\)\)/);
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
