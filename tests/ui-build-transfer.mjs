import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { packBuild, unpackBuild, eligibleBuild } from '../tools/ui-build-transfer.mjs';
import { hash, PROFILE, CONTROL_SHA, REPOSITORY, unseal, seal, validateFiles, validateCandidate, controlShaFor } from '../tools/ui-candidate.mjs';
import {ACCOUNT_CORE_PROFILE,requireProductionProfile} from '../tools/ui-staging-models.mjs';
const keys=generateKeyPairSync('rsa',{modulusLength:3072,
  publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const context={sourceSha:'a'.repeat(40),workflowSha:'b'.repeat(40),runId:'123',attempt:'1',pipelineDigest:'c'.repeat(64)};
function candidate(profile=PROFILE,buildProfile=undefined) {
  const contents={'index.html':'WeatherX','_worker.js':'private compiled functions','_routes.json':'{"version":1,"include":["/api/*"],"exclude":[]}'};
  const digest=createHash('sha256');
  const files=Object.entries(contents).sort(([a],[b])=>a<b?-1:1).map(([path,text])=>{
    const bytes=Buffer.from(text);digest.update(path).update('\0').update(String(bytes.length)).update('\0').update(bytes).update('\0');
    return {path,bytes:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64')};
  });
  const receipt={gitSha:context.sourceSha,workflowRunId:context.runId,releaseId:`git-${context.sourceSha.slice(0,12)}-run-123`,
    ...(buildProfile===undefined?{}:{buildProfile}),
    shellSha256:digest.digest('hex'),shellFileCount:3,shellBytes:files.reduce((n,f)=>n+f.bytes,0),indexSha256:hash('WeatherX')};
  const bytes=Buffer.from(JSON.stringify(receipt));files.push({path:'health/release.json',bytes:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64')});
  return {schemaVersion:1,controlSha:controlShaFor(profile),profile,...context,files,artifactDigest:validateFiles(files,profile).digest};
}
const records=()=>({run:{repository:{full_name:REPOSITORY},path:'.github/workflows/ui-staging.yml',event:'workflow_dispatch',
  head_branch:'main',id:123,run_attempt:1,head_sha:context.workflowSha},
  jobs:[{name:'build',status:'completed',conclusion:'success',head_sha:context.workflowSha}],
  artifacts:[{name:'ui-build-123-1',expired:false,size_in_bytes:999}]});
test('public-key envelope preserves exact unqualified build without exposing private compiled code',()=>{
  const c=candidate(), bytes=packBuild(c,keys.publicKey);
  assert.deepEqual(unpackBuild(bytes,keys.privateKey),c);
  assert.ok(!bytes.includes(Buffer.from('private compiled functions')));
  assert.ok(!bytes.equals(packBuild(c,keys.publicKey)));
  assert.throws(()=>unseal(bytes,'ab'.repeat(32)),'unqualified transport cannot enter production promotion');
  assert.throws(()=>seal(c,'ab'.repeat(32)),'unqualified payload cannot be sealed as qualified');
});
test('account profile and build receipt survive encrypted transfer without promotion or relabeling',()=>{
  const profile=ACCOUNT_CORE_PROFILE,buildProfile={product:'lab',platformAccount:'1',platformDataAuth:'public'};
  const c=candidate(profile,buildProfile),bytes=packBuild(c,keys.publicKey),decoded=unpackBuild(bytes,keys.privateKey);
  assert.deepEqual(decoded,c);validateCandidate(decoded);
  assert.throws(()=>requireProductionProfile(decoded.profile));
  assert.throws(()=>validateCandidate({...decoded,profile:PROFILE,controlSha:CONTROL_SHA}),/relabeled/);
  for(const bad of [undefined,{...buildProfile,platformAccount:'0'},{...buildProfile,platformDataAuth:'enforce'},
    {...buildProfile,product:'road'},{...buildProfile,extra:true}])
    assert.throws(()=>packBuild(candidate(profile,bad),keys.publicKey),/receipt differs/);
  const r=records();
  eligibleBuild(decoded,r.run,r.jobs,r.artifacts,{...context,profile});
  assert.throws(()=>eligibleBuild(decoded,r.run,r.jobs,r.artifacts,{...context,profile:PROFILE}),/differs from requested profile/);
});
test('account profile authenticates only the exact optional Wind100 receipt shape',()=>{
  const wind100={catalogId:'stage-wind100-34547542747-1',runId:'2026091000',selectionSha256:'e'.repeat(64)};
  const buildProfile={product:'lab',platformAccount:'1',platformDataAuth:'public',wind100};
  const c=candidate(ACCOUNT_CORE_PROFILE,buildProfile),decoded=unpackBuild(packBuild(c,keys.publicKey),keys.privateKey);
  assert.deepEqual(validateCandidate(decoded).buildProfile.wind100,wind100);
  for(const mutate of [p=>p.wind100.extra=true,p=>p.wind100.catalogId='stage-wind100-other',p=>p.wind100.runId='2026093124',
    p=>p.wind100.selectionSha256='E'.repeat(64),p=>p.wind100=null]){
    const bad=structuredClone(buildProfile);mutate(bad);assert.throws(()=>packBuild(candidate(ACCOUNT_CORE_PROFILE,bad),keys.publicKey));
  }
  assert.throws(()=>packBuild(candidate(PROFILE,{product:'lab',platformAccount:'0',platformDataAuth:'public',wind100}),keys.publicKey),/cannot enter another profile/);
});
test('build ciphertext, header, length, recipient and fake qualification fail closed',()=>{
  const c=candidate(), bytes=packBuild(c,keys.publicKey);
  for(const offset of [0,6,8,391,392,404,430,bytes.length-1]){
    const b=Buffer.from(bytes);b[offset]^=1;assert.throws(()=>unpackBuild(b,keys.privateKey));
  }
  assert.throws(()=>unpackBuild(bytes,keys.publicKey));assert.throws(()=>packBuild(c,keys.privateKey));
  assert.throws(()=>packBuild({...c,qualification:{fullTests:true}},keys.publicKey));
  const other=generateKeyPairSync('rsa',{modulusLength:3072,privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  assert.throws(()=>unpackBuild(bytes,other.privateKey));
});
test('publisher requires a successful exact source/run/attempt/job/artifact and current policy',()=>{
  const c=candidate(), r=records();eligibleBuild(c,r.run,r.jobs,r.artifacts,context);
  for(const mutate of [x=>x.run.run_attempt++,x=>x.run.id++,x=>x.run.event='push',x=>x.run.head_branch='feature',
    x=>x.run.head_sha='d'.repeat(40),x=>x.run.repository.full_name='attacker/repo',x=>x.run.path='.github/workflows/bake.yml',
    x=>x.jobs[0].conclusion='failure',x=>x.jobs[0].status='in_progress',x=>x.jobs[0].head_sha='d'.repeat(40),
    x=>x.jobs.push(x.jobs[0]),x=>x.jobs=[],x=>x.artifacts[0].name='ui-build-123-2',
    x=>x.artifacts[0].expired=true,x=>x.artifacts.push(x.artifacts[0])]){
    const bad=records();mutate(bad);assert.throws(()=>eligibleBuild(c,bad.run,bad.jobs,bad.artifacts,context));
  }
  for(const field of Object.keys(context))assert.throws(()=>eligibleBuild(c,r.run,r.jobs,r.artifacts,{...context,[field]:'bad'}));
});
