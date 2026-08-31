// Manual, cloud-only experimental collection archive. No serving pointer, catalog,
// component promotion, production bucket, Pages token or Worker deployment exists here.
import assert from 'node:assert/strict';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, parse } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ACCOUNT='a89f9a1af485021fbc60a68b163c7c6e';
export const MODELS=['icon','hrrr-ak','hrdps','nam','nam-hi','nam-ak','arome-antilles'];
const BUCKET='weatherx-data-staging', MAX_BYTES=30*1024**3, MAX_FILE=512*1024**2, MAX_FILES=100_000;
const RECEIPT='cloud-input-receipt.json', MAX_RECEIPT=32*1024**2;
const SHA=/^[a-f0-9]{64}$/, COMMIT=/^[a-f0-9]{40}$/, MAGIC=Buffer.from('WXMI1');
export const hash=value=>createHash('sha256').update(value).digest('hex');
const encoded=value=>Buffer.from(JSON.stringify(value)+'\n');
function safePath(value){
  assert.ok(typeof value==='string' && value.length<=1024 && /^[A-Za-z0-9_./@+:-]+$/.test(value),'invalid input path');
  assert.ok(value.split('/').every(p=>p && p!=='.' && p!=='..' && !p.startsWith('.')),'hidden or traversing input path');
  return value;
}
function cycleTime(init,now){
  assert.match(init??'',/^\d{8}(00|06|12|18)$/,'explicit six-hour source cycle required');
  const iso=`${init.slice(0,4)}-${init.slice(4,6)}-${init.slice(6,8)}T${init.slice(8)}:00:00.000Z`, time=Date.parse(iso);
  assert.ok(Number.isFinite(time) && new Date(time).toISOString()===iso,'invalid source cycle');
  assert.ok(now>=time && now-time<=12*3600_000,'source cycle is stale or future');
  return time;
}
export function gate(env,now=Date.now()){
  for(const [k,v] of Object.entries({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',
    GITHUB_JOB:'collect',GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/model-inputs.yml@refs/heads/main',
    GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',STAGING_DATA_ISOLATION_APPROVED:'true',
    STAGING_MODEL_COLLECTION_ENABLED:'true',STAGING_R2_ACCOUNT_ID:ACCOUNT}))assert.equal(env[k],v,k);
  assert.match(env.MODEL_SOURCE_SHA??'',COMMIT);assert.equal(env.MODEL_SOURCE_SHA,env.STAGING_MODEL_APPROVED_SOURCE_SHA,'unapproved collector');
  assert.ok(MODELS.includes(env.MODEL_ID),'unqualified model');cycleTime(env.MODEL_INIT,now);
  assert.match(env.GITHUB_RUN_ID??'',/^[1-9]\d{0,19}$/);assert.match(env.GITHUB_RUN_ATTEMPT??'',/^[1-9]\d{0,3}$/);
  return {sourceSha:env.MODEL_SOURCE_SHA,model:env.MODEL_ID,init:env.MODEL_INIT,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT};
}
function prefix(pin){
  assert.match(pin.sourceSha??'',COMMIT);assert.ok(MODELS.includes(pin.model));assert.match(pin.init??'',/^\d{10}$/);
  assert.match(pin.runId??'',/^[1-9]\d{0,19}$/);assert.match(pin.attempt??'',/^[1-9]\d{0,3}$/);
  return `staging-candidates/model-inputs/${pin.sourceSha}/${pin.model}/${pin.init}/${pin.runId}-${pin.attempt}/`;
}
export const objectKey=(pin,path)=>prefix(pin)+'objects/'+hash(safePath(path))+'.wxmi';
function keyBytes(key){assert.match(key??'',SHA,'32-byte archive encryption key required');return Buffer.from(key,'hex');}
export function seal(body,key,remoteKey,sha){
  assert.match(sha,SHA);assert.equal(hash(body),sha);
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',keyBytes(key),iv);
  cipher.setAAD(Buffer.from(remoteKey+'\0'+sha));
  const ciphertext=Buffer.concat([cipher.update(body),cipher.final()]);
  return Buffer.concat([MAGIC,iv,cipher.getAuthTag(),ciphertext]);
}
export function unseal(body,key,remoteKey,sha){
  assert.match(sha,SHA);assert.ok(body.length>=33 && body.subarray(0,5).equals(MAGIC),'invalid encrypted input');
  const decipher=createDecipheriv('aes-256-gcm',keyBytes(key),body.subarray(5,17));
  decipher.setAAD(Buffer.from(remoteKey+'\0'+sha));decipher.setAuthTag(body.subarray(17,33));
  const plain=Buffer.concat([decipher.update(body.subarray(33)),decipher.final()]);assert.equal(hash(plain),sha,'archive hash mismatch');return plain;
}
export function validateReceipt(r,pin,now=Date.now()){
  assert.equal(r.schemaVersion,1);assert.equal(r.kind,'weatherx-cloud-model-inputs');
  assert.equal(r.status,'COLLECTED');assert.equal(r.qualification,'unqualified');
  assert.deepEqual(r.cloud,{runId:pin.runId,runAttempt:pin.attempt,runnerEnvironment:'github-hosted'},'different collection invocation');
  assert.equal(r.leadCount,49);assert.equal(r.horizonHours,48);
  for(const k of ['sourceSha','model','init'])assert.equal(r[k],pin[k],`receipt ${k} mismatch`);
  assert.equal(r.complete,true);
  for(const k of ['publishable','renderReady','fusionEligible','weatherxFusionIssued'])assert.equal(r[k],false,`unqualified hold ${k}`);
  const started=cycleTime(r.init,now), created=Date.parse(r.createdAt);
  assert.ok(typeof r.createdAt==='string' && Number.isFinite(created) && created>=started && created<=now,'invalid collection time');
  assert.ok(Array.isArray(r.inventory) && r.inventory.length>0 && r.inventory.length<=MAX_FILES);
  const seen=new Set();let total=0,previous='';
  for(const o of r.inventory){
    safePath(o.path);assert.ok(o.path>previous && o.path!==RECEIPT,'unsorted/duplicate/reserved inventory');previous=o.path;
    assert.ok(Number.isSafeInteger(o.bytes) && o.bytes>=0 && o.bytes<=MAX_FILE);assert.match(o.sha256??'',SHA);
    total+=o.bytes;assert.ok(total<=MAX_BYTES,'archive budget exceeded');seen.add(o.path);
  }
  for(const p of seen){let parent=dirname(p);while(parent!=='.'){assert.ok(!seen.has(parent),'file/directory collision');parent=dirname(parent);}}
  assert.equal(r.totalBytes,total);safePath(r.sourceReceipt);assert.ok(seen.has(r.sourceReceipt),'source receipt missing');
  assert.match(r.sourceReceiptSha256??'',SHA);
  assert.equal(r.inventory.find(o=>o.path===r.sourceReceipt).sha256,r.sourceReceiptSha256,'source receipt is not bound to inventory');
  safePath(r.stagedRoot);assert.ok(seen.has(r.stagedRoot+'/index.json'),'staged model index missing');
  return r;
}
function realDirectory(root){
  assert.equal(resolve(root),root,'absolute output path required');
  for(let at=root;;at=dirname(at)){const s=lstatSync(at);assert.ok(s.isDirectory()&&!s.isSymbolicLink(),'symlink output ancestry');if(at===parse(at).root)break;}
  assert.equal(realpathSync(root),root,'noncanonical output directory');
}
async function localInventory(root){
  realDirectory(root);const found=[];let total=0;
  async function visit(at){for(const name of readdirSync(at).sort()){
    const file=resolve(at,name),path=file.slice(root.length+1),stat=lstatSync(file);safePath(path);
    assert.ok(!stat.isSymbolicLink(),'symlink input');
    if(stat.isDirectory()){await visit(file);continue;}
    assert.ok(stat.isFile() && stat.nlink===1,'nonregular or hard-linked input');
    if(path===RECEIPT){assert.ok(stat.size<=MAX_RECEIPT);continue;}
    assert.ok(stat.size<=MAX_FILE);total+=stat.size;assert.ok(total<=MAX_BYTES);
    const digest=createHash('sha256');let bytes=0;for await(const c of createReadStream(file)){bytes+=c.length;assert.ok(bytes<=MAX_FILE);digest.update(c);}
    assert.equal(bytes,stat.size,'source size changed');found.push({path,bytes,sha256:digest.digest('hex')});assert.ok(found.length<=MAX_FILES);
  }}
  await visit(root);return found.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
async function pool(items,fn){let next=0,failure;await Promise.all(Array.from({length:Math.min(2,items.length)},async()=>{
  while(!failure && next<items.length){const item=items[next++];try{await fn(item);}catch(error){failure??=error;}}
}));if(failure)throw failure;}

export async function archiveInputs({root,pin,key,io,now=Date.now,log=()=>{}}){
  keyBytes(key);realDirectory(root);
  const receiptPath=resolve(root,RECEIPT), receiptStat=lstatSync(receiptPath);
  assert.ok(receiptStat.isFile()&&!receiptStat.isSymbolicLink()&&receiptStat.nlink===1&&receiptStat.size<=MAX_RECEIPT);
  const raw=readFileSync(receiptPath), receipt=validateReceipt(JSON.parse(raw),pin,now()), base=prefix(pin);
  assert.deepEqual(await localInventory(root),receipt.inventory,'source inventory mismatch before archive');
  validateReceipt(receipt,pin,now());log({phase:'inputs-validated',model:pin.model,objects:receipt.inventory.length,bytes:receipt.totalBytes});
  const expected=receipt.inventory.map(o=>objectKey(pin,o.path));
  expected.push(base+'receipt.wxmi',base+'complete.json');
  const existing=await io.list(base);assert.ok(existing.every(k=>expected.includes(k)),'unlisted remote input object');
  async function retain(remote,body,sha){
    let stored=await io.get(remote);
    if(stored===null){await io.put(remote,seal(body,key,remote,sha));stored=await io.get(remote);}
    assert.ok(stored);assert.deepEqual(unseal(stored,key,remote,sha),body,'remote decrypted bytes mismatch');return hash(stored);
  }
  await pool(receipt.inventory,async o=>{
    const file=resolve(root,o.path),stat=lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size===o.bytes);
    const body=readFileSync(file);assert.equal(hash(body),o.sha256,'source changed before transfer');
    await retain(objectKey(pin,o.path),body,o.sha256);
  });
  // Re-read every original byte after transfer; no completed archive for a changing collection.
  assert.deepEqual(await localInventory(root),receipt.inventory,'source changed during transfer');assert.deepEqual(readFileSync(receiptPath),raw);
  validateReceipt(receipt,pin,now());
  const receiptCipherSha256=await retain(base+'receipt.wxmi',raw,hash(raw));
  const remote=await io.list(base), required=expected.filter(k=>!k.endsWith('/complete.json'));
  assert.deepEqual(remote.filter(k=>!k.endsWith('/complete.json')).sort(),required.sort(),'incomplete remote inventory');
  validateReceipt(receipt,pin,now());
  // This minimal record contains no input paths, values, provider URLs or private proof data.
  const completion={schemaVersion:1,kind:'weatherx-private-cloud-input-archive',...pin,objects:receipt.inventory.length,bytes:receipt.totalBytes,
    receiptSha256:hash(raw),receiptCipherSha256,archiveKeyId:hash(keyBytes(key)).slice(0,16),encrypted:true,activated:false,productionWritten:false,
    publishable:false,renderReady:false,fusionEligible:false,weatherxFusionIssued:false};
  const bytes=encoded(completion), previous=await io.get(base+'complete.json');
  if(previous===null)await io.put(base+'complete.json',bytes);else assert.deepEqual(previous,bytes,'existing completion differs');
  assert.deepEqual(await io.get(base+'complete.json'),bytes,'completion readback failed');
  log({phase:'encrypted-archive-complete',model:pin.model,objects:completion.objects,bytes:completion.bytes});return completion;
}

