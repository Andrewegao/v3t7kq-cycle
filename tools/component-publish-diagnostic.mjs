// Retain only an encrypted bounded tail for the existing owner-private recipient.
import assert from 'node:assert/strict';
import {existsSync,lstatSync,openSync,readSync,closeSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {encryptedTail} from './nam-hi-diagnostic.mjs';
const models=new Set(['ecmwf','gfs','hrrr','aifs','icon','hrdps','arome-antilles','hrrr-ak','nam','nam-hi','nam-ak']);
export function retain(input,output,{model,runId,sourceSha},publicKey){
  assert.ok(models.has(model));assert.match(runId,/^[1-9][0-9]*$/);assert.match(sourceSha,/^[a-f0-9]{40}$/);
  if(!existsSync(input))return false;
  const info=lstatSync(input);assert.ok(info.isFile()&&!info.isSymbolicLink());
  const buffer=Buffer.alloc(Math.min(info.size,16384)),fd=openSync(input,'r');let count;
  try{count=readSync(fd,buffer,0,buffer.length,Math.max(0,info.size-buffer.length));}finally{closeSync(fd);}
  const capture=encryptedTail(publicKey);let sealed;
  try{capture.add('stderr',buffer.subarray(0,count));sealed=capture.finish();}finally{buffer.fill(0);}
  const receipt={schemaVersion:1,kind:'weatherx-component-private-diagnostic',model,runId,sourceSha,
    publishable:false,logBytes:info.size,capturedBytes:count,encryptedTail:sealed};
  mkdirSync(dirname(output),{recursive:true,mode:0o700});
  writeFileSync(output,JSON.stringify(receipt)+'\n',{mode:0o600});return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    assert.ok(process.env.RUNNER_TEMP);
    retain(resolve(process.env.RUNNER_TEMP,'component-publish.log'),
      resolve(process.env.RUNNER_TEMP,'component-diagnostic/receipt.json'),
      {model:process.env.MODEL,runId:process.env.GITHUB_RUN_ID,sourceSha:process.env.ATMOS_SHA});
  }catch{console.error('component diagnostic retention refused; no plaintext emitted');process.exitCode=1;}
}
