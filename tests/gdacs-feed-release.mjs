import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKER, PATTERN, ROUTE_MANIFEST, parseInputs, canonical, normalizedSettings, timeout, routeMatches, assertBootstrap, sourceInventory, assertBuildInputs, createTransport, saveReceipt, execute, recover, buildOptions, assertOwnedWorker, moduleHash, verifyLive, assertBoundary } from '../tools/gdacs-feed-release.mjs';

const clone=value=>structuredClone(value);
const originalRoute={id:'1'.repeat(32),pattern:'weatherx.org/api/platform/*',script:'weatherx-platform-edge-production'};
const newRoute={id:'2'.repeat(32),pattern:PATTERN,script:WORKER};
const newRoutes=ROUTE_MANIFEST.map((entry,index)=>({id:String(index+2).repeat(32),pattern:entry.pattern,script:WORKER}));
function fixture(overrides={}){
  const before={consumers:{platform:{version:'healthy-platform',settingsSha256:'settings',schedulesSha256:'schedules'},data:{version:'healthy-data',settingsSha256:'data-settings'}},pages:{id:'canonical',sha256:'pages'},pointer:{release:'cycle-1',sha256:'pointer'},routes:[originalRoute]};
  const receipt={schemaVersion:2,routeManifest:ROUTE_MANIFEST,sha:'a'.repeat(40),release:'cycle-1',source:{bundleSha256:'exact-module'},ownershipTag:'gdacs-12345678-1234-1234-1234-123456789abc',before:clone(before),createdAt:new Date().toISOString(),status:'preflight-passed'};
  const state={boundary:clone(before),worker:null};const calls=[],saved=[];
  const candidate=()=>({contentSha256:'exact-module',version:'12345678-1234-1234-1234-123456789abc',versionSha256:'version-detail',versionAnnotations:{'workers/tag':receipt.ownershipTag},settings:{bindings:[],compatibility_date:'2026-08-18',compatibility_flags:['nodejs_compat'],observability:{enabled:true,head_sampling_rate:1},logpush:false,tail_consumers:[]},schedules:{schedules:[]},subdomain:{enabled:false,previews_enabled:false}});
  const ops={
    boundary:async()=>clone(state.boundary),worker:async()=>clone(state.worker),routes:async()=>clone(state.boundary.routes),
    upload:async()=>{calls.push('upload');assert.equal(saved.at(-1).intent.upload,true);state.worker=candidate();},
    disable:async()=>{calls.push('disable');assert.equal(saved.at(-1).intent.disable,true);state.worker.subdomain={enabled:false,previews_enabled:false};},
    attach:async entry=>{calls.push('attach');assert.equal(saved.at(-1).intent.routes[entry.id].attach,true);state.boundary.routes.push(clone(newRoutes.find(route=>route.pattern===entry.pattern)));},
    detach:async id=>{calls.push('detach:'+id);const entry=ROUTE_MANIFEST.find(item=>newRoutes.find(route=>route.id===id)?.pattern===item.pattern);assert.equal(saved.at(-1).intent.routes[entry.id].detach,true);state.boundary.routes=state.boundary.routes.filter(route=>route.id!==id);},
    verify:async()=>calls.push('verify'),pause:async ms=>calls.push('pause:'+ms),resetRecovery:()=>calls.push('reset-recovery'),
  };
  Object.assign(ops,overrides);
  return {receipt,state,calls,saved,ops,candidate,persist:()=>saved.push(clone(receipt))};
}

