import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {ACCOUNT,hash} from '../tools/shared-data.mjs';
import {activePin,assertFollowing,assertSharedReadConfig,MAX_PIN_HOURS,PIN_KEY,pinDocument,pinGate,probeGate,probeFailureDiagnostic,productionCurrent,releasedPinDocument,SHARED_READ_SECRETS,SHARED_READ_VARS,stagingServing,writePin} from '../tools/staging-shared-read.mjs';

const now=Date.parse('2026-09-04T06:00:00Z');
const hosted={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main'};

test('probe runs only hosted on main and never holds a write or deployment credential',()=>{
  for(const event of ['workflow_dispatch','schedule'])probeGate({...hosted,GITHUB_EVENT_NAME:event});
  for(const patch of [{GITHUB_ACTIONS:''},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_REF:'refs/heads/dev'},{GITHUB_EVENT_NAME:'push'},
    {STAGING_R2_WRITE_ACCESS_KEY_ID:'w'},{R2_PRODUCTION_ACCESS_KEY_ID:'p'},{CLOUDFLARE_API_TOKEN:'t'},{STAGING_WORKER_API_TOKEN:'d'},{UI_CANDIDATE_KEY:'k'}])
    assert.throws(()=>probeGate({...hosted,GITHUB_EVENT_NAME:'workflow_dispatch',...patch}),JSON.stringify(patch));
});

test('pin writer is manual, switch-gated, staging-scoped and refuses the production read credential',()=>{
  const env={...hosted,GITHUB_EVENT_NAME:'workflow_dispatch',STAGING_DATA_ISOLATION_APPROVED:'true',STAGING_SHARED_READ_PIN_ENABLED:'true',STAGING_R2_ACCOUNT_ID:ACCOUNT};
  pinGate(env);
  for(const patch of [{GITHUB_EVENT_NAME:'schedule'},{STAGING_DATA_ISOLATION_APPROVED:'false'},{STAGING_SHARED_READ_PIN_ENABLED:''},{STAGING_R2_ACCOUNT_ID:'b'.repeat(32)},
    {SHARED_R2_READ_ACCESS_KEY_ID:'r'},{R2_PRODUCTION_SECRET_ACCESS_KEY:'p'},{CLOUDFLARE_DATA_EDGE_API_TOKEN:'e'}])assert.throws(()=>pinGate({...env,...patch}),JSON.stringify(patch));
});

function stagingConfig(){
  return {name:'weatherx-platform-edge',env:{
    local:{vars:{APP_ORIGIN:'http://localhost:4173'}},
    staging:{name:'weatherx-platform-edge-staging',secrets:{required:['AUTH_HASH_KEY',...SHARED_READ_SECRETS]},
      vars:{APP_ORIGIN:'https://staging.weatherx.org',AUTH_MODE:'public',BILLING_MODE:'disabled',DATA_CATALOG_MODE:'serve',...SHARED_READ_VARS},
      r2_buckets:[{binding:'DATA_BUCKET',bucket_name:'weatherx-data-staging'},{binding:'COMPONENT_BUCKET',bucket_name:'weatherx-components-staging'}]},
    production:{vars:{APP_ORIGIN:'https://weatherx.org'},r2_buckets:[{binding:'DATA_BUCKET',bucket_name:'weatherx-data-production'}]}}};
}
test('staging configuration may name production only through the read-only variables, never a binding',()=>{
  assert.equal(assertSharedReadConfig(stagingConfig()).vars.SHARED_READ_DATA_BUCKET,'weatherx-data-production');
  for(const mutate of [c=>c.env.staging.r2_buckets.push({binding:'SHARED_DATA_BUCKET',bucket_name:'weatherx-data-production'}),
    c=>c.env.staging.r2_buckets[0].bucket_name='weatherx-data-production',c=>c.env.staging.vars.DATA_SOURCE_MODE='own',
    c=>c.env.staging.vars.SHARED_READ_ACCOUNT_ID='b'.repeat(32),c=>c.env.staging.vars.SHARED_READ_COMPONENT_BUCKET='weatherx-components-staging',
    c=>c.env.staging.secrets.required=['AUTH_HASH_KEY','SHARED_READ_ACCESS_KEY_ID'],c=>c.env.production.vars.DATA_SOURCE_MODE='shared',
    c=>c.env.local.vars.SHARED_READ_ACCOUNT_ID=ACCOUNT,c=>c.env.staging.vars.AUTH_MODE='enforce']){
    const config=stagingConfig();mutate(config);assert.throws(()=>assertSharedReadConfig(config));
  }
});

