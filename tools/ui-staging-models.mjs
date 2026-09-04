// Public metadata only. This helper never downloads weather, reads credentials or
// grants production eligibility. Cycle-owned selection bytes must be reviewed.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';

export const STAGING_ORIGIN='https://staging.weatherx.org';
export const SELECTION_ASSET='assets/staging-model-selection.json';
export const MAX_SELECTION_BYTES=1024*1024;
export const MODELS=['icon','hrrr-ak','hrdps','nam','nam-hi','nam-ak','arome-antilles'];
const HASH=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/,RUN=/^[1-9]\d{0,19}$/,ATTEMPT=/^[1-9]\d{0,3}$/;
export const digest=body=>createHash('sha256').update(body).digest('hex');
export const BASELINE_PROFILE=Object.freeze({product:'lab',account:false,expandedModels:false,data:false});
export function resolveSelectionRequest(requested='approved',approved){
  assert.ok(requested==='approved'||requested==='none'||HASH.test(requested??''),'invalid staging selection request');
  if(requested==='none')return 'none';
  assert.match(approved??'',HASH,'protected staging selection approval required');
  if(requested!=='approved')assert.equal(requested,approved,'requested staging selection differs from protected approval');
  return approved;
}
export function canonical(value){
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  assert.ok(value===null||['string','boolean','number'].includes(typeof value));if(typeof value==='number')assert.ok(Number.isFinite(value));return JSON.stringify(value);
}
function keys(object,expected){assert.ok(object&&typeof object==='object'&&!Array.isArray(object));assert.deepEqual(Object.keys(object).sort(),expected.split(' ').sort());return object;}
export function profileFor(selection='none'){
  if(selection===undefined||selection==='none')return BASELINE_PROFILE;
  assert.match(selection,HASH);return {...BASELINE_PROFILE,expandedModels:true,stagingOnly:true,modelSelectionSha256:selection};
}
export function validateProfile(profile){
  if(profile?.expandedModels===false){assert.deepEqual(profile,BASELINE_PROFILE);return profile;}
  assert.deepEqual(profile,profileFor(profile?.modelSelectionSha256));return profile;
}
// The baseline profile builds production with expandedModels:false. Since 2026-09-04 that no longer
// means "no regional models": the seven regional packs ride the immutable data release and the app
// admits them from the release-carried data/model-roster.json (data admission), never from a UI
// build flag or a staging selection. Only a hash-pinned staging experiment remains profile-gated.
export function requireProductionProfile(profile){assert.deepEqual(profile,BASELINE_PROFILE,'staging experiment cannot enter production');}
export function cycleTime(init,now=Date.now()){
  assert.match(init??'',/^\d{8}(00|06|12|18)$/);const iso=`${init.slice(0,4)}-${init.slice(4,6)}-${init.slice(6,8)}T${init.slice(8)}:00:00.000Z`,time=Date.parse(iso);
  assert.ok(Number.isFinite(time)&&new Date(time).toISOString()===iso&&(now===null||(now>=time&&now-time<=12*3600000)),'stale/future model selection');return time;
}
const grid=(width,height,lon0,lon1,lat0,lat1,step,crosses=false)=>({width,height,lon0,lon1,lat0,lat1,...(step===undefined?{}:{dx:step,dy:step,longitudeConvention:'continuous-east-degrees',wrapMeridian:180,crossesAntimeridian:crosses})});
export const GRIDS={icon:grid(1440,721,-180,179.75,90,-90),hrdps:grid(4483,1735,-152.75,-40.7,70.625,27.275000000000002),
  'arome-antilles':grid(945,529,-75.3,-51.7,22.9,9.7),nam:grid(1465,632,-134.1,-60.900000000000006,52.650000000000006,21.1,.05),
  'nam-hi':grid(308,203,-161.525,-153.85000000000002,23.1,18.05,.025),'nam-ak':grid(2323,699,-209.8,-93.7,75.4,40.5,.05,true),
  'hrrr-ak':grid(1758,711,-203.60000000000002,-115.75,77.10000000000001,41.6,.05,true)};
export function variables(model){const wind=['hrdps','arome-antilles'].includes(model)?100:150;return {
  temp:{file:'temp/{i}.png',channels:['t2m'],range:[-100,70],units:'degC'},wind:{file:'wind/{i}.png',channels:['u10','v10'],range:[-wind,wind],units:'m/s'},
  mslp:{file:'mslp/{i}.png',channels:['mslp'],range:['nam','nam-hi','nam-ak','hrrr-ak'].includes(model)?[600,1200]:[800,1100],units:'hPa'},mask:{file:'mask.png'}};}
