// Dispatches ONLY the existing staging qualification workflow. Never deploys,
// bakes, executes candidate source, or possesses Cloudflare/promotion credentials.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const REPO='Andrewegao/v3t7kq-cycle',WORKFLOW='ui-staging.yml';
export function followPlan(sha,recent,history){
  assert.match(sha??'',/^[a-f0-9]{40}$/);
  for(const listing of [recent,history]){
    assert.ok(Number.isSafeInteger(listing.total_count)&&listing.total_count>=0);
    assert.ok(Array.isArray(listing.workflow_runs)&&listing.workflow_runs.length<=100);
    for(const run of listing.workflow_runs){
      assert.equal(run.head_branch,'main');assert.equal(run.event,'workflow_dispatch');
      assert.equal(run.path,`.github/workflows/${WORKFLOW}`);
      assert.equal(typeof run.status,'string');assert.equal(typeof run.display_title,'string');
    }
  }
  assert.equal(history.workflow_runs.length,history.total_count,'incomplete source-attempt history; inspect manually');
  if(recent.workflow_runs.some(r=>r.status!=='completed'))return {dispatch:false,reason:'staging-qualification-active'};
  if(history.workflow_runs.some(r=>r.display_title===`Staging ${sha}`))return {dispatch:false,reason:'source-already-attempted'};
  return {dispatch:true,reason:'new-master-source'};
}
export async function follow(env,api,now=Date.now()){
  assert.equal(env.GITHUB_REPOSITORY,REPO);assert.equal(env.GITHUB_REF,'refs/heads/main');
  assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(env.GITHUB_JOB,'follow');assert.ok(['schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME));
  assert.equal(env.UI_STAGING_FOLLOW_MASTER_ENABLED,'true');
  assert.match(env.APP_MASTER_SHA??'',/^[a-f0-9]{40}$/);
  const time=Date.parse(env.APP_MASTER_COMMITTED_AT);assert.ok(Number.isFinite(time)&&time<=now+300_000,'invalid source timestamp');
  const base=`actions/workflows/${WORKFLOW}/runs?branch=main&event=workflow_dispatch&per_page=100`;
  const [recent,history]=await Promise.all([api('GET',base),api('GET',base+'&created='+encodeURIComponent('>='+new Date(time).toISOString()))]);
  const plan=followPlan(env.APP_MASTER_SHA,recent,history);
  if(plan.dispatch)await api('POST',`actions/workflows/${WORKFLOW}/dispatches`,{ref:'main',inputs:{atmos_sha:env.APP_MASTER_SHA}});
  return {...plan,sourceSha:env.APP_MASTER_SHA};
}
async function api(method,path,body){
  const response=await fetch(`https://api.github.com/repos/${REPO}/${path}`,{method,redirect:'error',signal:AbortSignal.timeout(20_000),
    headers:{Authorization:`Bearer ${process.env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  assert.equal(response.status,method==='POST'?204:200,'staging dispatcher request failed');
  if(method==='POST')return;
  let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;assert.ok(size<=4*1024**2,'oversized run history');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  follow(process.env,api).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('Staging follower refused incomplete or unapproved evidence');process.exitCode=1;});
