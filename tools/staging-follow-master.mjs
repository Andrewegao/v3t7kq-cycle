// Dispatches ONLY the existing staging qualification workflow. Never deploys,
// bakes, executes candidate source, or possesses Cloudflare/promotion credentials.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const REPO='Andrewegao/v3t7kq-cycle',WORKFLOW='ui-staging.yml';
export function followPlan(sha,history){
  assert.match(sha??'',/^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(history.total_count)&&history.total_count>=0&&history.total_count<=1000);
  assert.ok(Array.isArray(history.workflow_runs)&&history.workflow_runs.length<=1000);
  const ids=new Set();
    for(const run of history.workflow_runs){
      assert.ok(Number.isSafeInteger(run.id)&&run.id>0&&!ids.has(run.id),'repeated/invalid run');ids.add(run.id);
      assert.equal(run.head_branch,'main');assert.equal(run.event,'workflow_dispatch');
      assert.equal(run.path,`.github/workflows/${WORKFLOW}`);
      assert.ok(['completed','queued','in_progress','waiting','requested','pending'].includes(run.status));
      assert.match(run.display_title??'',/^Staging [a-f0-9]{40}$/,'unattributed source attempt; inspect manually');
    }
  assert.equal(history.workflow_runs.length,history.total_count,'incomplete source-attempt history; inspect manually');
  if(history.workflow_runs.some(r=>r.status!=='completed'))return {dispatch:false,reason:'staging-qualification-active'};
  if(history.workflow_runs.some(r=>r.display_title===`Staging ${sha}`))return {dispatch:false,reason:'source-already-attempted'};
  return {dispatch:true,reason:'new-master-source'};
}
export async function follow(env,api){
  assert.equal(env.GITHUB_REPOSITORY,REPO);assert.equal(env.GITHUB_REF,'refs/heads/main');
  assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(env.GITHUB_JOB,'follow');assert.ok(['schedule','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME));
  assert.equal(env.UI_STAGING_FOLLOW_MASTER_ENABLED,'true');
  assert.match(env.APP_MASTER_SHA??'',/^[a-f0-9]{40}$/);
  const base=`actions/workflows/${WORKFLOW}/runs?branch=main&event=workflow_dispatch&per_page=100`;
  // Complete bounded history, not a commit-date heuristic: imported/rebased commits
  // can have arbitrary dates and old waiting jobs can fall beyond the first page.
  const history={total_count:null,workflow_runs:[]};
  for(let page=1;page<=10;page++){
    const listing=await api('GET',base+`&page=${page}`);
    assert.ok(Number.isSafeInteger(listing.total_count)&&listing.total_count>=0&&listing.total_count<=1000,'history exceeds audit bound; inspect manually');
    if(history.total_count===null)history.total_count=listing.total_count;
    assert.equal(listing.total_count,history.total_count,'history changed during inspection');
    assert.ok(Array.isArray(listing.workflow_runs));
    assert.equal(listing.workflow_runs.length,Math.min(100,history.total_count-history.workflow_runs.length),'truncated history page');
    history.workflow_runs.push(...listing.workflow_runs);
    if(history.workflow_runs.length===history.total_count)break;
  }
  const plan=followPlan(env.APP_MASTER_SHA,history);
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
