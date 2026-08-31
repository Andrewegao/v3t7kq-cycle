// Assemble public staging-model metadata only. This controller has no R2 write,
// serving-pointer, Pages, Worker, production, archive or fusion capability.
import assert from 'node:assert/strict';
import {appendFileSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ACCOUNT} from './shared-data.mjs';
import {MODELS,digest,validateSelection,STAGING_ORIGIN,MAX_SELECTION_BYTES} from './ui-staging-models.mjs';

export const DATA='weatherx-data-staging';
export const INPUTS={icon:'ICON_CATALOG_ID','hrrr-ak':'HRRR_AK_CATALOG_ID',hrdps:'HRDPS_CATALOG_ID',nam:'NAM_CATALOG_ID','nam-hi':'NAM_HI_CATALOG_ID','nam-ak':'NAM_AK_CATALOG_ID','arome-antilles':'AROME_ANTILLES_CATALOG_ID'};
const SHA=/^[a-f0-9]{40}$/,DIGEST=/^[a-f0-9]{64}$/,CATALOG=/^stage-([a-z0-9-]+)-([1-9]\d{0,19})-([1-9]\d{0,3})$/;
const CACHE='public, max-age=31536000, immutable';
const exactKeys=(value,expected)=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value));assert.deepEqual(Object.keys(value).sort(),[...expected].sort());return value;};
const encode=value=>Buffer.from(JSON.stringify(value)+'\n');

