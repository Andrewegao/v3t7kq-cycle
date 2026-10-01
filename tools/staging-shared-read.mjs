// Shared-read staging controller. Production is only ever READ here, with the bucket-scoped
// Object Read S3 credential; the only write is the staging-owned canary pin object, with
// staging-scoped credentials and a compare-and-swap. No collector, deployment, pointer or
// production mutation exists in this file.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ACCOUNT,createTransport,hash,identifier} from './shared-data.mjs';
import {ORIGIN as STAGING_ORIGIN} from './staging-data.mjs';

const REPOSITORY='Andrewegao/v3t7kq-cycle';
const SHA=/^[a-f0-9]{64}$/;
const HOUR=3_600_000;
const WIND_POLICY=JSON.parse(readFileSync(new URL('./staging-wind100-policy.json',import.meta.url),'utf8'));
assert.equal(WIND_POLICY.model,'ecmwf');assert.equal(WIND_POLICY.freshnessHours,30);
const WIND_CATALOG=/^stage-wind100-(?:recurring-)?[1-9]\d{0,19}-[1-9]\d{0,5}$/;
const WIND_SOURCE='ECMWF IFS 0.25 degree direct open-data GRIB';
const HTTP_FAILURES=new WeakMap();
export const PIN_KEY='shared-read/pin.json';
export const MAX_PIN_HOURS=48;
export const SHARED_READ_VARS={DATA_SOURCE_MODE:'shared',SHARED_READ_ACCOUNT_ID:ACCOUNT,
  SHARED_READ_DATA_BUCKET:'weatherx-data-production',SHARED_READ_COMPONENT_BUCKET:'weatherx-components-production',SHARED_READ_PIN_KEY:PIN_KEY};
export const SHARED_READ_SECRETS=['SHARED_READ_ACCESS_KEY_ID','SHARED_READ_SECRET_ACCESS_KEY'];
const WRITE_CREDENTIALS=['STAGING_R2_WRITE_ACCESS_KEY_ID','STAGING_R2_WRITE_SECRET_ACCESS_KEY'];
const FORBIDDEN_CREDENTIALS=['R2_PRODUCTION_ACCESS_KEY_ID','R2_PRODUCTION_SECRET_ACCESS_KEY','CLOUDFLARE_API_TOKEN','CLOUDFLARE_DATA_EDGE_API_TOKEN','STAGING_WORKER_API_TOKEN','UI_STAGING_PAGES_TOKEN','UI_PRODUCTION_PAGES_TOKEN','UI_CANDIDATE_KEY'];

function hostedMain(env){
  assert.equal(env.GITHUB_ACTIONS,'true','shared-read controller is cloud-only');
  assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY,REPOSITORY);
  assert.equal(env.GITHUB_REF,'refs/heads/main');
  for(const key of FORBIDDEN_CREDENTIALS)assert.ok(!env[key],`shared-read controller refuses ${key}`);
}
export function probeGate(env){
  hostedMain(env);
  assert.ok(['workflow_dispatch','schedule'].includes(env.GITHUB_EVENT_NAME));
  for(const key of WRITE_CREDENTIALS)assert.ok(!env[key],`read-only probe refuses ${key}`);
}
export function pinGate(env){
  hostedMain(env);
  assert.equal(env.GITHUB_EVENT_NAME,'workflow_dispatch','pins are manual');
  assert.equal(env.STAGING_DATA_ISOLATION_APPROVED,'true','effective bucket-scoped credentials must be audited');
  assert.equal(env.STAGING_SHARED_READ_PIN_ENABLED,'true','canary pins are not enabled');
  assert.equal(env.STAGING_R2_ACCOUNT_ID,ACCOUNT,'same-account storage only');
  for(const key of ['SHARED_R2_READ_ACCESS_KEY_ID','SHARED_R2_READ_SECRET_ACCESS_KEY'])assert.ok(!env[key],`pin writer needs no production read credential (${key})`);
}

