// Trusted, secret-free real-site gate for the staging-only release-roster core profile.
// It proves AIFS on Wind and HRRR on Temperature (HRRR Wind is intentionally unadmitted),
// while checking every release-roster regional choice independently. It never reads the
// expired hash-selected staging asset and it cannot qualify production.
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonical,GRIDS,STAGING_ORIGIN,MODELS as REGIONAL_MODELS,variables} from './ui-staging-models.mjs';
import {pointUrl,validatePointPayload} from './ui-staging-preflight.mjs';
import {pixelDifference} from './ui-staging-model-browser.mjs';

const HOUR=3_600_000;
const CORE=Object.freeze({
  aifs:{label:'AIFS',field:'wind',deck:'wind-field',location:{name:'aifs-global',lat:35,lon:104},windAdmitted:true},
  hrrr:{label:'HRRR',field:'temp',deck:'temp-raster',location:{name:'hrrr-conus',lat:39.74,lon:-104.99},windAdmitted:false},
});
const SAFE_ID=/^[A-Za-z0-9._:@+-]{1,160}$/;
const RELEASE_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,SHA1=/^[a-f0-9]{40}$/,SHA256=/^[a-f0-9]{64}$/;
const ROSTER_KEYS=['schemaVersion','kind','createdAt','maxAgeHours','cycleHours','horizonHours','leadCount','fusionEligible','models'];
const ROSTER_ENTRY_KEYS=new Set(['status','init','initTime','path','collectedAt','reason','sourceSha','sourceReceiptSha256',
  'stagedQualificationSha256','inventorySha256','totalBytes','attempts']);
const MANIFEST_KEYS=new Set(['schemaVersion','model','init_time','grid','variables','windReference','frames','attribution','license','base','individualModel']);
const MAX_CATALOG_BYTES=256*1024;
class CatalogTransportError extends Error {}

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
function regionalCycle(model,value){
  assert.ok(REGIONAL_MODELS.includes(model));assert.match(value??'',ISO);const time=Date.parse(value);assert.ok(Number.isFinite(time));
  assert.equal(new Date(time).toISOString().replace('.000',''),value);assert.equal(time%(6*HOUR),0,`${model} requires a six-hour source cycle`);
  return value.replace(/[-:T]/g,'').slice(0,10);
}
export function validateRegionalCatalogIndex(value,model,catalogId){
  assert.ok(REGIONAL_MODELS.includes(model));assert.match(catalogId??'',RELEASE_ID);const index=object(value,`${model} catalog index required`);
  assert.equal(index.schemaVersion,1);assert.equal(index.model,model);assert.ok(Array.isArray(index.runs)&&index.runs.length>=1&&index.runs.length<=32,`${model} catalog runs`);
  const run=object(index.runs[0],`${model} latest catalog run required`),cycle=regionalCycle(model,run.init_time);assert.equal(run.path,`runs/${cycle}/`);
  return {model,init:run.init_time,cycle,catalogId,manifestPath:`/data/_catalog/${catalogId}/${model}/${run.path}manifest.json`};
}
export function validateRegionalCatalogManifest(value,index,now=Date.now()){
  const manifest=object(value,`${index.model} catalog manifest required`);assert.ok(Object.keys(manifest).every(key=>MANIFEST_KEYS.has(key)),'unsanitized catalog manifest fields');
  assert.equal(manifest.schemaVersion,1);assert.equal(manifest.model,index.model);assert.equal(manifest.init_time,index.init);assert.equal(manifest.windReference,'earth-relative');
  assert.ok(manifest.individualModel===undefined||manifest.individualModel===true);assert.equal(canonical(manifest.grid),canonical(GRIDS[index.model]),'unreviewed catalog grid');
  assert.equal(canonical(manifest.variables),canonical(variables(index.model)),'unreviewed catalog encoding');
  const init=Date.parse(manifest.init_time);assert.ok(Number.isFinite(init)&&init<=now&&now-init<=24*HOUR,'stale or future catalog cycle');
  assert.ok(Array.isArray(manifest.frames)&&manifest.frames.length===49,'49 catalog frames required');
  for(const [i,value] of manifest.frames.entries()){const frame=object(value,'catalog manifest frame');assert.deepEqual(Object.keys(frame).sort(),['i','valid_time']);
    assert.equal(frame.i,i);assert.equal(frame.valid_time,new Date(init+i*HOUR).toISOString().replace('.000',''));}
  assert.ok(typeof manifest.attribution==='string'&&manifest.attribution.length>0&&manifest.attribution.length<=1024,'catalog attribution required');
  if(manifest.license!==undefined)assert.ok(typeof manifest.license==='string'&&manifest.license.length>0&&manifest.license.length<=1024,'invalid catalog license');
  const base=`/data/_catalog/${index.catalogId}/${index.model}/runs/${index.cycle}/`;
  return {...manifest,base,individualModel:true};
}
async function catalogJson(response){
  const declared=response.headers.get('content-length');if(declared!==null)assert.ok(/^\d+$/.test(declared)&&Number(declared)<=MAX_CATALOG_BYTES,'catalog metadata too large');
  assert.ok(response.body,'catalog metadata missing');const chunks=[];let size=0;
  try{for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=MAX_CATALOG_BYTES,'catalog metadata too large');chunks.push(chunk);}}
  finally{await response.body?.cancel().catch(()=>{});}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