export function request(env){
  const catalogs={};
  for(const model of MODELS){const id=env[INPUTS[model]];assert.match(id??'',CATALOG);const match=CATALOG.exec(id);assert.equal(match[1],model,'catalog/model mismatch');catalogs[model]=id;}
  assert.equal(new Set(Object.values(catalogs)).size,MODELS.length,'duplicate catalog');return catalogs;
}
export function gate(env){
  for(const [key,value] of Object.entries({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_JOB:'assemble',GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/staging-model-selection.yml@refs/heads/main',STAGING_DATA_ISOLATION_APPROVED:'true',STAGING_MODEL_SELECTION_ENABLED:'true',STAGING_R2_ACCOUNT_ID:ACCOUNT}))assert.equal(env[key],value,key);
  assert.match(env.GITHUB_RUN_ID??'',/^[1-9]\d{0,19}$/);assert.match(env.GITHUB_RUN_ATTEMPT??'',/^[1-9]\d{0,3}$/);
  assert.match(env.STAGING_MODEL_APPROVED_SOURCE_SHA??'',SHA);assert.match(env.STAGING_MODEL_VALIDATOR_SOURCE_SHA??'',SHA);
  const catalogs=request(env),text=env.STAGING_MODEL_SELECTION_APPROVED_CATALOGS_JSON;
  assert.ok(typeof text==='string'&&text.length>0&&text.length<=2048,'bounded catalog approval required');
  const approved=exactKeys(JSON.parse(text),MODELS);for(const model of MODELS)assert.equal(approved[model],catalogs[model],`unapproved ${model} catalog`);
  return {catalogs,sourceSha:env.STAGING_MODEL_APPROVED_SOURCE_SHA,validatorSha:env.STAGING_MODEL_VALIDATOR_SOURCE_SHA};
}
export const selectionKey=(model,catalogId)=>{assert.ok(MODELS.includes(model));assert.match(catalogId,CATALOG);assert.equal(CATALOG.exec(catalogId)[1],model);return `staging-candidates/model-components/${catalogId}/selection.json`;};

function validateObject(value,model,catalogId,ctx,now){
  assert.ok(value&&Buffer.isBuffer(value.body)&&value.body.length>0&&value.body.length<=MAX_SELECTION_BYTES);
  assert.equal(value.bytes,value.body.length);assert.equal(value.sha256,digest(value.body));assert.deepEqual(value.customMetadata,{sha256:value.sha256},'exact selection metadata hash required');
  assert.equal(value.httpMetadata?.contentType,'application/json');assert.equal(value.httpMetadata?.cacheControl,CACHE);assert.equal(value.httpMetadata?.contentEncoding,undefined);
  const entry=JSON.parse(value.body);const bundle=validateSelection(encode({schemaVersion:1,kind:'weatherx-staging-model-selection',targetOrigin:STAGING_ORIGIN,entries:[entry]}),digest(encode({schemaVersion:1,kind:'weatherx-staging-model-selection',targetOrigin:STAGING_ORIGIN,entries:[entry]})),now);
  assert.equal(entry.model,model);assert.equal(entry.catalogId,catalogId);assert.equal(entry.collectorSourceSha,ctx.sourceSha);assert.equal(entry.validatorSourceSha,ctx.validatorSha);
  const match=CATALOG.exec(catalogId);assert.deepEqual(entry.validatorRun,{runId:match[2],runAttempt:match[3],runnerEnvironment:'github-hosted'});
  return bundle.entries[0];
}
export async function assemble(ctx,{io,now=Date.now()}){
  const entries=[];
  for(const model of MODELS){const catalogId=ctx.catalogs[model],value=await io.get(DATA,selectionKey(model,catalogId),MAX_SELECTION_BYTES);assert.ok(value,`missing ${model} selection`);entries.push(validateObject(value,model,catalogId,ctx,now));}
  entries.sort((a,b)=>a.model.localeCompare(b.model));assert.equal(new Set(entries.map(x=>x.model)).size,MODELS.length);
  const body=encode({schemaVersion:1,kind:'weatherx-staging-model-selection',targetOrigin:STAGING_ORIGIN,entries}),sha256=digest(body);
  validateSelection(body,sha256,now);return {body,sha256,entries};
}
function directory(path){const stat=lstatSync(path);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink());assert.equal(realpathSync(path),path);}
export function writeSelection(temp,result,outputFile){
  assert.equal(resolve(temp),temp);directory(temp);const root=resolve(temp,'weatherx-staging-model-selection');assert.equal(existsSync(root),false,'fresh artifact directory required');mkdirSync(root,{mode:0o700});directory(root);
  const path=resolve(root,result.sha256+'.json');writeFileSync(path,result.body,{flag:'wx',mode:0o600});assert.deepEqual(readdirSync(root),[result.sha256+'.json']);
  assert.deepEqual(readFileSync(path),result.body);assert.equal(digest(readFileSync(path)),result.sha256);
  if(outputFile){assert.equal(resolve(outputFile),outputFile);const stat=lstatSync(outputFile);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=1024*1024);directory(dirname(outputFile));appendFileSync(outputFile,`selection_sha256=${result.sha256}\nselection_path=${path}\n`);}
  return path;
}

export async function createSelectionS3(env,ctx,injectedClient,injectedSdk){
  assert.equal(env.STAGING_R2_ACCOUNT_ID,ACCOUNT);assert.ok(env.STAGING_R2_WRITE_ACCESS_KEY_ID&&env.STAGING_R2_WRITE_SECRET_ACCESS_KEY,'staging S3 credential required');
  assert.deepEqual(ctx,gate(env),'storage reader requires exact protected request');
  const sdk=injectedSdk??await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js'),client=injectedClient??new sdk.S3Client({region:'auto',endpoint:`https://${ACCOUNT}.r2.cloudflarestorage.com`,forcePathStyle:true,maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',credentials:{accessKeyId:env.STAGING_R2_WRITE_ACCESS_KEY_ID,secretAccessKey:env.STAGING_R2_WRITE_SECRET_ACCESS_KEY}});
  return {async get(bucket,key,maxBytes){assert.equal(bucket,DATA);assert.ok(MODELS.some(model=>key===selectionKey(model,ctx.catalogs[model])),'read outside approved selections');assert.equal(maxBytes,MAX_SELECTION_BYTES);
    let object;try{object=await client.send(new sdk.GetObjectCommand({Bucket:bucket,Key:key}),{abortSignal:AbortSignal.timeout(45_000)});}catch{throw Error('staging selection read failed');}
    if(!object)return null;const chunks=[];let bytes=0;try{assert.ok(Number.isSafeInteger(object.ContentLength)&&object.ContentLength>0&&object.ContentLength<=maxBytes);assert.ok(object.Body?.[Symbol.asyncIterator]);for await(const chunk of object.Body){bytes+=chunk.length;assert.ok(bytes<=maxBytes);chunks.push(Buffer.from(chunk));}assert.equal(bytes,object.ContentLength);const body=Buffer.concat(chunks);return {body,bytes,sha256:digest(body),customMetadata:object.Metadata??{},httpMetadata:{contentType:object.ContentType,cacheControl:object.CacheControl,contentEncoding:object.ContentEncoding}};}finally{object.Body?.destroy?.();}},close:()=>client.destroy?.()};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const ctx=gate(process.env),command=process.argv[2];if(command==='gate')console.log(JSON.stringify({models:MODELS.length,production:false,writes:false}));
    else if(command==='assemble'){const io=await createSelectionS3(process.env,ctx);try{const result=await assemble(ctx,{io});const path=writeSelection(resolve(process.env.RUNNER_TEMP),result,resolve(process.env.GITHUB_OUTPUT));console.log(JSON.stringify({selectionSha256:result.sha256,path,models:result.entries.length,production:false,writes:false}));}finally{io.close();}}
    else throw Error('unsupported operation');
  }catch{console.error('Staging model selection assembly refused; no storage or deployment was changed.');process.exitCode=1;}
}
