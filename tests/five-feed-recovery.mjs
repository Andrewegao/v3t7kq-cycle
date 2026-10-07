import test from 'node:test';
import * as controller from '../tools/five-feed-recovery.mjs';
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
test('manual recovery is the observation refresh job in all-five mode behind its literal confirmation',()=>{
  const manual=readFileSync(new URL('../.github/workflows/five-feed-recovery.yml',import.meta.url),'utf8');
  const lane=readFileSync(new URL('../.github/workflows/observation-refresh.yml',import.meta.url),'utf8');
  assert.match(manual,/workflow_dispatch:/);assert.doesNotMatch(manual,/^  (?:schedule|workflow_call):|uses: \.\//m);
  assert.deepEqual(manual.split('\njobs:\n')[1].match(/^  [a-z-]+:/gm),['  recover:']);
  const recover=manual.split('\n  recover:\n')[1];
  const refresh=lane.split('\n  refresh:\n')[1].split('\n').slice(2).join('\n');
  assert.equal(recover,refresh.replace('      FIVE_FEED_MODE: scheduled','      FIVE_FEED_MODE: recovery'),
    'the recovery job must stay byte-identical to the scheduled refresh job apart from its mode');
  assert.match(recover,/^      FIVE_FEED_MODE: recovery$/m);
  assert.match(recover,/CONFIRMATION="\$\(jq -r '\.inputs\.confirmation \/\/ ""' "\$GITHUB_EVENT_PATH"\)"/);
  assert.match(recover,/test "\$CONFIRMATION" = 'RECOVER FIVE OBSERVATION FEEDS'/);
  const source=recover.split('      - name: Require main')[1].split('      - name:')[0];
  assert.doesNotMatch(source,/secrets\./,'confirmation and source approval precede every credential');
});

test('observation lane owns its own lock, fixed source, scoped key, and stage then atomic promote-set',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/observation-refresh.yml',import.meta.url),'utf8');
  const helper=readFileSync(new URL('../tools/five-feed-recovery.mjs',import.meta.url),'utf8');
  assert.match(workflow,/schedule:\n(?:\s+#.*\n)*\s+- cron: '14,44 \* \* \* \*'/);
  assert.doesNotMatch(workflow,/workflow_call:/);
  const plan=workflow.split('\n  plan:\n')[1].split('\n  refresh:\n')[0];
  assert.doesNotMatch(plan,/environment:|concurrency:|secrets\.|: write/);
  assert.match(plan,/OBSERVATION_REFRESH_ENABLED/);assert.match(plan,/actions: read/);
  assert.match(plan,/run: node tools\/workflow-run-summary\.mjs observation-plan/);
  assert.match(workflow,/workflow_dispatch:\n    inputs:\n      confirmation:\n[\s\S]*?required: true/);
  const refresh=workflow.split('\n  refresh:\n')[1];
  assert.match(refresh,/environment: production/);
  assert.match(refresh,/group: weatherx-observation-components-production\n\s+cancel-in-progress: false/);
  assert.doesNotMatch(workflow,/group: weatherx-data-maintenance/);
  assert.match(refresh,/timeout-minutes: 60/);assert.match(refresh,/runs-on: ubuntu-24.04/);
  assert.match(refresh,/--require-hashes --only-binary=:all:/);
  assert.equal(workflow.split(SOURCE).length-1,2,'the declared producer source is pinned in exactly two places');
  assert.match(refresh,/test "\$APPROVED_SHA" = "\$ATMOS_SHA"/);assert.match(refresh,/test "\$ENABLED" = true/);
  for (const caller of ['"recovery:workflow_dispatch:Andrewegao/v3t7kq-cycle/.github/workflows/five-feed-recovery.yml@refs/heads/main"',
    '"scheduled:schedule:Andrewegao/v3t7kq-cycle/.github/workflows/observation-refresh.yml@refs/heads/main"',
    '"scheduled:workflow_dispatch:Andrewegao/v3t7kq-cycle/.github/workflows/observation-refresh.yml@refs/heads/main"'])
    assert.ok(refresh.includes(caller),caller);
  assert.match(refresh,/test "\$CONFIRMATION" = 'RECOVER FIVE OBSERVATION FEEDS'/);
  assert.match(refresh,/"scheduled:workflow_dispatch:[^"]+"\)\n\s+test "\$CONFIRMATION" = 'RECOVER FIVE OBSERVATION FEEDS' ;;/,
    'a manual dispatch of the scheduled lane needs the literal confirmation; the schedule does not');
  assert.match(refresh,/"scheduled:schedule:[^"]+"\) ;;/);
  const collect=refresh.split('      - name: Collect all five')[1].split('      - name:')[0];
  assert.match(collect,/OPENAQ_API_KEY/);assert.match(collect,/--mode "\$FIVE_FEED_MODE"/);
  assert.doesNotMatch(collect,/R2_|CATALOG_PROMOTION_KEY|DEPLOY_KEY/);
  assert.equal((workflow.match(/secrets\.OPENAQ_API_KEY/g)||[]).length,1);
  const order=['Collect all five','Stage verify atomic CAS','Report each family','Retain only aggregate'].map(name=>refresh.indexOf(name));
  assert.ok(order.every((at,i)=>at>0&&(i===0||at>order[i-1])),'verdict follows publication and precedes retention');
  const verdict=refresh.split('      - name: Report each family')[1].split('      - name:')[0];
  assert.match(verdict,/always\(\)/);assert.doesNotMatch(verdict,/secrets\.|continue-on-error/);
  assert.match(refresh,/observation-receipt\.json/);
  assert.match(helper,/PROMOTE:'0'/);assert.match(helper,/'promote-set'/);
  assert.match(helper,/fsyncSync\(fd\)/);assert.match(helper,/target-predecessor-changed/);assert.match(helper,/promotion-baseline.json/);
  assert.match(helper,/whole-release-pointer-changed/);assert.match(helper,/public-alias-hash/);
  assert.doesNotMatch(workflow,/npm ci|chromium|playwright|bake_model_inputs|fetch\.py|wrangler|promote-release/);
});

test('each mode is bound to exactly one caller workflow and event set before any credential use',async()=>{
  const saved={...process.env};
  const base={GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main',APPROVED_SHA:SOURCE,
    GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',CATALOG_ENDPOINT:'https://wrong.invalid'};
  const recovery='Andrewegao/v3t7kq-cycle/.github/workflows/five-feed-recovery.yml@refs/heads/main';
  const scheduled='Andrewegao/v3t7kq-cycle/.github/workflows/observation-refresh.yml@refs/heads/main';
  const attempt=async env=>{
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env,base,env);
    try {await controller.main(['snapshot','/nonexistent-atmos','/nonexistent-state']);return 'passed';}
    catch(error) {return error.message;}
  };
  try {
    for (const env of [{FIVE_FEED_MODE:'recovery',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:recovery},
      {FIVE_FEED_MODE:'scheduled',GITHUB_EVENT_NAME:'schedule',GITHUB_WORKFLOW_REF:scheduled},
      {FIVE_FEED_MODE:'scheduled',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:scheduled}])
      assert.equal(await attempt(env),'production-catalog-endpoint',JSON.stringify(env));
    for (const env of [{FIVE_FEED_MODE:'recovery',GITHUB_EVENT_NAME:'schedule',GITHUB_WORKFLOW_REF:recovery},
      {FIVE_FEED_MODE:'recovery',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:scheduled},
      {FIVE_FEED_MODE:'scheduled',GITHUB_EVENT_NAME:'schedule',GITHUB_WORKFLOW_REF:recovery},
      {FIVE_FEED_MODE:'scheduled',GITHUB_EVENT_NAME:'push',GITHUB_WORKFLOW_REF:scheduled},
      {FIVE_FEED_MODE:'',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_WORKFLOW_REF:recovery},
      {FIVE_FEED_MODE:'scheduled',GITHUB_EVENT_NAME:'schedule',GITHUB_WORKFLOW_REF:scheduled,APPROVED_SHA:'0'.repeat(40)}])
      assert.equal(await attempt(env),'manual-approved-source',JSON.stringify(env));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env,saved);
  }
});

