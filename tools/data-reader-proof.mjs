// Read-only acceptance of actual immutable production inputs by both proposed
// entrypoints. Freshness is reported honestly, not relaxed or called healthy.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { canonical } from './gdacs-feed-release.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b,label)=>assert.ok(canonical(a)===canonical(b),label);
const DATA='weatherx-data-production',COMPONENTS='weatherx-components-production';
const ORIGIN='https://weatherx.org';
export function pinnedMapUrl(catalogId,model){
  assert.match(catalogId,/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/);assert.ok(!catalogId.includes('..'));
  assert.ok(['ecmwf','gfs','hrrr','aifs'].includes(model));
  return `${ORIGIN}/data/_catalog/${catalogId}/${model}/index.json`;
}
export function verifyManifestHash(bytes,expected){
  // buildReleasePointer/releasePromotion commit JSON.stringify(parsed manifest),
  // not insignificant transport whitespace. Preserve both digests in the receipt.
  const parsed=JSON.parse(bytes),canonicalSha256=hash(JSON.stringify(parsed));
  assert.equal(canonicalSha256,expected,'whole manifest canonical hash mismatch');
  return {canonicalSha256,rawSha256:hash(bytes)};
}
function loader(){return registerHooks({
  resolve(specifier,context,next){if(specifier.startsWith('.')&&context.parentURL?.endsWith('.ts')&&existsSync(fileURLToPath(new URL(specifier+'.ts',context.parentURL))))return next(specifier+'.ts',context);return next(specifier,context);},
  load(url,context,next){if(url.startsWith('file:')&&url.endsWith('.ts'))return {format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform'}),shortCircuit:true};return next(url,context);},
});}
export async function verifySourceImports(atmos){
  const hook=loader();
  try{
    for(const entry of ['dataEdge','dataEdgeReadOnly'])assert.equal(typeof (await import(pathToFileURL(resolve(atmos,`platform/edge/src/${entry}.ts`)))).default?.fetch,'function','source entrypoint unavailable');
    const catalog=await import(pathToFileURL(resolve(atmos,'platform/edge/src/catalog.ts')));
    assert.equal(typeof catalog.promoteCatalogComponents,'function','paired publication support absent');
    assert.equal(typeof catalog.resolveActiveCatalog,'function','catalog reader absent');
  }finally{hook.deregister();}
}
function r2(bytes){const sha=hash(bytes);return {size:bytes.length,etag:sha,httpEtag:`"${sha}"`,customMetadata:{sha256:sha},body:new Uint8Array(bytes),json:async()=>JSON.parse(bytes),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),writeHttpMetadata(headers){headers.set('Content-Type','application/json');}};}
export async function proveReaders(atmos,object,transport,kind){
  const hook=loader();
  try{
    const catalogModule=await import(pathToFileURL(resolve(atmos,'platform/edge/src/catalog.ts')));
    const full=(await import(pathToFileURL(resolve(atmos,'platform/edge/src/dataEdge.ts')))).default;
    const readonly=(await import(pathToFileURL(resolve(atmos,'platform/edge/src/dataEdgeReadOnly.ts')))).default;
    const {buildReleasePointer}=await import(pathToFileURL(resolve(atmos,'ops/platform/build-release-pointer.mjs')));
    const pointerBytes=await object(DATA,'catalogs/current.json',256*1024),pointer=JSON.parse(pointerBytes);
    assert.ok(catalogModule.isCatalogPointer(pointer),'catalog pointer invalid');
    const snapshotKey=`catalogs/snapshots/${pointer.catalogId}.json`,snapshot=await object(DATA,snapshotKey,4*1024*1024);
    assert.equal(hash(snapshot),pointer.catalogSha256,'catalog snapshot hash mismatch');
    const catalog=JSON.parse(snapshot);assert.ok(catalogModule.isDataCatalog(catalog),'catalog schema invalid');
    const releaseBytes=await object(DATA,'releases/current.json',256*1024),release=JSON.parse(releaseBytes);
    const manifestBytes=await object(DATA,`releases/${release.releaseId}/manifest.json`),manifest=JSON.parse(manifestBytes);
    same(buildReleasePointer(manifest,release.releaseId,release.publishedAt),release,'whole release pointer mismatch');
    const manifestHashes=verifyManifestHash(manifestBytes,release.manifestSha256);
    const records=new Map(manifest.objects.map(x=>[x.path,x]));
    const held=new Map([['catalogs/current.json',pointerBytes],[snapshotKey,snapshot],['releases/current.json',releaseBytes],[`releases/${release.releaseId}/manifest.json`,manifestBytes]]);
    const componentIndexes=new Set();
    for(const component of Object.values(catalog.components)){
      const raw=await object(COMPONENTS,component.manifestKey,256*1024);
      assert.equal(hash(raw),component.manifestSha256,'component manifest hash mismatch');
      const {manifestKey,manifestSha256,...entry}=component;
      same(JSON.parse(raw),entry,'component manifest identity mismatch');
      if(['ecmwf','gfs','hrrr','aifs'].includes(component.componentId)){
        same(component.mounts,[`data/${component.componentId}/`],'core map component mount mismatch');
        componentIndexes.add(component.rootPrefix+'index.json');
      }
    }
    const fetched=[];
    async function bucketGet(bucket,key){
      let bytes;
      if(bucket===DATA&&held.has(key))bytes=held.get(key);
      else if(bucket===DATA){
        const prefix=`releases/${release.releaseId}/`;assert.ok(key.startsWith(prefix),'unreviewed whole key requested');
        const record=records.get(key.slice(prefix.length));assert.ok(record,'whole object absent from inventory');
        bytes=await object(bucket,key,4*1024*1024);assert.equal(bytes.length,record.bytes,'whole byte count mismatch');assert.equal(hash(bytes),record.sha256,'whole object hash mismatch');
      }else{
        assert.ok(componentIndexes.has(key),'unreviewed component key requested');
        bytes=await object(bucket,key,256*1024);
      }
      fetched.push({bucket,key,bytes:bytes.length,sha256:hash(bytes)});return r2(bytes);
    }
    const env={AUTH_MODE:'public',DATA_CATALOG_MODE:'serve',APP_ORIGIN:`https://reader-proof-${randomUUID()}.invalid`,DATA_POINTER_KEY:'releases/current.json',DATA_CATALOG_POINTER_KEY:'catalogs/current.json',DATA_BUCKET:{get:key=>bucketGet(DATA,key)},COMPONENT_BUCKET:{get:key=>bucketGet(COMPONENTS,key)}};
    const resolved=await catalogModule.resolveActiveCatalog({bucket:env.DATA_BUCKET,pointerKey:'catalogs/current.json'});
    assert.ok(resolved,'actual catalog is not readable');same(resolved.catalog,catalog,'resolved catalog drift');
    const reads=[];
    for(const model of ['ecmwf','gfs','hrrr','aifs']){
      const url=pinnedMapUrl(pointer.catalogId,model);
      const a=await full.fetch(new Request(url),env),b=await readonly.fetch(new Request(url),env);
      assert.equal(a.status,200,'candidate map read failed');assert.equal(b.status,200,'fallback map read failed');
      assert.equal(a.headers.get('x-weatherx-catalog'),pointer.catalogId,'candidate ignored catalog pin');assert.equal(b.headers.get('x-weatherx-catalog'),pointer.catalogId,'fallback ignored catalog pin');
      const raw=Buffer.from(await a.arrayBuffer());same(raw,Buffer.from(await b.arrayBuffer()),'candidate/fallback map parity failed');
      const live=await transport.request(url);assert.equal(live.status,200,'live pinned map read failed');assert.equal(live.headers.get('x-weatherx-catalog'),pointer.catalogId,'live ignored catalog pin');assert.equal(hash(live.body),hash(raw),'live/source pinned map mismatch');
      reads.push({model,url,sha256:hash(raw),catalogId:pointer.catalogId});
    }
    // Numeric legacy point proof uses the descriptor's own time grid, preserving
    // old-data honesty. Phase 2 alone can prove a newly routed fresh point service.
    const points=[];
    for(const model of ['ecmwf','gfs']){
      const descriptor=release.pointSeries?.models?.[model];assert.ok(descriptor?.storage?.leadHours?.length,'legacy packed point descriptor missing');
      const start=Date.parse(descriptor.initializedAt)+descriptor.storage.leadHours[0]*3_600_000;
      const params=new URLSearchParams({lat:'39.9',lon:'116.4',run:descriptor.runId,variables:'temperature',start:new Date(start).toISOString(),end:new Date(start+12*3_600_000).toISOString()});
      const url=`${ORIGIN}/api/v1/point-series/${model}?${params}`;
      // Explicitly test the legacy whole-release compatibility branch even after
      // a concurrent paired component publication. This is local only, not config.
      const legacy={...env,DATA_CATALOG_MODE:'shadow',APP_ORIGIN:`https://legacy-proof-${randomUUID()}.invalid`};
      const a=await full.fetch(new Request(url),legacy),b=await readonly.fetch(new Request(url),legacy);
      assert.equal(a.status,200,'candidate legacy point decode failed');assert.equal(b.status,200,'fallback legacy point decode failed');
      const actual=await a.json(),other=await b.json();same(actual,other,'point reader parity failed');
      assert.equal(actual.runId,descriptor.runId);assert.ok(actual.series?.temperature?.samples?.some(x=>Number.isFinite(x.value)),'point has no finite weather values');
      points.push({model,runId:actual.runId,quality:actual.quality,freshUntil:descriptor.freshUntil,payloadSha256:hash(canonical(actual))});
    }
    // A safe GET tests the fallback's refusal marker without signing a mutation.
    const probe=await transport.request(ORIGIN+'/api/platform/internal/catalog');
    assert.equal(probe.status,kind==='readonly'?503:404,'catalog mode probe failed');
    if(kind==='readonly')assert.equal(probe.headers.get('x-weatherx-publication'),'paused','publication pause marker missing');
    return {catalogId:pointer.catalogId,catalogSha256:pointer.catalogSha256,releaseId:release.releaseId,pointerSha256:hash(releaseBytes),manifestHashes,reads,points,objects:fetched,qualification:'reader-compatibility-only; freshness and point-route activation remain separate'};
  }finally{hook.deregister();}
}
