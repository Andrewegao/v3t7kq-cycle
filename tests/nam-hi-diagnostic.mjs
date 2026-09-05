import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, privateDecrypt, createDecipheriv, createHash} from 'node:crypto';
import {readFileSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {APPROVED_SOURCE, MODEL, validateInit, gate, collectorPlan, encryptedTail, runChild, qualificationSummary} from '../tools/nam-hi-diagnostic.mjs';

const keys=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
function decrypt(envelope){
  const key=privateDecrypt({key:keys.privateKey,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64'));
  const d=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
  d.setAAD(Buffer.from(`weatherx-nam-hi-diagnostic/v1:${envelope.keySha256}`));
  d.setAuthTag(Buffer.from(envelope.tag,'base64'));
  const payload=JSON.parse(Buffer.concat([d.update(Buffer.from(envelope.ciphertext,'base64')),d.final()]).toString());
  return Buffer.from(payload.stdout,'base64').toString()+Buffer.from(payload.stderr,'base64').toString();
}
const now=new Date('2026-09-05T16:00:00Z');
const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1'};
test('only a fresh exact six-hour NAM-HI cycle on manual canonical main is admitted',()=>{
  assert.equal(MODEL,'nam-hi');assert.equal(APPROVED_SOURCE,'77487534a6ff0a17bf4e5d55f9ab5c06938138d4');
  assert.equal(validateInit('2026090512',now),'2026090512');gate('2026090512',env,now);
  for(const value of ['2026090518','2026090500','2026090513','2026090506x','$(env)','2026023012','202609051200',null])assert.throws(()=>validateInit(value,now));
  for(const [key,value] of Object.entries({GITHUB_ACTIONS:'false',GITHUB_EVENT_NAME:'push',GITHUB_REPOSITORY:'evil/repo',GITHUB_REF:'refs/heads/other',GITHUB_RUN_ID:'x',GITHUB_RUN_ATTEMPT:'0'}))assert.throws(()=>gate('2026090512',{...env,[key]:value},now));
});
test('fixed scientific invocation and isolated root, no caller supplied script or extra flags',()=>{
  const p=collectorPlan('/tmp/source','/tmp/run/qualification','2026090512');
  assert.equal(p.command,'python3');
  assert.deepEqual(p.args,['/tmp/source/experiments/models/qualify_noaa_regional_horizon.py','--root','/tmp/run/qualification','--model','nam-hi=2026090512','--workers','2']);
  assert.throws(()=>collectorPlan('/tmp/source','/tmp/source/output','2026090512'));
});
test('encrypted bounded stream roundtrips exact exception and authenticates bytes',()=>{
  const c=encryptedTail(keys.publicKey);const secret='ValueError: exact https://private.invalid/?token=SECRET /private/path\n';
  c.add('stderr',Buffer.from(secret));const e=c.finish();
  assert.equal(decrypt(e),secret);assert.ok(!JSON.stringify(e).includes('SECRET'));assert.ok(!JSON.stringify(e).includes('private'));
  const forged=structuredClone(e);forged.keySha256='a'.repeat(64);assert.throws(()=>decrypt(forged));
  const truncated=structuredClone(e);truncated.ciphertext=truncated.ciphertext.slice(4);assert.throws(()=>decrypt(truncated));
});
test('production recipient is exactly the existing public key, never a new private key',()=>{
  const current=readFileSync(new URL('../tools/nam-hi-diagnostic.mjs',import.meta.url),'utf8');
  const existing=readFileSync(new URL('../tools/gdacs-feed-release.mjs',import.meta.url),'utf8');
  const key=s=>s.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----\n/)?.[0];
  assert.equal(key(current),key(existing));
  assert.equal(createHash('sha256').update(key(current)).digest('hex'),'e62e11ec1cc48e65bf2db65f0d4806c94fd02c6828686487ddad8c2ad9a56ead');
  assert.doesNotMatch(current,/BEGIN PRIVATE KEY/);
});
test('tail is bounded separately for both streams and oversized total output fails closed',()=>{
  const c=encryptedTail(keys.publicKey);for(let i=0;i<100;i++)c.add('stdout',Buffer.alloc(4096,65));c.add('stderr',Buffer.from('LAST ERROR'));
  const e=c.finish();assert.ok(decrypt(e).length<=32768);assert.ok(decrypt(e).endsWith('LAST ERROR'));assert.ok(e.droppedBytes>0);assert.ok(JSON.stringify(e).length<70000);
  assert.throws(()=>{const x=encryptedTail(keys.publicKey);x.add('stderr',Buffer.alloc(1024*1024+1));},/output-limit/);
});
test('real child failure never emits raw stderr or arbitrary environment and retains encrypted cause',async()=>{
  const code="process.stderr.write('HTTP Error 403: SECRET https://private.invalid/\\n'+String(process.env.TEST_SECRET));process.exit(1)";
  process.env.TEST_SECRET='NOT_FOR_CHILD';
  const r=await runChild({command:process.execPath,args:['-e',code],cwd:'/tmp'},{publicKey:keys.publicKey,timeoutMs:2000});
  delete process.env.TEST_SECRET;
  assert.equal(r.status,'failed');assert.equal(r.httpStatus,403);assert.equal(r.stage,'source-http');
  assert.ok(decrypt(r.encryptedTail).includes('HTTP Error 403: SECRET'));assert.ok(!decrypt(r.encryptedTail).includes('NOT_FOR_CHILD'));
  const {encryptedTail:_,...publicPart}=r;assert.ok(!JSON.stringify(publicPart).includes('SECRET'));assert.ok(!JSON.stringify(publicPart).includes('private'));
});
test('spawn error, timeout, signal, output limit and success are fixed public outcomes',async()=>{
  const opts={publicKey:keys.publicKey,timeoutMs:2000,killGraceMs:20};
  const missing=await runChild({command:'/definitely/missing',args:[],cwd:'/tmp'},opts);assert.equal(missing.failure,'spawn-error');
  const timeout=await runChild({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:'/tmp'},{...opts,timeoutMs:30});assert.equal(timeout.failure,'timeout');
  const noisy=await runChild({command:process.execPath,args:['-e',"process.stderr.write(Buffer.alloc(2*1024*1024));setInterval(()=>{},1000)"],cwd:'/tmp'},opts);assert.equal(noisy.failure,'output-limit');
  const signaled=await runChild({command:process.execPath,args:['-e',"process.kill(process.pid,'SIGTERM')"],cwd:'/tmp'},opts);assert.equal(signaled.failure,'child-signal');
  const good=await runChild({command:process.execPath,args:['-e',"console.log('private success path')"],cwd:'/tmp'},opts);assert.equal(good.status,'exited-zero');assert.ok(!JSON.stringify({...good,encryptedTail:undefined}).includes('private success'));
});
test('handled controller interruption terminates and reaps the child before returning encrypted evidence',async()=>{
  const url=new URL('../tools/nam-hi-diagnostic.mjs',import.meta.url).href;
  const script=`import {runChild} from ${JSON.stringify(url)};
    const timer=setTimeout(()=>process.kill(process.pid,'SIGTERM'),100);
    const result=await runChild({command:process.execPath,args:['-e',"process.stderr.write('private interrupted');setInterval(()=>{},1000)"],cwd:'/tmp'},{timeoutMs:2000,killGraceMs:20});
    clearTimeout(timer);console.log(JSON.stringify(result));`;
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let out='',err='';
    child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',reject);
    child.on('close',code=>resolve({code,out,err}));
  });
  assert.equal(result.code,0);assert.equal(result.err,'');assert.ok(!result.out.includes('private interrupted'));
  assert.equal(JSON.parse(result.out).failure,'interrupted');assert.ok(JSON.parse(result.out).encryptedTail);
});
test('timeout retains group KILL escalation when the root closes before its TERM-ignoring grandchild',async()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'nam-hi-owned-child-')),pidfile=path.join(dir,'pid');let pid;
  function alive(id){
    try{process.kill(id,0);}catch(error){if(error.code==='ESRCH')return false;throw error;}
    // A terminated non-child can briefly remain an init-owned zombie on Linux.
    if(process.platform==='linux'){
      try{if(/\) Z /.test(readFileSync(`/proc/${id}/stat`,'utf8')))return false;}
      catch(error){if(error.code==='ENOENT')return false;throw error;}
    }
    return true;
  }
  const grandchild=`process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000)`;
  const root=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  try{
    const start=Date.now();const result=await runChild({command:process.execPath,args:['-e',root],cwd:dir},{publicKey:keys.publicKey,timeoutMs:1000,killGraceMs:80});
    assert.equal(result.failure,'timeout');assert.ok(existsSync(pidfile),'owned grandchild must start to exercise early-root-close regression');
    pid=Number(readFileSync(pidfile,'utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>1);
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(alive(pid),false,'same-group grandchild must not survive the diagnostic');
    assert.ok(result.wallSeconds>=1.07&&Date.now()-start>=1080,'result must wait for group escalation, not merely root close');
  }finally{
    if(pid===undefined&&existsSync(pidfile))pid=Number(readFileSync(pidfile,'utf8'));
    if(Number.isSafeInteger(pid)&&pid>1&&alive(pid)){try{process.kill(pid,'SIGKILL');}catch{}}
    rmSync(dir,{recursive:true,force:true});
  }
});
test('exit zero alone cannot claim qualification, release or publication',()=>{
  const proof={modelId:'nam-hi',initTime:'2026-09-05T12:00:00Z',completeInputs:true,validatedLeadCount:49,qualifiedHorizonHours:48,publishable:false,fusionEligible:false,weatherxFusionIssued:false,frames:Array.from({length:49},(_,i)=>({i,leadHour:i}))};
  const summary=qualificationSummary(proof,'2026090512');assert.equal(summary.qualifiedLeads,49);assert.equal(summary.publishable,false);
  for(const patch of [{modelId:'nam'},{validatedLeadCount:48},{publishable:true},{frames:[]},{initTime:'2026-09-05T06:00:00Z'}])assert.throws(()=>qualificationSummary({...proof,...patch},'2026090512'));
});
test('manual workflow has no production authority and retains only the encrypted receipt',()=>{
  const w=readFileSync(new URL('../.github/workflows/nam-hi-diagnostic.yml',import.meta.url),'utf8');
  assert.match(w,/workflow_dispatch:/);assert.doesNotMatch(w,/schedule:|push:|pull_request:|workflow_run:|continue-on-error:/);
  assert.match(w,/^    environment: staging$/m);assert.doesNotMatch(w,/environment: production/);
  assert.deepEqual([...w.matchAll(/secrets\.([A-Z_]+)/g)].map(x=>x[1]),['ATMOS_DEPLOY_KEY']);
  assert.match(w,/persist-credentials: false/);assert.match(w,/permissions:\s*\n  contents: read/);
  assert.match(w,new RegExp(`ref: ${APPROVED_SOURCE}`));
  assert.match(w,/path: \$\{\{ runner.temp \}\}\/nam-hi-diagnostic-receipt\/receipt.json/);
  assert.doesNotMatch(w,/wrangler|R2_|CLOUDFLARE|PAGES_|PROMOTION|gh workflow|upload-cloud|catalog-promote/);
  assert.match(w,/timeout-minutes: 30/);assert.match(w,/node --test cycle\/tests\/nam-hi-diagnostic.mjs/);
  const ci=readFileSync(new URL('../.github/workflows/scheduler-ci.yml',import.meta.url),'utf8');assert.match(ci,/node --test tests\/nam-hi-diagnostic.mjs/);
});
