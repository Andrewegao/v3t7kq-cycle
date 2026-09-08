import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,existsSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,privateDecrypt,createDecipheriv} from 'node:crypto';
import {projectLine, PublicLineProjector, scanFile, retainLatest} from '../tools/bake-public-diagnostic.mjs';

const keys=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
function decrypt(envelope){
  const key=privateDecrypt({key:keys.privateKey,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64'));
  try{const d=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));d.setAAD(Buffer.from('weatherx-nam-hi-diagnostic/v1:'+envelope.keySha256));d.setAuthTag(Buffer.from(envelope.tag,'base64'));return JSON.parse(Buffer.concat([d.update(Buffer.from(envelope.ciphertext,'base64')),d.final()]));}finally{key.fill(0);}
}

test('projects only canonical allowlisted progress fields',()=>{
  const sha='a'.repeat(40);const cases=new Map([
    ['[2026-09-05T07:00:00Z] bake-stage name=native-ecmwf event=start','[2026-09-05T07:00:00Z] bake-stage name=native-ecmwf event=start'],
    ['[2026-09-05T07:00:01+00:00] bake-stage name=native-ecmwf event=end status=1 elapsed_seconds=120','[2026-09-05T07:00:01+00:00] bake-stage name=native-ecmwf event=end status=1 elapsed_seconds=120'],
    ['point-series worker model=nam-ak status=start-failed seconds=1.253','point-series worker model=nam-ak status=start-failed seconds=1.253'],
    [`{"requiresEnrichment":true,"sourceSha":"${sha}","runId":"123","models":["ecmwf","gfs","hrrr","aifs"],"status":"installed-unqualified-inputs"}`,`{"status":"installed-unqualified-inputs","models":["ecmwf","gfs","hrrr","aifs"],"runId":"123","sourceSha":"${sha}","requiresEnrichment":true}`],
    ['promoted cycle-123','promoted cycle-123'],['[2026-09-05T07:05:00Z] === cycle complete ===','[2026-09-05T07:05:00Z] === cycle complete ==='],
    ['model-input resource icon peak-rss-kib=2345 elapsed-seconds=67.8','model-input resource icon peak-rss-kib=2345 elapsed-seconds=67.8'],
    ['[2026-09-05T07:01:00Z] model-input start gfs','[2026-09-05T07:01:00Z] model-input start gfs'],
    ['[2026-09-05T07:02:00Z] model-input end gfs exit=-9','[2026-09-05T07:02:00Z] model-input end gfs exit=-9'],
    ['[2026-09-05T07:03:00Z] regional-model install nam-hi status=absent init=- reason=provider refused /private/path','[2026-09-05T07:03:00Z] regional-model install nam-hi status=absent init=-'],
  ]);for(const [line,expected] of cases)assert.equal(projectLine(line),expected,line);
});

test('rejects freeform, malformed, control-bearing and oversized public lines',()=>{
  const secret='SYNTHETIC_PRIVATE_SOURCE_SENTINEL';for(const line of [`checkpoint: ${secret}`,`WEATHER LAB GATE FAILED ${secret}`,
    `[2026-09-05T07:00:00Z] bake-stage name=native-gfs event=end status=0 elapsed_seconds=5 PRIVATE=${secret}`,
    `[2026-09-05T07:00:00Z] bake-stage name=${secret} event=start`,
    '[2026-99-99T99:99:99Z] bake-stage name=native-gfs event=start','[2026-09-05T07:00:00Z] regional-model install nam-hi status=absent init=- trailing=field',
    'promoted cycle-0',`point-series worker model=gfs status=0 seconds=1\u001b[31m${secret}`,'x'.repeat(4097)])assert.equal(projectLine(line),null,line);
});

test('stream projection bounds partial and oversized records without leaking suffixes',()=>{
  const output=[];const p=new PublicLineProjector(line=>output.push(line),{maxLineBytes:128,maxRecords:3});
  p.add(Buffer.from('private '+('x'.repeat(400))+'\n[2026-09-05T07:00:00Z] model-input start '));p.add(Buffer.from('ecmwf\ncheckpoint: secret\npromoted cycle-12\n[2026-09-05T07:05:00Z] === cycle complete ===\n'));p.finish();
  assert.deepEqual(output,['[2026-09-05T07:00:00Z] model-input start ecmwf','promoted cycle-12','[2026-09-05T07:05:00Z] === cycle complete ===']);
});

