import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {
  ACCOUNT_CORE_PROFILE,BASELINE_PROFILE,CORE_RELEASE_PROFILE,CORE_RELEASE_REQUEST,
  TC_APPROVAL,TC_RELEASE_PROFILE,TC_RELEASE_REQUEST,TC_SELECTION_ASSET,TC_SELECTION_SHA256,
  coreReleaseProfile,profileFor,readTcSelection,requireProductionProfile,requireStagingApproval,
  resolveSelectionRequest,tcGuidanceProfile,validateCandidateTcSelection,validateProfile,validateTcSelection,
} from '../tools/ui-staging-models.mjs';
import {publicBuildEnvironment,requiredSourceGuard,pipelineDigest,POLICY_FILES} from '../tools/ui-release.mjs';
import {CONTROL_SHA,MAX_FILES,STAGING_CONTROL_SHA,TC_CONTROL_SHA,controlShaFor,validateFiles} from '../tools/ui-candidate.mjs';
import {protocol,validateTcFixture,validateTcProofBytes,verifyControllerRoot} from '../tools/ui-staging-tc-proof.mjs';

const ROOT=resolve(new URL('..',import.meta.url).pathname);
const FIXTURE=resolve(ROOT,'staging-tc-selections',TC_SELECTION_SHA256);
const NOW=Date.parse('2026-09-10T16:00:00.000Z');
const sha=value=>createHash('sha256').update(value).digest('hex');

test('TC profile is exact, account-off, core-roster, independently approved and nonpromotable',()=>{
  assert.deepEqual(TC_RELEASE_PROFILE,{...CORE_RELEASE_PROFILE,tcGuidance:TC_APPROVAL,tcSelectionSha256:TC_SELECTION_SHA256});
  assert.equal(profileFor(TC_RELEASE_REQUEST),TC_RELEASE_PROFILE);assert.equal(tcGuidanceProfile(TC_RELEASE_PROFILE),true);
  assert.equal(coreReleaseProfile(TC_RELEASE_PROFILE),true);assert.equal(TC_RELEASE_PROFILE.account,false);assert.throws(()=>requireProductionProfile(TC_RELEASE_PROFILE));
  assert.equal(controlShaFor(TC_RELEASE_PROFILE),TC_CONTROL_SHA);assert.equal(requiredSourceGuard(TC_RELEASE_PROFILE),TC_CONTROL_SHA);
  assert.equal(MAX_FILES,5000);
  assert.equal(controlShaFor(BASELINE_PROFILE),CONTROL_SHA);assert.equal(controlShaFor(ACCOUNT_CORE_PROFILE),STAGING_CONTROL_SHA);
  for(const mutation of [{account:true},{stagingOnly:false},{tcGuidance:'other'},{tcSelectionSha256:'0'.repeat(64)},{extra:true}])
    assert.throws(()=>validateProfile({...TC_RELEASE_PROFILE,...mutation}));
  assert.equal(resolveSelectionRequest(TC_RELEASE_REQUEST,undefined,CORE_RELEASE_REQUEST,undefined,undefined,TC_APPROVAL),TC_RELEASE_REQUEST);
  assert.throws(()=>resolveSelectionRequest(TC_RELEASE_REQUEST,undefined,CORE_RELEASE_REQUEST,undefined,undefined,undefined),/TC profile approval/);
  assert.throws(()=>resolveSelectionRequest(TC_RELEASE_REQUEST,undefined,undefined,undefined,undefined,TC_APPROVAL),/core profile approval/);
});

test('reviewed TC selection and complete fixture inventory match every pinned digest',()=>{
  const read=readTcSelection(ROOT,TC_RELEASE_PROFILE,NOW);assert.equal(sha(read.bytes),TC_SELECTION_SHA256);
  const fixture=validateTcFixture(FIXTURE,TC_SELECTION_SHA256,NOW);assert.equal(fixture.selection.catalogId,'stage-tc-guidance-900007-1');
  assert.deepEqual(fixture.manifest.storms.map(storm=>storm.gdacsId),['1001315','1001320']);assert.equal(fixture.tracks.size,8);
  const component=JSON.parse(readFileSync(resolve(FIXTURE,'component.json')));assert.equal(component.objectCount,1+fixture.tracks.size);
  assert.throws(()=>validateTcSelection(read.bytes,TC_SELECTION_SHA256,Date.parse('2026-09-11T10:00:00.000Z')),/stale/);
  const changed=Buffer.from(read.bytes);changed[changed.length-2]^=1;assert.throws(()=>validateTcSelection(changed,TC_SELECTION_SHA256,NOW),/differ/);
});

