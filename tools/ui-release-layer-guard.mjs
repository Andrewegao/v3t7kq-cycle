// Candidate-only release proof. No deployment credentials reach the browser process.
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,lstatSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {PUBLIC_COMBINED_ATMOS_SHA} from './ui-public-combined.mjs';
import {addDiagnostics,addStageDiagnostics,filterLine,diagnosticFailure} from './ui-layer-diagnostics.mjs';
// Current release admission is independent of the historical diagnostics target.
export const RELEASE_LAYER_FILES=Object.freeze({
 'app/e2e/layer-switch-tint.mjs':'df65cf5409c67f0001a6cbf5edf7847c0d1798a2bf437714b9035b06d8d2c67a',
 'app/e2e/layer-switch-surface.mjs':'441de2a52996646a8540a6df2f7f346c143f6efcd41daf3d9ab4c6ddf4ca9809',
});
const ORIGINS=Object.freeze({staging:'https://staging.weatherx.org',production:'https://weatherx.org'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function layerGuardContext(context){
 assert.ok(Object.hasOwn(ORIGINS,context.stage),'unsupported layer guard target');
 assert.equal(context.sourceSha,PUBLIC_COMBINED_ATMOS_SHA,'unreviewed layer guard source');
 assert.match(context.releaseId,new RegExp(`^git-${context.sourceSha.slice(0,12)}-run-[1-9][0-9]*$`));
 for(const key of ['indexSha256','receiptSha256'])assert.match(context[key]??'',/^[a-f0-9]{64}$/);
 for(const key of ['controlRoot','runnerTemp'])assert.equal(resolve(context[key]),context[key]);
 return ORIGINS[context.stage];
}
export function layerGuardIdentity(context,receiptBytes,indexBytes){
 const receipt=JSON.parse(receiptBytes);
 assert.equal(receipt.gitSha,context.sourceSha);assert.equal(receipt.releaseId,context.releaseId);
 assert.equal(receipt.indexSha256,context.indexSha256);
 assert.equal(hash(receiptBytes),context.receiptSha256);assert.equal(hash(indexBytes),context.indexSha256);
}
export function layerGuardSource(root,sourceSha){
 assert.equal(sourceSha,PUBLIC_COMBINED_ATMOS_SHA);
 assert.equal(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',stdio:'pipe'}).trim(),sourceSha);
 execFileSync('git',['-C',root,'diff','--exit-code','HEAD'],{stdio:'pipe'});
 const hashes={};
 for(const path of Object.keys(RELEASE_LAYER_FILES)){
  assert.ok(lstatSync(resolve(root,path)).isFile());
  hashes[path]=hash(readFileSync(resolve(root,path)));
 }
 layerGuardSourceHashes(hashes);
}
export function layerGuardSourceHashes(hashes){
 assert.deepEqual(Object.keys(hashes).sort(),Object.keys(RELEASE_LAYER_FILES).sort(),'layer guard source inventory mismatch');
 for(const [path,expected]of Object.entries(RELEASE_LAYER_FILES))
  assert.equal(hashes[path],expected,'layer guard controller hash mismatch');
}
export function layerGuardChildEnvironment(env,base){
 assert.ok(Object.values(ORIGINS).includes(base));
 return {PATH:env.PATH,HOME:env.HOME,TMPDIR:env.RUNNER_TEMP,BASE:base};
}
export function layerGuardPaintEvidence(observations){
 const proven=observations.filter(row=>row.event==='prefill'&&row.phase==='paint-proven');
 assert.deepEqual(proven.map(row=>row.layer),['temp','cloud','gust','precip','wind'],'incomplete strict prefill paint evidence');
 for(const row of proven){
  assert.equal(row.receipt?.layer,row.layer);assert.ok(['native','deck'].includes(row.receipt.owner));
  if(row.receipt.owner==='native')assert.ok(['temp','wind'].includes(row.layer));
  assert.equal(typeof row.receipt.authoritativeDeck,'boolean');
  if(row.receipt.owner==='deck')assert.equal(row.receipt.authoritativeDeck,true);
  for(const key of ['intentGeneration','receiptSequence'])assert.ok(Number.isInteger(row.receipt[key])&&row.receipt[key]>=0);
 }
 return proven.map(row=>({layer:row.layer,...row.receipt}));
}
export async function waitForLayerGuardChild(child,{timeoutMs=15*60_000,kill=pid=>process.kill(pid,'SIGKILL')}={}){
 let deadlineExceeded=false;
 const cleanup=()=>{if(Number.isInteger(child.pid)&&child.pid>0)try{kill(-child.pid);}catch{}};
 const timer=setTimeout(()=>{deadlineExceeded=true;cleanup();},timeoutMs);
 try{
  const exit=await new Promise(resolve=>{
   child.once('error',()=>resolve({code:null,signal:'spawn-error'}));
   child.once('close',(code,signal)=>resolve({code,signal}));
  });
  return {...exit,deadlineExceeded};
 }finally{clearTimeout(timer);cleanup();}
}
export function layerGuardSucceeded(result){
 return result.code===0&&result.identityBefore===true&&result.identityAfter?.ok===true
  && !result.deadlineExceeded&&!result.truncated&&!result.failure;
}
export async function runReleaseLayerGuard(context){
 const base=layerGuardContext(context),out=resolve(context.runnerTemp,'ui-incidents');
 mkdirSync(out,{recursive:true});
 const id=`layer-paint-${context.stage}-${randomUUID()}`;
 const result={sourceSha:context.sourceSha,releaseId:context.releaseId,indexSha256:context.indexSha256,
  receiptSha256:context.receiptSha256,stage:context.stage,mode:'strict-paint',startedAt:new Date().toISOString(),
  ok:false,phase:'source-identity-preflight',identityBefore:false,identityAfter:null,code:null,signal:null,
  deadlineExceeded:false,truncated:false,diagnosticBytes:0,httpCacheDisabled:true};
 const observations=[];
 const get=path=>execFileSync('curl',['--fail','--silent','--show-error','--max-time','30',base+path],
  {maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
 const identity=()=>layerGuardIdentity(context,get('/health/release.json'),get('/'));
 let copy;
 try{
  layerGuardSource(context.controlRoot,context.sourceSha);identity();result.identityBefore=true;
  const source=readFileSync(resolve(context.controlRoot,'app/e2e/layer-switch-tint.mjs'),'utf8');
  const runtime=readFileSync(new URL('./ui-layer-diagnostics-browser.txt',import.meta.url),'utf8');
  copy=resolve(context.controlRoot,`app/e2e/.ui-release-layer-${id}.mjs`);
  writeFileSync(copy,addDiagnostics(addStageDiagnostics(source),runtime,'strict-paint'),{flag:'wx',mode:0o600});
  let buffer='';result.phase='browser-launch';
  const append=line=>{
   let safe;try{safe=filterLine(line);}catch{result.truncated=true;return;}
   if(!safe)return;
   if(result.diagnosticBytes+Buffer.byteLength(safe)>1024*1024){result.truncated=true;return;}
   const row=JSON.parse(safe);result.diagnosticBytes+=Buffer.byteLength(safe);observations.push(row);
   if(row.event==='prefill')result.phase=`prefill-${row.layer}-${row.phase}`;
   else if(row.event==='phase')result.phase=row.phase;
   else if(row.event==='fatal'){
    result.failureCategory=row.category;result.failureStage=row.stage;
    result.originalSourceLine=row.originalSourceLine;result.failureCode=row.failureCode;
   }
  };
  const child=spawn(process.execPath,[copy],{cwd:resolve(context.controlRoot,'app'),
   env:layerGuardChildEnvironment({...process.env,RUNNER_TEMP:context.runnerTemp},base),stdio:['ignore','pipe','pipe'],detached:true});
  child.stdout.on('data',chunk=>{buffer+=chunk.toString();let at;
   while((at=buffer.indexOf('\n'))>=0){append(buffer.slice(0,at));buffer=buffer.slice(at+1);}
   if(buffer.length>128*1024){buffer='';result.truncated=true;}});
  child.stderr.resume();
  Object.assign(result,await waitForLayerGuardChild(child));
  if(result.code===0){
   try{result.paintProofs=layerGuardPaintEvidence(observations);}catch{result.failure='strict-paint-evidence-incomplete';}
  }
 }catch{result.failure='layer-guard-source-or-identity-failed';}
 finally{
  if(result.identityBefore){
   try{identity();result.identityAfter={ok:true};}catch{result.identityAfter={ok:false};}
  }
  result.ok=layerGuardSucceeded(result);
  if(result.truncated&&!result.failure)result.failure='layer-guard-evidence-truncated';
  if(!result.ok&&(result.deadlineExceeded||result.identityAfter?.ok===false||!result.failure))result.failure=diagnosticFailure(result,'strict-paint');
  if(copy)try{unlinkSync(copy);}catch{result.ok=false;result.failure='layer-guard-copy-cleanup-failed';}
  writeFileSync(resolve(out,`${id}.json`),JSON.stringify({...result,completedAt:new Date().toISOString(),observations}));
 }
 assert.equal(result.ok,true,`release layer proof failed: ${result.failure}`);
 return result;
}
// Cheap source-only admission before build work; never fetches an origin or launches a browser.
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 assert.equal(process.argv[2],'source','unsupported layer guard command');
 assert.equal(process.argv.length,5,'source command requires checkout and exact SHA');
 layerGuardSource(resolve(process.argv[3]),process.argv[4]);
 console.log(JSON.stringify({sourceSha:process.argv[4],files:RELEASE_LAYER_FILES,sourceAdmission:true,browserExecuted:false}));
}