test('missing log is quiet and successful; scan emits only projected records',async()=>{
  const root=mkdtempSync(join(tmpdir(),'wx-bake-scan-'));const output=[];try{assert.equal(await scanFile(join(root,'missing'),line=>output.push(line)),false);writeFileSync(join(root,'log'),'checkpoint: secret\npromoted cycle-88\nprivate suffix\n');assert.equal(await scanFile(join(root,'log'),line=>output.push(line)),true);assert.deepEqual(output,['promoted cycle-88']);}finally{rmSync(root,{recursive:true,force:true});}
});

test('failed-cycle details retain only an encrypted bounded latest-file tail',()=>{
  const root=mkdtempSync(join(tmpdir(),'wx-bake-retain-')),runner=join(root,'runner');mkdirSync(join(root,'ops/logs'),{recursive:true});mkdirSync(runner);const secret='SYNTHETIC_PRIVATE_SOURCE_SENTINEL';
  const raw='x'.repeat(30000)+secret;writeFileSync(join(root,'ops/logs/bake-20260905.log'),raw);
  try{assert.equal(retainLatest({cwd:root,runnerTemp:runner,runId:'123',sourceSha:'b'.repeat(40),publicKey:keys.publicKey}),true);const serialized=readFileSync(join(runner,'weatherx-bake-diagnostic/receipt.json'),'utf8');assert.ok(!serialized.includes(secret));assert.ok(serialized.length<50000);const receipt=JSON.parse(serialized);assert.equal(receipt.publishable,false);assert.equal(receipt.logBytes,raw.length);assert.equal(receipt.capturedBytes,16384);const clear=decrypt(receipt.encryptedTail);assert.equal(Buffer.from(clear.stderr,'base64').toString(),raw.slice(-16384));assert.throws(()=>retainLatest({cwd:root,runnerTemp:runner,runId:'0',sourceSha:'b'.repeat(40),publicKey:keys.publicKey}));}finally{rmSync(root,{recursive:true,force:true});}
});

test('missing logs and encryption failure produce no plaintext fallback artifact',()=>{
  const root=mkdtempSync(join(tmpdir(),'wx-bake-retain-failure-')),runner=join(root,'runner');mkdirSync(runner);
  try{assert.equal(retainLatest({cwd:root,runnerTemp:runner,runId:'123',sourceSha:'b'.repeat(40),publicKey:keys.publicKey}),false);mkdirSync(join(root,'ops/logs'),{recursive:true});writeFileSync(join(root,'ops/logs/bake-failure.log'),'SYNTHETIC_PRIVATE_SOURCE_SENTINEL');assert.throws(()=>retainLatest({cwd:root,runnerTemp:runner,runId:'123',sourceSha:'b'.repeat(40),publicKey:'invalid'}));assert.equal(existsSync(join(runner,'weatherx-bake-diagnostic/receipt.json')),false);}finally{rmSync(root,{recursive:true,force:true});}
});

test('a linked log directory is refused before public scan or private retention',()=>{
  const root=mkdtempSync(join(tmpdir(),'wx-bake-linked-log-')),outside=mkdtempSync(join(tmpdir(),'wx-bake-outside-')),runner=join(root,'runner');mkdirSync(join(root,'ops'));mkdirSync(runner);writeFileSync(join(outside,'bake-secret.log'),'SYNTHETIC_PRIVATE_SOURCE_SENTINEL');symlinkSync(outside,join(root,'ops/logs'));
  try{assert.throws(()=>retainLatest({cwd:root,runnerTemp:runner,runId:'123',sourceSha:'b'.repeat(40),publicKey:keys.publicKey}));assert.equal(existsSync(join(runner,'weatherx-bake-diagnostic/receipt.json')),false);}finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
});
