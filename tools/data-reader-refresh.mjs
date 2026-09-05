#!/usr/bin/env node
// Phase 1 only: upgrade the existing data Worker. Never changes routes, settings,
// data pointers, Pages, platform Worker, schedules, secrets or publication policy.
// Recovery uses our schema-compatible read-only version, NEVER the old reader.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { normalizedSettings, canonical, saveReceipt, createTransport, ACCOUNT, ZONE } from './gdacs-feed-release.mjs';
import { activeVersion, normalizedBindings, assertSettings } from './consumer-refresh.mjs';
import { proveReaders, verifySourceImports } from './data-reader-proof.mjs';

export const WORKER='weatherx-data-edge-production';
export const SCRIPT=`/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
export const PAGES_READ_URL=`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects/atmos-platform`;
const ORIGIN='https://weatherx.org';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{40}$/;
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=value=>hash(canonical(value));
const same=(a,b,message)=>assert.ok(canonical(a)===canonical(b),message);
const sorted=values=>[...values].sort((a,b)=>canonical(a).localeCompare(canonical(b)));
export const CLOSURE=['access','catalog','catalogApi','crypto','data','dataEdge','db','http','pointSeries','pointSeriesContract','releasePromotion','sharedRead','telemetry','types'].map(x=>`src/${x}.ts`).sort();

// Permission discovery only: this selected existing credential can issue one
// fixed Pages GET, never a Pages mutation or redirect. Do not log API bodies.
export async function checkPagesReadAuthority({token=process.env.PAGES_TOKEN,fetchImpl=globalThis.fetch,log=console.log}={}){
  let status='unavailable';
  try{
    assert.ok(token,'missing credential');
    const response=await fetchImpl(PAGES_READ_URL,{method:'GET',redirect:'error',signal:AbortSignal.timeout(15_000),headers:{Authorization:`Bearer ${token}`}});
    status=String(response.status);
    if(response.status!==200){await response.body?.cancel();throw Error('permission refused');}
    const chunks=[];let size=0;
    for await(const chunk of response.body??[]){size+=chunk.length;assert.ok(size<=1024*1024,'oversized permission response');chunks.push(chunk);}
    const body=JSON.parse(Buffer.concat(chunks));
    assert.ok(body.success===true&&body.result?.name==='atmos-platform','wrong permission response');
    log('Pages GET authority confirmed (HTTP 200)');
  }catch{
    log(`Pages GET authority refused (HTTP ${status})`);
    throw Error('Existing credential cannot verify the protected Pages boundary; no changes made');
  }
}

export function sourceInventory(atmos,sha){
  assert.match(sha,SHA,'exact source required');
  const git=args=>execFileSync('git',args,{cwd:atmos,encoding:'utf8',timeout:30_000});
  assert.equal(git(['rev-parse','HEAD']).trim(),sha,'source HEAD mismatch');
  assert.equal(git(['status','--porcelain=v1','--untracked-files=all','--','platform/edge','ops/platform']).trim(),'','source must be clean and committed');
  const files=git(['ls-tree','-r','HEAD','--','platform/edge','ops/platform']).trim().split('\n');
  assert.ok(files.every(x=>/^100(?:644|755) blob [a-f0-9]{40}\t/.test(x)),'source symlink or submodule');
  return digest(files);
}
export function assertClosure(inputs,kind){
  same(Object.keys(inputs).sort(),[...CLOSURE,...(kind==='readonly'?['src/dataEdgeReadOnly.ts']:[])].sort(),'unexpected Worker bundle closure');
}
export async function build(atmos,sha){
  const inventory=sourceInventory(atmos,sha);
  const config=JSON.parse(readFileSync(resolve(atmos,'platform/edge/wrangler.data.jsonc'),'utf8'));
  assert.equal(config.account_id,ACCOUNT);assert.equal(config.main,'src/dataEdge.ts');
  const settings={...config,...config.env['production-serve']};
  assert.equal(settings.name,WORKER);assert.equal(settings.vars.AUTH_MODE,'public');assert.equal(settings.vars.DATA_CATALOG_MODE,'serve');
  assert.equal(settings.workers_dev,false);assert.equal(config.preview_urls,false);
  const esbuild=await import(pathToFileURL(resolve(atmos,'platform/edge/node_modules/esbuild/lib/main.js')));
  const lock=JSON.parse(readFileSync(resolve(atmos,'platform/edge/package-lock.json'),'utf8'));
  assert.equal(esbuild.version,lock.packages['node_modules/esbuild'].version);
  const bundles={};
  for(const kind of ['readonly','full']){
    const entry=kind==='readonly'?'dataEdgeReadOnly':'dataEdge';
    const out=await esbuild.build({absWorkingDir:resolve(atmos,'platform/edge'),entryPoints:[`src/${entry}.ts`],bundle:true,format:'esm',platform:'browser',target:'es2022',write:false,metafile:true,tsconfigRaw:{}});
    assert.equal(out.outputFiles.length,1);assertClosure(out.metafile.inputs,kind);
    const bytes=Buffer.from(out.outputFiles[0].contents);assert.ok(bytes.length>0&&bytes.length<512*1024);
    bundles[kind]={bytes,sha256:hash(bytes),inputs:Object.keys(out.metafile.inputs).sort()};
  }
  assert.equal(sourceInventory(atmos,sha),inventory);
  await verifySourceImports(atmos);
  return {bundles,settings,inventory,esbuildVersion:esbuild.version};
}
function userAnnotations(value={}){const {'workers/triggered_by':serverOwned,...user}=value;return user;}
export function versionAnnotations(kind,receipt){return {...userAnnotations(receipt.boundary.data.settings.annotations),'workers/tag':`${receipt.tag}-${kind}`,'workers/commit_sha':receipt.sha,'workers/message':`WeatherX data reader ${kind} ${receipt.sha}`};}
export function assertBoundary(current,receipt){
  const observed=structuredClone(current);
  const tag=observed.data.settings.annotations?.['workers/tag'];
  for(const kind of ['readonly','full'])if(receipt.versions?.[kind]&&tag===`${receipt.tag}-${kind}`){
    // /settings includes version-derived annotations (including after inactive
    // upload). Normalize ONLY our exact durable-owned version annotation delta.
    same(userAnnotations(observed.data.settings.annotations),versionAnnotations(kind,receipt),'owned annotation drift');
    if(Object.hasOwn(receipt.boundary.data.settings,'annotations'))observed.data.settings.annotations=receipt.boundary.data.settings.annotations;
    else delete observed.data.settings.annotations;
  }
  same(observed,receipt.boundary,'protected production boundary changed');
}
export function assertVersion(version,kind,receipt){
  assert.match(version.id??'',UUID,'version id missing');
  if(receipt.versions?.[kind])assert.equal(version.id,receipt.versions[kind],'recorded version identity changed');
  assert.equal(version.annotations?.['workers/tag'],`${receipt.tag}-${kind}`,'version ownership changed');
  assert.equal(version.annotations?.['workers/commit_sha'],receipt.sha,'version source changed');
  same(normalizedBindings(version.resources?.bindings??[]),receipt.boundary.data.settings.bindings,'uploaded bindings changed');
  assert.equal(version.resources?.script_runtime?.compatibility_date,receipt.boundary.data.settings.compatibility_date,'uploaded compatibility changed');
  same(sorted(version.resources?.script_runtime?.compatibility_flags??[]),receipt.boundary.data.settings.compatibility_flags,'uploaded flags changed');
  same(version.resources?.script_runtime,receipt.boundary.data.runtime,'uploaded version runtime changed');
  if(receipt.versionEtags?.[kind])assert.equal(version.resources?.script?.etag,receipt.versionEtags[kind],'immutable version bytes identity changed');
}

// No restore of a pre-upgrade version is ever allowed, even if pointer hashes
// still match: a concurrent publisher could change the catalog after that read.
export async function recover(receipt,ops,persist){
  if(receipt.status==='passed')return;
  receipt.recovery='started';persist();
  if(!receipt.intent?.activate){receipt.recovery='no-active-mutation';persist();return;}
  try{
    const current=await ops.active();
    const fallback=receipt.versions?.readonly;
    assert.ok(fallback,'owned compatible fallback missing');
    assertVersion(await ops.version(fallback),'readonly',receipt);
    assertBoundary(await ops.boundary(),receipt);
    if(current===receipt.beforeVersion){
      // Response loss before first activation: observation only, never deploy old.
      receipt.recovery='old-version-still-active';persist();return;
    }
    assert.ok(current===fallback||current===receipt.versions.full,'foreign deployment active');
    if(current!==fallback){
      assert.equal(await ops.active(),current,'deployment changed before containment');
      receipt.intent.contain=true;persist();
      try{await ops.deploy(fallback);}catch{receipt.containmentResponseLost=true;persist();}
      assert.equal(await ops.active(),fallback,'compatible fallback activation not observed');
    }
    await ops.verify('readonly',receipt);
    assertBoundary(await ops.boundary(),receipt);
    receipt.recovery='compatible-readonly-active';receipt.publicationPaused=true;
    receipt.recoveryPointers=await ops.pointers();persist();
  }catch{
    receipt.recovery='manual-forward-repair-required';persist();
    throw Error('data-reader recovery refused; never restore the incompatible old version');
  }
}
export async function execute(receipt,ops,persist){
  assert.equal(receipt.status,'preflight-passed');
  assert.ok(Date.now()-Date.parse(receipt.createdAt)<15*60_000,'preflight expired');
  const step=async(name,fn)=>{receipt.stage=name;persist();try{return await fn();}catch{receipt.failedStage=name;persist();throw Error(`data-reader stage failed: ${name}`);}};
  try{
    assertBoundary(await ops.boundary(),receipt);
    assert.equal(await ops.active(),receipt.beforeVersion,'active version changed');
    same(await ops.pointers(),receipt.pointers,'data pointers changed before upload');
    receipt.versions={};receipt.versionEtags={};receipt.intent={};persist();
    for(const kind of ['readonly','full'])await step(`upload-${kind}`,async()=>{
      receipt.intent.upload=kind;persist();
      // Inactive upload response loss cannot be reconciled safely by a label alone.
      // Refuse with old active version untouched; never retry or infer ownership.
      const version=await ops.upload(kind,receipt);assertVersion(version,kind,receipt);
      assert.match(version.resources?.script?.etag??'',/^[a-f0-9]{64}$/,'version content identity absent');
      receipt.versionEtags[kind]=version.resources.script.etag;
      receipt.versions[kind]=version.id;persist();
      assertVersion(await ops.version(version.id),kind,receipt);
      assertBoundary(await ops.boundary(),receipt);
      assert.equal(await ops.active(),receipt.beforeVersion,'inactive upload changed active version');
    });
    for(const kind of ['readonly','full'])await step(`activate-${kind}`,async()=>{
      assertBoundary(await ops.boundary(),receipt);
      same(await ops.pointers(),receipt.pointers,'pointer changed before qualification');
      const expected=kind==='readonly'?receipt.beforeVersion:receipt.versions.readonly;
      assert.equal(await ops.active(),expected,'foreign activation');
      assertVersion(await ops.version(receipt.versions[kind]),kind,receipt);
      receipt.intent.activate=kind;persist();
      try{await ops.deploy(receipt.versions[kind]);}catch{receipt.activationResponseLost=kind;persist();}
      assert.equal(await ops.active(),receipt.versions[kind],'activation not observed');
      for(let round=0;round<3;round++){
        if(round)await ops.pause(15_000);
        await ops.verify(kind,receipt);
        assert.equal(await ops.active(),receipt.versions[kind],'verification deployment changed');
        assertBoundary(await ops.boundary(),receipt);
      }
    });
    receipt.status='passed';receipt.completedAt=new Date().toISOString();receipt.afterPointers=await ops.pointers();persist();
  }catch{
    receipt.status='failed';persist();ops.resetRecovery?.();await recover(receipt,ops,persist);
    throw Error(`data-reader refresh failed; recovery=${receipt.recovery}`);
  }
}

export function makeOperations(transport,atmos,source){
  const api=(path,options)=>transport.api(path,'DATA_EDGE_TOKEN',options);
  const version=id=>{assert.match(id,UUID);return api(`${SCRIPT}/versions/${id}`);};
  const active=async()=>activeVersion(await api(`${SCRIPT}/deployments`));
  const object=async(bucket,key,max=16*1024*1024)=>{
    assert.ok(['weatherx-data-production','weatherx-components-production'].includes(bucket));
    assert.match(key,/^[A-Za-z0-9._/-]+$/);assert.ok(!key.split('/').some(x=>!x||x==='.'||x==='..'));
    const response=await transport.authenticated(`/accounts/${ACCOUNT}/r2/buckets/${bucket}/objects/${key.split('/').map(encodeURIComponent).join('/')}`,'DATA_EDGE_TOKEN');
    assert.equal(response.status,200,'immutable object read failed');assert.ok(response.body.length<=max,'object oversized');return response.body;
  };
  const pointers=async()=>Object.fromEntries(await Promise.all(['catalogs/current.json','releases/current.json'].map(async key=>[key,hash(await object('weatherx-data-production',key,256*1024))])));
  async function boundary(){
    const targets={};
    for(const [id,name,token] of [['data',WORKER,'DATA_EDGE_TOKEN'],['platform','weatherx-platform-edge-production','PLATFORM_EDGE_TOKEN']]){
      const base=`/accounts/${ACCOUNT}/workers/scripts/${name}`;
      const [settings,schedules,subdomain,deployments]=await Promise.all(['/settings','/schedules','/subdomain','/deployments'].map(path=>transport.api(base+path,token)));
      const normalized=normalizedSettings(settings);
      if(id==='data')assertSettings(source.settings,settings);
      else for(const [key,wanted] of [['AUTH_MODE','observe'],['BILLING_MODE','disabled'],['DATA_CATALOG_MODE','shadow']])assert.ok(normalized.bindings.some(x=>x.name===key&&x.text===wanted),'platform safety mode changed');
      assert.equal(subdomain.enabled,false,'development URL enabled');assert.equal(subdomain.previews_enabled,false,'preview URL enabled');
      const activeId=activeVersion(deployments);
      const detail=await transport.api(`${base}/versions/${activeId}`,token);assert.equal(detail.id,activeId,'active version identity mismatch');
      targets[id]={settings:normalized,runtime:detail.resources.script_runtime,schedules:{...schedules,schedules:sorted(schedules.schedules)},subdomain,...(id==='platform'?{version:activeId}:{})};
    }
    const pages=await transport.api(`/accounts/${ACCOUNT}/pages/projects/atmos-platform`,'PAGES_TOKEN');
    assert.equal(pages.canonical_deployment?.environment,'production');assert.equal(pages.canonical_deployment?.latest_stage?.status,'success');
    const routes=sorted(await api(`/zones/${ZONE}/workers/routes`));
    same(routes.filter(x=>x.script===WORKER).map(x=>x.pattern).sort(),source.settings.routes.map(x=>x.pattern).sort(),'data route policy changed');
    return {...targets,routes,pages:{id:pages.canonical_deployment.id,sha256:digest(pages.canonical_deployment),settingsSha256:digest(pages.deployment_configs)}};
  }
  return {active,version,object,pointers,boundary,
    upload:async(kind,receipt)=>{
      const previous=receipt.beforeVersion;assert.match(previous,UUID);
      const settings=receipt.boundary.data.settings;
      const metadata={main_module:'dataReader.mjs',compatibility_date:settings.compatibility_date,compatibility_flags:settings.compatibility_flags,
        bindings:settings.bindings.map(x=>({name:x.name,type:'inherit',version_id:previous})),
        annotations:versionAnnotations(kind,receipt)};
      // Versioned options must survive unchanged. Observability/logpush/tails/tags
      // are non-versioned: never PATCH them (Wrangler versions upload does not).
      for(const key of ['placement','limits','cache_options','usage_model'])if(Object.hasOwn(settings,key))metadata[key]=settings[key];
      for(const key of ['limits','usage_model'])if(Object.hasOwn(receipt.boundary.data.runtime,key))metadata[key]=receipt.boundary.data.runtime[key];
      const body=new FormData();body.set('metadata',new Blob([JSON.stringify(metadata)],{type:'application/json'}));
      body.set('dataReader.mjs',new Blob([source.bundles[kind].bytes],{type:'application/javascript+module'}),'dataReader.mjs');
      return api(`${SCRIPT}/versions?bindings_inherit=strict`,{method:'POST',body});
    },
    deploy:id=>{assert.match(id,UUID);return api(`${SCRIPT}/deployments`,{method:'POST',body:{strategy:'percentage',versions:[{version_id:id,percentage:100}]}});},
    verify:async(kind,receipt)=>{
      const proof=await proveReaders(atmos,object,transport,kind);receipt.latestProof=proof;
      const health=await transport.request(ORIGIN+'/api/platform/data-health');assert.equal(health.status,200);
      same(JSON.parse(health.body),{ok:true,authMode:'public',catalogMode:'serve'},'data health mode changed');
    },
    pause:ms=>new Promise(resolvePromise=>setTimeout(resolvePromise,ms)),
  };
}

export async function main(args=process.argv.slice(2)){
  if(args.length===1&&args[0]==='pages-access')return checkPagesReadAuthority();
  const [command,atmosInput,sha,receiptInput,expectedDigest]=args;
  assert.ok(['preflight','execute','recover'].includes(command));assert.equal(args.length,5);assert.match(sha??'',SHA);assert.match(expectedDigest??'',/^[a-f0-9]{64}$/);
  const atmos=resolve(atmosInput),receiptPath=resolve(receiptInput);
  const source=await build(atmos,sha);
  let end=Date.now()+8*60_000;
  const transport=createTransport({deadline:()=>end});const ops=makeOperations(transport,atmos,source);
  ops.resetRecovery=()=>{end=Date.now()+5*60_000;};
  if(command==='preflight'){
    const boundary=await ops.boundary(),beforeVersion=await ops.active();const observed=digest({boundary,beforeVersion});
    console.log(`data-reader boundary sha256: ${observed}`);
    assert.equal(observed,expectedDigest,'reviewed boundary digest required');
    const receipt={schemaVersion:1,sha,controller:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,tag:`wxdr-${randomUUID()}`,createdAt:new Date().toISOString(),boundary,boundarySha256:observed,pointers:await ops.pointers(),beforeVersion,source:{inventory:source.inventory,esbuildVersion:source.esbuildVersion,bundles:Object.fromEntries(Object.entries(source.bundles).map(([k,v])=>[k,{sha256:v.sha256,inputs:v.inputs}]))}};
    await ops.verify('preflight',receipt);same(await ops.pointers(),receipt.pointers,'pointer changed during preflight');
    receipt.status='preflight-passed';saveReceipt(receiptPath,receipt);return;
  }
  assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.GITHUB_REF,'refs/heads/main');assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');
  assert.equal(process.env.GITHUB_WORKFLOW_REF,`Andrewegao/v3t7kq-cycle/.github/workflows/data-reader-refresh.yml@refs/heads/main`);
  assert.ok(existsSync(receiptPath),'receipt missing');const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
  assert.equal(receipt.sha,sha);assert.equal(receipt.controller,process.env.GITHUB_SHA);assert.equal(receipt.runId,process.env.GITHUB_RUN_ID);assert.equal(receipt.attempt,process.env.GITHUB_RUN_ATTEMPT);assert.equal(receipt.boundarySha256,expectedDigest);assert.equal(digest({boundary:receipt.boundary,beforeVersion:receipt.beforeVersion}),expectedDigest);
  assert.equal(receipt.source.inventory,source.inventory);
  for(const kind of ['readonly','full'])assert.equal(receipt.source.bundles[kind].sha256,source.bundles[kind].sha256);
  const persist=()=>saveReceipt(receiptPath,receipt);
  if(command==='recover')return recover(receipt,ops,persist);
  try{await execute(receipt,ops,persist);}catch{end=Date.now()+5*60_000;throw Error(`data-reader refresh refused at ${receipt.failedStage??'precondition'}; ${receipt.recovery??'no mutation'}`);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
