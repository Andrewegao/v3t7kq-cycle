import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT, MODELS, gate, hash, objectKey, seal, unseal, validateReceipt, archiveInputs, createArchiveS3 } from '../tools/model-inputs.mjs';

const now = Date.parse('2026-08-31T20:00:00Z');
const key = 'ab'.repeat(32);
const env = () => ({ GITHUB_ACTIONS:'true', RUNNER_ENVIRONMENT:'github-hosted', GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',
  GITHUB_JOB:'collect',GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/model-inputs.yml@refs/heads/main',
  GITHUB_EVENT_NAME:'workflow_dispatch', GITHUB_REF:'refs/heads/main', GITHUB_RUN_ID:'1234', GITHUB_RUN_ATTEMPT:'1',
  STAGING_DATA_ISOLATION_APPROVED:'true', STAGING_MODEL_COLLECTION_ENABLED:'true', STAGING_R2_ACCOUNT_ID:ACCOUNT,
  MODEL_SOURCE_SHA:'a'.repeat(40), STAGING_MODEL_APPROVED_SOURCE_SHA:'a'.repeat(40), MODEL_INIT:'2026083112', MODEL_ID:'icon' });
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'wx-model-inputs-test-')));
  const values={'raw/input.grib2':Buffer.from('native-original'), 'quantitative/lead.npz':Buffer.from('floats'),
    'staged/index.json':Buffer.from('{}'), 'proof/source-receipt.json':Buffer.from('{"publishable":false}')};
  const inventory=Object.entries(values).map(([path,body])=>{
    mkdirSync(join(root,path,'..'),{recursive:true}); writeFileSync(join(root,path),body);
    return {path,bytes:body.length,sha256:hash(body)};
  }).sort((a,b)=>a.path<b.path?-1:1);
  const receipt={schemaVersion:1,kind:'weatherx-cloud-model-inputs',status:'COLLECTED',qualification:'unqualified',
    cloud:{runId:'1234',runAttempt:'1',runnerEnvironment:'github-hosted'},leadCount:49,horizonHours:48,
    sourceSha:'a'.repeat(40),model:'icon',init:'2026083112',sourceReceiptSha256:hash(values['proof/source-receipt.json']),
    complete:true,publishable:false,renderReady:false,fusionEligible:false,weatherxFusionIssued:false,
    createdAt:new Date(now).toISOString(),sourceReceipt:'proof/source-receipt.json',stagedRoot:'staged',
    inventory,totalBytes:inventory.reduce((n,x)=>n+x.bytes,0)};
  const bytes=Buffer.from(JSON.stringify(receipt)); writeFileSync(join(root,'cloud-input-receipt.json'),bytes);
  const objects=new Map(), calls=[];
  const io={async get(k){calls.push(['get',k]);return objects.get(k)??null;},async put(k,b){calls.push(['put',k]);assert.ok(!objects.has(k));objects.set(k,Buffer.from(b));},
    async list(prefix){calls.push(['list',prefix]);return [...objects.keys()].filter(x=>x.startsWith(prefix)).sort();}};
  return {root,receipt,bytes,objects,calls,io};
}
test('only seven additions on approved hosted manual main and exact fresh source',()=>{
  assert.equal(MODELS.length,7); assert.equal(gate(env(),now).model,'icon');
  assert.equal(gate({...env(),GITHUB_JOB:'collect-independent'},now).model,'icon');
  for(const name of Object.keys(env()))assert.throws(()=>gate({...env(),[name]:''},now),undefined,name);
  for(const patch of [{MODEL_ID:'access-g3'},{MODEL_ID:'ecmwf'},{MODEL_INIT:'2026023012'},{MODEL_INIT:'2026083113'},
    {MODEL_INIT:'2026083100'},{MODEL_INIT:'2026083118',GITHUB_EVENT_NAME:'schedule'},
    {STAGING_R2_ACCOUNT_ID:'b'.repeat(32)},{MODEL_SOURCE_SHA:'b'.repeat(40)},{GITHUB_REF:'refs/heads/experiment'},
    {GITHUB_JOB:'collect-noaa'},{GITHUB_JOB:'collect-independent-extra'}])
    assert.throws(()=>gate({...env(),...patch},now));
});
test('ciphertext authenticates key, object identity, digest and every byte',()=>{
  const plain=Buffer.from('private scientific inputs'), path='staging-candidates/model-inputs/test';
  const encrypted=seal(plain,key,path,hash(plain));
  assert.equal(encrypted.includes(plain),false); assert.deepEqual(unseal(encrypted,key,path,hash(plain)),plain);
  for(const args of [[encrypted,'cd'.repeat(32),path,hash(plain)],[encrypted,key,path+'other',hash(plain)],
    [encrypted,key,path,'f'.repeat(64)],[encrypted.subarray(1),key,path,hash(plain)]])assert.throws(()=>unseal(...args));
  const corrupt=Buffer.from(encrypted);corrupt[corrupt.length-1]^=1;assert.throws(()=>unseal(corrupt,key,path,hash(plain)));
});
test('private object keys cannot address publication pointers or expose source paths',()=>{
  const pin=gate(env(),now), a=objectKey(pin,'proof/source-receipt.json');
  assert.match(a,/^staging-candidates\/model-inputs\/[a-f0-9]{40}\/icon\/2026083112\/1234-1\/objects\/[a-f0-9]{64}\.wxmi$/);
  for(const name of ['../escape','/absolute','a//b','a/../b','a\\b','a?x','.git/config'])assert.throws(()=>objectKey(pin,name));
});
test('receipt preserves holds, exact identity, inventory and resource budgets',()=>{
  const f=fixture(),pin=gate(env(),now); validateReceipt(f.receipt,pin,now);
  for(const change of [r=>r.publishable=true,r=>r.model='gfs',r=>r.sourceSha='b'.repeat(40),r=>r.init='2026083106',
    r=>r.totalBytes++,r=>r.inventory.push(r.inventory[0]),r=>r.inventory[0].path='../secret',
    r=>r.inventory[0].bytes=1024**3,r=>r.inventory[0].sha256='no',r=>r.sourceReceipt='absent.json',
    r=>r.createdAt='2026-08-31T21:00:00Z',r=>r.stagedRoot='raw',r=>r.renderReady=true,
    r=>r.cloud.runId='9999',r=>r.cloud.runAttempt='9',r=>r.cloud.runnerEnvironment='self-hosted',
    r=>r.leadCount=1,r=>r.horizonHours=0,r=>r.status='PARTIAL',r=>r.qualification='passed',
    r=>r.sourceReceiptSha256='e'.repeat(64)]){
    const r=structuredClone(f.receipt);change(r);assert.throws(()=>validateReceipt(r,pin,now));
  }
});
test('all source bytes validate before write; all encrypted bytes read back; minimal completion last',async()=>{
  const f=fixture(),pin=gate(env(),now);const result=await archiveInputs({root:f.root,pin,key,io:f.io,now:()=>now});
  assert.equal(result.activated,false);assert.equal(result.productionWritten,false);assert.equal(result.objects,4);
  assert.match(f.calls.filter(x=>x[0]==='put').at(-1)[1],/\/complete.json$/);
  for(const [path,body] of f.objects){assert.ok(path.startsWith('staging-candidates/model-inputs/'));
    if(!path.endsWith('/complete.json'))assert.equal(body.includes(Buffer.from('native-original')),false);
  }
  const puts=f.calls.filter(x=>x[0]==='put').length;
  await archiveInputs({root:f.root,pin,key,io:f.io,now:()=>now});assert.equal(f.calls.filter(x=>x[0]==='put').length,puts);
});
test('missing, additional, equal-size changed and symlink inputs fail before writes',async()=>{
  for(const mutate of [f=>writeFileSync(join(f.root,'raw/input.grib2'),'changed-native!'),
    f=>writeFileSync(join(f.root,'extra.txt'),'secret'),f=>symlinkSync(join(f.root,'raw/input.grib2'),join(f.root,'link'))]){
    const f=fixture();mutate(f);await assert.rejects(archiveInputs({root:f.root,pin:gate(env(),now),key,io:f.io,now:()=>now}));
    assert.equal(f.calls.filter(x=>x[0]==='put').length,0);
  }
});
test('readback corruption, wrong existing objects and late expiry never produce completion',async()=>{
  for(const mode of ['readback','existing','late']){
    const f=fixture(),pin=gate(env(),now);let clock=now;
    if(mode==='existing')f.objects.set(objectKey(pin,f.receipt.inventory[0].path),Buffer.from('bad ciphertext'));
    const original=f.io.put;f.io.put=async(k,b)=>{await original(k,b);if(mode==='readback')f.objects.set(k,Buffer.from('bad ciphertext'));if(mode==='late')clock=now+5*3600_000;};
    await assert.rejects(archiveInputs({root:f.root,pin,key,io:f.io,now:()=>clock}));
    assert.ok(![...f.objects.keys()].some(x=>x.endsWith('/complete.json')));
  }
});
test('late source mutation, changed private receipt and extra remote data block completion',async()=>{
  for(const mode of ['input','receipt','extra']){
    const f=fixture(),pin=gate(env(),now),put=f.io.put;let mutated=false;
    f.io.put=async(k,b)=>{await put(k,b);if(mutated)return;mutated=true;
      if(mode==='input')writeFileSync(join(f.root,'raw/input.grib2'),'native-ALTERED');
      if(mode==='receipt')writeFileSync(join(f.root,'cloud-input-receipt.json'),'{}');
      if(mode==='extra')f.objects.set(k.replace(/objects\/.+$/, 'objects/'+'e'.repeat(64)+'.wxmi'),Buffer.from('extra'));
    };
    await assert.rejects(archiveInputs({root:f.root,pin,key,io:f.io,now:()=>now}));
    assert.ok(![...f.objects.keys()].some(x=>x.endsWith('/complete.json')));
  }
});
test('actual S3 command construction cannot read or write another bucket/prefix or overwrite',async()=>{
  const calls=[],pin=gate(env(),now),target=objectKey(pin,'raw/lead.grib2');
  const client={async send(command){calls.push(command);if(command.constructor.name==='GetObjectCommand')throw {$metadata:{httpStatusCode:404}};
    if(command.constructor.name==='ListObjectsV2Command')return {Contents:[],IsTruncated:false};return {};},destroy(){}};
  const io=await createArchiveS3({...env(),STAGING_R2_WRITE_ACCESS_KEY_ID:'fixture',STAGING_R2_WRITE_SECRET_ACCESS_KEY:'fixture',
    AWS_ACCESS_KEY_ID:'broad-unused',CLOUDFLARE_API_TOKEN:'broad-unused'},pin,client);
  assert.equal(await io.get(target),null);await io.put(target,Buffer.from('ciphertext'));
  const base=target.slice(0,target.indexOf('objects/'));assert.deepEqual(await io.list(base),[]);
  for(const path of ['releases/current.json','catalogs/current.json','components/icon/test','../escape',base+'objects/../receipt.wxmi',base+'private.json']){
    await assert.rejects(io.get(path));await assert.rejects(io.put(path,Buffer.from('x')));await assert.rejects(io.list(path));
  }
  assert.ok(calls.every(c=>c.input.Bucket==='weatherx-data-staging'));
  const put=calls.find(c=>c.constructor.name==='PutObjectCommand');assert.equal(put.input.IfNoneMatch,'*');assert.equal(put.input.CacheControl,'private, no-store');
  assert.deepEqual(calls.map(c=>c.constructor.name),['GetObjectCommand','PutObjectCommand','ListObjectsV2Command']);
});
test('S3 truncated bodies, repeated pagination and unknown keys fail closed with redacted errors',async()=>{
  const pin=gate(env(),now),target=objectKey(pin,'raw/file.grib2'),base=target.slice(0,target.indexOf('objects/'));
  for(const mode of ['truncated','pagination','key','error']){
    const io=await createArchiveS3({...env(),STAGING_R2_WRITE_ACCESS_KEY_ID:'fixture',STAGING_R2_WRITE_SECRET_ACCESS_KEY:'fixture'},pin,{
      async send(c){if(mode==='error')throw {message:'secret-sensitive-server-error',$metadata:{httpStatusCode:403}};
        if(mode==='pagination')return {Contents:[],IsTruncated:true,NextContinuationToken:'same'};
        if(mode==='key')return {Contents:[{Key:'releases/current.json',Size:1}],IsTruncated:false};
        return {ContentLength:2,Body:{async *[Symbol.asyncIterator](){yield Buffer.from('1');},destroy(){}}};},destroy(){}});
    if(mode==='truncated')await assert.rejects(io.get(target));
    else if(mode==='error')await assert.rejects(io.get(target),e=>!e.message.includes('secret-sensitive'));
    else await assert.rejects(io.list(base));
  }
});
