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
import {createStagingS3} from './staging-s3.mjs';
import {ORIGIN as STAGING_ORIGIN} from './staging-data.mjs';

const REPOSITORY='Andrewegao/v3t7kq-cycle';
const SHA=/^[a-f0-9]{64}$/;
const HOUR=3_600_000;
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

async function publicResponse(fetcher,path,method='GET'){
  const response=await fetcher(STAGING_ORIGIN+path,{method,redirect:'error',cache:'no-store',headers:{'Cache-Control':'no-cache'},signal:AbortSignal.timeout(20_000)});
  assert.equal(response.status,200,`${path}: expected HTTP 200`);
  let total=0;const chunks=[];
  for await(const chunk of response.body??[]){total+=chunk.length;assert.ok(total<=64*1024,`${path}: oversized response`);chunks.push(Buffer.from(chunk));}
  return {headers:response.headers,body:Buffer.concat(chunks)};
}
export async function stagingServing(fetcher=fetch,now=Date.now()){
  const health=JSON.parse((await publicResponse(fetcher,'/api/platform/data-health')).body.toString('utf8'));
  const whole=await publicResponse(fetcher,'/data/ledger/index.json','HEAD');
  const component=await publicResponse(fetcher,'/data/ecmwf/index.json','HEAD');
  const start=new Date(Math.floor(now/HOUR)*HOUR).toISOString(),end=new Date(Date.parse(start)+6*HOUR).toISOString();
  const query=new URLSearchParams({lat:'35',lon:'104',variables:'temperature',start,end});
  const point=JSON.parse((await publicResponse(fetcher,`/api/v1/point-series/ecmwf?${query}`)).body.toString('utf8'));
  return {health,releaseId:whole.headers.get('x-weatherx-release'),catalogId:component.headers.get('x-weatherx-catalog'),
    dataSources:[whole.headers.get('x-weatherx-data-source'),component.headers.get('x-weatherx-data-source')],
    point:{releaseId:point.releaseId,runId:point.runId,quality:point.quality,freshUntil:point.freshUntil}};
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
  return {schemaVersion:1,kind:'weatherx-staging-shared-read-probe',origin:STAGING_ORIGIN,production,staging:{releaseId:staging.releaseId,catalogId:staging.catalogId,point:staging.point},
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
export async function main(command,env=process.env,argv=[]){
  if(command==='config'){
    const config=assertSharedReadConfig(JSON.parse(readFileSync(resolve(argv[0]??''),'utf8')));
    return {worker:config.name,dataSource:config.vars.DATA_SOURCE_MODE,buckets:config.r2_buckets.map(b=>b.bucket_name),productionBindings:0};
  }
  if(command==='probe'){
    probeGate(env);
    const io=createTransport(env,execFileSync,event=>console.log(JSON.stringify(event)));
    const receipt=assertFollowing(productionCurrent(io),await stagingServing());
    save(env,'probe.json',receipt);return receipt;
  }
  if(command==='pin'||command==='unpin'){
    pinGate(env);
    const document=command==='pin'?pinDocument({releaseId:env.PIN_RELEASE_ID||null,catalogId:env.PIN_CATALOG_ID||null,hours:Number(env.PIN_HOURS),reason:env.PIN_REASON??''}):releasedPinDocument();
    const io=createStagingS3(env);
    try{const receipt=await writePin(io,document);save(env,command+'.json',receipt);return receipt;}
    finally{io.close();}
  }
  throw Error('usage: staging-shared-read.mjs config <wrangler.jsonc> | probe | pin | unpin');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main(process.argv[2],process.env,process.argv.slice(3)).then(result=>console.log(JSON.stringify(result)))
    .catch(error=>{console.error(`Shared-read controller refused: ${error.message}`);process.exitCode=1;});
}