// The staging Worker configuration that may follow production: staging buckets only, the
// shared source named by variables, the read credential by secrets, never a production binding.
export function assertSharedReadConfig(base){
  const c={...base,...base.env?.staging};delete c.env;
  assert.equal(c.name,'weatherx-platform-edge-staging');
  assert.deepEqual((c.r2_buckets??[]).map(b=>b.bucket_name).sort(),['weatherx-components-staging','weatherx-data-staging'],'staging must bind only staging buckets');
  assert.ok(!JSON.stringify(c.r2_buckets).includes('production'),'a production bucket binding is never allowed on staging');
  for(const [name,value] of Object.entries(SHARED_READ_VARS))assert.equal(c.vars?.[name],value,`staging ${name}`);
  for(const name of SHARED_READ_SECRETS)assert.ok(c.secrets?.required?.includes(name),`staging must require ${name}`);
  assert.equal(c.vars?.DATA_CATALOG_MODE,'serve');assert.equal(c.vars?.AUTH_MODE,'public');
  for(const environment of ['local','production']){
    const vars=base.env?.[environment]?.vars??{};
    assert.ok(!('DATA_SOURCE_MODE' in vars)&&!Object.keys(vars).some(k=>k.startsWith('SHARED_READ_')),`${environment} must not carry shared-read configuration`);
  }
  return c;
}

export function productionCurrent(io){
  const release=JSON.parse(io.get('data','releases/current.json')),catalog=JSON.parse(io.get('data','catalogs/current.json'));
  assert.equal(release.schemaVersion,1);assert.equal(catalog.schemaVersion,2);
  assert.match(release.manifestSha256??'',SHA);assert.match(catalog.catalogSha256??'',SHA);
  return {releaseId:identifier(release.releaseId),catalogId:identifier(catalog.catalogId),
    releasePublishedAt:release.publishedAt,catalogPublishedAt:catalog.publishedAt};
}

