// Cheap, credential-free dependency check for staging UI qualification. This runs before candidate
// checkout, dependency installation, browser download, build, or Pages deployment. It never reads
// production and cannot publish anything.
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {coreReleaseProfile,cycleTime,profileFor,readSelection,selectionProfile,STAGING_ORIGIN} from './ui-staging-models.mjs';

const HOUR=3_600_000;
const TIDE_PATH='/data-atmos/tides/tides.json';
const MAX_TIDE_BYTES=2*1024*1024;
const PIPELINE_MARGIN=25*60_000;
const POINT_MODELS=['ecmwf','gfs','aifs','hrrr'];
const VARIABLES=['temperature','wind_speed','wind_direction','wind_gust','precipitation','dewpoint','visibility','solar_radiation'];

export function normalizeLongitude(value){return ((value+180)%360+360)%360-180;}
export function requireSelectionMargin(bundle,now=Date.now()){
  assert.ok(Number.isFinite(now));for(const entry of bundle?.entries??[])assert.ok(cycleTime(entry.init,now)+12*HOUR>=now+PIPELINE_MARGIN,'staging model selection will expire during qualification');return bundle;
}
export function preflightLocations(bundle){
  const locations=[{name:'china-default',lat:35,lon:104}];
  for(const entry of bundle?.entries??[]){
    const g=entry.grid;locations.push({name:entry.model,lat:(g.lat0+g.lat1)/2,lon:normalizeLongitude((g.lon0+g.lon1)/2)});
  }
  const seen=new Set();return locations.filter(({lat,lon})=>{const key=`${lat.toFixed(4)},${lon.toFixed(4)}`;if(seen.has(key))return false;seen.add(key);return true;});
}
export function pointUrl(model,{lat,lon},now=Date.now()){
  assert.ok(POINT_MODELS.includes(model));assert.ok(Number.isFinite(lat)&&lat>=-90&&lat<=90);assert.ok(Number.isFinite(lon)&&lon>=-180&&lon<180);
  const start=new Date(Math.floor(now/HOUR)*HOUR).toISOString(),end=new Date(Date.parse(start)+14*24*HOUR).toISOString();
  const query=new URLSearchParams({lat:String(lat),lon:String(lon),variables:VARIABLES.join(','),start,end});
  return new URL(`/api/v1/point-series/${model}?${query}`,STAGING_ORIGIN);
}
function hasFiniteSample(variable,start,end){return Array.isArray(variable?.samples)&&variable.samples.some(sample=>{
  const time=Date.parse(sample?.validTime);return Number.isFinite(sample?.value)&&Number.isFinite(time)&&time>=Date.parse(start)&&time<=Date.parse(end);
});}
export function validatePointPayload(payload,model,{now=Date.now(),location,start,end,margin=PIPELINE_MARGIN}={}){
  assert.equal(payload?.schemaVersion,1);assert.equal(payload.model,model);assert.match(payload.runId??'',/^\d{10}$/);
  assert.notEqual(payload.quality,'stale','staging point data is stale');assert.ok(['complete','partial'].includes(payload.quality));
  const initialized=Date.parse(payload.initializedAt),freshUntil=Date.parse(payload.freshUntil);
  assert.ok(Number.isFinite(initialized)&&initialized<=now&&now-initialized<=48*HOUR,'staging point run is not current');
  assert.ok(Number.isFinite(freshUntil)&&freshUntil>=now+margin,'staging point data will expire during qualification');
  assert.ok(location&&Math.abs(payload.requestedPoint?.latitude-location.lat)<1e-6&&Math.abs(normalizeLongitude(payload.requestedPoint?.longitude)-location.lon)<1e-6,'staging point response coordinates changed');
  assert.equal(payload.window?.start,start,'staging point response start changed');assert.equal(payload.window?.end,end,'staging point response end changed');
  for(const field of ['temperature','wind_speed','wind_direction'])assert.ok(hasFiniteSample(payload.series?.[field],start,end),`staging point ${field} is unavailable`);
  return {model,runId:payload.runId,releaseId:payload.releaseId,quality:payload.quality,initializedAt:payload.initializedAt,freshUntil:payload.freshUntil};
}
// Match the existing final guard's GET and release authority, including reading the
// complete response. The staging reader enforces the tide lease; never fall back to
// production or cache a successful result. Discard chunks to keep memory bounded.
async function probeTides(fetchImpl){
  const url=new URL(TIDE_PATH,STAGING_ORIGIN);
  const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(20_000),
    headers:{Accept:'application/json','Cache-Control':'no-cache'}});
  try{
    assert.equal(response.url,url.href,'staging tide request redirected');
    assert.equal(response.status,200,`staging tide ${TIDE_PATH} returned ${response.status}`);
    assert.match(response.headers.get('content-type')??'',/^application\/json(?:;|$)/i,'staging tide response must be JSON');
    const releaseId=response.headers.get('x-weatherx-release');
    assert.ok(releaseId,'staging tide response lacks a release header');
    const declared=response.headers.get('content-length');
    assert.ok(declared===null||(/^\d+$/.test(declared)&&Number(declared)<=MAX_TIDE_BYTES),'staging tide response exceeds size bound');
    assert.ok(response.body,'staging tide response lacks a body');
    let bytes=0;
    for await(const chunk of response.body){
      bytes+=chunk.byteLength;
      assert.ok(bytes<=MAX_TIDE_BYTES,'staging tide response exceeds size bound');
    }
    assert.ok(bytes>0,'staging tide response is empty');
    return {path:TIDE_PATH,releaseId,bytes};
  }finally{
    if(response.body&&!response.body.locked)await response.body.cancel().catch(()=>{});
  }
}