async function catalogMetadata(url,request){
  try{return await request(new URL(url,STAGING_ORIGIN).href,{redirect:'error',signal:AbortSignal.timeout(5_000),headers:{Accept:'application/json','Cache-Control':'no-cache'}});}
  catch{throw new CatalogTransportError('catalog request failed');}
}
export async function catalogAdmissionProof(model,rosterSelectable,now=Date.now(),request=fetch){
  let indexResponse,response;
  try{
    indexResponse=await catalogMetadata(`/data/${model}/index.json`,request);
    if(!indexResponse.ok){if(indexResponse.status===404)return {catalogStatus:'absent',catalogId:null,catalogInit:null,expectedSelectable:rosterSelectable};
      if(indexResponse.status>=500)throw new CatalogTransportError('catalog index unavailable');assert.fail('catalog index refused');}
    const catalogId=indexResponse.headers.get('x-weatherx-catalog');
    if(catalogId===null)return {catalogStatus:'absent',catalogId:null,catalogInit:null,expectedSelectable:rosterSelectable};
    assert.match(catalogId,RELEASE_ID);assert.equal(indexResponse.headers.has('x-weatherx-release'),false,'catalog index carries release identity');
    const index=validateRegionalCatalogIndex(await catalogJson(indexResponse),model,catalogId);
    response=await catalogMetadata(index.manifestPath,request);
    if(!response.ok){if(response.status>=500)throw new CatalogTransportError('catalog manifest unavailable');assert.fail('catalog manifest refused');}
    assert.equal(response.headers.get('x-weatherx-catalog'),catalogId,'catalog manifest identity');assert.equal(response.headers.has('x-weatherx-release'),false,'catalog manifest carries release identity');
    validateRegionalCatalogManifest(await catalogJson(response),index,now);
    return {catalogStatus:'valid',catalogId,catalogInit:index.init,expectedSelectable:true};
  }catch(error){
    if(error instanceof CatalogTransportError)return {catalogStatus:'transport',catalogId:null,catalogInit:null,expectedSelectable:rosterSelectable};
    return {catalogStatus:'refused',catalogId:null,catalogInit:null,expectedSelectable:false};
  }finally{await indexResponse?.body?.cancel().catch(()=>{});await response?.body?.cancel().catch(()=>{});}
}
export function coreCycle(model,value){
  assert.ok(model==='aifs'||model==='hrrr');assert.match(value??'',/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):00:00Z$/);
  const time=Date.parse(value);assert.ok(Number.isFinite(time));assert.equal(new Date(time).toISOString().replace('.000',''),value,'core run is not an exact UTC hour');
  if(model==='aifs')assert.equal(new Date(time).getUTCHours()%6,0,'AIFS requires a six-hour source cycle');
  return value.replace(/[-:T]/g,'').slice(0,10);
}

