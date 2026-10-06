// Read-only browser evidence; this lane cannot publish or clear release fuses.
import assert from 'node:assert/strict';
import {strictPaintReceipt} from './ui-layer-paint-proof.mjs';
import {createHash} from 'node:crypto';
import {execFileSync, spawn} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, appendFileSync, lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const SOURCE='5b622f594b107e105dae9ee6b494c20ff8d0699a';
export const RELEASE='git-5b622f594b10-run-36293915679';
export const INDEX='1a9b3dd49125fbd22d6456e108bb1e0528660105fd87f27620668ca8b41728a4';
export const RECOVERY_SOURCE='547a8e1e54a7e46b211ea0770d895b6cc46c8afd';
export const RECOVERY_RELEASE='git-547a8e1e54a7-run-37413651923';
export const RECOVERY_INDEX='1183bb846808b0d628333c17cbbb6e1edfead1b74afbdc194710fd1c321ad697';
export const TARGETS=Object.freeze({staging:'https://staging.weatherx.org','failed-preview':'https://73c343d0.atmos-platform-dnp.pages.dev',
 'recovery-preview':'https://2fd3d799.weatherx-platform-staging.pages.dev'});
export const FILES=Object.freeze({
 'app/e2e/layer-switch-tint.mjs':'6bc8e5cc54190678cdcfbdc181dcde8832a38f02e481495946e142365e4259ef',
 'app/e2e/layer-switch-surface.mjs':'3e6244dc1df4529174cf8e5a65668706f542931d685169d54b88c71c34f8fbe4',
});
export const RECOVERY_FILES=Object.freeze({
 'app/e2e/layer-switch-tint.mjs':'d686f763ce892d2b6288c8caafa0924bf0bef6328847ad3806bd0f395b8e632b',
 'app/e2e/layer-switch-surface.mjs':'3e6244dc1df4529174cf8e5a65668706f542931d685169d54b88c71c34f8fbe4',
});
const HISTORICAL_CONTEXT=Object.freeze({source:SOURCE,release:RELEASE,index:INDEX,files:FILES});
const RECOVERY_CONTEXT=Object.freeze({source:RECOVERY_SOURCE,release:RECOVERY_RELEASE,index:RECOVERY_INDEX,files:RECOVERY_FILES});
export function diagnosticContext(target){
 assert.ok(Object.hasOwn(TARGETS,target),'unsupported diagnostic target');
 return target==='recovery-preview'?RECOVERY_CONTEXT:HISTORICAL_CONTEXT;
}
const reviewedContext=context=>assert.ok(context===HISTORICAL_CONTEXT||context===RECOVERY_CONTEXT,'unreviewed diagnostic context');
const hash=b=>createHash('sha256').update(b).digest('hex');
export function gate(env){
 assert.equal(env.GITHUB_ACTIONS,'true');assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
 assert.equal(env.GITHUB_REPOSITORY,'Andrewegao/v3t7kq-cycle');assert.equal(env.GITHUB_REF,'refs/heads/main');
 assert.equal(env.GITHUB_EVENT_NAME,'workflow_dispatch');
 assert.equal(env.GITHUB_JOB,'diagnose');
 assert.equal(env.GITHUB_WORKFLOW_REF,'Andrewegao/v3t7kq-cycle/.github/workflows/ui-layer-diagnostics.yml@refs/heads/main');
 assert.ok(Object.hasOwn(TARGETS,env.DIAGNOSTIC_TARGET),'unsupported diagnostic target');
 assert.ok(['original','strict-paint'].includes(env.DIAGNOSTIC_MODE),'unsupported diagnostic mode');
 for(const key of ['BASE','ANGLE','CPU_THROTTLE','CLOUDFLARE_API_TOKEN','UI_CANDIDATE_KEY','UI_BUILD_PRIVATE_KEY',
  'R2_PRODUCTION_ACCESS_KEY_ID','R2_PRODUCTION_SECRET_ACCESS_KEY'])assert.ok(!env[key],`diagnostics refuses ${key}`);
 return TARGETS[env.DIAGNOSTIC_TARGET];
}
export function verifySource(root,context=HISTORICAL_CONTEXT){
 reviewedContext(context);
 assert.equal(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),context.source);
 execFileSync('git',['-C',root,'diff','--exit-code','HEAD']);
 for(const [path,expected]of Object.entries(context.files)){
  assert.ok(lstatSync(resolve(root,path)).isFile());
  assert.equal(hash(readFileSync(resolve(root,path))),expected,`diagnostic source changed: ${path}`);
 }
}
export function assertIdentity(receipt,index,context=HISTORICAL_CONTEXT){
 reviewedContext(context);
 assert.equal(receipt.gitSha,context.source);assert.equal(receipt.releaseId,context.release);
 assert.equal(receipt.indexSha256,context.index);assert.equal(hash(index),context.index);
}
export const PREFILL_WAIT=`  await page.waitForFunction((layer) => window.__atmos.store.getState().layers[layer].visible
    && !document.body.dataset.wlSwap, id, { timeout: 30_000 });`;
