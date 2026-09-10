// Trusted Cycle-owned proof for the isolated TC UI artifact. It runs only on loopback,
// reads the reviewed fixture inventory, and has no deploy or cloud write capability.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {TC_SELECTION_ASSET,TC_SELECTION_SHA256,validateTcSelection} from './ui-staging-models.mjs';
import {TC_CONTROL_SHA} from './ui-candidate.mjs';

const SHA256=/^[a-f0-9]{64}$/,SHA1=/^[a-f0-9]{40}$/;
const MAX_FIXTURE_BYTES=256*1024,MAX_RECEIPT_BYTES=256*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
const exactKeys=(value,expected,label)=>{
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value),`${label} object required`);
  assert.deepEqual(Object.keys(value).sort(),expected.slice().sort(),`${label} fields changed`);return value;
};
function regular(path,label,max=MAX_FIXTURE_BYTES){
  const stat=lstatSync(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,`${label} must be one regular file`);
  assert.equal(realpathSync(path),path,`${label} path changed`);assert.ok(stat.size>0&&stat.size<=max,`${label} exceeds bound`);
  return readFileSync(path);
}
export function validateTcFixture(root,expected=TC_SELECTION_SHA256,now=null){
  assert.ok(isAbsolute(root),'TC fixture root must be absolute');assert.equal(realpathSync(root),root,'TC fixture root changed');
  const allowed=new Set(['catalog.json','component.json','manifest.json','selection.json','tracks']);
  assert.ok(readdirSync(root).every(name=>allowed.has(name)),'unexpected TC fixture entry');
  const selectionBytes=regular(resolve(root,'selection.json'),'TC selection',16*1024);
  const selection=validateTcSelection(selectionBytes,expected,now);
  const manifestBytes=regular(resolve(root,'manifest.json'),'TC manifest');
  const componentBytes=regular(resolve(root,'component.json'),'TC component');
  const catalogBytes=regular(resolve(root,'catalog.json'),'TC catalog');
  assert.equal(hash(manifestBytes),selection.manifestSha256,'TC manifest differs from selection');
  assert.equal(hash(componentBytes),selection.componentManifestSha256,'TC component differs from selection');
  assert.equal(hash(catalogBytes),selection.catalogSha256,'TC catalog differs from selection');
  const manifest=JSON.parse(manifestBytes),component=JSON.parse(componentBytes),catalog=JSON.parse(catalogBytes),tracksDir=resolve(root,'tracks');
  exactKeys(component,'schemaVersion componentId artifactId generationTime completedAt rootPrefix mounts objectCount inventorySha256 quality'.split(' '),'TC component');
  assert.equal(component.schemaVersion,1);assert.equal(component.componentId,'tc-guidance');assert.match(component.artifactId,/^stage-tc-guidance-[A-Za-z0-9-]{1,96}$/);
  assert.equal(component.rootPrefix,`components/tc-guidance/${component.artifactId}/`);assert.deepEqual(component.mounts,['data-atmos/tc-models/']);assert.equal(component.objectCount,5);assert.equal(component.inventorySha256,selection.inventorySha256);
  exactKeys(catalog,'schemaVersion sequence parentCatalogId createdAt components rollbackEpoch'.split(' '),'TC catalog');assert.equal(catalog.schemaVersion,2);assert.equal(catalog.sequence,1);assert.equal(catalog.parentCatalogId,null);assert.equal(catalog.rollbackEpoch,0);
  const catalogComponent=catalog.components?.['tc-guidance'];assert.ok(catalogComponent&&typeof catalogComponent==='object');assert.equal(catalogComponent.artifactId,component.artifactId);
  assert.equal(catalogComponent.inventorySha256,selection.inventorySha256);assert.equal(catalogComponent.manifestSha256,selection.componentManifestSha256);
  assert.equal(catalogComponent.manifestKey,`${component.rootPrefix}component.json`);assert.equal(Object.keys(catalog.components).length,1);
  assert.equal(realpathSync(tracksDir),tracksDir);assert.ok(lstatSync(tracksDir).isDirectory()&&!lstatSync(tracksDir).isSymbolicLink());
  assert.equal(manifest?.v,1);assert.ok(Array.isArray(manifest.sources)&&manifest.sources.length>=1&&manifest.sources.length<=4);
  assert.ok(Array.isArray(manifest.storms)&&manifest.storms.length>=1&&manifest.storms.length<=128);
  const references=manifest.storms.flatMap(storm=>{
    assert.match(storm?.gdacsId??'',/^\d{1,32}$/);assert.equal(storm.id,`gdacs-${storm.gdacsId}`);
    assert.ok(typeof storm.name==='string'&&storm.name.length>0&&storm.name.length<=120);
    assert.ok(Array.isArray(storm.tracks)&&storm.tracks.length>=1&&storm.tracks.length<=4);return storm.tracks;
  });
  assert.ok(references.length>=1&&references.length<=512);
  const expectedTrackNames=references.map(ref=>{
    assert.match(ref?.sha256??'',SHA256);assert.equal(ref.path,`tracks/${ref.sha256}.json`);return `${ref.sha256}.json`;
  }).sort();
  assert.deepEqual(readdirSync(tracksDir).sort(),expectedTrackNames,'TC fixture tracks differ from manifest');
  const inventory=[{path:'manifest.json',size:manifestBytes.length,sha256:hash(manifestBytes)}];
  const tracks=new Map();let total=selectionBytes.length+manifestBytes.length+componentBytes.length+catalogBytes.length;
  for(const name of expectedTrackNames){
    const bytes=regular(resolve(tracksDir,name),'TC track');total+=bytes.length;const sha=name.slice(0,-5);assert.equal(hash(bytes),sha,'TC track digest changed');
    const ref=references.find(value=>value.sha256===sha),track=JSON.parse(bytes);assert.equal(track?.v,1);assert.match(track.gdacsId??'',/^\d{1,32}$/);assert.equal(track.stormId,`gdacs-${track.gdacsId}`);
    assert.equal(track.model,ref.model);assert.equal(track.initializedAt,ref.initializedAt);
    assert.ok(['ecmwf','gfs','hafs-a','hafs-b'].includes(track.model));assert.ok(Array.isArray(track.points)&&track.points.length>=2&&track.points.length<=200);
    tracks.set(sha,{bytes,track});inventory.push({path:`tracks/${name}`,size:bytes.length,sha256:sha});
  }
  assert.ok(total<=MAX_FIXTURE_BYTES,'TC fixture exceeds aggregate bound');
  inventory.sort((a,b)=>a.path.localeCompare(b.path));assert.equal(hash(JSON.stringify(inventory)),selection.inventorySha256,'TC inventory digest changed');
  return {selectionBytes,selection,manifestBytes,manifest,tracks,inventorySha256:selection.inventorySha256};
}
export function verifyControllerRoot(root,git=(args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()){
  assert.ok(isAbsolute(root),'UI controller root must be absolute');const stat=lstatSync(root);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());assert.equal(realpathSync(root),root,'UI controller root changed');
  assert.equal(git(['rev-parse','HEAD']),TC_CONTROL_SHA,'unqualified TC browser controller');git(['diff','--exit-code','HEAD']);
}
export function protocol(env){
  const base=new URL(env.BASE??'');assert.equal(base.protocol,'http:');assert.ok(['127.0.0.1','localhost'].includes(base.hostname));
  assert.match(env.UI_EXPECTED_SOURCE_SHA??'',SHA1);assert.equal(env.WEATHERX_EXPECTED_RELEASE_ID,`git-${env.UI_EXPECTED_SOURCE_SHA.slice(0,12)}-run-${env.GITHUB_RUN_ID}`);
  assert.equal(env.UI_TC_SELECTION_SHA256,TC_SELECTION_SHA256);assert.equal(env.UI_TC_CONTROL_SHA,TC_CONTROL_SHA);
  for(const key of ['UI_TC_FIXTURE_ROOT','UI_TC_DIST','UI_TC_PROOF_OUTPUT','UI_CONTROL_ROOT'])assert.ok(isAbsolute(env[key]??''),`${key} must be absolute`);
  for(const key of Object.keys(env))assert.ok(!/^(?:GITHUB_TOKEN|GH_TOKEN|CLOUDFLARE|UI_BUILD_PRIVATE_KEY|UI_CANDIDATE_KEY|STAGING_R2|MODEL_INPUT_ARCHIVE_KEY)/.test(key),'TC proof must not inherit credentials');
}
function hazards(manifest,track){
  const storm=manifest.storms[0],init=Date.parse(track.initializedAt),points=track.points.slice(0,17);
  return {v:1,at:new Date(init).toISOString(),ttl:600,tc:[{id:storm.gdacsId,ep:1,name:storm.name,zh:storm.name,tier:'Orange',src:'Reviewed TC fixture',upd:new Date(init).toISOString(),peakKt:75,peakAt:new Date(init).toISOString(),t0:new Date(init-24*3600000).toISOString(),
    pts:points.map((point,index)=>[point.lon,point.lat,index*6,'TY']),obsUpto:Math.min(1,points.length-1),lon:points[0].lon,lat:points[0].lat,cls:'TY',cone:[],rings:{'60':null,'90':null,'120':null},r7:null,landfall:null,
    brief:{short:'Isolated UI qualification fixture',long:'Reviewed immutable guidance bytes for loopback UI qualification.',delta:'',by:'fact',src:'Reviewed TC fixture'}}],ev:[],bundles:[],feed:{gdacs:true,eonet:true,tc:true},geomMissing:0};
}
export function validateTcProofBytes(bytes,context,now=Date.now()){
  assert.ok(Buffer.isBuffer(bytes)&&bytes.length>0&&bytes.length<=MAX_RECEIPT_BYTES,'TC proof exceeds bound');
  const value=exactKeys(JSON.parse(bytes),'schemaVersion kind qualificationScope sourceSha releaseId controllerSha selectionSha256 fixtureInventorySha256 qualifiedAt cloudWrites sharedStagingDeploy viewports'.split(' '),'TC proof');
  assert.equal(value.schemaVersion,1);assert.equal(value.kind,'weatherx-isolated-tc-ui-proof-v1');assert.equal(value.qualificationScope,'loopback-build-only-nonpromotable');
  assert.equal(value.sourceSha,context.sourceSha);assert.equal(value.releaseId,context.releaseId);assert.equal(value.controllerSha,TC_CONTROL_SHA);
  assert.equal(value.selectionSha256,TC_SELECTION_SHA256);assert.equal(value.fixtureInventorySha256,context.fixtureInventorySha256);
  assert.equal(value.cloudWrites,0);assert.equal(value.sharedStagingDeploy,false);const at=Date.parse(value.qualifiedAt);assert.ok(Number.isFinite(at)&&at<=now&&now-at<=10*60000);
  assert.ok(Array.isArray(value.viewports)&&value.viewports.length===2);for(const row of value.viewports){exactKeys(row,['width','height','models','pinnedTrackRequests'],'TC viewport');assert.ok([[1440,1000],[390,844]].some(([w,h])=>row.width===w&&row.height===h));assert.deepEqual(row.models,['gfs','ecmwf']);assert.ok(row.pinnedTrackRequests>=2);}
  assert.deepEqual(value.viewports.map(row=>`${row.width}x${row.height}`).sort(),['1440x1000','390x844'],'TC proof requires one desktop and one mobile viewport');
  return value;
}
export async function runTcProof(env=process.env){
  protocol(env);verifyControllerRoot(env.UI_CONTROL_ROOT);const fixture=validateTcFixture(env.UI_TC_FIXTURE_ROOT,env.UI_TC_SELECTION_SHA256,Date.now());
  const distSelection=regular(resolve(env.UI_TC_DIST,TC_SELECTION_ASSET),'built TC selection',16*1024);assert.ok(distSelection.equals(fixture.selectionBytes),'built TC selection differs from reviewed bytes');
  const release=JSON.parse(regular(resolve(env.UI_TC_DIST,'health/release.json'),'build release receipt').toString());assert.equal(release.gitSha,env.UI_EXPECTED_SOURCE_SHA);assert.equal(release.releaseId,env.WEATHERX_EXPECTED_RELEASE_ID);
  const firstStorm=fixture.manifest.storms[0],gfsRef=firstStorm.tracks.find(row=>row.model==='gfs')??firstStorm.tracks[0],gfs=fixture.tracks.get(gfsRef.sha256).track;
  const syntheticHazards=hazards(fixture.manifest,gfs),results=[];
  const {chromium}=await import(pathToFileURL(resolve(env.UI_CONTROL_ROOT,'app/node_modules/playwright/index.mjs')));
  const browser=await chromium.launch({headless:true});let active;
  try{
    for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
      const context=await browser.newContext({viewport});const page=await context.newPage();active=page;const errors=[],verified=new Set();let trackRequests=0;
      page.on('pageerror',error=>errors.push(error.stack||error.message));
      // The proof has no data-plane access. Exercise the app's bounded weather
      // recovery path, then qualify only the reviewed hurricane fixture.
      await page.route('**/api/forecast/**',route=>route.fulfill({status:503,body:'isolated TC qualification'}));
      await page.route('**/api/hazards',route=>route.fulfill({json:syntheticHazards}));
      await page.route('**/data-atmos/_catalog/**/tc-models/**',route=>{
        const path=new URL(route.request().url()).pathname,digest=path.match(/tracks\/([a-f0-9]{64})\.json$/)?.[1];
        const item=digest?fixture.tracks.get(digest):path===fixture.selection.manifestPath?{bytes:fixture.manifestBytes}:null;
        if(!item)return route.fulfill({status:404,body:'missing'});if(digest)trackRequests++;verified.add(path);
        return route.fulfill({status:200,body:item.bytes,contentType:'application/json',headers:{'x-weatherx-catalog':fixture.selection.catalogId,'x-weatherx-data-source':'own'}});
      });
      await page.goto(`${env.BASE}/lab?devprobes=1&lat=${gfs.points[0].lat}&lon=${gfs.points[0].lon}&z=4`,{waitUntil:'domcontentloaded'});
      await page.waitForFunction(()=>window.__atmos?.store&&window.__map?.isStyleLoaded(),null,{timeout:60000});
      const recovery=page.getByRole('button',{name:/^(?:Continue to map|继续看地图)$/});await recovery.waitFor({state:'visible',timeout:30000});await recovery.click();
      // HurricaneHost intentionally waits for the general weather canvas to be
      // marked lit. This data-plane-free proof has just exercised the truthful
      // recovery card, so arm only that local mount signal; the full application
      // and Weather Lab release gates run separately before this step.
      await page.evaluate(()=>document.body.classList.add('wl-lit'));
      await page.evaluate(({cursor,lon,lat})=>{const store=window.__atmos.store;store.getState().setLayerVisible('hazards',true);store.getState().setLayerVisible('hurricanes',true);store.setState({cursorMs:cursor});window.__map.jumpTo({center:[lon,lat],zoom:4});}, {cursor:Date.parse(gfs.points[Math.min(1,gfs.points.length-1)].validAt),lon:gfs.points[0].lon,lat:gfs.points[0].lat});
      await page.waitForFunction(()=>!window.__map.isMoving());
      await page.locator('.rp-row').filter({hasText:firstStorm.name}).click({timeout:30000});await page.locator('[data-model="gfs"]').waitFor({timeout:30000});
      await page.locator('[data-model="gfs"]').click();await page.waitForFunction(()=>window.__map.getStyle().layers.some(layer=>layer.id.startsWith('tc-model-gfs-')));
      const gfsValues=await page.locator('.tc-model-values').innerText();await page.locator('[data-model="ecmwf"]').click();
      await page.waitForFunction(()=>window.__map.getStyle().layers.some(layer=>layer.id.startsWith('tc-model-ecmwf-')));assert.notEqual(await page.locator('.tc-model-values').innerText(),gfsValues);
      const ecmwfRef=firstStorm.tracks.find(row=>row.model==='ecmwf');assert.ok(ecmwfRef,'reviewed ECMWF track required');
      assert.ok(verified.has(fixture.selection.manifestPath));assert.ok(verified.has(fixture.selection.manifestPath.replace('manifest.json',gfsRef.path)));
      assert.ok(verified.has(fixture.selection.manifestPath.replace('manifest.json',ecmwfRef.path)));
      assert.ok([...verified].every(path=>path.startsWith(`/data-atmos/_catalog/${fixture.selection.catalogId}/tc-models/`)),'unpinned TC fixture request');
      assert.equal(errors.length,0,errors.join('\n'));assert.ok(trackRequests>=2);results.push({...viewport,models:['gfs','ecmwf'],pinnedTrackRequests:trackRequests});await context.close();
    }
  }catch(error){if(active&&!active.isClosed())console.error((await active.locator('body').innerText()).slice(0,4000));throw error;}
  finally{await browser.close();}
  const receipt={schemaVersion:1,kind:'weatherx-isolated-tc-ui-proof-v1',qualificationScope:'loopback-build-only-nonpromotable',sourceSha:env.UI_EXPECTED_SOURCE_SHA,releaseId:env.WEATHERX_EXPECTED_RELEASE_ID,controllerSha:TC_CONTROL_SHA,selectionSha256:TC_SELECTION_SHA256,fixtureInventorySha256:fixture.inventorySha256,qualifiedAt:new Date().toISOString(),cloudWrites:0,sharedStagingDeploy:false,viewports:results};
  const bytes=Buffer.from(JSON.stringify(receipt));validateTcProofBytes(bytes,{sourceSha:receipt.sourceSha,releaseId:receipt.releaseId,fixtureInventorySha256:fixture.inventorySha256});writeFileSync(env.UI_TC_PROOF_OUTPUT,bytes,{flag:'wx',mode:0o600});return receipt;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  runTcProof().then(receipt=>console.log(JSON.stringify(receipt))).catch(error=>{console.error(error);process.exitCode=1;});
}