// Serialized into Playwright. Scheduled Deck props are not a paint receipt: require the exact
// current intent's post-selection application receipt and its accepted completed render generation.
export function deckSurfaceProof(expected){
  const api=window.__atmos,state=api?.store.getState(),manifest=state?.manifest;
  if(!api||!manifest||!expected||!Number.isInteger(expected.afterSequence)||!state.layers[expected.field]?.visible||document.body.dataset.wlSwap
    ||manifest.model!==expected.manifest.model||manifest.init_time!==expected.manifest.init||manifest.base!==expected.manifest.base
    ||state.cursorMs!==expected.cursorMs||api.map.isMoving())return false;
  const round=value=>Math.round(value*1e6)/1e6,bounds=api.map.getBounds(),host=api.map.getContainer();
  const camera=JSON.stringify([round(bounds.getWest()),round(bounds.getEast()),round(bounds.getNorth()),round(bounds.getSouth()),
    round(api.map.getZoom()),round(api.map.getBearing()),round(api.map.getPitch()),host.clientWidth,host.clientHeight]);
  if(camera!==expected.camera)return false;
  const handoff=api.temperatureHandoffDiagnostics?.(),ledger=api.renderCausalDiagnostics?.(),current=ledger?.events.at(-1)?.data;
  if(!ledger?.enabled||ledger.errors||handoff?.selectedPrimary!==expected.field||current?.intentKey!==expected.field||!Number.isInteger(current.intentGeneration))return false;
  if(current.model!==manifest.model||current.run!==manifest.init_time||current.base!==manifest.base||current.cursor!==state.cursorMs||current.swap!=='idle')return false;
  const matches=event=>event.sequence>expected.afterSequence&&event.data.intentKey===expected.field&&event.data.intentGeneration===current.intentGeneration
    &&event.data.swap==='idle'&&event.data.model===manifest.model&&event.data.run===manifest.init_time&&event.data.base===manifest.base&&event.data.cursor===state.cursorMs;
  const receipt=ledger.events.findLast(event=>event.stage==='layer-receipt'&&event.data.path==='deck'&&event.data.painted?.split('|').includes(expected.field)&&matches(event));
  if(!receipt||!Number.isInteger(receipt.data.receiptToken)||!Number.isInteger(receipt.data.overlayGeneration)||!Number.isInteger(current.overlayGeneration))return false;
  const flush=ledger.events.findLast(event=>event.stage==='receipt-flush'&&event.sequence<receipt.sequence&&matches(event));
  const draw=ledger.events.findLast(event=>event.stage==='deck-after'&&event.sequence<(flush?.sequence??0)&&matches(event));
  if(flush?.data.accepted!==true||!draw||flush.data.renderedGeneration!==receipt.data.overlayGeneration||draw.data.renderedGeneration!==receipt.data.overlayGeneration)return false;
  const currentDraw=ledger.events.findLast(event=>event.stage==='deck-after'&&matches(event)&&event.data.renderedGeneration===event.data.overlayGeneration
    &&event.data.renderedGeneration===current.overlayGeneration);
  if(!currentDraw)return false;
  const snapshot=api.deckSnapshot(),summary=snapshot.filter(layer=>layer.id===expected.deck);
  const layers=api.map.__deck?.layerManager?.getLayers?.(),matchesLayer=layers?.filter(layer=>layer.id===expected.deck),layer=matchesLayer?.[0];
  if(summary.length!==1||summary[0].opacity<.8||matchesLayer?.length!==1||!layer?.isLoaded||layer.props?.visible===false||layer.props?.opacity<.8
    ||!layer.props.image||!layer.props.image2||layer.state?.props?.image!==layer.props.image||layer.state?.props?.image2!==layer.props.image2
    ||!layer.state?.imageTexture||!layer.state?.imageTexture2||!layer.getSubLayers?.().some(child=>child.state?.model))return false;
  return {receiptSequence:receipt.sequence,receiptGeneration:receipt.data.overlayGeneration,drawSequence:currentDraw.sequence,
    renderedGeneration:currentDraw.data.renderedGeneration,camera};
}

