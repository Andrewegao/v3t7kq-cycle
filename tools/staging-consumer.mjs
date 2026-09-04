// One pinned, already-qualified staging consumer repair. No data writes or UI
// deployment. Account-scoped credentials stay in a trusted hosted controller.
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizedBindings, assertSettings, activeVersion } from './consumer-refresh.mjs';
import { ACCOUNT, hash } from './shared-data.mjs';
import { preflight as publicHealth } from './staging-data.mjs';
import { SHARED_READ_SECRETS, SHARED_READ_VARS } from './staging-shared-read.mjs';

export const SOURCE_SHA = '4e5177d925f0fc32fe57d17e478daf3c9e31dc7c';
export const WORKER = 'weatherx-platform-edge-staging';
const ZONE = '9dc4df7c3c094ab9a11dd00d378adc26';
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
// Actual deployed route set audited before this repair. Source additionally names
// three ancillary routes; this code-only refresh must not install those implicitly.
export const EXISTING_ROUTES=['staging.weatherx.org/api/platform/*','staging.weatherx.org/api/v1/*',
  'staging.weatherx.org/cdn/*','staging.weatherx.org/data-atmos/*','staging.weatherx.org/data/*'];
const execute=promisify(execFile);
const sorted=v=>[...v].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));

export function consumerGate(env) {
  assert.equal(env.GITHUB_ACTIONS,'true'); assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY,'Andrewegao/v3t7kq-cycle'); assert.equal(env.GITHUB_REF,'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME,'workflow_dispatch'); assert.equal(env.GITHUB_JOB,'refresh');
  assert.equal(env.GITHUB_WORKFLOW_REF,'Andrewegao/v3t7kq-cycle/.github/workflows/staging-consumer-refresh.yml@refs/heads/main');
  assert.equal(env.STAGING_CONSUMER_ENABLED,'true'); assert.equal(env.STAGING_CONSUMER_SOURCE_SHA,SOURCE_SHA);
  assert.equal(env.CONFIRM,'REFRESH-STAGING-CONSUMER'); assert.equal(env.STAGING_R2_ACCOUNT_ID,ACCOUNT);
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
  return desired;
}
export function settingsState(settings,routes,crons) {
  return JSON.parse(JSON.stringify({bindings:normalizedBindings(settings.bindings),compatibility_date:settings.compatibility_date,
    compatibility_flags:sorted(settings.compatibility_flags??[]),observability:settings.observability,
    placement:settings.placement,tail_consumers:settings.tail_consumers,logpush:settings.logpush,
    routes:sorted(routes),crons:sorted(crons)}));
}
export function assertAllowedTransition(config,before,after) {
  const wanted=desiredSettings(before,config);assertSettings(config,wanted);
  assert.deepEqual(after,wanted,'staging change exceeds the approved public-mode and shared-read bindings');
}
export async function guardedRepair({before,desired,upload,snapshot,getVersion=async()=> (await snapshot()).version,activate,verify,rollback,persist}) {
  const receipt={schemaVersion:1,sourceSha:SOURCE_SHA,worker:WORKER,before,desired,status:'preflight-passed'};
  await persist(receipt);
  receipt.uploaded=await upload();assert.match(receipt.uploaded,UUID);await persist(receipt);
  assert.deepEqual(await snapshot(),before,'inactive upload changed live boundary');
  let attempted=false;
  try {
    receipt.status='activating';await persist(receipt);attempted=true;
    await activate(receipt.uploaded);await verify();
    const after=await snapshot();assert.equal(after.version,receipt.uploaded);assert.deepEqual(after.state,desired);
    receipt.status='passed';receipt.after=after;await persist(receipt);return receipt;
  } catch(error) {
    if(attempted){
      // Bad runtime/binding metadata must not prevent identifying and restoring
      // our own version. Acceptance still requires the complete strict snapshot.
      const liveVersion=await getVersion();
      assert.ok([before.version,receipt.uploaded].includes(liveVersion),'another publisher owns staging; refusing rollback');
      if(liveVersion!==before.version)await rollback(before.version);
      assert.deepEqual(await snapshot(),before,'staging rollback did not restore prior boundary');
      receipt.status='failed-restored';await persist(receipt);
    }
    throw error;
  }
}
async function jsonGet(url,token){
  const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(30_000)});
  assert.equal(r.status,200,'Cloudflare read failed');let n=0;const parts=[];
  for await(const chunk of r.body){n+=chunk.length;assert.ok(n<=2*1024**2,'oversized Cloudflare response');parts.push(chunk);}
  const value=JSON.parse(Buffer.concat(parts));assert.equal(value.success,true,'Cloudflare rejected read');return value.result;
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
    compatibility_date:runtime.compatibility_date,compatibility_flags:runtime.compatibility_flags??[]},patterns,crons);
  assertSettings(config,desiredSettings(state,config));
  return {version,state};
}
export async function main(command,atmos,receiptPath,env=process.env){
  assert.ok(['preflight','execute','recover'].includes(command));
  const croot=resolve(atmos,'platform/edge');
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:atmos,encoding:'utf8'}).trim(),SOURCE_SHA);
  execFileSync('git',['diff','--exit-code','HEAD'],{cwd:atmos,stdio:'pipe'});
  const config=configForStaging(JSON.parse(readFileSync(resolve(croot,'wrangler.jsonc'))));
  const token=env.STAGING_WORKER_API_TOKEN;assert.ok(token,'staging Worker credential required');
  const getVersion=async()=>activeVersion(await jsonGet(BASE+'/deployments',token));
  const snapshot=()=>consumerSnapshot(config,url=>jsonGet(url,token));
  const persist=async receipt=>{mkdirSync(dirname(receiptPath),{recursive:true,mode:0o700});writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});};
  if(command==='preflight'){
    const before=await snapshot(),desired=desiredSettings(before.state,config);
    const receipt={sourceSha:SOURCE_SHA,worker:WORKER,before,desired,settingsSha256:hash(JSON.stringify(before.state)),at:new Date().toISOString(),workflowRun:env.GITHUB_RUN_ID??null,workflowAttempt:env.GITHUB_RUN_ATTEMPT??null};
    await persist(receipt);console.log(JSON.stringify({worker:WORKER,version:before.version,settingsSha256:receipt.settingsSha256,changes:['AUTH_MODE=public','BILLING_MODE=disabled',...(config.vars.DATA_SOURCE_MODE==='shared'?['DATA_SOURCE_MODE=shared','SHARED_READ_*']:[])],deployed:false}));return receipt;
  }
  consumerGate(env);
  const stored=JSON.parse(readFileSync(receiptPath));assert.equal(stored.sourceSha,SOURCE_SHA);assert.equal(stored.worker,WORKER);
  assert.equal(stored.before.version,env.STAGING_CONSUMER_APPROVED_VERSION);
  assert.equal(hash(JSON.stringify(stored.before.state)),env.STAGING_CONSUMER_APPROVED_SETTINGS_SHA256);
  assert.equal(stored.workflowRun,env.GITHUB_RUN_ID);assert.equal(stored.workflowAttempt,env.GITHUB_RUN_ATTEMPT);
  const run=async(args)=>{
    try{return (await execute(process.execPath,[resolve(croot,'node_modules/wrangler/bin/wrangler.js'),...args,'--config','wrangler.jsonc','--env','staging'],{
      cwd:croot,encoding:'utf8',timeout:180_000,maxBuffer:8*1024**2,
      env:{PATH:env.PATH,HOME:env.HOME,CI:'true',NO_COLOR:'1',CLOUDFLARE_ACCOUNT_ID:ACCOUNT,CLOUDFLARE_API_TOKEN:token}})).stdout;}
    catch{throw Error('Guarded staging version operation failed');}
  };
  const restore=async version=>{
    await run(['versions','deploy',`${version}@100%`,'--yes','--message','Restore prior staging consumer']);
  };
  if(command==='recover'){
    if(stored.status==='passed'||!stored.uploaded)return;
    assert.equal(stored.workflowRun,env.GITHUB_RUN_ID);assert.equal(stored.workflowAttempt,env.GITHUB_RUN_ATTEMPT);
    const liveVersion=await getVersion();assert.ok([stored.before.version,stored.uploaded].includes(liveVersion),'staging owned by another publisher');
    if(liveVersion!==stored.before.version)await restore(stored.before.version);
    assert.deepEqual(await snapshot(),stored.before);stored.status='failed-restored';await persist(stored);return;
  }
  assert.ok(Date.now()-Date.parse(stored.at)<10*60_000,'staging preflight expired');
  assert.deepEqual(await snapshot(),stored.before,'staging changed since reviewed preflight');
  assertAllowedTransition(config,stored.before.state,stored.desired);
  return guardedRepair({before:stored.before,desired:stored.desired,snapshot,getVersion,
    persist:r=>persist({...r,workflowRun:env.GITHUB_RUN_ID,workflowAttempt:env.GITHUB_RUN_ATTEMPT}),
    upload:async()=>{
      // Deliberately omit --keep-vars: the ONLY admitted variable delta is the
      // reviewed AUTH/BILLING pair; staged version bindings are checked before activation.
      const output=await run(['versions','upload','--tag',`staging-${SOURCE_SHA.slice(0,12)}`]);
      const id=output.match(/Worker Version ID:\s*([a-f0-9-]{36})/)?.[1];assert.match(id??'',UUID);
      const v=await jsonGet(BASE+`/versions/${id}`,token);assert.equal(v.id,id);
      assertSettings(config,{...v.resources.script_runtime,bindings:v.resources.bindings});
      return id;
    },
    activate:id=>run(['versions','deploy',`${id}@100%`,'--yes','--message','Qualified staging public-weather repair']),
    verify:async()=>{for(let n=0;n<3;n++){await publicHealth();if(n<2)await new Promise(r=>setTimeout(r,5000));}},rollback:restore});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv[2],resolve(process.argv[3]??''),resolve(process.argv[4]??'')).catch(()=>{console.error('Staging consumer repair refused or restored; inspect stage receipt');process.exitCode=1;});
