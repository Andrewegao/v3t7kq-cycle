// Cheap, credential-free dependency check for staging UI qualification. This runs before candidate
// checkout, dependency installation, browser download, build, or Pages deployment. It never reads
// production and cannot publish anything.
import assert from 'node:assert/strict';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {cycleTime,profileFor,readSelection,STAGING_ORIGIN} from './ui-staging-models.mjs';

const HOUR=3_600_000;
const PIPELINE_MARGIN=25*60_000;
const MODELS=['ecmwf','gfs'];
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
  assert.ok(MODELS.includes(model));assert.ok(Number.isFinite(lat)&&lat>=-90&&lat<=90);assert.ok(Number.isFinite(lon)&&lon>=-180&&lon<180);
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
export async function runPreflight({selection='none',root,fetchImpl=fetch,now=Date.now(),batchSize=4}={}){
  assert.ok(Number.isInteger(batchSize)&&batchSize>=1&&batchSize<=8);const profile=profileFor(selection);
  const bundle=profile.stagingOnly?requireSelectionMargin(readSelection(root,profile,now).bundle,now):null,locations=preflightLocations(bundle),work=[];
  for(const location of locations)for(const model of MODELS)work.push({location,model});
  const results=[];
  for(let i=0;i<work.length;i+=batchSize){
    const rows=await Promise.all(work.slice(i,i+batchSize).map(async({location,model})=>{
      const url=pointUrl(model,location,now),start=url.searchParams.get('start'),end=url.searchParams.get('end'),response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(20_000),headers:{Accept:'application/json','Cache-Control':'no-cache'}});
      assert.equal(response.url,url.href,'staging point request redirected');assert.equal(response.status,200,`staging point ${model}/${location.name} returned ${response.status}`);
      const release=response.headers.get('x-weatherx-release');assert.ok(release,'staging point response lacks a release header');
      const validated=validatePointPayload(await response.json(),model,{now,location,start,end});assert.equal(validated.releaseId,release,'staging point header/body release changed');
      return {location:location.name,headerRelease:release,...validated};
    }));results.push(...rows);
  }
  assert.equal(new Set(results.map(result=>result.headerRelease)).size,1,'staging point probes span multiple releases');
  return {schemaVersion:1,origin:STAGING_ORIGIN,selection,locations:locations.length,probes:results.length,results};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const root=resolve(process.env.UI_CYCLE_ROOT??fileURLToPath(new URL('../',import.meta.url)));
    const receipt=await runPreflight({selection:process.env.MODEL_SELECTION_SHA256??'none',root});
    console.log(JSON.stringify({phase:'staging-data-preflight',origin:receipt.origin,locations:receipt.locations,probes:receipt.probes,production:false}));
  }catch(error){console.error('Staging data preflight failed: '+(error instanceof Error?error.message:String(error)));process.exitCode=1;}
}