async function publicResponse(fetcher,path,method='GET',maximum=64*1024){
  const response=await fetcher(STAGING_ORIGIN+path,{method,redirect:'error',cache:'no-store',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(20_000)});
  let reader;
  try{
    if(response.status!==200){
      const error=Error(`${path}: expected HTTP 200`);
      HTTP_FAILURES.set(error,response.status);throw error;
    }
    const length=response.headers.get('Content-Length');
    if(method==='GET'&&length!==null)assert.ok(/^\d+$/.test(length)&&Number(length)<=maximum,`${path}: oversized response`);
    reader=response.body?.getReader();let total=0;const chunks=[];
    while(reader){const {done,value}=await reader.read();if(done)break;
      total+=value.byteLength;assert.ok(total<=maximum,`${path}: oversized response`);chunks.push(Buffer.from(value));}
    return {headers:response.headers,body:Buffer.concat(chunks)};
  }finally{
    // Retire both rejected HTTP bodies and a reader stopped by the byte bound.
    if(reader){try{await reader.cancel();}finally{reader.releaseLock();}}
    else await response.body?.cancel();
  }
}
const runIso=run=>`${run.slice(0,4)}-${run.slice(4,6)}-${run.slice(6,8)}T${run.slice(8)}:00:00.000Z`;
function windFreshness(selected,now){
  const initialized=Date.parse(runIso(selected.runId)),expires=Date.parse(selected.freshUntil);
  assert.ok(Number.isFinite(now)&&initialized<=now&&expires===initialized+WIND_POLICY.freshnessHours*HOUR&&expires>now,
    'Wind100 freshness differs or has expired');
}
async function probeWind100(fetcher,clock,onPhase){
  onPhase('wind100-selector');
  const discovery=await publicResponse(fetcher,'/api/platform/staging-wind100/current','GET',4096);
  assert.equal(discovery.headers.get('Cache-Control'),'no-store','Wind100 discovery must not be cached');
  const selected=JSON.parse(discovery.body.toString('utf8'));
  assert.ok(selected&&typeof selected==='object'&&!Array.isArray(selected),'Wind100 selector invalid');
  assert.equal(selected.schemaVersion,1);assert.equal(selected.kind,'staging-native-wind100-selector');
  assert.match(selected.catalogId??'',WIND_CATALOG);assert.match(selected.selectionSha256??'',SHA);
  assert.match(selected.runId??'',/^\d{10}$/);
  const initializedAt=runIso(selected.runId),initialized=Date.parse(initializedAt);
  assert.ok(Number.isFinite(initialized)&&new Date(initialized).toISOString()===initializedAt,'Wind100 run time invalid');
  assert.equal(Date.parse(selected.initializedAt),initialized,'Wind100 initialization differs');
  windFreshness(selected,clock());
  onPhase('wind100-point');
  const end=new Date(initialized+6*HOUR).toISOString();
  const query=new URLSearchParams({lat:'32.06',lon:'118.8',variables:'wind_speed',optionalVariables:'wind_speed_100m',
    start:initializedAt,end,run:selected.runId,catalog:selected.catalogId,selection:selected.selectionSha256});
  const response=await publicResponse(fetcher,`/api/v1/point-series/ecmwf?${query}`);
  const point=JSON.parse(response.body.toString('utf8'));
  assert.equal(response.headers.get('X-WeatherX-Data-Source'),'own','Wind100 must use the isolated staging source');
  assert.equal(response.headers.get('X-WeatherX-Catalog'),selected.catalogId,'Wind100 catalog differs');
  assert.equal(point.schemaVersion,1);assert.equal(point.model,'ecmwf');assert.equal(point.runId,selected.runId);
  assert.equal(point.releaseId,selected.catalogId);assert.equal(point.source,WIND_SOURCE);
  assert.equal(point.runSelection,undefined);assert.equal(Date.parse(point.initializedAt),initialized);
  assert.equal(Date.parse(point.freshUntil),Date.parse(selected.freshUntil));
  assert.equal(point.quality,'complete');assert.deepEqual(point.missingFields,[]);assert.deepEqual(point.optionalMissingFields,[]);
  assert.equal(point.nativeCadenceSeconds,10800);assert.equal(point.resolutionDegrees,0.25);
  assert.deepEqual(point.window,{start:initializedAt,end});assert.deepEqual(point.requestedPoint,{latitude:32.06,longitude:118.8});
  assert.deepEqual(Object.keys(point.series??{}).sort(),['wind_speed','wind_speed_100m']);
  for(const series of Object.values(point.series)){
    assert.equal(series.kind,'instantaneous');assert.equal(series.units,'m/s');assert.ok(Array.isArray(series.samples));
    assert.deepEqual(series.samples.map(row=>row?.validTime),[initializedAt,new Date(initialized+3*HOUR).toISOString()]);
    assert.ok(series.samples.every(row=>Number.isFinite(row?.value)&&row.value>=0),'Wind100 native samples invalid');
  }
  // The body read is asynchronous: the lease may expire while it is consumed.
  windFreshness(selected,clock());
  return {catalogId:selected.catalogId,runId:selected.runId,selectionSha256:selected.selectionSha256,
    initializedAt,freshUntil:new Date(Date.parse(selected.freshUntil)).toISOString(),native100m:true};
}
export async function stagingServing(fetcher=fetch,now=Date.now,{wind100Enabled=false,onPhase=()=>{}}={}){
  const clock=typeof now==='function'?now:()=>now;
  onPhase('staging-follow');
  const health=JSON.parse((await publicResponse(fetcher,'/api/platform/data-health')).body.toString('utf8'));
  const whole=await publicResponse(fetcher,'/data/ledger/index.json','HEAD');
  const component=await publicResponse(fetcher,'/data/ecmwf/index.json','HEAD');
  const start=new Date(Math.floor(clock()/HOUR)*HOUR).toISOString(),end=new Date(Date.parse(start)+6*HOUR).toISOString();
  const query=new URLSearchParams({lat:'35',lon:'104',variables:'temperature',start,end});
  const point=JSON.parse((await publicResponse(fetcher,`/api/v1/point-series/ecmwf?${query}`)).body.toString('utf8'));
  return {health,releaseId:whole.headers.get('x-weatherx-release'),catalogId:component.headers.get('x-weatherx-catalog'),
    dataSources:[whole.headers.get('x-weatherx-data-source'),component.headers.get('x-weatherx-data-source')],
    point:{releaseId:point.releaseId,runId:point.runId,quality:point.quality,freshUntil:point.freshUntil},
    ...(wind100Enabled?{wind100:await probeWind100(fetcher,clock,onPhase)}:{})};
}

