import assert from 'node:assert/strict';
import {chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const root=new URL('..',import.meta.url).pathname;
const script=join(root,'tools/model-inputs-noaa.sh');

function executable(path,body){writeFileSync(path,`#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);chmodSync(path,0o755);}
function outputValue(path,key){
  const line=readFileSync(path,'utf8').trim().split('\n').filter((entry)=>entry.startsWith(`${key}=`)).at(-1);
  return line?.slice(key.length+1)??'';
}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'weatherx-noaa-orchestrator-'));
  const bin=join(dir,'bin');const runner=join(dir,'runner');const events=join(dir,'events');const output=join(dir,'output');
  mkdirSync(bin);mkdirSync(runner);writeFileSync(events,'');writeFileSync(output,'');
  executable(join(bin,'timeout'),'while [[ "$1" == -* || "$1" =~ ^[0-9]+[smh]$ ]]; do shift; done\nexec "$@"');
  executable(join(bin,'python'),`
echo "collect:$MODEL_ID" >>"$EVENTS"
if [[ " \${FAIL_COLLECT:-} " == *" $MODEL_ID "* ]]; then exit 19; fi
if [[ "\${ABORT_COLLECT:-}" == "$MODEL_ID" ]]; then kill -TERM "$PPID"; kill -KILL "$PPID"; sleep 1; exit 143; fi
mkdir -p "$RUNNER_TEMP/weatherx-model-inputs/$MODEL_ID"
printf '{"model":"%s"}\n' "$MODEL_ID" >"$RUNNER_TEMP/weatherx-model-inputs/$MODEL_ID/cloud-input-receipt.json"`);
  executable(join(bin,'node'),`
if [[ "$*" == *" archive" ]]; then
  echo "archive-start:$MODEL_ID" >>"$EVENTS"
  sleep 0.05
  echo "archive-finish:$MODEL_ID" >>"$EVENTS"
  if [[ " \${FAIL_ARCHIVE:-} " == *" $MODEL_ID "* ]]; then exit 23; fi
fi`);
  const env={...process.env,PATH:`${bin}:${process.env.PATH}`,RUNNER_TEMP:runner,GITHUB_OUTPUT:output,EVENTS:events,MODEL_INIT:'2026090106',MODEL_SOURCE_SHA:'a'.repeat(40)};
  return {dir,runner,events,output,env,cleanup:()=>rmSync(dir,{recursive:true,force:true})};
}
function run(action,env){return spawnSync('bash',[script,action],{cwd:root,env,encoding:'utf8'});}

test('one NOAA acquisition failure preserves and archives every completed sibling while overall collection fails',()=>{
  const f=fixture();
  try{
    const collected=run('collect',{...f.env,FAIL_COLLECT:'nam'});
    assert.equal(collected.status,1);
    assert.equal(outputValue(f.output,'completed'),'hrrr-ak nam-hi nam-ak');
    assert.match(readFileSync(f.events,'utf8'),/collect:hrrr-ak[\s\S]*collect:nam[\s\S]*collect:nam-hi[\s\S]*collect:nam-ak/);
    writeFileSync(f.output,'');
    const archived=run('archive',{...f.env,MODEL_INPUTS_COMPLETED:'hrrr-ak nam-hi nam-ak'});
    assert.equal(archived.status,0,archived.stderr);
    const events=readFileSync(f.events,'utf8');
    for(const model of ['hrrr-ak','nam-hi','nam-ak'])assert.match(events,new RegExp(`archive-finish:${model}`));
    assert.doesNotMatch(events,/archive-(?:start|finish):nam(?:\n|$)/);
  }finally{f.cleanup();}
});

test('termination during a later acquisition leaves the last canonical completed prefix flushed',()=>{
  const f=fixture();
  try{
    const collected=run('collect',{...f.env,ABORT_COLLECT:'nam'});
    assert.ok(collected.status!==0||collected.signal!==null);
    assert.equal(outputValue(f.output,'completed'),'hrrr-ak');
    assert.match(readFileSync(f.events,'utf8'),/collect:hrrr-ak\ncollect:nam\n/);
  }finally{f.cleanup();}
});

test('one NOAA archive failure still joins its sibling and attempts the later pair before failing',()=>{
  const f=fixture();
  try{
    for(const model of ['hrrr-ak','nam','nam-hi','nam-ak']){
      const dir=join(f.runner,'weatherx-model-inputs',model);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'cloud-input-receipt.json'),'{}');
    }
    const archived=run('archive',{...f.env,MODEL_INPUTS_COMPLETED:'hrrr-ak nam nam-hi nam-ak',FAIL_ARCHIVE:'hrrr-ak'});
    assert.equal(archived.status,1);
    const events=readFileSync(f.events,'utf8');
    for(const model of ['hrrr-ak','nam','nam-hi','nam-ak'])assert.match(events,new RegExp(`archive-finish:${model}`));
    assert.equal(outputValue(f.output,'failed'),'1');
  }finally{f.cleanup();}
});

test('archive refuses non-canonical sets and absent receipts before archive invocation',()=>{
  const f=fixture();
  try{
    assert.equal(run('archive',{...f.env,MODEL_INPUTS_COMPLETED:'nam hrrr-ak'}).status,1);
    assert.equal(run('archive',{...f.env,MODEL_INPUTS_COMPLETED:'hrrr-ak'}).status,1);
    assert.doesNotMatch(readFileSync(f.events,'utf8'),/archive-/);
  }finally{f.cleanup();}
});
