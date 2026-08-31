import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {loadPinnedReader,publishDisplay,makeCatalog,DATA,COMPONENTS} from '../tools/staging-model-components.mjs';
import {hash} from '../tools/model-inputs.mjs';
import {fixture,NOW} from './staging-model-components.mjs';

test('actual pinned reader serves prepared model snapshot, rejecting absent metadata and unrelated models',{skip:!process.env.STAGING_CONSUMER_ROOT},async t=>{
  const f=fixture(t),root=resolve(process.env.STAGING_CONSUMER_ROOT),reader=await loadPinnedReader(root);t.after(()=>reader.close());
  const selection=await publishDisplay(f.ctx,{...f,reader});
  const {servePrivateData}=await import(pathToFileURL(resolve(root,'platform/edge/src/data.ts')));
  let currentReads=0;
  function bucket(name){return {get:async key=>{if(key.endsWith('/current.json'))currentReads++;
    const o=f.objects.get(name+'/'+key);if(!o)return null;const body=Buffer.from(o.body);
    return {size:body.length,customMetadata:o.metadata,httpEtag:'"synthetic"',body,
      arrayBuffer:async()=>body,writeHttpMetadata:h=>{h.set('Content-Type',o.httpMetadata.contentType);h.set('Cache-Control',o.httpMetadata.cacheControl);}};}};}
  const env={AUTH_MODE:'public',BILLING_MODE:'disabled',APP_ORIGIN:'https://staging.weatherx.org',DATA_CATALOG_MODE:'serve',DATA_CATALOG_POINTER_KEY:'catalogs/current.json',DATA_POINTER_KEY:'releases/current.json',DATA_BUCKET:bucket(DATA),COMPONENT_BUCKET:bucket(COMPONENTS)};
  for(const path of [selection.indexPath,selection.manifestPath,`/data/_catalog/${selection.catalogId}/icon/runs/2026083112/wind/000.png`]){
    const response=await servePrivateData(new Request('https://staging.weatherx.org'+path),env,undefined,{cache:null});assert.equal(response.status,200);
    assert.equal(response.headers.get('x-weatherx-catalog'),selection.catalogId);assert.equal(response.headers.get('x-weatherx-release'),null);
  }
  assert.equal((await servePrivateData(new Request(`https://staging.weatherx.org/data/_catalog/${selection.catalogId}/gfs/index.json`),env,undefined,{cache:null})).status,404);
  assert.equal(currentReads,0,'pinned model lookup must not borrow current whole/catalog authority');
  const actual=f.objects.get(DATA+`/catalogs/snapshots/${selection.catalogId}.json`);
  const badId='stage-icon-missing-metadata';f.save(DATA,`catalogs/snapshots/${badId}.json`,actual.body,{});
  assert.equal((await servePrivateData(new Request(`https://staging.weatherx.org/data/_catalog/${badId}/icon/index.json`),env,undefined,{cache:null})).status,503);
  const wrongId='stage-icon-wrong-hash';f.save(DATA,`catalogs/snapshots/${wrongId}.json`,actual.body,{sha256:'f'.repeat(64)});
  assert.equal((await servePrivateData(new Request(`https://staging.weatherx.org/data/_catalog/${wrongId}/icon/index.json`),env,undefined,{cache:null})).status,503);
  const changed=makeCatalog(f.ctx,f.q,null,new Date(NOW).toISOString()).catalog;
  for(const mutate of [x=>x.schemaVersion=3,x=>x.components.icon.rootPrefix='releases/not-a-component/',x=>x.components.icon.quality.status='failed']){const c=structuredClone(changed);mutate(c);assert.equal(reader.isDataCatalog(c),false);}
  assert.equal(hash(actual.body),selection.catalogSha256);
});
