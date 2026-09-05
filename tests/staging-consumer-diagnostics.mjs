import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {guardedRepair,verifySharedForecast,safeFailure} from '../tools/staging-consumer.mjs';
const OLD='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',NEW='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const before={version:OLD,state:{bindings:[]}},desired={bindings:[]};
test('unknown exceptions and forged diagnostics never reflect raw text or properties',()=>{
  const error=Object.assign(Error('SECRET https://private/?token=SECRET'),{diagnostic:{phase:'SECRET',code:'SECRET'},status:'SECRET',stderr:'SECRET'});
  assert.deepEqual(safeFailure(error,'verify'),{phase:'verify',code:'operation-failed'});
  assert.doesNotMatch(JSON.stringify(safeFailure(error,'SECRET')),/SECRET|https/);
});
async function failProbe(fetcher){const probes=[];let failure;try{await verifySharedForecast(fetcher,Date.parse('2026-09-05T20:00:00Z'),probe=>probes.push(probe));}catch(error){failure=safeFailure(error,'verify');}return {probes,failure};}
test('health network HTTP content JSON and stream errors retain fixed meaningful phases',async()=>{
  for(const [fetcher,code] of [
    [async()=>{throw Error('SECRET_URL https://private/token');},'network'],
    [async()=>new Response('SECRET',{status:503}),'http-status'],
    [async()=>new Response('SECRET',{headers:{'content-type':'text/html'}}),'content-type'],
    [async()=>new Response('{SECRET',{headers:{'content-type':'application/json'}}),'json'],
    [async()=>new Response(new ReadableStream({start(c){c.error(Error('SECRET'));}}),{headers:{'content-type':'application/json'}}),'stream'],
  ]){const result=await failProbe(fetcher);assert.equal(result.failure.phase,'read-health');assert.equal(result.failure.code,code);assert.equal(result.probes.length,1);assert.doesNotMatch(JSON.stringify(result),/SECRET|private|token/);}
});
test('health contract records billing/source markers but never unknown body/header values',async()=>{
  const result=await failProbe(async url=>Response.json(url.endsWith('/data-health')?
    {ok:true,authMode:'public',catalogMode:'serve',dataSource:'shared',sharedReadConfigured:true,secret:'SECRET'}:
    {ok:true,authMode:'public',billingMode:'enabled',secret:'SECRET'},
    {headers:{'x-weatherx-catalog':'SECRET','authorization':'SECRET','x-weatherx-data-source':'SECRET'}}));
  assert.deepEqual(result.failure,{phase:'contract-health',code:'contract'});
  assert.equal(result.probes[0].billingMode,'enabled');assert.equal(result.probes[1].dataSource,'shared');
  assert.equal(result.probes[1].sharedReadConfigured,true);assert.doesNotMatch(JSON.stringify(result),/SECRET|authorization/);
});
test('map read and map contract failures are distinguishable from health',async()=>{
  for(const invalidJSON of [true,false]){
    const result=await failProbe(async url=>{
      if(url.endsWith('/data-health'))return Response.json({ok:true,authMode:'public',catalogMode:'serve',dataSource:'shared',sharedReadConfigured:true});
      if(url.endsWith('/health'))return Response.json({ok:true,authMode:'public',billingMode:'disabled'});
      if(invalidJSON)return new Response('SECRET',{status:404});
      return Response.json({model:'ecmwf',runs:[{path:'runs/2026090500/',init_time:'2026-09-05T00:00:00Z'}]},
        {headers:{'x-weatherx-data-source':'own','x-weatherx-catalog':'95-11111111-1111-1111-1111-111111111111'}});
    });
    assert.equal(result.failure.phase,invalidJSON?'read-ecmwf-index':'contract-ecmwf-index');
    assert.equal(result.failure.code,invalidJSON?'http-status':'contract');
    if(!invalidJSON){assert.equal(result.probes.at(-1).runId,'2026090500');assert.equal(result.probes.at(-1).dataSource,'own');}
  }
});
test('failure context and bounded probe records survive successful rollback',async()=>{
  let current=OLD,saved;
  await assert.rejects(guardedRepair({before,desired,upload:async()=>NEW,snapshot:async()=>({version:current,state:desired}),
    activate:async()=>{current=NEW;},verify:async observe=>verifySharedForecast(async()=>new Response('SECRET',{status:503}),Date.now(),observe),
    getVersion:async()=>current,rollback:async()=>{current=OLD;},persist:async value=>{saved=structuredClone(value);}}));
  assert.equal(saved.status,'failed-restored');assert.deepEqual(saved.failure,{phase:'read-health',code:'http-status',httpStatus:503});
  assert.equal(saved.probes[0].httpStatus,503);assert.doesNotMatch(JSON.stringify(saved),/SECRET/);
});
test('upload and recovery failure contexts remain distinct without leaking subprocess output',async()=>{
  for(const uploadFailure of [true,false]){let current=OLD,saved;
    await assert.rejects(guardedRepair({before,desired,upload:async()=>{if(uploadFailure)throw Error('SECRETstderr');return NEW;},snapshot:async()=>({version:current,state:desired}),
      activate:async()=>{current=NEW;},verify:async()=>{throw Error('SECRETread');},getVersion:async()=>current,
      rollback:async()=>{throw Error('SECRETrestore');},persist:async value=>{saved=structuredClone(value);}}));
    assert.equal(saved.failure.phase,uploadFailure?'upload':'verify');
    if(!uploadFailure)assert.equal(saved.recoveryFailure.phase,'rollback');
    assert.doesNotMatch(JSON.stringify(saved),/SECRET/);
  }
});
test('receipt caps probe records and re-sanitizes callback fields',async()=>{
  let current=OLD,saved;
  await guardedRepair({before,desired,upload:async()=>NEW,snapshot:async()=>({version:current,state:desired}),
    activate:async()=>{current=NEW;},verify:async observe=>{for(let n=0;n<40;n++)await observe({label:'health',httpStatus:200,token:'SECRET',catalogId:'SECRET',runId:'SECRET',dataSource:'SECRET'});},
    rollback:async()=>{current=OLD;},persist:async value=>{saved=structuredClone(value);}});
  assert.equal(saved.status,'passed');assert.equal(saved.probes.length,24);
  assert.deepEqual(saved.probes[0],{label:'health',httpStatus:200});assert.doesNotMatch(JSON.stringify(saved),/SECRET|token/);
});
test('receipt write failures after activation never prevent owned rollback',async()=>{
  for(const at of ['verify','probe','catch']){
    let current=OLD,rollbacks=0,saved;
    await assert.rejects(guardedRepair({before,desired,upload:async()=>NEW,snapshot:async()=>({version:current,state:desired}),
      activate:async()=>{current=NEW;},verify:async observe=>{
        if(at==='probe')await observe({label:'health',httpStatus:200});
        throw Error('SECREToriginal');
      },getVersion:async()=>current,rollback:async()=>{rollbacks++;current=OLD;},persist:async value=>{
        const fail=current===NEW&&(at==='verify'||(at==='probe'&&value.probes?.length)||value.status==='failed-recovery-pending');
        if(fail)throw Error('SECRETdisk');saved=structuredClone(value);
      }}));
    assert.equal(current,OLD);assert.equal(rollbacks,1);assert.equal(saved.status,'failed-restored');
    assert.doesNotMatch(JSON.stringify(saved),/SECRET/);
  }
});
test('probe persistence failure does not replace the original HTTP or health contract failure',async()=>{
  for(const httpFailure of [true,false]){
    let current=OLD,saved;
    await assert.rejects(guardedRepair({before,desired,upload:async()=>NEW,snapshot:async()=>({version:current,state:desired}),
      activate:async()=>{current=NEW;},verify:async observe=>verifySharedForecast(async url=>httpFailure?new Response('SECRET',{status:503}):Response.json(url.endsWith('/data-health')?
        {ok:true,authMode:'public',catalogMode:'serve',dataSource:'shared',sharedReadConfigured:true}:{ok:true,authMode:'public',billingMode:'enabled'}),Date.now(),observe),
      getVersion:async()=>current,rollback:async()=>{current=OLD;},persist:async value=>{
        if(current===NEW&&value.probes?.length)throw Error('SECRETdisk');saved=structuredClone(value);
      }}));
    assert.equal(current,OLD);assert.equal(saved.status,'failed-restored');
    assert.equal(saved.failure.phase,httpFailure?'read-health':'contract-health');
    assert.equal(saved.failure.code,httpFailure?'http-status':'contract');assert.doesNotMatch(JSON.stringify(saved),/SECRET/);
  }
});
test('permanent receipt outage still restores owned version and refuses a foreign version',async()=>{
  for(const foreign of [false,true]){
    let current=OLD,failed=false,rollbacks=0,receipt;
    const diskError=Error('SECRETdisk');
    await assert.rejects(guardedRepair({before,desired,upload:async()=>NEW,snapshot:async()=>({version:current,state:desired}),
      activate:async()=>{current=NEW;failed=true;},verify:async()=>{},getVersion:async()=>foreign?'cccccccc-cccc-cccc-cccc-cccccccccccc':current,
      rollback:async()=>{rollbacks++;current=OLD;},persist:async value=>{receipt=value;if(failed)throw diskError;}}),
      error=>foreign?/another publisher owns staging/.test(error.message):error===diskError);
    assert.equal(rollbacks,foreign?0:1);assert.equal(current,foreign?NEW:OLD);
    assert.equal(receipt.status,foreign?'failed-recovery-incomplete':'failed-restored');
    assert.deepEqual(receipt.persistenceFailure,{phase:'receipt-persist',code:'write'});
    assert.doesNotMatch(JSON.stringify(receipt),/SECRET/);
  }
});
test('workflow runs the diagnostic regression; source pin and retry schedule stay exact',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/staging-consumer-refresh.yml',import.meta.url),'utf8');
  assert.match(workflow,/tests\/staging-consumer-diagnostics\.mjs/);
  const source=readFileSync(new URL('../tools/staging-consumer.mjs',import.meta.url),'utf8');
  assert.match(source,/for\(let n=0;n<3;n\+\+\)/);assert.match(source,/setTimeout\(r,5000\)/);
  assert.match(source,/0aa9fbed9e179ab2ccb6ac456727b9f33124ddb6/);
});
