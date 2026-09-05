import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash,randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { verifySourceImports } from '../tools/data-reader-proof.mjs';
import { validatePair,validatePayload,validateUiPayload,UI_VARIABLES,assertRouteAbsent,ownedRoute,execute,recover,PATTERN,provePairs } from '../tools/point-route-activate.mjs';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const baseline=[{id:'a'.repeat(32),pattern:'weatherx.org/api/v1/*',script:'weatherx-platform-edge-production',request_limit_fail_open:false}];
const created={id:'b'.repeat(32),pattern:PATTERN,script:'weatherx-data-edge-production',request_limit_fail_open:false};
function fixture(){
  const receipt={status:'preflight-passed',createdAt:new Date().toISOString(),before:{routes:structuredClone(baseline),pages:{id:'same'},platform:{version:'unchanged'}},sha:'c'.repeat(40)};
  let routes=structuredClone(baseline);const writes=[],events=[],saved=[];
  const ops={routes:async()=>structuredClone(routes),boundary:async()=>({...structuredClone(receipt.before),routes:structuredClone(routes)}),assertSource:async()=>{},prove:async()=>({fresh:true}),verify:async()=>{events.push('verify');return {fresh:true};},pause:async()=>{},attach:async()=>{writes.push('attach');routes.push(structuredClone(created));return structuredClone(created);},detach:async id=>{writes.push(`detach:${id}`);routes=routes.filter(r=>r.id!==id);}};
  return {receipt,ops,writes,events,saved,persist:()=>saved.push(structuredClone(receipt)),getRoutes:()=>routes,setRoutes:value=>{routes=value;}};
}
function pair(){const now=Date.parse('2026-09-05T13:00:00Z'),generation='2026-09-05T12:00:00Z';const descriptor={runId:'2026090512',initializedAt:generation,freshUntil:'2026-09-06T00:00:00Z',storage:{format:'WXPS1'}};return {now,map:{componentId:'gfs',generationTime:generation,mounts:['data/gfs/'],quality:{status:'passed'}},point:{componentId:'point-gfs',generationTime:generation,mounts:['point-series/v2/gfs/'],quality:{status:'passed',checks:['point_series']},pointSeries:{modelId:'gfs',descriptor}},index:{model:'gfs',runs:[{init_time:generation,path:'runs/2026090512/'}]}};}
test('fresh pair requires exact descriptor, generation and latest map path',()=>{const f=pair();assert.equal(validatePair('gfs',f.map,f.point,f.index,f.now).runId,'2026090512');});
for(const [label,change] of [
  ['missing point',f=>{f.point=null;}],['stale',f=>{f.point.pointSeries.descriptor.freshUntil='2026-09-05T13:10:00Z';}],
  ['different map generation',f=>{f.map.generationTime='2026-09-05T06:00:00Z';}],['different map latest',f=>{f.index.runs[0].init_time='2026-09-05T06:00:00Z';}],
  ['different map path',f=>{f.index.runs[0].path='runs/2026090506/';}],['future',f=>{f.now=Date.parse('2026-09-05T11:00:00Z');}],
  ['wrong mount',f=>{f.point.mounts=['data/gfs/'];}],['unqualified',f=>{f.point.quality.checks=[];}],
])test(`pair refuses ${label}`,()=>{const f=pair();change(f);assert.throws(()=>validatePair('gfs',f.map,f.point,f.index,f.now));});
test('live point must be exact catalog/run and complete with finite values; fallback forbidden',()=>{
  const f=pair(),payload={model:'gfs',runId:'2026090512',releaseId:'91-catalog',quality:'complete',missingFields:[],series:{temperature:{samples:[{value:20}]},wind_speed:{samples:[{value:3}]}}};
  validatePayload(payload,'gfs',f.point.pointSeries.descriptor,'91-catalog');
  for(const patch of [{quality:'stale'},{releaseId:'90-old'},{runId:'2026090506'},{runSelection:{mode:'current_fallback'}},{series:{temperature:{samples:[{value:null}]},wind_speed:{samples:[{value:NaN}]}}}])assert.throws(()=>validatePayload({...payload,...patch},'gfs',f.point.pointSeries.descriptor,'91-catalog'));
});
test('only platform wildcard can overlap point route; preexisting, narrower and no-script routes refused',()=>{
  assertRouteAbsent(baseline);
  for(const conflict of [created,{id:'x',pattern:'weatherx.org/api/v1/point-series/gfs',script:'foreign'},{id:'x',pattern:'*weatherx.org/api/v1/*'}, {id:'x',pattern:'weatherx.org/api/*',script:'foreign'}])assert.throws(()=>assertRouteAbsent([...baseline,conflict]));
});
test('success creates one exact route, preserves platform wildcard and requires three live rounds',async()=>{
  const f=fixture();await execute(f.receipt,f.ops,f.persist);assert.equal(f.receipt.status,'passed');assert.deepEqual(f.writes,['attach']);assert.equal(f.events.length,3);assert.deepEqual(f.getRoutes()[0],baseline[0]);assert.ok(f.saved.some(x=>x.createIntent&&!x.route));
});
test('fresh proof failure before attachment causes no write',async()=>{const f=fixture();f.ops.prove=async()=>{throw Error('stale');};await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.deepEqual(f.writes,[]);});
test('failed live qualification deletes only acknowledged exact route',async()=>{const f=fixture();f.ops.verify=async()=>{throw Error('catalog mismatch');};await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.deepEqual(f.writes,['attach',`detach:${created.id}`]);assert.deepEqual(f.getRoutes(),baseline);});
test('lost POST response never infers ownership from a matching route',async()=>{const f=fixture(),attach=f.ops.attach;f.ops.attach=async()=>{await attach();throw Error('response lost');};await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.deepEqual(f.writes,['attach']);assert.equal(f.receipt.recovery,'manual-route-review-required');});
test('foreign route replacement is not deleted',async()=>{const f=fixture();f.ops.verify=async()=>{f.setRoutes([...baseline,{...created,script:'foreign'}]);throw Error('route changed');};await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.deepEqual(f.writes,['attach']);});
test('foreign UI or source drift prevents recovery from changing routing',async()=>{
  const f=fixture();f.ops.verify=async()=>{f.ops.boundary=async()=>({...f.receipt.before,routes:f.getRoutes(),pages:{id:'foreign'}});throw Error('UI changed');};await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.deepEqual(f.writes,['attach']);
});
test('lost DELETE response is reconciled only by observed route absence',async()=>{const f=fixture(),detach=f.ops.detach;f.ops.verify=async()=>{throw Error('bad point');};f.ops.detach=async id=>{await detach(id);throw Error('response lost');};await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(f.receipt.recovery,'owned-route-removed');assert.deepEqual(f.getRoutes(),baseline);});
test('receipt cannot claim a baseline route or permit changed fail-open setting',()=>{const f=fixture();f.receipt.route=baseline[0];assert.throws(()=>ownedRoute(baseline,f.receipt));f.receipt.route=created;assert.throws(()=>ownedRoute([{...created,request_limit_fail_open:true}],f.receipt));});
test('workflow is manual, source-pinned, route-only, and independently recovers',()=>{
  const workflow=read('.github/workflows/point-route-activate.yml');
  for(const text of ['workflow_dispatch:','environment: production','ACTIVATE-POINT-ROUTE-ONLY','group: weatherx-production-data-edge','merge-base --is-ancestor','persist-credentials: false','mjs preflight','mjs execute','mjs recover','always()'])assert.ok(workflow.includes(text),text);
  assert.ok(!/workflow run|wrangler (deploy|versions)|ui-release|bake\.sh|secret set|variable set/.test(workflow));
  assert.ok(!/^  (schedule|push|workflow_run):/m.test(workflow));
  assert.ok(workflow.includes('PAGES_READ_TOKEN || secrets.CLOUDFLARE_WORKERS_API_TOKEN'));
  const controller=read('tools/point-route-activate.mjs');assert.ok(!controller.includes('script: null'));assert.ok(!controller.includes('script: undefined'));
  assert.ok(read('.github/workflows/scheduler-ci.yml').includes('node --test tests/data-reader-*.mjs'),'focused tests already covered by existing shared CI wildcard');
});
test('workflow passes actionlint including context availability',{skip:process.platform!=='darwin'},()=>{execFileSync('/opt/homebrew/bin/actionlint',['-shellcheck=','-pyflakes=',new URL('../.github/workflows/point-route-activate.yml',import.meta.url).pathname],{stdio:'pipe'});});