// Serialized into Playwright. The OFF image is eligible only after Deck has completed a newer
// exact-identity generation with the selected raster gone or authored at zero opacity.
export function hiddenDeckSurfaceProof(expected){
  const api=window.__atmos,state=api?.store.getState(),manifest=state?.manifest;
  if(!api||!manifest||!expected||!Number.isInteger(expected.afterSequence)||document.body.dataset.wlSwap||api.map.isMoving()
    ||manifest.model!==expected.manifest.model||manifest.init_time!==expected.manifest.init||manifest.base!==expected.manifest.base||state.cursorMs!==expected.cursorMs)return false;
  const round=value=>Math.round(value*1e6)/1e6,bounds=api.map.getBounds(),host=api.map.getContainer();
  const camera=JSON.stringify([round(bounds.getWest()),round(bounds.getEast()),round(bounds.getNorth()),round(bounds.getSouth()),
    round(api.map.getZoom()),round(api.map.getBearing()),round(api.map.getPitch()),host.clientWidth,host.clientHeight]);
  if(camera!==expected.camera)return false;
  const ledger=api.renderCausalDiagnostics?.(),current=ledger?.events.at(-1)?.data;if(!ledger?.enabled||ledger.errors)return false;
  const draw=ledger.events.findLast(event=>event.stage==='deck-after'&&event.sequence>expected.afterSequence&&event.data.swap==='idle'
    &&event.data.model===manifest.model&&event.data.run===manifest.init_time&&event.data.base===manifest.base&&event.data.cursor===state.cursorMs
    &&Number.isInteger(event.data.renderedGeneration)&&event.data.renderedGeneration===event.data.overlayGeneration);
  if(!draw||current?.overlayGeneration!==draw.data.renderedGeneration||current.model!==manifest.model||current.run!==manifest.init_time
    ||current.base!==manifest.base||current.cursor!==state.cursorMs||current.swap!=='idle')return false;
  const summary=api.deckSnapshot().filter(layer=>layer.id===expected.deck),layers=api.map.__deck?.layerManager?.getLayers?.()??[];
  const actual=layers.filter(layer=>layer.id===expected.deck);if(summary.some(layer=>layer.opacity>0)||actual.some(layer=>layer.props?.visible!==false&&layer.props?.opacity>0))return false;
  if(expected.field==='wind'&&state.layers.wind?.visible!==false)return false;
  if(expected.field==='temp'&&state.layers.temp?.opacity!==0)return false;
  return {drawSequence:draw.sequence,renderedGeneration:draw.data.renderedGeneration,camera};
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
  const releaseRosterRows=releaseRosterProof((await boundedJson('/data/model-roster.json')).body,now);
  const rosterRows=await Promise.all(releaseRosterRows.map(async row=>{
    const catalog=await catalogAdmissionProof(row.model,row.expectedSelectable,now);
    return {...row,rosterSelectable:row.expectedSelectable,...catalog};
  }));
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
    await page.goto(`${STAGING_ORIGIN}/?devprobes=1&rendercausal=1#c=${location.lon},${location.lat},5.2&l=wind`,{waitUntil:'domcontentloaded',timeout:60_000});
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
    const expected=rosterRows.map(row=>({name:labels[row.model],selectable:row.expectedSelectable}));
    await page.waitForFunction(expected=>{const buttons=[...document.querySelectorAll('#forecast-model-dialog button.wy-model')];
      return expected.every(item=>{const matches=buttons.filter(button=>button.querySelector('.wy-model-name')?.textContent?.trim()===item.name);
        return matches.length===(item.selectable?1:0)&&(!item.selectable||matches[0].disabled===false);});},expected,{timeout:15_000});
    const listed=await page.locator('#forecast-model-dialog button.wy-model').evaluateAll(buttons=>buttons.map(button=>({name:button.querySelector('.wy-model-name')?.textContent?.trim(),disabled:button.disabled})));
    await page.keyboard.press('Escape');
    return rosterRows.map(row=>{const match=listed.filter(entry=>entry.name===labels[row.model]);assert.ok(match.length<=1,`${row.model} option duplicated`);
      return {...row,visible:match.length===1,enabled:match.length===1&&!match[0].disabled};});
  }
  async function fixedCamera(page,location){
    await page.evaluate(location=>{const map=window.__atmos.map;window.__wxCoreCameraUnlock?.();let applying=false;
      const exact=()=>{const center=map.getCenter();return !map.isMoving()&&Math.abs(center.lng-location.lon)<1e-6&&Math.abs(center.lat-location.lat)<1e-6
        &&Math.abs(map.getZoom()-5.2)<1e-6&&Math.abs(map.getBearing())<1e-6&&Math.abs(map.getPitch())<1e-6;};
      const hold=()=>{if(applying||exact())return;applying=true;try{map.stop();map.jumpTo({center:[location.lon,location.lat],zoom:5.2,bearing:0,pitch:0});}finally{applying=false;}};
      map.on('movestart',hold);map.on('move',hold);window.__wxCoreCameraUnlock=()=>{map.off('movestart',hold);map.off('move',hold);delete window.__wxCoreCameraUnlock;};hold();},location);
    await page.waitForFunction(location=>{const map=window.__atmos.map,center=map.getCenter();return !map.isMoving()&&Math.abs(center.lng-location.lon)<1e-6
      &&Math.abs(center.lat-location.lat)<1e-6&&Math.abs(map.getZoom()-5.2)<1e-6&&Math.abs(map.getBearing())<1e-6&&Math.abs(map.getPitch())<1e-6;},location,{timeout:10_000});
    return page.evaluate(()=>{const map=window.__atmos.map,bounds=map.getBounds(),host=map.getContainer(),round=value=>Math.round(value*1e6)/1e6;
      return JSON.stringify([round(bounds.getWest()),round(bounds.getEast()),round(bounds.getNorth()),round(bounds.getSouth()),round(map.getZoom()),
        round(map.getBearing()),round(map.getPitch()),host.clientWidth,host.clientHeight]);});
  }
  async function exactDeckPaint(page,rule,index){
    await page.waitForFunction(({model,init,base})=>{const manifest=window.__atmos.store.getState().manifest;
      return manifest?.model===model&&manifest.init_time===init&&manifest.base===base;},
    {model:index.model,init:index.init,base:`/data/_catalog/${index.catalogId}/${index.model}/runs/${index.cycle}/`},{timeout:45_000});
    const camera=await fixedCamera(page,rule.location);
    if(await page.evaluate(field=>window.__atmos.store.getState().layers[field]?.visible===true,rule.field)){
      await page.evaluate(field=>window.__atmos.activateLayer(field),rule.field);
      await page.waitForFunction(field=>window.__atmos.store.getState().layers[field]?.visible===false,rule.field,{timeout:15_000});
    }
    const afterSequence=await page.evaluate(()=>window.__atmos.renderCausalDiagnostics().events.at(-1)?.sequence??0);
    await page.evaluate(field=>window.__atmos.activateLayer(field),rule.field);
    await page.waitForFunction(field=>window.__atmos.store.getState().layers[field]?.visible===true,rule.field,{timeout:15_000});
    const cursorMs=await page.evaluate(()=>window.__atmos.store.getState().cursorMs);
    const expected={afterSequence,manifest:{model:index.model,init:index.init,base:`/data/_catalog/${index.catalogId}/${index.model}/runs/${index.cycle}/`},
      cursorMs,field:rule.field,deck:rule.deck,camera};
    const handle=await page.waitForFunction(deckSurfaceProof,expected,{timeout:45_000});await handle.dispose();return {expected};
  }
  async function stableScreenshot(page,predicate,expected,clip,label){
    for(let attempt=0;attempt<3;attempt++){
      const beforeHandle=await page.waitForFunction(predicate,expected,{timeout:30_000}),before=await beforeHandle.jsonValue();await beforeHandle.dispose();
      const bytes=await page.screenshot({clip}),after=await page.evaluate(predicate,expected);
      const identity=proof=>JSON.stringify([proof?.receiptSequence??null,proof?.receiptGeneration??null,proof?.renderedGeneration??null,proof?.camera??null]);
      if(after&&identity(before)===identity(after))return {image:PNG.sync.read(bytes),proof:after};
    }
    throw new Error(`${label} paint identity did not remain stable across capture`);
  }
  async function modelProof(model){
    const rule=CORE[model],record={model,status:'error'};let session;
    try{
      session=await pageFor(rule.location);const {page,pageErrors}=session;const menuRoster=await rosterMenuProof(page);
      if(observedRoster===null)observedRoster=menuRoster;else assert.deepEqual(menuRoster,observedRoster,'release roster menu changed between model checks');
      await ensureLayer(page,rule.field);await pick(page,model);
      const index=indexes[model];if(index?.error)throw index.error;const {expected}=await exactDeckPaint(page,rule,index);
      const clip={x:300,y:160,width:650,height:470},{image:on,proof:paint}=await stableScreenshot(page,deckSurfaceProof,expected,clip,'ON');
      const hideAfterSequence=await page.evaluate(()=>window.__atmos.renderCausalDiagnostics().events.at(-1)?.sequence??0);
      if(rule.field==='wind')await page.evaluate(()=>window.__atmos.store.getState().setLayerVisible('wind',false));
      else await page.evaluate(field=>window.__atmos.store.getState().setLayerOpacity(field,0),rule.field);
      const hiddenExpected={...expected,afterSequence:hideAfterSequence};
      const {image:off,proof:hidden}=await stableScreenshot(page,hiddenDeckSurfaceProof,hiddenExpected,clip,'OFF');
      await page.evaluate(()=>window.__wxCoreCameraUnlock?.());
      const changedRatio=pixelDifference(on,off);assert.ok(changedRatio>.01,`${model} weather pixels did not change`);
      const state=await page.evaluate(({model,location})=>{const a=window.__atmos,s=a.store.getState(),m=s.manifest;return {model:m.model,init:m.init_time,base:m.base,variables:Object.keys(m.variables),sample:model==='aifs'?a.sampleWind(location.lon,location.lat):null};},{model,location:rule.location});
      assert.equal(state.model,model);assert.equal(state.init,index.init);assert.ok(baseMatches(model,index.cycle,index.catalogId,state.base),'model base/catalog identity changed');
      assert.ok(state.variables.includes(rule.field));if(model==='hrrr')assert.equal(state.variables.includes('wind'),false,'unverified HRRR wind became admitted');
      const point=await pointProof(model,rule.location,now);assert.equal(point.runId,index.cycle,'map and point runs differ');pointReleases.push(point.releaseId);
      if(model==='aifs')assert.ok(Number.isFinite(state.sample),'AIFS wind sampler is not finite');
      const outside=model==='hrrr'?await hrrrOutsideDomain(now):null;
      assert.deepEqual(pageErrors,[],'browser emitted core model errors');
      Object.assign(record,{status:'ready',init:index.init,base:state.base,catalogId:index.catalogId,field:rule.field,deck:rule.deck,paint,hidden,changedRatio,
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
