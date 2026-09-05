import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,realpathSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {BASELINE_PROFILE,CORE_RELEASE_PROFILE,CORE_RELEASE_REQUEST,MODELS,GRIDS,variables,displayPaths,digest,canonical,cycleTime,resolveSelectionRequest,profileFor,validateProfile,requireProductionProfile,validateSelection,readSelection,validateCandidateSelection,requireStagingApproval,browserEnvironment,validateBrowserReceipt,validateCoreBrowserReceipt} from '../tools/ui-staging-models.mjs';
import {browserCandidateReady,discardedResponseBody,layerActivationNeeded,matrixProofPlan,pixelDifference,responseBodyOrFallback,responseCaptureNeeded,validateFetchedObject,validateIndependentPointSource} from '../tools/ui-staging-model-browser.mjs';
import {coreCycle,protocol as coreBrowserProtocol,releaseRosterProof,validateCoreIndex,validateOutsideDomain} from '../tools/ui-staging-core-browser.mjs';
import {createCandidate,hash,eligibleRun,REPOSITORY,CONTROL_SHA,STAGING_CONTROL_SHA,controlShaFor} from '../tools/ui-candidate.mjs';
import {eligibleBuild} from '../tools/ui-build-transfer.mjs';
import {publicBuildEnvironment,requiredSourceGuard,standaloneWeatherFeedVerificationRequired} from '../tools/ui-release.mjs';
import {requireSelectionMargin} from '../tools/ui-staging-preflight.mjs';

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
  assert.deepEqual(profileFor(CORE_RELEASE_REQUEST),CORE_RELEASE_PROFILE);validateProfile(CORE_RELEASE_PROFILE);assert.throws(()=>requireProductionProfile(CORE_RELEASE_PROFILE));
  for(const bad of ['',{},'x'.repeat(64),{...p,account:true},{...p,extra:true}])assert.throws(()=>validateProfile(typeof bad==='string'?profileFor(bad):bad));
  for(const bad of [{...CORE_RELEASE_PROFILE,releaseRosterCore:'other'},{...CORE_RELEASE_PROFILE,modelSelectionSha256:DIGEST},{...CORE_RELEASE_PROFILE,stagingOnly:false}])assert.throws(()=>validateProfile(bad));
});
test('ordinary staging resolves the protected approval while baseline remains an explicit opt-out',()=>{
  assert.equal(resolveSelectionRequest(undefined,DIGEST),DIGEST);
  assert.equal(resolveSelectionRequest('approved',DIGEST),DIGEST);
  assert.equal(resolveSelectionRequest(DIGEST,DIGEST),DIGEST);
  assert.equal(resolveSelectionRequest('none',undefined),'none');
  assert.equal(resolveSelectionRequest(CORE_RELEASE_REQUEST,undefined,CORE_RELEASE_REQUEST),CORE_RELEASE_REQUEST);
  assert.throws(()=>resolveSelectionRequest(CORE_RELEASE_REQUEST,DIGEST,undefined),/core profile approval/);
  assert.throws(()=>resolveSelectionRequest(CORE_RELEASE_REQUEST,DIGEST,'other'),/core profile approval/);
  for(const [requested,approved] of [['approved',undefined],['approved','x'],['',DIGEST],['0'.repeat(64),DIGEST]])
    assert.throws(()=>resolveSelectionRequest(requested,approved));
});
test('all seven exact data-qualified entries validate without granting browser/fusion authority',()=>{
  const body=selection(),sha=digest(body),bundle=validateSelection(body,sha,NOW);assert.deepEqual(bundle.entries.map(e=>e.model),MODELS);
  for(const change of [b=>b.entries=[],b=>b.entries[0].grid.width++,b=>b.entries[0].fusionEligible=true,b=>b.entries[0].displayInventory.pop(),
    b=>b.entries[0].component.artifactId='other',b=>b.entries[0].createdAt='2025-01-01T00:00:00.000Z',b=>b.entries[0].createdAt='2026-08-31T20:00:00.001Z']){
    const changed=Buffer.from(JSON.stringify((()=>{const v=structuredClone(bundle);change(v);return v;})()));assert.throws(()=>validateSelection(changed,digest(changed),NOW));
  }
  assert.throws(()=>validateSelection(body,'0'.repeat(64),NOW));assert.throws(()=>validateSelection(body,sha,NOW+24*3600000));
});
test('selection preflight rejects a cycle with less than the reserved pipeline lifetime',()=>{
  const body=selection(['icon']),sha=digest(body),bundle=validateSelection(body,sha,NOW),expires=Date.parse('2026-09-01T00:00:00.000Z');
  assert.doesNotThrow(()=>requireSelectionMargin(bundle,expires-25*60_000));
  assert.throws(()=>requireSelectionMargin(bundle,expires-25*60_000+1),/will expire during qualification/);
  assert.throws(()=>cycleTime('2026090100',NOW),/stale\/future model selection/);
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
  const core=candidateFixture(CORE_RELEASE_PROFILE);assert.equal(validateCandidateSelection(core,NOW),null);
  assert.equal(requireStagingApproval(core,{MODEL_SELECTION_SHA256:CORE_RELEASE_REQUEST,UI_STAGING_CORE_PROFILE_APPROVED:CORE_RELEASE_REQUEST},NOW),null);
  assert.throws(()=>requireStagingApproval(core,{MODEL_SELECTION_SHA256:CORE_RELEASE_REQUEST}),/core profile approval/);
  assert.throws(()=>candidateFixture(CORE_RELEASE_PROFILE,body),/cannot carry experimental selection/);
  for(const mutate of [c=>c.files.splice(c.files.findIndex(f=>f.path==='assets/staging-model-selection.json'),1),c=>c.profile=BASELINE_PROFILE,c=>c.profile.modelSelectionSha256='0'.repeat(64)]){
    const bad=structuredClone(candidate);mutate(bad);assert.throws(()=>validateCandidateSelection(bad,NOW));
  }
});
test('production run eligibility rejects a qualified staging experiment before artifact acceptance',()=>{
  const body=selection(['icon']),sha=digest(body),c=candidateFixture(profileFor(sha),body);c.qualification={origin:'https://staging.weatherx.org',artifactDigest:c.artifactDigest,fullTests:true,weatherLab:true,builtRuntime:true,probes:3,deploymentId:'12345678-1234-1234-1234-123456789abc',qualifiedAt:new Date(NOW).toISOString()};
  const run={id:123,repository:{full_name:REPOSITORY},path:'.github/workflows/ui-staging.yml',event:'workflow_dispatch',head_branch:'main',status:'completed',conclusion:'success',run_attempt:1,head_sha:c.workflowSha};
  const artifacts=[{name:'ui-candidate-123-1',expired:false,expires_at:'2026-10-01T00:00:00Z'}];
  assert.throws(()=>eligibleRun(run,artifacts,{runId:'123',sourceSha:SHA,digest:c.artifactDigest,pipelineDigest:c.pipelineDigest,candidate:c},NOW),/cannot enter production/);
  const core=candidateFixture(CORE_RELEASE_PROFILE);core.qualification=structuredClone(c.qualification);
  assert.throws(()=>eligibleRun(run,artifacts,{runId:'123',sourceSha:SHA,digest:core.artifactDigest,pipelineDigest:core.pipelineDigest,candidate:core},NOW),/cannot enter production/);
});
test('isolated publisher binds protected input profile to the exact same-attempt build',()=>{
  const body=selection(['icon']),sha=digest(body),profile=profileFor(sha),c=candidateFixture(profile,body);
  const run={id:123,run_attempt:1,repository:{full_name:REPOSITORY},path:'.github/workflows/ui-staging.yml',event:'workflow_dispatch',head_branch:'main',head_sha:c.workflowSha};
  const jobs=[{name:'build',status:'completed',conclusion:'success',head_sha:c.workflowSha}],artifacts=[{name:'ui-build-123-1',expired:false,size_in_bytes:1234}];
  const context={runId:'123',attempt:'1',workflowSha:c.workflowSha,sourceSha:SHA,pipelineDigest:c.pipelineDigest,profile};
  eligibleBuild(c,run,jobs,artifacts,context);assert.throws(()=>eligibleBuild(c,run,jobs,artifacts,{...context,profile:BASELINE_PROFILE}),/differs from requested profile/);
});
test('manual staging defaults to protected approval and only explicit none selects baseline',()=>{
  const root=new URL('../',import.meta.url),staging=readFileSync(new URL('.github/workflows/ui-staging.yml',root),'utf8'),production=readFileSync(new URL('.github/workflows/ui-release.yml',root),'utf8');
  assert.match(staging,/model_selection_sha256:[\s\S]*?default: approved/);
  assert.match(staging,/\n  profile:\n[\s\S]*?environment:\s*\n\s*name: ui-staging[\s\S]*?APPROVED_SELECTION: \$\{\{ vars\.UI_STAGING_MODEL_SELECTION_APPROVED_SHA256 \}\}/);
  assert.match(staging,/APPROVED_CORE_PROFILE: \$\{\{ vars\.UI_STAGING_CORE_PROFILE_APPROVED \}\}/);
  assert.equal(staging.split('needs.profile.outputs.model_selection_sha256').length-1,4);
  assert.match(staging,/name: ui-staging[\s\S]*?UI_STAGING_MODEL_SELECTION_APPROVED_SHA256: \$\{\{ vars\.UI_STAGING_MODEL_SELECTION_APPROVED_SHA256 \}\}/);
  assert.match(staging,/UI_STAGING_CORE_PROFILE_APPROVED: \$\{\{ vars\.UI_STAGING_CORE_PROFILE_APPROVED \}\}/);
  assert.doesNotMatch(production,/model_selection_sha256|UI_STAGING_MODEL_SELECTION_APPROVED_SHA256|UI_STAGING_CORE_PROFILE_APPROVED|VITE_STAGING_MODEL_ADMISSION|release-roster-core-v1/);
});
test('build flags select mutually exclusive production or exact staging-experiment release guards',()=>{
  const body=selection(['icon']),sha=digest(body),profile=profileFor(sha),source={bytes:body};
  const staging=publicBuildEnvironment(profile,source,{KEEP:'yes'});
  assert.equal(controlShaFor(profile),STAGING_CONTROL_SHA);
  assert.equal(staging.ATMOS_PUBLIC_RELEASE,'0');assert.equal(staging.ATMOS_STAGING_EXPERIMENT_RELEASE,'1');
  assert.equal(staging.VITE_MODEL_EXPANSION_QUALIFICATION,'1');assert.equal(staging.VITE_STAGING_MODEL_ADMISSION,'1');
  assert.equal(staging.VITE_STAGING_MODEL_SELECTION_SHA256,sha);assert.equal(staging.VITE_PLATFORM_ACCOUNT,'0');assert.equal(staging.VITE_MODEL_LOCAL_BASE,'');assert.equal(staging.KEEP,'yes');
  const baseline=publicBuildEnvironment(BASELINE_PROFILE,null,{});
  assert.equal(controlShaFor(BASELINE_PROFILE),CONTROL_SHA);
  assert.equal(baseline.ATMOS_PUBLIC_RELEASE,'1');assert.equal(baseline.ATMOS_STAGING_EXPERIMENT_RELEASE,'0');
  assert.equal(baseline.VITE_MODEL_EXPANSION_QUALIFICATION,'0');assert.equal(baseline.VITE_STAGING_MODEL_ADMISSION,'0');assert.equal(baseline.VITE_STAGING_MODEL_SELECTION_SHA256,'');
  assert.equal(requiredSourceGuard(profile),'164a469189da2c8303c997d4020b3ae20da84cd7');assert.equal(requiredSourceGuard(BASELINE_PROFILE),null);
  const core=publicBuildEnvironment(CORE_RELEASE_PROFILE,null,{});
  assert.equal(core.ATMOS_PUBLIC_RELEASE,'0');assert.equal(core.ATMOS_STAGING_EXPERIMENT_RELEASE,'1');assert.equal(core.ATMOS_STAGING_RELEASE_ROSTER,'1');
  assert.equal(core.VITE_MODEL_EXPANSION_QUALIFICATION,'1');assert.equal(core.VITE_STAGING_MODEL_ADMISSION,'0');assert.equal(core.VITE_STAGING_MODEL_SELECTION_SHA256,'');
  assert.equal(requiredSourceGuard(CORE_RELEASE_PROFILE),'ed8065275eefa5e6e530ce37d1133a3baf1026c5');assert.throws(()=>publicBuildEnvironment(CORE_RELEASE_PROFILE,source,{}));
  assert.throws(()=>publicBuildEnvironment(profile,null,{}));
  assert.throws(()=>publicBuildEnvironment(profile,{bytes:Buffer.from('wrong')},{}));
  assert.throws(()=>publicBuildEnvironment(BASELINE_PROFILE,source,{}));
});
test('browser child process uses an allowlist and pixel proof measures visible color changes',()=>{
  const clean=browserEnvironment({PATH:'/bin',HOME:'/tmp',GITHUB_TOKEN:'secret',CLOUDFLARE_API_TOKEN:'secret',UI_CANDIDATE_KEY:'secret',RANDOM:'discard'},{BASE:'https://staging.weatherx.org'});
  assert.deepEqual(clean,{PATH:'/bin',HOME:'/tmp',BASE:'https://staging.weatherx.org'});
  const off={width:2,height:1,data:Buffer.from([0,0,0,255,0,0,0,255])},on={...off,data:Buffer.from([9,0,0,255,8,0,0,255])};assert.equal(pixelDifference(on,off),.5);
});
test('core browser gate is staging-only and refuses inherited credentials before launch',()=>{
  const env={BASE:'https://staging.weatherx.org',UI_EXPECTED_SOURCE_SHA:SHA,WEATHERX_EXPECTED_RELEASE_ID:`git-${SHA.slice(0,12)}-run-123`,UI_MODEL_BROWSER_OUTPUT:'/tmp/receipt.json'};
  assert.doesNotThrow(()=>coreBrowserProtocol(env));
  assert.throws(()=>coreBrowserProtocol({...env,BASE:'https://weatherx.org'}),/only actual staging/);
  assert.throws(()=>coreBrowserProtocol({...env,CLOUDFLARE_API_TOKEN:'secret'}),/must not inherit credentials/);
  assert.equal(validateOutsideDomain({error:{code:'outside_model_domain',message:'The requested point is outside this model domain.'}}),true);
  assert.throws(()=>validateOutsideDomain({error:'outside_model_domain'}));
});
test('browser admission requires one coherent exact candidate in its own page context',()=>{
  const expected={sourceSha:SHA,releaseId:`git-${SHA.slice(0,12)}-run-123`,selectionSha256:DIGEST};
  const ready={origin:'https://staging.weatherx.org',releaseStatus:200,selectionStatus:200,sourceSha:expected.sourceSha,
    releaseId:expected.releaseId,selectionSha256:expected.selectionSha256,modelButtonCount:1,modelButtonVisible:true,
    lit:true,bootSettled:true,atmosReady:true};
  assert.equal(browserCandidateReady(ready,expected),true);
  for(const mutate of [s=>s.origin='https://weatherx.org',s=>s.releaseStatus=404,s=>s.selectionStatus=404,s=>s.sourceSha='0'.repeat(40),
    s=>s.releaseId='git-'+SHA.slice(0,12)+'-run-999',s=>s.selectionSha256='0'.repeat(64),s=>s.modelButtonCount=0,
    s=>s.modelButtonVisible=false,s=>s.lit=false,s=>s.bootSettled=false,s=>s.atmosReady=false]){
    const state=structuredClone(ready);mutate(state);assert.equal(browserCandidateReady(state,expected),false);
  }
});
test('model matrix ensures an active layer without toggling an already-visible layer off',()=>{
  assert.equal(layerActivationNeeded({wind:{visible:true}},'wind'),false);
  assert.equal(layerActivationNeeded({wind:{visible:false}},'wind'),true);
  assert.equal(layerActivationNeeded({},'wind'),true);
});
test('regional map layers retain an independently attributed global point forecast without joining fusion',()=>{
  for(const source of ['ECMWF IFS 0.25°','NOAA GFS 0.25°','WeatherX Fusion','Open-Meteo fallback'])assert.deepEqual(
    validateIndependentPointSource('Point forecast is separate from the map layer.',source,'nam'),
    {kind:'independent-global',source,mapModelFusionEligible:false},
  );
  assert.throws(()=>validateIndependentPointSource('Verified point forecast not yet published.','ECMWF IFS 0.25°','nam'),/retain the independent point forecast/);
  assert.throws(()=>validateIndependentPointSource('Point forecast is separate from the map layer.','NAM','nam'),/unexpected independent point source/);
});
test('model byte proof is armed for every exact field frame before performance warming can run',()=>{
  const entries=['icon','nam'].map((model,i)=>entry(model,i)),plan=matrixProofPlan(entries,NOW);
  assert.equal(plan.rows.length,2);assert.equal(plan.required.size,12);
  const icon=plan.rows[0];assert.equal(icon.lead,9);assert.equal(icon.cursor,Date.parse('2026-08-31T21:30:00Z'));
  assert.deepEqual(icon.paths.temp,[
    `/data/_catalog/${entries[0].catalogId}/icon/runs/${INIT}/temp/009.png`,
    `/data/_catalog/${entries[0].catalogId}/icon/runs/${INIT}/temp/010.png`,
  ]);
  assert.equal(responseCaptureNeeded(plan.required,new Map(),new Set(),icon.paths.temp[0]),true,'an early warm response must already be captured');
  assert.throws(()=>matrixProofPlan(entries,NOW+41*3600000),/stale\/future model selection/);
});
test('browser byte proof ignores stale responses, captures once, and narrowly recovers a discarded CDP body',async()=>{
  const path='/data/_catalog/current/temp/001.png',required=new Set([path]),observed=new Map(),capturing=new Set();
  assert.equal(responseCaptureNeeded(required,observed,capturing,'/data/_catalog/stale/temp/001.png'),false);
  assert.equal(responseCaptureNeeded(required,observed,capturing,path),true);capturing.add(path);assert.equal(responseCaptureNeeded(required,observed,capturing,path),false);
  let fallbacks=0;const discarded={body:async()=>{throw Error('response.body: Protocol error (Network.getResponseBody): No data found for resource with given identifier');}};
  assert.equal(discardedResponseBody(await discarded.body().catch(e=>e)),true);
  assert.deepEqual(await responseBodyOrFallback(discarded,async()=>{fallbacks++;return Buffer.from('exact');}),Buffer.from('exact'));assert.equal(fallbacks,1);
  const other={body:async()=>{throw Error('HTTP body truncated');}};await assert.rejects(()=>responseBodyOrFallback(other,async()=>{fallbacks++;return Buffer.from('wrong');}),/truncated/);assert.equal(fallbacks,1);
  const bytes=Buffer.from('exact'),expected={catalogId:'current',bytes:bytes.length,sha256:digest(bytes)},headers={get:name=>name==='x-weatherx-catalog'?'current':null};
  const fetched={url:'https://staging.weatherx.org'+path,status:200,headers};assert.deepEqual(validateFetchedObject(path,expected,fetched,bytes),bytes);
  for(const mutate of [r=>r.url='https://weatherx.org'+path,r=>r.url+='?redirected=1',r=>r.status=206,r=>r.headers={get:()=> 'stale'}]){
    const bad={...fetched};mutate(bad);assert.throws(()=>validateFetchedObject(path,expected,bad,bytes));
  }
  assert.throws(()=>validateFetchedObject(path,{...expected,bytes:bytes.length+1},fetched,bytes));assert.throws(()=>validateFetchedObject(path,{...expected,sha256:'0'.repeat(64)},fetched,bytes));
  capturing.clear();observed.set(path,DIGEST);assert.equal(responseCaptureNeeded(required,observed,capturing,path),false);
});
test('only production preflight adds a standalone weather-feed probe',()=>{
  assert.equal(standaloneWeatherFeedVerificationRequired('staging','preflight'),false);
  assert.equal(standaloneWeatherFeedVerificationRequired('production','preflight'),true);
  assert.equal(standaloneWeatherFeedVerificationRequired('staging','candidate'),false);
  assert.equal(standaloneWeatherFeedVerificationRequired('production','candidate'),false);
  assert.equal(standaloneWeatherFeedVerificationRequired('staging','rollback'),false);
  assert.equal(standaloneWeatherFeedVerificationRequired('production','rollback'),false);
  assert.throws(()=>standaloneWeatherFeedVerificationRequired('preview','preflight'));
  assert.throws(()=>standaloneWeatherFeedVerificationRequired('staging','unknown'));
});
test('browser receipt proves each selected model plus the exact latest-selection race',()=>{
  const body=selection(['icon','nam']),bundle=validateSelection(body,digest(body),NOW),selected=e=>({model:e.model,init:e.init,base:e.manifestPath.slice(0,-'manifest.json'.length)});
  const model=e=>({model:e.model,catalogId:e.catalogId,init:e.init,selected:selected(e),layers:['temp','wind','mslp'].map(field=>({field,changedRatio:.02,point:{kind:'independent-global',source:'ECMWF IFS 0.25°',mapModelFusionEligible:false}})),domain:{}});
  const receipt={schemaVersion:1,origin:'https://staging.weatherx.org',sourceSha:SHA,releaseId:`git-${SHA.slice(0,12)}-run-123`,selectionSha256:digest(body),qualifiedAt:new Date(NOW).toISOString(),models:[...bundle.entries.map(model),{rapidModelSequence:['icon','nam'],finalModel:'nam'}],verifiedObjectCount:12};
  const bytes=Buffer.from(JSON.stringify(receipt));validateBrowserReceipt(bytes,bundle,{sourceSha:SHA,releaseId:receipt.releaseId,selectionSha256:digest(body)},NOW);
  for(const mutate of [r=>r.models.pop(),r=>r.models.at(-1).finalModel='icon',r=>r.verifiedObjectCount=11]){const bad=structuredClone(receipt);mutate(bad);assert.throws(()=>validateBrowserReceipt(Buffer.from(JSON.stringify(bad)),bundle,{sourceSha:SHA,releaseId:receipt.releaseId,selectionSha256:digest(body)},NOW));}
});
test('release-roster core receipt binds two independent model proofs and never reads selection policy',()=>{
  const releaseRoster=MODELS.map((model,index)=>({model,status:index===0?'fresh':'absent',init:index===0?INIT:null,expectedSelectable:index===0,visible:index===0,enabled:index===0}));
  const row=(model,catalogId)=>({model,status:'ready',init:'2026-08-31T12:00:00Z',base:`/data/_catalog/${catalogId}/${model}/runs/${INIT}/`,catalogId,
    field:model==='hrrr'?'temp':'wind',deck:model==='hrrr'?'temp-raster':'wind-field',changedRatio:.12,finitePointValue:12.5,pointRunId:INIT,
    pointQuality:'complete',windAdmitted:model!=='hrrr',domain:{inside:true,outside:model==='hrrr'?true:null}});
  const receipt={schemaVersion:1,kind:'weatherx-staging-core-browser-receipt',origin:'https://staging.weatherx.org',sourceSha:SHA,
    releaseId:`git-${SHA.slice(0,12)}-run-123`,qualifiedAt:new Date(NOW).toISOString(),pointReleaseId:'cycle-123',releaseRoster,
    models:[row('aifs','catalog-aifs'),row('hrrr','catalog-hrrr')],rapidModelSequence:['aifs','hrrr'],finalModel:'hrrr',selectionRequests:[],errors:[]};
  const bytes=Buffer.from(JSON.stringify(receipt));assert.deepEqual(validateCoreBrowserReceipt(bytes,{sourceSha:SHA,releaseId:receipt.releaseId},NOW),receipt);
  const hourly=structuredClone(receipt),hrrr=hourly.models.find(model=>model.model==='hrrr');
  Object.assign(hrrr,{init:'2026-08-31T19:00:00Z',base:'/data/_catalog/catalog-hrrr/hrrr/runs/2026083119/',pointRunId:'2026083119'});
  assert.deepEqual(validateCoreBrowserReceipt(Buffer.from(JSON.stringify(hourly)),{sourceSha:SHA,releaseId:receipt.releaseId},NOW),hourly);
  for(const mutate of [r=>r.selectionRequests.push('/assets/staging-model-selection.json'),r=>r.models[1].field='wind',r=>r.models[1].windAdmitted=true,
    r=>r.models[0].pointRunId='2026083118',r=>r.models[0].base='/data/aifs/runs/2026083112/',r=>r.releaseRoster[0].visible=false,
    r=>r.models.pop(),r=>r.errors.push({model:'hrrr',error:'unavailable'}),r=>r.finalModel='aifs']){
    const bad=structuredClone(receipt);mutate(bad);assert.throws(()=>validateCoreBrowserReceipt(Buffer.from(JSON.stringify(bad)),{sourceSha:SHA,releaseId:receipt.releaseId},NOW));
  }
});
test('core browser inventory proof keeps every regional admission independent',()=>{
  const models=Object.fromEntries(MODELS.map(model=>[model,{status:'absent'}]));
  models.icon={status:'fresh',init:INIT,initTime:'2026-08-31T12:00:00Z',path:`runs/${INIT}/`};
  models['nam-hi']={status:'carried',init:'2026083100',initTime:'2026-08-31T00:00:00Z',path:'runs/2026083100/'};
  const roster={schemaVersion:1,kind:'weatherx-release-model-roster',createdAt:'2026-08-31T19:00:00Z',maxAgeHours:24,cycleHours:6,horizonHours:48,leadCount:49,fusionEligible:false,models};
  const proof=releaseRosterProof(roster,NOW);
  assert.deepEqual(proof.map(row=>[row.model,row.expectedSelectable]),MODELS.map(model=>[model,model==='icon'||model==='nam-hi']));
  models.nam={status:'fresh',init:'2026082912',initTime:'2026-08-29T12:00:00Z',path:'runs/2026082912/'};
  assert.equal(releaseRosterProof(roster,NOW).find(row=>row.model==='nam').expectedSelectable,false);
  assert.throws(()=>releaseRosterProof({...roster,horizonHours:72},NOW));
  assert.throws(()=>releaseRosterProof({...roster,models:{...models,icon:{...models.icon,path:'runs/other/'}}},NOW));
  const index=validateCoreIndex({schemaVersion:1,model:'hrrr',runs:[{init_time:'2026-08-31T12:00:00Z',path:`runs/${INIT}/`}]},'hrrr','catalog-hrrr');
  assert.equal(index.manifestPath,`/data/_catalog/catalog-hrrr/hrrr/runs/${INIT}/manifest.json`);
  assert.equal(coreCycle('hrrr','2026-09-05T19:00:00Z'),'2026090519');
  assert.equal(validateCoreIndex({schemaVersion:1,model:'hrrr',runs:[{init_time:'2026-09-05T19:00:00Z',path:'runs/2026090519/'}]},'hrrr','catalog-hourly').cycle,'2026090519');
  assert.throws(()=>coreCycle('aifs','2026-09-05T19:00:00Z'));
  for(const invalid of ['2026-09-05T24:00:00Z','2026-09-31T19:00:00Z','2026-09-05T19:30:00Z'])assert.throws(()=>coreCycle('hrrr',invalid));
  assert.throws(()=>validateCoreIndex({schemaVersion:1,model:'hrrr',runs:[]},'hrrr','catalog-hrrr'));
});