export async function createArchiveS3(env,pin,injectedClient){
  const {S3Client,GetObjectCommand,PutObjectCommand,ListObjectsV2Command}=await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
  assert.equal(env.STAGING_R2_ACCOUNT_ID,ACCOUNT);assert.ok(env.STAGING_R2_WRITE_ACCESS_KEY_ID&&env.STAGING_R2_WRITE_SECRET_ACCESS_KEY);
  const client=injectedClient??new S3Client({region:'auto',endpoint:`https://${ACCOUNT}.r2.cloudflarestorage.com`,forcePathStyle:true,maxAttempts:1,
    requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',
    credentials:{accessKeyId:env.STAGING_R2_WRITE_ACCESS_KEY_ID,secretAccessKey:env.STAGING_R2_WRITE_SECRET_ACCESS_KEY}});
  const base=prefix(pin);
  function target(k){assert.ok(k.startsWith(base));assert.match(k.slice(base.length),/^(objects\/[a-f0-9]{64}\.wxmi|receipt\.wxmi|complete\.json)$/);return {Bucket:BUCKET,Key:k};}
  async function send(command,missing=false){try{return await client.send(command,{abortSignal:AbortSignal.timeout(120_000)});}catch(e){
    if(missing&&e?.$metadata?.httpStatusCode===404)return null;throw Error(e?.$metadata?.httpStatusCode===412?'immutable archive collision':'staging archive S3 operation failed');}}
  return {close:()=>client.destroy?.(),async get(k){
    const o=await send(new GetObjectCommand(target(k)),true);if(o===null)return null;
    try{assert.ok(Number.isSafeInteger(o.ContentLength)&&o.ContentLength<=MAX_FILE+33);const chunks=[];let count=0;
      for await(const c of o.Body){count+=c.length;assert.ok(count<=MAX_FILE+33);chunks.push(Buffer.from(c));}
      assert.equal(count,o.ContentLength);return Buffer.concat(chunks);
    }finally{o.Body?.destroy?.();}
  },async put(k,body){assert.ok(Buffer.isBuffer(body)&&body.length<=MAX_FILE+33);
    await send(new PutObjectCommand({...target(k),Body:body,ContentLength:body.length,IfNoneMatch:'*',ContentType:'application/octet-stream',CacheControl:'private, no-store'}));
  },async list(requested){assert.equal(requested,base);const keys=[],tokens=new Set();let token;
    do{const p=await send(new ListObjectsV2Command({Bucket:BUCKET,Prefix:base,MaxKeys:1000,ContinuationToken:token}));
      for(const o of p.Contents??[]){target(o.Key);assert.ok(Number.isSafeInteger(o.Size)&&o.Size<=MAX_FILE+33);keys.push(o.Key);assert.ok(keys.length<=MAX_FILES+2);}
      token=p.IsTruncated?p.NextContinuationToken:undefined;if(p.IsTruncated){assert.ok(typeof token==='string'&&token&&!tokens.has(token));tokens.add(token);}
    }while(token);assert.equal(new Set(keys).size,keys.length);return keys.sort();
  }};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const pin=gate(process.env);if(process.argv[2]==='gate')console.log(JSON.stringify(pin));
    else if(process.argv[2]==='archive'){
      const root=resolve(process.env.RUNNER_TEMP,'weatherx-model-inputs',pin.model);
      const io=await createArchiveS3(process.env,pin);try{console.log(JSON.stringify(await archiveInputs({root,pin,key:process.env.MODEL_INPUT_ARCHIVE_KEY,io,log:x=>console.log(JSON.stringify(x))})));}finally{io.close();}
    }else throw Error('unsupported command');
  }catch{console.error('Model input gate/archive failed; no serving activation is performed.');process.exitCode=1;}
}
