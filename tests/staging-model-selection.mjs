import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {mkdtempSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {ACCOUNT} from '../tools/shared-data.mjs';
import {MODELS,GRIDS,variables,displayPaths,canonical,digest,validateSelection} from '../tools/ui-staging-models.mjs';
import {DATA,INPUTS,request,gate,selectionKey,assemble,writeSelection,createSelectionS3} from '../tools/staging-model-selection.mjs';

const NOW=Date.parse('2026-08-31T20:00:00Z'),INIT='2026083112',SOURCE='a'.repeat(40),VALIDATOR='b'.repeat(40),HASH='d'.repeat(64);
const CATALOGS={icon:'stage-icon-33441950112-1','hrrr-ak':'stage-hrrr-ak-33441950136-1','nam-hi':'stage-nam-hi-33441949773-1',hrdps:'stage-hrdps-33442744025-1',nam:'stage-nam-33442743910-1','nam-ak':'stage-nam-ak-33443398599-1','arome-antilles':'stage-arome-antilles-33443398590-1'};
function env(){const value={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_JOB:'assemble',GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/staging-model-selection.yml@refs/heads/main',GITHUB_RUN_ID:'999',GITHUB_RUN_ATTEMPT:'1',STAGING_DATA_ISOLATION_APPROVED:'true',STAGING_MODEL_SELECTION_ENABLED:'true',STAGING_MODEL_SELECTION_APPROVED_CATALOGS_JSON:JSON.stringify(CATALOGS),STAGING_MODEL_APPROVED_SOURCE_SHA:SOURCE,STAGING_MODEL_VALIDATOR_SOURCE_SHA:VALIDATOR,STAGING_R2_ACCOUNT_ID:ACCOUNT};for(const model of MODELS)value[INPUTS[model]]=CATALOGS[model];return value;}
function entry(model){const match=/-(\d+)-(\d+)$/.exec(CATALOGS[model]),artifactId=`stage-${INIT}-${match[1]}-${match[2]}`,files=displayPaths(INIT).map((path,index)=>({path,bytes:index+1,sha256:digest(model+'/'+path)}));return {schemaVersion:1,kind:'weatherx-staging-model-selection-entry',targetOrigin:'https://staging.weatherx.org',model,status:'DATA_QUALIFIED',catalogId:CATALOGS[model],catalogSha256:HASH,component:{artifactId,manifestKey:`components/${model}/${artifactId}/component.json`,manifestSha256:HASH,inventorySha256:HASH},collectorSourceSha:SOURCE,validatorSourceSha:VALIDATOR,cloudSource:{runId:'12',runAttempt:'1'},validatorRun:{runId:match[1],runAttempt:match[2],runnerEnvironment:'github-hosted'},archiveReceiptSha256:HASH,archiveMarkerSha256:HASH,sourceReceiptSha256:HASH,stagedQualificationSha256:HASH,createdAt:new Date(NOW).toISOString(),stagingDataQualified:true,init:INIT,leadCount:49,horizonHours:48,grid:GRIDS[model],variables:variables(model),windReference:'earth-relative',displayInventory:files,displayInventorySha256:digest(canonical(files)),indexPath:`/data/_catalog/${CATALOGS[model]}/${model}/index.json`,manifestPath:`/data/_catalog/${CATALOGS[model]}/${model}/runs/${INIT}/manifest.json`,browserQualified:false,fusionEligible:false,productionPublishable:false,weatherxFusionIssued:false};}
const encode=value=>Buffer.from(JSON.stringify(value)+'\n');
function object(value){const body=encode(value);return {body,bytes:body.length,sha256:digest(body),customMetadata:{sha256:digest(body)},httpMetadata:{contentType:'application/json',cacheControl:'public, max-age=31536000, immutable',contentEncoding:undefined}};}
function fixture(){const ctx=gate(env()),objects=new Map(MODELS.map(model=>[selectionKey(model,CATALOGS[model]),object(entry(model))]));return {ctx,objects,io:{get:async(bucket,key,max)=>{assert.equal(bucket,DATA);assert.equal(max,1024*1024);return objects.get(key)??null;}}};}

test('manual hosted main and exact protected seven-catalog approval are mandatory',()=>{
  assert.deepEqual(request(env()),CATALOGS);assert.deepEqual(gate(env()).catalogs,CATALOGS);
  for(const mutate of [e=>e.GITHUB_EVENT_NAME='push',e=>e.GITHUB_REF='refs/heads/other',e=>e.GITHUB_JOB='other',e=>e.STAGING_DATA_ISOLATION_APPROVED='false',e=>e.STAGING_MODEL_SELECTION_ENABLED='false',e=>e.STAGING_R2_ACCOUNT_ID='wrong',e=>e.STAGING_MODEL_APPROVED_SOURCE_SHA='x',e=>{const a=JSON.parse(e.STAGING_MODEL_SELECTION_APPROVED_CATALOGS_JSON);a.icon='stage-icon-1-1';e.STAGING_MODEL_SELECTION_APPROVED_CATALOGS_JSON=JSON.stringify(a);},e=>delete e.ICON_CATALOG_ID]){const bad=env();mutate(bad);assert.throws(()=>gate(bad));}
});
test('seven exact immutable entries assemble into one sorted content-addressed public bundle',async()=>{
  const f=fixture(),result=await assemble(f.ctx,{io:f.io,now:NOW});assert.equal(result.entries.length,7);assert.deepEqual(result.entries.map(x=>x.model),[...MODELS].sort());assert.equal(digest(result.body),result.sha256);validateSelection(result.body,result.sha256,NOW);
  const temp=realpathSync(mkdtempSync(resolve(tmpdir(),'wx-selection-output-'))),output=resolve(temp,'github-output');writeFileSync(output,'');const path=writeSelection(temp,result,output);
  assert.equal(path,resolve(temp,'weatherx-staging-model-selection',result.sha256+'.json'));assert.deepEqual(readFileSync(path),result.body);assert.equal(readFileSync(output,'utf8'),`selection_sha256=${result.sha256}\nselection_path=${path}\n`);
});
test('missing, duplicate, wrong source/validator/run/catalog and stale entries fail closed',async()=>{
  const mutations=[f=>f.objects.delete(selectionKey('icon',CATALOGS.icon)),f=>f.objects.set(selectionKey('hrdps',CATALOGS.hrdps),object(entry('icon'))),f=>{const e=entry('nam');e.collectorSourceSha='c'.repeat(40);f.objects.set(selectionKey('nam',CATALOGS.nam),object(e));},f=>{const e=entry('nam-hi');e.validatorSourceSha='c'.repeat(40);f.objects.set(selectionKey('nam-hi',CATALOGS['nam-hi']),object(e));},f=>{const e=entry('nam-ak');e.validatorRun.runId='1';f.objects.set(selectionKey('nam-ak',CATALOGS['nam-ak']),object(e));},f=>{const e=entry('hrrr-ak');e.catalogId='stage-hrrr-ak-1-1';f.objects.set(selectionKey('hrrr-ak',CATALOGS['hrrr-ak']),object(e));}];
  for(const mutate of mutations){const f=fixture();mutate(f);await assert.rejects(assemble(f.ctx,{io:f.io,now:NOW}));}
  const stale=fixture();await assert.rejects(assemble(stale.ctx,{io:stale.io,now:NOW+13*3600_000}));
});
test('unqualified or promoted authority flags are never assembled',async()=>{
  for(const mutate of [e=>e.status='UNQUALIFIED',e=>e.stagingDataQualified=false,e=>e.browserQualified=true,e=>e.fusionEligible=true,e=>e.productionPublishable=true,e=>e.weatherxFusionIssued=true]){const f=fixture(),e=entry('icon');mutate(e);f.objects.set(selectionKey('icon',CATALOGS.icon),object(e));await assert.rejects(assemble(f.ctx,{io:f.io,now:NOW}));}
});
test('S3 adapter can issue only exact bounded GETs from the staging data bucket',async()=>{
  class GetObjectCommand{constructor(input){this.input=input;}}const calls=[],body=object(entry('icon')).body,client={send:async command=>{calls.push(command);return {ContentLength:body.length,Body:Readable.from([body]),Metadata:{sha256:digest(body)},ContentType:'application/json',CacheControl:'public, max-age=31536000, immutable'};}};
  const value=env();Object.assign(value,{STAGING_R2_WRITE_ACCESS_KEY_ID:'synthetic-id',STAGING_R2_WRITE_SECRET_ACCESS_KEY:'synthetic-secret'});const io=await createSelectionS3(value,gate(value),client,{GetObjectCommand});
  const result=await io.get(DATA,selectionKey('icon',CATALOGS.icon),1024*1024);assert.equal(result.sha256,digest(body));assert.deepEqual(calls[0].input,{Bucket:DATA,Key:selectionKey('icon',CATALOGS.icon)});
  const count=calls.length;await assert.rejects(io.get(DATA,'catalogs/current.json',1024*1024));await assert.rejects(io.get('weatherx-data-production',selectionKey('icon',CATALOGS.icon),1024*1024));assert.equal(calls.length,count);
  const changed={...value,STAGING_MODEL_SELECTION_APPROVED_CATALOGS_JSON:JSON.stringify({...CATALOGS,icon:'stage-icon-1-1'})};await assert.rejects(createSelectionS3(changed,gate(value),client,{GetObjectCommand}));
});
test('workflow retains only one short-lived public JSON and has no mutation or deployment capability',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/staging-model-selection.yml',import.meta.url),'utf8'),tool=readFileSync(new URL('../tools/staging-model-selection.mjs',import.meta.url),'utf8');assert.match(workflow,/workflow_dispatch:/);assert.doesNotMatch(workflow,/\n  (?:push|schedule|workflow_run|pull_request):/);assert.match(workflow,/environment:\n\s+name: data-staging/);
  assert.equal((workflow.match(/actions\/upload-artifact@/g)??[]).length,1);assert.match(workflow,/path: \$\{\{ steps\.selection\.outputs\.selection_path \}\}[\s\S]*retention-days: 3/);
  assert.doesNotMatch(workflow,/MODEL_INPUT_ARCHIVE_KEY|PAGES_TOKEN|WORKER_TOKEN|CLOUDFLARE_API_TOKEN|PRODUCTION.*TOKEN|CATALOG_PROMOTION|releases\/current|catalogs\/current|wrangler|ui-release\.mjs|guard-pages-deploy|actions\/cache@/i);
  const credentialBlock=workflow.split('- name: Read exact immutable selection entries')[1].split('- name: Retain only')[0];assert.match(credentialBlock,/STAGING_R2_WRITE_ACCESS_KEY_ID/);assert.doesNotMatch(workflow.split('- name: Retain only')[1],/secrets\.|STAGING_R2/);
  assert.doesNotMatch(tool,/PutObjectCommand|DeleteObjectCommand|ListObjects|\.put\(|\.delete\(|catalogs\/current|releases\/current/);
  for(const line of workflow.split('\n').filter(x=>x.includes('uses:')))assert.match(line,/@[a-f0-9]{40}\b/);
});
