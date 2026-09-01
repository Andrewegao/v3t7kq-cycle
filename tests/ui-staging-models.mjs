import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {BASELINE_PROFILE,MODELS,GRIDS,variables,displayPaths,digest,canonical,profileFor,validateProfile,requireProductionProfile,validateSelection,readSelection,validateCandidateSelection,requireStagingApproval,browserEnvironment,validateBrowserReceipt} from '../tools/ui-staging-models.mjs';
import {browserCandidateReady,pixelDifference} from '../tools/ui-staging-model-browser.mjs';
import {createCandidate,hash,eligibleRun,REPOSITORY} from '../tools/ui-candidate.mjs';
import {eligibleBuild} from '../tools/ui-build-transfer.mjs';
import {publicBuildEnvironment,requiredSourceGuard,weatherFeedVerificationRequired} from '../tools/ui-release.mjs';

const NOW=Date.parse('2026-08-31T20:00:00Z'),INIT='2026083112',SHA='a'.repeat(40),DIGEST='b'.repeat(64);
function entry(model,n){
  const files=displayPaths(INIT).map((path,i)=>({path,bytes:i+1,sha256:digest(model+'/'+path)}));
  const run=String(100+n),attempt='1',artifactId=`stage-${INIT}-${run}-${attempt}`,catalogId=`stage-${model}-${run}-${attempt}`;
  return {schemaVersion:1,kind:'weatherx-staging-model-selection-entry',targetOrigin:'https://staging.weatherx.org',model,status:'DATA_QUALIFIED',catalogId,catalogSha256:DIGEST,
    component:{artifactId,manifestKey:`components/${model}/${artifactId}/component.json`,manifestSha256:DIGEST,inventorySha256:DIGEST},collectorSourceSha:SHA,validatorSourceSha:SHA,
    cloudSource:{runId:'12',runAttempt:'1'},validatorRun:{runId:run,runAttempt:attempt,runnerEnvironment:'github-hosted'},archiveReceiptSha256:DIGEST,archiveMarkerSha256:DIGEST,
    sourceReceiptSha256:DIGEST,stagedQualificationSha256:DIGEST,createdAt:new Date(NOW).toISOString(),stagingDataQualified:true,init:INIT,leadCount:49,horizonHours:48,grid:GRIDS[model],variables:variables(model),
    windReference:'earth-relative',displayInventory:files,displayInventorySha256:digest(canonical(files)),indexPath:`/data/_catalog/${catalogId}/${model}/index.json`,
    manifestPath:`/data/_catalog/${catalogId}/${model}/runs/${INIT}/manifest.json`,browserQualified:false,fusionEligible:false,productionPublishable:false,weatherxFusionIssued:false};
}
export function selection(models=MODELS){return Buffer.from(JSON.stringify({schemaVersion:1,kind:'weatherx-staging-model-selection',targetOrigin:'https://staging.weatherx.org',entries:models.map((m,i)=>entry(m,i))})+'\n');}
function candidateFixture(profile=BASELINE_PROFILE,bundle){
  const root=mkdtempSync(resolve(tmpdir(),'wx-stage-profile-')),content={'index.html':'x','_worker.js':'x','_routes.json':'{}',...(bundle?{'assets/staging-model-selection.json':bundle}:{})};
  const crypto=[];for(const path of Object.keys(content).sort()){const bytes=Buffer.from(content[path]);crypto.push([path,bytes]);mkdirSync(resolve(root,path,'..'),{recursive:true});writeFileSync(resolve(root,path),bytes);}
  const d=(h=>{for(const [path,bytes] of crypto)h.update(path).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0');return h.digest('hex');})(createHash('sha256'));
  const receipt={schemaVersion:1,gitSha:SHA,workflowRunId:'123',releaseId:`git-${SHA.slice(0,12)}-run-123`,shellSha256:d,indexSha256:hash('x'),shellFileCount:crypto.length,shellBytes:crypto.reduce((n,[,b])=>n+b.length,0)};
  mkdirSync(resolve(root,'health'));writeFileSync(resolve(root,'health/release.json'),JSON.stringify(receipt));
  return createCandidate(root,{sourceSha:SHA,runId:'123',attempt:'1',workflowSha:'c'.repeat(40),pipelineDigest:'d'.repeat(64),profile});
}
test('baseline remains exact while experimental profile binds one content digest',()=>{
  assert.deepEqual(profileFor(),BASELINE_PROFILE);assert.deepEqual(profileFor('none'),BASELINE_PROFILE);requireProductionProfile(BASELINE_PROFILE);
  const p=profileFor(DIGEST);validateProfile(p);assert.equal(p.stagingOnly,true);assert.throws(()=>requireProductionProfile(p));
  for(const bad of ['',{},'x'.repeat(64),{...p,account:true},{...p,extra:true}])assert.throws(()=>validateProfile(typeof bad==='string'?profileFor(bad):bad));
});
test('all seven exact data-qualified entries validate without granting browser/fusion authority',()=>{
  const body=selection(),sha=digest(body),bundle=validateSelection(body,sha,NOW);assert.deepEqual(bundle.entries.map(e=>e.model),MODELS);
  for(const change of [b=>b.entries=[],b=>b.entries[0].grid.width++,b=>b.entries[0].fusionEligible=true,b=>b.entries[0].displayInventory.pop(),
    b=>b.entries[0].component.artifactId='other',b=>b.entries[0].createdAt='2025-01-01T00:00:00.000Z']){
    const changed=Buffer.from(JSON.stringify((()=>{const v=structuredClone(bundle);change(v);return v;})()));assert.throws(()=>validateSelection(changed,digest(changed),NOW));
  }
  assert.throws(()=>validateSelection(body,'0'.repeat(64),NOW));assert.throws(()=>validateSelection(body,sha,NOW+24*3600000));
});
test('cycle-owned content-addressed source refuses symlinks and mismatched file identity',()=>{
  const root=realpathSync(mkdtempSync(resolve(tmpdir(),'wx-stage-selection-'))),folder=resolve(root,'staging-selections'),body=selection(['icon']),sha=digest(body);mkdirSync(folder);writeFileSync(resolve(folder,sha+'.json'),body);
  assert.deepEqual(readSelection(root,profileFor(sha),NOW).bundle.entries.map(e=>e.model),['icon']);assert.equal(readSelection(root,BASELINE_PROFILE,NOW),null);
  const p=profileFor('0'.repeat(64));assert.throws(()=>readSelection(root,p,NOW));
});
test('candidate profile and exact public asset are inseparable; protected staging approval is conditional',()=>{
  const body=selection(['icon']),sha=digest(body),profile=profileFor(sha),candidate=candidateFixture(profile,body);
  assert.equal(validateCandidateSelection(candidate,NOW).entries[0].model,'icon');
  assert.equal(requireStagingApproval(candidate,{MODEL_SELECTION_SHA256:sha,UI_STAGING_MODEL_SELECTION_APPROVED_SHA256:sha},NOW).entries.length,1);
  assert.throws(()=>requireStagingApproval(candidate,{MODEL_SELECTION_SHA256:sha,UI_STAGING_MODEL_SELECTION_APPROVED_SHA256:'0'.repeat(64)},NOW));
  const baseline=candidateFixture();assert.equal(requireStagingApproval(baseline,{MODEL_SELECTION_SHA256:'none'},NOW),null);
  for(const mutate of [c=>c.files.splice(c.files.findIndex(f=>f.path==='assets/staging-model-selection.json'),1),c=>c.profile=BASELINE_PROFILE,c=>c.profile.modelSelectionSha256='0'.repeat(64)]){
    const bad=structuredClone(candidate);mutate(bad);assert.throws(()=>validateCandidateSelection(bad,NOW));
  }
});
test('production run eligibility rejects a qualified staging experiment before artifact acceptance',()=>{
  const body=selection(['icon']),sha=digest(body),c=candidateFixture(profileFor(sha),body);c.qualification={origin:'https://staging.weatherx.org',artifactDigest:c.artifactDigest,fullTests:true,weatherLab:true,builtRuntime:true,probes:3,deploymentId:'12345678-1234-1234-1234-123456789abc',qualifiedAt:new Date(NOW).toISOString()};
  const run={id:123,repository:{full_name:REPOSITORY},path:'.github/workflows/ui-staging.yml',event:'workflow_dispatch',head_branch:'main',status:'completed',conclusion:'success',run_attempt:1,head_sha:c.workflowSha};
  const artifacts=[{name:'ui-candidate-123-1',expired:false,expires_at:'2026-10-01T00:00:00Z'}];
  assert.throws(()=>eligibleRun(run,artifacts,{runId:'123',sourceSha:SHA,digest:c.artifactDigest,pipelineDigest:c.pipelineDigest,candidate:c},NOW),/cannot enter production/);
});
test('isolated publisher binds protected input profile to the exact same-attempt build',()=>{
  const body=selection(['icon']),sha=digest(body),profile=profileFor(sha),c=candidateFixture(profile,body);
  const run={id:123,run_attempt:1,repository:{full_name:REPOSITORY},path:'.github/workflows/ui-staging.yml',event:'workflow_dispatch',head_branch:'main',head_sha:c.workflowSha};
  const jobs=[{name:'build',status:'completed',conclusion:'success',head_sha:c.workflowSha}],artifacts=[{name:'ui-build-123-1',expired:false,size_in_bytes:1234}];
  const context={runId:'123',attempt:'1',workflowSha:c.workflowSha,sourceSha:SHA,pipelineDigest:c.pipelineDigest,profile};
  eligibleBuild(c,run,jobs,artifacts,context);assert.throws(()=>eligibleBuild(c,run,jobs,artifacts,{...context,profile:BASELINE_PROFILE}),/differs from requested profile/);
});
test('manual staging defaults to baseline and only its protected environment can approve an experiment',()=>{
  const root=new URL('../',import.meta.url),staging=readFileSync(new URL('.github/workflows/ui-staging.yml',root),'utf8'),production=readFileSync(new URL('.github/workflows/ui-release.yml',root),'utf8');
  assert.match(staging,/model_selection_sha256:[\s\S]*?default: none/);assert.match(staging,/name: ui-staging[\s\S]*?UI_STAGING_MODEL_SELECTION_APPROVED_SHA256: \$\{\{ vars\.UI_STAGING_MODEL_SELECTION_APPROVED_SHA256 \}\}/);
  assert.doesNotMatch(production,/model_selection_sha256|UI_STAGING_MODEL_SELECTION_APPROVED_SHA256|VITE_STAGING_MODEL_ADMISSION/);
});
test('build flags select mutually exclusive production or exact staging-experiment release guards',()=>{
  const body=selection(['icon']),sha=digest(body),profile=profileFor(sha),source={bytes:body};
  const staging=publicBuildEnvironment(profile,source,{KEEP:'yes'});
  assert.equal(staging.ATMOS_PUBLIC_RELEASE,'0');assert.equal(staging.ATMOS_STAGING_EXPERIMENT_RELEASE,'1');
  assert.equal(staging.VITE_MODEL_EXPANSION_QUALIFICATION,'1');assert.equal(staging.VITE_STAGING_MODEL_ADMISSION,'1');
  assert.equal(staging.VITE_STAGING_MODEL_SELECTION_SHA256,sha);assert.equal(staging.VITE_PLATFORM_ACCOUNT,'0');assert.equal(staging.VITE_MODEL_LOCAL_BASE,'');assert.equal(staging.KEEP,'yes');
  const baseline=publicBuildEnvironment(BASELINE_PROFILE,null,{});
  assert.equal(baseline.ATMOS_PUBLIC_RELEASE,'1');assert.equal(baseline.ATMOS_STAGING_EXPERIMENT_RELEASE,'0');
  assert.equal(baseline.VITE_MODEL_EXPANSION_QUALIFICATION,'0');assert.equal(baseline.VITE_STAGING_MODEL_ADMISSION,'0');assert.equal(baseline.VITE_STAGING_MODEL_SELECTION_SHA256,'');
  assert.equal(requiredSourceGuard(profile),'164a469189da2c8303c997d4020b3ae20da84cd7');assert.equal(requiredSourceGuard(BASELINE_PROFILE),null);
  assert.throws(()=>publicBuildEnvironment(profile,null,{}));
  assert.throws(()=>publicBuildEnvironment(profile,{bytes:Buffer.from('wrong')},{}));
  assert.throws(()=>publicBuildEnvironment(BASELINE_PROFILE,source,{}));
});
test('browser child process uses an allowlist and pixel proof measures visible color changes',()=>{
  const clean=browserEnvironment({PATH:'/bin',HOME:'/tmp',GITHUB_TOKEN:'secret',CLOUDFLARE_API_TOKEN:'secret',UI_CANDIDATE_KEY:'secret',RANDOM:'discard'},{BASE:'https://staging.weatherx.org'});
  assert.deepEqual(clean,{PATH:'/bin',HOME:'/tmp',BASE:'https://staging.weatherx.org'});
  const off={width:2,height:1,data:Buffer.from([0,0,0,255,0,0,0,255])},on={...off,data:Buffer.from([9,0,0,255,8,0,0,255])};assert.equal(pixelDifference(on,off),.5);
});
test('browser admission requires one coherent exact candidate in its own page context',()=>{
  const expected={sourceSha:SHA,releaseId:`git-${SHA.slice(0,12)}-run-123`,selectionSha256:DIGEST};
  const ready={origin:'https://staging.weatherx.org',releaseStatus:200,selectionStatus:200,sourceSha:expected.sourceSha,
    releaseId:expected.releaseId,selectionSha256:expected.selectionSha256,modelButtonCount:1,lit:true,atmosReady:true};
  assert.equal(browserCandidateReady(ready,expected),true);
  for(const mutate of [s=>s.origin='https://weatherx.org',s=>s.releaseStatus=404,s=>s.selectionStatus=404,s=>s.sourceSha='0'.repeat(40),
    s=>s.releaseId='git-'+SHA.slice(0,12)+'-run-999',s=>s.selectionSha256='0'.repeat(64),s=>s.modelButtonCount=0,s=>s.lit=false,s=>s.atmosReady=false]){
    const state=structuredClone(ready);mutate(state);assert.equal(browserCandidateReady(state,expected),false);
  }
});
test('staging can bootstrap an old site but every uploaded candidate must pass weather-feed verification',()=>{
  assert.equal(weatherFeedVerificationRequired('staging','preflight'),false);
  assert.equal(weatherFeedVerificationRequired('production','preflight'),true);
  assert.equal(weatherFeedVerificationRequired('staging','candidate'),true);
  assert.equal(weatherFeedVerificationRequired('production','candidate'),true);
  assert.equal(weatherFeedVerificationRequired('staging','rollback'),false);
  assert.equal(weatherFeedVerificationRequired('production','rollback'),false);
  assert.throws(()=>weatherFeedVerificationRequired('preview','preflight'));
  assert.throws(()=>weatherFeedVerificationRequired('staging','unknown'));
});
test('browser receipt proves each selected model plus the exact latest-selection race',()=>{
  const body=selection(['icon','nam']),bundle=validateSelection(body,digest(body),NOW),selected=e=>({model:e.model,init:e.init,base:e.manifestPath.slice(0,-'manifest.json'.length)});
  const model=e=>({model:e.model,catalogId:e.catalogId,init:e.init,selected:selected(e),layers:['temp','wind','mslp'].map(field=>({field,changedRatio:.02,point:'explicit-unavailable',fusionEligible:false})),domain:{}});
  const receipt={schemaVersion:1,origin:'https://staging.weatherx.org',sourceSha:SHA,releaseId:`git-${SHA.slice(0,12)}-run-123`,selectionSha256:digest(body),qualifiedAt:new Date(NOW).toISOString(),models:[...bundle.entries.map(model),{rapidModelSequence:['icon','nam'],finalModel:'nam'}],verifiedObjectCount:12};
  const bytes=Buffer.from(JSON.stringify(receipt));validateBrowserReceipt(bytes,bundle,{sourceSha:SHA,releaseId:receipt.releaseId,selectionSha256:digest(body)},NOW);
  for(const mutate of [r=>r.models.pop(),r=>r.models.at(-1).finalModel='icon',r=>r.verifiedObjectCount=11]){const bad=structuredClone(receipt);mutate(bad);assert.throws(()=>validateBrowserReceipt(Buffer.from(JSON.stringify(bad)),bundle,{sourceSha:SHA,releaseId:receipt.releaseId,selectionSha256:digest(body)},NOW));}
});
