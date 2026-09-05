import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {OWNED_REUSE,SOURCE_SHA,readOwnedOrigin,assertReusableVersion,reusablePreflight,activateOwned,restoreOwned,confirmOwned,consumerGate} from '../tools/staging-consumer.mjs';
const bytes=readFileSync(new URL('./fixtures/staging-owned-receipt.json',import.meta.url));
const origin=readOwnedOrigin(bytes),OLD=OWNED_REUSE.before,NEW=OWNED_REUSE.version,OTHER='cccccccc-cccc-cccc-cccc-cccccccccccc';
const bindings=origin.desired.bindings;
const config={...origin.before.state.script_runtime,vars:Object.fromEntries(bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,b.text])),
  secrets:{required:bindings.filter(b=>b.type==='secret_text').map(b=>b.name)},
  r2_buckets:bindings.filter(b=>b.type==='r2_bucket').map(b=>({binding:b.name,bucket_name:b.bucket_name})),
  d1_databases:bindings.filter(b=>b.type==='d1').map(b=>({binding:b.name,database_id:b.id})),
  queues:{producers:bindings.filter(b=>b.type==='queue').map(b=>({binding:b.name,queue:b.queue_name}))},
  analytics_engine_datasets:bindings.filter(b=>b.type==='analytics_engine').map(b=>({binding:b.name,dataset:b.dataset})),
  send_email:bindings.filter(b=>b.type==='send_email').map(({type,...b})=>b)};
const resource={id:NEW,metadata:{created_on:'2026-09-05T20:00:51.429394Z'},annotations:{'workers/tag':`staging-${SOURCE_SHA.slice(0,12)}`,'workers/triggered_by':'version_upload'},
  resources:{script:{etag:OWNED_REUSE.etag},script_runtime:origin.before.state.script_runtime,bindings}};
const history=[NEW,...origin.versionHistory].slice(0,10);
test('only exact archived receipt bytes are admitted, including original source/version/lineage',()=>{
  assert.equal(origin.uploaded,NEW);assert.equal(origin.workflowRun,OWNED_REUSE.run);
  for(const mutate of [r=>r.sourceSha='a'.repeat(40),r=>r.uploaded=OTHER,r=>r.workflowRun='1',r=>r.versionHistory.reverse(),r=>r.desired.bindings.pop()]){
    const r=structuredClone(origin);mutate(r);assert.throws(()=>readOwnedOrigin(Buffer.from(JSON.stringify(r))));
  }
  assert.throws(()=>readOwnedOrigin(Buffer.concat([bytes,Buffer.from(' ')])));
});
test('retained version requires exact ID/content/source metadata/runtime and complete bindings',()=>{
  assertReusableVersion(config,origin,resource);
  for(const mutate of [r=>r.id=OTHER,r=>r.resources.script.etag='b'.repeat(64),r=>r.annotations['workers/tag']='staging-other',
    r=>r.annotations['workers/triggered_by']='upload',r=>r.metadata.created_on='2026-09-05T20:00:52Z',
    r=>r.resources.script_runtime.usage_model='bundled',r=>r.resources.bindings.pop(),r=>r.resources.bindings.find(b=>b.name==='AUTH_MODE').text='enforce']){
    const r=structuredClone(resource);mutate(r);assert.throws(()=>assertReusableVersion(config,origin,r));
  }
});
test('reuse preflight is read-only and refuses current snapshot or history drift',async()=>{
  const base={config,origin,snapshot:async()=>structuredClone(origin.before),history:async()=>history,readVersion:async()=>structuredClone(resource)};
  assert.deepEqual((await reusablePreflight(base)).before,origin.before);
  for(const override of [
    {snapshot:async()=>({...origin.before,version:OTHER})},
    {snapshot:async()=>({...origin.before,state:{...origin.before.state,routes:[]}})},
    {history:async()=>[OTHER,...history].slice(0,10)},
    {readVersion:async()=>({...resource,id:OTHER})},
    {origin:{...origin,desired:{...origin.desired,crons:['* * * * *']}}},
  ])await assert.rejects(reusablePreflight({...base,...override}));
  let reads=0;await assert.rejects(reusablePreflight({...base,snapshot:async()=>++reads===1?origin.before:{...origin.before,version:OTHER}}));
});
test('existing ownership functions activate exact reused ID, confirm, and restore without upload',async()=>{
  let current=OLD;const operations=[];
  const common={before:origin.before,uploaded:NEW,priorHistory:origin.versionHistory,history:async()=>history,getVersion:async()=>current};
  await activateOwned({...common,snapshot:async()=>({...origin.before,version:current}),activate:async id=>{operations.push(['activate',id]);current=id;}});
  await confirmOwned(common);await restoreOwned({...common,restore:async id=>{operations.push(['restore',id]);current=id;}});
  assert.deepEqual(operations,[['activate',NEW],['restore',OLD]]);
  current=OTHER;await assert.rejects(restoreOwned({...common,restore:async()=>assert.fail('foreign overwritten')}));
  await assert.rejects(activateOwned({...common,snapshot:async()=>origin.before,activate:async()=>assert.fail('foreign overwritten')}));
});
test('reuse requires separate exact confirmation; workflow never supplies shared secrets to reuse',()=>{
  const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_JOB:'refresh',GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/staging-consumer-refresh.yml@refs/heads/main',STAGING_CONSUMER_ENABLED:'true',STAGING_CONSUMER_SOURCE_SHA:SOURCE_SHA,CONFIRM:'REUSE-STAGING-33988771315',STAGING_CONSUMER_MODE:'reuse-owned-33988771315',STAGING_R2_ACCOUNT_ID:'a89f9a1af485021fbc60a68b163c7c6e',STAGING_CONSUMER_APPROVED_VERSION:OLD,STAGING_CONSUMER_APPROVED_SETTINGS_SHA256:'a'.repeat(64),GITHUB_RUN_ID:'2',GITHUB_RUN_ATTEMPT:'1'};
  consumerGate(env);assert.throws(()=>consumerGate({...env,CONFIRM:'REFRESH-STAGING-CONSUMER'}));
  assert.throws(()=>consumerGate({...env,STAGING_CONSUMER_MODE:'reuse-any'}));
  const workflow=readFileSync(new URL('../.github/workflows/staging-consumer-refresh.yml',import.meta.url),'utf8');
  const reuse=workflow.split('- name: Reuse only the reviewed owned staging version without upload')[1].split('\n      - name:')[0];
  assert.doesNotMatch(reuse,/SHARED_READ|secrets-file|versions.*upload|PRODUCTION/);
  assert.match(reuse,/execute-reuse/);assert.match(workflow,/python cycle\/tests\/staging-consumer-reuse\.py/);
  const controller=readFileSync(new URL('../tools/staging-consumer.mjs',import.meta.url),'utf8');
  assert.match(controller,/versions\[0\],before.version,'latest version is not the serving version/);
  assert.match(controller,/stored.versionHistory\[0\],stored.before.version,'latest version does not own reviewed secrets/);
});
