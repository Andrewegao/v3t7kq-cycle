import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {authenticateCatalog,authenticateRelease,mountPreflight,verifySuccessor,candidatesFor,inventoryDigest,validateStagedManifest,refreshBaseline,readPublicAliases,FEEDS,SOURCE}
  from '../tools/five-feed-recovery.mjs';

const digest=b=>createHash('sha256').update(b).digest('hex');
const bytes=o=>Buffer.from(JSON.stringify(o));
const timestamp='2026-10-06T16:00:00.000Z';
function catalog() {
  const c={schemaVersion:2,sequence:9,parentCatalogId:'older',createdAt:timestamp,rollbackEpoch:3,components:{
    gfs:{componentId:'gfs',manifestKey:'components/gfs/real/component.json',manifestSha256:'a'.repeat(64),mounts:['data/gfs/']}}};
  const p={schemaVersion:2,catalogId:'original',sequence:9,previousCatalogId:'older',publishedAt:timestamp,catalogSha256:digest(bytes(c))};
  return {p,c};
}
function release() {
  const m={schemaVersion:1,releaseId:'real-whole',createdAt:timestamp,objectCount:1,
    objects:[{path:'data-atmos/stations/metar.json',bytes:15,sha256:'b'.repeat(64)}]};
  const p={schemaVersion:1,releaseId:'real-whole',objectCount:1,manifestSha256:digest(bytes(m))};
  return {p,m};
}
test('catalog and whole fallback authenticate bytes and envelope before mount admission',()=>{
  const {p,c}=catalog();assert.deepEqual(authenticateCatalog(p,bytes(c)),c);
  assert.throws(()=>authenticateCatalog(p,bytes({...c,rollbackEpoch:4})));
  const altered={...c,sequence:10};assert.throws(()=>authenticateCatalog({...p,catalogSha256:digest(bytes(altered))},bytes(altered)));
  const r=release();assert.deepEqual(authenticateRelease(r.p,bytes(r.m)),r.m);
  assert.throws(()=>authenticateRelease(r.p,bytes({...r.m,releaseId:'forged'})));
  const duplicate={...r.m,objectCount:2,objects:[...r.m.objects,...r.m.objects]};
  assert.throws(()=>authenticateRelease({...r.p,objectCount:2,manifestSha256:digest(bytes(duplicate))},bytes(duplicate)));
});
test('a five-feed mount cannot hide a whole fallback sibling or overlapping component',()=>{
  const {c}=catalog(),{m}=release();mountPreflight(c,m);
  for (const path of ['data-atmos/stations/airport-roster.json','data-atmos/openaq/config.json','data-atmos/fires/unrelated.json']) {
    assert.throws(()=>mountPreflight(c,{...m,objects:[...m.objects,{path}]}));
  }
  for (const mount of ['data-atmos/','data-atmos/stations/','data-atmos/stations/subdir/']) {
    assert.throws(()=>mountPreflight({...c,components:{...c.components,other:{mounts:[mount]}}},m));
  }
  mountPreflight({...c,components:{...c.components,'obs-metar':{mounts:['data-atmos/stations/']}}},m);
  assert.throws(()=>mountPreflight({...c,components:{...c.components,'obs-metar':{mounts:['data-atmos/']}}},m));
});
test('five candidates bind each original component hash and the rollback epoch',()=>{
  const {p,c}=catalog();const baseline={pointer:p,catalog:c};
  const receipt={families:Object.fromEntries(Object.keys(FEEDS).map(f=>[f,{}]))};
  const source=Object.fromEntries(Object.keys(FEEDS).map(f=>[f,{manifestKey:`components/obs-${f}/new/component.json`,
    manifestSha256:'c'.repeat(64),expectedPreviousManifestSha256:null,expectedRollbackEpoch:3}]));
  assert.equal(candidatesFor(baseline,receipt,source).length,5);
  const absent=structuredClone(receipt);delete absent.families.buoys;assert.throws(()=>candidatesFor(baseline,absent,source));
  for(const mutation of [s=>delete s.fires,s=>s.metar.expectedRollbackEpoch=4,s=>s.synop.expectedPreviousManifestSha256='d'.repeat(64),
    s=>s.openaq.manifestKey='components/gfs/wrong/component.json',s=>s.fires.manifestKey='components/obs-fires/new/not-component.json']){
    const copy=structuredClone(source);mutation(copy);assert.throws(()=>candidatesFor(baseline,receipt,copy));
  }
});
test('one atomic successor replaces five components and preserves every unrelated component',()=>{
  const {c}=catalog();const before={...c,catalogId:'original'};
  const candidates=Object.keys(FEEDS).map(f=>({manifestKey:`components/obs-${f}/new/component.json`,manifestSha256:'c'.repeat(64)}));
  const after={...c,sequence:10,parentCatalogId:'original',components:{...c.components,...Object.fromEntries(candidates.map(row=>
    [row.manifestKey.split('/')[1],{...row}]))}};
  verifySuccessor(before,after,candidates);
  for(const mutate of [v=>v.sequence=14,v=>v.rollbackEpoch=4,v=>v.components.gfs.manifestSha256='e'.repeat(64),
    v=>delete v.components.gfs,v=>delete v.components['obs-fires'],v=>v.components['obs-buoys'].manifestSha256='f'.repeat(64)]) {
    const copy=structuredClone(after);mutate(copy);assert.throws(()=>verifySuccessor(before,copy,candidates));
  }
  assert.throws(()=>verifySuccessor(before,after,candidates.slice(0,4)));
});
test('manual workflow owns one existing lock, fixed source, scoped key, and stage then atomic promote-set',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/five-feed-recovery.yml',import.meta.url),'utf8');
  const helper=readFileSync(new URL('../tools/five-feed-recovery.mjs',import.meta.url),'utf8');
  assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/schedule:|workflow_call:/);
  assert.match(workflow,/group: weatherx-data-maintenance\n\s+cancel-in-progress: false/);
  assert.match(workflow,/timeout-minutes: 60/);assert.match(workflow,/runs-on: ubuntu-24.04/);
  assert.match(workflow,/--require-hashes --only-binary=:all:/);assert.match(workflow,new RegExp(SOURCE));
  const collect=workflow.split('      - name: Collect all five')[1].split('      - name:')[0];
  assert.match(collect,/OPENAQ_API_KEY/);assert.doesNotMatch(collect,/R2_|CATALOG_PROMOTION_KEY|DEPLOY_KEY/);
  assert.equal((workflow.match(/OPENAQ_API_KEY:/g)||[]).length,1);
  assert.match(helper,/PROMOTE:'0'/);assert.match(helper,/'promote-set'/);
  assert.match(helper,/fsyncSync\(fd\)/);assert.match(helper,/target-predecessor-changed/);assert.match(helper,/promotion-baseline.json/);
  assert.match(helper,/whole-release-pointer-changed/);assert.match(helper,/public-alias-hash/);
  assert.doesNotMatch(workflow,/npm ci|chromium|playwright|bake_model_inputs|fetch\.py|wrangler|promote-release/);
});

