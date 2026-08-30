#!/usr/bin/env node
// Code-only, exact-source consumer repair. Never writes data, bindings, routes or secrets.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks, stripTypeScriptTypes } from 'node:module';

const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const ZONE = '9dc4df7c3c094ab9a11dd00d378adc26';
const API = 'https://api.cloudflare.com/client/v4';
const ORIGIN = 'https://weatherx.org';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const execFileAsync=promisify(execFile);
let deadline=Infinity;
let cancellation=new AbortController();
export function boundedTimeout(limit,until=deadline,now=Date.now()) {
  const remaining=until-now;
  assert.ok(remaining>0,'consumer operation deadline exceeded');
  return Math.min(limit,remaining);
}
const TARGETS = [
  { id:'platform', name:'weatherx-platform-edge-production', config:'wrangler.jsonc', env:'production', token:'PLATFORM_EDGE_TOKEN' },
  { id:'data', name:'weatherx-data-edge-production', config:'wrangler.data.jsonc', env:'production-serve', token:'DATA_EDGE_TOKEN' },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sorted = items => [...items].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
export function validateInputs(sha, release) {
  assert.match(sha ?? '', /^[a-f0-9]{40}$/,'immutable source SHA required');
  assert.match(release ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/,'safe release required');
  assert.ok(!release.includes('..'),'release traversal rejected');
}
export function normalizedBindings(bindings) {
  return sorted(bindings.map(b=>{
    const allowed={secret_text:[],plain_text:['text'],r2_bucket:['bucket_name','jurisdiction'],d1:['id','database_id'],queue:['queue_name','delivery_delay'],analytics_engine:['dataset'],send_email:['allowed_sender_addresses','allowed_destination_addresses','destination_address']}[b.type];
    assert.ok(allowed,'unreviewed binding type');
    assert.ok(Object.keys(b).every(k=>['name','type',...allowed].includes(k)),'unreviewed binding field');
    const common={name:b.name,type:b.type};
    switch(b.type) {
      case 'secret_text': return common;
      case 'plain_text': return {...common,text:b.text};
      case 'r2_bucket': return {...common,bucket_name:b.bucket_name,jurisdiction:b.jurisdiction};
      case 'd1': if(b.id&&b.database_id)assert.equal(b.id,b.database_id);return {...common,id:b.id ?? b.database_id};
      case 'queue': return {...common,queue_name:b.queue_name,delivery_delay:b.delivery_delay};
      case 'analytics_engine': return {...common,dataset:b.dataset};
      case 'send_email': return {...common,allowed_sender_addresses:sorted(b.allowed_sender_addresses ?? []),allowed_destination_addresses:sorted(b.allowed_destination_addresses ?? []),destination_address:b.destination_address};
      default: throw Error('unreviewed binding type');
    }
  }));
}
function expectedBindings(config) {
  return normalizedBindings([
    ...Object.entries(config.vars ?? {}).map(([name,text])=>({name,text,type:'plain_text'})),
    ...(config.secrets?.required ?? []).map(name=>({name,type:'secret_text'})),
    ...(config.r2_buckets ?? []).map(b=>({name:b.binding,type:'r2_bucket',bucket_name:b.bucket_name,...(b.jurisdiction?{jurisdiction:b.jurisdiction}:{})})),
    ...(config.d1_databases ?? []).map(b=>({name:b.binding,type:'d1',id:b.database_id})),
    ...(config.queues?.producers ?? []).map(b=>({name:b.binding,type:'queue',queue_name:b.queue,...(b.delivery_delay!==undefined?{delivery_delay:b.delivery_delay}:{})})),
    ...(config.analytics_engine_datasets ?? []).map(b=>({name:b.binding,type:'analytics_engine',dataset:b.dataset})),
    ...(config.send_email ?? []).map(b=>({...b,type:'send_email'})),
  ]);
}
export function assertSettings(config, settings) {
  // Do not include values in assertion errors: an unexpected binding may be sensitive.
  assert.ok(JSON.stringify(expectedBindings(config))===JSON.stringify(normalizedBindings(settings.bindings)),'live bindings differ from reviewed configuration');
  assert.equal(settings.compatibility_date,config.compatibility_date,'compatibility date changed');
  assert.deepEqual(sorted(settings.compatibility_flags ?? []),sorted(config.compatibility_flags ?? []));
}
export function activeVersion(value) {
  const current=[...(value.deployments ?? [])].sort((a,b)=>Date.parse(b.created_on)-Date.parse(a.created_on))[0];
  assert.equal(current?.versions?.length,1,'mixed or missing deployment');
  assert.equal(current.versions[0].percentage,100,'partial deployment');
  assert.match(current.versions[0].version_id,UUID,'invalid active version');
  return current.versions[0].version_id;
}
export function verifiedObject(bytes, record) {
  assert.ok(record,'object absent from release manifest');
  assert.equal(bytes.length,record.bytes,'object size mismatch');
  assert.equal(hash(bytes),record.sha256,'object hash mismatch');
  return bytes;
}
export function requireFreshDescriptor(descriptor, now=Date.now()) {
  // freshUntil is the source's acquisition freshness deadline, not a forecast-valid-time cap.
  assert.ok(Date.parse(descriptor.freshUntil)>now+30*60_000,'model has insufficient rollout freshness margin');
}
export function saveReceipt(path,value) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
}
export async function transaction(targets,{deploy,verify,rollback}) {
  const attempted=[];
  try {
    for(const target of targets){attempted.push(target);await deploy(target);}
    await verify();
  } catch(error) {
    const failures=[];
    for(const target of attempted.reverse())try{await rollback(target);}catch{failures.push(target);}
    if(failures.length)throw Error(`consumer refresh failed; rollback incomplete for ${failures.join(',')}`);
    throw Error('consumer refresh failed; prior versions restored (not a healthy v2 serving claim)',{cause:error});
  }
}
async function bytes(url,token,max=16*1024*1024,method='GET') {
  const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(boundedTimeout(30_000)),cancellation.signal]),headers:token?{Authorization:`Bearer ${token}`}:{}});
  assert.equal(response.status,200,`HTTP ${response.status} while reading ${new URL(url).pathname}`);
  const chunks=[];let size=0;
  for await(const chunk of response.body ?? []){size+=chunk.length;if(size>max)throw Error('response exceeds safety limit');chunks.push(chunk);}
  return {body:Buffer.concat(chunks),headers:response.headers};
}
async function api(path,token) {
  const {body}=await bytes(API+path,token);
  const result=JSON.parse(body);assert.equal(result.success,true,'Cloudflare API rejected read');return result.result;
}
const workerPath = target => `/accounts/${ACCOUNT}/workers/scripts/${target.name}`;
async function remoteObject(key,token,max) {
  assert.ok(!key.split('/').some(p=>!p||p==='..'||p==='.'),'invalid object path');
  return (await bytes(`${API}/accounts/${ACCOUNT}/r2/buckets/weatherx-data-production/objects/${key.split('/').map(encodeURIComponent).join('/')}`,token,max)).body;
}
function source(atmos,sha) {
  assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:atmos,encoding:'utf8'}).trim(),sha,'checkout is not requested source');
  execFileSync('git',['diff','--exit-code','HEAD','--','platform/edge','ops/platform'],{cwd:atmos,stdio:'pipe'});
  return TARGETS.map(target=>{
    const base=JSON.parse(readFileSync(resolve(atmos,'platform/edge',target.config),'utf8'));
    const config={...base,...base.env[target.env]};delete config.env;
    assert.equal(config.name,target.name);
    assert.equal(config.account_id ?? ACCOUNT,ACCOUNT);
    assert.equal(config.workers_dev,false);
    assert.equal(config.vars.AUTH_MODE,target.id==='data'?'public':'observe');
    assert.equal(config.vars.DATA_CATALOG_MODE,target.id==='data'?'serve':'shadow');
    if(target.id==='platform')assert.equal(config.vars.BILLING_MODE,'disabled');
    return {...target,configValue:config};
  });
}
async function snapshot(target) {
  const token=process.env[target.token];assert.ok(token,`missing ${target.token}`);
  const settings=await api(workerPath(target)+'/settings',token);
  assertSettings(target.configValue,settings);
  // Route reads use the existing route-scoped credential; the platform upload token
  // need not gain route-write or zone permissions for this code-only repair.
  const routes=await api(`/zones/${ZONE}/workers/routes`,process.env.DATA_EDGE_TOKEN);
  const routePatterns=sorted(routes.filter(r=>r.script===target.name).map(r=>r.pattern));
  assert.deepEqual(routePatterns,sorted(target.configValue.routes.map(r=>r.pattern)),'live route boundary mismatch');
  const schedules=await api(workerPath(target)+'/schedules',token);
  const crons=sorted(schedules.schedules.map(x=>x.cron));
  assert.deepEqual(crons,sorted(target.configValue.triggers?.crons ?? []),'cron boundary mismatch');
  const state={bindings:normalizedBindings(settings.bindings),compatibility_date:settings.compatibility_date,compatibility_flags:sorted(settings.compatibility_flags ?? []),observability:settings.observability,placement:settings.placement,tail_consumers:settings.tail_consumers,logpush:settings.logpush,routes:routePatterns,crons};
  return {version:activeVersion(await api(workerPath(target)+'/deployments',token)),settingsSha256:hash(JSON.stringify(state))};
}
function typescriptLoader() {
  return registerHooks({
    resolve(specifier,context,next){
      if(specifier.startsWith('.')&&context.parentURL?.endsWith('.ts')&&existsSync(fileURLToPath(new URL(specifier+'.ts',context.parentURL))))return next(specifier+'.ts',context);
      return next(specifier,context);
    },
    load(url,context,next){
      if(url.startsWith('file:')&&url.endsWith('.ts'))return {format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8')),shortCircuit:true};
      return next(url,context);
    },
  });
}
async function releaseProof(atmos,release,previous) {
  const token=process.env.DATA_EDGE_TOKEN;
  const raw=await remoteObject('releases/current.json',token,256*1024);const pointer=JSON.parse(raw);
  assert.equal(pointer.releaseId,release,'current release changed');
  const manifest=JSON.parse(await remoteObject(`releases/${release}/manifest.json`,token));
  const {buildReleasePointer}=await import(pathToFileURL(resolve(atmos,'ops/platform/build-release-pointer.mjs')));
  assert.deepEqual(buildReleasePointer(manifest,release,pointer.publishedAt),pointer,'published pointer/manifest mismatch');
  assert.equal(pointer.pointSeries?.schemaVersion,2,'refresh requires v2 publication');
  const loader=typescriptLoader();
  try {
    const {isReleasePointer,resolveRelease}=await import(pathToFileURL(resolve(atmos,'platform/edge/src/data.ts')));
    const {servePointSeries}=await import(pathToFileURL(resolve(atmos,'platform/edge/src/pointSeries.ts')));
    assert.ok(isReleasePointer(pointer),'requested source cannot consume published pointer');
    const index=new Map(manifest.objects.map(o=>[o.path,o]));
    const expectedPacks=new Set(['point-series/v2/catalog.json']);
    for(const [model,descriptor] of Object.entries(pointer.pointSeries.models)){
      assert.equal(descriptor.storage?.format,'WXPS1');
      for(let y=0;y<Math.ceil(descriptor.grid.height/descriptor.chunk.height);y++)for(let x=0;x<Math.ceil(descriptor.grid.width/descriptor.chunk.width);x++){
        expectedPacks.add(`point-series/v2/${model}/${descriptor.runId}/chunks/${y}/${x}.bin.gz`);
      }
    }
    assert.deepEqual(sorted([...index.keys()].filter(p=>p.startsWith('point-series/'))),sorted(expectedPacks),'incomplete point-series manifest inventory');
    const catalogBytes=verifiedObject(await remoteObject(`releases/${release}/point-series/v2/catalog.json`,token),index.get('point-series/v2/catalog.json'));
    const catalog=JSON.parse(catalogBytes);assert.deepEqual(catalog.models,pointer.pointSeries.models,'point catalog descriptor mismatch');
    const cache=new Map();
    const env={AUTH_MODE:'observe',APP_ORIGIN:`https://consumer-proof-${Date.now()}.invalid`,DATA_POINTER_KEY:'releases/current.json',DATA_BUCKET:{async get(key){
      if(key==='releases/current.json')return {size:raw.length,json:async()=>pointer};
      assert.ok(key.startsWith(`releases/${release}/point-series/v2/`),'consumer requested wrong release or format');
      if(!cache.has(key))cache.set(key,verifiedObject(await remoteObject(key,token,512*1024),index.get(key.slice(`releases/${release}/`.length))));
      const b=cache.get(key);return {size:b.length,arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength)};
    }}};
    assert.equal((await resolveRelease(env))?.releaseId,release,'cold consumer resolution failed');
    const definitions=previous?.points ?? ['ecmwf','gfs'].flatMap(model=>[
      ['Chicago',41.88,-87.63],['Fairbanks',64.84,-147.72],['Honolulu',21.31,-157.86],['Montreal',45.50,-73.57],['SanJuan',18.47,-66.11],['Dateline',0,180],['Polar',89.5,15],
    ].map(([name,lat,lon])=>{
      const descriptor=pointer.pointSeries.models[model];assert.ok(descriptor);
      const start=new Date(Math.ceil(Date.now()/3_600_000)*3_600_000);const end=new Date(+start+12*3_600_000);
      requireFreshDescriptor(descriptor);
      const params=new URLSearchParams({lat:String(lat),lon:String(lon),run:descriptor.runId,variables:'temperature,wind_speed,wind_direction,precipitation',start:start.toISOString(),end:end.toISOString()});
      return {name,model,url:`${ORIGIN}/api/v1/point-series/${model}?${params}`};
    }));
    const points=[];
    for(const definition of definitions){
      const r=await servePointSeries(new Request(definition.url),env,definition.model,undefined,{cache:null});
      assert.equal(r.status,200,'real point pack decoding failed');const payload=await r.json();
      assert.equal(payload.releaseId,release);assert.equal(payload.runId,pointer.pointSeries.models[definition.model].runId);
      assert.equal(payload.quality,'complete','point pack is stale or missing requested variables');
      for(const item of Object.values(payload.series))assert.ok(item.samples.some(s=>Number.isFinite(s.value)),'no finite point samples');
      points.push({...definition,payloadSha256:hash(JSON.stringify(payload)),payload,runId:payload.runId});
    }
    const fallbacks=[];
    for(const path of ['ledger/index.json','verify/index.json','health.json']){
      const {body,headers}=await bytes(`${ORIGIN}/data/_release/${release}/${path}`);
      assert.equal(headers.get('x-weatherx-release'),release);verifiedObject(body,index.get('data/'+path));
      fallbacks.push({path,sha256:hash(body)});
    }
    return {pointerSha256:hash(raw),manifestSha256:pointer.manifestSha256,objectCount:pointer.objectCount,pointObjectCount:pointer.pointSeries.objectCount,points,fallbacks};
  } finally {loader.deregister();}
}
// Persist only our own stage identifiers and a small error category, never arbitrary
// assertion/CLI messages (which can contain binding values or response bodies).
export async function checked(stage,action,report=()=>{}) {
  assert.match(stage,/^[A-Za-z0-9:/._-]{1,180}$/,'invalid diagnostic stage');
  report({stage,state:'started'});
  try {const result=await action();report({stage,state:'passed'});return result;}
  catch(error){report({stage,state:'failed',kind:error?.code==='ERR_ASSERTION'?'assertion':error?.name==='AbortError'?'aborted':'error'});throw error;}
}
// Math.atan2 is implementation-approximated. Real identical WXPS packs at the
// pinned source differ by <=5.69e-14 degrees in Node/workerd. Keep every other
// payload field exact; admit only <=1e-12 degree rounding in derived direction.
export function assertPointPayload(actual,expected) {
  const normalized=structuredClone(actual);
  const samples=normalized?.series?.wind_direction?.samples;
  const reference=expected?.series?.wind_direction?.samples;
  let roundedDirectionValues=0,maxDirectionDifference=0;
  if(Array.isArray(samples)&&Array.isArray(reference)) {
    assert.equal(samples.length,reference.length,'direction sample count differs');
    for(let i=0;i<samples.length;i++){
      const value=samples[i]?.value,wanted=reference[i]?.value;
      if(Number.isFinite(value)&&Number.isFinite(wanted)){
        const difference=Math.abs(value-wanted);
        assert.ok(difference<=1e-12,'derived direction exceeds runtime rounding bound');
        if(difference>0){roundedDirectionValues++;maxDirectionDifference=Math.max(maxDirectionDifference,difference);}
        samples[i].value=wanted;
      }
    }
  }
  assert.deepEqual(normalized,expected,'decoded payload differs beyond runtime direction rounding');
  assert.equal(hash(JSON.stringify(normalized)),hash(JSON.stringify(expected)),'normalized payload serialization differs');
  return {roundedDirectionValues,maxDirectionDifference};
}
export async function liveVerify(receipt,{read=bytes,report=()=>{}}={}) {
  const check=(stage,action)=>checked(stage,action,report);
  for(const [path,wanted] of [['/api/platform/data-health',{ok:true,authMode:'public',catalogMode:'serve'}],['/api/platform/health',{ok:true,authMode:'observe',billingMode:'disabled'}]]){
    const stage=`health:${path.includes('data-health')?'data':'platform'}`;
    const {body}=await check(stage+':read',()=>read(ORIGIN+path));
    await check(stage+':payload',()=>assert.deepEqual(JSON.parse(body),wanted,'safety health mismatch'));
  }
  for(const sample of receipt.proof.fallbacks){
    for(const method of ['GET','HEAD']){
      const stage=`fallback:${sample.path}:${method}`;
      const {body,headers}=await check(stage+':read',()=>read(`${ORIGIN}/data/${sample.path}`,null,16*1024*1024,method));
      await check(stage+':release',()=>assert.equal(headers.get('x-weatherx-release'),receipt.release,'fallback still serves wrong release'));
      await check(stage+':catalog',()=>assert.equal(headers.get('x-weatherx-catalog'),null));
      if(method==='GET')await check(stage+':payload',()=>assert.equal(hash(body),sample.sha256,'fallback bytes mismatch'));
    }
  }
  for(const sample of receipt.proof.points){
    const stage=`point:${sample.model}:${sample.name}`;
    const {body,headers}=await check(stage+':read',()=>read(sample.url));
    await check(stage+':release',()=>assert.equal(headers.get('x-weatherx-release'),receipt.release));
    await check(stage+':payload',()=>{
      assert.equal(hash(JSON.stringify(sample.payload)),sample.payloadSha256,'reference payload hash mismatch');
      const actual=JSON.parse(body);
      const comparison=assertPointPayload(actual,sample.payload);
      receipt.pointComparisons??={};
      receipt.pointComparisons[`${sample.model}:${sample.name}`]={expectedSha256:sample.payloadSha256,actualSha256:hash(JSON.stringify(actual)),...comparison};
    });
  }
  for(const model of ['ecmwf','gfs','hrrr','aifs']){
    const {headers}=await check(`catalog:${model}:read`,()=>read(`${ORIGIN}/data/${model}/index.json`));
    await check(`catalog:${model}:header`,()=>assert.ok(headers.get('x-weatherx-catalog'),'catalog authority lost'));
  }
}
const pause = async ms => {await new Promise(r=>setTimeout(r,boundedTimeout(ms)));};
async function converge(check) {
  let failure;
  for(let i=0;i<12;i++){try{return await check();}catch(e){failure=e;if(i<11)await pause(5000);}}
  throw failure;
}
export async function main(args=process.argv.slice(2)) {
  const [command,...rest]=args;assert.ok(['preflight','execute','recover'].includes(command),'invalid command');
  deadline=Date.now()+(command==='execute'?8:4)*60_000;
  cancellation=new AbortController();
  assert.equal(rest.length,8,'four named arguments required');const options=Object.fromEntries(Array.from({length:4},(_,i)=>[rest[i*2],rest[i*2+1]]));
  assert.deepEqual(Object.keys(options).sort(),['--atmos','--receipt','--release','--sha']);
  const atmos=resolve(options['--atmos']), receiptPath=resolve(options['--receipt']), sha=options['--sha'], release=options['--release'];validateInputs(sha,release);
  const targets=source(atmos,sha);
  if(command==='preflight'){
    const before={};for(const t of targets)before[t.id]=await snapshot(t);
    const proof=await releaseProof(atmos,release);
    const receipt={schemaVersion:1,sha,release,createdAt:new Date().toISOString(),workflowRun:process.env.GITHUB_RUN_ID ?? null,workflowAttempt:process.env.GITHUB_RUN_ATTEMPT ?? null,before,proof,status:'preflight-passed'};
    saveReceipt(receiptPath,receipt);console.log('consumer preflight passed: exact pointer, manifest, 14 real-pack points and unchanged settings');return receipt;
  }
  assert.equal(process.env.GITHUB_ACTIONS,'true','production mutation requires guarded GitHub Actions');
  assert.equal(process.env.GITHUB_REPOSITORY,'Andrewegao/v3t7kq-cycle');assert.equal(process.env.GITHUB_REF,'refs/heads/main');
  assert.equal(process.env.GITHUB_WORKFLOW_REF,'Andrewegao/v3t7kq-cycle/.github/workflows/consumer-refresh.yml@refs/heads/main');
  const receipt=JSON.parse(readFileSync(receiptPath));assert.equal(receipt.sha,sha);assert.equal(receipt.release,release);
  assert.equal(receipt.workflowRun,process.env.GITHUB_RUN_ID);assert.equal(receipt.workflowAttempt,process.env.GITHUB_RUN_ATTEMPT);
  if(command==='execute'){assert.equal(receipt.status,'preflight-passed');assert.ok(Date.now()-Date.parse(receipt.createdAt)<15*60_000,'preflight expired');}
  const persist=()=>saveReceipt(receiptPath,receipt);
  const report=event=>{
    receipt.lastCheck={...event,at:new Date().toISOString()};
    if(event.state==='failed')receipt.failedChecks=[...(receipt.failedChecks??[]),receipt.lastCheck].slice(-16);
    persist();
  };
  const check=(stage,action)=>checked(stage,action,report);
  const wrangler=resolve(atmos,'platform/edge/node_modules/wrangler/bin/wrangler.js');
  async function run(t,args){
    // Capture output; print neither credentials nor arbitrary remote response bodies.
    try{return (await execFileAsync(process.execPath,[wrangler,...args,'--config',t.config,'--env',t.env],{cwd:dirname(resolve(atmos,'platform/edge',t.config)),encoding:'utf8',timeout:boundedTimeout(180_000),signal:cancellation.signal,maxBuffer:8*1024*1024,env:{...process.env,CLOUDFLARE_API_TOKEN:process.env[t.token],NO_COLOR:'1'}})).stdout;}
    catch{throw Error(`Wrangler ${args.slice(0,2).join(' ')} failed for ${t.id}`);}
  }
  async function rollback(id) {
    const t=targets.find(t=>t.id===id);const current=activeVersion(await api(workerPath(t)+'/deployments',process.env[t.token]));
    assert.ok([receipt.before[id].version,receipt.uploaded?.[id]].includes(current),'refuse to roll back another publisher');
    if(current!==receipt.before[id].version)await run(t,['rollback',receipt.before[id].version,'--yes','--message','Consumer refresh verification failed']);
    await converge(async()=>assert.deepEqual(await snapshot(t),receipt.before[id]));
  }
  if(command==='recover') {
    if(receipt.status==='passed'||!receipt.uploaded)return;
    const failed=[];for(const t of [...targets].reverse())try{await rollback(t.id);}catch{failed.push(t.id);}
    receipt.recovery=failed.length?'incomplete':'prior-versions-restored';persist();
    assert.equal(failed.length,0,'independent recovery incomplete; inspect receipt');
    console.log('prior consumer versions restored; v2 serving remains unqualified');return;
  }
  for(const t of targets)assert.deepEqual(await snapshot(t),receipt.before[t.id],'live state changed after preflight');
  assert.equal(hash(await remoteObject('releases/current.json',process.env.DATA_EDGE_TOKEN,256*1024)),receipt.proof.pointerSha256,'pointer changed after preflight');
  receipt.uploaded={};
  // Upload both inactive versions before changing either serving deployment. Versions operations
  // deliberately do not run `deploy` or `triggers deploy`: routes, crons and queue consumers stay put.
  for(const t of targets){
    const output=await run(t,['versions','upload','--keep-vars','--tag',`consumer-${sha.slice(0,12)}`,'--message',`Verified v2 reader ${sha}`]);
    const id=output.match(/Worker Version ID:\s*([a-f0-9-]{36})/)?.[1];assert.match(id??'',UUID,'missing uploaded version receipt');
    receipt.uploaded[t.id]=id;persist();
    const version=await api(workerPath(t)+`/versions/${id}`,process.env[t.token]);
    assert.equal(version.id,id);assertSettings(t.configValue,{...version.resources.script_runtime,bindings:version.resources.bindings});
  }
  for(const t of targets)assert.deepEqual(await snapshot(t),receipt.before[t.id],'upload changed active state');
  assert.equal(hash(await remoteObject('releases/current.json',process.env.DATA_EDGE_TOKEN,256*1024)),receipt.proof.pointerSha256,'pointer changed while staging versions');
  const cancel=()=>cancellation.abort();process.once('SIGTERM',cancel);process.once('SIGINT',cancel);
  let rollbackStarted=false;
  try {
    await transaction(targets.map(t=>t.id),{
      deploy:async id=>{
        const t=targets.find(t=>t.id===id);assert.deepEqual(await snapshot(t),receipt.before[id],'concurrent deployment detected');
        receipt.status='activating';persist();
        await check(`activation:${id}`,()=>run(t,['versions','deploy',`${receipt.uploaded[id]}@100%`,'--yes','--message',`Qualified v2 consumer ${sha}`]));
        await check(`activation:${id}:converged`,()=>converge(async()=>assert.equal((await snapshot(t)).version,receipt.uploaded[id])));
      },
      verify:async()=>{
        await converge(()=>liveVerify(receipt,{report}));await pause(31_000);await liveVerify(receipt,{report});
        receipt.after={};for(const t of targets){await check(`postcheck:${t.id}:settings`,async()=>{const state=await snapshot(t);assert.equal(state.version,receipt.uploaded[t.id]);assert.equal(state.settingsSha256,receipt.before[t.id].settingsSha256,'settings drift');receipt.after[t.id]=state;});}
        await check('postcheck:pointer',async()=>assert.equal(hash(await remoteObject('releases/current.json',process.env.DATA_EDGE_TOKEN,256*1024)),receipt.proof.pointerSha256,'pointer changed during rollout'));
      },
      rollback:async id=>{
        if(!rollbackStarted){rollbackStarted=true;deadline=Date.now()+4*60_000;cancellation=new AbortController();}
        await rollback(id);
      },
    });
    receipt.status='passed';receipt.completedAt=new Date().toISOString();persist();console.log(`verified ${release} on both exact-source v2 consumers; safety settings unchanged`);
  }catch(error){receipt.status='failed';receipt.error=error.message;persist();throw error;}
  finally{process.removeListener('SIGTERM',cancel);process.removeListener('SIGINT',cancel);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
