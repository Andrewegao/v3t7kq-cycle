import assert from 'node:assert/strict';
import test from 'node:test';
import {MODELS,hash} from '../tools/shared-data.mjs';
import {discoverCurrentSelection,gate} from '../tools/staging-current-selection.mjs';

const now=Date.parse('2026-09-01T20:00:00Z'),time=new Date(now).toISOString(),encoded=value=>Buffer.from(JSON.stringify(value)+'\n');
function fixture(){
  const releaseId='cycle-current',catalogId='51-current',objects=['data/ledger/index.json','data/verify/index.json',
    'data/ledger/accuracy/current.json','data/ledger/accuracy/current.txt','data-atmos/index.json','point-series/index.json']
    .map(path=>({path,bytes:1,sha256:hash(path)}));
  const pointSeries={schemaVersion:2,models:Object.fromEntries(['ecmwf','gfs'].map(model=>[model,{freshUntil:new Date(now+2*3600_000).toISOString()}]))};
  const manifest={schemaVersion:1,releaseId,createdAt:time,objectCount:objects.length,objects,pointSeries};
  const release={schemaVersion:1,releaseId,publishedAt:time,objectCount:objects.length,manifestSha256:hash(JSON.stringify(manifest)),pointSeries};
  const components=Object.fromEntries(MODELS.map(model=>{const descriptor={schemaVersion:1,componentId:model,artifactId:`${model}-current`,
    generationTime:time,completedAt:time,rootPrefix:`components/${model}/${model}-current/`,mounts:[`data/${model}/`],objectCount:1,
    inventorySha256:hash(model),quality:{status:'passed',checks:['manifest','inventory','remote_bytes','coverage','freshness','live_superset','horizon','cadence','grid','referenced_bytes']}};
    return [model,{...descriptor,manifestKey:descriptor.rootPrefix+'component.json',manifestSha256:hash(model+'-manifest')}];}));
  const catalog={schemaVersion:2,sequence:51,parentCatalogId:'50-old',createdAt:time,components},catalogRaw=encoded(catalog);
  const catalogPointer={schemaVersion:2,catalogId,sequence:51,publishedAt:time,previousCatalogId:'50-old',catalogSha256:hash(catalogRaw)};
  const store=new Map([['releases/current.json',encoded(release)],[`releases/${releaseId}/manifest.json`,encoded(manifest)],
    ['catalogs/current.json',encoded(catalogPointer)],[`catalogs/snapshots/${catalogId}.json`,catalogRaw]]),reads=[];
  return {release,manifest,catalogPointer,store,reads,io:{get(kind,key){assert.equal(kind,'data');reads.push(key);const value=store.get(key);assert.ok(value);return value;}}};
}

test('hosted manual main and absence of all write/deployment credentials are mandatory',()=>{
  const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main'};
  gate(env);
  for(const patch of [{GITHUB_ACTIONS:''},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_EVENT_NAME:'schedule'},{GITHUB_REF:'refs/heads/dev'},
    {STAGING_R2_WRITE_ACCESS_KEY_ID:'write'},{CLOUDFLARE_API_TOKEN:'broad'},{STAGING_WORKER_API_TOKEN:'deploy'}])assert.throws(()=>gate({...env,...patch}));
});

test('discovers and validates both exact current identities without writing',async()=>{
  const f=fixture();let validations=0;
  const receipt=await discoverCurrentSelection(f.io,(descriptor,objects)=>{assert.deepEqual(descriptor,f.manifest.pointSeries);assert.deepEqual(objects,f.manifest.objects);validations++;},now);
  assert.equal(validations,1);assert.deepEqual(f.reads,['releases/current.json','catalogs/current.json',`releases/${f.release.releaseId}/manifest.json`,`catalogs/snapshots/${f.catalogPointer.catalogId}.json`]);
  assert.equal(receipt.selectionSha256,hash(JSON.stringify(receipt.selection)));assert.equal(receipt.stagingWritten,false);assert.equal(receipt.productionWritten,false);
  assert.deepEqual(receipt.pointModels,['ecmwf','gfs']);assert.deepEqual(receipt.pointComponents,[]);
});

test('pointer, manifest, catalog and point validation failures stop discovery',async()=>{
  for(const mutate of [f=>{f.release.manifestSha256='0'.repeat(64);f.store.set('releases/current.json',encoded(f.release));},
    f=>f.store.set(`releases/${f.release.releaseId}/manifest.json`,encoded({...f.manifest,objectCount:1})),
    f=>{f.catalogPointer.catalogSha256='0'.repeat(64);f.store.set('catalogs/current.json',encoded(f.catalogPointer));}]){
    const f=fixture();mutate(f);await assert.rejects(discoverCurrentSelection(f.io,()=>{},now));
  }
  const f=fixture();await assert.rejects(discoverCurrentSelection(f.io,()=>{throw Error('bad points');},now),/bad points/);
});
