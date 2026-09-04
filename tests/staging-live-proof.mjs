import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {readPublic,bindBytes,loadConsumer,verifyStaging} from '../tools/staging-live-proof.mjs';
import {hash} from '../tools/shared-data.mjs';
import {fixture} from './shared-data.mjs';
import {buildServingCatalog} from '../tools/staging-activate.mjs';

test('public proof refuses production, redirects, errors and oversized bodies',async()=>{
  await assert.rejects(readPublic('https://weatherx.org/data/a'));
  for(const response of [new Response('bad',{status:403}),new Response('abcd')])await assert.rejects(readPublic('https://staging.weatherx.org/data/a',{fetcher:async()=>response,maxBytes:3}));
  let observed;await readPublic('https://staging.weatherx.org/data/a',{fetcher:async(u,o)=>{observed=o;return new Response('ok');}});
  assert.equal(observed.redirect,'error');assert.equal(observed.headers.Authorization,undefined);
  assert.throws(()=>bindBytes(Buffer.from('bad'),{bytes:3,sha256:hash('good')}));
});
test('actual pinned readers accept explicit staging activation markers and derived catalog', {skip:!process.env.STAGING_CONSUMER_ROOT},async()=>{
  const consumer=loadConsumer(resolve(process.env.STAGING_CONSUMER_ROOT));
  try{const deps=await consumer.dependencies({}),f=fixture();const marker={id:'123-1',sourceSha:'a'.repeat(40)};
    const ctx={selection:f.pin,candidateId:hash(JSON.stringify(f.pin)),activationId:marker.id,sourceSha:marker.sourceSha,receiptSha256:'b'.repeat(64)};
    const serving=buildServingCatalog(ctx,f.catalogPointer,f.catalog,f.catalog,Date.parse(f.catalog.createdAt)+1000);
    await deps.validateServingPointers({release:{...f.release,stagingActivation:marker},catalogPointer:{...serving.pointer,stagingActivation:marker},catalog:serving.catalog});
    assert.throws(()=>deps.validateServingPointers({release:{...f.release,schemaVersion:99},catalogPointer:f.catalogPointer,catalog:f.catalog}));
  }finally{consumer.close();}
});