export function activePin(pin,now=Date.now()){
  if(!pin||typeof pin!=='object'||pin.schemaVersion!==1||(pin.releaseId==null&&pin.catalogId==null))return null;
  const expires=Date.parse(pin.expiresAt);
  return Number.isFinite(expires)&&expires>now?pin:null;
}
export function assertFollowing(production,staging,now=Date.now()){
  const health=staging.health;
  assert.equal(health?.ok,true);assert.equal(health.authMode,'public');assert.equal(health.catalogMode,'serve');
  assert.equal(health.dataSource,'shared','staging is not in shared-read mode');
  assert.equal(health.sharedReadConfigured,true,'staging shared-read credential is missing');
  assert.deepEqual(staging.dataSources,['shared','shared'],'staging served current data from its own copy');
  const pin=activePin(health.pin,now);
  const expected={releaseId:pin?.releaseId??production.releaseId,catalogId:pin?.catalogId??production.catalogId};
  assert.equal(staging.releaseId,expected.releaseId,pin?'staging does not serve the pinned release':'staging lags production release');
  assert.equal(staging.catalogId,expected.catalogId,pin?'staging does not serve the pinned catalog':'staging lags production catalog');
  assert.equal(staging.point.releaseId,staging.releaseId,'point series and map release differ');
  assert.notEqual(staging.point.quality,'stale','staging point data is stale');
  if(staging.wind100)windFreshness(staging.wind100,now);
  return {schemaVersion:1,kind:'weatherx-staging-shared-read-probe',origin:STAGING_ORIGIN,production,staging:{releaseId:staging.releaseId,catalogId:staging.catalogId,point:staging.point,
    ...(staging.wind100?{wind100:staging.wind100}:{})},
    pin,following:!pin,checkedAt:new Date(now).toISOString(),productionWritten:false,stagingWritten:false};
}

export function pinDocument({releaseId=null,catalogId=null,hours,reason=''},now=Date.now()){
  if(releaseId!=null)identifier(releaseId);if(catalogId!=null)identifier(catalogId);
  assert.ok(releaseId!=null||catalogId!=null,'a pin names a release, a catalog or both');
  assert.ok(Number.isInteger(hours)&&hours>=1&&hours<=MAX_PIN_HOURS,`pin lifetime must be 1..${MAX_PIN_HOURS} hours`);
  assert.ok(typeof reason==='string'&&reason.length<=200&&/^[\x20-\x7e]*$/.test(reason),'pin reason must be short printable ASCII');
  return {schemaVersion:1,releaseId,catalogId,expiresAt:new Date(now+hours*HOUR).toISOString(),...(reason?{reason}:{})};
}
export function releasedPinDocument(now=Date.now()){
  return {schemaVersion:1,releaseId:null,catalogId:null,expiresAt:new Date(now).toISOString(),reason:'unpinned'};
}
// Compare-and-swap on the staging pin object only; a concurrent writer conflicts instead of
// being overwritten. The production read credential is deliberately absent from this path.
export async function writePin(io,document){
  assert.ok(document&&document.schemaVersion===1,'pin document required');
  const body=Buffer.from(JSON.stringify(document)+'\n');
  const existing=await io.get('weatherx-data-staging',PIN_KEY,{maxBytes:8192});
  const options=existing?{ifMatch:existing.etag}:{ifNoneMatch:'*'};
  const {etag}=await io.put('weatherx-data-staging',PIN_KEY,body,{...options,httpMetadata:{contentType:'application/json',cacheControl:'no-store'},customMetadata:{sha256:hash(body)}});
  const saved=await io.get('weatherx-data-staging',PIN_KEY,{maxBytes:8192});
  assert.equal(saved?.etag,etag,'pin readback ETag mismatch');assert.equal(hash(saved.body),hash(body),'pin readback bytes mismatch');
  return {key:PIN_KEY,etag,sha256:hash(body),document};
}

