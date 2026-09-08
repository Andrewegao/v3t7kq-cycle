// Public bake logs are a projection of fixed progress fields. Detailed output is owner-key encrypted.
import assert from 'node:assert/strict';
import {createReadStream,existsSync,lstatSync,readdirSync,openSync,readSync,closeSync,mkdirSync,writeFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encryptedTail} from './nam-hi-diagnostic.mjs';

const MODELS='ecmwf|gfs|hrrr|aifs|icon|hrrr-ak|hrdps|nam|nam-hi|nam-ak|arome-antilles';
const CORE_MODELS='ecmwf|gfs|hrrr|aifs|icon';
const REGIONAL_MODELS='icon|hrrr-ak|hrdps|nam|nam-hi|nam-ak|arome-antilles';
const RUN=/^[1-9][0-9]{0,19}$/;
const SHA=/^[a-f0-9]{40}$/;
const DECIMAL=/^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,6})?$/;
const INTEGER=/^(?:0|[1-9][0-9]{0,9})$/;
const MAX_LINE_BYTES=4096;
const MAX_PUBLIC_RECORDS=10000;
const TAIL_BYTES=16384;
const STAGES=new Set([
  'ledger-tail','ledger-snapshot','data-bake','catalog-rebase','freshness-superset','fusion-accuracy',
  'road-board-capture','weather-lab-gate','duplicate-bake-receipt','vault-archive','release-cas-read',
  'immutable-release-publish','data-regional-model-packs','data-bricks-ecmwf','data-bricks-gfs',
  'data-verify-backfill','data-verify-observations','data-station-ledger-frames','data-station-ledger-float',
  'data-station-ledger-report','data-verify-publish','data-station-ledger-monthly-merge','data-point-assembly',
  'point-assembly',
  ...`${MODELS}`.split('|').map(model=>`native-${model}`),
]);

function timestamp(value){
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|\+00:00)$/.exec(value);
  if(!match)return false;
  const parts=match.slice(1,7).map(Number),date=new Date(Date.UTC(...[parts[0],parts[1]-1,...parts.slice(2)]));
  return date.getUTCFullYear()===parts[0]&&date.getUTCMonth()===parts[1]-1&&date.getUTCDate()===parts[2]&&
    date.getUTCHours()===parts[3]&&date.getUTCMinutes()===parts[4]&&date.getUTCSeconds()===parts[5];
}
function bounded(value,pattern,max){return pattern.test(value)&&Number(value)<=max;}

