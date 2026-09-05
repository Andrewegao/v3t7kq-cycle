// Trusted, secret-free real-site gate for the staging-only release-roster core profile.
// It proves AIFS on Wind and HRRR on Temperature (HRRR Wind is intentionally unadmitted),
// while checking every release-roster regional choice independently. It never reads the
// expired hash-selected staging asset and it cannot qualify production.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {STAGING_ORIGIN,MODELS as REGIONAL_MODELS} from './ui-staging-models.mjs';
import {pointUrl,validatePointPayload} from './ui-staging-preflight.mjs';
import {pixelDifference} from './ui-staging-model-browser.mjs';

const HOUR=3_600_000;
const CORE=Object.freeze({
  aifs:{label:'AIFS',field:'wind',deck:'wind-field',location:{name:'aifs-global',lat:35,lon:104},windAdmitted:true},
  hrrr:{label:'HRRR',field:'temp',deck:'temp-raster',location:{name:'hrrr-conus',lat:39.74,lon:-104.99},windAdmitted:false},
});
const SAFE_ID=/^[A-Za-z0-9._:@+-]{1,160}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,SHA1=/^[a-f0-9]{40}$/,SHA256=/^[a-f0-9]{64}$/;
const ROSTER_KEYS=['schemaVersion','kind','createdAt','maxAgeHours','cycleHours','horizonHours','leadCount','fusionEligible','models'];
const ROSTER_ENTRY_KEYS=new Set(['status','init','initTime','path','collectedAt','reason','sourceSha','sourceReceiptSha256',
  'stagedQualificationSha256','inventorySha256','totalBytes','attempts']);

export function protocol(env){
  assert.equal(env.BASE,STAGING_ORIGIN,'only actual staging custom domain can qualify');
  assert.match(env.UI_EXPECTED_SOURCE_SHA??'',/^[a-f0-9]{40}$/);
  assert.match(env.WEATHERX_EXPECTED_RELEASE_ID??'',/^git-[a-f0-9]{12}-run-[1-9]\d*$/);
  assert.ok(env.UI_MODEL_BROWSER_OUTPUT,'browser receipt path required');
  for(const key of Object.keys(env))assert.ok(!/^(?:GITHUB_TOKEN|GH_TOKEN|CLOUDFLARE|UI_BUILD_PRIVATE_KEY|UI_CANDIDATE_KEY|STAGING_R2|MODEL_INPUT_ARCHIVE_KEY)/.test(key),'browser must not inherit credentials');
}

function object(value,message){assert.ok(value&&typeof value==='object'&&!Array.isArray(value),message);return value;}
export function releaseRosterProof(value,now=Date.now()){
  const roster=object(value,'release roster required');
  assert.deepEqual(Object.keys(roster).sort(),[...ROSTER_KEYS].sort());assert.equal(roster.schemaVersion,1);assert.equal(roster.kind,'weatherx-release-model-roster');
  assert.match(roster.createdAt??'',ISO);assert.equal(roster.maxAgeHours,24);assert.equal(roster.cycleHours,6);assert.equal(roster.horizonHours,48);
  assert.equal(roster.leadCount,49);assert.equal(roster.fusionEligible,false);
  const models=object(roster.models,'release roster models required');assert.deepEqual(Object.keys(models).sort(),[...REGIONAL_MODELS].sort());
  return REGIONAL_MODELS.map(model=>{
    const entry=object(models[model],`${model} roster entry required`);assert.ok(['fresh','carried','absent'].includes(entry.status),`${model} roster status`);
    assert.ok(Object.keys(entry).every(key=>ROSTER_ENTRY_KEYS.has(key)),`${model} roster entry carries unknown fields`);
    if(entry.collectedAt!==undefined)assert.match(entry.collectedAt,ISO);if(entry.reason!==undefined)assert.ok(typeof entry.reason==='string'&&entry.reason.length<=1024);
    if(entry.sourceSha!==undefined)assert.match(entry.sourceSha,SHA1);for(const key of ['sourceReceiptSha256','stagedQualificationSha256','inventorySha256'])if(entry[key]!==undefined)assert.match(entry[key],SHA256);
    if(entry.totalBytes!==undefined)assert.ok(Number.isSafeInteger(entry.totalBytes)&&entry.totalBytes>0);if(entry.attempts!==undefined)assert.ok(Array.isArray(entry.attempts));
    let init=null,expectedSelectable=false;
    if(entry.status!=='absent'){
      assert.match(entry.init??'',/^\d{8}(?:00|06|12|18)$/);init=String(entry.init);
      const time=Date.parse(`${init.slice(0,4)}-${init.slice(4,6)}-${init.slice(6,8)}T${init.slice(8)}:00:00Z`);
      assert.ok(Number.isFinite(time));assert.equal(entry.initTime,new Date(time).toISOString().replace('.000',''));assert.equal(entry.path,`runs/${init}/`);
      expectedSelectable=time<=now&&now-time<=24*HOUR;
    }
    return {model,status:entry.status,init,expectedSelectable};
  });
}

