#!/usr/bin/env node
// Read-only historical reporting, NOT admission, publication, or a live-health gate.
// Never retain/print raw job logs, remote errors, URLs, or arbitrary reason strings.
import assert from 'node:assert/strict';
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const MODELS=Object.freeze(['ecmwf','gfs','hrrr','aifs','icon','hrdps','arome-antilles','hrrr-ak','nam','nam-hi','nam-ak']);
const CORE=MODELS.slice(0,4), REGIONAL=MODELS.slice(4);
const REPO='Andrewegao/v3t7kq-cycle', API=`https://api.github.com/repos/${REPO}`;
const PUBLISH='bake → gate → publish immutable data release';
const safeConclusion=value=>['success','failure','cancelled','skipped','timed_out','action_required','neutral','stale','startup_failure'].includes(value)?value:'unknown';
const jobName=model=>`${CORE.includes(model)?'core':'regional'} (${model})`;
const succeeded=(job,name)=>job?.steps?.some(step=>step.name===name&&step.conclusion==='success');

export function validateRun(run,{runId,attempt,headSha}){
  assert.equal(String(run.id),runId);assert.equal(run.run_attempt,attempt);assert.equal(run.head_sha,headSha);
  assert.equal(run.path,'.github/workflows/bake.yml');assert.equal(run.repository?.full_name,REPO);
}
export function collectEvidence(evidence,raw,{runId,sourceSha,jobName:name}){
  const line=raw.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/,'').replace(/\r$/,'');
  if(name==='bake'){
    if(line===`promoted cycle-${runId}`)evidence.promoted=true;
    if(/^\[[\dT:.+Z-]+\] === cycle complete ===$/.test(line))evidence.completed=true;
    const install=/^\[[\dT:.+Z-]+\] regional-model install ([a-z-]+) status=(fresh|carried|absent) init=(\d{10}|-)(?: reason=.*)?$/.exec(line);
    if(install&&REGIONAL.includes(install[1])){
      const value={status:install[2],run:install[3]==='-'?null:install[3]};
      if((value.status==='absent')!==(value.run===null))return;
      evidence.installed??={};const prior=evidence.installed[install[1]];
      evidence.installed[install[1]]=prior&&JSON.stringify(prior)!==JSON.stringify(value)?{status:'unknown',run:null}:value;
    }
    if(/^\{"status":\s*"installed-unqualified-inputs"/.test(line)){
      try{const value=JSON.parse(line);if(value.runId===runId&&value.sourceSha===sourceSha&&JSON.stringify(value.models)===JSON.stringify(CORE))evidence.coreInstalled=true;}catch{}
    }
  }else{
    const model=MODELS.find(model=>jobName(model)===name);if(!model)return;
    const collected=/^\[[\dT:.+Z-]+\] regional-model collected ([a-z-]+) cycle=(\d{10}) files=\d+ bytes=\d+ wall=[\d.]+s$/.exec(line);
    if(collected?.[1]===model)evidence.collectedRun=collected[2];
    if(new RegExp(`^\\[[\\dT:.+Z-]+\\] regional-model abstained ${model} after [0-9]+ cycle attempt\\(s\\)$`).test(line))evidence.abstained=true;
  }
}