export const PREFILL_ACTIVATE='  await page.evaluate((layer) => window.__atmos.activateLayer(layer), id);';
// Exact common checkpoints in both reviewed harnesses. These only label the next original
// operation; originalSourceLine is that checkpoint's line in the uninstrumented harness.
export const STAGE_ANCHORS=Object.freeze([
 {stage:'startup-navigation',anchor:'await page.goto(`${BASE}/?fleet=lab&devprobes=1&rendercausal=1&ground=relief#c=104.000,35.000,3.10&t=2026-08-29T05:00Z&l=wind`, {'},
 {stage:'startup-app-ready',anchor:"await page.waitForFunction(() => document.body.classList.contains('wl-lit') && window.__atmos?.deckSnapshot, null, { timeout: 60_000 });"},
 {stage:'startup-opening-retired',anchor:"await page.waitForFunction(() => !document.getElementById('ws-cont')"},
 {stage:'baseline-wind-ready',anchor:'await waitForWind();\n// Native paint can precede the full linked-URL restore.'},
 {stage:'baseline-url-restore',anchor:'await page.waitForFunction(() => !!document.body.dataset.wlUrlCam, null, { timeout: 30_000 });'},
 {stage:'baseline-particles-hidden',anchor:'await page.waitForFunction(() => !window.__atmos.particles.visible && window.__atmos.particles.opacity === 0, null, { timeout: 10_000 });'},
 {stage:'baseline-full-field-paint',anchor:"await page.waitForFunction(() => performance.getEntriesByName('wx:first-field-full-paint').length > 0, null, { timeout: 30_000 });"},
 {stage:'baseline-slider-ready',anchor:'  await page.waitForFunction(forecastSliderReady, null, { timeout: 30_000 });'},
 {stage:'baseline-slider-bounds',anchor:'const scrubWindow = await scrub.evaluate((element) => {'},
 {stage:'baseline-field-commit',anchor:'  await scrub.press(scrubWindow.key);'},
 {stage:'baseline-cursor-settled',anchor:'await page.waitForFunction((cursor) => window.__atmos.store.getState().cursorMs === cursor && !document.body.dataset.wlSwap, frozenCursorMs, { timeout: 30_000 });'},
 {stage:'baseline-ground-ready',anchor:"await page.waitForFunction(() => window.__atmos.map.getLayer('wx-ground'), null, { timeout: 30_000 });"},
 {stage:'baseline-map-tiles-ready',anchor:'await page.waitForFunction(() => window.__atmos.map.areTilesLoaded(), null, { timeout: 30_000 });'},
 {stage:'baseline-capture',anchor:'const baselineState = await snapshot();'},
 {stage:'baseline-idle-control',anchor:'const idleControlState = await snapshot();'},
 {stage:'prefill-entry',anchor:PREFILL_ACTIVATE+'\n'+PREFILL_WAIT},
 {stage:'texture-compaction',anchor:'const recycleBefore = await page.evaluate(() => window.__atmos.weatherTextureBudgetStats().recycles);'},
 {stage:'mid-fade-compaction',anchor:'const midFadeRecycleBefore = await page.evaluate(() => window.__atmos.weatherTextureBudgetStats().recycles);'},
 {stage:'hostile-layer-sequence',anchor:'let temperaturePaintAfterSequence;'},
 {stage:'temperature-before-aba',anchor:'let temperatureBeforeABA;'},
 {stage:'hostile-wind-temp-wind',anchor:"webglPhase = 'rapid-wind-temp-wind';"},
 {stage:'final-capture',anchor:'const finalState = await snapshot();'},
 {stage:'roundtrip-assertions',anchor:"if (!baselineWind || !finalWind) throw new Error('wind raster missing from baseline or final state');"},
].map(Object.freeze));
export function addStageDiagnostics(source){
 const inserts=STAGE_ANCHORS.map(({stage,anchor})=>{
  assert.equal(source.split(anchor).length,2,'diagnostic stage anchor changed: '+stage);
  const offset=source.indexOf(anchor),line=source.slice(0,offset).split('\n').length;
  return {offset,text:'diagnosticStage('+JSON.stringify(stage)+', '+line+');\n'};
 });
 // Descending original offsets keep both original bytes and checkpoint line numbers stable.
 for(const {offset,text} of inserts.sort((a,b)=>b.offset-a.offset))source=source.slice(0,offset)+text+source.slice(offset);
 return source;
}
const ADD_BEFORE=`  await diagnosticSnapshot(id, 'before', Date.now());
  const diagnosticStarted = Date.now();
  try {
`;
const ADD_AFTER=`
  } catch (error) {
    await diagnosticSnapshot(id, 'timeout', diagnosticStarted);
    throw error;
  }
  await diagnosticSnapshot(id, 'settled', diagnosticStarted);`;