export function validateCoreIndex(value,model,catalogId){
  const index=object(value,`${model} index required`);assert.equal(index.schemaVersion,1);assert.equal(index.model,model);
  assert.ok(Array.isArray(index.runs)&&index.runs.length>0,`${model} run required`);assert.match(catalogId??'',SAFE_ID);
  const run=object(index.runs[0],`${model} latest run required`),cycle=coreCycle(model,run.init_time);assert.equal(run.path,`runs/${cycle}/`);
  return {model,init:run.init_time,cycle,catalogId,manifestPath:`/data/_catalog/${catalogId}/${model}/${run.path}manifest.json`};
}
export function coreCycle(model,value){
  assert.ok(model==='aifs'||model==='hrrr');assert.match(value??'',/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):00:00Z$/);
  const time=Date.parse(value);assert.ok(Number.isFinite(time));assert.equal(new Date(time).toISOString().replace('.000',''),value,'core run is not an exact UTC hour');
  if(model==='aifs')assert.equal(new Date(time).getUTCHours()%6,0,'AIFS requires a six-hour source cycle');
  return value.replace(/[-:T]/g,'').slice(0,10);
}

async function boundedJson(url,{status=200,max=2*1024*1024}={}){
  const parsed=new URL(url,STAGING_ORIGIN);assert.equal(parsed.origin,STAGING_ORIGIN);
  const response=await fetch(parsed,{redirect:'error',signal:AbortSignal.timeout(20_000),headers:{Accept:'application/json','Cache-Control':'no-cache'}});
  assert.equal(response.url,parsed.href,'staging request redirected');assert.equal(response.status,status,`${parsed.pathname} returned ${response.status}`);
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=max,'staging response too large');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);return {body:JSON.parse(bytes),headers:response.headers};
}

async function pointProof(model,location,now){
  const url=pointUrl(model,location,now),start=url.searchParams.get('start'),end=url.searchParams.get('end');
  const {body,headers}=await boundedJson(url);const releaseId=headers.get('x-weatherx-release');assert.match(releaseId??'',SAFE_ID);
  const proof=validatePointPayload(body,model,{now,location,start,end,margin:0});assert.equal(proof.releaseId,releaseId);
  const samples=body.series.temperature.samples.filter(sample=>Number.isFinite(sample?.value));assert.ok(samples.length>0,`${model} temperature point value required`);
  return {releaseId,runId:proof.runId,quality:proof.quality,value:samples[0].value};
}

async function hrrrOutsideDomain(now){
  const url=pointUrl('hrrr',{name:'outside-hrrr',lat:35,lon:104},now);
  const {body}=await boundedJson(url,{status:404,max:64*1024});return validateOutsideDomain(body);
}
export function validateOutsideDomain(body){assert.equal(body?.error?.code,'outside_model_domain');assert.ok(typeof body.error.message==='string'&&body.error.message.length>0);return true;}