export async function runPreflight({selection='none',root,fetchImpl=fetch,now=Date.now(),batchSize=4}={}){
  assert.ok(Number.isInteger(batchSize)&&batchSize>=1&&batchSize<=8);const profile=profileFor(selection);
  const bundle=selectionProfile(profile)?requireSelectionMargin(readSelection(root,profile,now).bundle,now):null,locations=preflightLocations(bundle),work=[];
  for(const location of locations)for(const model of ['ecmwf','gfs'])work.push({location,model});
  if(coreReleaseProfile(profile))work.push({location:{name:'aifs-global',lat:35,lon:104},model:'aifs'},
    {location:{name:'hrrr-conus',lat:39.74,lon:-104.99},model:'hrrr'});
  const probes=work.map(({location,model})=>({name:`${model}@${location.name}`,run:async()=>{
    const url=pointUrl(model,location,now),start=url.searchParams.get('start'),end=url.searchParams.get('end'),response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(20_000),headers:{Accept:'application/json','Cache-Control':'no-cache'}});
    assert.equal(response.url,url.href,'staging point request redirected');assert.equal(response.status,200,`staging point ${model}/${location.name} returned ${response.status}`);
    const release=response.headers.get('x-weatherx-release');assert.ok(release,'staging point response lacks a release header');
    const validated=validatePointPayload(await response.json(),model,{now,location,start,end});assert.equal(validated.releaseId,release,'staging point header/body release changed');
    return {location:location.name,headerRelease:release,...validated};
  }}));
  probes.push({name:`tides@${TIDE_PATH}`,run:()=>probeTides(fetchImpl)});
  const results=[],failures=[];
  for(let i=0;i<probes.length;i+=batchSize){
    const batch=probes.slice(i,i+batchSize),settled=await Promise.allSettled(batch.map(probe=>probe.run()));
    settled.forEach((row,index)=>{if(row.status==='fulfilled')results.push(row.value);else failures.push(new Error(
      `${batch[index].name}: ${row.reason instanceof Error?row.reason.message:String(row.reason)}`));});
  }
  if(failures.length)throw new AggregateError(failures,`staging data preflight failed ${failures.length} independent probe(s)`);
  const tides=results.pop();
  assert.equal(new Set(results.map(result=>result.headerRelease)).size,1,'staging point probes span multiple releases');
  const locationCount=new Set(work.map(row=>`${row.location.lat},${row.location.lon}`)).size;
  // Tide snapshots have their own publication identity, independent of forecast releases.
  return {schemaVersion:1,origin:STAGING_ORIGIN,selection,locations:locationCount,probes:results.length,results,tides};
}

export function formatPreflightFailure(error){
  const line=value=>String(value instanceof Error?value.message:value).split('\n',1)[0]
    .replace(/[\x00-\x1f\x7f]/g,' ').slice(0,240);
  const details=error instanceof AggregateError?error.errors.slice(0,12).map(item=>`  - ${line(item)}`):[];
  return [line(error),...details].join('\n');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const root=resolve(process.env.UI_CYCLE_ROOT??fileURLToPath(new URL('../',import.meta.url)));
    const receipt=await runPreflight({selection:process.env.MODEL_SELECTION_SHA256??'none',root});
    console.log(JSON.stringify({phase:'staging-data-preflight',origin:receipt.origin,locations:receipt.locations,probes:receipt.probes,tides:receipt.tides,production:false}));
  }catch(error){console.error('Staging data preflight failed: '+formatPreflightFailure(error));process.exitCode=1;}
}