export function buildReport({runId,attempt,headSha,sourceSha,jobs,evidence,readStatus='complete'}){
  const find=name=>{const matches=jobs.filter(job=>job.name===name);return matches.length===1?matches[0]:undefined;};
  const publisher=find('bake'),proof=evidence.bake??{};
  // A green job alone is not proof of either inclusion or pointer promotion.
  // A later optional archive failure does not erase an acknowledged promotion.
  const acknowledged=succeeded(publisher,PUBLISH)&&proof.promoted===true&&proof.completed===true;
  const models=MODELS.map(model=>{
    const name=jobName(model),job=find(name),ev=evidence[name]??{},conclusion=safeConclusion(job?.conclusion);
    let collection='unknown';
    if(!job||conclusion==='unknown')collection='unknown';
    else if(conclusion!=='success')collection=`job-${conclusion}`;
    else if(CORE.includes(model)){
      const uploaded=succeeded(job,'retain only sealed core model inputs for the joined bake');
      if(uploaded&&succeeded(job,'collect one core model and seal its map, point and float inputs'))collection='sealed';
      else if(uploaded&&succeeded(job,'recover only compatible completed core inputs')
        &&job.steps?.some(step=>step.name==='collect one core model and seal its map, point and float inputs'&&step.conclusion==='skipped'))collection='recovered';
    }else if(ev.abstained)collection='abstained';
    else if(ev.collectedRun&&succeeded(job,'collect one regional model for the newest complete cycle (one older-cycle fallback)'))collection='collected';
    else if(succeeded(job,'recover only compatible completed regional inputs')&&succeeded(job,'hand the display packs (or abstention receipts) to the bake job')
      &&job.steps?.some(step=>step.name==='collect one regional model for the newest complete cycle (one older-cycle fallback)'&&step.conclusion==='skipped'))collection='recovered';
    const install=CORE.includes(model)?(proof.coreInstalled?{status:'verified-inputs',run:null}:undefined):proof.installed?.[model];
    const installed=install?.status??'unknown';
    let published='unconfirmed';
    if(acknowledged){
      if(installed==='absent')published='not-included';
      else if(['fresh','carried','verified-inputs'].includes(installed))published=installed==='carried'?'included-carried':'included';
    }
    return {model,jobConclusion:conclusion,collection,collectedRun:ev.collectedRun??null,
      installed,installedRun:install?.run??null,published,evidenceRead:ev.readStatus??'complete'};
  });
  const publishedMapCount=models.filter(row=>row.published.startsWith('included')).length;
  return {schemaVersion:1,runId,attempt,controllerSha:headSha,sourceSha,releaseId:`cycle-${runId}`,readStatus,
    publisherConclusion:safeConclusion(publisher?.conclusion),promotionAcknowledged:acknowledged,
    outcome:!acknowledged?'publication-not-confirmed':models.some(row=>row.published==='unconfirmed')?'published-incomplete-evidence':publishedMapCount===11?'published-eleven-map-inclusions':'published-partial',
    publishedMapCount,allElevenLiveVerified:false,models};
}
export function markdown(report){
  return `## Model publication report\n\nRun ${report.runId}, attempt ${report.attempt}: **${report.outcome}**. Confirmed map inclusions: ${report.publishedMapCount}/11.\n\n`+
    'Historical evidence only: not a current freshness, point-forecast, or browser-health check. A withheld candidate does not mean the prior live release was removed. Unknown means evidence was unavailable, not healthy.\n\n'+
    '| Model | Job | Collection | Installed | Published map |\n|---|---|---|---|---|\n'+
    report.models.map(row=>`| ${row.model} | ${row.jobConclusion} | ${row.collection}${row.collectedRun?` (${row.collectedRun})`:''} | ${row.installed}${row.installedRun?` (${row.installedRun})`:''} | ${row.published} |`).join('\n')+'\n';
}
function apiOptions(token){return {method:'GET',redirect:'manual',signal:AbortSignal.timeout(60000),headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'}};}
async function jsonGet(path,token,fetcher){
  const response=await fetcher(API+path,apiOptions(token));if(response.status!==200)throw Error('metadata read failed');
  let size=0;const parts=[];for await(const chunk of response.body){size+=chunk.length;if(size>2*1024**2)throw Error('metadata oversized');parts.push(Buffer.from(chunk));}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export async function readJobLog(id,{token,runId,sourceSha,jobName:name,fetcher=fetch,maxBytes=16*1024**2}){
  assert.ok(Number.isSafeInteger(id)&&id>0);let response=await fetcher(`${API}/actions/jobs/${id}/logs`,apiOptions(token));
  if([301,302,303,307,308].includes(response.status)){
    const target=new URL(response.headers.get('location'));
    if(target.protocol!=='https:'||target.username||target.password||target.port||
      !['.blob.core.windows.net','.actions.githubusercontent.com'].some(suffix=>target.hostname.endsWith(suffix)))throw Error('unsafe log redirect');
    // Never forward the API credential to the signed log-storage URL.
    response=await fetcher(target.href,{method:'GET',redirect:'error',credentials:'omit',headers:{},signal:AbortSignal.timeout(60000)});
  }
  if(response.status!==200||!response.body)return {readStatus:'unavailable'};
  const evidence={readStatus:'complete'},decoder=new TextDecoder(),reader=response.body.getReader();let bytes=0,carry='',dropping=false;
  try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;
    if(bytes>maxBytes){evidence.readStatus='oversized';break;}
    for(const part of decoder.decode(value,{stream:true}).split(/(?<=\n)/)){
      const ended=part.endsWith('\n');if(!dropping){carry+=part;if(carry.length>4096){carry='';dropping=true;}}
      if(ended){if(!dropping)collectEvidence(evidence,carry.slice(0,-1),{runId,sourceSha,jobName:name});carry='';dropping=false;}
    }
  }if(carry&&!dropping)collectEvidence(evidence,carry,{runId,sourceSha,jobName:name});}
  finally{await reader.cancel();}
  return evidence;
}
export async function main(env=process.env,fetcher=fetch){
  assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.GITHUB_REPOSITORY,REPO);assert.equal(env.GITHUB_JOB,'model-status');
  const runId=env.GITHUB_RUN_ID,attempt=Number(env.GITHUB_RUN_ATTEMPT),headSha=env.GITHUB_SHA;
  assert.match(runId??'',/^[1-9]\d*$/);assert.ok(Number.isSafeInteger(attempt)&&attempt>0);assert.match(headSha??'',/^[a-f0-9]{40}$/);
  const workflow=readFileSync(new URL('../.github/workflows/bake.yml',import.meta.url),'utf8');
  const sources=[...workflow.matchAll(/^          ref: ([a-f0-9]{40})$/gm)].map(match=>match[1]);
  assert.equal(sources.length,3);assert.equal(new Set(sources).size,1);const sourceSha=sources[0];
  const token=env.GH_TOKEN;assert.ok(token);let jobs=[],evidence={},readStatus='complete';
  try{
    validateRun(await jsonGet(`/actions/runs/${runId}`,token,fetcher),{runId,attempt,headSha});
    const result=await jsonGet(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,token,fetcher);
    assert.ok(Array.isArray(result.jobs)&&result.total_count<=100);
    jobs=result.jobs.filter(job=>['bake',...MODELS.map(jobName)].includes(job.name));
    assert.ok(jobs.length<=12&&new Set(jobs.map(job=>job.name)).size===jobs.length);
    assert.ok(jobs.every(job=>String(job.run_id)===runId&&job.head_sha===headSha));
    const pending=[...jobs];await Promise.all(Array.from({length:3},async()=>{for(let job;(job=pending.shift());){
      try{evidence[job.name]=await readJobLog(job.id,{token,runId,sourceSha,jobName:job.name,fetcher});}
      catch{evidence[job.name]={readStatus:'unavailable'};}
    }}));
    if(Object.values(evidence).some(value=>value.readStatus!=='complete'))readStatus='partial-evidence';
  }catch{jobs=[];evidence={};readStatus='metadata-unavailable';}
  const report=buildReport({runId,attempt,headSha,sourceSha,jobs,evidence,readStatus});
  const output=resolve(env.RUNNER_TEMP,'weatherx-model-status','report.json');mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n');appendFileSync(env.GITHUB_STEP_SUMMARY,markdown(report));
  console.log(`Model status report: ${report.outcome}; ${report.publishedMapCount}/11 historical map inclusions; not a live-health certification.`);
  return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(()=>{console.error('Model report unavailable; no publication or health claim.');process.exitCode=1;});
