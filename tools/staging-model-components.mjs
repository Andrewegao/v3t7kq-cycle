// Manual staging-only immutable display preparation. Neither serving pointer is
// writable here. A scientific data receipt is NOT browser/fusion/UI activation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, statfsSync } from 'node:fs';
import { dirname, resolve, parse } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { ACCOUNT, MODELS, hash, objectKey, unseal, validateReceipt, createArchiveS3 } from './model-inputs.mjs';

export const READER_SHA = 'a58eff158b56ef2ba25189d2b859315b00893a14';
export const DATA = 'weatherx-data-staging', COMPONENTS = 'weatherx-components-staging';
export const SCIENCE = ['coverage','freshness','horizon','cadence','grid','referenced_bytes','native_wind','source_binding'];
const SHA = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/, ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const JSON_MAX = 32*1024**2, FILE_MAX = 512*1024**2, DISPLAY_MAX = 3*1024**3;
const CACHE = 'public, max-age=31536000, immutable';
const httpMetadata = key => ({contentType:key.endsWith('.png')?'image/png':'application/json',cacheControl:CACHE});
const encode = value => Buffer.from(JSON.stringify(value)+'\n');
export function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  assert.ok(value===null || ['string','boolean','number'].includes(typeof value));
  if(typeof value==='number')assert.ok(Number.isFinite(value));return JSON.stringify(value);
}
export function fresh(init, now) {
  assert.match(init??'',/^\d{8}(00|06|12|18)$/);
  const iso=`${init.slice(0,4)}-${init.slice(4,6)}-${init.slice(6,8)}T${init.slice(8)}:00:00.000Z`, time=Date.parse(iso);
  assert.ok(Number.isFinite(time)&&new Date(time).toISOString()===iso&&now>=time&&now-time<=12*3600_000,'stale/future source');return time;
}
export function request(env) {
  const pin={sourceSha:env.MODEL_SOURCE_SHA,model:env.MODEL_ID,init:env.MODEL_INIT,runId:env.ARCHIVE_RUN_ID,attempt:env.ARCHIVE_RUN_ATTEMPT};
  assert.match(pin.sourceSha??'',COMMIT);assert.ok(MODELS.includes(pin.model));
  assert.match(pin.runId??'',/^[1-9]\d{0,19}$/);assert.match(pin.attempt??'',/^[1-9]\d{0,3}$/);
  assert.match(env.MODEL_VALIDATOR_SHA??'',COMMIT);assert.match(env.ARCHIVE_RECEIPT_SHA256??'',SHA);assert.match(env.ARCHIVE_MARKER_SHA256??'',SHA);
  const prior=env.PRIOR_CATALOG_ID==='none'&&env.PRIOR_CATALOG_SHA256==='none'?null:{catalogId:env.PRIOR_CATALOG_ID,sha256:env.PRIOR_CATALOG_SHA256};
  if(prior){assert.match(prior.catalogId??'',ID);assert.match(prior.sha256??'',SHA);assert.ok(prior.catalogId.startsWith(`stage-${pin.model}-`),'prior must be isolated model catalog');}
  return {pin,validatorSha:env.MODEL_VALIDATOR_SHA,receiptSha256:env.ARCHIVE_RECEIPT_SHA256,markerSha256:env.ARCHIVE_MARKER_SHA256,prior};
}
export function gate(env,now=Date.now()) {
  for(const [k,v] of Object.entries({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',
    GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_JOB:'qualify',
    GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/staging-model-components.yml@refs/heads/main',
    STAGING_DATA_ISOLATION_APPROVED:'true',STAGING_MODEL_COMPONENTS_ENABLED:'true',STAGING_R2_ACCOUNT_ID:ACCOUNT}))assert.equal(env[k],v,k);
  const selection=request(env);fresh(selection.pin.init,now);
  assert.equal(selection.pin.sourceSha,env.STAGING_MODEL_APPROVED_SOURCE_SHA,'collector not approved');
  assert.equal(selection.validatorSha,env.STAGING_MODEL_VALIDATOR_SOURCE_SHA,'validator not approved');
  const approvalText=env.STAGING_MODEL_COMPONENTS_APPROVED_REQUESTS_JSON;
  assert.ok(typeof approvalText==='string'&&approvalText.length<=2048,'bounded per-model approval map required');
  const approvals=JSON.parse(approvalText);
  assert.ok(approvals&&typeof approvals==='object'&&!Array.isArray(approvals));
  assert.ok(Object.keys(approvals).length>0&&Object.keys(approvals).length<=MODELS.length);
  for(const [model,digest] of Object.entries(approvals)){assert.ok(MODELS.includes(model),'unknown approval model');assert.match(digest??'',SHA);}
  assert.equal(hash(canonical(selection)),approvals[selection.pin.model],'exact per-model request approval required');
  assert.match(env.GITHUB_RUN_ID??'',/^[1-9]\d{0,19}$/);assert.match(env.GITHUB_RUN_ATTEMPT??'',/^[1-9]\d{0,3}$/);
  const publicationId=`${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  return {...selection,publicationId,artifactId:`stage-${selection.pin.init}-${publicationId}`,catalogId:`stage-${selection.pin.model}-${publicationId}`};
}
export const archivePrefix = pin => objectKey(pin,'placeholder').split('/objects/')[0]+'/';
function safePath(value) {
  assert.ok(typeof value==='string' && value.length<=1024 && value.split('/').every(p=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)&&p!=='.'&&p!=='..'),'unsafe path');return value;
}
function directory(root) {
  assert.equal(resolve(root),root);
  for(let p=root;;p=dirname(p)){const s=lstatSync(p);assert.ok(s.isDirectory()&&!s.isSymbolicLink());if(p===parse(p).root)break;}
  assert.equal(realpathSync(root),root);return root;
}
export function privateRoot(root,{freshOnly=false}={}) {
  assert.equal(resolve(root),root);let ancestor=root;while(!existsSync(ancestor))ancestor=dirname(ancestor);directory(ancestor);
  if(existsSync(root)){directory(root);assert.equal(lstatSync(root).mode&0o077,0,'private directory required');if(freshOnly)assert.equal(readdirSync(root).length,0,'fresh output required');}
  else mkdirSync(root,{recursive:true,mode:0o700});return root;
}
function localFile(root,path,max=FILE_MAX) {
  directory(root);safePath(path);const file=resolve(root,path);
  for(let at=dirname(file);at!==root;at=dirname(at))directory(at);
  const st=lstatSync(file);assert.ok(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size>0&&st.size<=max,'invalid file');return file;
}
async function fileHash(root,path) {
  const file=localFile(root,path),before=lstatSync(file),digest=createHash('sha256');let bytes=0;
  for await(const chunk of createReadStream(file)){bytes+=chunk.length;assert.ok(bytes<=FILE_MAX);digest.update(chunk);}
  const after=lstatSync(file);assert.equal(bytes,before.size);assert.equal(after.size,before.size);assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);
  return {path,bytes,sha256:digest.digest('hex')};
}
async function exactLocal(root,expected,excluded=[]) {
  directory(root);const paths=[];
  function walk(at){for(const n of readdirSync(at)){const f=resolve(at,n),p=f.slice(root.length+1),s=lstatSync(f);safePath(p);assert.ok(!s.isSymbolicLink());
    if(s.isDirectory())walk(f);else {assert.ok(s.isFile()&&s.nlink===1);if(!excluded.includes(p))paths.push(p);}assert.ok(paths.length<=100_000);}}
  walk(root);assert.deepEqual(paths.sort(),expected.map(x=>x.path).sort(),'exact local inventory required');
  for(const row of expected)assert.deepEqual(await fileHash(root,row.path),row,'local bytes differ');
}
function writePrivate(root,path,body) {
  safePath(path);const file=resolve(root,path);mkdirSync(dirname(file),{recursive:true,mode:0o700});directory(dirname(file));
  writeFileSync(file,body,{flag:'wx',mode:0o600});
}
async function pool(items,fn,limit=2) {let next=0,error;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(!error&&next<items.length){const item=items[next++];try{await fn(item);}catch(e){error??=e;}}}));if(error)throw error;}
export function validateMarker(bytes,ctx,key) {
  assert.ok(Buffer.isBuffer(bytes)&&bytes.length<=JSON_MAX);assert.equal(hash(bytes),ctx.markerSha256,'archive marker differs from approval');
  const m=JSON.parse(bytes);assert.deepEqual(m,{schemaVersion:1,kind:'weatherx-private-cloud-input-archive',...ctx.pin,
    objects:m.objects,bytes:m.bytes,receiptSha256:ctx.receiptSha256,receiptCipherSha256:m.receiptCipherSha256,
    archiveKeyId:hash(Buffer.from(key,'hex')).slice(0,16),encrypted:true,activated:false,productionWritten:false,
    publishable:false,renderReady:false,fusionEligible:false,weatherxFusionIssued:false});
  assert.match(key??'',SHA);assert.match(m.receiptCipherSha256??'',SHA);assert.ok(Number.isSafeInteger(m.objects)&&m.objects>0&&m.objects<=100_000);
  assert.ok(Number.isSafeInteger(m.bytes)&&m.bytes>0&&m.bytes<=30*1024**3);return m;
}
export function restoreDiskBudget(receipt) {
  // Sanitization temporarily retains the assembler output AND its typed final
  // display copy. Reserving twice the entire staged subtree is conservative.
  const staged=receipt.inventory.filter(o=>o.path.startsWith(receipt.stagedRoot+'/')).reduce((n,o)=>n+o.bytes,0);
  assert.ok(staged>0);return receipt.totalBytes+2*staged+512*1024**2;
}
export async function restoreArchive(ctx,{io,key,root,control,now=Date.now,log=()=>{},freeDisk=path=>{const s=statfsSync(path,{bigint:true});return s.bavail*s.bsize;}}) {
  fresh(ctx.pin.init,now());privateRoot(root,{freshOnly:true});privateRoot(control,{freshOnly:true});
  const base=archivePrefix(ctx.pin),markerBytes=await io.get(base+'complete.json');assert.ok(markerBytes,'completed archive required');
  const marker=validateMarker(markerBytes,ctx,key),cipher=await io.get(base+'receipt.wxmi');assert.ok(cipher&&cipher.length<=JSON_MAX+33);
  assert.equal(hash(cipher),marker.receiptCipherSha256);const receiptBytes=unseal(cipher,key,base+'receipt.wxmi',ctx.receiptSha256);
  const receipt=validateReceipt(JSON.parse(receiptBytes),ctx.pin,now());assert.equal(receipt.inventory.length,marker.objects);assert.equal(receipt.totalBytes,marker.bytes);
  const required=restoreDiskBudget(receipt);assert.ok(freeDisk(root)>=BigInt(required),'insufficient private restore/sanitizer disk');
  log({phase:'restore-resource-admission',model:ctx.pin.model,requiredBytes:required});
  // Preserve the exact original private root; HRDPS's launch-root checks are never rewritten.
  const expected=[...receipt.inventory.map(o=>objectKey(ctx.pin,o.path)),base+'receipt.wxmi',base+'complete.json'].sort();
  assert.deepEqual((await io.list(base)).sort(),expected);
  let complete=0;
  await pool(receipt.inventory,async row=>{safePath(row.path);const remote=objectKey(ctx.pin,row.path),encrypted=await io.get(remote);
    assert.ok(encrypted&&encrypted.length===row.bytes+33);const body=unseal(encrypted,key,remote,row.sha256);assert.equal(body.length,row.bytes);
    writePrivate(root,row.path,body);complete++;if(complete%100===0)log({phase:'archive-restored',model:ctx.pin.model,objects:complete});});
  await exactLocal(root,receipt.inventory);validateReceipt(receipt,ctx.pin,now());
  assert.deepEqual(await io.get(base+'complete.json'),markerBytes,'archive marker changed');
  assert.equal(hash(await io.get(base+'receipt.wxmi')),marker.receiptCipherSha256,'archive receipt changed');
  assert.deepEqual((await io.list(base)).sort(),expected);
  writePrivate(root,'cloud-input-receipt.json',receiptBytes);writePrivate(control,'archive-marker.json',markerBytes);
  log({phase:'archive-verified',model:ctx.pin.model,objects:marker.objects,bytes:marker.bytes});return receipt;
}

export function displayPaths(init) {
  const prefix=`runs/${init}/`;
  return ['index.json',prefix+'manifest.json',prefix+'mask.png',...Array.from({length:49},(_,i)=>['temp','wind','mslp'].map(f=>prefix+f+'/'+String(i).padStart(3,'0')+'.png')).flat()].sort();
}
export function validateDisplayReceipt(q,ctx,archive,now=Date.now()) {
  assert.equal(q.schemaVersion,1);assert.equal(q.kind,'weatherx-staging-model-display');
  assert.equal(q.status,'staging-data-qualified-not-activated');
  assert.equal(q.model,ctx.pin.model);assert.equal(q.init,ctx.pin.init);assert.equal(q.collectorSourceSha,ctx.pin.sourceSha);assert.equal(q.validatorSourceSha,ctx.validatorSha);
  assert.deepEqual(q.cloudSource,{runId:ctx.pin.runId,runAttempt:ctx.pin.attempt});
  assert.equal(q.archiveReceiptSha256,ctx.receiptSha256);assert.equal(q.archiveMarkerSha256,ctx.markerSha256);
  assert.equal(q.sourceReceiptSha256,archive.sourceReceiptSha256);assert.match(q.stagedQualificationSha256??'',SHA);
  assert.equal(q.stagedQualificationSha256,archive.inventory.find(o=>o.path===archive.timelineReceipt)?.sha256,'timeline receipt not in original archive');
  assert.equal(q.leadCount,49);assert.equal(q.horizonHours,48);assert.equal(q.windReference,'earth-relative');
  assert.equal(q.stagingDataQualified,true);assert.equal(q.originalHoldsPreserved,true);
  for(const k of ['browserQualified','fusionEligible','productionActivation','weatherxFusionIssued','publishable'])assert.equal(q[k],false,k);
  assert.deepEqual(q.scientificChecks,SCIENCE);const init=fresh(q.init,now),created=Date.parse(q.createdAt);
  assert.ok(Number.isFinite(created)&&created>=init&&created<=now);
  assert.ok(Array.isArray(q.displayInventory));assert.deepEqual(q.displayInventory.map(x=>x.path),displayPaths(q.init));
  let bytes=0;for(const row of q.displayInventory){assert.deepEqual(Object.keys(row).sort(),['bytes','path','sha256']);assert.match(row.sha256??'',SHA);
    assert.ok(Number.isSafeInteger(row.bytes)&&row.bytes>0&&row.bytes<=FILE_MAX);bytes+=row.bytes;assert.ok(bytes<=DISPLAY_MAX);}
  assert.equal(q.displayInventorySha256,hash(canonical(q.displayInventory)));
  assert.ok(q.grid&&q.variables&&typeof q.grid==='object'&&typeof q.variables==='object');return q;
}
function manifest(root,init) {return JSON.parse(readFileSync(localFile(root,`runs/${init}/manifest.json`,JSON_MAX)));}
export function assertSuperset(next,previous) {
  if(!previous)return;
  assert.equal(next.model,previous.model);assert.ok(Date.parse(next.init_time)>=Date.parse(previous.init_time),'model cycle regressed');
  assert.deepEqual(next.grid,previous.grid,'grid changed');assert.equal(next.windReference,previous.windReference,'wind reference changed');
  for(const [field,def] of Object.entries(previous.variables))assert.deepEqual(next.variables[field],def,'model field removed or encoding changed');
  const times=m=>m.frames.map(f=>(Date.parse(f.valid_time)-Date.parse(m.init_time))/1000),leads=new Set(times(next));
  for(const lead of times(previous))assert.ok(Number.isFinite(lead)&&leads.has(lead),'model horizon/cadence regressed');
}
export function makeCatalog(ctx,q,previous,completedAt) {
  const rootPrefix=`components/${ctx.pin.model}/${ctx.artifactId}/`;
  const inventory=q.displayInventory.map(o=>({path:o.path,size:o.bytes,sha256:o.sha256}));
  const component={schemaVersion:1,componentId:ctx.pin.model,artifactId:ctx.artifactId,
    generationTime:new Date(fresh(ctx.pin.init,Date.parse(completedAt))).toISOString(),completedAt,rootPrefix,mounts:[`data/${ctx.pin.model}/`],objectCount:150,
    inventorySha256:hash(JSON.stringify(inventory)),quality:{status:'passed',checks:['manifest','inventory','remote_bytes',...SCIENCE,'live_superset']}};
  const body=encode(component),descriptor={...component,manifestKey:rootPrefix+'component.json',manifestSha256:hash(body)};
  const catalog={schemaVersion:2,sequence:(previous?.sequence??0)+1,parentCatalogId:ctx.prior?.catalogId??null,createdAt:completedAt,
    components:{[ctx.pin.model]:descriptor},rollbackEpoch:previous?.rollbackEpoch??0};
  return {component:body,descriptor,catalog,body:encode(catalog)};
}

function bound(body,row) {assert.ok(Buffer.isBuffer(body));assert.equal(body.length,row.bytes);assert.equal(hash(body),row.sha256);return body;}
function fixedCatalog(ctx,key) {return key===`catalogs/snapshots/${ctx.catalogId}.json`;}
export function publicationTarget(ctx,bucket,key) {
  const prefix=`components/${ctx.pin.model}/${ctx.artifactId}/`;
  assert.ok(bucket===DATA||bucket===COMPONENTS,'staging buckets only');
  if(bucket===COMPONENTS){assert.ok(key.startsWith(prefix));assert.ok([...displayPaths(ctx.pin.init),'component.json'].includes(key.slice(prefix.length)),'non-display component write');}
  else assert.ok(fixedCatalog(ctx,key)||key===`staging-candidates/model-components/${ctx.catalogId}/selection.json`,'serving pointers/control paths forbidden');
  return {Bucket:bucket,Key:key};
}
export async function inspectPrior(ctx,io,reader) {
  if(!ctx.prior)return null;
  const object=await io.get(DATA,`catalogs/snapshots/${ctx.prior.catalogId}.json`,512*1024);assert.ok(object);
  assert.equal(hash(object.body),ctx.prior.sha256);assert.equal(object.metadata.sha256,ctx.prior.sha256,'prior catalog metadata required');
  const catalog=JSON.parse(object.body);assert.ok(reader.isDataCatalog(catalog));
  assert.deepEqual(Object.keys(catalog.components),[ctx.pin.model],'prior must be one-model isolated snapshot');
  const c=catalog.components[ctx.pin.model];assert.deepEqual(c.mounts,[`data/${ctx.pin.model}/`]);
  assert.ok(c.artifactId.startsWith('stage-'));const meta=await io.get(COMPONENTS,c.manifestKey,256*1024);assert.ok(meta);
  assert.equal(hash(meta.body),c.manifestSha256);const expected={...c};delete expected.manifestKey;delete expected.manifestSha256;
  assert.deepEqual(JSON.parse(meta.body),expected);
  const listed=await io.list(COMPONENTS,c.rootPrefix,151),rows=[];
  assert.equal(listed.length,151);assert.equal(c.objectCount,150);
  let index,previousManifest;
  await pool(listed.filter(x=>x.key!==c.manifestKey),async item=>{
    const path=item.key.slice(c.rootPrefix.length);safePath(path);
    const read=await io.hashObject(COMPONENTS,item.key,item.bytes);assert.ok(read);assert.equal(read.bytes,item.bytes);rows.push({path,size:read.bytes,sha256:read.sha256});
    if(path==='index.json'){const obj=await io.get(COMPONENTS,item.key,JSON_MAX);assert.ok(obj);bound(obj.body,{bytes:read.bytes,sha256:read.sha256});index=JSON.parse(obj.body);}
    if(/^runs\/\d{10}\/manifest.json$/.test(path)){assert.equal(previousManifest,undefined);const obj=await io.get(COMPONENTS,item.key,JSON_MAX);assert.ok(obj);bound(obj.body,{bytes:read.bytes,sha256:read.sha256});previousManifest=JSON.parse(obj.body);}
  },4);
  rows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);assert.equal(hash(JSON.stringify(rows)),c.inventorySha256,'prior full inventory differs');
  assert.equal(index?.model,ctx.pin.model);assert.equal(index.runs?.length,1);assert.equal(previousManifest?.model,ctx.pin.model);
  const init=previousManifest.init_time?.replace(/[-:T]/g,'').slice(0,10);assert.match(init??'',/^\d{10}$/);
  assert.deepEqual(rows.map(x=>x.path),displayPaths(init));assert.deepEqual(index.runs,[{init_time:previousManifest.init_time,path:`runs/${init}/`}]);
  return {catalog,manifest:previousManifest,object};
}
function qualifiedSelection(ctx,q,prepared,completedAt) {
  return {schemaVersion:1,kind:'weatherx-staging-model-selection-entry',targetOrigin:'https://staging.weatherx.org',
    status:'DATA_QUALIFIED',
    model:ctx.pin.model,catalogId:ctx.catalogId,catalogSha256:hash(prepared.body),
    component:{artifactId:prepared.descriptor.artifactId,manifestKey:prepared.descriptor.manifestKey,manifestSha256:prepared.descriptor.manifestSha256,inventorySha256:prepared.descriptor.inventorySha256},
    collectorSourceSha:ctx.pin.sourceSha,validatorSourceSha:ctx.validatorSha,cloudSource:{runId:ctx.pin.runId,runAttempt:ctx.pin.attempt},
    validatorRun:q.validatorRun,archiveReceiptSha256:ctx.receiptSha256,archiveMarkerSha256:ctx.markerSha256,
    sourceReceiptSha256:q.sourceReceiptSha256,stagedQualificationSha256:q.stagedQualificationSha256,
    init:ctx.pin.init,leadCount:49,horizonHours:48,displayInventory:q.displayInventory,displayInventorySha256:q.displayInventorySha256,
    grid:q.grid,variables:q.variables,windReference:'earth-relative',
    indexPath:`/data/_catalog/${ctx.catalogId}/${ctx.pin.model}/index.json`,manifestPath:`/data/_catalog/${ctx.catalogId}/${ctx.pin.model}/runs/${ctx.pin.init}/manifest.json`,
    createdAt:completedAt,stagingDataQualified:true,browserQualified:false,fusionEligible:false,productionPublishable:false,weatherxFusionIssued:false};
}
export async function publishDisplay(ctx,{io,reader,root,archiveRoot,now=Date.now,log=()=>{}}) {
  fresh(ctx.pin.init,now());const archiveBytes=readFileSync(localFile(archiveRoot,'cloud-input-receipt.json',JSON_MAX));
  assert.equal(hash(archiveBytes),ctx.receiptSha256);const archive=validateReceipt(JSON.parse(archiveBytes),ctx.pin,now());
  const qBytes=readFileSync(localFile(root,'qualification.json',JSON_MAX)),q=validateDisplayReceipt(JSON.parse(qBytes),ctx,archive,now());
  const run=ctx.publicationId.split('-');assert.deepEqual(q.validatorRun,{runId:run[0],runAttempt:run[1],runnerEnvironment:'github-hosted'},'wrong validation invocation');
  const display=directory(resolve(root,'display'));await exactLocal(display,q.displayInventory);
  const m=manifest(display,ctx.pin.init);assert.equal(m.model,ctx.pin.model);assert.equal(m.windReference,'earth-relative');
  assert.deepEqual(m.grid,q.grid);assert.deepEqual(m.variables,q.variables);
  assert.equal(m.qualification?.publishable,false);assert.equal(m.qualification?.fusionEligible,false);assert.equal(m.qualification?.productionActivation,false);
  const prior=await inspectPrior(ctx,io,reader);assertSuperset(m,prior?.manifest);
  const rootPrefix=`components/${ctx.pin.model}/${ctx.artifactId}/`,allowed=new Set([...q.displayInventory.map(o=>rootPrefix+o.path),rootPrefix+'component.json']);
  assert.ok((await io.list(COMPONENTS,rootPrefix,151)).every(o=>allowed.has(o.key)),'unexpected candidate object');
  async function immutable(bucket,key,body,metadata={}) {
    publicationTarget(ctx,bucket,key);const previous=await io.hashObject(bucket,key,body.length);
    if(previous){assert.equal(previous.bytes,body.length);assert.equal(previous.sha256,hash(body),'immutable collision');assert.deepEqual(previous.metadata,metadata);assert.deepEqual(previous.httpMetadata,httpMetadata(key));}
    else await io.put(bucket,key,body,metadata);
    const after=await io.hashObject(bucket,key,body.length);assert.ok(after);assert.equal(after.bytes,body.length);assert.equal(after.sha256,hash(body),'readback bytes differ');assert.deepEqual(after.metadata,metadata);assert.deepEqual(after.httpMetadata,httpMetadata(key));
  }
  await pool(q.displayInventory,async row=>{
    const body=readFileSync(localFile(display,row.path));bound(body,row);await immutable(COMPONENTS,rootPrefix+row.path,body);
  },4);
  await exactLocal(display,q.displayInventory);assert.deepEqual(readFileSync(localFile(root,'qualification.json',JSON_MAX)),qBytes,'qualification changed');
  validateDisplayReceipt(q,ctx,archive,now());assert.deepEqual(readFileSync(localFile(archiveRoot,'cloud-input-receipt.json',JSON_MAX)),archiveBytes);
  // Original science supplies its eight checks. Controller supplies the actual
  // prior-model comparison plus full immutable remote byte proof above. Browser
  // testing, fusion readiness and production admission are deliberately absent.
  // New completion time is sampled only after full display readback. Rechecking
  // an already completed immutable candidate retains its original timestamp;
  // every other descriptor byte is reconstructed and checked again below.
  const existingDescriptor=await io.get(COMPONENTS,rootPrefix+'component.json',256*1024);
  const completedAt=existingDescriptor?JSON.parse(existingDescriptor.body).completedAt:new Date(now()).toISOString();
  assert.ok(typeof completedAt==='string'&&Number.isFinite(Date.parse(completedAt))&&Date.parse(completedAt)>=Date.parse(q.createdAt)&&Date.parse(completedAt)<=now(),'invalid component completion time');
  const prepared=makeCatalog(ctx,q,prior?.catalog,completedAt);assert.ok(reader.isDataCatalog(prepared.catalog),'actual pinned reader rejected candidate');
  await immutable(COMPONENTS,prepared.descriptor.manifestKey,prepared.component);
  assert.deepEqual((await io.list(COMPONENTS,rootPrefix,151)).map(o=>o.key).sort(),[...allowed].sort());
  if(prior){const latest=await io.get(DATA,`catalogs/snapshots/${ctx.prior.catalogId}.json`,512*1024);assert.ok(latest);assert.deepEqual(latest.body,prior.object.body);assert.deepEqual(latest.metadata,prior.object.metadata);}
  fresh(ctx.pin.init,now());const catalogKey=`catalogs/snapshots/${ctx.catalogId}.json`,catalogSha=hash(prepared.body);
  await immutable(DATA,catalogKey,prepared.body,{sha256:catalogSha});
  const readable=await reader.loadCatalogById(ctx.catalogId,{bucket:{get:async key=>{assert.equal(key,catalogKey);const value=await io.get(DATA,key,512*1024);return value&&{size:value.body.length,customMetadata:value.metadata,arrayBuffer:async()=>value.body};}},componentBucket:{},pointerKey:'catalogs/current.json'});
  assert.deepEqual(readable,prepared.catalog,'pinned reader could not verify stored catalog');
  fresh(ctx.pin.init,now());const selection=qualifiedSelection(ctx,q,prepared,completedAt),body=encode(selection);
  await immutable(DATA,`staging-candidates/model-components/${ctx.catalogId}/selection.json`,body,{sha256:hash(body)});
  log({phase:'staging-model-component-prepared',model:ctx.pin.model,catalogId:ctx.catalogId,objects:150,activated:false});return selection;
}

export async function loadPinnedReader(root) {
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),READER_SHA);
  execFileSync('git',['diff','--exit-code','HEAD'],{cwd:root,stdio:'pipe'});
  const hooks=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('.')&&context.parentURL?.endsWith('.ts')&&existsSync(fileURLToPath(new URL(specifier+'.ts',context.parentURL))))return next(specifier+'.ts',context);return next(specifier,context);},
    load(url,context,next){if(url.startsWith('file:')&&url.endsWith('.ts'))return {format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8')),shortCircuit:true};return next(url,context);}});
  try {const reader=await import(pathToFileURL(resolve(root,'platform/edge/src/catalog.ts')));return {...reader,close:()=>hooks.deregister()};}
  catch(error){hooks.deregister();throw error;}
}

// SDK transport has one fixed account/two staging buckets. PUT can target only
// this run's typed display, descriptor, snapshot and minimal selection receipt.
export async function createPublicationS3(env,ctx,injectedClient) {
  const {S3Client,GetObjectCommand,PutObjectCommand,ListObjectsV2Command}=await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
  assert.equal(env.STAGING_R2_ACCOUNT_ID,ACCOUNT);assert.ok(env.STAGING_R2_WRITE_ACCESS_KEY_ID&&env.STAGING_R2_WRITE_SECRET_ACCESS_KEY);
  const client=injectedClient??new S3Client({region:'auto',endpoint:`https://${ACCOUNT}.r2.cloudflarestorage.com`,forcePathStyle:true,maxAttempts:1,
    requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',credentials:{accessKeyId:env.STAGING_R2_WRITE_ACCESS_KEY_ID,secretAccessKey:env.STAGING_R2_WRITE_SECRET_ACCESS_KEY}});
  function readTarget(bucket,key) {
    assert.ok(bucket===DATA||bucket===COMPONENTS);safePath(key);
    if(bucket===COMPONENTS)assert.ok(key.startsWith(`components/${ctx.pin.model}/stage-`),'foreign model read');
    else assert.ok(key===`catalogs/snapshots/${ctx.prior?.catalogId}.json`||fixedCatalog(ctx,key)||key===`staging-candidates/model-components/${ctx.catalogId}/selection.json`,'unrelated staging control read');
    return {Bucket:bucket,Key:key};
  }
  async function send(command,missing=false) {try{return await client.send(command,{abortSignal:AbortSignal.timeout(120_000)});}catch(error){if(missing&&error?.$metadata?.httpStatusCode===404)return null;throw Error(error?.$metadata?.httpStatusCode===412?'immutable staging collision':'staging object operation failed');}}
  async function read(bucket,key,maxBytes,collect) {
    assert.ok(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=FILE_MAX);const obj=await send(new GetObjectCommand(readTarget(bucket,key)),true);if(!obj)return null;
    try {assert.ok(Number.isSafeInteger(obj.ContentLength)&&obj.ContentLength<=maxBytes);const parts=[],digest=createHash('sha256');let bytes=0;
      for await(const chunk of obj.Body){bytes+=chunk.length;assert.ok(bytes<=maxBytes);digest.update(chunk);if(collect)parts.push(Buffer.from(chunk));}
      assert.equal(bytes,obj.ContentLength);assert.equal(obj.ContentEncoding,undefined,'unexpected content encoding');return {bytes,sha256:digest.digest('hex'),metadata:obj.Metadata??{},httpMetadata:{contentType:obj.ContentType,cacheControl:obj.CacheControl},...(collect?{body:Buffer.concat(parts)}:{})};
    }finally{obj.Body?.destroy?.();}
  }
  return {close:()=>client.destroy?.(),get:(bucket,key,max=JSON_MAX)=>{assert.ok(max<=JSON_MAX);return read(bucket,key,max,true);},
    hashObject:(bucket,key,max)=>read(bucket,key,max,false),
    async put(bucket,key,body,metadata={}) {const target=publicationTarget(ctx,bucket,key);assert.ok(Buffer.isBuffer(body)&&body.length>0&&body.length<=FILE_MAX);
      assert.deepEqual(metadata,bucket===DATA?{sha256:hash(body)}:{});
      await send(new PutObjectCommand({...target,Body:body,ContentLength:body.length,IfNoneMatch:'*',Metadata:metadata,ContentType:httpMetadata(key).contentType,CacheControl:CACHE}));
    },async list(bucket,prefix,maxObjects) {
      assert.equal(bucket,COMPONENTS);assert.ok(prefix.endsWith('/'));readTarget(bucket,prefix.slice(0,-1));assert.ok(maxObjects===151);
      const found=[],tokens=new Set();let token;
      do {const page=await send(new ListObjectsV2Command({Bucket:bucket,Prefix:prefix,MaxKeys:1000,ContinuationToken:token}));
        for(const o of page.Contents??[]){readTarget(bucket,o.Key);assert.ok(o.Key.startsWith(prefix));assert.ok(Number.isSafeInteger(o.Size)&&o.Size>0&&o.Size<=FILE_MAX);found.push({key:o.Key,bytes:o.Size});assert.ok(found.length<=maxObjects);}
        token=page.IsTruncated?page.NextContinuationToken:undefined;if(page.IsTruncated){assert.ok(typeof token==='string'&&token&&!tokens.has(token));tokens.add(token);}
      }while(token);assert.equal(new Set(found.map(o=>o.key)).size,found.length);return found;
    }};
}
function paths(env,ctx) {
  const temp=directory(resolve(env.RUNNER_TEMP));
  return {archiveRoot:resolve(temp,'weatherx-model-inputs',ctx.pin.model),control:resolve(temp,'weatherx-staging-model-control',ctx.pin.model),root:resolve(temp,'weatherx-staging-model-display',ctx.pin.model)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {const ctx=gate(process.env),command=process.argv[2];
    if(command==='gate')console.log(JSON.stringify({requestSha256:hash(canonical(request(process.env))),model:ctx.pin.model,activated:false}));
    else if(command==='restore'){const p=paths(process.env,ctx),io=await createArchiveS3(process.env,ctx.pin);try{await restoreArchive(ctx,{io,key:process.env.MODEL_INPUT_ARCHIVE_KEY,root:p.archiveRoot,control:p.control,log:x=>console.log(JSON.stringify(x))});}finally{io.close();}}
    else if(command==='publish'){const p=paths(process.env,ctx),reader=await loadPinnedReader(resolve('control')),io=await createPublicationS3(process.env,ctx);try{const selection=await publishDisplay(ctx,{...p,io,reader,log:x=>console.log(JSON.stringify(x))});writePrivate(p.control,'selection.json',encode(selection));}finally{reader.close();io.close();}}
    else throw Error('unsupported operation');
  }catch{console.error('Staging model preparation failed; no serving pointers or UI deployment changed.');process.exitCode=1;}
}