test('scheduled mode publishes only admitted families and keeps every other component, recovery still needs five',()=>{
  const {p,c}=catalog();const baseline={pointer:p,catalog:c};
  const source=Object.fromEntries(['metar','openaq'].map(f=>[f,{manifestKey:`components/obs-${f}/new/component.json`,
    manifestSha256:'c'.repeat(64),expectedPreviousManifestSha256:null,expectedRollbackEpoch:3}]));
  const receipt={mode:'scheduled',families:{metar:{},openaq:{}}};
  assert.deepEqual(controller.admittedFamilies(receipt,'scheduled'),['metar','openaq']);
  assert.equal(candidatesFor(baseline,receipt,source,'scheduled').length,2);
  for (const [bad,mode] of [[receipt,'recovery'],[{...receipt,mode:'recovery'},'scheduled'],[{mode:'scheduled',families:{}},'scheduled'],
    [{mode:'scheduled',families:{metar:{},gfs:{}}},'scheduled'],[receipt,'unknown']])
    assert.throws(()=>controller.admittedFamilies(bad,mode),JSON.stringify([bad,mode]));
  const extra={...source,fires:{...source.metar,manifestKey:'components/obs-fires/new/component.json'}};
  assert.throws(()=>candidatesFor(baseline,receipt,extra,'scheduled'));
  const servedFire={componentId:'obs-fires',manifestKey:'components/obs-fires/old/component.json',manifestSha256:'d'.repeat(64),mounts:[FEEDS.fires]};
  const before={...c,catalogId:'original',components:{...c.components,'obs-fires':servedFire}};
  const candidates=Object.values(source);
  const after={...before,sequence:10,parentCatalogId:'original',components:{...before.components,
    ...Object.fromEntries(candidates.map(row=>[row.manifestKey.split('/')[1],{...row}]))}};
  delete after.catalogId;
  verifySuccessor(before,after,candidates,['metar','openaq']);
  assert.throws(()=>verifySuccessor(before,after,candidates),'all-five verification refuses a partial successor');
  const changedFire=structuredClone(after);changedFire.components['obs-fires'].manifestSha256='e'.repeat(64);
  assert.throws(()=>verifySuccessor(before,changedFire,candidates,['metar','openaq']),'a refused family must keep its served component');
  assert.throws(()=>verifySuccessor(before,after,candidates,['metar','openaq','fires']));
  assert.throws(()=>verifySuccessor(before,after,candidates,['gfs']));
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

test('fixed cache settling preserves stale-before refusal and exact current-after hashes',async()=>{
  const originalNow=Date.now,originalTimer=globalThis.setTimeout,originalFetch=globalThis.fetch;
  let now=Date.parse('2026-10-06T17:00:00Z'),requests=0;const cachedUntil=now+30000,deadline=now+18*60*1000,sleeps=[];
  const fresh=Buffer.from('fresh'),stale=Buffer.from('stale');
  const receipt={families:Object.fromEntries(Object.keys(FEEDS).map(f=>[f,{files:[{path:f==='metar'?'metar.json':f==='fires'?'index.json':'stations.json',size:fresh.length,sha256:digest(fresh)}]}]))};
  Date.now=()=>now;globalThis.setTimeout=(callback,ms)=>{sleeps.push(ms);now+=ms;queueMicrotask(callback);return 1;};
  globalThis.fetch=async()=>{requests++;return new Response(now<cachedUntil?stale:fresh);};
  try {
    await assert.rejects(()=>readPublicAliases(receipt,deadline),/complete-public-alias-readback/);
    await controller.settleCatalogCache(deadline);
    assert.deepEqual(sleeps,[31000]);assert.equal(now,cachedUntil+1000);
    assert.equal((await readPublicAliases(receipt,deadline)).length,10);
    const count=requests;
    await assert.rejects(()=>controller.settleCatalogCache(now+31000+9*60*1000),/catalog-cache-settle-budget/);
    assert.deepEqual(sleeps,[31000]);assert.equal(requests,count);
  } finally {Date.now=originalNow;globalThis.setTimeout=originalTimer;globalThis.fetch=originalFetch;}
});

test('cache settling refuses elapsed deadline and main keeps acknowledgement and successor before aliases',async()=>{
  const originalNow=Date.now,originalTimer=globalThis.setTimeout;let now=1000000;
  Date.now=()=>now;globalThis.setTimeout=(callback,ms)=>{assert.equal(ms,31000);now+=30*60*1000;queueMicrotask(callback);return 1;};
  try {await assert.rejects(()=>controller.settleCatalogCache(now+18*60*1000),/catalog-cache-settle-budget/);}
  finally {Date.now=originalNow;globalThis.setTimeout=originalTimer;}
  const helper=readFileSync(new URL('../tools/five-feed-recovery.mjs',import.meta.url),'utf8');
  const readback=helper.slice(helper.indexOf("fail(existsSync(join(work,'promotion-intent.json'))"));
  assert.match(readback,/existsSync\(join\(work,'promotion-result.json'\)\)/);
  assert.ok(readback.indexOf('verifySuccessor(')<readback.indexOf('await settleCatalogCache('));
  assert.ok(readback.indexOf('await settleCatalogCache(')<readback.indexOf('await readPublicAliases('));
  assert.match(readback,/verifyStableTargets\(mode,after,final\)/);
});

test('scheduled readback tolerates unrelated model and release promotions but never a changed obs target or epoch',()=>{
  const {c}=catalog();
  const servedFire={componentId:'obs-fires',manifestKey:'components/obs-fires/old/component.json',manifestSha256:'d'.repeat(64),mounts:[FEEDS.fires]};
  const before={...c,components:{...c.components,'obs-fires':servedFire}};
  const candidates=['metar','openaq'].map(f=>({manifestKey:`components/obs-${f}/obs-${f}-9-1/component.json`,manifestSha256:'c'.repeat(64)}));
  const ours={...before,sequence:10,parentCatalogId:'original',components:{...before.components,
    ...Object.fromEntries(candidates.map(row=>[row.manifestKey.split('/')[1],{...row}]))}};
  // Race: the hourly GFS component bake promoted twice after our promote-set landed.
  const raced=structuredClone(ours);raced.sequence=12;raced.parentCatalogId='gfs-11';raced.components.gfs.manifestSha256='f'.repeat(64);
  assert.throws(()=>verifySuccessor({...before,catalogId:'original'},raced,candidates,['metar','openaq']),'manual rule stays strict');
  controller.verifyScheduledReadback(before,raced,candidates,['metar','openaq']);
  for (const mutate of [v=>v.rollbackEpoch++,v=>v.sequence=9,v=>v.components['obs-metar'].manifestSha256='e'.repeat(64),
    v=>v.components['obs-fires'].manifestSha256='e'.repeat(64),v=>delete v.components['obs-openaq'],
    v=>v.components['obs-synop']={componentId:'obs-synop',manifestKey:'components/obs-synop/x/component.json',manifestSha256:'e'.repeat(64),mounts:[FEEDS.synop]}]) {
    const copy=structuredClone(raced);mutate(copy);assert.throws(()=>controller.verifyScheduledReadback(before,copy,candidates,['metar','openaq']));
  }
  // Final stability: unrelated advances and a new whole release during alias readback are accepted
  // in scheduled mode; any obs-* or epoch change is not. Manual mode keeps exact equality.
  const after={catalog:raced,releasePointer:{releaseId:'cycle-1'},pointer:{catalogId:'x'}};
  const final=structuredClone(after);final.catalog.sequence=13;final.catalog.components.gfs.manifestSha256='a'.repeat(64);
  final.releasePointer={releaseId:'cycle-2'};final.pointer.catalogId='y';
  controller.verifyStableTargets('scheduled',after,final);
  assert.throws(()=>controller.verifyStableTargets('recovery',after,final),/catalog-changed-during-readback/);
  for (const mutate of [v=>v.catalog.rollbackEpoch++,v=>v.catalog.components['obs-metar'].manifestSha256='9'.repeat(64)]) {
    const copy=structuredClone(final);mutate(copy);assert.throws(()=>controller.verifyStableTargets('scheduled',after,copy));
  }
  const helper=readFileSync(new URL('../tools/five-feed-recovery.mjs',import.meta.url),'utf8');
  const readback=helper.slice(helper.indexOf("fail(existsSync(join(work,'promotion-intent.json'))"));
  assert.match(readback,/if \(mode==='scheduled'\) verifyScheduledReadback/);
  assert.match(readback,/whole-release-pointer-changed/);assert.match(readback,/verifyStableTargets\(mode,after,final\)/);
});