test('immutable staged manifest binds exact run artifact, unchanged publisher ordering, bytes and checks',()=>{
  const files=[{path:'tiles/2_9.json',size:2,sha256:'b'.repeat(64)},
    {path:'index.json',size:1,sha256:'a'.repeat(64)},{path:'tiles/10_9.json',size:3,sha256:'c'.repeat(64)}];
  const receipt={generationTime:timestamp,files};const artifact='obs-fires-123-1';
  const manifest={schemaVersion:1,componentId:'obs-fires',artifactId:artifact,rootPrefix:`components/obs-fires/${artifact}/`,
    mounts:[FEEDS.fires],generationTime:timestamp,objectCount:3,inventorySha256:inventoryDigest(files),
    quality:{status:'passed',checks:['manifest','inventory','remote_bytes','native_schema','fresh_records','source_identity','mount_inventory']}};
  const candidate={manifestKey:`components/obs-fires/${artifact}/component.json`,manifestSha256:digest(bytes(manifest))};
  validateStagedManifest('fires',candidate,bytes(manifest),receipt,artifact);
  assert.equal(inventoryDigest(files),inventoryDigest([...files].reverse()));
  for (const mutate of [m=>m.artifactId='other',m=>m.mounts=['data-atmos/'],m=>m.objectCount=4,
    m=>m.generationTime='2026-10-05T16:00:00.000Z',m=>m.quality.checks=['manifest'],m=>m.inventorySha256='f'.repeat(64)]) {
    const copy=structuredClone(manifest);mutate(copy);
    assert.throws(()=>validateStagedManifest('fires',{...candidate,manifestSha256:digest(bytes(copy))},bytes(copy),receipt,artifact));
  }
  assert.throws(()=>validateStagedManifest('fires',candidate,bytes({...manifest,componentId:'gfs'}),receipt,artifact));
});

