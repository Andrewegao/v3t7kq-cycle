import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PUBLIC_COMBINED_ATMOS_SHA} from '../tools/ui-public-combined.mjs';
import {layerGuardContext,layerGuardIdentity,layerGuardSource,layerGuardChildEnvironment,layerGuardPaintEvidence,runReleaseLayerGuard,waitForLayerGuardChild,layerGuardSucceeded} from '../tools/ui-release-layer-guard.mjs';
import {POLICY_FILES} from '../tools/ui-release.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
 const index=Buffer.from('exact fixture HTML');
 const context={stage:'staging',sourceSha:PUBLIC_COMBINED_ATMOS_SHA,releaseId:`git-${PUBLIC_COMBINED_ATMOS_SHA.slice(0,12)}-run-123`,
  indexSha256:hash(index),controlRoot:'/tmp/fixture-control',runnerTemp:'/tmp/fixture-output'};
 const receipt=Buffer.from(JSON.stringify({gitSha:context.sourceSha,releaseId:context.releaseId,indexSha256:context.indexSha256}));
 context.receiptSha256=hash(receipt);return {context,receipt,index};
}
test('only fixed release origins, reviewed source, and fully bound identities are admitted',()=>{
 const {context}=fixture();
 assert.equal(layerGuardContext(context),'https://staging.weatherx.org');
 assert.equal(layerGuardContext({...context,stage:'production'}),'https://weatherx.org');
 for(const change of [{stage:'failed-preview'},{stage:'https://evil.test'},{stage:'__proto__'},{sourceSha:'a'.repeat(40)},
  {releaseId:'git-'+context.sourceSha.slice(0,12)+'-run-0'},{indexSha256:'a'},{receiptSha256:''},{controlRoot:'relative'}])
  assert.throws(()=>layerGuardContext({...context,...change}));
});
test('served receipt and actual HTML must match the sealed candidate bytes',()=>{
 const {context,receipt,index}=fixture();assert.doesNotThrow(()=>layerGuardIdentity(context,receipt,index));
 assert.throws(()=>layerGuardIdentity(context,Buffer.concat([receipt,Buffer.from(' ')]),index));
 assert.throws(()=>layerGuardIdentity(context,receipt,Buffer.from('changed')));
 for(const key of ['sourceSha','releaseId','indexSha256','receiptSha256'])assert.throws(()=>layerGuardIdentity({...context,[key]:'changed'},receipt,index));
});
test('browser environment strips inherited publication/auth credentials and target overrides',()=>{
 const env=layerGuardChildEnvironment({PATH:'/bin',HOME:'/home',RUNNER_TEMP:'/tmp',GH_TOKEN:'secret',CLOUDFLARE_API_TOKEN:'secret',
  UI_CANDIDATE_KEY:'secret',BASE:'https://evil.test',ANGLE:'override',CPU_THROTTLE:'10'},'https://weatherx.org');
 assert.deepEqual(env,{PATH:'/bin',HOME:'/home',TMPDIR:'/tmp',BASE:'https://weatherx.org'});
 assert.throws(()=>layerGuardChildEnvironment({},'https://weatherx.org.evil.test'));
});
test('successful browser exit requires every strict prefill receipt in original order',()=>{
 const rows=['temp','cloud','gust','precip','wind'].map((layer,index)=>({event:'prefill',phase:'paint-proven',layer,
  receipt:{layer,owner:layer==='temp'?'native':'deck',authoritativeDeck:layer!=='temp',intentGeneration:index+1,receiptSequence:index+10}}));
 assert.equal(layerGuardPaintEvidence(rows).length,5);
 for(const invalid of [[],rows.slice(1),[...rows].reverse(),[...rows,rows[0]],rows.map(row=>({...row,receipt:{...row.receipt,owner:'native'}}))])
  assert.throws(()=>layerGuardPaintEvidence(invalid));
});
test('source refusal is retained without a browser or identity fetch, and no raw source/error text leaks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'wx-layer-source-'));
 try{
  const {context}=fixture();context.controlRoot=root;context.runnerTemp=root;
  assert.throws(()=>layerGuardSource(root,context.sourceSha));
  await assert.rejects(runReleaseLayerGuard(context),/layer-guard-source-or-identity-failed/);
  const files=readdirSync(join(root,'ui-incidents'));assert.equal(files.length,1);
  const result=JSON.parse(readFileSync(join(root,'ui-incidents',files[0])));
  assert.equal(result.ok,false);assert.equal(result.identityBefore,false);assert.equal(result.code,null);
  assert.deepEqual(result.observations,[]);assert.equal(result.failure,'layer-guard-source-or-identity-failed');
  assert.ok(!JSON.stringify(result).includes(root));
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('corrected runner and transitive source are pipeline-bound inside candidate verification only',()=>{
 for(const file of ['tools/ui-release-layer-guard.mjs','tools/ui-layer-diagnostics.mjs','tools/ui-layer-diagnostics-browser.txt','tools/ui-layer-paint-proof.mjs'])
  assert.ok(POLICY_FILES.includes(file),file);
 const release=readFileSync(new URL('../tools/ui-release.mjs',import.meta.url),'utf8');
 const verify=release.split('async function verify(stage) {')[1].split('\nasync function retain()')[0];
 assert.ok(verify.indexOf("if (phase !== 'rollback')")<verify.indexOf('await runReleaseLayerGuard'));
 assert.match(verify,/if\(publicCombinedProfile\(c.profile\)\)await runReleaseLayerGuard/);
 assert.match(verify,/else run\('node',\[resolve\(CONTROL,'app\/e2e\/layer-switch-tint.mjs'\)\]/);
 const runner=readFileSync(new URL('../tools/ui-release-layer-guard.mjs',import.meta.url),'utf8');
 assert.ok(runner.includes("addDiagnostics(source,runtime,'strict-paint')"));
 assert.match(runner,/finally\{[\s\S]*identity\(\);result.identityAfter/);
 assert.ok(runner.includes('15*60_000'));assert.ok(runner.includes('1024*1024'));
 assert.ok(runner.includes('kill(-child.pid)'));
 assert.doesNotMatch(runner,/pages deploy|wrangler|openFuse|clearLocalFuse/);
});

test('browser process groups are cleaned up after success, failure, spawn error, and deadline',async()=>{
 const {EventEmitter}=await import('node:events');
 for(const outcome of ['success','failure','error','deadline']){
  const child=new EventEmitter();child.pid=34567;const killed=[];
  const waiting=waitForLayerGuardChild(child,{timeoutMs:outcome==='deadline'?5:1000,kill:pid=>{
   killed.push(pid);if(outcome==='deadline')queueMicrotask(()=>child.emit('close',null,'SIGKILL'));
  }});
  if(outcome==='error')queueMicrotask(()=>child.emit('error',new Error('private detail')));
  else if(outcome!=='deadline')queueMicrotask(()=>child.emit('close',outcome==='success'?0:1,null));
  const result=await waiting;assert.ok(killed.length>=1);assert.ok(killed.every(pid=>pid===-34567));
  assert.equal(result.deadlineExceeded,outcome==='deadline');
  if(outcome==='error')assert.equal(result.signal,'spawn-error');
 }
});
test('exit zero cannot hide missing identity, truncated evidence, or an expired deadline',()=>{
 const result={code:0,identityBefore:true,identityAfter:{ok:true}};
 assert.equal(layerGuardSucceeded(result),true);
 for(const change of [{code:1},{identityBefore:false},{identityAfter:{ok:false}},{deadlineExceeded:true},{truncated:true},{failure:'proof-missing'}])
  assert.equal(layerGuardSucceeded({...result,...change}),false);
});