test('candidate admission requires exact TC asset and old profiles reject it',()=>{
  const bytes=readFileSync(resolve(FIXTURE,'selection.json'));
  const candidate={profile:TC_RELEASE_PROFILE,files:[{path:TC_SELECTION_ASSET,base64:bytes.toString('base64')}]};
  assert.equal(validateCandidateTcSelection(candidate,NOW).catalogId,'stage-tc-guidance-900007-1');
  for(const mutate of [c=>c.files.splice(0),c=>c.files[0].base64=Buffer.from('wrong').toString('base64'),c=>c.profile=CORE_RELEASE_PROFILE]){
    const changed=structuredClone(candidate);mutate(changed);assert.throws(()=>validateCandidateTcSelection(changed,NOW));
  }
  assert.throws(()=>validateCandidateTcSelection({profile:ACCOUNT_CORE_PROFILE,files:candidate.files},NOW));
});

test('TC build flags override ambient account and TC state while every existing profile stays TC-off',()=>{
  const env=publicBuildEnvironment(TC_RELEASE_PROFILE,null,{VITE_PLATFORM_ACCOUNT:'1',VITE_TC_MODELS:'malicious',VITE_TC_MODELS_SELECTION_SHA256:'bad'});
  assert.equal(env.ATMOS_PUBLIC_RELEASE,'0');assert.equal(env.ATMOS_STAGING_EXPERIMENT_RELEASE,'1');assert.equal(env.ATMOS_STAGING_RELEASE_ROSTER,'1');
  assert.equal(env.VITE_PLATFORM_ACCOUNT,'0');assert.equal(env.ATMOS_STAGING_ACCOUNT_PROFILE,'');assert.equal(env.VITE_TC_MODELS,'1');assert.equal(env.VITE_TC_MODELS_SELECTION_SHA256,TC_SELECTION_SHA256);
  for(const profile of [BASELINE_PROFILE,CORE_RELEASE_PROFILE,ACCOUNT_CORE_PROFILE]){
    const off=publicBuildEnvironment(profile,null,{VITE_TC_MODELS:'1',VITE_TC_MODELS_SELECTION_SHA256:TC_SELECTION_SHA256});
    assert.equal(off.VITE_TC_MODELS,'0');assert.equal(off.VITE_TC_MODELS_SELECTION_SHA256,'');
  }
});

test('TC profile preserves the existing file ceiling',()=>{
  const empty=sha(Buffer.alloc(0)),required=['index.html','_worker.js','_routes.json','health/release.json'],paths=[...required,...Array.from({length:MAX_FILES-required.length+1},(_,index)=>`assets/tc-${index}.txt`)];
  const files=paths.map(path=>({path,bytes:0,sha256:empty,base64:''}));
  assert.throws(()=>validateFiles(files,CORE_RELEASE_PROFILE),/invalid file inventory|ordinary file limit/);
  assert.throws(()=>validateFiles(files,TC_RELEASE_PROFILE),/invalid file inventory|ordinary file limit/);
  assert.doesNotThrow(()=>validateFiles(files.slice(0,MAX_FILES),TC_RELEASE_PROFILE));
});

test('TC approvals bind both request and authenticated candidate',()=>{
  const bytes=readFileSync(resolve(FIXTURE,'selection.json')),candidate={profile:TC_RELEASE_PROFILE,files:[{path:TC_SELECTION_ASSET,base64:bytes.toString('base64')}]};
  const env={MODEL_SELECTION_SHA256:TC_RELEASE_REQUEST,UI_STAGING_CORE_PROFILE_APPROVED:CORE_RELEASE_REQUEST,UI_STAGING_TC_PROFILE_APPROVED:TC_APPROVAL};
  assert.equal(requireStagingApproval(candidate,env,NOW),null);
  for(const key of ['UI_STAGING_CORE_PROFILE_APPROVED','UI_STAGING_TC_PROFILE_APPROVED'])assert.throws(()=>requireStagingApproval(candidate,{...env,[key]:''},NOW));
  assert.throws(()=>requireStagingApproval({...candidate,profile:ACCOUNT_CORE_PROFILE},env,NOW));
});

