import test from 'node:test';
import assert from 'node:assert/strict';
import {consumerGate,SOURCE_SHA,WORKER,EXISTING_ROUTES,configForStaging,desiredSettings,settingsState,guardedRepair,consumerSnapshot} from '../tools/staging-consumer.mjs';
const OLD='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',NEW='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',OTHER='cccccccc-cccc-cccc-cccc-cccccccccccc';
const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_JOB:'refresh',GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/staging-consumer-refresh.yml@refs/heads/main',STAGING_CONSUMER_ENABLED:'true',STAGING_CONSUMER_SOURCE_SHA:SOURCE_SHA,CONFIRM:'REFRESH-STAGING-CONSUMER',STAGING_R2_ACCOUNT_ID:'a89f9a1af485021fbc60a68b163c7c6e',STAGING_CONSUMER_APPROVED_VERSION:OLD,STAGING_CONSUMER_APPROVED_SETTINGS_SHA256:'a'.repeat(64),GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1'};
const settings={bindings:[{name:'AUTH_MODE',type:'plain_text',text:'enforce'},{name:'BILLING_MODE',type:'plain_text',text:'enabled'},{name:'DATA_BUCKET',type:'r2_bucket',bucket_name:'weatherx-data-staging'}],compatibility_date:'2026-08-15'};
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
  for(const mutation of [b=>b.env.staging.name='weatherx-platform-edge-production',b=>b.env.staging.r2_buckets[0].bucket_name='weatherx-data-production',b=>b.env.staging.vars.AUTH_MODE='observe',b=>b.env.staging.routes[0].pattern='weatherx.org/data/*']){const v=structuredClone(base);mutation(v);assert.throws(()=>configForStaging(v));}
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