test('actual source decodes fresh synthetic paired WXPS bytes; invalid packs and wrong live catalog fail',{skip:!process.env.WEATHERX_ATMOS_SOURCE},async()=>{
  const atmos=process.env.WEATHERX_ATMOS_SOURCE;await verifySourceImports(atmos);
  const reader=(await import(pathToFileURL(resolve(atmos,'platform/edge/src/dataEdge.ts')))).default;
  const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),now=Date.now();
  const init=new Date(Math.floor(now/(6*3_600_000))*6*3_600_000).toISOString(),generated=new Date(now).toISOString();
  const run=init.replace(/[-:]/g,'').replace('T','').slice(0,10),leadHours=Array.from({length:17},(_,i)=>i*3),stored=new Map(),components={};
  const descriptor={runId:run,initializedAt:init,generatedAt:generated,freshUntil:new Date(now+12*3_600_000).toISOString(),source:'synthetic retained fixture',license:{id:'test',redistributionAllowed:true,reviewedAt:generated},resolutionDegrees:0.25,nativeCadenceSeconds:10800,grid:{lon0:-180,lat0:90,lonStep:0.25,latStep:-0.25,width:1440,height:721,wrapLongitude:true},chunk:{width:16,height:16},variables:{temperature:{kind:'instantaneous',units:'C'},wind_speed:{kind:'instantaneous',units:'m/s'}},storage:{format:'WXPS1',missing:-32768,leadHours,fields:[{id:'temperature',scaleInv:100},{id:'wind_u',scaleInv:100},{id:'wind_v',scaleInv:100}]}};
  for(const model of ['ecmwf','gfs'])for(const point of [false,true]){
    const id=point?`point-${model}`:model,rootPrefix=`components/${id}/fixture/`;
    const manifest={schemaVersion:1,componentId:id,artifactId:'fixture',generationTime:init,completedAt:generated,rootPrefix,mounts:[point?`point-series/v2/${model}/`:`data/${model}/`],objectCount:1,inventorySha256:'a'.repeat(64),quality:{status:'passed',checks:['manifest','inventory','remote_bytes',...(point?['point_series']:[])]},...(point?{pointSeries:{schemaVersion:1,modelId:model,descriptor}}:{})};
    const bytes=Buffer.from(JSON.stringify(manifest));stored.set(rootPrefix+'component.json',bytes);components[id]={...manifest,manifestKey:rootPrefix+'component.json',manifestSha256:sha(bytes)};
    if(!point)stored.set(rootPrefix+'index.json',Buffer.from(JSON.stringify({schemaVersion:1,model,runs:[{init_time:init,path:`runs/${run}/`}]})));
  }
  const id='1-fixture',catalog=Buffer.from(JSON.stringify({schemaVersion:2,sequence:1,parentCatalogId:null,createdAt:generated,components}));
  stored.set(`catalogs/snapshots/${id}.json`,catalog);stored.set('catalogs/current.json',Buffer.from(JSON.stringify({schemaVersion:2,catalogId:id,sequence:1,publishedAt:generated,catalogSha256:sha(catalog),previousCatalogId:null})));
  let corrupt=false,wrongHeader=false;
  const object=async(_bucket,key)=>{
    if(stored.has(key))return stored.get(key);
    const match=/\/chunks\/(\d+)\/(\d+)\.bin\.gz$/.exec(key);assert.ok(match,'unexpected synthetic object');
    if(corrupt)return Buffer.from('invalid gzip');
    const bytes=Buffer.alloc(14+256*3*leadHours.length*2);bytes.write('WXPS');bytes[4]=1;bytes[5]=16;bytes[6]=16;bytes[7]=3;bytes.writeUInt16LE(leadHours.length,8);bytes.writeUInt16LE(Number(match[2]),10);bytes.writeUInt16LE(Number(match[1]),12);
    for(let field=0;field<3;field++)for(let cell=0;cell<256;cell++)for(let lead=0;lead<leadHours.length;lead++)bytes.writeInt16LE([2000,300,400][field],14+((field*256+cell)*leadHours.length+lead)*2);
    return gzipSync(bytes);
  };
  const asR2=async key=>{const bytes=await object('',key);return {size:bytes.length,etag:sha(bytes),httpEtag:sha(bytes),customMetadata:{sha256:sha(bytes)},body:new Uint8Array(bytes),json:async()=>JSON.parse(bytes),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),writeHttpMetadata(){}};};
  const env={AUTH_MODE:'public',DATA_CATALOG_MODE:'serve',APP_ORIGIN:`https://synthetic-${randomUUID()}.invalid`,DATA_CATALOG_POINTER_KEY:'catalogs/current.json',DATA_BUCKET:{get:asR2},COMPONENT_BUCKET:{get:asR2}};
  const transport={request:async url=>{const response=await reader.fetch(new Request(url),env);if(wrongHeader&&url.includes('/api/v1/point-series/'))response.headers.set('x-weatherx-release','0-old');return {status:response.status,headers:response.headers,body:Buffer.from(await response.arrayBuffer())};}};
  const proof=await provePairs(atmos,object,transport,{live:true});assert.equal(proof.rows.length,6);assert.ok(proof.rows.every(x=>x.quality==='complete'&&x.runId===run));
  assert.equal(proof.uiRows.length,6);assert.ok(proof.uiRows.every(x=>x.quality==='partial'&&x.missingFields.includes('precipitation')&&x.availableFields.includes('temperature')&&Date.parse(x.window.end)-Date.parse(x.window.start)===14*24*3_600_000));
  wrongHeader=true;await assert.rejects(provePairs(atmos,object,transport,{live:true}),/public point cache has another catalog/);wrongHeader=false;
  corrupt=true;await assert.rejects(provePairs(atmos,object,transport),/local paired point read failed/);
});

