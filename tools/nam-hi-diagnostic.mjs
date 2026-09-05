// Diagnostic only. No serving, archive, credentials, retry or publication APIs.
import {spawn,execFileSync} from 'node:child_process';
import {createHash,randomBytes,createCipheriv,publicEncrypt} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,realpathSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const APPROVED_SOURCE='77487534a6ff0a17bf4e5d55f9ab5c06938138d4';
export const MODEL='nam-hi';
// Same existing owner-local recipient as the reviewed reader diagnostic. No private key here.
const PUBLIC_KEY=`-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA0YX3Ub8kc1eLvLBM9iy0
g+8kplyZtW6AyJFn89IdOHAkfp7zFU9l1rEJF1bb/fyFjFWFrjAVjQyP07heG9cc
tLANJU3ffZ9b8nVDTeAAmacViuEniltH7CLCaYIcuwuRfIvlmfVlH6wan+ec3lBI
lNDSgAUlBIr7OaUfr8+II3GctnlWBzi/GlASicL3+0FCeuzUoGWg34wBLb4G39/l
yTP4nmgbNMIJlG9buYDF/mqVmwq/KDje15hsCfUQL0+RQLiEQBbus+R002BEHZAq
ndzFglsvZny+oeZfLKXKVACoybL+YFBRZTJGknLSg/Twg9s2XBTgtluiW25pFC9F
Atr6X7fkSWArkHv4wHPptugtqfk6ZsPvRx96l+vpFrDg4G9Pij2RcGtuRoXnDN/c
J0XifLdu+BHJn0fyqBNPRQLjQaYTCDBdn3B/QPb8Cz+2dJbCVJISRCRQJoE36LDd
msYTudGT2UyaOQY6+dDztttvmxVHK3brf7zeh3h77+MLAgMBAAE=
-----END PUBLIC KEY-----
`;
const sha=b=>createHash('sha256').update(b).digest('hex');
function require(value,code){if(!value)throw new Error(code);}
export function validateInit(init,now=new Date()){
  require(typeof init==='string'&&/^\d{10}$/.test(init),'invalid-init');
  const iso=`${init.slice(0,4)}-${init.slice(4,6)}-${init.slice(6,8)}T${init.slice(8)}:00:00Z`;
  const date=new Date(iso);
  require(Number.isFinite(date.getTime())&&date.toISOString().replace(/[-:TZ.]/g,'').slice(0,10)===init&&date.getUTCHours()%6===0,'invalid-init');
  require(now-date>=0&&now-date<=12*3600_000,'stale-or-future-init');
  return init;
}
export function gate(init,env=process.env,now=new Date()){
  require(env.GITHUB_ACTIONS==='true'&&env.GITHUB_EVENT_NAME==='workflow_dispatch'&&env.GITHUB_REPOSITORY==='Andrewegao/v3t7kq-cycle'&&env.GITHUB_REF==='refs/heads/main','cloud-manual-main-required');
  require(/^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID??'')&&/^[1-9]\d{0,3}$/.test(env.GITHUB_RUN_ATTEMPT??''),'invalid-run-identity');
  return validateInit(init,now);
}
export function collectorPlan(repo,root,init){
  repo=path.resolve(repo);root=path.resolve(root);
  require(root!==repo&&!root.startsWith(repo+path.sep),'root-inside-source');
  require(/^\d{10}$/.test(init),'invalid-init');
  return {command:'python3',args:[path.join(repo,'experiments/models/qualify_noaa_regional_horizon.py'),'--root',root,'--model',`${MODEL}=${init}`,'--workers','2'],cwd:repo};
}
export function encryptedTail(publicKey=PUBLIC_KEY){
  const tails={stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};let total=0,finished=false;
  return {
    add(stream,data){
      require(!finished&&Object.hasOwn(tails,stream),'invalid-capture-state');total+=data.length;
      const old=tails[stream];const next=Buffer.concat([old,data.subarray(-16384)]).subarray(-16384);
      tails[stream]=Buffer.from(next);old.fill(0);
      require(total<=1024*1024,'output-limit');
    },
    classify(){
      const text=tails.stderr.toString();
      const status=text.match(/HTTP Error (400|401|403|404|408|416|429|500|502|503|504)\b/)?.[1];
      const stage=status?'source-http':/timed out|TimeoutError/.test(text)?'source-timeout':/server did not honor bounded range|wrong returned byte range|truncated\/oversized source payload/.test(text)?'source-range':/metadata mismatch|unexpected .* metadata/.test(text)?'metadata-validation':/projection|convergence|axis_error/.test(text)?'grid-validation':/ModuleNotFoundError|ImportError/.test(text)?'runtime-import':'qualifier';
      return {stage,...(status?{httpStatus:Number(status)}:{})};
    },
    finish(){
      require(!finished,'capture-already-finished');finished=true;
      const plaintext=Buffer.from(JSON.stringify({version:1,stdout:tails.stdout.toString('base64'),stderr:tails.stderr.toString('base64')}));
      const key=randomBytes(32),iv=randomBytes(12),keySha256=sha(publicKey);
      try{
        const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(`weatherx-nam-hi-diagnostic/v1:${keySha256}`));
        const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
        return {version:1,algorithm:'RSA-OAEP-SHA256+A256GCM',keySha256,wrappedKey:publicEncrypt({key:publicKey,oaepHash:'sha256'},key).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64'),observedBytes:total,droppedBytes:Math.max(0,total-tails.stdout.length-tails.stderr.length)};
      }finally{key.fill(0);plaintext.fill(0);tails.stdout.fill(0);tails.stderr.fill(0);}
    }
  };
}
export async function runChild(plan,{publicKey=PUBLIC_KEY,timeoutMs=21*60_000,killGraceMs=3000}={}){
  const capture=encryptedTail(publicKey),start=Date.now();let failure,child,timer,killTimer,closed,escalated=false,settled=false;
  // Do not forward Actions tokens, checkout credentials, proxies or arbitrary user environment.
  const childEnv={PATH:process.env.PATH,LANG:'C.UTF-8',PYTHONUNBUFFERED:'1',PYTHONDONTWRITEBYTECODE:'1'};
  for(const key of ['LD_LIBRARY_PATH','DYLD_LIBRARY_PATH'])if(process.env[key])childEnv[key]=process.env[key];
  return await new Promise(resolve=>{
    function stop(code){
      if(settled)return;
      failure??=code;
      if(child?.pid&&!killTimer){
        try{process.kill(-child.pid,'SIGTERM');}catch{}
        killTimer=setTimeout(()=>{
          try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')failure='termination-failed';}
          escalated=true;settle();
        },killGraceMs);
      }
    }
    function finish(code,signal){
      closed={code,signal};clearTimeout(timer);settle();
    }
    function settle(){
      // The root can close while a same-group descendant ignores TERM and owns
      // no stdio pipe. Do not cancel that descendant's pending KILL escalation.
      if(settled||!closed||(killTimer&&!escalated))return;
      settled=true;clearTimeout(timer);clearTimeout(killTimer);
      const {code,signal}=closed;
      process.removeListener('SIGTERM',terminate);process.removeListener('SIGINT',terminate);
      resolve({status:!failure&&code===0?'exited-zero':'failed',failure:failure??(code===0?null:signal?'child-signal':'child-exit'),exitCode:Number.isInteger(code)?code:null,...capture.classify(),wallSeconds:Math.round((Date.now()-start)/100)/10,encryptedTail:capture.finish()});
    }
    function terminate(){stop('interrupted');}
    process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
    try{child=spawn(plan.command,plan.args,{cwd:plan.cwd,env:childEnv,detached:true,stdio:['ignore','pipe','pipe']});}
    catch{failure='spawn-error';finish(null,null);return;}
    child.on('error',()=>{failure='spawn-error';});
    child.stdout.on('data',data=>{try{capture.add('stdout',data);}catch{stop('output-limit');}});
    child.stderr.on('data',data=>{try{capture.add('stderr',data);}catch{stop('output-limit');}});
    child.on('close',finish);timer=setTimeout(()=>stop('timeout'),timeoutMs);
  });
}
export function qualificationSummary(value,init){
  const expected=`${init.slice(0,4)}-${init.slice(4,6)}-${init.slice(6,8)}T${init.slice(8)}:00:00Z`;
  require(value?.modelId===MODEL&&value.initTime===expected&&value.completeInputs===true&&value.validatedLeadCount===49&&value.qualifiedHorizonHours===48&&value.publishable===false&&value.fusionEligible===false&&value.weatherxFusionIssued===false,'qualification-proof-invalid');
  require(Array.isArray(value.frames)&&value.frames.length===49&&value.frames.every((frame,i)=>frame.i===i&&frame.leadHour===i),'qualification-proof-invalid');
  return {qualifiedLeads:49,horizonHours:48,publishable:false,release:false};
}
function verifySource(repo){
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']}).trim();
  require(git('rev-parse','HEAD')===APPROVED_SOURCE,'wrong-source');
  require(git('status','--porcelain','--untracked-files=all')==='','dirty-source');
  git('merge-base','--is-ancestor',APPROVED_SOURCE,'refs/remotes/origin/master');
}
async function main(){
  const [mode,init,source]=process.argv.slice(2);gate(init);
  require(mode==='gate'||mode==='run','invalid-mode');
  if(mode==='gate'){console.log(JSON.stringify({status:'admitted',model:MODEL,init,sourceSha:APPROVED_SOURCE,publishable:false}));return;}
  require(source&&process.env.RUNNER_TEMP,'missing-path');
  const repo=realpathSync(source),temp=realpathSync(process.env.RUNNER_TEMP);verifySource(repo);
  const receiptDir=path.join(temp,'nam-hi-diagnostic-receipt');
  mkdirSync(receiptDir,{mode:0o700});
  const root=mkdtempSync(path.join(temp,'nam-hi-qualification-'));
  const result=await runChild(collectorPlan(repo,root,init));
  if(result.status==='exited-zero'){
    try{
      const file=path.join(root,'qualifications',MODEL,`${init}.json`),stat=lstatSync(file);require(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=256*1024,'qualification-proof-invalid');
      const bytes=readFileSync(file);result.qualification=qualificationSummary(JSON.parse(bytes),init);result.qualificationSha256=sha(bytes);result.status='qualified-only';
    }catch{result.status='failed';result.failure='qualification-proof-invalid';}
  }
  const receipt={schemaVersion:1,kind:'weatherx-nam-hi-cloud-diagnostic',model:MODEL,init,sourceSha:APPROVED_SOURCE,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,publishable:false,release:false,...result};
  const encoded=JSON.stringify(receipt);require(Buffer.byteLength(encoded)<=80*1024,'receipt-limit');
  writeFileSync(path.join(receiptDir,'receipt.json'),encoded,{flag:'wx',mode:0o600});
  const {encryptedTail:_,...publicReceipt}=receipt;console.log(JSON.stringify(publicReceipt));
  if(receipt.status!=='qualified-only')process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('{"status":"refused","stage":"controller-preflight"}');process.exitCode=1;});
