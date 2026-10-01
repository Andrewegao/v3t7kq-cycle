import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {pagesProjectMetadata,validateProjectSnapshot} from '../tools/ui-release.mjs';

const payload={success:true,result:{name:'weatherx-platform-staging'}};
const deadline=error=>/deadline/.test(error.message)||/deadline/.test(error.cause?.message??'');
const transport=code=>new TypeError('fetch failed',{cause:Object.assign(new Error('inert transport'),{code})});
function fixture(fetcher){
  let clock=0;const sleeps=[],requests=[],diagnostics=[];
  return {options:{now:()=>clock,onFailure:row=>diagnostics.push(row),sleep:async ms=>{sleeps.push(ms);clock+=ms;},fetcher:async(url,options)=>{
    requests.push({url,options});return fetcher({advance:ms=>{clock+=ms;},options,call:requests.length});
  }},sleeps,requests,diagnostics};
}
test('Pages metadata retries only known transient GET transport and keeps exact request scope',async()=>{
  for(const code of ['ECONNRESET','ETIMEDOUT','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT']){
    const f=fixture(({call})=>{if(call<3)throw transport(code);return Response.json(payload);});
    assert.deepEqual(await pagesProjectMetadata('staging','inert-token',f.options),payload);
    assert.equal(f.requests.length,3);assert.deepEqual(f.sleeps,[250,500]);
    for(const {url,options} of f.requests){
      assert.equal(url,'https://api.cloudflare.com/client/v4/accounts/a89f9a1af485021fbc60a68b163c7c6e/pages/projects/weatherx-platform-staging');
      assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.body,undefined);
      assert.equal(options.headers.Authorization,'Bearer inert-token');assert.ok(options.signal instanceof AbortSignal);
    }
  }
});
test('Pages metadata exhaustion preserves the final transport failure and stops at three attempts',async()=>{
  const failure=transport('ECONNRESET'),f=fixture(()=>{throw failure;});
  await assert.rejects(pagesProjectMetadata('staging','inert-token',f.options),error=>error.cause===failure);
  assert.equal(f.requests.length,3);assert.deepEqual(f.sleeps,[250,500]);
});
test('Pages metadata enforces total deadline after I/O and before another request',async()=>{
  const f=fixture(({advance,call})=>{advance(call===3?4250:20000);throw transport('ETIMEDOUT');});
  await assert.rejects(pagesProjectMetadata('staging','inert-token',f.options),deadline);
  assert.equal(f.requests.length,3);assert.deepEqual(f.sleeps,[250,500]);
  const late=fixture(({advance})=>{advance(45000);return Response.json(payload);});
  await assert.rejects(pagesProjectMetadata('staging','inert-token',late.options),deadline);
  assert.equal(late.requests.length,1);
  const timely=fixture(({advance})=>{advance(44999);return Response.json(payload);});
  assert.deepEqual(await pagesProjectMetadata('staging','inert-token',timely.options),payload);
  let clock=0,calls=0;
  await assert.rejects(pagesProjectMetadata('staging','inert-token',{now:()=>clock,onFailure:()=>{},sleep:async()=>{clock=45000;},fetcher:async()=>{calls++;throw transport('ECONNRESET');}}),deadline);
  assert.equal(calls,1);
});
test('Pages metadata retries body transport loss but includes body consumption in its deadline',async()=>{
  const f=fixture(({call})=>call===1?new Response(new ReadableStream({start(controller){controller.error(transport('ECONNRESET'));}})):Response.json(payload));
  assert.deepEqual(await pagesProjectMetadata('staging','inert-token',f.options),payload);
  assert.equal(f.requests.length,2);assert.deepEqual(f.sleeps,[250]);
  const late=fixture(({advance})=>new Response(new ReadableStream({pull(controller){
    advance(45000);controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));controller.close();
  }})));
  await assert.rejects(pagesProjectMetadata('staging','inert-token',late.options),deadline);
  assert.equal(late.requests.length,1);
});
test('Pages metadata request timeout is capped by the remaining total budget',async t=>{
  const timeouts=[];
  t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return new AbortController().signal;});
  const f=fixture(({advance})=>{advance(20000);throw transport('ETIMEDOUT');});
  await assert.rejects(pagesProjectMetadata('staging','inert-token',f.options),deadline);
  assert.deepEqual(timeouts,[20000,20000,4250]);
  for(const clock of [NaN,Infinity,-Infinity]){
    const invalid=fixture(()=>Response.json(payload));invalid.options.now=()=>clock;
    await assert.rejects(pagesProjectMetadata('staging','inert-token',invalid.options),/clock/);assert.equal(invalid.requests.length,0);
  }
});
test('Pages metadata retries only its own timeout, including body AbortError',async t=>{
  for(const bodyTimeout of [false,true]){
    let signals=0;const reason=new DOMException('inert timeout','TimeoutError');
    const mock=t.mock.method(AbortSignal,'timeout',()=>++signals===1?AbortSignal.abort(reason):new AbortController().signal);
    const f=fixture(({call})=>{
      if(call>1)return Response.json(payload);
      if(!bodyTimeout)throw reason;
      return new Response(new ReadableStream({start(controller){controller.error(new DOMException('inert aborted body','AbortError'));}}));
    });
    assert.deepEqual(await pagesProjectMetadata('staging','inert-token',f.options),payload);
    assert.equal(f.requests.length,2);assert.deepEqual(f.sleeps,[250]);mock.mock.restore();
  }
});
test('Pages metadata aborted signals never make auth, JSON or body-limit refusal retryable',async t=>{
  t.mock.method(AbortSignal,'timeout',()=>AbortSignal.abort(new DOMException('inert timeout','TimeoutError')));
  for(const response of [()=>new Response('',{status:401}),()=>new Response('',{status:403}),
    ()=>new Response('invalid-json'),()=>new Response('x'.repeat(2*1024*1024+1))]){
    const f=fixture(response);
    await assert.rejects(pagesProjectMetadata('staging','inert-token',f.options));
    assert.equal(f.requests.length,1);assert.deepEqual(f.sleeps,[]);
    assert.equal(f.diagnostics.length,1);assert.equal(f.diagnostics[0].retryEligible,false);
    assert.equal(f.diagnostics[0].ownTimeout,false);
  }
});
test('Pages metadata final refusal and the unchanged CLI catch hide raw error messages',async()=>{
  const sensitive='inert-token https://private.invalid/?credential=sensitive body-secret';
  const source=readFileSync(new URL('../tools/ui-release.mjs',import.meta.url),'utf8');
  const catchBody=source.match(/\} catch\(error\) \{ (console\.error\(`UI release refused: \$\{error\.message\}`\); process\.exitCode=1;) \}/)?.[1];
  assert.ok(catchBody,'existing final CLI catch must remain unchanged');
  for(const code of ['ECONNRESET','ENOTFOUND',sensitive]){
    const failure=new TypeError(sensitive,{cause:Object.assign(new Error(sensitive),{code})});
    const f=fixture(()=>{throw failure;});
    await assert.rejects(pagesProjectMetadata('staging','inert-token',f.options),error=>{
      assert.equal(error.message,'Pages metadata GET refused');assert.equal(error.cause,failure);
      const messages=[],inertProcess={exitCode:0};
      new Function('error','console','process',catchBody)(error,{error:message=>messages.push(message)},inertProcess);
      assert.equal(inertProcess.exitCode,1);assert.deepEqual(messages,['UI release refused: Pages metadata GET refused']);
      assert.ok(!JSON.stringify(messages).includes(sensitive));assert.ok(!JSON.stringify(f.diagnostics).includes(sensitive));
      return true;
    });
  }
});
test('Pages metadata failure diagnostics are fixed bounded fields without source error or credentials',async()=>{
  const sensitive='inert-token https://private.invalid/?credential=sensitive body-secret';
  for(const code of ['ECONNRESET','ENOTFOUND',sensitive]){
    const failure=new TypeError(sensitive,{cause:Object.assign(new Error(sensitive),{code})});
    const f=fixture(()=>{throw failure;});
    await assert.rejects(pagesProjectMetadata('staging','inert-token',f.options),error=>error.cause===failure);
    assert.equal(f.diagnostics.length,1);
    const row=f.diagnostics[0];assert.deepEqual(Object.keys(row).sort(),['kind','attempt','maxAttempts','reason','transportCode','ownTimeout','retryEligible'].sort());
    assert.equal(row.transportCode,code===sensitive?null:code);assert.equal(row.attempt,code==='ECONNRESET'?3:1);
    assert.equal(row.retryEligible,code==='ECONNRESET');assert.equal(row.ownTimeout,false);
    assert.ok(!JSON.stringify(row).includes('sensitive'));assert.ok(!JSON.stringify(row).includes('inert-token'));
  }
});
test('Pages metadata does not retry fatal auth, redirect, HTTP, JSON, body bound or unknown failures',async()=>{
  for(const response of [()=>new Response('',{status:401}),()=>new Response('',{status:403}),()=>new Response('',{status:404}),
    ()=>new Response('',{status:429}),()=>new Response('',{status:503}),()=>new Response('',{status:302}),
    ()=>new Response('not-json'),()=>new Response('x'.repeat(2*1024*1024+1))]){
    const f=fixture(response);await assert.rejects(pagesProjectMetadata('staging','inert-token',f.options));
    assert.equal(f.requests.length,1);assert.deepEqual(f.sleeps,[]);
  }
  for(const failure of [transport('ENOTFOUND'),transport('ECONNREFUSED'),transport('CERT_HAS_EXPIRED'),transport('ERR_TLS_CERT_ALTNAME_INVALID'),
    new TypeError('fetch failed'),new Error('configuration failed'),new DOMException('cancelled','AbortError'),new DOMException('unrelated timeout','TimeoutError')]){
    const f=fixture(()=>{throw failure;});await assert.rejects(pagesProjectMetadata('staging','inert-token',f.options),error=>error.cause===failure);
    assert.equal(f.requests.length,1);assert.deepEqual(f.sleeps,[]);
  }
});
test('Pages metadata leaves provider-success and configuration identity gates fatal',async()=>{
  for(const value of [{success:false,result:payload.result},{success:true,result:{...payload.result,domains:['wrong.example']}}]){
    const f=fixture(()=>Response.json(value));const result=await pagesProjectMetadata('staging','inert-token',f.options);
    assert.throws(()=>{assert.equal(result.success,true);validateProjectSnapshot('staging',result.result,'a'.repeat(64));});
    assert.equal(f.requests.length,1);assert.deepEqual(f.sleeps,[]);
  }
  const f=fixture(()=>Response.json(payload));await assert.rejects(pagesProjectMetadata('unknown','inert-token',f.options));
  assert.equal(f.requests.length,0);
});
test('Pages metadata retries real Node fetch socket loss against only an owned inert server',async t=>{
  let connections=0;
  const server=createServer((request,response)=>{connections++;assert.equal(request.method,'GET');assert.equal(request.headers.authorization,undefined);
    if(connections===1){request.socket.destroy();return;}response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify(payload));});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const local=`http://127.0.0.1:${server.address().port}/metadata`;
  let attempts=0;
  const result=await pagesProjectMetadata('staging','inert-token',{fetcher:(_url,options)=>{attempts++;return fetch(local,{method:options.method,redirect:options.redirect,signal:options.signal});}});
  assert.deepEqual(result,payload);assert.equal(connections,2);assert.equal(attempts,2);
});
