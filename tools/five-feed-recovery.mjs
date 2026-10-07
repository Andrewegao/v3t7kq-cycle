#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, existsSync, openSync, fsyncSync, closeSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// The single production producer declaration shared with every ordinary data workflow.
export const SOURCE = JSON.parse(readFileSync(new URL('../ops/atmos-production-source.json', import.meta.url), 'utf8')).atmosSha;
const WORKFLOW_PREFIX = 'Andrewegao/v3t7kq-cycle/.github/workflows/';
// recovery: manual, literal confirmation, all five families or nothing (original contract).
// scheduled: unattended; each admitted family publishes on its own and a refused family keeps
// its served component. Every mode keeps the same CAS, staging, lock and readback guarantees.
// A workflow_dispatch needs the literal confirmation, except the component-bake chain caller,
// which only scheduled mode accepts (its run id is verified by the lane's plan job).
export const CONFIRMATION = 'RECOVER FIVE OBSERVATION FEEDS';
export const CHAIN_CALLER = 'component-bake-chain';
export const MODES = Object.freeze({
  recovery: Object.freeze({events: ['workflow_dispatch'], workflowRef: `${WORKFLOW_PREFIX}five-feed-recovery.yml@refs/heads/main`, allFive: true, chain: false}),
  scheduled: Object.freeze({events: ['schedule', 'workflow_dispatch'], workflowRef: `${WORKFLOW_PREFIX}observation-refresh.yml@refs/heads/main`, allFive: false, chain: true}),
});
export function dispatchAdmitted(mode, inputs) {
  if (!object(inputs)) return false;
  if (inputs.caller === CHAIN_CALLER) return MODES[mode]?.chain === true && /^[1-9][0-9]{0,19}$/.test(inputs.chain_run_id ?? '');
  return inputs.confirmation === CONFIRMATION;
}
export const FEEDS = Object.freeze({metar:'data-atmos/stations/',synop:'data-atmos/synop/',
  buoys:'data-atmos/buoys/',openaq:'data-atmos/openaq/',fires:'data-atmos/fires/'});
