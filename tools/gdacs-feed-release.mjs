#!/usr/bin/env node
// One-time, exact-source GDACS isolation. This is not a general Worker deployer.
// Only mutations: create the previously absent Worker, disable its development
// URLs, attach one new route, and (on failure) delete that exact owned route.
// Cloudflare routes have no compare-and-swap. Recheck immediately before POST;
// detected drift is a refusal, never permission to replace another publisher.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, chmodSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { normalizedBindings, activeVersion, validateInputs, assertPointPayload, verifiedObject, requireFreshDescriptor } from './consumer-refresh.mjs';

export const WORKER = 'weatherx-gdacs-feed-production';
export const PATTERN = 'weatherx.org/api/gdacs/list*';
export const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
export const ZONE = '9dc4df7c3c094ab9a11dd00d378adc26';
const ORIGIN = 'https://weatherx.org';
const API = 'https://api.cloudflare.com/client/v4';
const SCRIPT = `/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
const ROUTES = `/zones/${ZONE}/workers/routes`;
const MODULE = 'gdacsFeed.mjs';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SOURCE_PATHS = ['platform/edge', 'app/functions', 'ops/platform', 'ops/release'];
const CONSUMERS = [
  { name:'weatherx-platform-edge-production', token:'PLATFORM_EDGE_TOKEN', version:'31f5a18f-ab38-4d98-aaa0-27bfa6c9b572', vars:{AUTH_MODE:'observe',BILLING_MODE:'disabled',DATA_CATALOG_MODE:'shadow'} },
  { name:'weatherx-data-edge-production', token:'DATA_EDGE_TOKEN', version:'43f28d1e-bbc1-4c4e-a665-f05180d48b3f', vars:{AUTH_MODE:'public',DATA_CATALOG_MODE:'serve'} },
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,normalize(value[k])]));
  return value;
}
const hash = value => sha256(canonical(value));
const sorted = values => [...values].sort((a,b)=>canonical(a).localeCompare(canonical(b)));
const same = (a,b,label) => assert.ok(canonical(a)===canonical(b),label);
export function normalizedSettings(settings) {
  assert.ok(settings && Array.isArray(settings.bindings),'settings missing bindings');
  // Preserve every setting, including unknown future fields. Secret values are
  // neither required nor retained; secret names and all non-secret bindings are.
  return normalize({...settings,bindings:normalizedBindings(settings.bindings),compatibility_flags:sorted(settings.compatibility_flags??[])});
}
export function parseInputs(args) {
  const [command,...rest]=args;
  assert.ok(['preflight','execute','recover'].includes(command),'invalid command');
  assert.equal(rest.length,8,'four named arguments required');
  const options={};
  for(let i=0;i<rest.length;i+=2){assert.ok(!Object.hasOwn(options,rest[i]),'duplicate argument');options[rest[i]]=rest[i+1];}
  same(Object.keys(options).sort(),['--atmos','--expected-release','--receipt','--sha'],'unexpected arguments');
  validateInputs(options['--sha'],options['--expected-release']);
  assert.ok(options['--atmos']&&!options['--atmos'].startsWith('--'),'missing source directory');
  assert.ok(options['--receipt']&&!options['--receipt'].startsWith('--'),'missing receipt path');
  return {command,atmos:resolve(options['--atmos']),sha:options['--sha'],release:options['--expected-release'],receiptPath:resolve(options['--receipt'])};
}
export function saveReceipt(path,receipt) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const temporary=`${path}.${randomUUID()}.tmp`;
  const fd=openSync(temporary,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(receipt,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temporary,path);chmodSync(path,0o600);
  const directory=openSync(dirname(path),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
export function timeout(limit,deadline,now=Date.now()) {
  assert.ok(deadline>now,'operation deadline exceeded');return Math.min(limit,deadline-now);
}
export function routeMatches(pattern,url) {
  const candidate=new URL(url);
  const value=pattern.includes('://')?candidate.href:candidate.href.slice(candidate.protocol.length+2);
  return new RegExp('^'+pattern.split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*')+'$','i').test(value);
}
export function assertBootstrap(worker,routes) {
  assert.equal(worker,null,'target Worker already exists; manual review required');
  assert.ok(Array.isArray(routes),'route snapshot required');
  for(const route of routes){
    assert.ok(route.script!==WORKER,'target already owns a route');
    // Reject broad matches and narrower descendants/query-specific competitors.
    const probe=route.pattern.replace(/^https?:\/\//,'').replace(/\*/g,'');
    assert.ok(!routeMatches(route.pattern,ORIGIN+'/api/gdacs/list') &&
      !routeMatches(route.pattern,ORIGIN+'/api/gdacs/list?guard=1') &&
      !probe.toLowerCase().startsWith('weatherx.org/api/gdacs/list'),'overlapping GDACS route exists');
  }
}
export function sourceInventory(atmos,sha,git=(args)=>execFileSync('git',args,{cwd:atmos,encoding:'utf8',maxBuffer:16*1024*1024,timeout:30_000})) {
  assert.equal(git(['rev-parse','HEAD']).trim(),sha,'source HEAD mismatch');
  assert.equal(git(['status','--porcelain=v1','--untracked-files=all','--',...SOURCE_PATHS]).trim(),'','source paths must be clean and committed');
  const inventory=git(['ls-tree','-r','HEAD','--',...SOURCE_PATHS]).trim().split('\n').filter(Boolean);
  assert.ok(inventory.length,'empty source inventory');
  for(const entry of inventory)assert.match(entry,/^100644 blob [a-f0-9]{40}\t|^100755 blob [a-f0-9]{40}\t/,'source symlink/submodule rejected');
  const files=new Set(inventory.map(entry=>entry.split('\t')[1]));
  for(const path of ['platform/edge/src/gdacsFeed.ts','platform/edge/wrangler.gdacs.jsonc','platform/edge/package-lock.json','app/functions/api/_weatherFeeds.ts','app/functions/api/_swr.ts','ops/release/verify-weather-feeds.mjs'])assert.ok(files.has(path),'required source not committed');
  return {sha,inventorySha256:sha256(inventory.join('\n')),files};
}
export function assertBuildInputs(inputs,atmos,files) {
  same(Object.keys(inputs).sort(),['../../app/functions/api/_swr.ts','../../app/functions/api/_weatherFeeds.ts','src/gdacsFeed.ts'],'bundle input isolation requires exactly three reviewed files');
  for(const name of Object.keys(inputs)){
    const path=relative(atmos,resolve(atmos,'platform/edge',name)).replaceAll('\\','/');
    assert.ok(!isAbsolute(path)&&!path.startsWith('../')&&files.has(path),'bundle input is not committed reviewed source');
  }
}
export function buildOptions(atmos) {
  return {absWorkingDir:resolve(atmos,'platform/edge'),entryPoints:['src/gdacsFeed.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',write:false,metafile:true,tsconfigRaw:{}};
}
export async function buildSource(atmos,sha) {
  const inventory=sourceInventory(atmos,sha);
  const config=JSON.parse(readFileSync(resolve(atmos,'platform/edge/wrangler.gdacs.jsonc'),'utf8'));
  const expected={name:WORKER,main:'src/gdacsFeed.ts',compatibility_date:'2026-08-18',compatibility_flags:['nodejs_compat'],workers_dev:false,preview_urls:false,routes:[],observability:{enabled:true,head_sampling_rate:1}};
  const {$schema,...actual}=config;same(actual,expected,'unreviewed GDACS configuration');
  const esbuild=await import(pathToFileURL(resolve(atmos,'platform/edge/node_modules/esbuild/lib/main.js')));
  const lock=JSON.parse(readFileSync(resolve(atmos,'platform/edge/package-lock.json'),'utf8'));
  assert.equal(esbuild.version,lock.packages?.['node_modules/esbuild']?.version,'esbuild differs from lockfile');
  const bundle=await esbuild.build(buildOptions(atmos));
  assert.equal(bundle.outputFiles.length,1,'unexpected bundle assets');
  assertBuildInputs(bundle.metafile.inputs,atmos,inventory.files);
  same(sourceInventory(atmos,sha).inventorySha256,inventory.inventorySha256,'source changed during build');
  const bytes=Buffer.from(bundle.outputFiles[0].contents);
  assert.ok(bytes.length>0&&bytes.length<1024*1024,'unexpected module size');
  return {bytes,source:{sha,inventorySha256:inventory.inventorySha256,bundleSha256:sha256(bytes),bundleBytes:bytes.length,esbuildVersion:esbuild.version,inputs:sorted(Object.keys(bundle.metafile.inputs))}};
}
export function createTransport({fetchImpl=globalThis.fetch,deadline=()=>Date.now()+30_000,signal=()=>undefined,tokens=process.env}={}) {
  async function request(url,init={},max=8*1024*1024){
    const signals=[AbortSignal.timeout(timeout(60_000,deadline())),signal(),init.signal].filter(Boolean);
    const response=await fetchImpl(url,{...init,redirect:'error',signal:AbortSignal.any(signals)});
    const chunks=[];let size=0;
    for await(const chunk of response.body??[]){size+=chunk.length;assert.ok(size<=max,'response body cap exceeded');chunks.push(chunk);}
    return {status:response.status,headers:response.headers,body:Buffer.concat(chunks)};
  }
  async function api(path,tokenName='PLATFORM_EDGE_TOKEN',{method='GET',body,allowAbsent=false}={}){
    assert.ok(tokens[tokenName],`missing ${tokenName}`);
    const headers={Authorization:`Bearer ${tokens[tokenName]}`};
    if(body && !(body instanceof FormData)){headers['Content-Type']='application/json';body=JSON.stringify(body);}
    const response=await request(API+path,{method,headers,body});
    const json=JSON.parse(response.body);
    if(allowAbsent && response.status===404 && json.success===false && json.errors?.some(error=>error.code===10007))return null;
    assert.ok(response.status>=200&&response.status<300&&json.success===true,'Cloudflare operation rejected');
    return json.result;
  }
  async function object(key,max=16*1024*1024){
    assert.ok(!key.split('/').some(part=>!part||part==='.'||part==='..'),'invalid R2 key');
    assert.ok(tokens.DATA_EDGE_TOKEN,'missing DATA_EDGE_TOKEN');
    const response=await request(`${API}/accounts/${ACCOUNT}/r2/buckets/weatherx-data-production/objects/${key.split('/').map(encodeURIComponent).join('/')}`,{headers:{Authorization:`Bearer ${tokens.DATA_EDGE_TOKEN}`}},max);
    assert.equal(response.status,200,'R2 read rejected');return response.body;
  }
  async function authenticated(path,tokenName='PLATFORM_EDGE_TOKEN'){
    assert.ok(tokens[tokenName],`missing ${tokenName}`);
    return request(API+path,{headers:{Authorization:`Bearer ${tokens[tokenName]}`}});
  }
  return {request,api,object,authenticated};
}
export async function moduleHash(transport) {
  const response=await transport.authenticated(SCRIPT+'/content/v2');
  assert.equal(response.status,200,'module readback failed');
  const contentType=response.headers.get('content-type')??'';
  if(contentType.startsWith('multipart/form-data')){
    const form=await new Response(response.body,{headers:response.headers}).formData();
    const modules=[...form.entries()];assert.equal(modules.length,1,'unexpected deployed modules');
    assert.equal(modules[0][0],MODULE,'unexpected module name');
    assert.ok(typeof modules[0][1]!=='string','module content is not a file');
    return sha256(Buffer.from(await modules[0][1].arrayBuffer()));
  }
  assert.match(contentType,/javascript|text\/plain/,'unexpected module response type');
  return sha256(response.body);
}
export function makeOperations(transport,atmos,bundle){
  const {api,object}=transport;
  const routes=()=>api(ROUTES,'DATA_EDGE_TOKEN');
  async function worker(){
    const settings=await api(SCRIPT+'/settings','PLATFORM_EDGE_TOKEN',{allowAbsent:true});
    if(settings===null)return null;
    const [subdomain,schedules,deployments,contentSha256]=await Promise.all([api(SCRIPT+'/subdomain'),api(SCRIPT+'/schedules'),api(SCRIPT+'/deployments'),moduleHash(transport)]);
    const version=activeVersion(deployments);
    const detail=await api(SCRIPT+`/versions/${version}`);assert.equal(detail.id,version,'version detail mismatch');
    return {settings:normalizedSettings(settings),subdomain,schedules,version,contentSha256,versionAnnotations:detail.annotations,versionSha256:hash(detail)};
  }
  async function boundary(){
    const consumers={};
    for(const target of CONSUMERS){
      const base=`/accounts/${ACCOUNT}/workers/scripts/${target.name}`;
      const [settings,schedules,subdomain,deployments]=await Promise.all([api(base+'/settings',target.token),api(base+'/schedules',target.token),api(base+'/subdomain',target.token),api(base+'/deployments',target.token)]);
      const state=normalizedSettings(settings);
      for(const [name,text] of Object.entries(target.vars))assert.ok(state.bindings.some(binding=>binding.name===name&&binding.type==='plain_text'&&binding.text===text),'consumer safety mode mismatch');
      const version=activeVersion(deployments);assert.equal(version,target.version,'healthy consumer version changed');
      consumers[target.name]={version,settingsSha256:hash(state),schedulesSha256:hash({...schedules,schedules:sorted(schedules.schedules)}),subdomainSha256:hash(subdomain)};
    }
    const pages=await api(`/accounts/${ACCOUNT}/pages/projects/atmos-platform`,'PAGES_TOKEN');
    assert.equal(pages.canonical_deployment?.environment,'production','Pages canonical is not production');
    assert.equal(pages.canonical_deployment?.latest_stage?.status,'success','Pages canonical is not healthy');
    const raw=await object('releases/current.json',256*1024);
    return {consumers,pages:{id:pages.canonical_deployment.id,sha256:hash(pages.canonical_deployment)},pointer:{release:JSON.parse(raw).releaseId,sha256:sha256(raw)},routes:sorted(await routes())};
  }
  return {worker,routes,boundary,
    upload:async receipt=>{
      const form=new FormData();
      form.set('metadata',new Blob([JSON.stringify({main_module:MODULE,compatibility_date:'2026-08-18',compatibility_flags:['nodejs_compat'],bindings:[],observability:{enabled:true,head_sampling_rate:1},logpush:false,tail_consumers:[],annotations:{'workers/tag':receipt.ownershipTag,'workers/message':`GDACS isolated source ${receipt.sha}`}})],{type:'application/json'}));
      form.set(MODULE,new Blob([bundle.bytes],{type:'application/javascript+module'}),MODULE);
      await api(SCRIPT,'PLATFORM_EDGE_TOKEN',{method:'PUT',body:form});
    },
    disable:()=>api(SCRIPT+'/subdomain','PLATFORM_EDGE_TOKEN',{method:'POST',body:{enabled:false,previews_enabled:false}}),
    attach:()=>api(ROUTES,'DATA_EDGE_TOKEN',{method:'POST',body:{pattern:PATTERN,script:WORKER}}),
    detach:id=>{assert.match(id,/^[a-f0-9]{32}$/,'invalid route id');return api(ROUTES+'/'+id,'DATA_EDGE_TOKEN',{method:'DELETE'});},
    verify:receipt=>verifyLive(transport,atmos,receipt),
    pause:ms=>new Promise(resolvePromise=>setTimeout(resolvePromise,ms)),
  };
}
export function assertOwnedWorker(worker,receipt,{inert=false,pinned=false}={}){
  assert.ok(receipt.intent?.upload && worker,'owned upload not observed');
  assert.equal(worker.contentSha256,receipt.source.bundleSha256,'candidate module changed');
  assert.equal(worker.versionAnnotations?.['workers/tag'],receipt.ownershipTag,'candidate version ownership tag mismatch');
  assert.equal(worker.settings.compatibility_date,'2026-08-18','candidate compatibility changed');
  same(worker.settings.compatibility_flags,['nodejs_compat'],'candidate flags changed');
  same(worker.settings.bindings,[],'candidate bindings changed');
  assert.equal(worker.settings.observability?.enabled,true,'candidate observability disabled');
  assert.equal(worker.settings.observability?.head_sampling_rate,1,'candidate sampling changed');
  assert.ok(!worker.settings.logpush,'candidate logpush enabled');
  same(worker.settings.tail_consumers??[],[],'candidate tail consumers changed');
  same(worker.schedules.schedules,[],'candidate schedules changed');
  assert.match(worker.version,UUID,'invalid candidate version');
  if(inert)same(worker.subdomain,{enabled:false,previews_enabled:false},'candidate development URLs enabled');
  if(pinned)same(worker,receipt.candidate,'candidate state drift');
}
export function ownedRoute(routes,receipt){
  const identity=receipt.route&&routes.find(route=>route.id===receipt.route.id);
  if(identity)same(identity,receipt.route,'owned route identity changed');
  const matches=routes.filter(route=>route.pattern===PATTERN);
  assert.ok(matches.length<=1,'ambiguous GDACS route');
  const route=matches[0];if(!route)return null;
  assert.ok(receipt.intent?.attach,'route exists without durable attach intent');
  assert.ok(!receipt.before.routes.some(old=>old.id===route.id),'cannot own an existing route');
  assert.equal(route.script,WORKER,'route belongs to another publisher');
  assert.match(route.id,/^[a-f0-9]{32}$/,'invalid owned route id');
  if(receipt.route)assert.equal(route.id,receipt.route.id,'owned route identity changed');
  return route;
}
export function assertBoundary(current,receipt,allowRoute=false){
  const route=allowRoute?ownedRoute(current.routes,receipt):null;
  const without={...current,routes:current.routes.filter(item=>item.id!==route?.id)};
  same(without,receipt.before,'protected production boundary drift');
  return route;
}
export async function recover(receipt,ops,persist){
  if(receipt.status==='passed')return receipt;
  receipt.recovery='started';persist();
  // Foreign production changes must fail qualification, not block containment
  // of the strictly owned GDACS route. Record only hashes/categories; never
  // restore a consumer, Pages deployment, pointer, or another publisher's route.
  async function observeForeignBoundary(){
    try{
      const current=await ops.boundary();
      const without={...current,routes:current.routes.filter(route=>route.id!==receipt.route?.id)};
      if(canonical(without)!==canonical(receipt.before))receipt.foreignDrift={kind:'protected-boundary-changed',sha256:hash(without),manualReview:true};
    }catch{receipt.foreignDrift={kind:'protected-boundary-read-failed',manualReview:true};}
    persist();
  }
  if(!receipt.intent?.upload){
    await observeForeignBoundary();receipt.recovery='no-owned-mutation';receipt.status='failed-no-mutation';persist();return receipt;
  }
  try{
    const route=ownedRoute(await ops.routes(),receipt);
    if(route){receipt.route=route;persist();}
    await observeForeignBoundary();
    const worker=await ops.worker();
    if(worker){
      assertOwnedWorker(worker,receipt,{pinned:!!receipt.candidate});
      // A cancellation between upload and URL-disable still owns the candidate.
      // This is the only idempotent containment mutation; never retry the upload.
      if(worker.subdomain.enabled||worker.subdomain.previews_enabled){receipt.intent.disable=true;persist();try{await ops.disable();}catch{};assertOwnedWorker(await ops.worker(),receipt,{inert:true});}
    }else assert.equal(route,null,'route points to missing candidate');
    if(route){
      assertOwnedWorker(await ops.worker(),receipt,{inert:true,pinned:!!receipt.candidate});
      // Immediately recheck our exact route identity, but do not overwrite or
      // require restoration of concurrently changed unrelated route entries.
      const currentRoute=ownedRoute(await ops.routes(),receipt);same(currentRoute,route,'route changed before detach');
      receipt.route=route;receipt.intent.detach=true;persist();
      try{await ops.detach(route.id);}catch{} // Response loss is resolved by readback, not retried.
    }
    const remainingRoutes=await ops.routes();
    assert.equal(ownedRoute(remainingRoutes,receipt),null,'owned route remains attached');
    assert.ok(!remainingRoutes.some(route=>route.script===WORKER),'candidate has a foreign route; cannot claim quarantine');
    if(worker)assertOwnedWorker(await ops.worker(),receipt,{inert:true,pinned:!!receipt.candidate});
    await observeForeignBoundary();
    receipt.recovery=worker?'route-removed-candidate-quarantined':'no-owned-mutation';
    receipt.status=worker?(receipt.foreignDrift?'failed-contained-manual-review':'failed-contained'):'failed-no-mutation';persist();return receipt;
  }catch{receipt.recovery='incomplete-manual-review';receipt.status='rollback-incomplete';persist();throw Error('GDACS recovery incomplete; inspect private receipt');}
}
export async function execute(receipt,ops,persist){
  assert.equal(receipt.status,'preflight-passed','preflight receipt required');
  assert.ok(Date.now()-Date.parse(receipt.createdAt)<15*60_000,'preflight expired');
  const stage=async(name,action)=>{receipt.stage=name;persist();try{return await action();}catch(error){receipt.failedStage=name;receipt.errorKind=error?.code==='ERR_ASSERTION'?'assertion':error?.name==='AbortError'?'aborted':'error';persist();throw error;}};
  try{
    await stage('bootstrap-recheck',async()=>{assertBoundary(await ops.boundary(),receipt);assertBootstrap(await ops.worker(),await ops.routes());});
    receipt.status='executing';receipt.intent={upload:true};persist();
    await stage('upload',async()=>{
      try{await ops.upload(receipt);}catch{receipt.uploadResponseLost=true;persist();}
      // The absent-to-new Worker is ours only with BOTH exact bytes and random tag.
      assertOwnedWorker(await ops.worker(),receipt);
    });
    receipt.intent.disable=true;persist();
    await stage('disable-development-urls',async()=>{try{await ops.disable();}catch{receipt.disableResponseLost=true;persist();}assertOwnedWorker(await ops.worker(),receipt,{inert:true});});
    await stage('candidate-readback',async()=>{receipt.candidate=await ops.worker();assertOwnedWorker(receipt.candidate,receipt,{inert:true});persist();assertBoundary(await ops.boundary(),receipt);});
    await stage('attach-route',async()=>{
      assertOwnedWorker(await ops.worker(),receipt,{inert:true,pinned:true});
      assertBoundary(await ops.boundary(),receipt);
      // No API supports route CAS. Store intent, then a final full route re-read.
      receipt.intent.attach=true;persist();same(sorted(await ops.routes()),receipt.before.routes,'route inventory changed before attach');
      try{await ops.attach();}catch{receipt.routeResponseLost=true;persist();}
      receipt.route=ownedRoute(await ops.routes(),receipt);assert.ok(receipt.route,'route attachment absent');persist();
      assertBoundary(await ops.boundary(),receipt,true);
    });
    for(let round=1;round<=3;round++){
      if(round>1)await ops.pause(15_000);
      await stage(`verification-${round}`,async()=>{assertOwnedWorker(await ops.worker(),receipt,{inert:true,pinned:true});assertBoundary(await ops.boundary(),receipt,true);await ops.verify(receipt);assertBoundary(await ops.boundary(),receipt,true);});
    }
    receipt.status='passed';receipt.completedAt=new Date().toISOString();persist();return receipt;
  }catch{
    receipt.status='failed';persist();
    // A separate recover CLI is mandatory in the workflow even if this succeeds.
    ops.resetRecovery?.();await recover(receipt,ops,persist);
    throw Error(receipt.status==='failed-no-mutation'?'GDACS qualification refused; no owned production mutation':receipt.foreignDrift?'GDACS failure contained; foreign production drift requires manual review':'GDACS verification failed; owned route removed and candidate quarantined');
  }
}
function tsLoader(){
  return registerHooks({resolve(specifier,context,next){if(specifier.startsWith('.')&&context.parentURL?.endsWith('.ts')&&existsSync(fileURLToPath(new URL(specifier+'.ts',context.parentURL))))return next(specifier+'.ts',context);return next(specifier,context);},load(url,context,next){if(url.startsWith('file:')&&url.endsWith('.ts'))return {format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8')),shortCircuit:true};return next(url,context);}});
}
async function pointProof(transport,atmos,release){
  const pointerBytes=await transport.object('releases/current.json',256*1024),pointer=JSON.parse(pointerBytes);
  assert.equal(pointer.releaseId,release,'published release changed');assert.equal(pointer.pointSeries?.schemaVersion,2,'v2 point series required');
  const manifest=JSON.parse(await transport.object(`releases/${release}/manifest.json`));
  const {buildReleasePointer}=await import(pathToFileURL(resolve(atmos,'ops/platform/build-release-pointer.mjs')));
  same(buildReleasePointer(manifest,release,pointer.publishedAt),pointer,'pointer manifest mismatch');
  const records=new Map(manifest.objects.map(item=>[item.path,item]));
  const loader=tsLoader();
  try{
    const {servePointSeries}=await import(pathToFileURL(resolve(atmos,'platform/edge/src/pointSeries.ts')));
    const points=[],cache=new Map();
    const env={AUTH_MODE:'observe',APP_ORIGIN:`https://gdacs-proof-${randomUUID()}.invalid`,DATA_POINTER_KEY:'releases/current.json',DATA_BUCKET:{async get(key){
      if(key==='releases/current.json')return {size:pointerBytes.length,json:async()=>pointer};
      const prefix=`releases/${release}/`;assert.ok(key.startsWith(prefix+'point-series/v2/'),'source requested unexpected object');
      if(!cache.has(key))cache.set(key,verifiedObject(await transport.object(key,512*1024),records.get(key.slice(prefix.length))));
      const bytes=cache.get(key);return {size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
    }}};
    for(const model of ['ecmwf','gfs']){
      const descriptor=pointer.pointSeries.models[model];requireFreshDescriptor(descriptor);
      const start=Math.ceil(Date.now()/3_600_000)*3_600_000;
      const params=new URLSearchParams({lat:'41.88',lon:'-87.63',run:descriptor.runId,variables:'temperature,wind_speed,wind_direction,precipitation',start:new Date(start).toISOString(),end:new Date(start+12*3_600_000).toISOString()});
      const url=`${ORIGIN}/api/v1/point-series/${model}?${params}`;
      const response=await servePointSeries(new Request(url),env,model,undefined,{cache:null});assert.equal(response.status,200,'source cannot decode point pack');
      const payload=await response.json();assert.equal(payload.releaseId,release);assert.equal(payload.runId,descriptor.runId);assert.equal(payload.quality,'complete');
      for(const series of Object.values(payload.series))assert.ok(series.samples.some(sample=>Number.isFinite(sample.value)),'point series has no finite values');
      points.push({model,url,payload,payloadSha256:sha256(JSON.stringify(payload))});
    }
    return {pointerSha256:sha256(pointerBytes),points};
  }finally{loader.deregister();}
}
async function safetyChecks(transport,receipt){
  for(const [path,wanted] of [['/api/platform/health',{ok:true,authMode:'observe',billingMode:'disabled'}],['/api/platform/data-health',{ok:true,authMode:'public',catalogMode:'serve'}]]){
    const response=await transport.request(ORIGIN+path);assert.equal(response.status,200,'health status failed');same(JSON.parse(response.body),wanted,'health safety mode failed');
  }
  for(const point of receipt.proof.points){
    const response=await transport.request(point.url);assert.equal(response.status,200,'point status failed');assert.equal(response.headers.get('x-weatherx-release'),receipt.release,'point release header changed');
    assert.equal(sha256(JSON.stringify(point.payload)),point.payloadSha256,'reference point hash changed');assertPointPayload(JSON.parse(response.body),point.payload);
  }
}
export async function verifyLive(transport,atmos,receipt,verification){
  await safetyChecks(transport,receipt);
  const {verifyWeatherFeeds}=verification??await import(pathToFileURL(resolve(atmos,'ops/release/verify-weather-feeds.mjs')));
  const original=globalThis.fetch;
  try{
    // Execute the original source verifier unchanged, with an outer byte/deadline
    // cap and no redirects. Its list and representative geometry gates all run.
    globalThis.fetch=async(url,init)=>{assert.equal(new URL(url).origin,ORIGIN,'verifier escaped origin');const response=await transport.request(url,init);return new Response(response.body,{status:response.status,headers:response.headers});};
    receipt.feedChecks=await verifyWeatherFeeds(ORIGIN);
  }finally{globalThis.fetch=original;}
  for(const suffix of ['', '?guard=query']){
    const response=await transport.request(ORIGIN+'/api/gdacs/list'+suffix);assert.equal(response.status,200,'GDACS route not served');
    assert.equal(response.headers.get('x-weatherx-feed'),'gdacs-events4app-v1','isolated feed provenance missing');
    const payload=JSON.parse(response.body);assert.equal(payload.type,'FeatureCollection');assert.ok(Array.isArray(payload.features));assert.match(response.headers.get('x-swr-age')??'',/^\d+$/);assert.ok(Number(response.headers.get('x-swr-age'))<86_400);
  }
}
async function beforeFeedDiagnostics(transport){
  const diagnostics=[];
  for(const [path,key] of [['/api/tc/list','features'],['/api/eonet/list','events'],['/api/gdacs/list','features']]){
    try{
      const response=await transport.request(ORIGIN+path);assert.equal(response.status,200);const payload=JSON.parse(response.body);assert.ok(Array.isArray(payload[key]));if(key==='features')assert.equal(payload.type,'FeatureCollection');
      const age=response.headers.get('x-swr-age');assert.match(age??'',/^\d+$/);assert.ok(Number(age)<86_400);diagnostics.push({path,healthy:true,count:payload[key].length});
    }catch{diagnostics.push({path,healthy:false});assert.equal(path,'/api/gdacs/list','previously healthy feed failed preflight');}
  }
  return diagnostics;
}
function assertWorkflow(){
  assert.equal(process.env.GITHUB_ACTIONS,'true','mutation requires guarded GitHub Actions');assert.equal(process.env.GITHUB_REPOSITORY,'Andrewegao/v3t7kq-cycle');assert.equal(process.env.GITHUB_REF,'refs/heads/main');assert.equal(process.env.GITHUB_WORKFLOW_REF,'Andrewegao/v3t7kq-cycle/.github/workflows/gdacs-feed-release.yml@refs/heads/main');
}
export async function main(args=process.argv.slice(2)){
  const {command,atmos,sha,release,receiptPath}=parseInputs(args);
  let deadline=Date.now()+(command==='execute'?10:6)*60_000,cancellation=new AbortController();
  const cancel=()=>cancellation.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  let receipt;
  try{
    const transport=createTransport({deadline:()=>deadline,signal:()=>cancellation.signal});
    // Recovery uses only the immutable receipt, never a build that can block
    // containment after a cancelled/failed upload. Source options still must match.
    const bundle=command==='recover'?null:await buildSource(atmos,sha);
    const ops=makeOperations(transport,atmos,bundle);
    ops.resetRecovery=()=>{deadline=Date.now()+4*60_000;cancellation=new AbortController();};
    const persist=()=>saveReceipt(receiptPath,receipt);
    if(command==='preflight'){
      assert.ok(!existsSync(receiptPath),'refuse to replace an existing receipt');
      const before=await ops.boundary();assert.equal(before.pointer.release,release,'expected release is not current');assertBootstrap(await ops.worker(),before.routes);
      const proof=await pointProof(transport,atmos,release);assert.equal(proof.pointerSha256,before.pointer.sha256,'proof pointer changed');
      receipt={schemaVersion:1,sha,release,source:bundle.source,ownershipTag:`gdacs-${randomUUID()}`,createdAt:new Date().toISOString(),workflowRun:process.env.GITHUB_RUN_ID??null,workflowAttempt:process.env.GITHUB_RUN_ATTEMPT??null,before,proof,status:'preflight-passed'};
      await safetyChecks(transport,receipt);receipt.feedDiagnostics=await beforeFeedDiagnostics(transport);
      assertBoundary(await ops.boundary(),receipt);persist();console.log('GDACS preflight passed; no production mutation');return receipt;
    }
    assertWorkflow();receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
    assert.equal(receipt.schemaVersion,1);assert.equal(receipt.sha,sha);assert.equal(receipt.release,release);assert.equal(receipt.workflowRun,process.env.GITHUB_RUN_ID);assert.equal(receipt.workflowAttempt,process.env.GITHUB_RUN_ATTEMPT);
    assert.match(receipt.ownershipTag,/^gdacs-[a-f0-9-]{36}$/);assert.equal(receipt.before.pointer.release,release);
    if(command==='recover'){await recover(receipt,ops,persist);console.log(`GDACS recovery status: ${receipt.recovery??'not-needed'}`);return receipt;}
    same(bundle.source,receipt.source,'build differs from preflight');await execute(receipt,ops,persist);console.log('GDACS feed qualified three times; protected production boundaries unchanged');return receipt;
  }finally{process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('GDACS guarded operation failed; inspect private receipt and run guarded recovery');process.exitCode=1;});