export const displayPaths=init=>['index.json',`runs/${init}/manifest.json`,`runs/${init}/mask.png`,...['temp','wind','mslp'].flatMap(f=>Array.from({length:49},(_,i)=>`runs/${init}/${f}/${String(i).padStart(3,'0')}.png`))].sort();
const ENTRY='schemaVersion kind targetOrigin model status catalogId catalogSha256 component collectorSourceSha validatorSourceSha cloudSource validatorRun archiveReceiptSha256 archiveMarkerSha256 sourceReceiptSha256 stagedQualificationSha256 createdAt stagingDataQualified init leadCount horizonHours grid variables windReference displayInventory displayInventorySha256 indexPath manifestPath browserQualified fusionEligible productionPublishable weatherxFusionIssued';
export function validateSelection(bytes,expected,now=Date.now()){
  assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX_SELECTION_BYTES);assert.match(expected??'',HASH);assert.equal(digest(bytes),expected,'selection bytes differ from approval');
  const b=keys(JSON.parse(bytes),'schemaVersion kind targetOrigin entries');assert.equal(b.schemaVersion,1);assert.equal(b.kind,'weatherx-staging-model-selection');assert.equal(b.targetOrigin,STAGING_ORIGIN);
  assert.ok(Array.isArray(b.entries)&&b.entries.length>0&&b.entries.length<=7,'qualified model entries required');const seen=new Set();
  for(const value of b.entries){const e=keys(value,ENTRY);assert.ok(MODELS.includes(e.model)&&!seen.has(e.model));seen.add(e.model);
    assert.equal(e.schemaVersion,1);assert.equal(e.kind,'weatherx-staging-model-selection-entry');assert.equal(e.targetOrigin,STAGING_ORIGIN);assert.equal(e.status,'DATA_QUALIFIED');assert.equal(e.stagingDataQualified,true);
    for(const k of ['browserQualified','fusionEligible','productionPublishable','weatherxFusionIssued'])assert.equal(e[k],false);
    const init=cycleTime(e.init,now),created=Date.parse(e.createdAt);assert.ok(Number.isFinite(created)&&new Date(created).toISOString()===e.createdAt&&created>=init&&created-init<=12*3600000&&(now===null||created<=now));
    assert.equal(e.leadCount,49);assert.equal(e.horizonHours,48);assert.equal(e.windReference,'earth-relative');assert.deepEqual(e.grid,GRIDS[e.model]);assert.deepEqual(e.variables,variables(e.model));
    for(const k of ['catalogSha256','archiveReceiptSha256','archiveMarkerSha256','sourceReceiptSha256','stagedQualificationSha256','displayInventorySha256'])assert.match(e[k]??'',HASH);
    for(const k of ['collectorSourceSha','validatorSourceSha'])assert.match(e[k]??'',COMMIT);
    keys(e.cloudSource,'runId runAttempt');keys(e.validatorRun,'runId runAttempt runnerEnvironment');
    for(const r of [e.cloudSource,e.validatorRun]){assert.match(r.runId??'',RUN);assert.match(r.runAttempt??'',ATTEMPT);}assert.equal(e.validatorRun.runnerEnvironment,'github-hosted');
    const component=keys(e.component,'artifactId manifestKey manifestSha256 inventorySha256');
    assert.equal(component.artifactId,`stage-${e.init}-${e.validatorRun.runId}-${e.validatorRun.runAttempt}`);assert.equal(e.catalogId,`stage-${e.model}-${e.validatorRun.runId}-${e.validatorRun.runAttempt}`);
    assert.equal(component.manifestKey,`components/${e.model}/${component.artifactId}/component.json`);assert.match(component.manifestSha256??'',HASH);assert.match(component.inventorySha256??'',HASH);
    assert.equal(e.indexPath,`/data/_catalog/${e.catalogId}/${e.model}/index.json`);assert.equal(e.manifestPath,`/data/_catalog/${e.catalogId}/${e.model}/runs/${e.init}/manifest.json`);
    assert.ok(Array.isArray(e.displayInventory));assert.deepEqual(e.displayInventory.map(f=>f.path),displayPaths(e.init));let total=0;
    for(const f of e.displayInventory){keys(f,'path bytes sha256');assert.ok(Number.isSafeInteger(f.bytes)&&f.bytes>0&&f.bytes<=64*1024**2);assert.match(f.sha256??'',HASH);total+=f.bytes;}assert.ok(total<=3*1024**3);
    assert.equal(digest(canonical(e.displayInventory)),e.displayInventorySha256);
  }return b;
}
export function readSelection(root,profile,now=Date.now()){
  validateProfile(profile);if(!profile.stagingOnly)return null;
  const folder=resolve(root,'staging-selections'),path=resolve(folder,profile.modelSelectionSha256+'.json');
  for(const p of [folder,path]){const s=lstatSync(p);assert.ok(!s.isSymbolicLink());assert.equal(realpathSync(p),p);}
  const stat=lstatSync(path);assert.ok(stat.isFile()&&stat.nlink===1&&stat.size>0&&stat.size<=MAX_SELECTION_BYTES);
  const bytes=readFileSync(path);return {bytes,bundle:validateSelection(bytes,profile.modelSelectionSha256,now)};
}
// Historical transport inspection is structural. Every build/staging admission
// and browser qualification explicitly supplies a live clock again.
export function validateCandidateSelection(candidate,now=null){
  const profile=validateProfile(candidate.profile),asset=candidate.files.find(f=>f.path===SELECTION_ASSET);
  if(!profile.stagingOnly){assert.equal(asset,undefined,'baseline cannot carry experimental selection');return null;}
  assert.ok(asset,'experimental selection asset required');return validateSelection(Buffer.from(asset.base64,'base64'),profile.modelSelectionSha256,now);
}
export function requireStagingApproval(candidate,env,now=Date.now()){
  const expected=profileFor(env.MODEL_SELECTION_SHA256);assert.deepEqual(candidate.profile,expected,'candidate differs from requested UI profile');
  const bundle=validateCandidateSelection(candidate,now);
  if(expected.stagingOnly)assert.equal(env.UI_STAGING_MODEL_SELECTION_APPROVED_SHA256,expected.modelSelectionSha256,'protected staging selection approval required');
  return bundle;
}
export function browserEnvironment(env,extra={}){
  const allowed=['PATH','HOME','TMPDIR','TMP','TEMP','RUNNER_TEMP','LANG','LC_ALL','DISPLAY','XDG_RUNTIME_DIR','PLAYWRIGHT_BROWSERS_PATH','NODE_EXTRA_CA_CERTS'];
  const clean=Object.fromEntries(allowed.filter(k=>env[k]!==undefined).map(k=>[k,env[k]]));
  return {...clean,...extra};
}
export function validateBrowserReceipt(bytes,bundle,context,now=Date.now()){
  assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=5*1024*1024);const r=JSON.parse(bytes);
  keys(r,'schemaVersion origin sourceSha releaseId selectionSha256 qualifiedAt models verifiedObjectCount');
  assert.equal(r.schemaVersion,1);assert.equal(r.origin,STAGING_ORIGIN);assert.equal(r.sourceSha,context.sourceSha);assert.equal(r.releaseId,context.releaseId);assert.equal(r.selectionSha256,context.selectionSha256);
  const at=Date.parse(r.qualifiedAt);assert.ok(Number.isFinite(at)&&at<=now&&now-at<=10*60000);
  // Each of the three layers must prove both interpolation frames. Index,
  // manifest and mask reads are verified when observed but are not required to
  // be re-fetched when the browser legitimately reuses them from its cache.
  assert.ok(Number.isSafeInteger(r.verifiedObjectCount)&&r.verifiedObjectCount>=bundle.entries.length*6&&r.verifiedObjectCount<=bundle.entries.length*150);
  assert.ok(Array.isArray(r.models));assert.equal(r.models.length,bundle.entries.length+(bundle.entries.length>1?1:0),'browser receipt model cardinality changed');
  for(const entry of bundle.entries){const matches=r.models.filter(x=>x?.model===entry.model);assert.equal(matches.length,1);
    const m=matches[0];assert.equal(m.catalogId,entry.catalogId);assert.equal(m.init,entry.init);assert.equal(m.selected?.model,entry.model);assert.equal(m.selected?.base,entry.manifestPath.slice(0,-'manifest.json'.length));
    assert.deepEqual(m.layers?.map(x=>x.field),['temp','wind','mslp']);for(const layer of m.layers){assert.ok(layer.changedRatio>.01);
      assert.equal(layer.point?.kind,'independent-global');assert.ok(['ECMWF IFS 0.25°','NOAA GFS 0.25°','WeatherX Fusion','Open-Meteo fallback'].includes(layer.point?.source));assert.equal(layer.point?.mapModelFusionEligible,false);}}
  if(bundle.entries.length>1){const sequence=r.models.at(-1),first=bundle.entries[0].model,last=bundle.entries.at(-1).model;
    assert.deepEqual(sequence,{rapidModelSequence:[first,last],finalModel:last});}
  return r;
}
