import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPagesReadAuthority, PAGES_READ_URL } from '../tools/data-reader-refresh.mjs';
const token='test-private-token',config='test-private-config';
const success=()=>Response.json({success:true,result:{name:'atmos-platform',deployment_configs:config}});
test('Pages authority check is one fixed bounded credentialed GET with no redirect',async()=>{
  const logs=[],calls=[];
  await checkPagesReadAuthority({token,log:x=>logs.push(x),fetchImpl:async(url,init)=>{calls.push({url,init});return success();}});
  assert.equal(calls.length,1);assert.equal(calls[0].url,PAGES_READ_URL);
  assert.match(PAGES_READ_URL,/\/accounts\/a89f9a1af485021fbc60a68b163c7c6e\/pages\/projects\/atmos-platform$/);
  assert.equal(calls[0].init.method,'GET');assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].init.headers.Authorization,`Bearer ${token}`);
  assert.ok(calls[0].init.signal instanceof AbortSignal);assert.equal(calls[0].init.body,undefined);
  assert.deepEqual(logs,['Pages GET authority confirmed (HTTP 200)']);
});
for(const status of [301,401,403,404,500])test(`Pages HTTP ${status} refuses without exposing response`,async()=>{
  const logs=[];
  await assert.rejects(checkPagesReadAuthority({token,log:x=>logs.push(x),fetchImpl:async()=>new Response(token+config,{status})}),/cannot verify/);
  assert.deepEqual(logs,[`Pages GET authority refused (HTTP ${status})`]);
});
test('missing credential refuses before network',async()=>{
  let called=false;await assert.rejects(checkPagesReadAuthority({token:'',log:()=>{},fetchImpl:async()=>{called=true;return success();}}),/cannot verify/);assert.equal(called,false);
});
for(const [label,reply] of [
  ['API refusal',()=>Response.json({success:false,errors:[{message:token}]})],
  ['wrong project',()=>Response.json({success:true,result:{name:'other'}})],
  ['malformed JSON',()=>new Response(token)],
  ['oversized body',()=>new Response('x'.repeat(1024*1024+1))],
])test(`Pages ${label} fails closed`,async()=>{
  const logs=[];await assert.rejects(checkPagesReadAuthority({token,log:x=>logs.push(x),fetchImpl:async()=>reply()}),/cannot verify/);
  assert.deepEqual(logs,['Pages GET authority refused (HTTP 200)']);
});
test('network/redirect failure text cannot leak credential or configuration',async()=>{
  const logs=[];await assert.rejects(checkPagesReadAuthority({token,log:x=>logs.push(x),fetchImpl:async()=>{throw Error(token+config);}}),error=>!error.message.includes(token)&&!error.message.includes(config));
  assert.deepEqual(logs,['Pages GET authority refused (HTTP unavailable)']);
});
