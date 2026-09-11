import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CONTROL_SHA, STAGING_CONTROL_SHA } from '../tools/ui-candidate.mjs';
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const staging=read('.github/workflows/ui-staging.yml'), prod=read('.github/workflows/ui-release.yml'), source=read('tools/ui-release.mjs'), candidate=read('tools/ui-candidate.mjs');
test('compressed profile is an explicit staging request using the unchanged input and default',()=>{
  assert.match(staging,/model_selection_sha256:\n\s+description:.*release-roster-core-br11-v1/);
  assert.match(staging,/model_selection_sha256:[\s\S]*?default: approved/);
  assert.match(staging,/APPROVED_STATIC_COMPRESSION: \$\{\{ vars\.UI_STAGING_STATIC_COMPRESSION_APPROVED \}\}/);
  assert.match(staging,/resolveSelectionRequest\(process\.env\.REQUESTED_SELECTION,process\.env\.APPROVED_SELECTION,process\.env\.APPROVED_CORE_PROFILE,process\.env\.APPROVED_STATIC_COMPRESSION,process\.env\.APPROVED_ACCOUNT_PROFILE\)/);
  assert.doesNotMatch(prod,/UI_STAGING_STATIC_COMPRESSION_APPROVED|release-roster-core-br11-v1|static-br11-v1/);
});
test('staging private checkouts use the current Atmos repository owner',()=>{
  assert.equal((staging.match(/repository: weatherx-hq\/atmos/g)||[]).length,3);
  assert.doesNotMatch(staging,/repository: Andrewegao\/atmos/);
});
const {installPagesWorker,platformVerificationEnvironment}=await import('../tools/ui-release.mjs');
test('staging rejects stale public point data before expensive build work while production remains isolated',()=>{
  const preflight='node cycle/tools/ui-staging-preflight.mjs';
  assert.match(staging,new RegExp(preflight.replaceAll('.','\\.')));
  assert.ok(staging.indexOf(preflight)<staging.indexOf('checkout exact candidate Atmos source'));
  assert.ok(staging.indexOf(preflight)<staging.indexOf('install locked dependencies and browsers'));
  assert.doesNotMatch(prod,/ui-staging-preflight|MODEL_SELECTION_SHA256/);
});
test('staging workflow leaves release-mode activation to the exact-profile controller',()=>{
  const build=staging.slice(staging.indexOf('\n  build:\n'),staging.indexOf('\n  qualify:\n'));
  assert.match(build,/VITE_MODEL_EXPANSION_QUALIFICATION: '0'/);assert.match(build,/VITE_STAGING_MODEL_ADMISSION: '0'/);
  assert.match(build,/VITE_STAGING_MODEL_SELECTION_SHA256: ''/);assert.doesNotMatch(build,/ATMOS_STAGING_EXPERIMENT_RELEASE:\s*'1'/);
  assert.match(source,/publicBuildEnvironment\(profile,selection/);
  assert.match(source,/merge-base','--is-ancestor',requiredSourceGuard\(profile\),'HEAD'/);
  assert.doesNotMatch(prod,/ATMOS_STAGING_EXPERIMENT_RELEASE|ATMOS_STAGING_RELEASE_ROSTER|MODEL_SELECTION_SHA256|VITE_STAGING_MODEL_ADMISSION|UI_STAGING_CORE_PROFILE_APPROVED/);
  const stagedController="ref: ${{ needs.profile.outputs.model_selection_sha256 == 'none' && '"
    + CONTROL_SHA + "' || '" + STAGING_CONTROL_SHA + "' }}";
  assert.equal(staging.split(stagedController).length-1,2);
  assert.match(STAGING_CONTROL_SHA,/^[a-f0-9]{40}$/);
  assert.equal((staging.match(/ref: \$\{\{ needs\.profile\.outputs\.model_selection_sha256/g)||[]).length,2);
  assert.match(candidate,/export const CONTROL_SHA = '25c402db5149daa018e349a34a4beeba1f2dca45'/);
  assert.match(prod,/ref: 25c402db5149daa018e349a34a4beeba1f2dca45/);
  assert.match(prod,/repository: weatherx-hq\/atmos/);
  assert.doesNotMatch(prod,/ref: a58eff158b56ef2ba25189d2b859315b00893a14/);
  assert.doesNotMatch(prod,/STAGING_CONTROL_SHA|stagingOnly/);
});
test('staging Wind100 pin comes only from protected profile outputs and production has no flags',()=>{
  const profile=staging.slice(staging.indexOf('\n  profile:\n'),staging.indexOf('\n  build:\n'));
  const build=staging.slice(staging.indexOf('\n  build:\n'),staging.indexOf('\n  qualify:\n'));
  const qualify=staging.slice(staging.indexOf('\n  qualify:\n'));
  for(const suffix of ['ENABLED','CATALOG_ID','RUN_ID','SELECTION_SHA256']){
    assert.match(profile,new RegExp(`STAGING_WIND100_UI_${suffix}: \\\$\\{\\{ vars\\.STAGING_WIND100_UI_${suffix} \\}\\}`));
    assert.match(build,new RegExp(`STAGING_WIND100_UI_${suffix}: \\\$\\{\\{ needs\\.profile\\.outputs\\.wind100_${suffix.toLowerCase()} \\}\\}`));
    assert.match(qualify,new RegExp(`STAGING_WIND100_UI_${suffix}: \\\$\\{\\{ vars\\.STAGING_WIND100_UI_${suffix} \\}\\}`));
  }
  assert.match(source,/validateWind100BuildReceipt\(c\.profile,JSON\.parse\(bytes\),process\.env\)/,
    'the deployed live release receipt must be compared with the current protected tuple');
  assert.match(source,/if\(wind100\)Object\.assign\(c\.qualification,\{wind100\}\)/);
  assert.match(source,/assert\.deepEqual\(c\.qualification\?\.wind100,wind100\?\?undefined/);
  assert.doesNotMatch(prod,/WIND100|wind100/);
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
test('only a staging candidate receives the bounded degraded-cache convergence window',()=>{
  const base={RELEASE_GUARD_VERIFY_REQUIRED_SUCCESSES:'3',RELEASE_GUARD_VERIFY_SLEEP_SECONDS:'15'};
  const staging=platformVerificationEnvironment('staging','candidate',base);
  assert.notEqual(staging,base);
  assert.deepEqual(staging,{...base,RELEASE_GUARD_VERIFY_ATTEMPTS:'50'});
  // 600 s ordinary outer refresh + 60 s cache-only recovery + two more 15 s
  // observations for the required three consecutive successes fit before attempt 50.
  assert.ok((Number(staging.RELEASE_GUARD_VERIFY_ATTEMPTS)-1)*Number(staging.RELEASE_GUARD_VERIFY_SLEEP_SECONDS)>=690);
  for(const [stage,phase] of [['production','candidate'],['production','rollback'],['staging','rollback']]){
    assert.equal(platformVerificationEnvironment(stage,phase,base),base);
    assert.equal(base.RELEASE_GUARD_VERIFY_ATTEMPTS,undefined);
  }
  const verify=source.slice(source.indexOf('async function verify(stage)'),source.indexOf('function retain()'));
  assert.match(verify,/stage==='staging'&&phase==='candidate'[\s\S]*?run\('\/usr\/bin\/timeout',[\s\S]*?'--signal=KILL','15m','bash'[\s\S]*?platformVerificationEnvironment\(stage,phase\)[\s\S]*?else run\('bash'/);
  assert.ok(verify.indexOf('verify-platform-production.sh')<verify.indexOf("if (phase !== 'rollback')"));
  assert.doesNotMatch(verify,/catch\s*\(/); // exhaustion still throws into the rollback guard
});
const gnuTimeout=['/usr/bin/timeout','/opt/homebrew/bin/gtimeout','/usr/local/bin/gtimeout'].find(path=>
  existsSync(path)&&spawnSync(path,['--version'],{encoding:'utf8'}).stdout?.startsWith('timeout (GNU coreutils)'));
test('the candidate wallclock propagates failures and kills the whole verifier process group',
  {skip:process.platform!=='linux'&&!gnuTimeout},()=>{
  assert.ok(gnuTimeout,'GNU timeout is required on the Linux release runner');
  const ordinary=spawnSync(gnuTimeout,['5s','bash','-c','exit 23'],{stdio:'pipe'});
  assert.equal(ordinary.status,23,'an ordinary verifier failure must remain visible');
  const temp=mkdtempSync(resolve(tmpdir(),'wx-ui-timeout-')),script=resolve(temp,'hold.sh');
  const survived=resolve(temp,'survived');
  try{
    writeFileSync(script,"#!/usr/bin/env bash\nset -euo pipefail\ntrap '' TERM\nout=$1\n( trap '' TERM; sleep 3; printf survived > \"$out\" ) &\nwait $!\n",{mode:0o700});
    const started=Date.now();
    const result=spawnSync(gnuTimeout,['--signal=KILL','0.1s','bash',script,survived],{stdio:'pipe'});
    assert.notEqual(result.status,0,'a real wallclock deadline must fail closed');
    assert.ok(Date.now()-started<2000,'descendant kept the verifier process group alive');
    assert.equal(existsSync(survived),false);
  }finally{rmSync(temp,{recursive:true,force:true});}
});
test('only successful staging retains encrypted output; production has no build step',()=>{
  const order=['npm test --prefix atmos/app','bash ops/weather-lab-ready.sh','ui-release.mjs build\n',
    'ui-release.mjs deploy staging','ui-release.mjs retain','path: ${{ runner.temp }}/ui-sealed/*'];
  for(let i=1;i<order.length;i++)assert.ok(staging.indexOf(order[i])>staging.indexOf(order[i-1]),order[i]);
  assert.doesNotMatch(prod,/ui-release.mjs build|npm run build|deploy-code-only.sh/);
  assert.match(prod,/ui-release.mjs download[\s\S]+ui-release.mjs deploy production/);
  assert.match(source,/if \(stage === 'production'\) \{ await auditRun\(c\); await exactStaging\(c\); \}/);
  assert.match(source,/assert.equal\(validateFiles\(readTree\(dist,c.profile\),c.profile\).digest,c.artifactDigest/);
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
