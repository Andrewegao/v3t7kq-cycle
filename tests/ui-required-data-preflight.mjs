import test from 'node:test';
import assert from 'node:assert/strict';
import {requireStagingTides,REQUIRED_TIDES_URL} from '../tools/ui-required-data-preflight.mjs';
import {POLICY_FILES} from '../tools/ui-release.mjs';

function fixture(change={}){
  let cancelled=0;
  return {response:{url:REQUIRED_TIDES_URL,status:200,headers:new Headers({'Content-Type':'application/json; charset=utf-8','X-WeatherX-Release':'release-a'}),
    body:{cancel:async()=>{cancelled++;}},json:()=>{throw new Error('must not buffer tide data');},...change},cancelled:()=>cancelled};
}
test('required tides uses the exact staging GET and releases its body without reading it',async()=>{
  const f=fixture();let calls=0;
  const receipt=await requireStagingTides({fetchImpl:async(url,init)=>{
    calls++;assert.equal(url,'https://staging.weatherx.org/data-atmos/tides/tides.json');
    assert.equal(init.redirect,'error');assert.equal(init.method,undefined);assert.equal(init.credentials,undefined);
    assert.deepEqual(init.headers,{Accept:'application/json','Cache-Control':'no-cache'});
    assert.ok(init.signal instanceof AbortSignal);assert.equal(init.signal.aborted,false);
    return f.response;
  }});
  assert.equal(calls,1);assert.equal(f.cancelled(),1);assert.deepEqual(receipt,{url:REQUIRED_TIDES_URL,status:200,releaseId:'release-a'});
  assert.ok(POLICY_FILES.includes('tools/ui-required-data-preflight.mjs'),'helper is bound into candidate pipeline authority');
});
test('required tides rejects each unavailable or unauthenticated header predicate and still cancels',async t=>{
  for(const [name,change,pattern] of [
    ['503',{status:503},/status 503; expected 200/],
    ['redirect',{url:'https://weatherx.org/data-atmos/tides/tides.json'},/request redirected/],
    ['HTML',{headers:new Headers({'Content-Type':'text/html','X-WeatherX-Release':'release-a'})},/Content-Type must be application\/json/],
    ['missing MIME',{headers:new Headers({'X-WeatherX-Release':'release-a'})},/Content-Type must be application\/json/],
    ['JSON lookalike',{headers:new Headers({'Content-Type':'application/jsonp','X-WeatherX-Release':'release-a'})},/Content-Type must be application\/json/],
    ['missing release',{headers:new Headers({'Content-Type':'application/json'})},/missing X-WeatherX-Release/],
    ['blank release',{headers:new Headers({'Content-Type':'application/json','X-WeatherX-Release':'   '})},/missing X-WeatherX-Release/],
  ])await t.test(name,async()=>{
    const f=fixture(change);
    await assert.rejects(requireStagingTides({fetchImpl:async()=>f.response}),error=>{
      assert.match(error.message,/required staging data https:\/\/staging\.weatherx\.org\/data-atmos\/tides\/tides\.json failed:/);
      assert.match(error.message,pattern);return true;
    });assert.equal(f.cancelled(),1);
  });
});
test('transport refusal and cancellation failure preserve the failed predicate',async()=>{
  await assert.rejects(requireStagingTides({fetchImpl:async()=>{throw new Error('network unavailable');}}),/required staging data.*network unavailable/);
  const f=fixture({status:503,body:{cancel:async()=>{throw new Error('already closed');}}});
  await assert.rejects(requireStagingTides({fetchImpl:async()=>f.response}),/status 503; expected 200/);
});