function production(){
  const reads=[];const store={'releases/current.json':{schemaVersion:1,releaseId:'cycle-100',publishedAt:'2026-09-04T05:30:00Z',manifestSha256:'a'.repeat(64)},
    'catalogs/current.json':{schemaVersion:2,catalogId:'90-abc',publishedAt:'2026-09-04T05:40:00Z',catalogSha256:'b'.repeat(64)}};
  return {reads,io:{get(kind,key){assert.equal(kind,'data');reads.push(key);return JSON.stringify(store[key]);}}};
}
test('production identities are read only from the two current pointers',()=>{
  const p=production();
  assert.deepEqual(productionCurrent(p.io),{releaseId:'cycle-100',catalogId:'90-abc',releasePublishedAt:'2026-09-04T05:30:00Z',catalogPublishedAt:'2026-09-04T05:40:00Z'});
  assert.deepEqual(p.reads,['releases/current.json','catalogs/current.json']);
});

function stagingSite({releaseId='cycle-100',catalogId='90-abc',source='shared',health={},pointRelease}={}){
  const calls=[];
  const fetcher=async(url,init)=>{
    const {pathname}=new URL(url);calls.push(`${init.method??'GET'} ${pathname}`);
    assert.equal(init.redirect,'error');assert.equal(new URL(url).origin,'https://staging.weatherx.org');
    if(pathname==='/api/platform/data-health')return Response.json({ok:true,authMode:'public',catalogMode:'serve',dataSource:'shared',sharedReadConfigured:true,pin:null,...health});
    if(pathname==='/data/ledger/index.json')return new Response(null,{headers:{'x-weatherx-release':releaseId,'x-weatherx-data-source':source}});
    if(pathname==='/data/ecmwf/index.json')return new Response(null,{headers:{'x-weatherx-catalog':catalogId,'x-weatherx-data-source':source}});
    if(pathname==='/api/v1/point-series/ecmwf')return Response.json({releaseId:pointRelease??releaseId,runId:'2026090400',quality:'complete',freshUntil:'2026-09-05T00:00:00Z'});
    throw Error('unexpected '+pathname);
  };
  return {calls,fetcher};
}
test('a following staging serves exactly production current from the shared source, with coherent points',async()=>{
  const site=stagingSite();const staging=await stagingServing(site.fetcher,now);
  assert.deepEqual(site.calls,['GET /api/platform/data-health','HEAD /data/ledger/index.json','HEAD /data/ecmwf/index.json','GET /api/v1/point-series/ecmwf']);
  const receipt=assertFollowing(productionCurrent(production().io),staging,now);
  assert.equal(receipt.following,true);assert.equal(receipt.productionWritten,false);assert.equal(receipt.stagingWritten,false);
  assert.deepEqual(receipt.staging,{releaseId:'cycle-100',catalogId:'90-abc',point:{releaseId:'cycle-100',runId:'2026090400',quality:'complete',freshUntil:'2026-09-05T00:00:00Z'}});
});

