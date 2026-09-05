// One pinned, already-qualified staging consumer repair. No data writes or UI
// deployment. Account-scoped credentials stay in a trusted hosted controller.
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizedBindings, assertSettings, activeVersion } from './consumer-refresh.mjs';
import { ACCOUNT, hash } from './shared-data.mjs';
import { validateHealth, ORIGIN } from './staging-data.mjs';
import { SHARED_READ_SECRETS, SHARED_READ_VARS } from './staging-shared-read.mjs';

export const SOURCE_SHA = '0aa9fbed9e179ab2ccb6ac456727b9f33124ddb6';
export const WORKER = 'weatherx-platform-edge-staging';
export const OWNED_REUSE=Object.freeze({run:'33988771315',attempt:'1',version:'e3d05c37-01c6-479e-baa8-450a6d3eabac',
  before:'371277cf-0113-4f9b-91c2-277a31a78d98',receiptSha:'4eb744b4691f0fc76265c30776e9ddde81397058c715c222bc8b3d5cce842b69',
  artifactId:9975982597,artifactSha:'43ec3ca54e9f0033461d1c753464865cf62b32cbfb3da4199a6bca62acead339',
  etag:'e9ce28d5818650c1170b27da97f479df2a91e7e4ba9690181e0290a528f787e8'});
const ZONE = '9dc4df7c3c094ab9a11dd00d378adc26';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Actual deployed route set re-audited after the hazard-feed repair. Preserve the
// ancillary feeds as part of the strict boundary; this refresh must not add or
// remove any route implicitly.
export const EXISTING_ROUTES=['staging.weatherx.org/api/platform/*','staging.weatherx.org/api/v1/*',
  'staging.weatherx.org/cdn/*','staging.weatherx.org/data-atmos/*','staging.weatherx.org/data/*',
  'staging.weatherx.org/api/tc/*','staging.weatherx.org/api/gdacs/*','staging.weatherx.org/api/eonet/*'];
