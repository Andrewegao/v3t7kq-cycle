import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {gate,TARGETS,SOURCE,RELEASE,INDEX,FILES,addDiagnostics,PREFILL_WAIT,PREFILL_ACTIVATE,filterLine,assertIdentity,checkAfterIdentity} from '../tools/ui-layer-diagnostics.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const env=()=>({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',
 GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_JOB:'diagnose',
 GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/ui-layer-diagnostics.yml@refs/heads/main',DIAGNOSTIC_TARGET:'staging'});
test('only fixed reviewed origins and manual main runner are accepted',()=>{
 for(const target of Object.keys(TARGETS))assert.equal(gate({...env(),DIAGNOSTIC_TARGET:target}),TARGETS[target]);
 for(const target of ['production','https://weatherx.org','https://staging.weatherx.org.evil.test','__proto__','',undefined])
  assert.throws(()=>gate({...env(),DIAGNOSTIC_TARGET:target}));
 for(const key of Object.keys(env()))assert.throws(()=>gate({...env(),[key]:''}),key);
 for(const key of ['BASE','ANGLE','CPU_THROTTLE','CLOUDFLARE_API_TOKEN','UI_CANDIDATE_KEY','UI_BUILD_PRIVATE_KEY',
  'R2_PRODUCTION_ACCESS_KEY_ID','R2_PRODUCTION_SECRET_ACCESS_KEY'])assert.throws(()=>gate({...env(),[key]:'unexpected'}),key);
});
test('original prefill wait survives instrumentation byte-for-byte and anchor drift fails closed',()=>{
 const source='const page = await context.newPage();\nconst threshold = 0.12;\n'+PREFILL_ACTIVATE+'\n'+PREFILL_WAIT+'\nthrow new Error("original assertion");';
 const output=addDiagnostics(source,'// observation code');
 assert.ok(output.includes(PREFILL_WAIT));
 assert.ok(output.includes(PREFILL_ACTIVATE+'\n'+PREFILL_WAIT));
 assert.ok(output.indexOf("await diagnosticSnapshot(id, 'before'")<output.indexOf(PREFILL_ACTIVATE));
 assert.ok(output.indexOf('const diagnosticStarted = Date.now();')>output.indexOf("await diagnosticSnapshot(id, 'before'"));
 assert.throws(()=>addDiagnostics(source.replace(PREFILL_ACTIVATE+'\n'+PREFILL_WAIT,PREFILL_ACTIVATE+'\nawait extraObservation();\n'+PREFILL_WAIT),''));assert.ok(output.includes('const threshold = 0.12;'));
 assert.ok(output.endsWith('throw new Error("original assertion");'));
 assert.equal((output.match(/timeout: 30_000/g)||[]).length,1);
 assert.ok(output.includes('throw error;'));
 assert.throws(()=>addDiagnostics(source.replace('30_000','60_000'),''));
 assert.throws(()=>addDiagnostics(source+PREFILL_WAIT,''));
 assert.throws(()=>addDiagnostics(source.replace('const page = await context.newPage();',''),''));
});
test('unreviewed deployment identity and mismatched served HTML are rejected',()=>{
 const receipt={gitSha:SOURCE,releaseId:RELEASE,indexSha256:INDEX};
 assert.throws(()=>assertIdentity(receipt,Buffer.from('not the reviewed HTML')));
 for(const key of Object.keys(receipt))assert.throws(()=>assertIdentity({...receipt,[key]:'changed'},Buffer.from('')));
 assert.deepEqual(Object.keys(FILES),['app/e2e/layer-switch-tint.mjs','app/e2e/layer-switch-surface.mjs']);
 for(const value of Object.values(FILES))assert.match(value,/^[a-f0-9]{64}$/);
});
test('only tagged bounded diagnostic rows are retained from guard output',()=>{
 assert.equal(filterLine('raw stack, source or console text'),null);
 assert.equal(filterLine('WX_LAYER_DIAGNOSTIC {"event":"fatal"}'),'{'+'"event":"fatal"}\n');
 assert.throws(()=>filterLine('WX_LAYER_DIAGNOSTIC '+ 'x'.repeat(65536)));
 assert.throws(()=>filterLine('WX_LAYER_DIAGNOSTIC []'));
});
test('browser instrumentation blocks mutations and strips query/header/body/console content',async()=>{
 const runtime=read('tools/ui-layer-diagnostics-browser.txt');
 execFileSync(process.execPath,['--input-type=module','--check'],{input:runtime});
 const events={},logs=[];let route;
 const context={route:async(_pattern,handler)=>{route=handler;}};
 const page={on:(event,handler)=>{events[event]=handler;},evaluate:async()=>({visible:['wind'],swap:'idle'})};
 const monitors={};
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await new AsyncFunction('context','page','process','console','BASE',runtime+'\nreturn diagnosticSnapshot("temp","timeout",Date.now());')
 (context,page,{on:(event,handler)=>{monitors[event]=handler;}},{log:value=>logs.push(value)},TARGETS.staging);
 let aborted=false,continued=false;
 await route({request:()=>({method:()=> 'POST'}),abort:()=>{aborted=true;},continue:()=>{continued=true;}});
 assert.ok(aborted&&!continued);
 events.requestfailed({url:()=>TARGETS.staging+'/data/x.png?token=secret-value',failure:()=>({errorText:'net::ERR_ABORTED'})});
 events.response({status:()=>503,url:()=>TARGETS.staging+'/api/private?secret=secret-value'});
 events.console({text:()=> 'WebGL error INVALID_OPERATION secret-value https://secret.test/token'});
 events.pageerror({name:'TypeError',message:'secret-value'});
 monitors.uncaughtExceptionMonitor({name:'TimeoutError',message:'secret-value'});
 const retained=logs.join('\n');assert.ok(!retained.includes('secret-value'));assert.ok(!retained.includes('secret.test'));
 assert.ok(retained.includes('INVALID_OPERATION'));assert.ok(retained.includes('503'));
 assert.ok(retained.includes('\"category\":\"timeout\"'));
});
test('workflow has no publish authority, arbitrary target/source or production approval surface',()=>{
 const workflow=read('.github/workflows/ui-layer-diagnostics.yml');
 assert.match(workflow,/permissions:\n  contents: read/);
 assert.match(workflow,/github.event_name == 'workflow_dispatch' && github.ref == 'refs\/heads\/main'/);
 assert.ok(workflow.includes('ref: '+SOURCE));
 assert.deepEqual([...new Set([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(m=>m[1]))],['ATMOS_DEPLOY_KEY']);
 assert.match(workflow,/^    environment: staging$/m);
 assert.equal((workflow.match(/^    environment:/gm)||[]).length,1);
 assert.doesNotMatch(workflow,/environment: production|name: ui-production|ui-release.mjs|wrangler|actions: write|issues: write|workflow_call|pull_request|schedule:/);
 assert.equal((workflow.match(/persist-credentials: false/g)||[]).length,2);
 assert.match(workflow,/if: \$\{\{ always\(\) \}\}/);
 assert.match(workflow,/timeout-minutes: 20/);
 const helper=read('tools/ui-layer-diagnostics.mjs');
 assert.ok(helper.includes("assert.equal(hash(readFileSync(resolve(root,path))),expected"));
 assert.ok(helper.includes('15*60_000'));assert.ok(helper.includes('1024*1024'));
 assert.doesNotMatch(helper,/\.\.\.process\.env/);
});

test('post-run identity requires the same receipt and actual HTML even after a failed guard',async()=>{
 const before={receiptSha256:'a',indexSha256:'b'};
 assert.deepEqual(await checkAfterIdentity(before,async()=>({...before})),{ok:true});
 assert.equal((await checkAfterIdentity(before,async()=>({...before,indexSha256:'changed'}))).ok,false);
 assert.equal((await checkAfterIdentity(before,async()=>{throw new Error('transport failed');})).ok,false);
 const helper=read('tools/ui-layer-diagnostics.mjs');
 assert.match(helper,/finally \{\n  if\(before\)result.identityAfter=await checkAfterIdentity/);
 assert.ok(helper.includes("result.deadlineExceeded=true"));
});

test('pending requests are bounded, sanitized, and removed on completion or failure',async()=>{
 const events={},logs=[];
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const snapshot=await new AsyncFunction('context','page','process','console','BASE',read('tools/ui-layer-diagnostics-browser.txt')+'\nreturn diagnosticSnapshot;')
 ({route:async()=>{}},{on:(event,handler)=>{events[event]=handler;},evaluate:async()=>({})},{on:()=>{}},{log:row=>logs.push(JSON.parse(row.slice(20)))},TARGETS.staging);
 const request=id=>({url:()=>TARGETS.staging+'/data/'+id+'.png?secret=do-not-log',failure:()=>({errorText:'net::ERR_ABORTED'})});
 const requests=Array.from({length:300},(_,i)=>request(i));
 requests.forEach(row=>events.request(row));
 await snapshot('wind','timeout',Date.now());
 let pending=logs.at(-1).pending;
 assert.equal(pending.length,40);assert.equal(pending[0].path,'/data/260.png');
 assert.ok(pending.every(row=>row.elapsedMs>=0));assert.ok(!JSON.stringify(logs).includes('do-not-log'));
 events.requestfinished(requests[299]);events.requestfailed(requests[298]);
 await snapshot('wind','timeout',Date.now());
 pending=logs.at(-1).pending;
 assert.equal(pending.at(-1).path,'/data/297.png');assert.equal(pending.length,40);
});
test('a wedged renderer still emits a bounded timeout snapshot',async()=>{
 const logs=[];let timeout,cleared=false;
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await new AsyncFunction('context','page','process','console','BASE','setTimeout','clearTimeout',
  read('tools/ui-layer-diagnostics-browser.txt')+'\nawait diagnosticSnapshot("temp","timeout",Date.now());')
 ({route:async()=>{}},{on:()=>{},evaluate:()=>new Promise(()=>{})},{on:()=>{}},{log:row=>logs.push(JSON.parse(row.slice(20)))},TARGETS.staging,
  (callback,ms)=>{timeout=ms;queueMicrotask(callback);return 1;},id=>{cleared=id===1;});
 assert.equal(timeout,2000);assert.ok(cleared);
 assert.deepEqual(logs.at(-1).state,{unavailable:true,reason:'snapshot-timeout'});
 assert.equal(logs.at(-1).phase,'timeout');
});
test('decode and texture snapshots retain only finite allowlisted numeric fields',async()=>{
 const logs=[];
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const app={store:{getState:()=>({})},deckSnapshot:()=>[],decodeWorkerStats:()=>({workers:2,pending:3,textureJobs:Infinity,fieldJobs:'secret'}),
  weatherTextureBudgetStats:()=>({bytes:123,ceiling:456,recycleQueued:true,private:'secret'})};
 await new AsyncFunction('context','page','process','console','BASE','window','document','performance',
  read('tools/ui-layer-diagnostics-browser.txt')+'\nawait diagnosticSnapshot("temp","timeout",Date.now());')
 ({route:async()=>{}},{on:()=>{},evaluate:callback=>callback()},{on:()=>{}},{log:row=>logs.push(JSON.parse(row.slice(20)))},TARGETS.staging,
  {__atmos:app},{body:{dataset:{}}},{getEntriesByName:()=>[]});
 assert.deepEqual(logs.at(-1).state.decode,{workers:2,pending:3,textureJobs:null,fieldJobs:null});
 assert.equal(logs.at(-1).state.textures.bytes,123);
 assert.ok(!JSON.stringify(logs).includes('secret'));assert.ok(!('recycleQueued' in logs.at(-1).state.textures));
});