function windSite({selectorPatch={},pointPatch={},headersPatch={},status=200,afterPoint=()=>{}}={}){
  const base=stagingSite();
  const initializedAt='2026-09-04T00:00:00.000Z',freshUntil='2026-09-05T06:00:00.000Z';
  const selector={schemaVersion:1,kind:'staging-native-wind100-selector',catalogId:'stage-wind100-recurring-100-1',
    runId:'2026090400',selectionSha256:'a'.repeat(64),initializedAt,freshUntil,...selectorPatch};
  const fetcher=async(url,init)=>{
    const u=new URL(url);
    if(u.pathname==='/api/platform/staging-wind100/current'){
      base.calls.push('GET '+u.pathname);assert.equal(init.method,'GET');assert.equal(init.redirect,'error');
      assert.equal(u.origin,'https://staging.weatherx.org');
      return Response.json(selector,{status,headers:{'Cache-Control':'no-store'}});
    }
    if(u.searchParams.get('optionalVariables')==='wind_speed_100m'){
      base.calls.push('GET pinned-wind100');
      assert.equal(u.searchParams.get('run'),selector.runId);assert.equal(u.searchParams.get('catalog'),selector.catalogId);
      assert.equal(u.searchParams.get('selection'),selector.selectionSha256);assert.equal(init.method,'GET');
      assert.equal(u.origin,'https://staging.weatherx.org');
      const times=[initializedAt,'2026-09-04T03:00:00.000Z'];
      const series=Object.fromEntries(['wind_speed','wind_speed_100m'].map(name=>[name,{kind:'instantaneous',units:'m/s',
        samples:times.map(validTime=>({validTime,value:5}))}]));
      const body={schemaVersion:1,model:'ecmwf',runId:selector.runId,releaseId:selector.catalogId,initializedAt,freshUntil,
        source:'ECMWF IFS 0.25 degree direct open-data GRIB',quality:'complete',missingFields:[],optionalMissingFields:[],
        nativeCadenceSeconds:10800,resolutionDegrees:0.25,requestedPoint:{latitude:32.06,longitude:118.8},
        window:{start:initializedAt,end:'2026-09-04T06:00:00.000Z'},series,...pointPatch};
      afterPoint();
      return Response.json(body,{headers:{'X-WeatherX-Data-Source':'own','X-WeatherX-Catalog':selector.catalogId,...headersPatch}});
    }
    return base.fetcher(url,init);
  };
  return {...base,fetcher,selector};
}
test('enabled probe covers discovery and the exact pinned native 100m point, without mutations',async()=>{
  const site=windSite();const staging=await stagingServing(site.fetcher,now,{wind100Enabled:true});
  assert.deepEqual(site.calls.slice(-2),['GET /api/platform/staging-wind100/current','GET pinned-wind100']);
  assert.equal(staging.wind100.catalogId,site.selector.catalogId);assert.equal(staging.wind100.runId,site.selector.runId);
  const receipt=assertFollowing(productionCurrent(production().io),staging,now);
  assert.equal(receipt.staging.wind100.selectionSha256,'a'.repeat(64));
  assert.equal(receipt.staging.wind100.freshUntil,site.selector.freshUntil);
});
test('Wind100 failure is visible even when broad health succeeds; identity and native completeness fail closed',async()=>{
  for(const options of [{status:404},{selectorPatch:{selectionSha256:'invalid'}},{selectorPatch:{runId:'2026023100'}},
    {selectorPatch:{catalogId:'production-100'}},{selectorPatch:{freshUntil:'2026-09-06T00:00:00Z'}},
    {selectorPatch:{initializedAt:'2026-09-04T12:00:00Z'}},
    {pointPatch:{runId:'2026090312'}},{pointPatch:{source:'derived wind'}},{pointPatch:{quality:'partial'}},
    {pointPatch:{optionalMissingFields:['wind_speed_100m']}},{headersPatch:{'X-WeatherX-Data-Source':'shared'}},
    {headersPatch:{'X-WeatherX-Catalog':'other'}},{pointPatch:{series:{}}}]){
    await assert.rejects(stagingServing(windSite(options).fetcher,now,{wind100Enabled:true}),JSON.stringify(options));
  }
});
test('Wind100 freshness is rechecked after awaited response and after body consumption at exact expiry',async()=>{
  const expiry=Date.parse('2026-09-05T06:00:00Z');let clock=expiry-1;
  const site=windSite({afterPoint:()=>{clock=expiry;}});
  await assert.rejects(stagingServing(site.fetcher,()=>clock,{wind100Enabled:true}),/freshness/);
  clock=expiry-1;
  const bodySite=windSite();
  const delayed=async(url,init)=>{
    const response=await bodySite.fetcher(url,init);
    if(!url.includes('optionalVariables'))return response;
    const bytes=new Uint8Array(await response.arrayBuffer());
    return new Response(new ReadableStream({pull(controller){clock=expiry;controller.enqueue(bytes);controller.close();}}),{headers:response.headers});
  };
  await assert.rejects(stagingServing(delayed,()=>clock,{wind100Enabled:true}),/freshness/);
  const valid=await stagingServing(windSite().fetcher,()=>expiry-1,{wind100Enabled:true});
  assert.equal(valid.wind100.freshUntil,'2026-09-05T06:00:00.000Z');
  assert.throws(()=>assertFollowing(productionCurrent(production().io),valid,expiry),/freshness/);
  await assert.rejects(stagingServing(windSite().fetcher,Date.parse('2026-09-03T23:59:59Z'),{wind100Enabled:true}),/freshness/);
});
test('oversized and failed responses cancel their bodies without exposing response content',async()=>{
  for(const status of [200,404]){
    let cancelled=false;
    const fetcher=async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(65537));},cancel(){cancelled=true;}}),{status});
    await assert.rejects(stagingServing(fetcher,now),status===200?/oversized/:/expected HTTP 200/);
    assert.equal(cancelled,true);
  }
});
test('HEAD probes do not apply the body byte limit to the full object Content-Length',async()=>{
  const site=stagingSite();
  const fetcher=async(url,init)=>{
    const response=await site.fetcher(url,init);
    if(init.method==='HEAD')response.headers.set('Content-Length','5000000');
    return response;
  };
  await stagingServing(fetcher,now);
  assert.equal(site.calls.length,4);
});
test('probe failure receipt has fixed categories and phases, never raw remote content or hostile getters',()=>{
  const secret='credential secret from remote response';
  for(const error of [{code:'ERR_ASSERTION',message:secret,actual:secret},new SyntaxError(secret),
    {name:'TimeoutError',message:secret},{get code(){throw Error(secret);},get name(){throw Error(secret);}}]){
    const receipt=probeFailureDiagnostic(error,'wind100-selector');
    assert.deepEqual(Object.keys(receipt).sort(),['schemaVersion','kind','origin','ok','phase','category','httpStatus','productionWritten','stagingWritten'].sort());
    assert.equal(receipt.phase,'wind100-selector');assert.ok(!JSON.stringify(receipt).includes(secret));
    assert.equal(receipt.ok,false);assert.equal(receipt.productionWritten,false);assert.equal(receipt.stagingWritten,false);
  }
  assert.equal(probeFailureDiagnostic({},secret).phase,'unknown');
});
test('selector HTTP failure retains only its numeric status in the bounded diagnostic',async()=>{
  await assert.rejects(stagingServing(windSite({status:404}).fetcher,now,{wind100Enabled:true}),error=>{
    const receipt=probeFailureDiagnostic(error,'wind100-selector');
    assert.equal(receipt.category,'http');assert.equal(receipt.httpStatus,404);return true;
  });
});
test('lag, own-copy serving, missing credential, stale points and unknown mode all fail the probe',async()=>{
  const prod=productionCurrent(production().io);
  for(const [name,options] of [['release lag',{releaseId:'cycle-99'}],['catalog lag',{catalogId:'89-old'}],['own copy',{source:'own'}],
    ['credential',{health:{sharedReadConfigured:false}}],['mode',{health:{dataSource:'own'}}],['point release',{pointRelease:'cycle-99'}]]){
    const staging=await stagingServing(stagingSite(options).fetcher,now);
    assert.throws(()=>assertFollowing(prod,staging,now),name);
  }
  const stale=await stagingServing(stagingSite().fetcher,now);stale.point.quality='stale';
  assert.throws(()=>assertFollowing(prod,stale,now),/stale/);
});
test('an active pin is honoured exactly and an expired or released pin means follow',async()=>{
  const prod=productionCurrent(production().io);
  const pin={schemaVersion:1,releaseId:'cycle-95',catalogId:null,expiresAt:new Date(now+HOUR).toISOString()};
  const pinned=await stagingServing(stagingSite({releaseId:'cycle-95',health:{pin}}).fetcher,now);
  assert.equal(assertFollowing(prod,pinned,now).following,false);
  assert.throws(()=>assertFollowing(prod,{...pinned,releaseId:'cycle-100',point:{...pinned.point,releaseId:'cycle-100'}},now),/pinned release/);
  const expired={...pin,expiresAt:new Date(now-1).toISOString()};
  assert.equal(activePin(expired,now),null);assert.equal(activePin(releasedPinDocument(now),now),null);assert.equal(activePin(null,now),null);
  const following=await stagingServing(stagingSite({health:{pin:expired}}).fetcher,now);
  assert.equal(assertFollowing(prod,following,now).following,true);
});
const HOUR=3_600_000;
test('pin documents are bounded identifiers with a short lifetime',()=>{
  assert.deepEqual(pinDocument({releaseId:'cycle-95',hours:6,reason:'canary'},now),{schemaVersion:1,releaseId:'cycle-95',catalogId:null,expiresAt:new Date(now+6*HOUR).toISOString(),reason:'canary'});
  assert.deepEqual(pinDocument({catalogId:'88-x',hours:MAX_PIN_HOURS},now).catalogId,'88-x');
  for(const bad of [{hours:6},{releaseId:'../x',hours:6},{releaseId:'r',hours:0},{releaseId:'r',hours:MAX_PIN_HOURS+1},{releaseId:'r',hours:1.5},{releaseId:'r',hours:6,reason:'x'.repeat(201)},{releaseId:'r',hours:6,reason:'非ASCII'}])
    assert.throws(()=>pinDocument(bad,now),JSON.stringify(bad));
  assert.deepEqual(releasedPinDocument(now),{schemaVersion:1,releaseId:null,catalogId:null,expiresAt:new Date(now).toISOString(),reason:'unpinned'});
});
test('pin writes are compare-and-swap on the single staging pin key and read back exactly',async()=>{
  const puts=[];let stored=null,corrupt=false;
  const io={get:async(bucket,key)=>{assert.equal(bucket,'weatherx-data-staging');assert.equal(key,PIN_KEY);return stored;},
    put:async(bucket,key,body,options)=>{assert.equal(bucket,'weatherx-data-staging');assert.equal(key,PIN_KEY);puts.push(options);
      stored={body:Buffer.from(corrupt?'{}':body),etag:`"v${puts.length}"`,customMetadata:options.customMetadata};return {etag:stored.etag};}};
  const first=await writePin(io,pinDocument({releaseId:'cycle-95',hours:2},now));
  assert.deepEqual(puts[0].ifNoneMatch,'*');assert.equal(first.etag,'"v1"');assert.equal(first.sha256,hash(Buffer.from(JSON.stringify(first.document)+'\n')));
  await writePin(io,releasedPinDocument(now));
  assert.equal(puts[1].ifMatch,'"v1"');assert.equal(puts[1].ifNoneMatch,undefined);
  corrupt=true;
  await assert.rejects(writePin(io,pinDocument({releaseId:'cycle-95',hours:2},now)),/readback/);
  await assert.rejects(writePin(io,{schemaVersion:2}));
});
test('shared-read workflows are read-only probes or a staging-scoped pin writer; never bake, deploy or touch production',()=>{
  const probe=readFileSync(new URL('../.github/workflows/staging-shared-read-probe.yml',import.meta.url),'utf8');
  const pin=readFileSync(new URL('../.github/workflows/staging-shared-read-pin.yml',import.meta.url),'utf8');
  for(const yaml of [probe,pin]){
    const code=yaml.split('\n').filter(line=>!/^\s*#/.test(line)).join('\n');
    assert.match(code,/environment:\n      name: data-staging/);assert.match(code,/permissions:\n  contents: read/);
    assert.doesNotMatch(code,/pages|wrangler|workflow_run:|workflow_call:|actions\/cache|pip install|setup-python|catalog-mutation|R2_PRODUCTION|CLOUDFLARE_API_TOKEN|STAGING_WORKER_API_TOKEN|bake/i);
    assert.doesNotMatch(code,/secrets\[|secrets:\s*inherit|(?:contents|actions|deployments):\s*write/);
  }
  const probeSecrets=[...new Set([...probe.matchAll(/secrets\.([A-Z_0-9]+)/g)].map(m=>m[1]))].sort();
  assert.deepEqual(probeSecrets,['SHARED_R2_READ_ACCESS_KEY_ID','SHARED_R2_READ_SECRET_ACCESS_KEY']);
  assert.match(probe,/STAGING_SHARED_READ_PROBE_ENABLED/);
  const pinSecrets=[...new Set([...pin.matchAll(/secrets\.([A-Z_0-9]+)/g)].map(m=>m[1]))].sort();
  assert.deepEqual(pinSecrets,['STAGING_R2_WRITE_ACCESS_KEY_ID','STAGING_R2_WRITE_SECRET_ACCESS_KEY']);
  assert.doesNotMatch(pin,/schedule:/);assert.match(pin,/STAGING_SHARED_READ_PIN_ENABLED/);
});