function save(env,name,value){
  const dir=resolve(env.RUNNER_TEMP,'staging-shared-read');mkdirSync(dir,{recursive:true,mode:0o700});
  writeFileSync(resolve(dir,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
}
export function probeFailureDiagnostic(error,phase){
  const safe=(object,key)=>{try{return object?.[key];}catch{return undefined;}};
  const code=safe(error,'code'),name=safe(error,'name');
  return {schemaVersion:1,kind:'weatherx-staging-shared-read-probe-failure',origin:STAGING_ORIGIN,ok:false,
    phase:['production-current','staging-follow','wind100-selector','wind100-point','follow-contract'].includes(phase)?phase:'unknown',
    category:HTTP_FAILURES.has(error)?'http':code==='ERR_ASSERTION'?'contract':['AbortError','TimeoutError'].includes(name)?'timeout':name==='SyntaxError'?'parse':'unexpected',
    httpStatus:HTTP_FAILURES.get(error)??null,
    productionWritten:false,stagingWritten:false};
}
export async function main(command,env=process.env,argv=[]){
  if(command==='config'){
    const config=assertSharedReadConfig(JSON.parse(readFileSync(resolve(argv[0]??''),'utf8')));
    return {worker:config.name,dataSource:config.vars.DATA_SOURCE_MODE,buckets:config.r2_buckets.map(b=>b.bucket_name),productionBindings:0};
  }
  if(command==='probe'){
    probeGate(env);
    let phase='production-current';
    try{
      const io=createTransport(env,execFileSync,event=>console.log(JSON.stringify(event)));
      const production=productionCurrent(io);
      const staging=await stagingServing(fetch,Date.now,{wind100Enabled:env.STAGING_WIND100_ENABLED==='true',onPhase:value=>{phase=value;}});
      phase='follow-contract';const receipt=assertFollowing(production,staging,Date.now());
      save(env,'probe.json',receipt);return receipt;
    }catch(error){save(env,'probe-failure.json',probeFailureDiagnostic(error,phase));throw error;}
  }
  if(command==='pin'||command==='unpin'){
    pinGate(env);
    const document=command==='pin'?pinDocument({releaseId:env.PIN_RELEASE_ID||null,catalogId:env.PIN_CATALOG_ID||null,hours:Number(env.PIN_HOURS),reason:env.PIN_REASON??''}):releasedPinDocument();
    // The read-only probe intentionally has no write SDK install. Load the adapter
    // only for an admitted pin operation; its locked dependency and guards remain.
    const {createStagingS3}=await import('./staging-s3.mjs');
    const io=createStagingS3(env);
    try{const receipt=await writePin(io,document);save(env,command+'.json',receipt);return receipt;}
    finally{io.close();}
  }
  throw Error('usage: staging-shared-read.mjs config <wrangler.jsonc> | probe | pin | unpin');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main(process.argv[2],process.env,process.argv.slice(3)).then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error(process.argv[2]==='probe'?'Shared-read probe refused; see the bounded failure receipt.':`Shared-read controller refused: ${error.message}`);process.exitCode=1;});
}