const DATA = 'weatherx:weatherx-data-production';
const COMPONENTS = 'weatherx:weatherx-components-production';
const ENDPOINT = 'https://weatherx.org/api/platform/internal/catalog';
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encoded = value => Buffer.from(JSON.stringify(value));
class ControllerError extends Error {}
const fail = (ok, code) => { if (!ok) throw new ControllerError(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const safePath = path => typeof path === 'string' && path.length <= 1024 &&
  !path.includes('\\') && !path.startsWith('/') && path.split('/').every(p=>p && p!=='.' && p!=='..');
const allowed = (family, path) => family === 'fires'
  ? ['fires.json','index.json','overview.json'].includes(path) || /^tiles\/(?:[0-9]|[12][0-9]|3[0-5])_(?:[0-9]|1[0-7])\.json$/.test(path)
  : path === (family === 'metar' ? 'metar.json' : 'stations.json');
const json = bytes => JSON.parse(bytes.toString('utf8'));
// Match the unchanged publisher's directory traversal and JSON property order.
export const inventoryDigest = files => sha(encoded(files.map(({path,size,sha256})=>({path,size,sha256}))
  .sort((a,b)=>a.path.localeCompare(b.path))));
export function admittedFamilies(receipt, mode = 'recovery') {
  const families=Object.keys(receipt?.families??{});
  fail(Object.hasOwn(MODES,mode) && (receipt?.mode??'recovery')===mode && families.length>0 &&
    families.every(family=>Object.hasOwn(FEEDS,family)) &&
    (!MODES[mode].allFive || families.length===Object.keys(FEEDS).length),'all-five-collection-required');
  return Object.keys(FEEDS).filter(family=>families.includes(family));
}
export function validateStagedManifest(family, candidate, bytes, receipt, artifactId) {
  const manifest=json(bytes),mount=FEEDS[family];
  fail(mount && ID.test(artifactId??'') && candidate.manifestKey===`components/obs-${family}/${artifactId}/component.json` &&
    sha(bytes)===candidate.manifestSha256 && manifest.schemaVersion===1 && manifest.componentId===`obs-${family}` &&
    manifest.artifactId===artifactId && manifest.rootPrefix===`components/obs-${family}/${artifactId}/` &&
    manifest.mounts?.length===1 && manifest.mounts[0]===mount &&
    manifest.generationTime===new Date(receipt.generationTime).toISOString() && manifest.quality?.status==='passed' &&
    ['manifest','inventory','remote_bytes','native_schema','fresh_records','source_identity','mount_inventory']
      .every(check=>manifest.quality.checks?.includes(check)) &&
    manifest.objectCount===receipt.files.length && manifest.inventorySha256===inventoryDigest(receipt.files),
    'immutable-staged-manifest-readback');
  return manifest;
}

export function authenticateCatalog(pointer, bytes) {
  fail(pointer?.schemaVersion===2 && ID.test(pointer.catalogId??'') && HASH.test(pointer.catalogSha256??'') &&
    Number.isSafeInteger(pointer.sequence) && pointer.sequence>0 && sha(bytes)===pointer.catalogSha256, 'catalog-pointer-hash');
  const catalog=json(bytes);
  fail(catalog?.schemaVersion===2 && catalog.sequence===pointer.sequence && catalog.createdAt===pointer.publishedAt &&
    catalog.parentCatalogId===pointer.previousCatalogId && (catalog.rollbackOfCatalogId??null)===(pointer.rollbackOfCatalogId??null) &&
    Number.isSafeInteger(catalog.rollbackEpoch??0) && (catalog.rollbackEpoch??0)>=0 && object(catalog.components) &&
    Object.keys(catalog.components).length<=128, 'catalog-envelope');
  for (const [id,c] of Object.entries(catalog.components)) {
    fail(ID.test(id) && object(c) && c.componentId===id && HASH.test(c.manifestSha256??'') &&
      safePath(c.manifestKey) && Array.isArray(c.mounts) && c.mounts.length>0, 'catalog-component');
  }
  return catalog;
}

export function authenticateRelease(pointer, bytes) {
  const manifest=json(bytes);
  fail(pointer?.schemaVersion===1 && ID.test(pointer.releaseId??'') && HASH.test(pointer.manifestSha256??'') &&
    sha(encoded(manifest))===pointer.manifestSha256 && manifest.schemaVersion===1 &&
    manifest.releaseId===pointer.releaseId && Number.isSafeInteger(pointer.objectCount) && pointer.objectCount>0 &&
    manifest.objectCount===pointer.objectCount && Array.isArray(manifest.objects) &&
    manifest.objects.length===pointer.objectCount && pointer.objectCount<=200000, 'whole-release-authentication');
  const paths=new Set();
  for (const row of manifest.objects) {
    fail(safePath(row.path) && !paths.has(row.path) && HASH.test(row.sha256??'') &&
      Number.isSafeInteger(row.bytes) && row.bytes>=0, 'whole-release-inventory');paths.add(row.path);
  }
  return manifest;
}

export function mountPreflight(catalog, manifest) {
  for (const [family,mount] of Object.entries(FEEDS)) {
    for (const row of manifest.objects.filter(r=>r.path.startsWith(mount))) {
      fail(allowed(family,row.path.slice(mount.length)), 'whole-release-mount-shadow');
    }
    for (const [id,c] of Object.entries(catalog.components)) {
      for (const active of c.mounts) {
        fail(typeof active==='string' && active.endsWith('/') && safePath(active.slice(0,-1)), 'active-mount');
        if (active.startsWith(mount) || mount.startsWith(active)) {
          fail(id===`obs-${family}` && c.mounts.length===1 && active===mount, 'catalog-mount-shadow');
        }
      }
    }
  }
}

export function refreshBaseline(original, current, staged = null) {
  fail((current.catalog.rollbackEpoch??0)===(original.catalog.rollbackEpoch??0),'target-rollback-epoch-changed');
  for (const family of Object.keys(FEEDS)) assert.deepEqual(current.catalog.components[`obs-${family}`]??null,
    original.catalog.components[`obs-${family}`]??null,'target-predecessor-changed');
  if (staged) assert.deepEqual(current.releasePointer,staged.releasePointer,'whole-release-changed-during-stage');
  return current;
}

export function verifySuccessor(before, after, candidates, families = Object.keys(FEEDS)) {
  fail(after.sequence===before.sequence+1 && after.parentCatalogId===before.catalogId &&
    (after.rollbackEpoch??0)===(before.rollbackEpoch??0), 'atomic-five-catalog-envelope');
  fail(families.length>0 && families.every(family=>Object.hasOwn(FEEDS,family)),'admitted-family-set');
  // Only admitted targets may change; a refused family's served component is unrelated here.
  const ids=families.map(f=>`obs-${f}`);
  assert.deepEqual(Object.keys(after.components).filter(id=>!ids.includes(id)).sort(),
    Object.keys(before.components).filter(id=>!ids.includes(id)).sort(), 'unrelated-component-set-changed');
  for (const [id,c] of Object.entries(before.components)) if (!ids.includes(id)) assert.deepEqual(after.components[id],c);
  fail(candidates.length===ids.length && new Set(candidates.map(c=>c.manifestKey)).size===ids.length,'exact-five-candidates');
  for (const candidate of candidates) {
    const id=candidate.manifestKey.split('/')[1];
    fail(ids.includes(id) && after.components[id]?.manifestKey===candidate.manifestKey &&
      after.components[id]?.manifestSha256===candidate.manifestSha256,'five-component-readback');
  }
}

// Scheduled readback runs while the hourly component bake and the whole bake keep promoting
// unrelated models and releases. It accepts those advances and proves only what this lane owns:
// every admitted obs-* entry is exactly this run's candidate, every refused family's entry is the
// predecessor it left, and the rollback epoch is unchanged. snapshot() re-runs the whole-release
// mount-shadow preflight, so an advanced release still cannot place files under an obs mount.
// Manual recovery keeps the strict single-successor, unchanged-release rule.
export function verifyScheduledReadback(before, after, candidates, families) {
  fail(Number.isSafeInteger(after.sequence) && after.sequence>=before.sequence+1 &&
    (after.rollbackEpoch??0)===(before.rollbackEpoch??0),'scheduled-successor-envelope');
  fail(families.length>0 && families.every(family=>Object.hasOwn(FEEDS,family)) &&
    candidates.length===families.length && new Set(candidates.map(c=>c.manifestKey)).size===families.length,'exact-five-candidates');
  for (const family of Object.keys(FEEDS)) {
    const id=`obs-${family}`;
    if (families.includes(family)) {
      const candidate=candidates.find(row=>row.manifestKey?.split('/')[1]===id);
      fail(candidate && after.components[id]?.manifestKey===candidate.manifestKey &&
        after.components[id]?.manifestSha256===candidate.manifestSha256,'five-component-readback');
    } else assert.deepEqual(after.components[id]??null,before.components[id]??null,'retained-target-changed');
  }
}
export function verifyStableTargets(mode, after, final) {
  if (mode!=='scheduled') {assert.deepEqual(final,after,'catalog-changed-during-readback');return;}
  fail((final.catalog.rollbackEpoch??0)===(after.catalog.rollbackEpoch??0),'catalog-changed-during-readback');
  for (const family of Object.keys(FEEDS)) assert.deepEqual(final.catalog.components[`obs-${family}`]??null,
    after.catalog.components[`obs-${family}`]??null,'catalog-changed-during-readback');
}

function run(command,args,env=process.env,timeout=60000,maxBuffer=1024**2) {
  const r=spawnSync('timeout',['--signal=TERM','--kill-after=5s',`${Math.ceil(timeout/1000)}s`,command,...args],
    {env,timeout:timeout+10000,maxBuffer,encoding:null});
  fail(!r.error && r.status===0,'bounded-command-refused');return r.stdout;
}
function r2(key,remote=DATA,cap=64*1024**2) {
  fail(safePath(key),'r2-key');
  const bytes=run('rclone',['cat',`${remote}/${key}`,'--s3-no-check-bucket','--retries','1','--low-level-retries','1',
    '--contimeout','15s','--timeout','30s'],process.env,60000,cap+1);
  fail(bytes.length>0 && bytes.length<=cap,'r2-object-bound');return bytes;
}
const save = (path,value) => {const fd=openSync(path,'wx');try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}};
const load = path => json(readFileSync(path));

function snapshot(fullInventory=true) {
  const targets={};
  const pointer=json(r2('catalogs/current.json',DATA,1024**2));
  const catalog=authenticateCatalog(pointer,r2(`catalogs/snapshots/${pointer.catalogId}.json`,DATA,4*1024**2));
  const releasePointer=json(r2('releases/current.json',DATA,1024**2));
  const manifest=authenticateRelease(releasePointer,r2(`releases/${releasePointer.releaseId}/manifest.json`));
  mountPreflight(catalog,manifest);
  for (const [family,mount] of Object.entries(FEEDS)) {
    const descriptor=catalog.components[`obs-${family}`];
    if (!descriptor) continue;
    const bytes=r2(descriptor.manifestKey,COMPONENTS,1024**2);const component=json(bytes);
    fail(sha(bytes)===descriptor.manifestSha256 && component.schemaVersion===1 &&
      descriptor.manifestKey===`${component.rootPrefix}component.json` && component.componentId===`obs-${family}` && component.rootPrefix===`components/obs-${family}/${component.artifactId}/` &&
      ID.test(component.artifactId??'') && component.mounts?.length===1 && component.mounts[0]===mount &&
      component.quality?.status==='passed' && Number.isSafeInteger(component.objectCount) &&
      component.objectCount>0 && component.objectCount<=651 && HASH.test(component.inventorySha256??''),'predecessor-component-auth');
    // Served bake time of the authenticated predecessor; reported when a family is refused.
    targets[family]={generationTime:typeof component.generationTime==='string'?component.generationTime:null};
    // The authenticated schema-1 manifest commits the previous immutable bytes. Mount-shadow
    // admission needs the full remote path inventory, not repeated downloads of old payloads.
    if (fullInventory) {
      const names=run('rclone',['lsf',`${COMPONENTS}/${component.rootPrefix}`,'--recursive','--files-only',
        '--s3-no-check-bucket','--retries','1','--low-level-retries','1'],process.env,60000,1024**2)
        .toString('utf8').trim().split('\n').filter(p=>p!=='component.json');
      fail(names.length===component.objectCount && new Set(names).size===names.length && names.every(p=>allowed(family,p)),
        'predecessor-mount-inventory');
    }
  }
  return {schemaVersion:1,pointer,catalog,releasePointer,releaseManifestSha256:releasePointer.manifestSha256,targets};
}

function pristine(atmos) {
  fail(run('git',['-C',atmos,'rev-parse','HEAD']).toString('utf8').trim()===SOURCE,'exact-producer-source');
  const paths=run('git',['-C',atmos,'ls-tree','-r','--name-only',SOURCE,'--','data','ops/platform']).toString('utf8').trim().split('\n')
    .filter(p=>/\.(?:py|mjs|sh|lock|txt)$/.test(p));
  fail(paths.length>0,'producer-closure-required');
  run('git',['-C',atmos,'diff','--exit-code','HEAD','--',...paths]);
}

export function candidatesFor(baseline, receipt, sourceReceipts, mode = 'recovery') {
  const families=admittedFamilies(receipt,mode);
  fail(Object.keys(sourceReceipts).sort().join()===[...families].sort().join(),'exact-five-candidate-families');
  return families.map(family=>{
    const candidate=sourceReceipts[family];const previous=baseline.catalog.components[`obs-${family}`];
    fail(candidate && safePath(candidate.manifestKey) && new RegExp(`^components/obs-${family}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}/component\\.json$`).test(candidate.manifestKey) &&
      HASH.test(candidate.manifestSha256??'') && candidate.expectedPreviousManifestSha256===(previous?.manifestSha256??null) &&
      candidate.expectedRollbackEpoch===(baseline.catalog.rollbackEpoch??0),'five-exact-preconditions');
    return candidate;
  });
}

function verifyCollected(atmos,stage,mode) {
  pristine(atmos);
  return json(run(join(atmos,'data/.venv/bin/python'),[fileURLToPath(new URL('./five-feed-collect.py',import.meta.url)),
    'verify',atmos,stage,'--mode',mode],baseEnv(),180000));
}
function baseEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k])=>['PATH','HOME','TMPDIR'].includes(k)));
}

