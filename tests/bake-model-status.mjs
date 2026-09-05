import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MODELS, collectEvidence, buildReport, markdown, readJobLog, validateRun, main} from '../tools/bake-model-status.mjs';

const runId='123',attempt=1,headSha='a'.repeat(40),sourceSha='b'.repeat(40);
const step=(name,conclusion='success')=>({name,conclusion});
function fixture(){
  const jobs=MODELS.map(model=>({id:MODELS.indexOf(model)+1,name:`${MODELS.indexOf(model)<4?'core':'regional'} (${model})`,conclusion:'success',steps:[
    step('collect one core model and seal its map, point and float inputs'),step('retain only sealed core model inputs for the joined bake'),
    step('collect one regional model for the newest complete cycle (one older-cycle fallback)'),step('hand the display packs (or abstention receipts) to the bake job')]}));
  jobs.push({id:12,name:'bake',conclusion:'success',steps:[step('bake → gate → publish immutable data release')]});
  const evidence=Object.fromEntries(jobs.map(job=>[job.name,{}]));
  for(const model of MODELS.slice(4))evidence[`regional (${model})`]={collectedRun:'2026090512'};
  evidence.bake={coreInstalled:true,installed:Object.fromEntries(MODELS.slice(4).map(model=>[model,{status:'fresh',run:'2026090512'}])),promoted:true,completed:true};
  return {runId,attempt,headSha,sourceSha,jobs,evidence};
}
test('all eleven rows distinguish published inclusion from live usability',()=>{
  const report=buildReport(fixture());
  assert.equal(report.models.length,11);assert.equal(new Set(report.models.map(row=>row.model)).size,11);
  assert.equal(report.publishedMapCount,11);assert.equal(report.allElevenLiveVerified,false);
  assert.match(markdown(report),/not a current freshness, point-forecast, or browser-health check/);
});
test('green abstention is not collection or publication success for that model',()=>{
  const f=fixture();f.evidence['regional (nam-hi)']={abstained:true};f.evidence.bake.installed['nam-hi']={status:'absent',run:null};
  const r=buildReport(f),row=r.models.find(v=>v.model==='nam-hi');
  assert.equal(row.collection,'abstained');assert.equal(row.installed,'absent');assert.equal(row.published,'not-included');assert.equal(r.publishedMapCount,10);
  assert.equal(r.outcome,'published-partial');
});
test('successful recovery cache miss with fresh collection and unavailable logs is not recovered',()=>{
  for(const kind of ['core','regional'])for(const readStatus of ['unavailable','oversized']){
    const f=fixture(),model=kind==='core'?'ecmwf':'nam-hi',job=f.jobs.find(j=>j.name===`${kind} (${model})`);
    const collection=kind==='core'?'collect one core model and seal its map, point and float inputs':'collect one regional model for the newest complete cycle (one older-cycle fallback)';
    job.steps.push(step(`recover only compatible completed ${kind} inputs`));
    f.evidence[job.name]={readStatus};
    let row=buildReport(f).models.find(r=>r.model===model);
    assert.equal(row.collection,kind==='core'?'sealed':'unknown','successful fresh core sealing is still independent proof');
    job.steps.find(s=>s.name===collection).conclusion='skipped';
    assert.equal(buildReport(f).models.find(r=>r.model===model).collection,'recovered');
    job.steps=job.steps.filter(s=>s.name!==collection);
    assert.equal(buildReport(f).models.find(r=>r.model===model).collection,'unknown','missing collection step is not an explicit skip');
  }
});
test('failed optional collection can carry an existing qualified map without relabeling it fresh',()=>{
  const f=fixture();f.jobs[4].conclusion='failure';f.evidence.bake.installed.icon={status:'carried',run:'2026090506'};
  const row=buildReport(f).models.find(v=>v.model==='icon');
  assert.equal(row.collection,'job-failure');assert.equal(row.installed,'carried');assert.equal(row.published,'included-carried');
});
test('each failed/cancelled/skipped core or regional job remains individually visible',()=>{
  for(const model of MODELS)for(const conclusion of ['failure','cancelled','skipped']){
    const f=fixture();f.jobs.find(v=>v.name.endsWith(`(${model})`)).conclusion=conclusion;
    assert.equal(buildReport(f).models.find(v=>v.model===model).collection,`job-${conclusion}`);
  }
});
test('missing proof or failed publisher never becomes a publication claim',()=>{
  for(const change of [f=>delete f.evidence.bake.promoted,f=>delete f.evidence.bake.completed,
    f=>f.jobs.at(-1).steps[0].conclusion='failure',f=>delete f.evidence.bake.coreInstalled,
    f=>delete f.evidence.bake.installed.icon]){
    const f=fixture();change(f);assert.ok(buildReport(f).publishedMapCount<11);
  }
  const f=fixture();f.jobs=[];f.evidence={};const r=buildReport(f);
  assert.equal(r.models.length,11);assert.equal(r.publishedMapCount,0);assert.ok(r.models.every(v=>v.collection==='unknown'));
  const incomplete=fixture();delete incomplete.evidence.bake.coreInstalled;
  assert.equal(buildReport(incomplete).outcome,'published-incomplete-evidence','unknown core inclusion is not known partial publication');
});
test('core failure skips a new whole candidate without claiming old live data was removed',()=>{
  const f=fixture();f.jobs[0].conclusion='failure';f.jobs.at(-1).conclusion='skipped';f.jobs.at(-1).steps=[];f.evidence.bake={};
  assert.equal(buildReport(f).outcome,'publication-not-confirmed');assert.match(markdown(buildReport(f)),/does not mean the prior live release was removed/);
});
test('only fixed structured events survive arbitrary secrets, URLs and shell echoes',()=>{
  const e={};for(const line of ['secret=NEVER_PRINT_THIS https://signed.example/token',
    'echo "promoted cycle-123"','promoted cycle-999',
    '[2026-09-05T12:00:00Z] regional-model install nam-hi status=absent init=- reason=NEVER_PRINT_THIS',
    `{"status":"installed-unqualified-inputs","models":["ecmwf","gfs","hrrr","aifs"],"runId":"123","sourceSha":"${sourceSha}"}`,
    'promoted cycle-123','[2026-09-05T12:00:00Z] === cycle complete ==='])collectEvidence(e,line,{runId,sourceSha,jobName:'bake'});
  assert.equal(e.promoted,true);assert.equal(e.completed,true);assert.equal(e.coreInstalled,true);
  assert.deepEqual(e.installed['nam-hi'],{status:'absent',run:null});assert.doesNotMatch(JSON.stringify(e),/NEVER_PRINT|signed|token/);
  const wrong={};collectEvidence(wrong,`{"status":"installed-unqualified-inputs","models":["ecmwf","gfs","hrrr","aifs"],"runId":"999","sourceSha":"${sourceSha}"}`,{runId,sourceSha,jobName:'bake'});assert.equal(wrong.coreInstalled,undefined);
});
test('run provenance cannot point at a different repo, workflow, attempt, source or run',()=>{
  const run={id:123,run_attempt:1,head_sha:headSha,path:'.github/workflows/bake.yml',repository:{full_name:'Andrewegao/v3t7kq-cycle'}};
  validateRun(run,{runId,attempt,headSha});
  for(const [key,value] of [['id',124],['run_attempt',2],['head_sha','c'.repeat(40)],['path','other.yml'],['repository',{full_name:'other/repo'}]])assert.throws(()=>validateRun({...run,[key]:value},{runId,attempt,headSha}));
});
test('log redirect drops credentials and rejects untrusted storage without printing its URL',async()=>{
  const calls=[];const fetcher=async(url,options)=>{calls.push({url,options});return calls.length===1?new Response(null,{status:302,headers:{location:'https://x.blob.core.windows.net/log?secret=value'}}):new Response('2026-09-05T12:00:00Z promoted cycle-123\n');};
  const e=await readJobLog(12,{token:'PRIVATE',runId,sourceSha,jobName:'bake',fetcher});assert.equal(e.promoted,true);
  assert.equal(calls[0].options.headers.Authorization,'Bearer PRIVATE');assert.equal(calls[1].options.headers.Authorization,undefined);assert.equal(calls[1].options.redirect,'error');
  await assert.rejects(readJobLog(12,{token:'PRIVATE',runId,sourceSha,jobName:'bake',fetcher:async()=>new Response(null,{status:302,headers:{location:'https://evil.example/?secret=PRIVATE'}})}),/^Error: unsafe log redirect$/);
});
test('bounded log streaming marks incomplete evidence instead of retaining oversized raw logs',async()=>{
  let cancelled=false;
  const body=new ReadableStream({pull(c){c.enqueue(new Uint8Array(1024));},cancel(){cancelled=true;}});
  const e=await readJobLog(12,{token:'x',runId,sourceSha,jobName:'bake',maxBytes:100,fetcher:async()=>new Response(body)});
  assert.equal(e.readStatus,'oversized');assert.equal(cancelled,true);assert.doesNotMatch(JSON.stringify(e),/000000/);
});
test('stream chunk boundaries and oversized individual lines cannot forge or lose the next safe event',async()=>{
  const encoder=new TextEncoder(),parts=['x'.repeat(5000),'discarded\npromoted cy','cle-123\n'];
  const body=new ReadableStream({pull(c){if(parts.length)c.enqueue(encoder.encode(parts.shift()));else c.close();}});
  const e=await readJobLog(12,{token:'x',runId,sourceSha,jobName:'bake',fetcher:async()=>new Response(body)});
  assert.equal(e.promoted,true);assert.equal(e.readStatus,'complete');
});
test('end-to-end read-only run/attempt report retains no raw diagnostic and produces eleven rows',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wx-model-status-test-'));
  try{
    const f=fixture(),requests=[],pinned=readFileSync(new URL('../.github/workflows/bake.yml',import.meta.url),'utf8').match(/^          ref: ([a-f0-9]{40})$/m)[1];
    const fetcher=async(url,options)=>{
      requests.push(url);assert.equal(options.method,'GET');assert.equal(options.redirect,'manual');
      if(url.endsWith('/actions/runs/123'))return Response.json({id:123,run_attempt:1,head_sha:headSha,path:'.github/workflows/bake.yml',repository:{full_name:'Andrewegao/v3t7kq-cycle'}});
      if(url.includes('/attempts/1/jobs'))return Response.json({total_count:12,jobs:f.jobs.map(job=>({...job,run_id:123,head_sha:headSha}))});
      const id=Number(url.match(/jobs\/(\d+)\/logs$/)?.[1]);assert.ok(id);
      if(id===12)return new Response([
        JSON.stringify({status:'installed-unqualified-inputs',models:MODELS.slice(0,4),runId,sourceSha:pinned}),
        ...MODELS.slice(4).map(model=>`[2026-09-05T12:00:00Z] regional-model install ${model} status=${model==='nam-hi'?'absent':'fresh'} init=${model==='nam-hi'?'-':'2026090512'}`),
        'promoted cycle-123','[2026-09-05T12:00:00Z] === cycle complete ==='].join('\n'));
      const model=MODELS[id-1];return new Response(model==='nam-hi'?'[2026-09-05T12:00:00Z] regional-model abstained nam-hi after 2 cycle attempt(s)\nPRIVATE_URL=https://private/secret':`[2026-09-05T12:00:00Z] regional-model collected ${model} cycle=2026090512 files=150 bytes=100 wall=1.0s`);
    };
    const report=await main({GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_JOB:'model-status',GITHUB_RUN_ID:runId,GITHUB_RUN_ATTEMPT:'1',GITHUB_SHA:headSha,GH_TOKEN:'PRIVATE_TOKEN',RUNNER_TEMP:dir,GITHUB_STEP_SUMMARY:join(dir,'summary.md')},fetcher);
    assert.equal(report.publishedMapCount,10);assert.equal(report.models.find(v=>v.model==='nam-hi').collection,'abstained');
    const json=readFileSync(join(dir,'weatherx-model-status/report.json'),'utf8'),md=readFileSync(join(dir,'summary.md'),'utf8');
    assert.doesNotMatch(json+md,/PRIVATE_|https:\/\/private/);assert.equal(requests.length,14);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('report job is read-only, always reports all dependencies and does not change release guards',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/bake.yml',import.meta.url),'utf8');
  const report=workflow.split('\n  model-status:\n')[1];assert.ok(report);
  assert.match(report,/needs: \[core, regional, bake\]/);assert.match(report,/if: \$\{\{ always\(\) \}\}/);
  assert.match(report,/actions: read/);assert.match(report,/contents: read/);
  assert.doesNotMatch(report,/secrets\.|environment:|R2_|CLOUDFLARE|CATALOG_|PAGES|workflow_dispatch/);
  assert.match(workflow,/needs\.core\.result == 'success'/);assert.match(workflow,/cron: '30 2,8,14,20 \* \* \*'/);
  assert.match(workflow,/installed-unqualified-inputs/);assert.match(workflow,/promoted cycle-/);
});