test('UI-shaped forecast keeps honest optional gaps and rejects wrong units, times, source, cadence or temperature',()=>{
  const start=Math.floor(Date.now()/3_600_000)*3_600_000,end=start+14*24*3_600_000;
  const descriptor={runId:'2026090500',initializedAt:'2026-09-05T00:00:00Z',generatedAt:'2026-09-05T01:00:00Z',freshUntil:new Date(Date.now()+12*3_600_000).toISOString(),source:'NOAA GFS direct',nativeCadenceSeconds:10800};
  const payload={schemaVersion:1,model:'gfs',...descriptor,releaseId:'91-cat',window:{start:new Date(start).toISOString(),end:new Date(end).toISOString()},quality:'partial',missingFields:UI_VARIABLES.filter(x=>x!=='temperature'),series:{temperature:{kind:'instantaneous',units:'C',samples:[{validTime:new Date(start).toISOString(),value:20}]}}};
  assert.equal(validateUiPayload(payload,'gfs',descriptor,'91-cat',start,end).quality,'partial');
  for(const change of [p=>{p.series.temperature.units='K';},p=>{p.series.temperature.samples[0].validTime='invalid';},p=>{p.source='different';},p=>{p.nativeCadenceSeconds=0;},p=>{p.series.temperature.samples[0].value=null;},p=>{p.quality='complete';},p=>{p.missingFields=[];},p=>{p.runSelection={mode:'current_fallback'};}]){const value=structuredClone(payload);change(value);assert.throws(()=>validateUiPayload(value,'gfs',descriptor,'91-cat',start,end));}
});