function baseMatches(model,cycle,catalogId,base){
  return base===`/data/_catalog/${catalogId}/${model}/runs/${cycle}/`;
}

export async function runCoreMatrix(env,now=Date.now()){
  protocol(env);const errors=[],rows=[],selectionRequests=[],pointReleases=[];let observedRoster=null;
  const release=(await boundedJson('/health/release.json')).body;
  assert.equal(release.gitSha,env.UI_EXPECTED_SOURCE_SHA);assert.equal(release.releaseId,env.WEATHERX_EXPECTED_RELEASE_ID);
  const rosterRows=releaseRosterProof((await boundedJson('/data/model-roster.json')).body,now);
  const indexes={};
  const indexModels=Object.keys(CORE),indexResults=await Promise.allSettled(indexModels.map(async model=>{
    const result=await boundedJson(`/data/${model}/index.json`),catalogId=result.headers.get('x-weatherx-catalog');
    return validateCoreIndex(result.body,model,catalogId);
  }));
  indexResults.forEach((result,index)=>{indexes[indexModels[index]]=result.status==='fulfilled'?result.value:{error:result.reason};});
  const {chromium}=await import(pathToFileURL(resolve(env.UI_CONTROL_ROOT,'app/node_modules/playwright/index.mjs')));
  const {PNG}=await import(pathToFileURL(resolve(env.UI_CONTROL_ROOT,'app/node_modules/pngjs/lib/png.js')));
  const browser=await chromium.launch({args:['--enable-gpu','--ignore-gpu-blocklist']});
  async function pageFor(location){
    const context=await browser.newContext({viewport:{width:1440,height:900},locale:'en-US'});
    await context.addInitScript(()=>{sessionStorage.setItem('atmos-boot-shown','1');localStorage.setItem('atmos-ai-code','central');localStorage.setItem('atmos-ai-scope','central');localStorage.setItem('atmos-coach-done','1');localStorage.setItem('atmos-locale','en');localStorage.setItem('atmos-debug','1');});
    const page=await context.newPage(),pageErrors=[];
    page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/assets/staging-model-selection.json')selectionRequests.push(url.href);});
    page.on('pageerror',error=>pageErrors.push(String(error)));
    page.on('console',message=>{if(/GL_INVALID|INVALID_(?:OPERATION|VALUE|ENUM)|WebGL.*(?:error|warning)/i.test(message.text()))pageErrors.push(message.text());});
    await page.route(/^https:\/\/(?:[^/]+\.)?weatherx\.org\//,route=>new URL(route.request().url()).origin===STAGING_ORIGIN?route.continue():route.abort());
    await page.goto(`${STAGING_ORIGIN}/?devprobes=1#c=${location.lon},${location.lat},5.2&l=wind`,{waitUntil:'domcontentloaded',timeout:60_000});
    await page.waitForFunction(()=>window.__atmos?.deckSnapshot&&document.body.classList.contains('wl-lit')&&!document.body.classList.contains('wl-boot'),null,{timeout:30_000});
    return {context,page,pageErrors};
  }
  async function openDialog(page){
    const trigger=page.locator('button[aria-controls="forecast-model-dialog"]').first();await trigger.waitFor({state:'visible',timeout:15_000});await trigger.click();
    await page.locator('#forecast-model-dialog').waitFor({state:'visible',timeout:5_000});
  }
  async function option(page,label){return page.locator('#forecast-model-dialog button.wy-model',{has:page.locator('.wy-model-name',{hasText:new RegExp(`^${label}$`)})}).first();}
  async function ensureLayer(page,field){
    const active=await page.evaluate(field=>window.__atmos.store.getState().layers[field]?.visible===true,field);
    if(!active)await page.evaluate(field=>window.__atmos.activateLayer(field),field);
    await page.waitForFunction(field=>window.__atmos.store.getState().layers[field]?.visible===true,field,{timeout:30_000});
  }
  async function pick(page,model){await openDialog(page);const pick=await option(page,CORE[model].label);assert.ok(await pick.count(),`${model} option absent`);assert.equal(await pick.isDisabled(),false,`${model} option disabled`);await pick.click();}
  async function rosterMenuProof(page){
    await openDialog(page);const labels={icon:'ICON','hrrr-ak':'HRRR AK',hrdps:'HRDPS',nam:'NAM','nam-hi':'NAM HI','nam-ak':'NAM AK','arome-antilles':'AROME ANT'};
    const expected=rosterRows.filter(row=>row.expectedSelectable).map(row=>labels[row.model]);
    await page.waitForFunction(expected=>{const names=[...document.querySelectorAll('#forecast-model-dialog button.wy-model .wy-model-name')].map(node=>node.textContent?.trim());
      return expected.every(name=>names.includes(name));},expected,{timeout:15_000});
    const listed=await page.locator('#forecast-model-dialog button.wy-model').evaluateAll(buttons=>buttons.map(button=>({name:button.querySelector('.wy-model-name')?.textContent?.trim(),disabled:button.disabled})));
    await page.keyboard.press('Escape');
    return rosterRows.map(row=>{const match=listed.filter(entry=>entry.name===labels[row.model]);assert.ok(match.length<=1,`${row.model} option duplicated`);
      return {...row,visible:match.length===1,enabled:match.length===1&&!match[0].disabled};});
  }
  async function modelProof(model){
    const rule=CORE[model],record={model,status:'error'};let session;
    try{
      session=await pageFor(rule.location);const {page,pageErrors}=session;const menuRoster=await rosterMenuProof(page);
      if(observedRoster===null)observedRoster=menuRoster;else assert.deepEqual(menuRoster,observedRoster,'release roster menu changed between model checks');
      await ensureLayer(page,rule.field);await pick(page,model);
      const index=indexes[model];if(index?.error)throw index.error;await page.waitForFunction(({model,deck})=>{
        const a=window.__atmos,s=a?.store.getState();return s?.manifest?.model===model&&!a.map.isMoving()&&a.deckSnapshot().some(layer=>layer.id===deck&&layer.opacity>.1);
      },{model,deck:rule.deck},{timeout:45_000});
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const clip={x:300,y:160,width:650,height:470},on=PNG.sync.read(await page.screenshot({clip}));
      if(rule.field==='wind')await page.evaluate(()=>window.__atmos.store.getState().setLayerVisible('wind',false));
      else await page.evaluate(field=>window.__atmos.store.getState().setLayerOpacity(field,0),rule.field);
      await page.waitForTimeout(250);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const off=PNG.sync.read(await page.screenshot({clip})),changedRatio=pixelDifference(on,off);assert.ok(changedRatio>.01,`${model} weather pixels did not change`);
      const state=await page.evaluate(({model,location})=>{const a=window.__atmos,s=a.store.getState(),m=s.manifest;return {model:m.model,init:m.init_time,base:m.base,variables:Object.keys(m.variables),sample:model==='aifs'?a.sampleWind(location.lon,location.lat):null};},{model,location:rule.location});
      assert.equal(state.model,model);assert.equal(state.init,index.init);assert.ok(baseMatches(model,index.cycle,index.catalogId,state.base),'model base/catalog identity changed');
      assert.ok(state.variables.includes(rule.field));if(model==='hrrr')assert.equal(state.variables.includes('wind'),false,'unverified HRRR wind became admitted');
      const point=await pointProof(model,rule.location,now);assert.equal(point.runId,index.cycle,'map and point runs differ');pointReleases.push(point.releaseId);
      if(model==='aifs')assert.ok(Number.isFinite(state.sample),'AIFS wind sampler is not finite');
      const outside=model==='hrrr'?await hrrrOutsideDomain(now):null;
      assert.deepEqual(pageErrors,[],'browser emitted core model errors');
      Object.assign(record,{status:'ready',init:index.init,base:state.base,catalogId:index.catalogId,field:rule.field,deck:rule.deck,changedRatio,
        finitePointValue:point.value,pointRunId:point.runId,pointQuality:point.quality,windAdmitted:rule.windAdmitted,domain:{inside:true,outside}});
    }catch(error){record.error=error instanceof Error?error.message:String(error);errors.push({model,error:record.error});}
    finally{await session?.context.close();}
    return record;
  }
  try{
    // Do not short-circuit: one missing model must not prevent independent evidence for the other.
    for(const model of ['aifs','hrrr'])rows.push(await modelProof(model));
    let rapidModelSequence=[],finalModel=null;
    if(rows.every(row=>row.status==='ready')){
      let session;try{
        session=await pageFor(CORE.aifs.location);const {page,pageErrors}=session;await ensureLayer(page,'wind');
        let release;const started=new Promise(resolve=>{release=resolve;});let delayed=false;
        await page.route(url=>url.origin===STAGING_ORIGIN&&url.pathname===indexes.aifs.manifestPath,async route=>{if(delayed)return route.continue();delayed=true;release();await new Promise(resolve=>setTimeout(resolve,1200));return route.continue();});
        await pick(page,'aifs');await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('AIFS rapid request did not start')),10_000))]);
        await page.locator('#forecast-model-dialog').waitFor({state:'detached',timeout:3_000});await ensureLayer(page,'temp');await pick(page,'hrrr');
        await page.waitForFunction(()=>window.__atmos.store.getState().manifest?.model==='hrrr',null,{timeout:45_000});await page.waitForTimeout(1500);
        finalModel=await page.evaluate(()=>window.__atmos.store.getState().manifest?.model);assert.equal(finalModel,'hrrr','late AIFS response overrode HRRR');rapidModelSequence=['aifs','hrrr'];
        assert.deepEqual(pageErrors,[],'browser emitted rapid-switch errors');
      }catch(error){errors.push({model:'rapid-aifs-hrrr',error:error instanceof Error?error.message:String(error)});}
      finally{await session?.context.close();}
    }
    if(selectionRequests.length)errors.push({model:'release-profile',error:'release-roster core profile fetched hash-selected staging policy'});
    const roster=observedRoster??[];
    if(roster.length!==REGIONAL_MODELS.length)errors.push({model:'release-roster',error:'release roster UI proof missing'});
    for(const row of roster){if(row.visible!==row.expectedSelectable||row.enabled!==row.expectedSelectable)errors.push({model:row.model,error:'visibility or enablement differs from its own roster entry'});}
    const receipt={schemaVersion:1,kind:'weatherx-staging-core-browser-receipt',origin:STAGING_ORIGIN,sourceSha:env.UI_EXPECTED_SOURCE_SHA,
      releaseId:env.WEATHERX_EXPECTED_RELEASE_ID,qualifiedAt:new Date(now).toISOString(),pointReleaseId:pointReleases[0]??null,
      releaseRoster:roster,models:rows,rapidModelSequence,finalModel,selectionRequests,errors};
    if(pointReleases.length){if(new Set(pointReleases).size!==1)errors.push({model:'core-point-release',error:'core point proofs span releases'});receipt.pointReleaseId=pointReleases[0];}
    writeFileSync(env.UI_MODEL_BROWSER_OUTPUT,JSON.stringify(receipt)+'\n',{mode:0o600});
    assert.equal(errors.length,0,'one or more core models failed qualification');assert.deepEqual(rapidModelSequence,['aifs','hrrr']);
    return receipt;
  }finally{await browser.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  runCoreMatrix(process.env).then(()=>{},error=>{console.error('Staging core browser qualification failed: '+(error instanceof Error?error.message:String(error)));process.exitCode=1;});
}