export function addDiagnostics(source,runtime,mode='original'){
 assert.ok(['original','strict-paint'].includes(mode));
 const anchor='const page = await context.newPage();';
 assert.equal(source.split(anchor).length,2,'page anchor changed');
 assert.equal(source.split(PREFILL_WAIT).length,2,'prefill wait changed');
 assert.equal(source.split(PREFILL_ACTIVATE+'\n'+PREFILL_WAIT).length,2,'activation/wait adjacency changed');
 // The original wait/assertion bytes are retained verbatim, with observations around them.
 const strict = mode === 'strict-paint';
 const before = strict ? ADD_BEFORE.replace('  const diagnosticStarted', '  const diagnosticExpected = await diagnosticPaintBaseline(id);\n  const diagnosticStarted') : ADD_BEFORE;
 const after = strict ? ADD_AFTER + '\n  await diagnosticWaitForPaint(diagnosticExpected, diagnosticStarted);' : ADD_AFTER;
 const proof = strict ? '\nconst diagnosticPaintPredicate = new Function("return (expected) => { const temp = " + temperatureSurfaceProof.toString() + "; const wind = " + windSurfaceProof.toString() + "; return (" + ' + JSON.stringify(strictPaintReceipt.toString()) + ' + ")(expected, temp, wind); }")();\n' : '';
 return source.replace(anchor,anchor+'\n'+runtime+proof+'\n')
  .replace(PREFILL_ACTIVATE+'\n'+PREFILL_WAIT,before+PREFILL_ACTIVATE+'\n'+PREFILL_WAIT+after);
}
export function filterLine(line){
 if(!line.startsWith('WX_LAYER_DIAGNOSTIC '))return null;
 assert.ok(Buffer.byteLength(line)<=64*1024,'diagnostic line exceeds bound');
 const row=JSON.parse(line.slice('WX_LAYER_DIAGNOSTIC '.length));
 assert.ok(row&&typeof row==='object'&&!Array.isArray(row));
 return JSON.stringify(row)+'\n';
}
export async function checkAfterIdentity(before,read){
 try { const next=await read();assert.deepEqual(next,before);return {ok:true}; }
 catch { return {ok:false,reason:'identity-unavailable-or-changed'}; }
}
export function diagnosticFailure(result,mode){
 if(result.deadlineExceeded)return 'process-deadline';
 if(result.identityAfter?.ok===false)return 'post-run-identity-failed';
 if(mode==='strict-paint'){
  if(/^prefill-(?:temp|cloud|gust|precip|wind)-paint-unproven$/.test(result.phase))return 'strict-paint-unproven';
  if(/^prefill-(?:temp|cloud|gust|precip|wind)-paint-baseline-unavailable$/.test(result.phase))return 'strict-paint-baseline-unavailable';
 }
 return 'original-guard-failed';
}
async function run(root,base,context){
 const out=resolve(process.env.RUNNER_TEMP,'ui-layer-diagnostics');mkdirSync(out,{recursive:true});
 const result={ok:false,phase:'identity-before',identityBefore:false,identityAfter:null,code:null,signal:null,
  deadlineExceeded:false,truncated:false,diagnosticBytes:0};
 // No body or curl error text is retained. Only exact identity digests are recorded.
 const get=path=>execFileSync('curl',['--fail','--silent','--show-error','--max-time','30',base+path],
  {maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe']});
 const readIdentity=()=>{const bytes=get('/health/release.json'),receipt=JSON.parse(bytes),index=get('/');
  assertIdentity(receipt,index,context);return {receiptSha256:hash(bytes),indexSha256:hash(index)};};
 let before;
 try {
  before=readIdentity();result.identityBefore=true;
  const original=readFileSync(resolve(root,'app/e2e/layer-switch-tint.mjs'),'utf8');
  const runtime=readFileSync(new URL('./ui-layer-diagnostics-browser.txt',import.meta.url),'utf8');
  const copy=resolve(root,'app/e2e/.ui-layer-diagnostics.mjs');
  writeFileSync(copy,addDiagnostics(addStageDiagnostics(original),runtime,process.env.DIAGNOSTIC_MODE),{flag:'wx'});
  writeFileSync(resolve(out,'identity.json'),JSON.stringify({sourceSha:context.source,releaseId:context.release,indexSha256:context.index,
   receiptSha256:before.receiptSha256,target:process.env.DIAGNOSTIC_TARGET,origin:base,
   originalHarnessSha256:context.files['app/e2e/layer-switch-tint.mjs'],workflowSha:process.env.GITHUB_SHA,
   instrumentation:{mode:process.env.DIAGNOSTIC_MODE,networkRouting:true,httpCacheDisabled:true},startedAt:new Date().toISOString()},null,2));
  result.phase='browser-launch';
  const log=resolve(out,'observations.jsonl');let buffer='';
  const append=line=>{let safe;try{safe=filterLine(line);}catch{result.truncated=true;return;}
   if(!safe)return;if(result.diagnosticBytes+Buffer.byteLength(safe)>1024*1024){result.truncated=true;return;}
   const row=JSON.parse(safe);if(row.event==='prefill')result.phase=`prefill-${row.layer}-${row.phase}`;
   else if(row.event==='phase')result.phase=row.phase;
   else if(row.event==='fatal'){result.failureCategory=row.category;result.failureStage=row.stage;
    result.originalSourceLine=row.originalSourceLine;result.failureCode=row.failureCode;}
   result.diagnosticBytes+=Buffer.byteLength(safe);appendFileSync(log,safe);};
  // Only system paths and a public target reach the browser process; no inherited tokens.
  const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.RUNNER_TEMP,BASE:base};
  const child=spawn(process.execPath,[copy],{cwd:resolve(root,'app'),env,stdio:['ignore','pipe','pipe'],detached:true});
  const timer=setTimeout(()=>{result.deadlineExceeded=true;try{process.kill(-child.pid,'SIGKILL');}catch{}},15*60_000);
  child.stdout.on('data',chunk=>{buffer+=chunk.toString();let at;while((at=buffer.indexOf('\n'))>=0){append(buffer.slice(0,at));buffer=buffer.slice(at+1);}
   if(buffer.length>128*1024){buffer='';result.truncated=true;}});
  child.stderr.resume();
  const exit=await new Promise(resolve=>{child.on('error',()=>resolve({code:null,signal:'spawn-error'}));
   child.on('close',(code,signal)=>resolve({code,signal}));});
  clearTimeout(timer);Object.assign(result,exit);
 } catch { result.failure='diagnostic-setup-or-identity-failed'; }
 finally {
  if(before)result.identityAfter=await checkAfterIdentity(before,readIdentity);
  result.ok=result.code===0&&result.identityAfter?.ok===true;
  if(!result.ok&&!result.failure)result.failure=diagnosticFailure(result,process.env.DIAGNOSTIC_MODE);
  writeFileSync(resolve(out,'result.json'),JSON.stringify({...result,completedAt:new Date().toISOString()},null,2));
 }
 assert.equal(result.ok,true,'diagnostic failed; inspect bounded result and observations');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const base=gate(process.env),[command,root]=process.argv.slice(2);
  assert.ok(['gate','verify','run'].includes(command));
  if(command==='gate'){assert.equal(root,undefined);}
  else {assert.ok(root);assert.equal(process.argv.length,4);const context=diagnosticContext(process.env.DIAGNOSTIC_TARGET);
   verifySource(resolve(root),context);if(command==='run')await run(resolve(root),base,context);}
 }catch {console.error('Layer diagnostic refused; inspect guarded inputs and retained bounded evidence.');process.exitCode=1;}
}
