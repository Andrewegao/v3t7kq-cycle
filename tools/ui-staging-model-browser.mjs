// Trusted cycle-owned real-site gate. Executed in a secret-free child process,
// inside the existing Pages rollback transaction. No candidate code is imported.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {digest,validateSelection,STAGING_ORIGIN,cycleTime} from './ui-staging-models.mjs';

export function protocol(env){
  assert.equal(env.BASE,STAGING_ORIGIN,'only actual staging custom domain can qualify');
  assert.match(env.UI_EXPECTED_SOURCE_SHA??'',/^[a-f0-9]{40}$/);
  assert.match(env.WEATHERX_EXPECTED_RELEASE_ID??'',/^git-[a-f0-9]{12}-run-[1-9]\d*$/);
  for(const k of Object.keys(env))assert.ok(!/^(?:GITHUB_TOKEN|GH_TOKEN|CLOUDFLARE|UI_BUILD_PRIVATE_KEY|UI_CANDIDATE_KEY|STAGING_R2|MODEL_INPUT_ARCHIVE_KEY)/.test(k),'browser must not inherit credentials');
}
export function pixelDifference(on,off){
  assert.equal(on.width,off.width);assert.equal(on.height,off.height);assert.equal(on.data.length,off.data.length);
  let changed=0;for(let i=0;i<on.data.length;i+=4)if(Math.max(...[0,1,2].map(c=>Math.abs(on.data[i+c]-off.data[i+c])))>8)changed++;
  return changed/(on.width*on.height);
}
export function layerActivationNeeded(layers,field){return layers?.[field]?.visible!==true;}
export function responseCaptureNeeded(required,observed,capturing,path){return required.has(path)&&!observed.has(path)&&!capturing.has(path);}
export function matrixProofPlan(entries,nowMs){
  const rows=entries.map(entry=>{
    const init=cycleTime(entry.init,nowMs),lead=Math.ceil((nowMs-init)/3600000)+1;assert.ok(lead>=0&&lead+1<=48);
    const paths=Object.fromEntries(['temp','wind','mslp'].map(field=>[field,[lead,lead+1].map(i=>`/data/_catalog/${entry.catalogId}/${entry.model}/runs/${entry.init}/${field}/${String(i).padStart(3,'0')}.png`)]));
    return {model:entry.model,init,lead,cursor:init+(lead+.5)*3600000,paths};
  });
  const required=new Set(rows.flatMap(row=>Object.values(row.paths).flat()));assert.equal(required.size,entries.length*6);
  return {rows,required};
}
const DISCARDED_BODY='Protocol error (Network.getResponseBody): No data found for resource with given identifier';
export function discardedResponseBody(error){return String(error).endsWith(DISCARDED_BODY);}
export async function responseBodyOrFallback(response,fallback){
  try{return await response.body();}
  catch(error){if(!discardedResponseBody(error))throw error;return fallback();}
}
export function validateFetchedObject(path,expected,response,body){
  const final=new URL(response.url);assert.equal(final.origin,STAGING_ORIGIN);assert.equal(final.pathname,path);assert.equal(final.search,'');assert.equal(response.status,200);
  assert.equal(response.headers.get('x-weatherx-catalog'),expected.catalogId);assert.equal(body.length,expected.bytes);assert.equal(digest(body),expected.sha256);return body;
}
export function browserCandidateReady(state,expected){
  return state?.origin===STAGING_ORIGIN&&state?.releaseStatus===200&&state?.selectionStatus===200
    &&state?.sourceSha===expected.sourceSha&&state?.releaseId===expected.releaseId
    &&state?.selectionSha256===expected.selectionSha256&&state?.modelButtonCount===1
    &&state?.modelButtonVisible===true&&state?.lit===true&&state?.bootSettled===true&&state?.atmosReady===true;
}
const LABELS={icon:'ICON',hrdps:'HRDPS',nam:'NAM','nam-hi':'NAM HI','nam-ak':'NAM AK','hrrr-ak':'HRRR AK','arome-antilles':'AROME ANT'};
const DECK={temp:'temp-raster',wind:'wind-field',mslp:'mslp-fill'};
async function get(url,max=1024*1024){
  assert.equal(new URL(url).origin,STAGING_ORIGIN);const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Cache-Control':'no-cache'}});assert.equal(r.status,200);
  const parts=[];let count=0;for await(const b of r.body){count+=b.length;assert.ok(count<=max);parts.push(b);}return Buffer.concat(parts);
}
export async function runMatrix(env){
  protocol(env);const bytes=readFileSync(env.UI_SELECTION_FILE),bundle=validateSelection(bytes,env.UI_SELECTION_SHA256);
  assert.equal(digest(await get(STAGING_ORIGIN+'/assets/staging-model-selection.json')),env.UI_SELECTION_SHA256,'deployed selection differs');
  const release=JSON.parse(await get(STAGING_ORIGIN+'/health/release.json'));assert.equal(release.gitSha,env.UI_EXPECTED_SOURCE_SHA);assert.equal(release.releaseId,env.WEATHERX_EXPECTED_RELEASE_ID);
  const {chromium}=await import(pathToFileURL(resolve(env.UI_CONTROL_ROOT,'app/node_modules/playwright/index.mjs')));
  const {PNG}=await import(pathToFileURL(resolve(env.UI_CONTROL_ROOT,'app/node_modules/pngjs/lib/png.js')));
  const browser=await chromium.launch({args:['--enable-gpu','--ignore-gpu-blocklist']});
  // Pre-arm every exact field/frame the matrix will prove before the page can warm any of them.
  // A valid performance warm may fetch a later-selected field before its row begins; arming lazily
  // discarded that already-verified response and made a healthy painted field look unverified.
  const proofPlan=matrixProofPlan(bundle.entries,Date.now()),plans=new Map(proofPlan.rows.map(row=>[row.model,row]));
  const results=[],errors=[],network=[],observed=new Map(),required=proofPlan.required,capturing=new Set(),pending=new Set();
  const context=await browser.newContext({viewport:{width:1440,height:900},locale:'en-US'});
  await context.addInitScript(()=>{
    sessionStorage.setItem('atmos-boot-shown','1');localStorage.setItem('atmos-ai-code','central');localStorage.setItem('atmos-ai-scope','central');
    localStorage.setItem('atmos-coach-done','1');localStorage.setItem('atmos-locale','en');localStorage.setItem('atmos-debug','1');
    window.__stagingGateCommits=[];window.addEventListener('wx:field-commit',e=>{window.__stagingGateCommits.push(e.detail);if(window.__stagingGateCommits.length>1000)window.__stagingGateCommits.shift();});
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(/GL_INVALID|INVALID_(?:OPERATION|VALUE|ENUM)|WebGL.*(?:error|warning)/i.test(m.text()))errors.push(m.text());});
  await page.route(/^https:\/\/(?:[^/]+\.)?weatherx\.org\//,route=>{
    if(new URL(route.request().url()).origin===STAGING_ORIGIN)return route.continue();
    errors.push('unexpected production request');return route.abort();
  });
  const byPath=new Map(bundle.entries.flatMap(e=>e.displayInventory.map(f=>[`/data/_catalog/${e.catalogId}/${e.model}/${f.path}`,{...f,catalogId:e.catalogId}])));
  async function fallbackBody(path,expected){
    const url=new URL(path,STAGING_ORIGIN),r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Cache-Control':'no-cache'}});
    const parts=[];let count=0;for await(const b of r.body){count+=b.length;assert.ok(count<=expected.bytes);parts.push(b);}const body=Buffer.concat(parts);
    return validateFetchedObject(path,expected,r,body);
  }
  page.on('response',r=>{
    const url=new URL(r.url()),expected=byPath.get(url.pathname);if(!expected||!responseCaptureNeeded(required,observed,capturing,url.pathname))return;
    capturing.add(url.pathname);
    const promise=(async()=>{assert.equal(url.origin,STAGING_ORIGIN);assert.equal(url.search,'');assert.equal(r.status(),200);assert.equal((await r.allHeaders())['x-weatherx-catalog'],expected.catalogId);
      const body=await responseBodyOrFallback(r,()=>fallbackBody(url.pathname,expected));assert.equal(body.length,expected.bytes);assert.equal(digest(body),expected.sha256);observed.set(url.pathname,expected.sha256);
    })().catch(e=>network.push(`${url.pathname}: ${String(e)}`)).finally(()=>{capturing.delete(url.pathname);pending.delete(promise);});pending.add(promise);
  });
  async function drainResponses(){
    for(let i=0;i<100;i++){
      const batch=[...pending];if(batch.length)await Promise.all(batch);
      else {await new Promise(resolve=>setImmediate(resolve));if(pending.size===0)return;}
    }
    assert.fail('timed out hashing selected staging response bytes');
  }
  async function browserCandidateState(){
    return page.evaluate(async()=>{
      const summary={origin:location.origin,href:location.href,width:innerWidth,height:innerHeight,bodyClass:document.body.className,
        lit:document.body.classList.contains('wl-lit'),atmosReady:!!window.__atmos?.deckSnapshot,
        bootSettled:!document.body.classList.contains('wl-boot'),
        modelButtonCount:document.querySelectorAll('button[aria-controls="forecast-model-dialog"]').length,
        bodyText:document.body.innerText.slice(0,500)};
      const modelButton=document.querySelector('button[aria-controls="forecast-model-dialog"]');
      summary.modelButtonVisible=!!modelButton&&modelButton.getClientRects().length===1
        &&getComputedStyle(modelButton).visibility!=='hidden'&&getComputedStyle(modelButton).display!=='none';
      try {
        const [releaseResponse,selectionResponse]=await Promise.all([
          fetch('/health/release.json',{cache:'no-store',headers:{'Cache-Control':'no-cache'}}),
          fetch('/assets/staging-model-selection.json',{cache:'no-store',headers:{'Cache-Control':'no-cache'}}),
        ]);
        summary.releaseStatus=releaseResponse.status;summary.selectionStatus=selectionResponse.status;
        if(releaseResponse.ok){const release=await releaseResponse.json();summary.sourceSha=release.gitSha;summary.releaseId=release.releaseId;}
        if(selectionResponse.ok){const selection=await selectionResponse.arrayBuffer(),hash=await crypto.subtle.digest('SHA-256',selection);
          summary.selectionSha256=[...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,'0')).join('');}
      } catch(error){summary.readinessError=String(error);}
      return summary;
    });
  }
  async function loadExactBrowserCandidate(){
    const expected={sourceSha:env.UI_EXPECTED_SOURCE_SHA,releaseId:env.WEATHERX_EXPECTED_RELEASE_ID,selectionSha256:env.UI_SELECTION_SHA256},attempts=[];
    for(let attempt=1;attempt<=3;attempt++){
      await page.goto(STAGING_ORIGIN+'/?devprobes=1#c=104,35,3.1&l=wind',{waitUntil:'domcontentloaded',timeout:60000});
      let startupError=null;
      try {await page.waitForFunction(()=>window.__atmos?.deckSnapshot&&document.body.classList.contains('wl-lit')
        &&!document.body.classList.contains('wl-boot'),null,{timeout:20000});}
      catch(error){startupError=String(error);}
      const state=await browserCandidateState();attempts.push({...state,attempt,startupError});
      if(browserCandidateReady(state,expected))return state;
      if(attempt<3)await page.waitForTimeout(1500);
    }
    throw Error('browser candidate did not converge: '+JSON.stringify(attempts));
  }
  async function openModel(model){
    const trigger=page.locator('button[aria-controls="forecast-model-dialog"]').first();
    try {await trigger.waitFor({state:'visible',timeout:15000});await trigger.click({timeout:15000});}
    catch(error){throw Error(`model trigger unavailable for ${model}: ${JSON.stringify(await browserCandidateState())}; ${error instanceof Error?error.message:String(error)}`);}
    const option=page.locator('#forecast-model-dialog [role="radio"]').filter({has:page.locator('.wy-model-name',{hasText:new RegExp('^'+LABELS[model]+'$')})});
    await option.waitFor({state:'visible',timeout:15000});assert.equal(await option.isDisabled(),false);await option.click();
  }
  async function ensureLayer(field){
    const layers=await page.evaluate(()=>window.__atmos.store.getState().layers);
    if(layerActivationNeeded(layers,field))await page.evaluate(field=>window.__atmos.activateLayer(field),field);
    await page.waitForFunction(field=>window.__atmos.store.getState().layers[field]?.visible===true,field,{timeout:15000});
  }
  async function settled(e,field,cursor){
    await page.waitForFunction(({model,init,field,id,cursor})=>{
      const a=window.__atmos,s=a?.store.getState(),m=s?.manifest;
      return m?.model===model&&m.init_time===init&&s.cursorMs===cursor&&s.layers[field]?.visible&&!document.body.dataset.wlSwap&&!a.map.isMoving()
        &&a.deckSnapshot().some(d=>d.id===id&&d.opacity>0.1)&&window.__stagingGateCommits.some(c=>c.model===model&&c.initTime===init);
    },{model:e.model,init:new Date(cycleTime(e.init)).toISOString().replace('.000Z','Z'),field,id:DECK[field],cursor},{timeout:45000});
    await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  }
  const snapshot=()=>page.evaluate(()=>{const a=window.__atmos,s=a.store.getState(),m=s.manifest,c=a.map.getCenter();return {model:m.model,init:m.init_time,base:m.base,cursor:s.cursorMs,center:[c.lng,c.lat],zoom:a.map.getZoom(),projection:a.map.getProjection()?.type,opacity:s.layers,commits:window.__stagingGateCommits.length};});
  try {
    let rapid=null,firstRequestStarted=null,firstRequestReleased=false;
    if(bundle.entries.length>1){
      const first=bundle.entries[0];let start;firstRequestStarted=new Promise(resolve=>{start=resolve;});let delayed=false;
      await page.route(url=>url.origin===STAGING_ORIGIN&&url.pathname===first.manifestPath,async route=>{
        if(delayed)return route.continue();delayed=true;start();await new Promise(resolve=>setTimeout(resolve,1500));firstRequestReleased=true;return route.continue();
      });
    }
    await loadExactBrowserCandidate();
    await page.evaluate(()=>{const s=window.__atmos.store.getState();s.setPlaying(false);s.setParticlesOverlay(false);});
    if(bundle.entries.length>1){
      const [first,last]=[bundle.entries[0],bundle.entries.at(-1)];await openModel(first.model);
      await Promise.race([firstRequestStarted,new Promise((_,reject)=>setTimeout(()=>reject(Error('first model request did not start')),10000))]);
      // The option click closes a real modal with a bounded exit animation. Re-clicking its trigger
      // before React has committed that close can toggle the still-open dialog shut instead of
      // reopening it; on a slower CI browser that made the selector appear to vanish. Wait only for
      // the UI close lifecycle (not the delayed model request), then prove the second user choice
      // still supersedes the first while its manifest is in flight.
      await page.locator('#forecast-model-dialog').waitFor({state:'detached',timeout:3000});
      assert.equal(firstRequestReleased,false,'first model request finished before rapid supersession');
      await openModel(last.model);
      await page.waitForFunction(model=>window.__atmos.store.getState().manifest?.model===model&&!window.__atmos.map.isMoving(),last.model,{timeout:45000});
      await page.waitForTimeout(2000);await drainResponses();const final=await snapshot();assert.equal(final.model,last.model);assert.equal(final.base,last.manifestPath.slice(0,-'manifest.json'.length));
      if(last.model!=='icon'){const mid=(last.grid.lon0+last.grid.lon1)/2,lon=final.center[0]+360*Math.round((mid-final.center[0])/360);assert.ok(lon>=last.grid.lon0&&lon<=last.grid.lon1&&final.center[1]>=last.grid.lat1&&final.center[1]<=last.grid.lat0,'stale regional camera overrode latest model');}
      rapid={rapidModelSequence:[first.model,last.model],finalModel:final.model};
      // Start the sequential byte/pixel matrix in a new document. Otherwise the
      // winning rapid-choice frames can survive in the app's memory cache and
      // satisfy rendering without a new response that the exact-byte gate can
      // observe. Page routing already disables Chromium's HTTP cache.
      await loadExactBrowserCandidate();
      await page.evaluate(()=>{const s=window.__atmos.store.getState();s.setPlaying(false);s.setParticlesOverlay(false);});
    }
    for(const entry of bundle.entries){
      validateSelection(bytes,env.UI_SELECTION_SHA256);const {cursor,paths}=plans.get(entry.model);const requiredFor=field=>paths[field];
      // activateLayer is intentionally a toggle: calling it when wind is already visible clears
      // every weather layer and removes the model selector. The matrix needs idempotent "ensure",
      // not a second user toggle, between model rows.
      await ensureLayer('wind');await openModel(entry.model);
      await page.waitForFunction(model=>window.__atmos.store.getState().manifest?.model===model,entry.model,{timeout:45000});
      await page.evaluate(cursor=>{window.__stagingGateCommits=[];const s=window.__atmos.store.getState();s.select(null);s.setCursor(cursor);s.setPlaying(false);s.setParticlesOverlay(false);},cursor);
      await settled(entry,'wind',cursor);const selected=await snapshot();assert.equal(selected.base,entry.manifestPath.slice(0,-'manifest.json'.length));
      if(entry.model!=='icon'){
        const g=entry.grid,mid=(g.lon0+g.lon1)/2,lon=selected.center[0]+360*Math.round((mid-selected.center[0])/360);
        assert.ok(lon>=g.lon0&&lon<=g.lon1&&selected.center[1]>=g.lat1&&selected.center[1]<=g.lat0,'regional selection did not frame its own domain');
      }
      const layers=[];
      for(const field of ['temp','wind','mslp']){
        const fieldPaths=requiredFor(field);
        await page.evaluate(()=>{window.__stagingGateCommits=[];});await ensureLayer(field);await settled(entry,field,cursor);
        const before=await snapshot(),clip={x:300,y:160,width:650,height:470},on=PNG.sync.read(await page.screenshot({clip}));
        const opacity=await page.evaluate(field=>{const s=window.__atmos.store.getState(),v=s.layers[field].opacity;s.setLayerOpacity(field,0);return v;},field);
        await page.waitForFunction(id=>window.__atmos.deckSnapshot().find(d=>d.id===id)?.opacity===0,DECK[field],{timeout:15000});
        await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const off=PNG.sync.read(await page.screenshot({clip}));
        await page.evaluate(({field,opacity})=>window.__atmos.store.getState().setLayerOpacity(field,opacity),{field,opacity});await settled(entry,field,cursor);
        const after=await snapshot();assert.equal(after.model,before.model);assert.equal(after.init,before.init);assert.equal(after.base,before.base);assert.equal(after.cursor,before.cursor);assert.deepEqual(after.center,before.center);
        const changed=pixelDifference(on,off);assert.ok(changed>.01,'weather raster failed >1% visible-pixel proof');
        await drainResponses();assert.equal(network.length,0,network.join(';'));
        for(const path of fieldPaths)assert.ok(observed.has(path),'selected field bytes were not verified');
        await page.locator('.maplibregl-canvas').first().click({position:{x:650,y:400}});
        const card=page.locator('.datalens .dl-card');await card.waitFor({state:'visible',timeout:15000});const text=await card.innerText();
        assert.match(text,/verified point forecast.*not yet published/i,'unqualified model must explicitly abstain from point/fusion issuance');assert.ok(text.includes(entry.model.toUpperCase()));
        await page.evaluate(()=>window.__atmos.store.getState().select(null));layers.push({field,changedRatio:changed,point:'explicit-unavailable',fusionEligible:false});
      }
      await ensureLayer('wind');await settled(entry,'wind',cursor);
      const domain=await page.evaluate(g=>{const a=window.__atmos;let good=null;for(const x of [.25,.5,.75])for(const y of [.25,.5,.75]){
        const lon=g.lon0+(g.lon1-g.lon0)*x,lat=g.lat1+(g.lat0-g.lat1)*y,value=a.sampleWind(lon,lat);if(Number.isFinite(value))good={lon,lat,value,west:a.sampleWind(lon-360,lat),east:a.sampleWind(lon+360,lat)};}
        return {good,outside:a.sampleWind((g.lon0+g.lon1)/2,g.lat1-1)};},entry.grid);
      assert.ok(domain.good,'no finite wind value inside qualified domain');
      if(entry.model!=='icon')assert.equal(domain.outside,null,'regional sampler leaked outside source domain');
      if(['nam-ak','hrrr-ak'].includes(entry.model)){assert.ok(Number.isFinite(domain.good.west)&&Number.isFinite(domain.good.east));assert.ok(Math.abs(domain.good.value-domain.good.west)<1e-6&&Math.abs(domain.good.value-domain.good.east)<1e-6);}
      results.push({model:entry.model,catalogId:entry.catalogId,init:entry.init,selected,layers,domain});
    }
    if(rapid)results.push(rapid);
    await drainResponses();assert.equal(network.length,0,network.join(';'));assert.equal(errors.length,0,errors.join(';'));validateSelection(bytes,env.UI_SELECTION_SHA256);
    const receipt={schemaVersion:1,origin:STAGING_ORIGIN,sourceSha:env.UI_EXPECTED_SOURCE_SHA,releaseId:env.WEATHERX_EXPECTED_RELEASE_ID,selectionSha256:env.UI_SELECTION_SHA256,qualifiedAt:new Date().toISOString(),models:results,verifiedObjectCount:observed.size};
    writeFileSync(env.UI_MODEL_BROWSER_OUTPUT,JSON.stringify(receipt,null,2)+'\n',{mode:0o600});return receipt;
  }finally{await context.close();await browser.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const result=await runMatrix(process.env);console.log(JSON.stringify({phase:'staging-model-browser-qualified',selectionSha256:result.selectionSha256,models:result.models.length,production:false}));}
  catch(error){console.error('Staging model browser qualification failed: '+error.message);process.exitCode=1;}
}
