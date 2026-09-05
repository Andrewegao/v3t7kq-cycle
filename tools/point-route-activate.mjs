#!/usr/bin/env node
// Phase 2 is route-only. Import the reviewed readers and boundary utilities;
// never call version upload/deploy, mutate settings, publish data or touch Pages.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, makeOperations, WORKER } from './data-reader-refresh.mjs';
import { createTransport, canonical, saveReceipt, ZONE, routeMatches } from './gdacs-feed-release.mjs';
import { assertPointPayload } from './consumer-refresh.mjs';
import { pinnedMapUrl } from './data-reader-proof.mjs';

export const PATTERN='weatherx.org/api/v1/point-series/*';
export const UI_VARIABLES=['temperature','wind_speed','wind_direction','wind_gust','precipitation','dewpoint','visibility','solar_radiation'];
const ROUTES=`/zones/${ZONE}/workers/routes`;
const DATA='weatherx-data-production',COMPONENTS='weatherx-components-production';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{40}$/,DIGEST=/^[a-f0-9]{64}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const digest=value=>hash(canonical(value));
const same=(a,b,message)=>assert.ok(canonical(a)===canonical(b),message);

export function validatePair(model,map,point,index,now=Date.now()){
  assert.ok(['ecmwf','gfs'].includes(model));assert.ok(map&&point,'fresh paired model components required');
  assert.equal(map.componentId,model);assert.equal(point.componentId,`point-${model}`);
  same(map.mounts,[`data/${model}/`],'map mount changed');same(point.mounts,[`point-series/v2/${model}/`],'point mount changed');
  assert.equal(map.quality?.status,'passed');assert.equal(point.quality?.status,'passed');
  assert.ok(point.quality.checks.includes('point_series'),'point quality receipt absent');
  const descriptor=point.pointSeries?.descriptor;assert.equal(point.pointSeries?.modelId,model);assert.ok(descriptor,'point descriptor absent');
  assert.equal(Date.parse(map.generationTime),Date.parse(point.generationTime),'map/point generation mismatch');
  assert.equal(Date.parse(descriptor.initializedAt),Date.parse(map.generationTime),'descriptor generation mismatch');
  const run=new Date(map.generationTime).toISOString().replace(/[-:]/g,'').replace('T','').slice(0,10);
  assert.match(run,/^\d{10}$/);assert.equal(descriptor.runId,run,'point run identity mismatch');
  assert.ok(Date.parse(descriptor.initializedAt)<=now,'future model run');
  assert.ok(Date.parse(descriptor.freshUntil)>now+30*60_000,'point freshness reserve less than 30 minutes');
  assert.equal(descriptor.storage?.format,'WXPS1','packed point format required');
  assert.equal(index.model,model);assert.ok(Array.isArray(index.runs)&&index.runs.length,'map index runs absent');
  const latest=[...index.runs].sort((a,b)=>Date.parse(b.init_time)-Date.parse(a.init_time))[0];
  assert.equal(Date.parse(latest.init_time),Date.parse(descriptor.initializedAt),'map latest run differs from point');
  assert.equal(latest.path,`runs/${run}/`,'map run path differs from point');
  return descriptor;
}
export function validatePayload(payload,model,descriptor,catalogId){
  assert.equal(payload.model,model);assert.equal(payload.runId,descriptor.runId);assert.equal(payload.releaseId,catalogId,'point did not use paired catalog');
  assert.equal(payload.quality,'complete','point forecast incomplete or stale');same(payload.missingFields,[],'point fields missing');
  assert.ok(!payload.runSelection,'unexpected run fallback');
  for(const field of ['temperature','wind_speed'])assert.ok(payload.series?.[field]?.samples?.some(sample=>Number.isFinite(sample.value)),'point lacks finite weather values');
}
export function validateUiPayload(payload,model,descriptor,catalogId,start,end){
  assert.equal(payload.schemaVersion,1);assert.equal(payload.model,model);assert.equal(payload.runId,descriptor.runId);
  assert.equal(payload.releaseId,catalogId);assert.ok(!payload.runSelection,'UI run fallback prohibited');
  for(const key of ['initializedAt','generatedAt','freshUntil','source','nativeCadenceSeconds'])assert.equal(payload[key],descriptor[key],`UI source ${key} differs`);
  assert.ok(typeof payload.source==='string'&&payload.source.trim(),'UI source absent');
  assert.ok(Date.parse(payload.freshUntil)>Date.now(),'UI point series stale');
  assert.ok(Number.isInteger(payload.nativeCadenceSeconds)&&payload.nativeCadenceSeconds>=3600&&payload.nativeCadenceSeconds<=21600,'UI cadence invalid');
  same(payload.window,{start:new Date(start).toISOString(),end:new Date(end).toISOString()},'UI request window differs');
  const units={temperature:['C','°C','celsius'],wind_speed:['m/s','m s-1'],wind_direction:['degree','degrees'],wind_gust:['m/s','m s-1'],precipitation:['mm'],dewpoint:['C','°C','celsius'],visibility:['km'],solar_radiation:['W/m2','W/m²']};
  assert.ok(payload.series&&Object.keys(payload.series).every(field=>UI_VARIABLES.includes(field)),'unexpected UI field');
  const missing=[];
  for(const field of UI_VARIABLES){
    const variable=payload.series[field];
    if(!variable){missing.push(field);continue;}
    assert.ok(units[field].includes(variable.units),`UI ${field} units invalid`);
    assert.ok(['instantaneous','interval'].includes(variable.kind)&&Array.isArray(variable.samples),'UI series malformed');
    let previous=-Infinity;
    for(const sample of variable.samples){
      assert.ok(sample.value===null||Number.isFinite(sample.value),'UI sample value invalid');
      const time=Date.parse(variable.kind==='instantaneous'?sample.validTime:sample.endTime);
      assert.ok(Number.isFinite(time)&&time>previous,'UI sample time invalid or unordered');previous=time;
      if(variable.kind==='instantaneous')assert.ok(time>=start&&time<end,'UI sample outside request');
      else{const from=Date.parse(sample.startTime);assert.ok(Number.isFinite(from)&&from<time&&time>start&&from<end,'UI interval invalid');}
    }
    if(!variable.samples.some(sample=>Number.isFinite(sample.value)))missing.push(field);
  }
  same([...payload.missingFields].sort(),missing.sort(),'UI missing-field honesty differs');
  assert.equal(payload.quality,missing.length?'partial':'complete','UI quality must reflect optional missing fields');
  assert.ok(!missing.includes('temperature'),'UI has no finite temperature');
  return {quality:payload.quality,missingFields:missing,availableFields:UI_VARIABLES.filter(field=>!missing.includes(field)),sampleCounts:Object.fromEntries(Object.entries(payload.series).map(([field,value])=>[field,value.samples.length]))};
}
export function assertRouteAbsent(routes){
  assert.ok(Array.isArray(routes));
  assert.ok(routes.some(r=>r.pattern==='weatherx.org/api/v1/*'&&r.script==='weatherx-platform-edge-production'),'platform wildcard missing');
  for(const route of routes){
    const path=route.pattern.replace(/^https?:\/\//,'').toLowerCase();
    assert.ok(!path.startsWith('weatherx.org/api/v1/point-series'),'existing exact or narrower point route needs owner review');
    if(routeMatches(route.pattern,'https://weatherx.org/api/v1/point-series/gfs?lat=39.9'))assert.ok(route.pattern==='weatherx.org/api/v1/*'&&route.script==='weatherx-platform-edge-production','unexpected overlapping point route');
  }
}
function routeRecord(route){
  assert.ok(Object.keys(route).every(k=>['id','pattern','script','request_limit_fail_open'].includes(k)),'unknown route setting');
  assert.ok(route.request_limit_fail_open==null||route.request_limit_fail_open===false,'fail-open route prohibited');
  return {...route,request_limit_fail_open:false};
}
export function ownedRoute(routes,receipt){
  assert.ok(receipt.route?.id,'route ownership was not acknowledged');
  assert.match(receipt.route.id,/^[a-f0-9]{32}$/);
  assert.ok(!receipt.before.routes.some(r=>r.id===receipt.route.id),'cannot own pre-existing route');
  const found=routes.find(r=>r.id===receipt.route.id);
  if(found)same(routeRecord(found),routeRecord(receipt.route),'owned route tuple changed');
  return found??null;
}
export function assertBoundary(current,receipt,withRoute=false){
  const normalized=structuredClone(current);
  if(withRoute){const owned=ownedRoute(normalized.routes,receipt);assert.ok(owned,'owned route disappeared');normalized.routes=normalized.routes.filter(r=>r.id!==owned.id);}
  same(normalized,receipt.before,'protected production boundary drift');
}
export async function recover(receipt,ops,persist){
  if(receipt.status==='passed')return;
  receipt.recovery='started';persist();
  try{
    const routes=await ops.routes();
    if(!receipt.route){
      // A matching tuple after a lost POST response is not proof that WE created
      // it. No route annotations/CAS exist; require manual review, never infer ID.
      assertRouteAbsent(routes);receipt.recovery='no-owned-route';persist();return;
    }
    const owned=ownedRoute(routes,receipt);
    if(!owned){receipt.recovery='owned-route-absent';persist();return;}
    assertBoundary(await ops.boundary(true),receipt,true);
    await ops.assertSource(receipt);
    same(ownedRoute(await ops.routes(),receipt),owned,'route changed before deletion');
    receipt.deleteIntent=true;persist();
    try{await ops.detach(owned.id);}catch{receipt.deleteResponseLost=true;persist();}
    assert.equal(ownedRoute(await ops.routes(),receipt),null,'owned route remains');
    assertBoundary(await ops.boundary(false),receipt);
    receipt.recovery='owned-route-removed';persist();
  }catch{receipt.recovery='manual-route-review-required';persist();throw Error('point route recovery requires manual review; no outsider route changed');}
}
export async function execute(receipt,ops,persist){
  assert.equal(receipt.status,'preflight-passed');assert.ok(Date.now()-Date.parse(receipt.createdAt)<10*60_000,'preflight expired');
  try{
    assertBoundary(await ops.boundary(false),receipt);await ops.assertSource(receipt);assertRouteAbsent(await ops.routes());
    receipt.proof=await ops.prove();persist();
    assertBoundary(await ops.boundary(false),receipt);await ops.assertSource(receipt);
    receipt.createIntent=true;persist();
    const route=await ops.attach();
    assert.match(route?.id??'',/^[a-f0-9]{32}$/);same({pattern:route.pattern,script:route.script},{pattern:PATTERN,script:WORKER},'create response route mismatch');
    receipt.route=route;persist();
    for(let round=0;round<3;round++){
      if(round)await ops.pause(15_000);
      assertBoundary(await ops.boundary(true),receipt,true);await ops.assertSource(receipt);
      receipt.proof=await ops.verify();persist();
      assertBoundary(await ops.boundary(true),receipt,true);await ops.assertSource(receipt);
    }
    receipt.status='passed';receipt.completedAt=new Date().toISOString();persist();
  }catch{receipt.status='failed';persist();ops.resetRecovery?.();await recover(receipt,ops,persist);throw Error(`point route activation failed; ${receipt.recovery}`);}
}

function r2(bytes){return {size:bytes.length,etag:hash(bytes),httpEtag:`"${hash(bytes)}"`,customMetadata:{sha256:hash(bytes)},body:new Uint8Array(bytes),json:async()=>JSON.parse(bytes),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),writeHttpMetadata(headers){headers.set('Content-Type','application/json');}};}
export async function provePairs(atmos,object,transport,{live=false}={}){
  // build() already ran actual TS source imports before constructing operations.
  const {isCatalogPointer,isDataCatalog}=await import(pathToFileURL(resolve(atmos,'platform/edge/src/catalog.ts')));
  const reader=(await import(pathToFileURL(resolve(atmos,'platform/edge/src/dataEdge.ts')))).default;
  const pointerBytes=await object(DATA,'catalogs/current.json',256*1024),pointer=JSON.parse(pointerBytes);
  assert.ok(isCatalogPointer(pointer),'invalid current catalog pointer');
  const key=`catalogs/snapshots/${pointer.catalogId}.json`,bytes=await object(DATA,key,4*1024*1024);
  assert.equal(hash(bytes),pointer.catalogSha256,'catalog hash mismatch');const catalog=JSON.parse(bytes);assert.ok(isDataCatalog(catalog),'invalid catalog');
  const held=new Map([['catalogs/current.json',pointerBytes],[key,bytes]]),allowed=new Map(),pairs={};
  const fetched=[];
  for(const model of ['ecmwf','gfs']){
    const map=catalog.components[model],point=catalog.components[`point-${model}`];assert.ok(map&&point,'paired catalog components absent');
    for(const component of [map,point]){
      const raw=await object(COMPONENTS,component.manifestKey,256*1024);assert.equal(hash(raw),component.manifestSha256,'component hash mismatch');
      const {manifestKey,manifestSha256,...manifest}=component;same(JSON.parse(raw),manifest,'component identity mismatch');
    }
    const indexBytes=await object(COMPONENTS,map.rootPrefix+'index.json',256*1024),index=JSON.parse(indexBytes);
    const descriptor=validatePair(model,map,point,index);
    allowed.set(map.rootPrefix+'index.json',indexBytes);pairs[model]={descriptor,indexSha256:hash(indexBytes),pointPrefix:`${point.rootPrefix}${descriptor.runId}/chunks/`};
  }
  const env={AUTH_MODE:'public',DATA_CATALOG_MODE:'serve',APP_ORIGIN:`https://point-cutover-${randomUUID()}.invalid`,DATA_POINTER_KEY:'releases/current.json',DATA_CATALOG_POINTER_KEY:'catalogs/current.json',
    DATA_BUCKET:{get:async k=>{assert.ok(held.has(k),'whole-release fallback prohibited');return r2(held.get(k));}},
    COMPONENT_BUCKET:{get:async k=>{
      let raw=allowed.get(k);
      if(!raw){assert.ok(Object.values(pairs).some(p=>k.startsWith(p.pointPrefix)&&/^\d+\/\d+\.bin\.gz$/.test(k.slice(p.pointPrefix.length))),'unreviewed component read');raw=await object(COMPONENTS,k,512*1024);allowed.set(k,raw);}
      fetched.push({key:k,bytes:raw.length,sha256:hash(raw)});return r2(raw);
    }},
  };
  const rows=[],uiRows=[];
  for(const [model,pair] of Object.entries(pairs)){
    const mapUrl=pinnedMapUrl(pointer.catalogId,model),local=await reader.fetch(new Request(mapUrl),env);
    assert.equal(local.status,200);assert.equal(local.headers.get('x-weatherx-catalog'),pointer.catalogId);
    const localBytes=Buffer.from(await local.arrayBuffer()),remote=await transport.request(mapUrl);
    assert.equal(remote.status,200);assert.equal(remote.headers.get('x-weatherx-catalog'),pointer.catalogId);assert.equal(hash(remote.body),hash(localBytes),'pinned map bytes differ');
    for(const [place,lat,lon] of [['Beijing',39.9,116.4],['Shanghai',31.23,121.47],['Chicago',41.88,-87.63]]){
      const start=Math.ceil(Date.now()/3_600_000)*3_600_000;
      const query=new URLSearchParams({lat:String(lat),lon:String(lon),run:pair.descriptor.runId,variables:'temperature,wind_speed',start:new Date(start).toISOString(),end:new Date(start+12*3_600_000).toISOString()});
      const url=`https://weatherx.org/api/v1/point-series/${model}?${query}`;
      const response=await reader.fetch(new Request(url),env);assert.equal(response.status,200,'local paired point read failed');
      assert.equal(response.headers.get('x-weatherx-release'),pointer.catalogId,'local point snapshot drift');
      const payload=await response.json();validatePayload(payload,model,pair.descriptor,pointer.catalogId);
      if(live){const actual=await transport.request(url);assert.equal(actual.status,200,'public paired point read failed');assert.equal(actual.headers.get('x-weatherx-release'),pointer.catalogId,'public point cache has another catalog');const value=JSON.parse(actual.body);validatePayload(value,model,pair.descriptor,pointer.catalogId);assertPointPayload(value,payload);}
      rows.push({model,place,runId:payload.runId,catalogId:pointer.catalogId,quality:payload.quality,freshUntil:payload.freshUntil,payloadSha256:digest(payload)});
      // Separate from the minimal complete core proof: the actual expanded-card
      // request includes optional fields and asks for 14 days, not 14 days of
      // invented coverage. Preserve honest partial responses and exact source.
      const uiStart=Math.floor(Date.now()/3_600_000)*3_600_000,uiEnd=uiStart+14*24*3_600_000;
      const uiQuery=new URLSearchParams({lat:String(lat),lon:String(lon),run:pair.descriptor.runId,runFallback:'current',variables:UI_VARIABLES.join(','),start:new Date(uiStart).toISOString(),end:new Date(uiEnd).toISOString()});
      const uiUrl=`https://weatherx.org/api/v1/point-series/${model}?${uiQuery}`;
      const reference=await reader.fetch(new Request(uiUrl),env);assert.equal(reference.status,200,'local expanded forecast read failed');
      assert.equal(reference.headers.get('x-weatherx-release'),pointer.catalogId);
      const uiPayload=await reference.json(),summary=validateUiPayload(uiPayload,model,pair.descriptor,pointer.catalogId,uiStart,uiEnd);
      if(live){const actual=await transport.request(uiUrl);assert.equal(actual.status,200,'public expanded forecast read failed');assert.equal(actual.headers.get('x-weatherx-release'),pointer.catalogId,'expanded forecast cache has another catalog');const value=JSON.parse(actual.body);validateUiPayload(value,model,pair.descriptor,pointer.catalogId,uiStart,uiEnd);assertPointPayload(value,uiPayload);}
      uiRows.push({model,place,runId:uiPayload.runId,catalogId:pointer.catalogId,source:uiPayload.source,window:uiPayload.window,...summary,payloadSha256:digest(uiPayload)});
    }
  }
  assert.equal(hash(await object(DATA,'catalogs/current.json',256*1024)),hash(pointerBytes),'catalog changed during qualification');
  return {catalogId:pointer.catalogId,catalogSha256:pointer.catalogSha256,observedAt:new Date().toISOString(),rows,uiRows,objects:fetched};
}
export function operations(transport,atmos,source){
  // The imported Phase1 operations receive a read-only API view. Its mutation
  // methods are never used and would throw before transport if called by mistake.
  const readTransport={...transport,api:(path,token,options)=>{assert.ok(!options?.method||options.method==='GET','Phase1 mutation prohibited');return transport.api(path,token,options);}};
  const baseRoutes=source.settings.routes.filter(x=>x.pattern!==PATTERN);
  const pre=makeOperations(readTransport,atmos,{...source,settings:{...source.settings,routes:baseRoutes}});
  const post=makeOperations(readTransport,atmos,{...source,settings:{...source.settings,routes:[...baseRoutes,{pattern:PATTERN,zone_name:'weatherx.org'}]}});
  return {
    boundary:withRoute=>(withRoute?post:pre).boundary(),routes:()=>transport.api(ROUTES,'DATA_EDGE_TOKEN'),
    assertSource:async receipt=>{assert.equal(await pre.active(),receipt.versionId,'data version changed');const version=await pre.version(receipt.versionId);assert.equal(version.id,receipt.versionId);assert.equal(version.annotations?.['workers/commit_sha'],receipt.sha,'active source differs');assert.ok(version.annotations?.['workers/tag']?.endsWith('-full'),'Phase1 full reader required');assert.equal(version.resources?.script?.etag,receipt.scriptEtag,'active module changed');},
    prove:()=>provePairs(atmos,pre.object,transport),
    verify:async()=>{
      // The public point route has no catalog-pin input. Its 30s pointer cache may
      // lag a new publication; bounded retries always re-prove a coherent snapshot.
      for(let attempt=0;attempt<3;attempt++){try{return await provePairs(atmos,pre.object,transport,{live:true});}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,16_000));}}
    },
    attach:()=>transport.api(ROUTES,'DATA_EDGE_TOKEN',{method:'POST',body:{pattern:PATTERN,script:WORKER}}),
    detach:id=>{assert.match(id,/^[a-f0-9]{32}$/);return transport.api(ROUTES+'/'+id,'DATA_EDGE_TOKEN',{method:'DELETE'});},
    pause:ms=>new Promise(r=>setTimeout(r,ms)),
  };
}
export async function main(args=process.argv.slice(2)){
  const [command,atmosInput,sha,versionId,scriptEtag,expectedDigest,receiptInput]=args;
  assert.equal(args.length,7);assert.ok(['preflight','execute','recover'].includes(command));assert.match(sha??'',SHA);assert.match(versionId??'',UUID);assert.match(scriptEtag??'',DIGEST);assert.match(expectedDigest??'',DIGEST);
  const atmos=resolve(atmosInput),receiptPath=resolve(receiptInput),source=await build(atmos,sha);
  let deadline=Date.now()+8*60_000;
  const transport=createTransport({deadline:()=>deadline}),ops=operations(transport,atmos,source);ops.resetRecovery=()=>{deadline=Date.now()+3*60_000;};
  if(command==='preflight'){
    const before=await ops.boundary(false);assertRouteAbsent(before.routes);
    const receipt={schemaVersion:1,sha,versionId,scriptEtag,before,createdAt:new Date().toISOString(),controller:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT};
    await ops.assertSource(receipt);const actual=digest({before,sha,versionId,scriptEtag});console.log(`point-route boundary sha256: ${actual}`);assert.equal(actual,expectedDigest,'reviewed boundary digest required');
    receipt.proof=await ops.prove();receipt.status='preflight-passed';saveReceipt(receiptPath,receipt);return;
  }
  assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.GITHUB_REF,'refs/heads/main');assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');
  assert.equal(process.env.GITHUB_WORKFLOW_REF,'Andrewegao/v3t7kq-cycle/.github/workflows/point-route-activate.yml@refs/heads/main');
  assert.ok(existsSync(receiptPath));const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
  for(const [key,value] of Object.entries({sha,versionId,scriptEtag,controller:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT}))assert.equal(receipt[key],value);
  assert.equal(digest({before:receipt.before,sha,versionId,scriptEtag}),expectedDigest);
  const persist=()=>saveReceipt(receiptPath,receipt);
  if(command==='recover')return recover(receipt,ops,persist);
  return execute(receipt,ops,persist);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