test('fresh authenticated baseline accepts unrelated model changes but retains five-target and epoch boundaries',()=>{
  const {p,c}=catalog(),r=release();const original={pointer:p,catalog:c,releasePointer:r.p};
  const current=structuredClone(original);current.catalog.sequence++;current.catalog.components.gfs.manifestSha256='b'.repeat(64);
  current.pointer.catalogId='new-model';current.releasePointer.releaseId='new-whole-during-collection';
  assert.equal(refreshBaseline(original,current),current);
  const staged=structuredClone(current),promotion=structuredClone(current);promotion.catalog.sequence++;
  promotion.catalog.components.gfs.manifestSha256='c'.repeat(64);refreshBaseline(original,promotion,staged);
  for(const mutate of [v=>v.catalog.rollbackEpoch++,v=>v.catalog.components['obs-metar']={manifestSha256:'a'.repeat(64)},
    v=>v.releasePointer.releaseId='changed-during-stage']) {
    const copy=structuredClone(promotion);mutate(copy);assert.throws(()=>refreshBaseline(original,copy,staged));
  }
  const originalWithTarget=structuredClone(original);originalWithTarget.catalog.components['obs-metar']={manifestSha256:'a'.repeat(64),mounts:[FEEDS.metar]};
  const changed=structuredClone(originalWithTarget);changed.catalog.components['obs-metar'].mounts=['data-atmos/'];
  assert.throws(()=>refreshBaseline(originalWithTarget,changed));
});

test('all public bytes on both genuine origins are checked with at most three active GETs',async()=>{
  const payload=Buffer.from('exact immutable public object'),hash=digest(payload);
  const receipt={families:Object.fromEntries(Object.keys(FEEDS).map(f=>[f,{files:[{path:f==='metar'?'metar.json':f==='fires'?'index.json':'stations.json',size:payload.length,sha256:hash}]}]))};
  const original=globalThis.fetch;let active=0,maximum=0,requests=0;
  globalThis.fetch=async(url)=>{
    requests++;assert.ok(url.startsWith('https://weatherx.org/data-atmos/')||url.startsWith('https://staging.weatherx.org/data-atmos/'));
    active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,2));
    return {ok:true,body:{getReader:()=>{let sent=false;return {read:async()=>sent?{done:true}:(sent=true,active--,{done:false,value:payload}),releaseLock(){},cancel:async()=>{}};}}};
  };
  try {
    const rows=await readPublicAliases(receipt,Date.now()+18*60*1000);assert.equal(rows.length,10);assert.equal(requests,10);assert.ok(maximum<=3);
    const altered=structuredClone(receipt);altered.families.metar.files[0].sha256='f'.repeat(64);
    await assert.rejects(()=>readPublicAliases(altered,Date.now()+18*60*1000));
    await assert.rejects(()=>readPublicAliases(receipt,Date.now()));
  } finally {globalThis.fetch=original;}
});
