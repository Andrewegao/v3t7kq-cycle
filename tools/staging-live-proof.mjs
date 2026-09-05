// Decode actual immutable staging packs with the pinned consumer, then compare
// every public response. No generated forecast fixtures are accepted here.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import { hash, pointModelSet } from './shared-data.mjs';
import { assertPointPayload } from './consumer-refresh.mjs';
import { preflight as checkHealth } from './staging-data.mjs';
// The independent own-copy activation lane retains its qualified decoder pin.
// A shared-reader repair must not silently repin this separate publisher.
const SOURCE_SHA = 'a58eff158b56ef2ba25189d2b859315b00893a14';

const ORIGIN='https://staging.weatherx.org',BUCKET='weatherx-data-staging';
export async function readPublic(url,{fetcher=fetch,maxBytes=16*1024**2,method='GET'}={}){
  assert.equal(new URL(url).origin,ORIGIN,'staging verification target required');
  const response=await fetcher(url,{method,redirect:'error',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(20_000)});
  assert.equal(response.status,200,'staging public response failed');let bytes=0;const chunks=[];
  for await(const chunk of response.body??[]){bytes+=chunk.length;assert.ok(bytes<=maxBytes,'oversized staging response');chunks.push(chunk);}
  return {body:Buffer.concat(chunks),headers:response.headers,status:response.status};
}
export function bindBytes(body,item){assert.ok(item,'source missing from manifest');assert.equal(body.length,item.bytes);assert.equal(hash(body),item.sha256,'source bytes mismatch');return body;}
export function loadConsumer(atmos){
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:atmos,encoding:'utf8'}).trim(),SOURCE_SHA);
  execFileSync('git',['diff','--exit-code','HEAD'],{cwd:atmos,stdio:'pipe'});
  const loader=registerHooks({
    resolve(specifier,context,next){if(specifier.startsWith('.')&&context.parentURL?.endsWith('.ts')&&existsSync(fileURLToPath(new URL(specifier+'.ts',context.parentURL))))return next(specifier+'.ts',context);return next(specifier,context);},
    load(url,context,next){if(url.startsWith('file:')&&url.endsWith('.ts'))return {format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8')),shortCircuit:true};return next(url,context);},
  });
  const module=path=>import(pathToFileURL(resolve(atmos,path)));
  return {close:()=>loader.deregister(),async dependencies(io){
    const [{isReleasePointer},{isCatalogPointer,isDataCatalog},{servePointSeries},{validatePointSeriesDescriptor}]=await Promise.all([
      module('platform/edge/src/data.ts'),module('platform/edge/src/catalog.ts'),module('platform/edge/src/pointSeries.ts'),module('ops/platform/validate-point-series.mjs')]);
    return {
      validatePoints:m=>validatePointSeriesDescriptor(m.pointSeries,m.objects),
      validateServingPointers:({release,catalogPointer,catalog})=>{assert.ok(isReleasePointer(release));assert.ok(isCatalogPointer(catalogPointer));assert.ok(isDataCatalog(catalog));},
      verifyConsumer:async()=>{await checkHealth();return {origin:ORIGIN,ok:true,authMode:'public',billingMode:'disabled',dataMode:'serve'};},
      verifyLive:args=>verifyStaging(args,io,servePointSeries),
    };
  }};
}
export async function verifyStaging({selection,manifest,catalog,servingCatalog},io,servePointSeries,{fetcher=fetch,pause=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now}={}){
  assert.equal(servingCatalog?.schemaVersion,2);assert.ok(servingCatalog.catalogId);
  const objects=new Map(manifest.objects.map(o=>[o.path,o]));
  const pointerObject=await io.get(BUCKET,'releases/current.json',{maxBytes:256*1024});assert.ok(pointerObject);
  const pointer=JSON.parse(pointerObject.body);assert.equal(pointer.releaseId,selection.releaseId);assert.equal(pointer.manifestSha256,selection.releaseManifestSha256);
  assert.deepEqual(pointer.pointSeries,manifest.pointSeries);
  const cache=new Map();let usedPack;
  const env={AUTH_MODE:'public',APP_ORIGIN:`https://staging-proof-${now()}.invalid`,DATA_POINTER_KEY:'releases/current.json',DATA_BUCKET:{get:async key=>{
    if(key==='releases/current.json')return {size:pointerObject.body.length,json:async()=>pointer};
    const prefix=`releases/${selection.releaseId}/`;
    assert.ok(key.startsWith(prefix+'point-series/v2/'),'source decoder escaped selected release');
    usedPack=key.slice(prefix.length);const record=objects.get(usedPack);assert.ok(record);
    if(!cache.has(key)){const value=await io.get(BUCKET,key,{maxBytes:512*1024});assert.ok(value);cache.set(key,bindBytes(value.body,record));}
    const bytes=cache.get(key);return {size:bytes.length,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)};
  }}};
  const start=new Date(Math.ceil(now()/3_600_000)*3_600_000),end=new Date(+start+12*3_600_000),references=[];
  for(const model of pointModelSet(manifest.pointSeries?.models))for(const [name,lat,lon] of [['Chicago',41.88,-87.63],['Fairbanks',64.84,-147.72],['Honolulu',21.31,-157.86],['Montreal',45.50,-73.57],['SanJuan',18.47,-66.11],['Dateline',0,180],['Polar',89.5,15]]){
    const descriptor=manifest.pointSeries.models[model];assert.ok(Date.parse(descriptor.freshUntil)>now()+30*60_000);
    const query=new URLSearchParams({lat:String(lat),lon:String(lon),run:descriptor.runId,variables:'temperature,wind_speed,wind_direction,precipitation',start:start.toISOString(),end:end.toISOString()});
    const url=`${ORIGIN}/api/v1/point-series/${model}?${query}`;usedPack=null;
    const response=await servePointSeries(new Request(url),env,model,undefined,{cache:null});assert.equal(response.status,200,'real staging pack decode failed');
    const payload=await response.json();assert.equal(payload.releaseId,selection.releaseId);assert.equal(payload.runId,descriptor.runId);assert.equal(payload.quality,'complete');
    assert.ok(usedPack,'source was not read');
    references.push({model,name,url,coordinates:[lon,lat],payload,packPath:usedPack,packSha256:objects.get(usedPack).sha256});
  }
  const componentReferences=[];
  for(const [model,c] of Object.entries(catalog.components)){
    const object=await io.get('weatherx-components-staging',c.rootPrefix+'index.json',{maxBytes:4*1024**2});assert.ok(object);
    componentReferences.push({model,sha256:hash(object.body)});
  }
  async function probe(){
    await checkHealth(fetcher);const points=[],fallBacks=[];
    for(const path of ['ledger/index.json','verify/index.json','ledger/accuracy/current.json','ledger/accuracy/current.txt']){
      const {body,headers}=await readPublic(`${ORIGIN}/data/${path}`,{fetcher});assert.equal(headers.get('x-weatherx-release'),selection.releaseId);
      assert.equal(headers.get('x-weatherx-catalog'),null);bindBytes(body,objects.get('data/'+path));assert.ok(body.length>0);
      fallBacks.push({path,sha256:hash(body)});
    }
    for(const expected of references){
      const response=await readPublic(expected.url,{fetcher,maxBytes:1024*1024});assert.equal(response.headers.get('x-weatherx-release'),selection.releaseId);
      const actual=JSON.parse(response.body);const comparison=assertPointPayload(actual,expected.payload);
      points.push({name:expected.name,model:expected.model,coordinates:expected.coordinates,status:200,complete:actual.quality==='complete',
        runId:actual.runId,releaseId:actual.releaseId,packPath:expected.packPath,packSha256:expected.packSha256,
        responseSha256:hash(JSON.stringify(actual)),numericMatch:true,comparison,
        values:Object.fromEntries(Object.entries(actual.series).map(([k,v])=>[k,v.samples.map(s=>s.value)]))});
    }
    for(const expected of componentReferences){
      const response=await readPublic(`${ORIGIN}/data/${expected.model}/index.json`,{fetcher,maxBytes:4*1024**2});
      assert.equal(response.headers.get('x-weatherx-catalog'),servingCatalog.catalogId);assert.equal(hash(response.body),expected.sha256);
    }
    return {origin:ORIGIN,ok:true,authMode:'public',billingMode:'disabled',dataMode:'serve',selection,servingCatalog,sourceVerified:true,points,fallBacks,componentIndexes:componentReferences};
  }
  // Bounded propagation wait only; never dispatches another release or relaxes a check.
  let proof,error;
  for(let i=0;i<8;i++){try{proof=await probe();break;}catch(e){error=e;if(i<7)await pause(5000);}}
  if(!proof)throw error;
  await pause(31_000);return probe();
}