const execute=promisify(execFile);
const sorted=v=>[...v].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function consumerGate(env) {
  assert.equal(env.GITHUB_ACTIONS,'true'); assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY,'Andrewegao/v3t7kq-cycle'); assert.equal(env.GITHUB_REF,'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME,'workflow_dispatch'); assert.equal(env.GITHUB_JOB,'refresh');
  assert.equal(env.GITHUB_WORKFLOW_REF,'Andrewegao/v3t7kq-cycle/.github/workflows/staging-consumer-refresh.yml@refs/heads/main');
  assert.equal(env.STAGING_CONSUMER_ENABLED,'true'); assert.equal(env.STAGING_CONSUMER_SOURCE_SHA,SOURCE_SHA);
  const mode=env.STAGING_CONSUMER_MODE??'upload';assert.ok(['upload','reuse-owned-33988771315'].includes(mode));
  assert.equal(env.CONFIRM,mode==='upload'?'REFRESH-STAGING-CONSUMER':'REUSE-STAGING-33988771315'); assert.equal(env.STAGING_R2_ACCOUNT_ID,ACCOUNT);
  assert.match(env.STAGING_CONSUMER_APPROVED_VERSION ?? '',UUID);
  assert.match(env.STAGING_CONSUMER_APPROVED_SETTINGS_SHA256 ?? '',/^[a-f0-9]{64}$/);
  for(const name of ['GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT'])assert.match(env[name]??'',/^[1-9][0-9]*$/);
}
export function configForStaging(base) {
  const c={...base,...base.env?.staging};delete c.env;
  assert.equal(c.name,WORKER);assert.equal(c.account_id??ACCOUNT,ACCOUNT);assert.equal(c.workers_dev,false);
  assert.equal(c.vars?.APP_ORIGIN,'https://staging.weatherx.org');
  assert.equal(c.vars?.AUTH_MODE,'public');assert.equal(c.vars?.BILLING_MODE,'disabled');assert.equal(c.vars?.DATA_CATALOG_MODE,'serve');
  assert.deepEqual(c.r2_buckets?.map(b=>b.bucket_name).sort(),['weatherx-components-staging','weatherx-data-staging']);
  assert.ok(!JSON.stringify(c.r2_buckets).includes('production'),'staging never binds a production bucket');
  // Either the historical own-copy shape or the complete shared-read shape; nothing in between.
  const mode=c.vars?.DATA_SOURCE_MODE??'own';assert.ok(['own','shared'].includes(mode),'unreviewed staging data source');
  const sharedNames=Object.keys(c.vars??{}).filter(k=>k.startsWith('SHARED_READ_'));
  if(mode==='shared'){for(const [name,value] of Object.entries(SHARED_READ_VARS))assert.equal(c.vars[name],value,`staging ${name}`);
    assert.deepEqual(sharedNames.sort(),Object.keys(SHARED_READ_VARS).filter(k=>k.startsWith('SHARED_READ_')).sort(),'unreviewed shared-read variable');
    for(const name of SHARED_READ_SECRETS)assert.ok(c.secrets?.required?.includes(name),`staging must require ${name}`);}
  else assert.equal(sharedNames.length,0,'own-copy staging must not carry shared-read variables');
  assert.equal(c.d1_databases?.[0]?.database_id,'9501827a-7e4c-4249-806b-d45d5857d9e5');
  assert.ok(c.routes?.length && c.routes.every(r=>(r.zone_id===ZONE || (r.zone_id===undefined && r.zone_name==='weatherx.org')) && r.pattern.startsWith('staging.weatherx.org/')));
  return c;
}
// The two admitted deltas: the public-mode pair, and (only when the reviewed configuration
// says so) the shared-read variables plus the two read-credential secrets. Anything else drifts.
export function desiredSettings(before,config) {
  const desired=structuredClone(before),seen=new Set();
  for(const b of desired.bindings){
    if(b.name==='AUTH_MODE'){assert.equal(b.type,'plain_text');assert.ok(['enforce','public'].includes(b.text));b.text='public';seen.add(b.name);}
    if(b.name==='BILLING_MODE'){assert.equal(b.type,'plain_text');assert.ok(['enabled','disabled'].includes(b.text));b.text='disabled';seen.add(b.name);}
  }
  assert.equal(seen.size,2,'staging mode bindings missing');
  if(config?.vars?.DATA_SOURCE_MODE==='shared'){
    for(const [name,text] of Object.entries(SHARED_READ_VARS)){
      const existing=desired.bindings.find(b=>b.name===name);
      if(existing){assert.equal(existing.type,'plain_text',`${name} must be a plain variable`);existing.text=text;}
      else desired.bindings.push({name,type:'plain_text',text});
    }
    for(const name of SHARED_READ_SECRETS){
      const existing=desired.bindings.find(b=>b.name===name);
      if(existing)assert.equal(existing.type,'secret_text',`${name} must be a secret`);
      else desired.bindings.push({name,type:'secret_text'});
    }
    desired.bindings=normalizedBindings(desired.bindings);
  }
  // Receipts are the review boundary between preflight and execution. Canonicalize
  // away optional undefined properties now so a JSON round-trip cannot turn an
  // identical Cloudflare binding into an apparent configuration change.
  return JSON.parse(JSON.stringify(desired));
}
export function settingsState(settings,routes,crons) {
  return JSON.parse(JSON.stringify({bindings:normalizedBindings(settings.bindings),compatibility_date:settings.compatibility_date,
    compatibility_flags:sorted(settings.compatibility_flags??[]),observability:settings.observability,
    placement:settings.placement,tail_consumers:settings.tail_consumers,logpush:settings.logpush,
    script_runtime:settings.script_runtime,
    routes:sorted(routes),crons:sorted(crons)}));
}
export function assertAllowedTransition(config,before,after) {
  const wanted=desiredSettings(before,config);assertSettings(config,wanted);
  assert.deepEqual(after,wanted,'staging change exceeds the approved public-mode and shared-read bindings');
}
export function sharedSecretsForUpload(config,env,before={bindings:[]}) {
  if(config?.vars?.DATA_SOURCE_MODE!=='shared')return null;
  if(sharedSecretState(before)==='existing')return null;
  const values={};
  for(const name of SHARED_READ_SECRETS){
    const value=env[name];
    assert.ok(typeof value==='string'&&value.length>=16&&value.length<=4096,`missing or invalid ${name}`);
    values[name]=value;
  }
  return values;
}
export function sharedSecretState(before) {
  const existing=SHARED_READ_SECRETS.map(name=>before.bindings.find(b=>b.name===name));
  assert.ok(existing.every(Boolean)||existing.every(v=>!v),'partial shared secret state requires separate repair');
  if(existing.every(Boolean)){
    assert.ok(existing.every(b=>b.type==='secret_text'),'shared credential must remain secret');
    return 'existing'; // Do not even read GitHub values: retain the latest owned version's secrets.
  }
  return 'bootstrap';
}
export function versionHistory(value){
  assert.ok(Array.isArray(value?.items)&&value.items.length>0&&value.items.length<=10,'missing version history');
  const ids=value.items.map(v=>{assert.match(v.id??'',UUID,'invalid version history identity');return v.id;});
  assert.equal(new Set(ids).size,ids.length,'duplicate version history');return ids;
}
export function assertUploadedHistory(before,after,uploaded){
  assert.match(uploaded,UUID);assert.ok(!before.includes(uploaded),'upload must create a new version');
  assert.deepEqual(after,[uploaded,...before].slice(0,10),'foreign version upload; secret inheritance no longer owned');
}
export async function activateOwned({before,uploaded,priorHistory,history,snapshot,getVersion,activate}){
  assertUploadedHistory(priorHistory,await history(),uploaded);
  assert.deepEqual(await snapshot(),before,'staging changed immediately before activation');
  assert.equal(await getVersion(),before.version,'foreign activation before deploy');
  return activate(uploaded);
}
export async function restoreOwned({before,uploaded,priorHistory,history,getVersion,restore}){
  assertUploadedHistory(priorHistory,await history(),uploaded);
  const live=await getVersion();
  if(live===before.version)return;
  assert.equal(live,uploaded,'foreign activation; refusing restore');
  return restore(before.version);
}
export async function confirmOwned({uploaded,priorHistory,history,getVersion}){
  assertUploadedHistory(priorHistory,await history(),uploaded);
  assert.equal(await getVersion(),uploaded,'foreign activation during qualification');
}
export function readOwnedOrigin(bytes){
  assert.ok(bytes.length<=65536);assert.equal(hash(bytes),OWNED_REUSE.receiptSha,'unreviewed origin receipt');
  const origin=JSON.parse(bytes);assert.equal(origin.schemaVersion,1);assert.equal(origin.sourceSha,SOURCE_SHA);
  assert.equal(origin.worker,WORKER);assert.equal(origin.status,'failed-restored');
  assert.equal(origin.workflowRun,OWNED_REUSE.run);assert.equal(origin.workflowAttempt,OWNED_REUSE.attempt);
  assert.equal(origin.uploaded,OWNED_REUSE.version);assert.equal(origin.before.version,OWNED_REUSE.before);
  assert.equal(origin.versionHistory[0],origin.before.version);return origin;
}
export function assertReusableVersion(config,origin,resource){
  assert.equal(resource.id,OWNED_REUSE.version,'wrong retained version');
  assert.deepEqual(JSON.parse(JSON.stringify(normalizedBindings(resource.resources?.bindings))),origin.desired.bindings,'retained bindings drift');
  assert.deepEqual(resource.resources?.script_runtime,origin.before.state.script_runtime,'retained runtime drift');
  assertRuntimePreserved(config,resource.resources.script_runtime);
  assertSettings(config,{...resource.resources.script_runtime,bindings:resource.resources.bindings});
  assert.equal(resource.annotations?.['workers/tag'],`staging-${SOURCE_SHA.slice(0,12)}`,'retained source tag mismatch');
  assert.equal(resource.annotations?.['workers/triggered_by'],'version_upload');
  assert.equal(resource.metadata?.created_on,'2026-09-05T20:00:51.429394Z','retained creation differs');
  // Opaque Cloudflare content identity, NOT a reproducible source-code SHA.
  assert.equal(resource.resources?.script?.etag,OWNED_REUSE.etag,'retained content identity differs');
}
export async function reusablePreflight({config,origin,snapshot,history,readVersion}){
  const before=await snapshot();assert.deepEqual(before,origin.before,'staging changed since owned restoration');
  const desired=desiredSettings(before.state,config);assert.deepEqual(desired,origin.desired,'reviewed desired settings changed');
  assertAllowedTransition(config,before.state,desired);assertRuntimePreserved(config,before.state.script_runtime);
  assertUploadedHistory(origin.versionHistory,await history(),OWNED_REUSE.version);
  const resource=await readVersion(OWNED_REUSE.version);assertReusableVersion(config,origin,resource);
  assert.deepEqual(await snapshot(),before,'staging changed during reuse preflight');
  assertUploadedHistory(origin.versionHistory,await history(),OWNED_REUSE.version);
  return {before,desired,versionHistory:origin.versionHistory};
}
export function assertRuntimePreserved(config,runtime) {
  assert.ok(runtime&&typeof runtime==='object','missing runtime');
  assert.ok(Object.keys(runtime).every(k=>['compatibility_date','compatibility_flags','usage_model','limits'].includes(k)),'unsupported runtime field');
  assert.equal(runtime.compatibility_date,config.compatibility_date,'runtime date differs from source');
  assert.deepEqual(sorted(runtime.compatibility_flags??[]),sorted(config.compatibility_flags??[]),'runtime flags differ from source');
  // Wrangler's default is standard; explicit nondefault values must be reviewed in source.
  if(Object.hasOwn(runtime,'usage_model'))assert.equal(runtime.usage_model,config.usage_model??'standard','runtime usage differs from source');
  assert.deepEqual(runtime.limits,config.limits,'runtime limits cannot be preserved by source upload');
}
const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;
const HOUR=3600000;
const PROBES=['health','data-health','ecmwf-index','ecmwf-manifest','ecmwf-point','gfs-index','gfs-manifest','gfs-point'];
const PHASES=new Set(['unknown','upload','upload-boundary','activate','verify','final-boundary','rollback-identity','rollback','rollback-boundary','control-read','contract-health','receipt-persist',...PROBES.flatMap(label=>[`read-${label}`,`contract-${label}`])]);
const failures=new WeakMap();
function rememberFailure(error,phase,code,httpStatus){
  if(error&&typeof error==='object'&&!failures.has(error))failures.set(error,{phase,code,...(Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?{httpStatus}:{})});
}
/** Never serialize an exception, assertion values, stderr, or a forged .diagnostic property. */
export function safeFailure(error,phase){
  return {...(error&&typeof error==='object'?failures.get(error):null)??{phase:PHASES.has(phase)?phase:'unknown',code:'operation-failed'}};
}
function safeProbe(value){
  const result={label:PROBES.includes(value.label)?value.label:'unknown'};
  if(Number.isInteger(value.httpStatus)&&value.httpStatus>=100&&value.httpStatus<=599)result.httpStatus=value.httpStatus;
  for(const [key,allowed] of Object.entries({dataSource:['own','shared'],authMode:['public','enforce','observe'],billingMode:['enabled','disabled'],catalogMode:['serve','shadow','off'],quality:['complete','partial','stale']}))if(allowed.includes(value[key]))result[key]=value[key];
  if(typeof value.sharedReadConfigured==='boolean')result.sharedReadConfigured=value.sharedReadConfigured;
  // Snapshot IDs must have known public formats, not merely arbitrary token-shaped strings.
  for(const key of ['catalogId','releaseId'])if(typeof value[key]==='string'&&/^(?:[0-9]+-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|cycle-[0-9]+)$/.test(value[key])&&value[key].length<=96)result[key]=value[key];
  if(typeof value.runId==='string'&&/^[0-9]{10}$/.test(value.runId))result.runId=value.runId;
  return result;
}
// Exact core publication policy: Atmos ops/platform/validate-model-component.py
// MAX_AGE_HOURS/MAX_FUTURE_SKEW_HOURS and data/build_point_series.py SOURCE.fresh_h.
// Regional UI admission has a separate, intentionally shorter policy.
export const CORE_FRESH_HOURS=Object.freeze({ecmwf:30,gfs:18});
async function forecastJson(path,fetcher,maxBytes=256*1024,label='unknown',observe=async()=>{}){
  let code='network',event={label};
  try{
  const response=await fetcher(ORIGIN+path,{method:'GET',redirect:'error',cache:'no-store',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(20000)});
  event={label,httpStatus:response.status,dataSource:response.headers.get('x-weatherx-data-source'),catalogId:response.headers.get('x-weatherx-catalog'),releaseId:response.headers.get('x-weatherx-release')};
  code='http-status';
  assert.equal(response.status,200,'staging forecast read failed');
  code='content-type';
  assert.match(response.headers.get('content-type')??'',/^application\/json\b/i,'staging forecast must be JSON');
  code='empty-body';
  assert.ok(response.body,'empty staging forecast');const reader=response.body.getReader(),parts=[];let size=0;
  try{while(true){code='stream';const {done,value}=await reader.read();if(done)break;size+=value.byteLength;code='oversized';assert.ok(size<=maxBytes,'oversized staging forecast');parts.push(Buffer.from(value));}}
  finally{await reader.cancel();}
  code='json';const body=JSON.parse(Buffer.concat(parts).toString('utf8'));
  if(body&&typeof body==='object')event={...event,authMode:body.authMode,billingMode:body.billingMode,catalogMode:body.catalogMode,sharedReadConfigured:body.sharedReadConfigured,quality:body.quality,
    dataSource:['own','shared'].includes(event.dataSource)?event.dataSource:body.dataSource,runId:body.runId??/^runs\/([0-9]{10})\/$/.exec(body.runs?.[0]?.path??'')?.[1]};
  return {body,headers:response.headers};
  }catch(error){rememberFailure(error,`read-${label}`,code,event.httpStatus);throw error;}
  finally{await observe(safeProbe(event));}
}
export async function verifySharedForecast(fetcher=fetch,now=Date.now(),observe=async()=>{}){
  let phase='contract-health',observationError;
  // Finish the read/contract checks so a receipt-write error cannot conceal the
  // original endpoint refusal. A lost receipt still prevents qualification.
  const record=async event=>{try{await observe(event);}catch(error){observationError??=error;rememberFailure(error,'receipt-persist','write');}};
  const read=async(label,path,maxBytes)=>{const value=await forecastJson(path,fetcher,maxBytes,label,record);phase=`contract-${label}`;return value;};
  try{
  const platform=await read('health','/api/platform/health',8192);
  const data=await read('data-health','/api/platform/data-health',8192);
  phase='contract-health';
  validateHealth(platform.body,data.body);
  assert.equal(data.body.dataSource,'shared','staging must read shared data');
  assert.equal(data.body.sharedReadConfigured,true,'shared credential not configured');
  const models=[];
  for(const model of ['ecmwf','gfs']){
    const index=await read(`${model}-index`,`/data/${model}/index.json`);
    assert.equal(index.headers.get('x-weatherx-data-source'),'shared');
    assert.equal(index.body.model,model);assert.ok(Array.isArray(index.body.runs)&&index.body.runs.length>0);
    const latest=index.body.runs[0],match=/^runs\/([0-9]{10})\/$/.exec(latest.path??'');assert.ok(match,'unsafe model run path');
    const runId=match[1],initialized=Date.parse(latest.init_time);
    assert.ok(Number.isFinite(initialized)&&initialized<=now+HOUR&&now-initialized<=CORE_FRESH_HOURS[model]*HOUR,'stale or future map run');
    assert.equal(new Date(initialized).toISOString().replace(/[-:T]/g,'').slice(0,10),runId,'map path/init mismatch');
    const catalogId=index.headers.get('x-weatherx-catalog');assert.match(catalogId??'',SAFE_ID,'missing map catalog identity');
    const manifest=await read(`${model}-manifest`,`/data/_catalog/${catalogId}/${model}/${latest.path}manifest.json`);
    assert.equal(manifest.headers.get('x-weatherx-data-source'),'shared');assert.equal(manifest.headers.get('x-weatherx-catalog'),catalogId);
    assert.equal(manifest.body.init_time,latest.init_time,'manifest run mismatch');
    const frames=manifest.body.frames;assert.ok(Array.isArray(frames)&&frames.length>1);
    const times=frames.map(f=>Date.parse(f.valid_time));assert.ok(times.every(Number.isFinite)&&times.every((t,i)=>!i||t>times[i-1]),'invalid map timeline');
    assert.ok(times[0]<=now&&times.at(-1)>=now+3*HOUR,'map does not cover current forecast');
    const start=Math.floor(now/HOUR)*HOUR,end=start+6*HOUR;
    const query=new URLSearchParams({lat:'39.9',lon:'116.4',variables:'temperature',run:runId,start:new Date(start).toISOString(),end:new Date(end).toISOString()});
    const point=await read(`${model}-point`,`/api/v1/point-series/${model}?${query}`),body=point.body;
    assert.equal(point.headers.get('x-weatherx-data-source'),'shared');
    assert.equal(body.schemaVersion,1);assert.equal(body.model,model);assert.equal(body.runId,runId);assert.equal(Date.parse(body.initializedAt),initialized);
    // Point mounts may legitimately use a catalog ID instead of the whole-release ID.
    assert.match(body.releaseId??'',SAFE_ID);assert.equal(point.headers.get('x-weatherx-release'),body.releaseId,'point response identity mismatch');
    assert.equal(body.quality,'complete');assert.deepEqual(body.missingFields,[]);assert.equal(body.runSelection,undefined,'fallback is not qualification');
    assert.ok(Number.isFinite(Date.parse(body.freshUntil))&&Date.parse(body.freshUntil)>now,'stale point forecast');
    assert.equal(Date.parse(body.freshUntil),initialized+CORE_FRESH_HOURS[model]*HOUR,'point freshness differs from source contract');
    assert.deepEqual(body.requestedPoint,{latitude:39.9,longitude:116.4});
    const samples=body.series?.temperature?.samples;assert.ok(Array.isArray(samples)&&samples.length>=2&&samples.length<=512,'missing numeric forecast');
    assert.ok(samples.every((s,i)=>typeof s.value==='number'&&Number.isFinite(s.value)&&Number.isFinite(Date.parse(s.validTime))&&Date.parse(s.validTime)>=start&&Date.parse(s.validTime)<=end&&(!i||Date.parse(s.validTime)>Date.parse(samples[i-1].validTime))),'invalid numeric forecast');
    models.push({model,runId,catalogId,pointSnapshotId:body.releaseId,samples:samples.length});
  }
  if(observationError)throw observationError;
  return {checkedAt:new Date(now).toISOString(),dataSource:'shared',models};
  }catch(error){rememberFailure(error,phase,'contract');throw error;}
}
export async function guardedRepair({before,desired,upload,snapshot,getVersion=async()=> (await snapshot()).version,activate,verify,rollback,persist}) {
  const receipt={schemaVersion:1,sourceSha:SOURCE_SHA,worker:WORKER,before,desired,status:'preflight-passed'};
  const write=async()=>{try{await persist(receipt);}catch(error){rememberFailure(error,'receipt-persist','write');throw error;}};
  // Diagnostic storage must never gate ownership checks or the actual restore.
  const recoveryWrite=async()=>{try{await write();}catch(error){receipt.persistenceFailure=safeFailure(error,'receipt-persist');}};
  await write();
  let attempted=false;
  try {
    receipt.phase='upload';await write();
    receipt.uploaded=await upload();assert.match(receipt.uploaded,UUID);await write();
    receipt.phase='upload-boundary';
    assert.deepEqual(await snapshot(),before,'inactive upload changed live boundary');
    receipt.status='activating';await write();attempted=true;
    receipt.phase='activate';await write();await activate(receipt.uploaded);
    receipt.phase='verify';await write();
    await verify(async event=>{receipt.probes??=[];if(receipt.probes.length<24)receipt.probes.push(safeProbe(event));await write();});
    receipt.phase='final-boundary';await write();
    const after=await snapshot();assert.equal(after.version,receipt.uploaded);assert.deepEqual(after.state,desired);
    receipt.status='passed';receipt.after=after;await write();return receipt;
  } catch(error) {
    receipt.failure=safeFailure(error,receipt.phase);
    receipt.status=attempted?'failed-recovery-pending':'failed-before-activation';await recoveryWrite();
    if(attempted){
      try{
      // Bad runtime/binding metadata must not prevent identifying and restoring
      // our own version. Acceptance still requires the complete strict snapshot.
      receipt.phase='rollback-identity';const liveVersion=await getVersion();
      assert.ok([before.version,receipt.uploaded].includes(liveVersion),'another publisher owns staging; refusing rollback');
      receipt.phase='rollback';if(liveVersion!==before.version)await rollback(before.version);
      receipt.phase='rollback-boundary';
      assert.deepEqual(await snapshot(),before,'staging rollback did not restore prior boundary');
      receipt.status='failed-restored';await recoveryWrite();
      }catch(recoveryError){receipt.recoveryFailure=safeFailure(recoveryError,receipt.phase);receipt.status='failed-recovery-incomplete';await recoveryWrite();throw recoveryError;}
    }
    throw error;
  }
}
async function jsonGet(url,token){
  let code='network',status;
  try{
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(30_000)});
  status=r.status;code='http-status';
  assert.equal(r.status,200,'Cloudflare read failed');let n=0;const parts=[];
  code='stream';for await(const chunk of r.body){n+=chunk.length;assert.ok(n<=2*1024**2,'oversized Cloudflare response');parts.push(chunk);}
  code='json';const value=JSON.parse(Buffer.concat(parts));code='api-result';assert.equal(value.success,true,'Cloudflare rejected read');return value.result;
  }catch(error){rememberFailure(error,'control-read',code,status);throw error;}
}
export async function consumerSnapshot(config,get){
  // /settings describes the latest upload, not necessarily the version serving
  // traffic. Versioned bindings/runtime must come from the active deployment.
  const deployment=await get(BASE+'/deployments'),version=activeVersion(deployment);
  const selected=value=>[...value.deployments].sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on))[0];
  const first=selected(deployment);assert.match(first.id??'',UUID,'missing deployment identity');
  const [settings,resource,routes,schedules]=await Promise.all([
    get(BASE+'/settings'),get(BASE+`/versions/${version}`),
    get(`https://api.cloudflare.com/client/v4/zones/${ZONE}/workers/routes`),get(BASE+'/schedules')]);
  assert.equal(resource.id,version,'active version resource mismatch');
  assert.ok(Array.isArray(resource.resources?.bindings),'active bindings missing');
  const runtime=resource.resources?.script_runtime;
  assert.ok(runtime&&typeof runtime.compatibility_date==='string','active runtime missing');
  const last=await get(BASE+'/deployments');assert.equal(activeVersion(last),version,'deployment changed during snapshot');
  assert.deepEqual(selected(last),first,'deployment changed during snapshot');
  const patterns=routes.filter(r=>r.script===WORKER).map(r=>r.pattern),crons=schedules.schedules.map(v=>v.cron);
  assert.deepEqual(sorted(patterns),sorted(EXISTING_ROUTES),'staging route mismatch');
  assert.deepEqual(sorted(crons),sorted(config.triggers?.crons??[]),'staging schedules changed');
  // Keep script-global settings, routes and schedules in the strict boundary.
  const state=settingsState({...settings,bindings:resource.resources.bindings,
    compatibility_date:runtime.compatibility_date,compatibility_flags:runtime.compatibility_flags??[],script_runtime:runtime},patterns,crons);
  assertSettings(config,desiredSettings(state,config));
  return {version,state};
}
export async function main(command,atmos,receiptPath,env=process.env){
  assert.ok(['preflight','execute','preflight-reuse','execute-reuse','recover'].includes(command));
  const reuse=['preflight-reuse','execute-reuse'].includes(command)||(command==='recover'&&env.STAGING_CONSUMER_MODE==='reuse-owned-33988771315');
  if(reuse){consumerGate(env);assert.equal(env.STAGING_CONSUMER_MODE,'reuse-owned-33988771315');}
  else if(command!=='recover')assert.equal(env.STAGING_CONSUMER_MODE??'upload','upload');
  const croot=resolve(atmos,'platform/edge');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:atmos,encoding:'utf8'}).trim(),SOURCE_SHA);
  execFileSync('git',['diff','--exit-code','HEAD'],{cwd:atmos,stdio:'pipe'});
  const config=configForStaging(JSON.parse(readFileSync(resolve(croot,'wrangler.jsonc'))));
  const token=env.STAGING_WORKER_API_TOKEN;assert.ok(token,'staging Worker credential required');
  const getVersion=async()=>activeVersion(await jsonGet(BASE+'/deployments',token));
  const history=async()=>versionHistory(await jsonGet(BASE+'/versions?page=1&per_page=10',token));
  const snapshot=()=>consumerSnapshot(config,url=>jsonGet(url,token));
  const readVersion=id=>jsonGet(BASE+`/versions/${id}`,token);
  const origin=reuse?readOwnedOrigin(readFileSync(join(dirname(receiptPath),'origin.json'))):null;
  const persist=async receipt=>{mkdirSync(dirname(receiptPath),{recursive:true,mode:0o700});writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});};
  if(command==='preflight-reuse'){
    const proof=await reusablePreflight({config,origin,snapshot,history,readVersion});
    const receipt={...proof,sourceSha:SOURCE_SHA,worker:WORKER,at:new Date().toISOString(),
      workflowRun:env.GITHUB_RUN_ID,workflowAttempt:env.GITHUB_RUN_ATTEMPT,reuseOrigin:{...OWNED_REUSE,receipt:origin}};
    await persist(receipt);console.log(JSON.stringify({worker:WORKER,version:proof.before.version,reusing:OWNED_REUSE.version,deployed:false}));return receipt;
  }
  if(command==='preflight'){
    const before=await snapshot(),desired=desiredSettings(before.state,config);
    assertRuntimePreserved(config,before.state.script_runtime);
    if(config.vars.DATA_SOURCE_MODE==='shared')sharedSecretState(before.state);
    const versions=await history();assert.equal(versions[0],before.version,'latest version is not the serving version; secret inheritance is unsafe');
    const receipt={sourceSha:SOURCE_SHA,worker:WORKER,before,desired,versionHistory:versions,settingsSha256:hash(JSON.stringify(before.state)),at:new Date().toISOString(),workflowRun:env.GITHUB_RUN_ID??null,workflowAttempt:env.GITHUB_RUN_ATTEMPT??null};
    await persist(receipt);console.log(JSON.stringify({worker:WORKER,version:before.version,settingsSha256:receipt.settingsSha256,changes:['AUTH_MODE=public','BILLING_MODE=disabled',...(config.vars.DATA_SOURCE_MODE==='shared'?['DATA_SOURCE_MODE=shared','SHARED_READ_*']:[])],deployed:false}));return receipt;
  }
  consumerGate(env);
  const stored=JSON.parse(readFileSync(receiptPath));assert.equal(stored.sourceSha,SOURCE_SHA);assert.equal(stored.worker,WORKER);
  assert.equal(stored.before.version,env.STAGING_CONSUMER_APPROVED_VERSION);
  assert.equal(hash(JSON.stringify(stored.before.state)),env.STAGING_CONSUMER_APPROVED_SETTINGS_SHA256);
  assert.equal(stored.workflowRun,env.GITHUB_RUN_ID);assert.equal(stored.workflowAttempt,env.GITHUB_RUN_ATTEMPT);
  if(reuse)assert.deepEqual(stored.reuseOrigin,{...OWNED_REUSE,receipt:origin},'reuse provenance changed');
  else assert.equal(stored.reuseOrigin,undefined,'normal upload cannot reuse receipt');
  const run=async(args,options={})=>{
    let secretDir,secretPath;
    if(options.secrets){
      secretDir=mkdtempSync(join(tmpdir(),'weatherx-staging-secrets-'));
      secretPath=join(secretDir,'secrets.json');
      writeFileSync(secretPath,JSON.stringify(options.secrets),{mode:0o600});
      args=[...args,'--secrets-file',secretPath];
    }
    try{return (await execute(process.execPath,[resolve(croot,'node_modules/wrangler/bin/wrangler.js'),...args,'--config','wrangler.jsonc','--env','staging'],{
      cwd:croot,encoding:'utf8',timeout:180_000,maxBuffer:8*1024**2,
      env:{PATH:env.PATH,HOME:env.HOME,CI:'true',NO_COLOR:'1',CLOUDFLARE_ACCOUNT_ID:ACCOUNT,CLOUDFLARE_API_TOKEN:token}})).stdout;}
    catch{throw Error('Guarded staging version operation failed');}
    finally{if(secretDir)rmSync(secretDir,{recursive:true,force:true});}
  };
  const restore=async version=>{
    assert.equal(version,stored.before.version);
    return restoreOwned({before:stored.before,uploaded:stored.uploaded,priorHistory:stored.versionHistory,history,getVersion,
      restore:id=>run(['versions','deploy',`${id}@100%`,'--yes','--message','Restore prior staging consumer'])});
  };
  if(command==='recover'){
    if(stored.status==='passed'||!stored.uploaded)return;
    assert.equal(stored.workflowRun,env.GITHUB_RUN_ID);assert.equal(stored.workflowAttempt,env.GITHUB_RUN_ATTEMPT);
    const liveVersion=await getVersion();assert.ok([stored.before.version,stored.uploaded].includes(liveVersion),'staging owned by another publisher');
    if(liveVersion!==stored.before.version)await restore(stored.before.version);
    assert.deepEqual(await snapshot(),stored.before);stored.status='failed-restored';await persist(stored);return;
  }
  const age=Date.now()-Date.parse(stored.at);assert.ok(age>=0&&age<10*60_000,'staging preflight expired');
  assert.deepEqual(await snapshot(),stored.before,'staging changed since reviewed preflight');
  if(reuse){
    assertUploadedHistory(stored.versionHistory,await history(),OWNED_REUSE.version);
    assertReusableVersion(config,origin,await readVersion(OWNED_REUSE.version));
  }else{
    assert.deepEqual(await history(),stored.versionHistory,'version history changed since reviewed preflight');
    assert.equal(stored.versionHistory[0],stored.before.version,'latest version does not own reviewed secrets');
  }
  assertRuntimePreserved(config,stored.before.state.script_runtime);
  assertAllowedTransition(config,stored.before.state,stored.desired);
  return guardedRepair({before:stored.before,desired:stored.desired,snapshot,getVersion,
    persist:r=>{stored.uploaded=r.uploaded;return persist({...r,versionHistory:stored.versionHistory,workflowRun:env.GITHUB_RUN_ID,workflowAttempt:env.GITHUB_RUN_ATTEMPT,...(reuse?{reuseOrigin:stored.reuseOrigin,candidateMode:'reused-owned-version'}:{})});},
    upload:async()=>{
      if(reuse){
        // Candidate acquisition only: no upload, no secret lookup or inheritance.
        assertReusableVersion(config,origin,await readVersion(OWNED_REUSE.version));
        assertUploadedHistory(stored.versionHistory,await history(),OWNED_REUSE.version);return OWNED_REUSE.version;
      }
      // Deliberately omit --keep-vars: apply only the reviewed public/shared delta.
      // Existing secrets are inherited (no secrets file) from the exclusively owned
      // latest version; both binding and full runtime readbacks gate activation.
      const output=await run(['versions','upload','--tag',`staging-${SOURCE_SHA.slice(0,12)}`],{secrets:sharedSecretsForUpload(config,env,stored.before.state)});
      const id=output.match(/Worker Version ID:\s*([a-f0-9-]{36})/)?.[1];assert.match(id??'',UUID);
      assertUploadedHistory(stored.versionHistory,await history(),id);
      const v=await jsonGet(BASE+`/versions/${id}`,token);assert.equal(v.id,id);
      assertSettings(config,{...v.resources.script_runtime,bindings:v.resources.bindings});
      assert.deepEqual(v.resources.script_runtime,stored.before.state.script_runtime,'inactive runtime changed');
      return id;
    },
    activate:id=>activateOwned({before:stored.before,uploaded:id,priorHistory:stored.versionHistory,history,snapshot,getVersion,
      activate:version=>run(['versions','deploy',`${version}@100%`,'--yes','--message','Qualified staging public-weather repair'])}),
    verify:async observe=>{for(let n=0;n<3;n++){await verifySharedForecast(fetch,Date.now(),observe);if(n<2)await new Promise(r=>setTimeout(r,5000));}
      await confirmOwned({uploaded:stored.uploaded,priorHistory:stored.versionHistory,history,getVersion});},rollback:restore});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv[2],resolve(process.argv[3]??''),resolve(process.argv[4]??'')).catch(()=>{console.error('Staging consumer repair refused or restored; inspect stage receipt');process.exitCode=1;});