export const CATALOG_CACHE_SETTLE_MS = 31_000;
export async function settleCatalogCache(publicationDeadline) {
  // The accepted reader caches a normal catalog pointer for30s independently of mutation.
  // Retain the existing eight-minute hash-readback budget and one-minute final-state reserve.
  const readbackReserve=9*60*1000;
  fail(Number.isSafeInteger(publicationDeadline) &&
    publicationDeadline>Date.now()+CATALOG_CACHE_SETTLE_MS+readbackReserve,'catalog-cache-settle-budget');
  await new Promise(resolve=>setTimeout(resolve,CATALOG_CACHE_SETTLE_MS));
  fail(publicationDeadline>Date.now()+readbackReserve,'catalog-cache-settle-budget');
}

export async function readPublicAliases(receipt,publicationDeadline) {
  const publicObjects=[];
  const jobs=[];
  for (const [family,mount] of Object.entries(FEEDS)) for (const row of receipt.families[family]?.files??[])
    for (const origin of ['https://weatherx.org','https://staging.weatherx.org']) jobs.push({family,mount,row,origin});
  fail(jobs.length>0,'public-alias-set');
  const deadline=Math.min(Date.now()+8*60*1000,publicationDeadline-60000);
  fail(Number.isSafeInteger(deadline) && deadline>Date.now(),'public-readback-budget');
  const cancellation=new AbortController();
  let next=0;
  const worker=async()=>{
    while(next<jobs.length && !cancellation.signal.aborted) {
      const {family,mount,row,origin}=jobs[next++];
      fail(Date.now()<deadline,'public-alias-global-deadline');
      const response=await fetch(`${origin}/${mount}${row.path}`,{redirect:'error',
        signal:AbortSignal.any([cancellation.signal,AbortSignal.timeout(Math.min(20000,deadline-Date.now()))]),cache:'no-store'});
      fail(response.ok,'public-alias-status');const reader=response.body?.getReader();fail(reader,'public-alias-body');
      const hash=createHash('sha256');let total=0;
      try {while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;
        if(total>row.size){await reader.cancel();throw new Error('public-alias-size');}hash.update(value);}}
      finally {reader.releaseLock();}
      fail(total===row.size && hash.digest('hex')===row.sha256,'public-alias-hash');
      publicObjects.push({origin,family,path:mount+row.path,bytes:total,sha256:row.sha256});
    }
  };
  const outcomes=await Promise.allSettled(Array.from({length:3},()=>worker().catch(error=>{cancellation.abort();throw error;})));
  fail(outcomes.every(row=>row.status==='fulfilled') && publicObjects.length===jobs.length,'complete-public-alias-readback');
  publicObjects.sort((a,b)=>(a.origin+a.path).localeCompare(b.origin+b.path));
  return publicObjects;
}