export function projectLine(line){
  if(typeof line!=='string'||Buffer.byteLength(line)>MAX_LINE_BYTES||/[\x00-\x09\x0b-\x1f\x7f-\uffff]/.test(line))return null;
  let match=/^\[([^\]]+)\] bake-stage name=([a-zA-Z0-9-]{1,80}) event=start$/.exec(line);
  if(match&&timestamp(match[1])&&STAGES.has(match[2]))return `[${match[1]}] bake-stage name=${match[2]} event=start`;
  match=/^\[([^\]]+)\] bake-stage name=([a-zA-Z0-9-]{1,80}) event=end status=([0-9]{1,3}) elapsed_seconds=([0-9]{1,10})$/.exec(line);
  if(match&&timestamp(match[1])&&STAGES.has(match[2])&&bounded(match[3],INTEGER,255)&&bounded(match[4],INTEGER,86400))return `[${match[1]}] bake-stage name=${match[2]} event=end status=${match[3]} elapsed_seconds=${match[4]}`;
  match=new RegExp(`^point-series worker model=(${MODELS}) status=(start-failed|-?[0-9]{1,3}) seconds=([0-9.]{1,17})$`).exec(line);
  if(match&&(match[2]==='start-failed'||bounded(match[2].replace(/^-/,''),INTEGER,255))&&bounded(match[3],DECIMAL,86400))return `point-series worker model=${match[1]} status=${match[2]} seconds=${match[3]}`;
  if(line.startsWith('{')&&Buffer.byteLength(line)<=1024){
    try{
      const value=JSON.parse(line),keys=Object.keys(value).sort();
      if(JSON.stringify(keys)===JSON.stringify(['models','requiresEnrichment','runId','sourceSha','status'])&&
        value.status==='installed-unqualified-inputs'&&JSON.stringify(value.models)===JSON.stringify(['ecmwf','gfs','hrrr','aifs'])&&
        RUN.test(value.runId)&&SHA.test(value.sourceSha)&&value.requiresEnrichment===true){
        return JSON.stringify({status:value.status,models:value.models,runId:value.runId,sourceSha:value.sourceSha,requiresEnrichment:true});
      }
    }catch{}
  }
  match=/^promoted cycle-([1-9][0-9]{0,19})$/.exec(line);if(match)return `promoted cycle-${match[1]}`;
  match=/^\[([^\]]+)\] === cycle complete ===$/.exec(line);if(match&&timestamp(match[1]))return `[${match[1]}] === cycle complete ===`;
  match=new RegExp(`^model-input resource (${CORE_MODELS}) peak-rss-kib=([0-9]{1,10}) elapsed-seconds=([0-9.]{1,17})$`).exec(line);
  if(match&&bounded(match[2],INTEGER,1_000_000_000)&&bounded(match[3],DECIMAL,86400))return `model-input resource ${match[1]} peak-rss-kib=${match[2]} elapsed-seconds=${match[3]}`;
  match=new RegExp(`^\\[([^\\]]+)\\] model-input start (${CORE_MODELS})$`).exec(line);
  if(match&&timestamp(match[1]))return `[${match[1]}] model-input start ${match[2]}`;
  match=new RegExp(`^\\[([^\\]]+)\\] model-input end (${CORE_MODELS}) exit=(-?[0-9]{1,3})$`).exec(line);
  if(match&&timestamp(match[1])&&match[3]!=='-0'&&bounded(match[3].replace(/^-/,''),INTEGER,255))return `[${match[1]}] model-input end ${match[2]} exit=${match[3]}`;
  match=new RegExp(`^\\[([^\\]]+)\\] regional-model install (${REGIONAL_MODELS}) status=(fresh|carried|absent) init=(\\d{10}|-)(?: reason=[\\x20-\\x7e]{1,512})?$`).exec(line);
  if(match&&timestamp(match[1]))return `[${match[1]}] regional-model install ${match[2]} status=${match[3]} init=${match[4]}`;
  return null;
}

export class PublicLineProjector{
  constructor(write,{maxLineBytes=MAX_LINE_BYTES,maxRecords=MAX_PUBLIC_RECORDS}={}){this.write=write;this.maxLineBytes=maxLineBytes;this.maxRecords=maxRecords;this.pending=Buffer.alloc(0);this.dropping=false;this.records=0;}
  emit(bytes){if(this.records>=this.maxRecords)return;const projected=projectLine(bytes.toString('utf8'));if(projected!==null){this.write(projected);this.records++;}}
  add(chunk){
    let offset=0;
    while(offset<chunk.length){
      const newline=chunk.indexOf(10,offset);
      if(this.dropping){if(newline<0)return;this.dropping=false;offset=newline+1;continue;}
      const end=newline<0?chunk.length:newline,part=chunk.subarray(offset,end);
      if(this.pending.length+part.length>this.maxLineBytes){this.pending=Buffer.alloc(0);if(newline<0){this.dropping=true;return;}}
      else this.pending=Buffer.concat([this.pending,part]);
      if(newline<0)return;
      if(this.pending.length&&this.pending[this.pending.length-1]===13)this.pending=this.pending.subarray(0,-1);
      this.emit(this.pending);this.pending=Buffer.alloc(0);offset=newline+1;
    }
  }
  finish(){if(!this.dropping&&this.pending.length)this.emit(this.pending);this.pending=Buffer.alloc(0);this.dropping=false;}
}