test('isolated proof protocol and receipt are source, controller, fixture and no-cloud bound',()=>{
  const source='a'.repeat(40),run='123',release=`git-${source.slice(0,12)}-run-${run}`,fixture=validateTcFixture(FIXTURE,TC_SELECTION_SHA256,NOW);
  const env={BASE:'http://127.0.0.1:4166',UI_EXPECTED_SOURCE_SHA:source,WEATHERX_EXPECTED_RELEASE_ID:release,GITHUB_RUN_ID:run,
    UI_TC_SELECTION_SHA256:TC_SELECTION_SHA256,UI_TC_CONTROL_SHA:TC_CONTROL_SHA,UI_TC_FIXTURE_ROOT:FIXTURE,UI_TC_DIST:'/tmp/dist',UI_TC_PROOF_OUTPUT:'/tmp/proof.json',UI_CONTROL_ROOT:'/tmp/control'};
  assert.doesNotThrow(()=>protocol(env));for(const mutation of [{BASE:'https://staging.weatherx.org'},{UI_TC_CONTROL_SHA:STAGING_CONTROL_SHA},{CLOUDFLARE_API_TOKEN:'secret'}])assert.throws(()=>protocol({...env,...mutation}));
  const calls=[];assert.doesNotThrow(()=>verifyControllerRoot(ROOT,args=>{calls.push(args);return args[0]==='rev-parse'?TC_CONTROL_SHA:'';}));assert.deepEqual(calls,[['rev-parse','HEAD'],['diff','--exit-code','HEAD']]);
  assert.throws(()=>verifyControllerRoot(ROOT,args=>args[0]==='rev-parse'?STAGING_CONTROL_SHA:''),/unqualified/);
  const receipt={schemaVersion:1,kind:'weatherx-isolated-tc-ui-proof-v1',qualificationScope:'loopback-build-only-nonpromotable',sourceSha:source,releaseId:release,controllerSha:TC_CONTROL_SHA,
    selectionSha256:TC_SELECTION_SHA256,fixtureInventorySha256:fixture.inventorySha256,qualifiedAt:new Date(NOW).toISOString(),cloudWrites:0,sharedStagingDeploy:false,
    viewports:[{width:1440,height:1000,models:['gfs','ecmwf'],pinnedTrackRequests:2},{width:390,height:844,models:['gfs','ecmwf'],pinnedTrackRequests:2}]};
  const bytes=Buffer.from(JSON.stringify(receipt));assert.equal(validateTcProofBytes(bytes,{sourceSha:source,releaseId:release,fixtureInventorySha256:fixture.inventorySha256},NOW).cloudWrites,0);
  for(const mutation of [{cloudWrites:1},{sharedStagingDeploy:true},{selectionSha256:'0'.repeat(64)},{sourceSha:'b'.repeat(40)},{viewports:[receipt.viewports[0],receipt.viewports[0]]},{viewports:[receipt.viewports[1],receipt.viewports[1]]}]){
    const changed={...receipt,...mutation};assert.throws(()=>validateTcProofBytes(Buffer.from(JSON.stringify(changed)),{sourceSha:source,releaseId:release,fixtureInventorySha256:fixture.inventorySha256},NOW));
  }
});

test('separate workflow has exact pins, current-master guard, encrypted output and no deploy capability',()=>{
  const workflow=readFileSync(resolve(ROOT,'.github/workflows/ui-staging-tc.yml'),'utf8'),shared=readFileSync(resolve(ROOT,'.github/workflows/ui-staging.yml'),'utf8');
  assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/\n  (?:schedule|push|pull_request|workflow_run):/);
  assert.match(workflow,new RegExp(TC_CONTROL_SHA));assert.match(workflow,new RegExp(TC_SELECTION_SHA256));assert.match(workflow,/rev-parse origin\/master/);
  assert.match(workflow,/npm run --prefix atmos\/app preview -- --host 127\.0\.0\.1 --port 4166 --strictPort/);
  assert.match(workflow,/ui-staging-tc-proof\.mjs/);assert.match(workflow,/ui-release\.mjs pack-build/);assert.match(workflow,/ui-tc-build-/);
  assert.doesNotMatch(workflow,/UI_STAGING_PAGES_TOKEN|CLOUDFLARE_API_TOKEN|UI_CANDIDATE_KEY|ui-release\.mjs deploy|wrangler pages deploy|weatherx-platform-staging/);
  assert.match(shared,/default: approved/);assert.doesNotMatch(shared,/release-roster-core-tc-v1|UI_STAGING_TC_PROFILE_APPROVED/);
  assert.ok(POLICY_FILES.includes('.github/workflows/ui-staging-tc.yml'));assert.ok(POLICY_FILES.includes('tools/ui-staging-tc-proof.mjs'));
  assert.notEqual(pipelineDigest(TC_RELEASE_PROFILE),pipelineDigest(CORE_RELEASE_PROFILE));
});