test('CLI requires immutable SHA, expected-release and exactly four unique options',()=>{
  const args=['preflight','--atmos','/source','--sha','a'.repeat(40),'--expected-release','cycle-1','--receipt','/private/receipt.json'];
  assert.equal(parseInputs(args).release,'cycle-1');
  for(const replace of [a=>a[4]='main',a=>a[6]='../release',a=>a[5]='--release',a=>a[7]='--atmos',a=>a[0]='deploy']){const bad=[...args];replace(bad);assert.throws(()=>parseInputs(bad));}
  assert.throws(()=>parseInputs([...args,'--force','true']));
});
test('query strings match exact wildcard route, while other feed families do not',()=>{
  for(const url of ['https://weatherx.org/api/gdacs/list','https://weatherx.org/api/gdacs/list?guard=1','https://weatherx.org/api/gdacs/list/child'])assert.equal(routeMatches(PATTERN,url),true);
  for(const url of ['https://weatherx.org/api/gdacs/geom','https://weatherx.org/api/tc/list','https://weatherx.org/api/eonet/list','https://other.org/api/gdacs/list'])assert.equal(routeMatches(PATTERN,url),false);
});
test('bootstrap requires absence and rejects broad, exact, suffix and foreign conflicts',()=>{
  assert.doesNotThrow(()=>assertBootstrap(null,[originalRoute]));
  assert.throws(()=>assertBootstrap({},[]));
  for(const pattern of [PATTERN,'weatherx.org/api/*','*weatherx.org/api/gdacs/*','https://weatherx.org/api/gdacs/list','weatherx.org/api/gdacs/list?special=*','weatherx.org/api/gdacs/list/child'])assert.throws(()=>assertBootstrap(null,[{id:'3'.repeat(32),pattern,script:'other'}]));
  assert.throws(()=>assertBootstrap(null,[{...originalRoute,script:WORKER}]));
});
test('full normalized settings preserve unknown fields, secret names and stable key order',()=>{
  const settings={bindings:[{name:'SECRET',type:'secret_text'},{name:'MODE',type:'plain_text',text:'safe'}],compatibility_flags:['b','a'],limits:{cpu_ms:10},future:{gate:true}};
  assert.equal(canonical(normalizedSettings(settings)),canonical(normalizedSettings({...settings,bindings:[...settings.bindings].reverse()})));
  assert.notEqual(canonical(normalizedSettings(settings)),canonical(normalizedSettings({...settings,future:{gate:false}})));
  assert.match(canonical(normalizedSettings(settings)),/SECRET/);
});
test('HTTP deadline and byte cap are hard bounds; errors expose no response body',async()=>{
  assert.equal(timeout(30_000,100_000,99_000),1000);assert.throws(()=>timeout(30_000,100_000,100_000));
  const transport=createTransport({fetchImpl:async()=>new Response('123456'),deadline:()=>Date.now()+1000});
  await assert.rejects(transport.request('https://weatherx.org',{},4),/cap/);
  const rejected=createTransport({fetchImpl:async()=>Response.json({success:false,errors:[{message:'secret-remote-value'}]},{status:403}),tokens:{PLATFORM_EDGE_TOKEN:'fake'}});
  await assert.rejects(rejected.api('/test'),error=>!error.message.includes('secret-remote-value'));
});
test('absence is only recognized for explicit Worker-not-found, not permission failures',async()=>{
  for(const [status,code,absent] of [[404,10007,true],[403,10000,false],[404,9999,false]]){
    const transport=createTransport({fetchImpl:async()=>Response.json({success:false,errors:[{code}]},{status}),tokens:{PLATFORM_EDGE_TOKEN:'fake'}});
    if(absent)assert.equal(await transport.api('/worker','PLATFORM_EDGE_TOKEN',{allowAbsent:true}),null);
    else await assert.rejects(transport.api('/worker','PLATFORM_EDGE_TOKEN',{allowAbsent:true}));
  }
});
test('source inventory rejects dirty, untracked, symbolic and unpinned inputs',()=>{
  const paths=['platform/edge/src/gdacsFeed.ts','platform/edge/wrangler.gdacs.jsonc','platform/edge/package-lock.json','app/functions/api/_weatherFeeds.ts','app/functions/api/_swr.ts','ops/release/verify-weather-feeds.mjs'];
  const listing=paths.map(path=>`100644 blob ${'b'.repeat(40)}\t${path}`).join('\n');
  const git=args=>args[0]==='rev-parse'?'a'.repeat(40):args[0]==='status'?'':listing;
  const inventory=sourceInventory('/source','a'.repeat(40),git);assert.equal(inventory.files.size,6);
  for(const bad of [args=>args[0]==='rev-parse'?'b'.repeat(40):git(args),args=>args[0]==='status'?'?? app/functions/api/new.ts':git(args),args=>args[0]==='ls-tree'?listing.replace('100644','120000'):git(args)])assert.throws(()=>sourceInventory('/source','a'.repeat(40),bad));
  const inputs=Object.fromEntries(['src/gdacsFeed.ts','../../app/functions/api/_weatherFeeds.ts','../../app/functions/api/_swr.ts'].map(path=>[path,{}]));
  assert.doesNotThrow(()=>assertBuildInputs(inputs,'/source',inventory.files));
  for(const path of ['../outside.ts','app/functions/api/untracked.ts','platform/edge/node_modules/unreviewed/index.js'])assert.throws(()=>assertBuildInputs({...inputs,[path]:{}},'/source',inventory.files));
  const missing={...inputs};delete missing['../../app/functions/api/_swr.ts'];assert.throws(()=>assertBuildInputs(missing,'/source',inventory.files));
});
test('receipt is private and durably replaceable',()=>{
  const directory=mkdtempSync(join(tmpdir(),'gdacs-receipt-'));
  try{const path=join(directory,'private','receipt.json');saveReceipt(path,{status:'intent'});saveReceipt(path,{status:'passed'});assert.equal(JSON.parse(readFileSync(path)).status,'passed');assert.equal(statSync(path).mode&0o777,0o600);}finally{rmSync(directory,{recursive:true});}
});
test('success has three complete rounds with two fifteen-second gaps and no destructive calls',async()=>{
  const f=fixture();await execute(f.receipt,f.ops,f.persist);
  assert.equal(f.receipt.status,'passed');assert.deepEqual(f.calls,['upload','disable','attach','attach','attach','verify','pause:15000','verify','pause:15000','verify']);
  assert.deepEqual(f.state.boundary.routes,[originalRoute,...newRoutes]);assert.deepEqual(f.receipt.before.routes,[originalRoute]);
});
test('stale or replayed execution cannot upload',async()=>{
  for(const status of ['passed','failed-contained','executing']){const f=fixture();f.receipt.status=status;await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.deepEqual(f.calls,[]);}
  const f=fixture();f.receipt.createdAt=new Date(Date.now()-16*60_000).toISOString();await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.deepEqual(f.calls,[]);
});
test('ambiguous successful upload is reconciled read-only without a retry',async()=>{
  const f=fixture();const upload=f.ops.upload;f.ops.upload=async()=>{await upload();throw Error('lost response');};
  await execute(f.receipt,f.ops,f.persist);assert.equal(f.receipt.uploadResponseLost,true);assert.equal(f.calls.filter(call=>call==='upload').length,1);assert.equal(f.receipt.status,'passed');
});
test('ambiguous successful route attachment is identified and can complete',async()=>{
  const f=fixture();const attach=f.ops.attach;f.ops.attach=async entry=>{await attach(entry);throw Error('lost response');};
  await execute(f.receipt,f.ops,f.persist);assert.ok(ROUTE_MANIFEST.every(entry=>f.receipt.intent.routes[entry.id].responseLost));assert.equal(f.receipt.routes['gdacs-list'].id,newRoute.id);assert.equal(f.calls.filter(call=>call==='attach').length,3);
});
test('verification failure removes only the new route and quarantines Worker',async()=>{
  const f=fixture();f.ops.verify=async()=>{throw Error('body with sensitive diagnostic');};
  await assert.rejects(execute(f.receipt,f.ops,f.persist),/quarantined/);
  assert.equal(f.receipt.status,'failed-contained');assert.equal(f.receipt.failedStage,'verification-1');assert.deepEqual(f.state.boundary.routes,[originalRoute]);assert.ok(f.state.worker);assert.deepEqual(f.state.worker.subdomain,{enabled:false,previews_enabled:false});
  assert.equal(JSON.stringify(f.saved).includes('sensitive diagnostic'),false);assert.deepEqual(f.calls.filter(call=>call.startsWith('detach:')),[...newRoutes].reverse().map(route=>'detach:'+route.id));
});
test('failed upload with no observed Worker never attaches or deletes',async()=>{
  const f=fixture();f.ops.upload=async()=>{f.calls.push('upload');throw Error('request rejected');};
  await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(f.receipt.recovery,'no-owned-mutation');assert.ok(!f.calls.includes('attach'));assert.ok(!f.calls.some(call=>call.startsWith('detach:')));
});
test('pre-upload boundary drift prevents all writes and reports no mutation',async()=>{
  for(const change of [b=>b.consumers.platform.version='foreign',b=>b.consumers.platform.settingsSha256='drift',b=>b.consumers.platform.schedulesSha256='cron',b=>b.pages.id='new-pages',b=>b.pointer.sha256='new-pointer',b=>b.routes[0].pattern='weatherx.org/*']){
    const f=fixture();change(f.state.boundary);await assert.rejects(execute(f.receipt,f.ops,f.persist),/no owned production mutation/);assert.deepEqual(f.calls,['reset-recovery']);assert.equal(f.receipt.status,'failed-no-mutation');assert.ok(f.receipt.foreignDrift);
  }
});
test('route boundary changed at last attachment check stops POST',async()=>{
  const f=fixture();let routeReads=0;
  f.ops.routes=async()=>{routeReads++;if(routeReads===2)f.state.boundary.routes.push({id:'4'.repeat(32),pattern:'weatherx.org/new/*',script:'new-publisher'});return clone(f.state.boundary.routes);};
  await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.ok(!f.calls.includes('attach'));assert.equal(f.receipt.failedStage,'attach-route:gdacs-list');
});
test('candidate module, version, settings, URL or schedule drift is never overwritten',async()=>{
  for(const change of [w=>w.contentSha256='foreign',w=>w.version='22345678-1234-1234-1234-123456789abc',w=>w.settings.bindings.push({name:'NEW',type:'plain_text',text:'x'}),w=>w.subdomain.enabled=true,w=>w.schedules.schedules.push({cron:'* * * * *'})]){
    const f=fixture();f.ops.verify=async()=>{change(f.state.worker);throw Error('changed');};
    await assert.rejects(execute(f.receipt,f.ops,f.persist),/recovery incomplete/);assert.equal(f.receipt.status,'rollback-incomplete');assert.ok(!f.calls.some(call=>call.startsWith('detach:')));
  }
});
test('cancellation recovery after upload disables owned development URLs with no route attach',async()=>{
  const f=fixture();f.receipt.status='executing';f.receipt.intent={upload:true};f.state.worker=f.candidate();f.state.worker.subdomain={enabled:true,previews_enabled:true};
  await recover(f.receipt,f.ops,f.persist);assert.deepEqual(f.calls,['disable']);assert.equal(f.receipt.recovery,'route-removed-candidate-quarantined');
});
test('independent recovery reconciles route POST response loss from persisted intent',async()=>{
  const f=fixture();f.receipt.status='executing';f.receipt.intent={upload:true,disable:true,routes:{'gdacs-list':{attach:true}}};f.state.worker=f.candidate();f.receipt.candidate=clone(f.state.worker);f.state.boundary.routes.push(clone(newRoute));
  await recover(f.receipt,f.ops,f.persist);assert.deepEqual(f.calls,['detach:'+newRoute.id]);assert.deepEqual(f.state.boundary.routes,[originalRoute]);assert.equal(f.receipt.routes['gdacs-list'].id,newRoute.id);
  await recover(f.receipt,f.ops,f.persist);assert.equal(f.calls.length,1);
});
test('response-loss deletion is reconciled once, failed deletion remains explicit',async()=>{
  for(const applied of [true,false]){
    const f=fixture();f.receipt.status='failed';f.receipt.intent={upload:true,disable:true,routes:{'gdacs-list':{attach:true}}};f.state.worker=f.candidate();f.receipt.candidate=clone(f.state.worker);f.state.boundary.routes.push(clone(newRoute));
    const detach=f.ops.detach;f.ops.detach=async id=>{if(applied)await detach(id);else f.calls.push('detach:'+id);throw Error('lost');};
    if(applied){await recover(f.receipt,f.ops,f.persist);assert.equal(f.receipt.status,'failed-contained');}
    else{await assert.rejects(recover(f.receipt,f.ops,f.persist),/incomplete/);assert.equal(f.receipt.status,'rollback-incomplete');}
    assert.equal(f.calls.length,1);
  }
});
test('foreign route ID or script cannot be deleted even with a matching pattern',async()=>{
  for(const change of [route=>route.script='another-worker',route=>route.id='5'.repeat(32),route=>route.pattern='weatherx.org/changed/*']){
    const f=fixture();f.receipt.status='failed';f.receipt.intent={upload:true,routes:{'gdacs-list':{attach:true}}};f.receipt.routes={'gdacs-list':clone(newRoute)};f.state.worker=f.candidate();const route=clone(newRoute);change(route);f.state.boundary.routes.push(route);
    await assert.rejects(recover(f.receipt,f.ops,f.persist),/incomplete/);assert.deepEqual(f.calls,[]);
  }
});
test('receipt without upload ownership cannot contain or delete a foreign Worker',async()=>{
  const f=fixture();f.receipt.status='failed';f.state.worker=f.candidate();await recover(f.receipt,f.ops,f.persist);assert.equal(f.receipt.status,'failed-no-mutation');assert.deepEqual(f.calls,[]);
});
test('regression: guard bundle options exactly match runtime qualification',()=>{
  assert.deepEqual(buildOptions('/source'),{absWorkingDir:'/source/platform/edge',entryPoints:['src/gdacsFeed.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',write:false,metafile:true,tsconfigRaw:{}});
});
test('regression: additional committed bundle input still violates three-file isolation',()=>{
  const paths=['platform/edge/src/gdacsFeed.ts','app/functions/api/_weatherFeeds.ts','app/functions/api/_swr.ts','platform/edge/src/index.ts'];
  const inputs=['src/gdacsFeed.ts','../../app/functions/api/_weatherFeeds.ts','../../app/functions/api/_swr.ts','src/index.ts'];
  assert.throws(()=>assertBuildInputs(Object.fromEntries(inputs.map(path=>[path,{}])),'/source',new Set(paths)),/input|isolation/);
});
test('regression: version annotation establishes ownership without settings annotations',()=>{
  const f=fixture();f.receipt.intent={upload:true};const worker=f.candidate();delete worker.settings.annotations;
  assert.doesNotThrow(()=>assertOwnedWorker(worker,f.receipt));
  worker.settings.annotations={'workers/tag':f.receipt.ownershipTag};worker.versionAnnotations['workers/tag']='foreign';
  assert.throws(()=>assertOwnedWorker(worker,f.receipt),/version ownership/);
});
test('regression: module readback uses only injected transport credentials',async()=>{
  let authorization;
  const transport=createTransport({tokens:{PLATFORM_EDGE_TOKEN:'injected-test-token'},fetchImpl:async(url,init)=>{authorization=init.headers.Authorization;return new Response('module bytes',{headers:{'content-type':'application/javascript'}});}});
  await moduleHash(transport);assert.equal(authorization,'Bearer injected-test-token');
});
test('regression: unrelated protected-state drift still detaches our unchanged route',async()=>{
  for(const change of [b=>b.pointer.sha256='new-pointer',b=>b.pages.id='new-pages',b=>b.consumers.platform.version='foreign',b=>b.routes.push({id:'7'.repeat(32),pattern:'weatherx.org/foreign/*',script:'foreign'})]){
    const f=fixture();f.ops.verify=async()=>{change(f.state.boundary);throw Error('foreign drift');};
    await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.ok(f.calls.includes('detach:'+newRoute.id));assert.ok(f.receipt.foreignDrift);assert.equal(f.receipt.status,'failed-contained-manual-review');assert.ok(!f.state.boundary.routes.some(route=>route.id===newRoute.id));
  }
});
test('regression: pre-mutation refusal is not reported as incomplete rollback',async()=>{
  const f=fixture();f.state.boundary.pointer.sha256='new-pointer';await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(f.receipt.status,'failed-no-mutation');assert.equal(f.receipt.recovery,'no-owned-mutation');assert.deepEqual(f.calls,['reset-recovery']);
});
test('containment still removes owned route when consumer boundary read fails',async()=>{
  const f=fixture();f.receipt.status='failed';f.receipt.intent={upload:true,routes:{'gdacs-list':{attach:true}}};f.state.worker=f.candidate();f.receipt.candidate=clone(f.state.worker);f.state.boundary.routes.push(clone(newRoute));f.ops.boundary=async()=>{throw Error('foreign consumer mode');};
  await recover(f.receipt,f.ops,f.persist);assert.deepEqual(f.calls,['detach:'+newRoute.id]);assert.equal(f.receipt.status,'failed-contained-manual-review');assert.equal(f.receipt.foreignDrift.kind,'protected-boundary-read-failed');
});
test('regression: plain and query GDACS reads require isolated feed provenance each round',async()=>{
  for(const missing of ['', '?guard=query']){
    const reads=[];let originalVerifierCalls=0;
    const transport={request:async url=>{const path=new URL(url).pathname;reads.push(url);const payload=path.endsWith('/data-health')?{ok:true,authMode:'public',catalogMode:'serve'}:path.endsWith('/health')?{ok:true,authMode:'observe',billingMode:'disabled'}:{type:'FeatureCollection',features:[]};return {status:200,body:Buffer.from(JSON.stringify(payload)),headers:new Headers({'x-swr-age':'0',...(url.endsWith('/api/gdacs/list'+missing)?{}:{'x-weatherx-feed':'weather-feeds-v2'})})};}};
    await assert.rejects(verifyLive(transport,'/source',{proof:{points:[]}},{verifyWeatherFeeds:async()=>{originalVerifierCalls++;return [];}}),/provenance/);
    assert.equal(originalVerifierCalls,1);assert.ok(reads.some(url=>url==='https://weatherx.org/api/gdacs/list'));
  }
});
test('fixed manifest permits exactly the three approved query-capable patterns',()=>{
  assert.deepEqual(ROUTE_MANIFEST.map(entry=>entry.pattern),['weatherx.org/api/gdacs/list*','weatherx.org/api/gdacs/geom*','weatherx.org/api/tc/geom*']);
  for(const entry of ROUTE_MANIFEST){
    assert.equal(routeMatches(entry.pattern,'https://weatherx.org'+entry.path+'?eventid=1&episodeid=1'),true);
    assert.throws(()=>assertBootstrap(null,[{id:'9'.repeat(32),pattern:entry.pattern,script:'foreign'}]));
  }
  for(const path of ['/api/tc/list','/api/eonet/list','/api/v1/point-series/gfs','/api/platform/health'])assert.ok(ROUTE_MANIFEST.every(entry=>!routeMatches(entry.pattern,'https://weatherx.org'+path)));
});
test('failed first, second or third attachment contains only preceding owned routes in reverse',async()=>{
  for(let failed=0;failed<3;failed++){
    const f=fixture();const attach=f.ops.attach;
    f.ops.attach=async entry=>{if(entry.id===ROUTE_MANIFEST[failed].id){f.calls.push('rejected:'+entry.id);throw Error('rejected');}await attach(entry);};
    await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(f.receipt.status,'failed-contained');
    assert.equal(f.receipt.failedStage,'attach-route:'+ROUTE_MANIFEST[failed].id);
    assert.deepEqual(f.calls.filter(call=>call.startsWith('detach:')),newRoutes.slice(0,failed).reverse().map(route=>'detach:'+route.id));
    assert.deepEqual(f.state.boundary.routes,[originalRoute]);assert.ok(!f.calls.includes('verify'));
  }
});
test('cancelled partial attachment reconciles every lost response from per-route durable intent',async()=>{
  for(let count=1;count<=3;count++){
    const f=fixture();f.receipt.status='executing';f.receipt.intent={upload:true,disable:true,routes:{}};f.receipt.routes={};f.state.worker=f.candidate();f.receipt.candidate=clone(f.state.worker);
    for(let index=0;index<count;index++){
      const entry=ROUTE_MANIFEST[index];f.receipt.intent.routes[entry.id]={attach:true};f.state.boundary.routes.push(clone(newRoutes[index]));
      if(index<count-1)f.receipt.routes[entry.id]=clone(newRoutes[index]);
    }
    await recover(f.receipt,f.ops,f.persist);assert.equal(f.receipt.status,'failed-contained');
    assert.deepEqual(f.calls,newRoutes.slice(0,count).reverse().map(route=>'detach:'+route.id));assert.deepEqual(f.state.boundary.routes,[originalRoute]);
  }
});
test('one failed deletion does not strand the other owned routes',async()=>{
  const f=fixture();f.ops.verify=async()=>{throw Error('failed gate');};const detach=f.ops.detach;
  f.ops.detach=async id=>{if(id===newRoutes[2].id){f.calls.push('detach:'+id);throw Error('rejected');}await detach(id);};
  await assert.rejects(execute(f.receipt,f.ops,f.persist),/recovery incomplete/);
  assert.deepEqual(f.calls.filter(call=>call.startsWith('detach:')),[...newRoutes].reverse().map(route=>'detach:'+route.id));
  assert.deepEqual(f.receipt.failedRecoveryRoutes,['tc-geom']);assert.deepEqual(f.state.boundary.routes,[originalRoute,newRoutes[2]]);
});
test('foreign replacement of one owned route never prevents containing other unchanged routes',async()=>{
  const f=fixture();f.ops.verify=async()=>{f.state.boundary.routes.find(route=>route.id===newRoutes[1].id).script='foreign';throw Error('foreign replacement');};
  await assert.rejects(execute(f.receipt,f.ops,f.persist),/recovery incomplete/);
  assert.deepEqual(f.calls.filter(call=>call.startsWith('detach:')),['detach:'+newRoutes[2].id,'detach:'+newRoutes[0].id]);
  assert.equal(f.state.boundary.routes.find(route=>route.id===newRoutes[1].id).script,'foreign');assert.deepEqual(f.receipt.failedRecoveryRoutes,['gdacs-geom']);
});
test('qualification rejects disappearing owned routes and unmanifested additions',async()=>{
  const f=fixture();await execute(f.receipt,f.ops,f.persist);
  f.state.boundary.routes=f.state.boundary.routes.filter(route=>route.id!==newRoutes[1].id);
  assert.throws(()=>assertBoundary(f.state.boundary,f.receipt,true),/disappeared/);
  f.state.boundary.routes.push(clone(newRoutes[1]),{id:'9'.repeat(32),pattern:'weatherx.org/api/tc/list*',script:WORKER});
  assert.throws(()=>assertBoundary(f.state.boundary,f.receipt,true),/boundary drift/);
});
test('real geometry query responses in the original verifier require the new provenance marker',async()=>{
  for(const affected of ['/api/gdacs/geom?eventtype=FL&eventid=1&episodeid=1','/api/tc/geom?eventid=2&episodeid=1']){
    const transport={request:async url=>{const path=new URL(url).pathname;const payload=path.endsWith('/data-health')?{ok:true,authMode:'public',catalogMode:'serve'}:path.endsWith('/health')?{ok:true,authMode:'observe',billingMode:'disabled'}:{type:'FeatureCollection',features:[]};return {status:200,body:Buffer.from(JSON.stringify(payload)),headers:new Headers({'x-swr-age':'0',...(url.endsWith(affected)?{}:{'x-weatherx-feed':'weather-feeds-v2'})})};}};
    const verification={verifyWeatherFeeds:async origin=>{await fetch(origin+affected);return [];}};
    await assert.rejects(verifyLive(transport,'/source',{proof:{points:[]}},verification),/provenance/);
  }
});