export async function main(argv) {
  const [operation,atmosArg,workArg,stageArg]=argv;const atmos=resolve(atmosArg??'');const work=resolve(workArg??'');
  fail(['snapshot','stage','promote','readback'].includes(operation) && atmosArg && workArg,'controller-arguments');
  const mode=process.env.FIVE_FEED_MODE??'';
  fail(Object.hasOwn(MODES,mode) && process.env.GITHUB_REPOSITORY==='Andrewegao/v3t7kq-cycle' && process.env.GITHUB_REF==='refs/heads/main' &&
    MODES[mode].events.includes(process.env.GITHUB_EVENT_NAME) && process.env.APPROVED_SHA===SOURCE &&
    process.env.GITHUB_WORKFLOW_REF===MODES[mode].workflowRef &&
    /^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ID??'') && /^[1-9][0-9]*$/.test(process.env.GITHUB_RUN_ATTEMPT??''),'manual-approved-source');
  if (process.env.GITHUB_EVENT_NAME==='workflow_dispatch') {
    let inputs=null;try {inputs=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH??'','utf8')).inputs;} catch {inputs=null;}
    fail(dispatchAdmitted(mode,inputs),'manual-approved-source');
  }
  fail(process.env.CATALOG_ENDPOINT===ENDPOINT,'production-catalog-endpoint');
  pristine(atmos);
  if (operation==='snapshot') {fail(!existsSync(work),'fresh-state-directory');mkdirSync(work);save(join(work,'baseline.json'),snapshot());return;}
  const baseline=load(join(work,'baseline.json'));const stage=resolve(stageArg??'');fail(stageArg,'collection-stage-required');
  verifyCollected(atmos,stage,mode);const receipt=load(join(stage,'receipt.json'));const families=admittedFamilies(receipt,mode);
  if (operation==='stage') {
    const staged=refreshBaseline(baseline,snapshot());save(join(work,'stage-baseline.json'),staged);const sourceReceipts={};
    for (const family of families) {const mount=FEEDS[family];
      const path=join(work,`${family}-candidate.json`);const previous=baseline.catalog.components[`obs-${family}`];
      run('bash',[join(atmos,'ops/platform/publish-r2-component.sh')],{...process.env,SOURCE_DIR:join(stage,family),
        COMPONENT_ID:`obs-${family}`,MOUNT:mount,GENERATION_TIME:receipt.families[family].generationTime,
        ARTIFACT_ID:`obs-${family}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
        COMPONENT_R2_REMOTE:COMPONENTS,PROMOTE:'0',PACK_COMPONENT_OBJECTS:'0',DIRECT_SCHEMA1_CHECKSUM:'0',
        REUSE_COMPONENT_MANIFEST_KEY:'',REUSE_MAP_OBJECTS_MANIFEST_KEY:'',COMPONENT_RECEIPT_FILE:path,
        EXPECTED_COMPONENT_MANIFEST_SHA256:previous?.manifestSha256??'',
        EXPECTED_CATALOG_ROLLBACK_EPOCH:String(baseline.catalog.rollbackEpoch??0),
        COMPONENT_QUALITY_CHECKS:'native_schema,fresh_records,source_identity,mount_inventory'},600000);
      const candidate=load(path);
      validateStagedManifest(family,candidate,r2(candidate.manifestKey,COMPONENTS,1024**2),receipt.families[family],
        `obs-${family}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
      sourceReceipts[family]=candidate;
    }
    save(join(work,'candidates.json'),candidatesFor(baseline,receipt,sourceReceipts,mode));return;
  }
  const candidates=load(join(work,'candidates.json'));
  fail(Array.isArray(candidates) && candidates.length===families.length,'five-candidates-required');
  const candidateMap=Object.fromEntries(candidates.map(candidate=>[candidate.manifestKey?.split('/')[1]?.replace(/^obs-/,''),candidate]));
  assert.deepEqual(candidatesFor(baseline,receipt,candidateMap,mode),candidates,'five-candidate-binding');
  const retained=Object.keys(FEEDS).filter(family=>!families.includes(family));
  for (const family of families) validateStagedManifest(family,candidateMap[family],
    r2(candidateMap[family].manifestKey,COMPONENTS,1024**2),receipt.families[family],
    `obs-${family}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  if (operation==='promote') {
    const promotionBaseline=refreshBaseline(baseline,snapshot(),load(join(work,'stage-baseline.json')));
    verifyCollected(atmos,stage,mode);
    const publicationDeadline=Number(process.env.FIVE_FEED_PUBLICATION_DEADLINE_MS);
    fail(Number.isSafeInteger(publicationDeadline) && publicationDeadline>Date.now()+11*60*1000+CATALOG_CACHE_SETTLE_MS &&
      publicationDeadline<=Date.now()+18*60*1000,'readback-budget-required-before-promotion');
    save(join(work,'promotion-baseline.json'),promotionBaseline);
    save(join(work,'promotion-intent.json'),{operation:'promote-set',candidates,sourceSha:SOURCE,
      previousCatalogId:promotionBaseline.pointer.catalogId,previousRelease:promotionBaseline.releasePointer});
    save(join(work,'public-promotion-intent.json'),{schemaVersion:1,status:'requested',sourceSha:SOURCE,mode,retained,
      runId:process.env.GITHUB_RUN_ID,runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),
      previousCatalogId:promotionBaseline.pointer.catalogId,previousReleaseId:promotionBaseline.releasePointer.releaseId,
      rollbackEpoch:promotionBaseline.catalog.rollbackEpoch??0,
      components:Object.fromEntries(families.map(family=>[`obs-${family}`,{
        previousManifestSha256:baseline.catalog.components[`obs-${family}`]?.manifestSha256??null,
        candidateManifestSha256:candidateMap[family].manifestSha256}]))});
    const result=run('node',[join(atmos,'ops/platform/submit-catalog-mutation.mjs'),'promote-set',ENDPOINT,join(work,'candidates.json')],
      process.env,150000);save(join(work,'promotion-result.json'),json(result));
    save(join(work,'public-promotion-result.json'),{schemaVersion:1,status:'request-completed',sourceSha:SOURCE,
      runId:process.env.GITHUB_RUN_ID,runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT)});return;
  }
  fail(existsSync(join(work,'promotion-intent.json')) && existsSync(join(work,'promotion-result.json')),'acknowledged-promotion-required');
  const promotionBaseline=load(join(work,'promotion-baseline.json'));
  const after=snapshot();
  if (mode==='scheduled') verifyScheduledReadback(promotionBaseline.catalog,after.catalog,candidates,families);
  else {
    assert.deepEqual(after.releasePointer,promotionBaseline.releasePointer,'whole-release-pointer-changed');
    verifySuccessor({...promotionBaseline.catalog,catalogId:promotionBaseline.pointer.catalogId},after.catalog,candidates,families);
  }
  await settleCatalogCache(Number(process.env.FIVE_FEED_PUBLICATION_DEADLINE_MS));
  const publicObjects=await readPublicAliases(receipt,Number(process.env.FIVE_FEED_PUBLICATION_DEADLINE_MS));
  const qualified=verifyCollected(atmos,stage,mode);const final=snapshot(false);verifyStableTargets(mode,after,final);
  // A retained family still serves its authenticated predecessor; report that bake time, never relabel it.
  const retainedServed=Object.fromEntries(retained.map(family=>[family,{status:'retained',
    servedGenerationTime:after.targets?.[family]?.generationTime??null}]));
  save(join(work,'acceptance.json'),{schemaVersion:1,status:'passed',sourceSha:SOURCE,mode,retained:retainedServed,runId:process.env.GITHUB_RUN_ID,
    runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT),catalogId:after.pointer.catalogId,previousCatalogId:promotionBaseline.pointer.catalogId,
    previousReleaseId:promotionBaseline.releasePointer.releaseId,families:qualified,publicObjects});
}

if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{
    const stage=['snapshot','stage','promote','readback'].includes(process.argv[2])?process.argv[2]:'arguments';
    console.error(JSON.stringify({status:'refused',stage,code:error instanceof ControllerError?error.message:
      error?.code==='ERR_ASSERTION'?'baseline-or-successor-mismatch':'invalid-or-unavailable-state'}));process.exitCode=1;
  });
}
