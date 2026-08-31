import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {followPlan,follow} from '../tools/staging-follow-master.mjs';
const SHA='a'.repeat(40),empty={total_count:0,workflow_runs:[]};
const run=(status='completed',sha=SHA)=>({head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/ui-staging.yml',status,display_title:`Staging ${sha}`,conclusion:'failure'});
const listing=r=>({total_count:r.length,workflow_runs:r});
test('new master qualifies once; failed and successful sources do not auto-retry',()=>{
  assert.equal(followPlan(SHA,empty,empty).dispatch,true);
  for(const conclusion of ['failure','success','cancelled'])assert.equal(followPlan(SHA,empty,listing([{...run(),conclusion}])).dispatch,false);
  for(const status of ['queued','in_progress','waiting','requested','pending'])assert.equal(followPlan(SHA,listing([run(status,'b'.repeat(40))]),empty).dispatch,false);
});
test('incomplete history and wrong workflow/branch refuse instead of duplicate dispatch',()=>{
  assert.throws(()=>followPlan(SHA,empty,{total_count:101,workflow_runs:[]}));
  for(const mutation of [{path:'.github/workflows/ui-release.yml'},{head_branch:'other'},{event:'push'}])assert.throws(()=>followPlan(SHA,empty,listing([{...run(),...mutation}])));
});
const env={GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main',GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_JOB:'follow',GITHUB_EVENT_NAME:'schedule',UI_STAGING_FOLLOW_MASTER_ENABLED:'true',APP_MASTER_SHA:SHA,APP_MASTER_COMMITTED_AT:'2026-08-31T00:00:00Z'};
test('actual follower dispatches only staging main with exact source and no release/bake inputs',async()=>{
  const calls=[];const result=await follow(env,async(...args)=>{calls.push(args);return empty;},Date.parse('2026-08-31T01:00:00Z'));
  assert.equal(result.dispatch,true);assert.deepEqual(calls.at(-1),['POST','actions/workflows/ui-staging.yml/dispatches',{ref:'main',inputs:{atmos_sha:SHA}}]);
  for(const key of Object.keys(env))await assert.rejects(follow({...env,[key]:'wrong'},async()=>{throw Error('must not dispatch')}));
});
test('follower has no Cloudflare credentials, protected publication environment or candidate execution',()=>{
  const file=readFileSync(new URL('../.github/workflows/staging-follow-master.yml',import.meta.url),'utf8');
  assert.match(file,/UI_STAGING_FOLLOW_MASTER_ENABLED == 'true'/);assert.match(file,/cancel-in-progress: false/);
  assert.doesNotMatch(file,/CLOUDFLARE|PAGES_TOKEN|UI_CANDIDATE_KEY|environment:|npm ci|npm run/);
  assert.match(file,/run: node cycle\/tools\/staging-follow-master.mjs/);
  const stage=readFileSync(new URL('../.github/workflows/ui-staging.yml',import.meta.url),'utf8');
  assert.match(stage,/run-name: Staging \$\{\{ inputs.atmos_sha \}\}/);
  const production=readFileSync(new URL('../.github/workflows/ui-release.yml',import.meta.url),'utf8');
  assert.doesNotMatch(production,/schedule:|workflow_run:|repository_dispatch:/);
});
