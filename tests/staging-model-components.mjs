import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {ACCOUNT,hash,seal,objectKey} from '../tools/model-inputs.mjs';
import {canonical,request,gate,archivePrefix,restoreArchive,displayPaths,validateDisplayReceipt,publishDisplay,makeCatalog,publicationTarget,assertSuperset,SCIENCE,DATA,COMPONENTS,createPublicationS3} from '../tools/staging-model-components.mjs';
// Reader tests reuse synthetic files, not registration of this suite twice.
const test=process.argv[1]===fileURLToPath(import.meta.url)?nodeTest:()=>{};
const encode=x=>Buffer.from(JSON.stringify(x)+'\n');
export const NOW=Date.parse('2026-08-31T20:00:00Z');
export function fixture(t){
  const temp=realpathSync(mkdtempSync(resolve(tmpdir(),'weatherx-model-display-test-')));t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_JOB:'qualify',
    GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/staging-model-components.yml@refs/heads/main',GITHUB_RUN_ID:'9876',GITHUB_RUN_ATTEMPT:'1',STAGING_R2_ACCOUNT_ID:ACCOUNT,
    STAGING_DATA_ISOLATION_APPROVED:'true',STAGING_MODEL_COMPONENTS_ENABLED:'true',MODEL_SOURCE_SHA:'a'.repeat(40),MODEL_VALIDATOR_SHA:'b'.repeat(40),MODEL_ID:'icon',MODEL_INIT:'2026083112',ARCHIVE_RUN_ID:'1234',ARCHIVE_RUN_ATTEMPT:'1',PRIOR_CATALOG_ID:'none',PRIOR_CATALOG_SHA256:'none',
    STAGING_MODEL_APPROVED_SOURCE_SHA:'a'.repeat(40),STAGING_MODEL_VALIDATOR_SOURCE_SHA:'b'.repeat(40)};
  const pin={sourceSha:env.MODEL_SOURCE_SHA,model:env.MODEL_ID,init:env.MODEL_INIT,runId:env.ARCHIVE_RUN_ID,attempt:env.ARCHIVE_RUN_ATTEMPT},key='c'.repeat(64);
  const inputFiles={'retained/source.json':encode({privatePath:'/private/original/path'}),'staged/icon/index.json':encode({model:'icon'}),'staged/icon/runs/2026083112/qualification.json':encode({publishable:false})};
  const inventory=Object.entries(inputFiles).sort().map(([path,body])=>({path,bytes:body.length,sha256:hash(body)}));
  const archive={schemaVersion:1,kind:'weatherx-cloud-model-inputs',status:'COLLECTED',qualification:'unqualified',...pin,complete:true,publishable:false,renderReady:false,fusionEligible:false,weatherxFusionIssued:false,
    createdAt:new Date(NOW-60000).toISOString(),cloud:{runId:pin.runId,runAttempt:pin.attempt,runnerEnvironment:'github-hosted'},leadCount:49,horizonHours:48,
    inventory,totalBytes:inventory.reduce((a,r)=>a+r.bytes,0),sourceReceipt:'retained/source.json',sourceReceiptSha256:inventory[0].sha256,stagedRoot:'staged/icon',timelineReceipt:'staged/icon/runs/2026083112/qualification.json'};
  const archiveBytes=encode(archive);env.ARCHIVE_RECEIPT_SHA256=hash(archiveBytes);
  const base=archivePrefix(pin),encryptedReceipt=seal(archiveBytes,key,base+'receipt.wxmi',hash(archiveBytes));
  const marker={schemaVersion:1,kind:'weatherx-private-cloud-input-archive',...pin,objects:inventory.length,bytes:archive.totalBytes,receiptSha256:hash(archiveBytes),receiptCipherSha256:hash(encryptedReceipt),archiveKeyId:hash(Buffer.from(key,'hex')).slice(0,16),encrypted:true,activated:false,productionWritten:false,publishable:false,renderReady:false,fusionEligible:false,weatherxFusionIssued:false};
  const markerBytes=encode(marker);env.ARCHIVE_MARKER_SHA256=hash(markerBytes);env.STAGING_MODEL_COMPONENTS_APPROVED_REQUESTS_JSON=JSON.stringify({icon:hash(canonical(request(env)))});
  const ctx=gate(env,NOW),remoteArchive=new Map([[base+'receipt.wxmi',encryptedReceipt],[base+'complete.json',markerBytes],...inventory.map(row=>[objectKey(pin,row.path),seal(inputFiles[row.path],key,objectKey(pin,row.path),row.sha256)])]);
  const archiveIO={get:async key=>remoteArchive.get(key)??null,list:async prefix=>[...remoteArchive.keys()].filter(k=>k.startsWith(prefix)).sort()};
  const archiveRoot=resolve(temp,'original'),root=resolve(temp,'qualified'),control=resolve(temp,'control');
  for(const p of [archiveRoot,root,control])mkdirSync(p,{mode:0o700});
  function write(root,path,body){const p=resolve(root,path);mkdirSync(dirname(p),{recursive:true});writeFileSync(p,body);}
  write(archiveRoot,'cloud-input-receipt.json',archiveBytes);
  const grid={width:2,height:2,lon0:-180,lon1:180,lat0:90,lat1:-90},variables={temp:{file:'temp/{i}.png',channels:['t2m'],units:'degC'},wind:{file:'wind/{i}.png',channels:['u10','v10'],units:'m/s'},mslp:{file:'mslp/{i}.png',channels:['mslp'],units:'hPa'},mask:{file:'mask.png'}};
  const m={schemaVersion:1,model:'icon',init_time:'2026-08-31T12:00:00Z',grid,variables,windReference:'earth-relative',qualification:{publishable:false,fusionEligible:false,productionActivation:false},frames:Array.from({length:49},(_,i)=>({i,valid_time:new Date(Date.parse('2026-08-31T12:00:00Z')+i*3600_000).toISOString()}))};
  const payload=new Map(displayPaths(pin.init).map(path=>[path,path==='index.json'?encode({schemaVersion:1,model:'icon',runs:[{init_time:m.init_time,path:'runs/2026083112/'}]}):path.endsWith('/manifest.json')?encode(m):Buffer.from('synthetic-not-real-PNG:'+path)]));
  const displayInventory=[...payload].map(([path,b])=>({path,bytes:b.length,sha256:hash(b)}));
  const q={schemaVersion:1,kind:'weatherx-staging-model-display',status:'staging-data-qualified-not-activated',model:'icon',init:pin.init,collectorSourceSha:pin.sourceSha,validatorSourceSha:ctx.validatorSha,cloudSource:{runId:pin.runId,runAttempt:pin.attempt},validatorRun:{runId:'9876',runAttempt:'1',runnerEnvironment:'github-hosted'},archiveReceiptSha256:ctx.receiptSha256,archiveMarkerSha256:ctx.markerSha256,sourceReceiptSha256:archive.sourceReceiptSha256,stagedQualificationSha256:inventory.at(-1).sha256,createdAt:new Date(NOW).toISOString(),leadCount:49,horizonHours:48,displayInventory,displayInventorySha256:hash(canonical(displayInventory)),grid,variables,windReference:'earth-relative',scientificChecks:SCIENCE,stagingDataQualified:true,originalHoldsPreserved:true,browserQualified:false,fusionEligible:false,productionActivation:false,weatherxFusionIssued:false,publishable:false};
  for(const [path,body] of payload)write(resolve(root,'display'),path,body);write(root,'qualification.json',encode(q));
  const objects=new Map(),writes=[],hooks={};
  const http=key=>({contentType:key.endsWith('.png')?'image/png':'application/json',cacheControl:'public, max-age=31536000, immutable'});
  function save(bucket,key,body,metadata={}){objects.set(bucket+'/'+key,{body:Buffer.from(body),metadata, httpMetadata:http(key)});}
  const io={get:async(bucket,key)=>{const o=objects.get(bucket+'/'+key);return o?{...structuredClone(o),body:Buffer.from(o.body)}:null;},hashObject:async(bucket,key)=>{const o=objects.get(bucket+'/'+key);if(!o)return null;await hooks.beforeHash?.(bucket,key);return {bytes:o.body.length,sha256:hash(o.body),metadata:o.metadata,httpMetadata:o.httpMetadata};},
    list:async(bucket,prefix)=>[...objects].filter(([key])=>key.startsWith(bucket+'/'+prefix)).map(([key,o])=>({key:key.slice(bucket.length+1),bytes:o.body.length})),
    put:async(bucket,key,body,metadata)=>{await hooks.beforePut?.(bucket,key,body);publicationTarget(ctx,bucket,key);assert.ok(!objects.has(bucket+'/'+key));writes.push({bucket,key});save(bucket,key,body,metadata);await hooks.afterPut?.(bucket,key);}};
  const reader={isDataCatalog:v=>v.schemaVersion===2&&!!v.components,loadCatalogById:async(id,deps)=>{const o=await deps.bucket.get('catalogs/snapshots/'+id+'.json');assert.equal(hash(Buffer.from(await o.arrayBuffer())),o.customMetadata.sha256);return JSON.parse(Buffer.from(await o.arrayBuffer()));}};
  return {ctx,env,pin,key,base,archive,archiveBytes,markerBytes,remoteArchive,archiveIO,archiveRoot,root,control,temp,write,q,m,io,reader,objects,writes,hooks,save,now:()=>NOW};
}
test('manual main hosted staging and exact request approval are mandatory',t=>{
  const f=fixture(t);assert.equal(gate(f.env,NOW).catalogId,'stage-icon-9876-1');
  for(const [k,v] of Object.entries({GITHUB_REF:'refs/heads/test',GITHUB_EVENT_NAME:'schedule',GITHUB_JOB:'collect',GITHUB_WORKFLOW_REF:'other',STAGING_R2_ACCOUNT_ID:'other',STAGING_MODEL_COMPONENTS_ENABLED:'false',STAGING_MODEL_VALIDATOR_SOURCE_SHA:'c'.repeat(40),ARCHIVE_RUN_ID:'9999',PRIOR_CATALOG_ID:'production'}))assert.throws(()=>gate({...f.env,[k]:v},NOW),k);
  assert.throws(()=>gate(f.env,NOW+24*3600_000));
});
test('per-model approvals admit independent parallel requests without replacement races',t=>{
  const f=fixture(t),nam={...f.env,MODEL_ID:'nam'},iconSha=hash(canonical(request(f.env))),namSha=hash(canonical(request(nam)));
  const approvals=JSON.stringify({icon:iconSha,nam:namSha});
  assert.equal(gate({...f.env,STAGING_MODEL_COMPONENTS_APPROVED_REQUESTS_JSON:approvals},NOW).pin.model,'icon');
  assert.equal(gate({...nam,STAGING_MODEL_COMPONENTS_APPROVED_REQUESTS_JSON:approvals},NOW).pin.model,'nam');
  for(const invalid of [undefined,'null','[]','{}','{','x'.repeat(2049),JSON.stringify({unknown:iconSha}),JSON.stringify({icon:'bad'}),JSON.stringify({nam:namSha}),JSON.stringify({icon:namSha,nam:iconSha})]){
    assert.throws(()=>gate({...f.env,STAGING_MODEL_COMPONENTS_APPROVED_REQUESTS_JSON:invalid},NOW));
  }
  // Approving an unrelated model cannot alter ICON's exact archive/prior pin.
  assert.throws(()=>gate({...f.env,ARCHIVE_RUN_ID:'9999',STAGING_MODEL_COMPONENTS_APPROVED_REQUESTS_JSON:approvals},NOW));
});
test('actual encrypted archive restores privately with exact invocation and files',async t=>{
  const f=fixture(t);rmSync(f.archiveRoot,{recursive:true});mkdirSync(f.archiveRoot,{mode:0o700});
  await restoreArchive(f.ctx,{io:f.archiveIO,key:f.key,root:f.archiveRoot,control:f.control,now:f.now});
  assert.deepEqual(readFileSync(resolve(f.archiveRoot,'cloud-input-receipt.json')),f.archiveBytes);
  assert.deepEqual(readFileSync(resolve(f.control,'archive-marker.json')),f.markerBytes);
});
test('incomplete, wrong-key, tampered or extra archive never completes restore',async t=>{
  for(const mode of ['missing','key','cipher','extra']){const f=fixture(t);rmSync(f.archiveRoot,{recursive:true});mkdirSync(f.archiveRoot,{mode:0o700});
    let key=f.key;if(mode==='missing')f.remoteArchive.delete(f.base+'complete.json');if(mode==='key')key='d'.repeat(64);
    if(mode==='cipher'){const row=f.archive.inventory[0],name=objectKey(f.pin,row.path);const bytes=Buffer.from(f.remoteArchive.get(name));bytes[34]^=1;f.remoteArchive.set(name,bytes);}
    if(mode==='extra')f.remoteArchive.set(f.base+'other',Buffer.from('bad'));
    await assert.rejects(restoreArchive(f.ctx,{io:f.archiveIO,key,root:f.archiveRoot,control:f.control,now:f.now}));}
});
test('output symlinks and nonempty roots refuse before archive reads',async t=>{
  const f=fixture(t);await assert.rejects(restoreArchive(f.ctx,{io:f.archiveIO,key:f.key,root:f.archiveRoot,control:f.control,now:f.now}));
  const link=resolve(f.temp,'linked');symlinkSync(f.archiveRoot,link);await assert.rejects(restoreArchive(f.ctx,{io:f.archiveIO,key:f.key,root:link,control:f.control,now:f.now}));
});
test('insufficient restore plus two-copy sanitizer disk refuses before any input download',async t=>{
  const f=fixture(t);rmSync(f.archiveRoot,{recursive:true});mkdirSync(f.archiveRoot,{mode:0o700});let reads=0;
  const io={...f.archiveIO,get:async key=>{if(key.includes('/objects/'))reads++;return f.archiveIO.get(key);}};
  await assert.rejects(restoreArchive(f.ctx,{io,key:f.key,root:f.archiveRoot,control:f.control,now:f.now,freeDisk:()=>0n}),/insufficient private restore/);assert.equal(reads,0);
});
test('receipt binds archive source hashes, science checks and unpromoted holds',t=>{
  const f=fixture(t);validateDisplayReceipt(f.q,f.ctx,f.archive,NOW);
  for(const change of [q=>q.status='COLLECTED',q=>q.sourceReceiptSha256='f'.repeat(64),q=>q.stagedQualificationSha256='f'.repeat(64),q=>q.archiveMarkerSha256='f'.repeat(64),q=>q.cloudSource.runId='5',q=>q.scientificChecks=['coverage'],q=>q.browserQualified=true,q=>q.publishable=true,q=>q.originalHoldsPreserved=false,q=>q.displayInventory.pop(),q=>q.displayInventory[0].path='private.json']){const q=structuredClone(f.q);change(q);assert.throws(()=>validateDisplayReceipt(q,f.ctx,f.archive,NOW));}
});
test('preparation writes exact display then descriptor/snapshot/selection, never serving pointers',async t=>{
  const f=fixture(t),selection=await publishDisplay(f.ctx,f);assert.equal(selection.status,'DATA_QUALIFIED');assert.equal(selection.browserQualified,false);
  assert.equal(f.writes.length,153);assert.match(f.writes.at(-3).key,/component.json$/);assert.equal(f.writes.at(-2).key,`catalogs/snapshots/${f.ctx.catalogId}.json`);assert.match(f.writes.at(-1).key,/selection.json$/);
  assert.ok(f.writes.every(w=>[DATA,COMPONENTS].includes(w.bucket)&&!w.key.endsWith('/current.json')));
  assert.doesNotMatch(JSON.stringify(selection),/\/private\/original|retained\/|source.json/);
  const component=JSON.parse(f.objects.get(COMPONENTS+'/'+`components/icon/${f.ctx.artifactId}/component.json`).body);assert.ok(component.quality.checks.includes('live_superset'));assert.ok(!component.quality.checks.includes('browser'));
});
test('same immutable preparation can be reverified without rewriting objects',async t=>{
  const f=fixture(t),a=await publishDisplay(f.ctx,f),writes=f.writes.length,b=await publishDisplay(f.ctx,f);assert.deepEqual(a,b);assert.equal(f.writes.length,writes);
});
test('bytes, headers, local proof drift or later freshness failure never emits selection',async t=>{
  for(const mode of ['bytes','header','local','fresh']){const f=fixture(t);let changed=false;
    if(mode==='local')f.write(resolve(f.root,'display'),f.q.displayInventory[0].path,Buffer.from('bad'));
    if(['bytes','header'].includes(mode))f.hooks.afterPut=(bucket,key)=>{if(!changed){changed=true;const obj=f.objects.get(bucket+'/'+key);if(mode==='bytes')obj.body[0]^=1;else obj.httpMetadata.contentType='text/html';}};
    const now=mode==='fresh'?(()=>{let calls=0;return ()=>++calls>2?NOW+24*3600_000:NOW;})():f.now;
    await assert.rejects(publishDisplay(f.ctx,{...f,now}));assert.ok(!f.writes.some(x=>x.key.endsWith('/selection.json')));assert.ok(!f.writes.some(x=>x.key.endsWith('/current.json')));}
});
test('upload failure cannot turn science-only validation into complete publication',async t=>{
  const f=fixture(t);f.hooks.beforePut=()=>{throw Error('synthetic storage failure');};await assert.rejects(publishDisplay(f.ctx,f));assert.equal(f.writes.length,0);
});
test('all old model variables, grid, lead coverage and cycle are protected',t=>{
  const f=fixture(t);assertSuperset(f.m,f.m);
  for(const change of [m=>m.init_time='2026-08-30T12:00:00Z',m=>m.frames.pop(),m=>delete m.variables.wind,m=>m.grid.width=3,m=>m.windReference='grid-relative']){const m=structuredClone(f.m);change(m);assert.throws(()=>assertSuperset(m,f.m));}
});
test('write capability rejects production, serving pointers, private input and wrong model',t=>{
  const f=fixture(t);
  for(const [bucket,key] of [['weatherx-data','catalogs/current.json'],[DATA,'catalogs/current.json'],[DATA,'releases/current.json'],[DATA,'staging-candidates/model-inputs/x'],[COMPONENTS,`components/icon/${f.ctx.artifactId}/source-receipt.json`],[COMPONENTS,`components/nam/${f.ctx.artifactId}/index.json`]])assert.throws(()=>publicationTarget(f.ctx,bucket,key));
});
test('snapshot descriptor has only data checks and keeps one-model authority separate',t=>{
  const f=fixture(t),p=makeCatalog(f.ctx,f.q,null,new Date(NOW).toISOString());assert.equal(p.catalog.sequence,1);assert.equal(p.catalog.parentCatalogId,null);assert.deepEqual(Object.keys(p.catalog.components),['icon']);assert.deepEqual(p.descriptor.mounts,['data/icon/']);
});
test('explicit previous model snapshot is rehashed completely and continued without touching current',async t=>{
  const f=fixture(t),previous=await publishDisplay(f.ctx,f);
  Object.assign(f.ctx,{prior:{catalogId:previous.catalogId,sha256:previous.catalogSha256},publicationId:'9877-1',catalogId:'stage-icon-9877-1',artifactId:'stage-2026083112-9877-1'});
  f.q.validatorRun.runId='9877';f.write(f.root,'qualification.json',encode(f.q));
  const next=await publishDisplay(f.ctx,f),catalog=JSON.parse(f.objects.get(DATA+`/catalogs/snapshots/${next.catalogId}.json`).body);
  assert.equal(catalog.sequence,2);assert.equal(catalog.parentCatalogId,previous.catalogId);
  assert.ok(!f.writes.some(x=>x.key.endsWith('/current.json')));
});
test('corrupt previous model bytes block publication before any new writes',async t=>{
  const f=fixture(t),previous=await publishDisplay(f.ctx,f),writes=f.writes.length;
  Object.assign(f.ctx,{prior:{catalogId:previous.catalogId,sha256:previous.catalogSha256},publicationId:'9877-1',catalogId:'stage-icon-9877-1',artifactId:'stage-2026083112-9877-1'});
  f.q.validatorRun.runId='9877';f.write(f.root,'qualification.json',encode(f.q));
  const file=f.objects.get(COMPONENTS+`/components/icon/${previous.component.artifactId}/runs/2026083112/wind/000.png`);file.body[0]^=1;
  await assert.rejects(publishDisplay(f.ctx,f),/prior full inventory/);assert.equal(f.writes.length,writes);
});
test('official SDK commands enforce fixed buckets, keys, conditions and bounded reads',async t=>{
  const f=fixture(t),calls=[],body=Buffer.from('1234');let oversized=false;
  const client={send:async command=>{calls.push(command);if(command.constructor.name==='GetObjectCommand')return {ContentLength:oversized?3:body.length,Body:Readable.from([body]),Metadata:{},ContentType:'image/png',CacheControl:'public, max-age=31536000, immutable'};return {};}};
  const io=await createPublicationS3({...f.env,STAGING_R2_WRITE_ACCESS_KEY_ID:'synthetic-id',STAGING_R2_WRITE_SECRET_ACCESS_KEY:'synthetic-secret'},f.ctx,client);
  const key=`components/icon/${f.ctx.artifactId}/runs/2026083112/wind/000.png`;
  await io.put(COMPONENTS,key,body,{});assert.equal(calls[0].input.Bucket,COMPONENTS);assert.equal(calls[0].input.IfNoneMatch,'*');assert.equal(calls[0].input.ContentType,'image/png');assert.equal(calls[0].input.IfMatch,undefined);
  assert.equal((await io.hashObject(COMPONENTS,key,4)).sha256,hash(body));oversized=true;await assert.rejects(io.hashObject(COMPONENTS,key,4));
  const count=calls.length;
  await assert.rejects(io.put(DATA,'catalogs/current.json',body,{}));await assert.rejects(io.get('weatherx-data-production','catalogs/current.json',4));
  await assert.rejects(io.put(COMPONENTS,key,body,{unexpected:'metadata'}));assert.equal(calls.length,count);
  await assert.rejects(createPublicationS3({...f.env,STAGING_R2_ACCOUNT_ID:'wrong'},f.ctx,client));
});
test('workflow is manual, protected, source-pinned and keeps science free of storage credentials',()=>{
  const source=readFileSync(new URL('../.github/workflows/staging-model-components.yml',import.meta.url),'utf8');
  assert.match(source,/workflow_dispatch:/);assert.doesNotMatch(source,/\n  (schedule|push|pull_request|workflow_run):/);assert.match(source,/environment:\n\s+name: data-staging/);
  assert.doesNotMatch(source,/upload-artifact@|actions\/cache@|PAGES.*TOKEN|WORKER.*TOKEN|CATALOG_PROMOTION_KEY|SHARED_R2_READ|ui-release\.yml/);
  for(const line of source.split('\n').filter(x=>x.includes('uses:')))assert.match(line,/@[a-f0-9]{40}\b/);
  const science=source.split('- name: Revalidate raw science')[1].split('- name: Prepare immutable')[0];assert.doesNotMatch(science,/secrets\.|STAGING_R2_WRITE|MODEL_INPUT_ARCHIVE_KEY/);
  assert.match(science,/mkdir -p "\$RUNNER_TEMP\/weatherx-staging-model-display"/);assert.match(science,/--archive-marker-sha256/);
});
