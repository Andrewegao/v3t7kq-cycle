import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {followPlan,follow} from '../tools/staging-follow-master.mjs';
const SHA='a'.repeat(40),empty={total_count:0,workflow_runs:[]};
const run=(status='completed',sha=SHA,id=1)=>({id,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/ui-staging.yml',status,display_title:`Staging ${sha}`,conclusion:'failure'});
const listing=r=>({total_count:r.length,workflow_runs:r});
test('new master qualifies once; failed and successful sources do not auto-retry',()=>{
  assert.equal(followPlan(SHA,empty).dispatch,true);
  for(const conclusion of ['failure','success','cancelled'])assert.equal(followPlan(SHA,listing([{...run(),conclusion}])).dispatch,false);
  for(const status of ['queued','in_progress','waiting','requested','pending'])assert.equal(followPlan(SHA,listing([run(status,'b'.repeat(40))])).dispatch,false);
});
test('incomplete history and wrong workflow/branch refuse instead of duplicate dispatch',()=>{
  assert.throws(()=>followPlan(SHA,{total_count:101,workflow_runs:[]}));
  for(const mutation of [{path:'.github/workflows/ui-release.yml'},{head_branch:'other'},{event:'push'}])assert.throws(()=>followPlan(SHA,listing([{...run(),...mutation}])));
});
const env={GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main',GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_JOB:'follow',GITHUB_EVENT_NAME:'schedule',UI_STAGING_FOLLOW_MASTER_ENABLED:'true',APP_MASTER_SHA:SHA};
test('actual follower dispatches only staging main with exact source and no release/bake inputs',async()=>{
  const calls=[];const result=await follow(env,async(...args)=>{calls.push(args);return empty;},Date.parse('2026-08-31T01:00:00Z'));
  assert.equal(result.dispatch,true);assert.deepEqual(calls.at(-1),['POST','actions/workflows/ui-staging.yml/dispatches',{ref:'main',inputs:{atmos_sha:SHA}}]);
  for(const key of Object.keys(env))await assert.rejects(follow({...env,[key]:'wrong'},async()=>{throw Error('must not dispatch')}));
});
test('older active or failed source runs beyond page one prevent dispatch regardless of commit timestamp',async()=>{
  for(const older of [run('waiting','b'.repeat(40),101),run('completed',SHA,101)]){
    const calls=[];const first=Array.from({length:100},(_,i)=>run('completed','b'.repeat(40),i+1));
    const result=await follow({...env,APP_MASTER_COMMITTED_AT:'2099-01-01T00:00:00Z'},async(method,path)=>{
      calls.push([method,path]);assert.equal(method,'GET');assert.ok(!path.includes('created='));
      return {total_count:101,workflow_runs:path.endsWith('page=1')?first:[older]};
    });
    assert.equal(result.dispatch,false);assert.equal(calls.length,2);
  }
});
test('history truncation, changing counts, repeated pages and unsupported status fail closed',async()=>{
  await assert.rejects(follow(env,async()=>({total_count:1001,workflow_runs:[]})));
  for(const kind of ['truncated','count','duplicate']){
    const first=Array.from({length:100},(_,i)=>run('completed','b'.repeat(40),i+1));
    await assert.rejects(follow(env,async(method,path)=>path.endsWith('page=1')?{total_count:101,workflow_runs:first}:
      {total_count:kind==='count'?102:101,workflow_runs:kind==='truncated'?[]:[run('completed','b'.repeat(40),kind==='duplicate'?1:101)]}));
  }
  assert.throws(()=>followPlan(SHA,listing([run('surprise')])));
  assert.throws(()=>followPlan(SHA,listing([{...run(),display_title:'WeatherX UI staging qualification'}])));
});
test('follower protects source key but has no Cloudflare credentials, publication environment or candidate execution',()=>{
  const file=readFileSync(new URL('../.github/workflows/staging-follow-master.yml',import.meta.url),'utf8');
  assert.match(file,/UI_STAGING_FOLLOW_MASTER_ENABLED == 'true'/);assert.match(file,/cancel-in-progress: false/);
  assert.match(file,/\n    environment: staging\n/);
  assert.doesNotMatch(file,/CLOUDFLARE|PAGES_TOKEN|UI_CANDIDATE_KEY|name: ui-production|name: ui-staging|npm ci|npm run/);
  assert.match(file,/run: node cycle\/tools\/staging-follow-master.mjs/);
  const stage=readFileSync(new URL('../.github/workflows/ui-staging.yml',import.meta.url),'utf8');
  assert.match(stage,/run-name: Staging \$\{\{ inputs.atmos_sha \}\}/);
  const production=readFileSync(new URL('../.github/workflows/ui-release.yml',import.meta.url),'utf8');
  assert.doesNotMatch(production,/schedule:|workflow_run:|repository_dispatch:/);
});
