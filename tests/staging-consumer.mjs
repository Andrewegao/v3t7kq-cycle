import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {consumerGate,SOURCE_SHA,WORKER,EXISTING_ROUTES,configForStaging,desiredSettings,settingsState,guardedRepair,consumerSnapshot,assertAllowedTransition,sharedSecretsForUpload} from '../tools/staging-consumer.mjs';
import {normalizedBindings} from '../tools/consumer-refresh.mjs';
import {SHARED_READ_SECRETS,SHARED_READ_VARS} from '../tools/staging-shared-read.mjs';
import * as repair from '../tools/staging-consumer.mjs';
const OLD='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',NEW='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',OTHER='cccccccc-cccc-cccc-cccc-cccccccccccc';
const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_JOB:'refresh',GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/staging-consumer-refresh.yml@refs/heads/main',STAGING_CONSUMER_ENABLED:'true',STAGING_CONSUMER_SOURCE_SHA:SOURCE_SHA,CONFIRM:'REFRESH-STAGING-CONSUMER',STAGING_R2_ACCOUNT_ID:'a89f9a1af485021fbc60a68b163c7c6e',STAGING_CONSUMER_APPROVED_VERSION:OLD,STAGING_CONSUMER_APPROVED_SETTINGS_SHA256:'a'.repeat(64),GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1'};
const settings={bindings:[{name:'AUTH_MODE',type:'plain_text',text:'enforce'},{name:'BILLING_MODE',type:'plain_text',text:'enabled'},{name:'DATA_BUCKET',type:'r2_bucket',bucket_name:'weatherx-data-staging'}],compatibility_date:'2026-08-15'};
const workflow=readFileSync(new URL('../.github/workflows/staging-consumer-refresh.yml',import.meta.url),'utf8');
test('workflow checkout and controller approval use the exact reviewed source pin',()=>{
  assert.equal(workflow.match(/STAGING_CONSUMER_SOURCE_SHA: ([a-f0-9]{40})/)?.[1],SOURCE_SHA);
  assert.equal(workflow.match(/repository: Andrewegao\/atmos\s+ref: ([a-f0-9]{40})/)?.[1],SOURCE_SHA);
});
test('staging refresh preserves the complete live weather and hazard route boundary',()=>{
  assert.deepEqual([...EXISTING_ROUTES].sort(),[
    'staging.weatherx.org/api/eonet/*','staging.weatherx.org/api/gdacs/*',
    'staging.weatherx.org/api/platform/*','staging.weatherx.org/api/tc/*',
    'staging.weatherx.org/api/v1/*','staging.weatherx.org/cdn/*',
    'staging.weatherx.org/data-atmos/*','staging.weatherx.org/data/*',
  ]);
});
test('locked controller dependencies are installed before the gate module is imported',()=>{
  const install=workflow.indexOf('npm ci --ignore-scripts --prefix cycle/staging-controller');
  const gate=workflow.indexOf("import {consumerGate} from './cycle/tools/staging-consumer.mjs'");
  assert.ok(install >= 0 && gate > install);
});
test('the full edge check receives its pinned Python and image dependency first',()=>{
  const setup=workflow.indexOf('actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065');
  const pillow=workflow.indexOf('python -m pip install pillow');
  const check=workflow.indexOf('npm run check --prefix control/platform/edge');
  assert.ok(setup >= 0 && pillow > setup && check > pillow);
});
test('workflow supplies the existing read-only credential only to the inactive upload step',()=>{
  const execute=workflow.split('      - name: Guarded staging-only inactive upload and public-mode repair\n')[1]?.split('\n      - ')[0]??'';
  assert.match(execute,/SHARED_READ_ACCESS_KEY_ID: \$\{\{ secrets\.SHARED_R2_READ_ACCESS_KEY_ID \}\}/);
  assert.match(execute,/SHARED_READ_SECRET_ACCESS_KEY: \$\{\{ secrets\.SHARED_R2_READ_SECRET_ACCESS_KEY \}\}/);
  assert.equal((workflow.match(/secrets\.SHARED_R2_READ_ACCESS_KEY_ID/g)??[]).length,1);
  assert.equal((workflow.match(/secrets\.SHARED_R2_READ_SECRET_ACCESS_KEY/g)??[]).length,1);
  assert.doesNotMatch(workflow,/R2_PRODUCTION_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)/);
});
test('guard requires hosted manual main, exact workflow/job/source/settings approval',()=>{
  consumerGate(env);
  for(const key of Object.keys(env)){assert.throws(()=>consumerGate({...env,[key]:'wrong'}),key);}
});
test('configuration target cannot be switched to production or another resource',()=>{
  const base={name:'base',workers_dev:false,env:{staging:{name:WORKER,vars:{APP_ORIGIN:'https://staging.weatherx.org',AUTH_MODE:'public',BILLING_MODE:'disabled',DATA_CATALOG_MODE:'serve'},r2_buckets:[{bucket_name:'weatherx-data-staging'},{bucket_name:'weatherx-components-staging'}],d1_databases:[{database_id:'9501827a-7e4c-4249-806b-d45d5857d9e5'}],routes:[{pattern:'staging.weatherx.org/data/*',zone_id:'9dc4df7c3c094ab9a11dd00d378adc26'}]}}};
  assert.equal(configForStaging(base).name,WORKER);
  const namedZone=structuredClone(base);delete namedZone.env.staging.routes[0].zone_id;namedZone.env.staging.routes[0].zone_name='weatherx.org';
  assert.equal(configForStaging(namedZone).name,WORKER);
  namedZone.env.staging.routes[0].zone_name='another.org';assert.throws(()=>configForStaging(namedZone));
  for(const mutation of [b=>b.env.staging.name='weatherx-platform-edge-production',b=>b.env.staging.r2_buckets[0].bucket_name='weatherx-data-production',b=>b.env.staging.vars.AUTH_MODE='observe',b=>b.env.staging.routes[0].pattern='weatherx.org/data/*',
    b=>b.env.staging.r2_buckets.push({binding:'SHARED',bucket_name:'weatherx-data-production'}),b=>b.env.staging.vars.DATA_SOURCE_MODE='mirror',b=>b.env.staging.vars.SHARED_READ_DATA_BUCKET='weatherx-data-production']){const v=structuredClone(base);mutation(v);assert.throws(()=>configForStaging(v));}
});
function sharedBase(){
  return {name:'base',workers_dev:false,compatibility_date:settings.compatibility_date,env:{staging:{name:WORKER,secrets:{required:['AUTH_HASH_KEY',...SHARED_READ_SECRETS]},vars:{APP_ORIGIN:'https://staging.weatherx.org',AUTH_MODE:'public',BILLING_MODE:'disabled',DATA_CATALOG_MODE:'serve',...SHARED_READ_VARS},
    r2_buckets:[{binding:'DATA_BUCKET',bucket_name:'weatherx-data-staging'},{binding:'COMPONENT_BUCKET',bucket_name:'weatherx-components-staging'}],d1_databases:[{binding:'PLATFORM_DB',database_id:'9501827a-7e4c-4249-806b-d45d5857d9e5'}],routes:[{pattern:'staging.weatherx.org/data/*',zone_name:'weatherx.org'}]}}};
}
test('shared-read staging shape is complete or refused; production buckets stay unbindable',()=>{
  assert.equal(configForStaging(sharedBase()).vars.DATA_SOURCE_MODE,'shared');
  for(const mutation of [b=>delete b.env.staging.vars.SHARED_READ_ACCOUNT_ID,b=>b.env.staging.vars.SHARED_READ_ACCOUNT_ID='b'.repeat(32),b=>b.env.staging.vars.SHARED_READ_DATA_BUCKET='weatherx-data-staging',
    b=>b.env.staging.vars.SHARED_READ_EXTRA='x',b=>b.env.staging.secrets.required=['AUTH_HASH_KEY'],b=>b.env.staging.r2_buckets.push({binding:'SHARED_DATA_BUCKET',bucket_name:'weatherx-data-production'})]){const v=sharedBase();mutation(v);assert.throws(()=>configForStaging(v));}
});
test('shared-read rollout adds exactly the reviewed variables and secrets on top of the public-mode pair',()=>{
  // The live Worker before rollout: public-mode pair still old, no shared-read bindings at all.
  const live=[...settings.bindings,{name:'AUTH_HASH_KEY',type:'secret_text'},{name:'COMPONENT_BUCKET',type:'r2_bucket',bucket_name:'weatherx-components-staging'},
    {name:'APP_ORIGIN',type:'plain_text',text:'https://staging.weatherx.org'},{name:'DATA_CATALOG_MODE',type:'plain_text',text:'serve'},{name:'PLATFORM_DB',type:'d1',id:'9501827a-7e4c-4249-806b-d45d5857d9e5'}];
  const config=configForStaging(sharedBase()),state=settingsState({...settings,bindings:live},['staging.weatherx.org/data/*'],[]);
  const desired=desiredSettings(state,config);
  for(const [name,text] of Object.entries(SHARED_READ_VARS))assert.deepEqual(desired.bindings.find(b=>b.name===name),{name,type:'plain_text',text});
  for(const name of SHARED_READ_SECRETS)assert.deepEqual(desired.bindings.find(b=>b.name===name),{name,type:'secret_text'});
  assert.deepEqual(desired.bindings,JSON.parse(JSON.stringify(normalizedBindings(desired.bindings))),'desired bindings must be normalized for comparison');
  assertAllowedTransition(config,state,desired);
  const reviewed=JSON.parse(JSON.stringify(desired));
  assertAllowedTransition(config,state,reviewed);
  assert.throws(()=>assertAllowedTransition(config,state,{...desired,bindings:[...desired.bindings,{name:'SHARED_DATA_BUCKET',type:'r2_bucket',bucket_name:'weatherx-data-production'}]}));
  assert.throws(()=>assertAllowedTransition(config,state,{...desired,bindings:desired.bindings.filter(b=>b.name!=='SHARED_READ_SECRET_ACCESS_KEY')}));
  const ownConfig=configForStaging({name:'base',workers_dev:false,env:{staging:{...sharedBase().env.staging,vars:{APP_ORIGIN:'https://staging.weatherx.org',AUTH_MODE:'public',BILLING_MODE:'disabled',DATA_CATALOG_MODE:'serve'}}}});
  assert.ok(!desiredSettings(state,ownConfig).bindings.some(b=>b.name.startsWith('SHARED_READ_')),'own-copy configuration adds nothing');
});
test('shared-read upload requires both bounded secret values while own-copy needs none',()=>{
  const config=configForStaging(sharedBase());
  const values={SHARED_READ_ACCESS_KEY_ID:'access-key-id-value',SHARED_READ_SECRET_ACCESS_KEY:'secret-access-key-value'};
  assert.deepEqual(sharedSecretsForUpload(config,values),values);
  for(const name of SHARED_READ_SECRETS)assert.throws(()=>sharedSecretsForUpload(config,{...values,[name]:''}),name);
  const own={vars:{DATA_SOURCE_MODE:'own'}};
  assert.equal(sharedSecretsForUpload(own,{}),null);
});
test('only the two known mode values change; snapshots survive JSON receipt serialization',()=>{
  const state=settingsState(settings,['staging.weatherx.org/data/*'],['17 3 * * *']);
  assert.deepEqual(state,JSON.parse(JSON.stringify(state)));
  const desired=desiredSettings(state);assert.equal(desired.bindings.find(b=>b.name==='AUTH_MODE').text,'public');
  assert.equal(desired.bindings.find(b=>b.name==='BILLING_MODE').text,'disabled');
  assert.deepEqual(desired.bindings.find(b=>b.name==='DATA_BUCKET'),state.bindings.find(b=>b.name==='DATA_BUCKET'));
  const bad=structuredClone(settings);bad.bindings[0].text='unrecognized';assert.throws(()=>desiredSettings(bad));
});
function fixture(){const before={version:OLD,state:settingsState(settings,[],[])},desired=desiredSettings(before.state),calls=[],receipts=[];let current=before;return{before,desired,calls,receipts,get current(){return current;},set current(v){current=v;},ops:{before,desired,upload:async()=>{calls.push('upload');return NEW;},snapshot:async()=>current,activate:async()=>{calls.push('activate');current={version:NEW,state:desired};},verify:async()=>calls.push('verify'),rollback:async()=>{calls.push('rollback');current=before;},persist:async r=>receipts.push(structuredClone(r))}};}
test('inactive upload precedes activation and live proof precedes success',async()=>{const f=fixture();const r=await guardedRepair(f.ops);assert.equal(r.status,'passed');assert.deepEqual(f.calls,['upload','activate','verify']);assert.equal(f.receipts[0].status,'preflight-passed');assert.equal(f.receipts.at(-1).status,'passed');});
test('live failure and activation acknowledgement loss restore only our prior version',async()=>{
  for(const phase of ['verify','activate']){const f=fixture(),original=f.ops[phase];f.ops[phase]=async()=>{await original();throw Error('fixture failure');};await assert.rejects(guardedRepair(f.ops));assert.deepEqual(f.current,f.before);assert.equal(f.receipts.at(-1).status,'failed-restored');assert.ok(f.calls.includes('rollback'));}
});
test('concurrent publisher is never overwritten during failure recovery',async()=>{const f=fixture();f.ops.verify=async()=>{f.current={version:OTHER,state:f.desired};throw Error('failed');};await assert.rejects(guardedRepair(f.ops),/another publisher/);assert.ok(!f.calls.includes('rollback'));});
test('inactive upload boundary drift blocks activation',async()=>{const f=fixture();f.ops.upload=async()=>{f.current={version:OTHER,state:f.desired};return NEW;};await assert.rejects(guardedRepair(f.ops),/inactive upload/);assert.ok(!f.calls.includes('activate'));});
test('unexpected runtime bindings after successful health also trigger rollback',async()=>{const f=fixture();f.ops.verify=async()=>{f.current={version:NEW,state:{...f.desired,unexpected:true}};};await assert.rejects(guardedRepair(f.ops));assert.deepEqual(f.current,f.before);});
test('failed rich snapshot cannot prevent identity-only recovery of our own version',async()=>{
  const f=fixture(),base=f.ops.snapshot;f.ops.snapshot=async()=>{if(f.current.version===NEW)throw Error('unreviewed binding type');return base();};
  f.ops.getVersion=async()=>f.current.version;
  await assert.rejects(guardedRepair(f.ops));assert.ok(f.calls.includes('rollback'));assert.deepEqual(f.current,f.before);
});
function apiFixture(){
  const config={compatibility_date:settings.compatibility_date,vars:{AUTH_MODE:'public',BILLING_MODE:'disabled'},r2_buckets:[{binding:'DATA_BUCKET',bucket_name:'weatherx-data-staging'}]};
  const f={config,latest:structuredClone(settings),active:OLD,deploymentId:OLD,reads:0,routes:EXISTING_ROUTES.map(pattern=>({pattern,script:WORKER})),schedules:{schedules:[]}};
  f.version={id:OLD,resources:{bindings:structuredClone(settings.bindings),script_runtime:{compatibility_date:settings.compatibility_date,compatibility_flags:[]}}};
  f.get=async url=>{
    if(url.endsWith('/settings'))return f.latest;
    if(url.endsWith('/deployments')){f.reads++;return {deployments:[{id:f.deploymentId,created_on:'2026-08-31T00:00:00Z',versions:[{version_id:f.active,percentage:100}]}]};}
    if(url.endsWith('/workers/routes'))return f.routes;
    if(url.endsWith('/schedules'))return f.schedules;
    if(url.endsWith('/versions/'+OLD))return f.version;
    throw Error('unexpected read');
  };return f;
}
test('actual snapshot uses serving version while settings tracks inactive upload',async()=>{
  const f=apiFixture(),before=await consumerSnapshot(f.config,f.get);
  f.latest=desiredSettings(f.latest);
  assert.deepEqual(await consumerSnapshot(f.config,f.get),before);
  assert.equal(before.state.bindings.find(b=>b.name==='AUTH_MODE').text,'enforce');
});
test('inactive-upload settings cannot hide active resource drift',async()=>{
  const f=apiFixture();f.latest=desiredSettings(f.latest);
  f.version.resources.bindings.find(b=>b.name==='DATA_BUCKET').bucket_name='weatherx-data-production';
  await assert.rejects(consumerSnapshot(f.config,f.get));
});
test('snapshot rejects concurrent deployment, wrong version response and missing runtime',async()=>{
  for(const kind of ['concurrent','same-version-redeployment','wrong-id','missing-runtime']){
    const f=apiFixture(),base=f.get;
    if(kind==='wrong-id')f.version.id=OTHER;
    if(kind==='missing-runtime')delete f.version.resources.script_runtime;
    f.get=async url=>{if(url.endsWith('/deployments')&&f.reads){if(kind==='concurrent')f.active=OTHER;if(kind==='same-version-redeployment')f.deploymentId=OTHER;}return base(url);};
    await assert.rejects(consumerSnapshot(f.config,f.get),kind);
  }
});
test('real snapshot rollback succeeds with latest-upload settings still pointing at new bindings',async()=>{
  const f=apiFixture(),before=await consumerSnapshot(f.config,f.get),desired=desiredSettings(before.state),old=structuredClone(f.version),base=f.get;
  f.get=async url=>url.endsWith('/versions/'+NEW)?f.version:base(url);
  const calls=[];
  await assert.rejects(guardedRepair({before,desired,snapshot:()=>consumerSnapshot(f.config,f.get),getVersion:async()=>f.active,
    upload:async()=>{f.latest=desiredSettings(f.latest);return NEW;},
    activate:async()=>{f.active=NEW;f.deploymentId=NEW;f.version={id:NEW,resources:{...old.resources,bindings:f.latest.bindings}};},
    verify:async()=>{throw Error('live proof failed');},
    rollback:async()=>{calls.push('rollback');f.active=OLD;f.deploymentId=OTHER;f.version=old;},persist:async()=>{}}),/live proof failed/);
  assert.deepEqual(calls,['rollback']);assert.deepEqual(await consumerSnapshot(f.config,f.get),before);
});
test('script-global settings routes and schedules remain guarded independently',async()=>{
  const f=apiFixture(),before=await consumerSnapshot(f.config,f.get);
  f.latest={...desiredSettings(f.latest),observability:{enabled:true}};
  assert.notDeepEqual(await consumerSnapshot(f.config,f.get),before);
  f.routes.push({script:WORKER,pattern:'weatherx.org/data/*'});
  await assert.rejects(consumerSnapshot(f.config,f.get),/route mismatch/);
  f.routes=EXISTING_ROUTES.map(pattern=>({script:WORKER,pattern}));f.schedules={schedules:[{cron:'* * * * *'}]};
  await assert.rejects(consumerSnapshot(f.config,f.get),/schedules changed/);
});
test('existing shared secrets are inherited without reading replacement values; partial state refuses',()=>{
  const config=configForStaging(sharedBase()),bindings=SHARED_READ_SECRETS.map(name=>({name,type:'secret_text'}));
  const inaccessible=new Proxy({}, {get(){throw Error('must not read secret values');}});
  assert.equal(sharedSecretsForUpload(config,inaccessible,{bindings}),null);
  assert.throws(()=>sharedSecretsForUpload(config,{}, {bindings:bindings.slice(0,1)}),/partial/);
  assert.equal(repair.sharedSecretState({bindings:[]}),'bootstrap');
  assert.throws(()=>repair.sharedSecretState({bindings:[{name:SHARED_READ_SECRETS[0],type:'plain_text'},{name:SHARED_READ_SECRETS[1],type:'secret_text'}]}));
});
test('latest upload history binds inherited secrets and refuses foreign inactive writes',()=>{
  assert.deepEqual(repair.versionHistory({items:[{id:OLD}]}),[OLD]);
  repair.assertUploadedHistory([OLD],[NEW,OLD],NEW);
  for(const ids of [[OTHER,NEW,OLD],[NEW,OTHER,OLD],[NEW],[OLD,NEW]])assert.throws(()=>repair.assertUploadedHistory([OLD],ids,NEW));
  assert.throws(()=>repair.versionHistory({items:[{id:OLD},{id:OLD}]}));
});
test('activation rechecks rich boundary and active identity after history before deploying',async()=>{
  const before={version:OLD,state:{approved:true}},calls=[];
  const ops={before,uploaded:NEW,priorHistory:[OLD],history:async()=>{calls.push('history');return [NEW,OLD];},
    snapshot:async()=>{calls.push('snapshot');return before;},getVersion:async()=>{calls.push('active');return OLD;},activate:async()=>calls.push('deploy')};
  await repair.activateOwned(ops);assert.deepEqual(calls,['history','snapshot','active','deploy']);
  for(const phase of ['snapshot','active']){
    calls.length=0;const changed={...ops};
    if(phase==='snapshot')changed.snapshot=async()=>({version:OTHER,state:before.state});
    else changed.getVersion=async()=>OTHER;
    await assert.rejects(repair.activateOwned(changed));assert.ok(!calls.includes('deploy'));
  }
});
test('restore checks identity after history, skips already restored, and never overwrites an existing-version foreign activation',async()=>{
  for(const live of [NEW,OLD,OTHER]){
    const calls=[];const ops={before:{version:OLD},uploaded:NEW,priorHistory:[OLD],history:async()=>{calls.push('history');return [NEW,OLD];},
      getVersion:async()=>{calls.push('active');return live;},restore:async id=>{assert.equal(id,OLD);calls.push('restore');}};
    if(live===OTHER)await assert.rejects(repair.restoreOwned(ops),/foreign activation/);else await repair.restoreOwned(ops);
    assert.deepEqual(calls,live===NEW?['history','active','restore']:['history','active']);
  }
});
test('qualification cannot pass after a foreign inactive upload or existing-version activation',async()=>{
  const ops={uploaded:NEW,priorHistory:[OLD],history:async()=>[NEW,OLD],getVersion:async()=>NEW};
  await repair.confirmOwned(ops);
  await assert.rejects(repair.confirmOwned({...ops,history:async()=>[OTHER,NEW,OLD]}),/foreign version upload/);
  await assert.rejects(repair.confirmOwned({...ops,getVersion:async()=>OTHER}),/foreign activation/);
  const source=readFileSync(new URL('../tools/staging-consumer.mjs',import.meta.url),'utf8');
  assert.ok(source.indexOf('await confirmOwned(',source.indexOf('verify:async()=>'))>source.indexOf('await verifySharedForecast();'));
});
test('full active runtime is recorded and unsupported source preservation fails closed',async()=>{
  const f=apiFixture();f.version.resources.script_runtime.usage_model='standard';
  const before=await consumerSnapshot(f.config,f.get);
  assert.deepEqual(before.state.script_runtime,f.version.resources.script_runtime);
  repair.assertRuntimePreserved(f.config,before.state.script_runtime);
  assert.throws(()=>repair.assertRuntimePreserved(f.config,{...before.state.script_runtime,limits:{cpu_ms:500}}),/runtime/);
  assert.throws(()=>repair.assertRuntimePreserved(f.config,{...before.state.script_runtime,unknown:true}),/runtime/);
});
const NOW=Date.parse('2026-09-05T12:00:00Z'),INIT='2026-09-05T06:00:00Z',RUN='2026090506';
function servingFixture(mutate=()=>{},initializations={}) {
  const calls=[];
  const fetcher=async(url,options)=>{
    assert.equal(options.redirect,'error');assert.equal(options.method,'GET');assert.ok(!options.headers?.Authorization);
    const u=new URL(url);assert.equal(u.origin,'https://staging.weatherx.org');calls.push(u);
    const selectedModel=u.pathname.split('/').find(v=>['ecmwf','gfs'].includes(v));
    const init=initializations[selectedModel]??INIT,run=init.replace(/[-:T]/g,'').slice(0,10);
    let value,headers={'x-weatherx-data-source':'shared','x-weatherx-catalog':'catalog-1','x-weatherx-release':'whole-1'};
    if(u.pathname.endsWith('/health'))value={ok:true,authMode:'public',billingMode:'disabled'};
    else if(u.pathname.endsWith('/data-health'))value={ok:true,authMode:'public',catalogMode:'serve',dataSource:'shared',sharedReadConfigured:true};
    else if(u.pathname.endsWith('/index.json'))value={schemaVersion:1,model:u.pathname.split('/').at(-2),runs:[{init_time:init,path:`runs/${run}/`}]};
    else if(u.pathname.endsWith('/manifest.json'))value={init_time:init,frames:[{valid_time:new Date(NOW).toISOString()},{valid_time:new Date(NOW+3*3600000).toISOString()}]};
    else {const model=u.pathname.split('/').at(-1);headers['x-weatherx-release']='catalog-1';value={schemaVersion:1,model,runId:run,releaseId:'catalog-1',initializedAt:init,freshUntil:new Date(Date.parse(init)+(model==='ecmwf'?30:18)*3600000).toISOString(),quality:'complete',missingFields:[],requestedPoint:{latitude:39.9,longitude:116.4},series:{temperature:{samples:[{validTime:new Date(NOW).toISOString(),value:20},{validTime:new Date(NOW+3600000).toISOString(),value:21}]}}};assert.equal(u.searchParams.get('run'),run);assert.equal(u.searchParams.has('runFallback'),false);}
    mutate(u,value,headers);return Response.json(value,{headers});
  };return {fetcher,calls};
}
test('live shared proof requires exact map run and finite current point values, including catalog-mounted point identity',async()=>{
  const f=servingFixture();const result=await repair.verifySharedForecast(f.fetcher,NOW);
  assert.deepEqual(result.models.map(v=>v.model),['ecmwf','gfs']);assert.equal(f.calls.length,8);
});
test('core freshness follows source ECMWF 30h and GFS 18h contracts, not regional or universal 18h policy',async()=>{
  assert.deepEqual(repair.CORE_FRESH_HOURS,{ecmwf:30,gfs:18});
  for(const age of [19,24,29]){
    const init=new Date(NOW-age*3600000).toISOString();
    await repair.verifySharedForecast(servingFixture(()=>{},{ecmwf:init}).fetcher,NOW);
  }
  for(const [model,age] of [['ecmwf',31],['gfs',19]]){
    const init=new Date(NOW-age*3600000).toISOString();
    await assert.rejects(repair.verifySharedForecast(servingFixture(()=>{},{[model]:init}).fetcher,NOW),/stale/);
  }
  for(const [model,age] of [['ecmwf',30],['gfs',18]]){
    const init=new Date(NOW-age*3600000).toISOString();
    await assert.rejects(repair.verifySharedForecast(servingFixture(()=>{},{[model]:init}).fetcher,NOW),/stale point/);
  }
  const future=new Date(NOW+2*3600000).toISOString();
  await assert.rejects(repair.verifySharedForecast(servingFixture(()=>{},{ecmwf:future}).fetcher,NOW),/future/);
  await assert.rejects(repair.verifySharedForecast(servingFixture((u,v)=>{if(v.series)v.freshUntil=new Date(NOW+100*3600000).toISOString();}).fetcher,NOW),/freshness differs/);
});
test('live proof refuses own/stale/mismatched/empty/nonfinite/fallback and traversal responses',async()=>{
  for(const mutation of [
    (u,v)=>{if(u.pathname.endsWith('/data-health'))v.dataSource='own';},
    (u,v,h)=>{if(u.pathname.endsWith('/index.json'))h['x-weatherx-data-source']='own';},
    (u,v)=>{if(u.pathname.endsWith('/index.json'))v.runs[0].path='../secret/';},
    (u,v)=>{if(u.pathname.endsWith('/manifest.json'))v.init_time='2026-09-04T06:00:00Z';},
    (u,v)=>{if(v.series)v.runId='2026090500';},
    (u,v)=>{if(v.series)v.freshUntil='2026-09-05T00:00:00Z';},
    (u,v)=>{if(v.series)v.series.temperature.samples=[];},
    (u,v)=>{if(v.series)v.series.temperature.samples[0].value=null;},
    (u,v)=>{if(v.series)v.runSelection={mode:'current_fallback'};},
    (u,v,h)=>{if(v.series)h['x-weatherx-release']='other';},
    (u,v)=>{if(v.series)v.requestedPoint.longitude=0;},
    (u,v)=>{if(v.series)v.series.temperature.samples[1].validTime=v.series.temperature.samples[0].validTime;},
    (u,v)=>{if(v.series)v.quality='partial';},
  ]) await assert.rejects(repair.verifySharedForecast(servingFixture(mutation).fetcher,NOW));
});
test('live proof cancels oversized response bodies and rejects HTML, non-200 and malformed JSON',async()=>{
  for(const response of [new Response('no',{status:503}),new Response('<html/>',{headers:{'content-type':'text/html'}}),new Response('{',{headers:{'content-type':'application/json'}})])await assert.rejects(repair.verifySharedForecast(async()=>response,NOW));
  let cancelled=false;
  const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(9000));},cancel(){cancelled=true;}});
  await assert.rejects(repair.verifySharedForecast(async()=>new Response(body,{headers:{'content-type':'application/json'}}),NOW),/oversized/);
  assert.equal(cancelled,true);
});