class TailRing{
  constructor(){this.buffer=Buffer.alloc(0);this.observed=0;}
  add(data){this.observed+=data.length;const next=Buffer.concat([this.buffer,data]).subarray(-TAIL_BYTES);this.buffer=Buffer.from(next);}
  clear(){this.buffer.fill(0);this.buffer=Buffer.alloc(0);}
}
function sealRings(stdout,stderr,publicKey){
  const capture=encryptedTail(publicKey);
  try{
    if(stdout.buffer.length)capture.add('stdout',stdout.buffer);
    if(stderr.buffer.length)capture.add('stderr',stderr.buffer);
    const envelope=capture.finish(),observedBytes=stdout.observed+stderr.observed;
    return {...envelope,observedBytes,droppedBytes:Math.max(0,observedBytes-stdout.buffer.length-stderr.buffer.length)};
  }finally{stdout.clear();stderr.clear();}
}
function latestLog(cwd){
  const dir=join(cwd,'ops/logs');if(!existsSync(dir))return null;const directory=lstatSync(dir);assert.ok(directory.isDirectory()&&!directory.isSymbolicLink());let selected=null,mtime=-1;
  for(const name of readdirSync(dir)){if(!/^bake-[a-zA-Z0-9._-]+\.log$/.test(name))continue;const path=join(dir,name),info=lstatSync(path);if(info.isFile()&&!info.isSymbolicLink()&&info.mtimeMs>=mtime){selected=path;mtime=info.mtimeMs;}}
  return selected;
}
function encryptedFileTail(path,publicKey){
  if(!path)return null;const info=lstatSync(path);assert.ok(info.isFile()&&!info.isSymbolicLink());const ring=new TailRing(),empty=new TailRing();
  const size=Math.min(info.size,TAIL_BYTES),buffer=Buffer.alloc(size),fd=openSync(path,'r');let count;
  try{count=readSync(fd,buffer,0,size,Math.max(0,info.size-size));ring.observed=info.size;ring.buffer=Buffer.from(buffer.subarray(0,count));}
  finally{closeSync(fd);buffer.fill(0);}
  return sealRings(empty,ring,publicKey);
}

export async function scanFile(path,write=line=>process.stdout.write(line+'\n')){
  if(!existsSync(path))return false;const info=lstatSync(path);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size<=1024*1024*1024);
  const projector=new PublicLineProjector(write);
  await new Promise((resolve,reject)=>{const stream=createReadStream(path);stream.on('data',data=>projector.add(data));stream.on('error',reject);stream.on('end',resolve);});
  projector.finish();return true;
}

export function retainLatest({cwd=process.cwd(),runnerTemp,runId,sourceSha,publicKey}={}){
  assert.ok(runnerTemp&&RUN.test(runId)&&SHA.test(sourceSha));const path=latestLog(cwd);if(!path)return false;
  const info=lstatSync(path),encryptedTail=encryptedFileTail(path,publicKey);
  const receipt={schemaVersion:1,kind:'weatherx-bake-private-diagnostic',runId,sourceSha,publishable:false,
    logBytes:info.size,capturedBytes:Math.min(info.size,TAIL_BYTES),encryptedTail};
  const directory=join(runnerTemp,'weatherx-bake-diagnostic');mkdirSync(directory,{recursive:true,mode:0o700});
  const encoded=JSON.stringify(receipt)+'\n';assert.ok(Buffer.byteLength(encoded)<50*1024);writeFileSync(join(directory,'receipt.json'),encoded,{flag:'wx',mode:0o600});return true;
}

async function main(){
  const [mode]=process.argv.slice(2);
  if(mode==='scan-latest'){const path=latestLog(process.cwd());if(path)await scanFile(path);return;}
  assert.equal(mode,'retain');retainLatest({runnerTemp:process.env.RUNNER_TEMP,runId:process.env.GITHUB_RUN_ID,sourceSha:process.env.ATMOS_SHA});
}
if(process.argv[1]&&realpathSync(resolve(process.argv[1]))===realpathSync(fileURLToPath(import.meta.url)))main().catch(()=>{console.error('bake diagnostic controller refused; no plaintext emitted');process.exitCode=1;});