// Synthetic dependency test ONLY: proves orchestration/comparison, not WXPS
// meteorology. The guarded workflow separately decodes actual immutable packs.
function proofFixture(pointModels=['ecmwf','gfs']){
  const now=Date.parse('2026-08-31T15:00:00Z'),releaseId='cycle-test',selection={releaseId,releaseManifestSha256:'a'.repeat(64),catalogId:'34-source',catalogSha256:'b'.repeat(64)},servingCatalog={schemaVersion:2,catalogId:'37-staging-1-1'},objects=[],store=new Map();
  const put=(path,body)=>{const b=Buffer.from(body);store.set(`releases/${releaseId}/${path}`,b);objects.push({path,bytes:b.length,sha256:hash(b)});};
  for(const path of ['ledger/index.json','verify/index.json','ledger/accuracy/current.json','ledger/accuracy/current.txt'])put('data/'+path,'synthetic-'+path);
  const models={},components={};
  for(const model of pointModels){
    models[model]={runId:'run-test',freshUntil:new Date(now+2*3600_000).toISOString()};
    put(`point-series/v2/${model}/run-test/chunks/0/0.bin.gz`,'synthetic-'+model);
    components[model]={rootPrefix:`components/${model}/test/`};store.set(components[model].rootPrefix+'index.json',Buffer.from(model));
  }
  const manifest={objects,pointSeries:{models}},pointer={releaseId,manifestSha256:selection.releaseManifestSha256,pointSeries:manifest.pointSeries};
  store.set('releases/current.json',Buffer.from(JSON.stringify(pointer)));
  const io={get:async(bucket,key)=>store.has(key)?{body:store.get(key)}:null};
  const payload=(url,model)=>({releaseId,runId:'run-test',quality:'complete',location:new URL(url).searchParams.get('lat'),series:Object.fromEntries(['temperature','wind_speed','wind_direction','precipitation'].map(k=>[k,{samples:[{value:1}]}]))});
  const calls=[];
  const fetcher=async url=>{calls.push(url);const path=new URL(url).pathname;
    if(path==='/api/platform/health')return Response.json({ok:true,authMode:'public',billingMode:'disabled'});
    if(path==='/api/platform/data-health')return Response.json({ok:true,authMode:'public',catalogMode:'serve'});
    if(path.startsWith('/api/v1/point-series/'))return Response.json(payload(url,path.split('/').at(-1)),{headers:{'x-weatherx-release':releaseId}});
    const model=path.split('/')[2];if(components[model])return new Response(model,{headers:{'x-weatherx-catalog':servingCatalog.catalogId}});
    return new Response(store.get(`releases/${releaseId}${path}`),{headers:{'x-weatherx-release':releaseId}});
  };
  const serve=async(request,env,model)=>{await env.DATA_BUCKET.get(`releases/${releaseId}/point-series/v2/${model}/run-test/chunks/0/0.bin.gz`);return Response.json(payload(request.url,model));};
  return {args:{selection,manifest,catalog:{components},servingCatalog},io,serve,fetcher,calls,now:()=>now};
}
test('public proof binds14points, sourcepacks, four ancillary products and independent staging catalog twice',async()=>{
  const f=proofFixture(),proof=await verifyStaging(f.args,f.io,f.serve,{fetcher:f.fetcher,pause:async()=>{},now:f.now});
  assert.equal(proof.points.length,14);assert.equal(proof.sourceVerified,true);assert.deepEqual(proof.servingCatalog,f.args.servingCatalog);
  assert.equal(f.calls.filter(u=>u.includes('/point-series/')).length,28);
});
test('an admitted AIFS point model adds its own seven decoded points; an unknown point model refuses',async()=>{
  const f=proofFixture(['aifs','ecmwf','gfs']),proof=await verifyStaging(f.args,f.io,f.serve,{fetcher:f.fetcher,pause:async()=>{},now:f.now});
  assert.equal(proof.points.length,21);assert.equal(proof.points.filter(p=>p.model==='aifs').length,7);
  assert.equal(f.calls.filter(u=>u.includes('/point-series/aifs')).length,14);
  const g=proofFixture(['ecmwf','gfs','nam']);
  await assert.rejects(verifyStaging(g.args,g.io,g.serve,{fetcher:g.fetcher,pause:async()=>{},now:g.now}),/unqualified point-series model/);
  const h=proofFixture(['ecmwf']);
  await assert.rejects(verifyStaging(h.args,h.io,h.serve,{fetcher:h.fetcher,pause:async()=>{},now:h.now}),/required point-series models/);
});
test('wrong point bytes, source IDs or catalog authority never qualify',async()=>{
  for(const change of ['value','release','catalog']){
    const f=proofFixture(),fetcher=async url=>{const r=await f.fetcher(url);if(change==='value'&&url.includes('/point-series/')){const p=await r.json();p.series.temperature.samples[0].value=2;return Response.json(p,{headers:r.headers});}
      if(change==='release'&&url.includes('/point-series/'))r.headers.set('x-weatherx-release','other');
      if(change==='catalog'&&url.includes('/data/ecmwf/'))r.headers.set('x-weatherx-catalog','34-source');return r;};
    await assert.rejects(verifyStaging(f.args,f.io,f.serve,{fetcher,pause:async()=>{},now:f.now}));
  }
});
test('new workflows are manual staging-only and never receive production or Pages credentials',()=>{
  for(const name of ['staging-consumer-refresh.yml','staging-data-activate.yml']){
    const text=readFileSync(new URL('../.github/workflows/'+name,import.meta.url),'utf8');
    assert.match(text,/workflow_dispatch:/);assert.doesNotMatch(text,/\n  (schedule|push|workflow_run|pull_request):/);
    assert.match(text,/environment:\n\s+name: data-staging/);assert.match(text,/group: weatherx-staging-publication/);
    assert.doesNotMatch(text,/CLOUDFLARE_WORKERS_API_TOKEN|CLOUDFLARE_DATA_EDGE_API_TOKEN|UI_CANDIDATE_KEY|PAGES.*TOKEN/);
    for(const line of text.split('\n').filter(l=>l.includes('uses:')))assert.match(line,/@[a-f0-9]{40}\b/);
  }
  const data=readFileSync(new URL('../.github/workflows/staging-data-activate.yml',import.meta.url),'utf8');
  assert.doesNotMatch(data,/SHARED_R2_READ|STAGING_WORKER_API_TOKEN/);assert.match(data,/run\.mjs recover/);
});
