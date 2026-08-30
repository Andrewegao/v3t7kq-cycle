import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {checked,liveVerify,assertPointPayload} from '../tools/consumer-refresh.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const release='cycle-33333979833';
const expected={releaseId:release,quality:'complete',value:3.5,series:{wind_direction:{units:'degree',samples:[{validTime:'2026-08-31T01:00:00Z',value:59.63236301585144}]},temperature:{units:'C',samples:[{validTime:'2026-08-31T01:00:00Z',value:23.5}]}}};
const point=JSON.stringify(expected);
const receipt={release,proof:{fallbacks:[{path:'ledger/index.json',sha256:digest('ledger')}],points:[{name:'Chicago',model:'ecmwf',url:'https://weatherx.org/api/v1/point-series/ecmwf',payloadSha256:digest(point),payload:expected}]}};
function reader(change=()=>{}) {
  return async(url,_token,_max,method='GET')=>{
    const path=new URL(url).pathname;
    const headers=new Headers();let body;
    if(path==='/api/platform/data-health')body=JSON.stringify({ok:true,authMode:'public',catalogMode:'serve'});
    else if(path==='/api/platform/health')body=JSON.stringify({ok:true,authMode:'observe',billingMode:'disabled'});
    else if(path==='/data/ledger/index.json'){body=method==='HEAD'?'':'ledger';headers.set('x-weatherx-release',release);}
    else if(path.startsWith('/api/v1/point-series/')){body=point;headers.set('x-weatherx-release',release);}
    else{body='{}';headers.set('x-weatherx-catalog','catalog-test');}
    const response={body:Buffer.from(body),headers};change(response,path,method);return response;
  };
}
test('checked preserves rejection while emitting only static diagnostic fields',async()=>{
  const events=[];const error=new Error('secret-value must never enter receipt');error.code='UNTRUSTED_SECRET';
  await assert.rejects(checked('activation:platform',()=>{throw error},x=>events.push(x)),e=>e===error);
  assert.deepEqual(events,[{stage:'activation:platform',state:'started'},{stage:'activation:platform',state:'failed',kind:'error'}]);
  assert.ok(!JSON.stringify(events).includes('secret-value'));
});
test('live verifier retains exact fallback release assertion and names its failure',async()=>{
  const events=[];
  await assert.rejects(liveVerify(receipt,{read:reader((r,p)=>{if(p==='/data/ledger/index.json')r.headers.set('x-weatherx-release','old');}),report:x=>events.push(x)}));
  assert.deepEqual(events.at(-1),{stage:'fallback:ledger/index.json:GET:release',state:'failed',kind:'assertion'});
});
test('live verifier rejects non-direction value changes and names its failure',async()=>{
  const events=[];
  await assert.rejects(liveVerify(receipt,{read:reader((r,p)=>{if(p.includes('point-series'))r.body=Buffer.from(point.replace('3.5','3.6'));}),report:x=>events.push(x)}));
  assert.deepEqual(events.at(-1),{stage:'point:ecmwf:Chicago:payload',state:'failed',kind:'assertion'});
});
test('real Node/workerd atan2 rounding is accepted only in direction sample values',()=>{
  const actual=structuredClone(expected);actual.series.wind_direction.samples[0].value=59.63236301585147;
  const before=structuredClone(actual);
  const result=assertPointPayload(actual,expected);
  assert.equal(result.roundedDirectionValues,1);
  assert.ok(result.maxDirectionDifference>0&&result.maxDirectionDifference<1e-12);
  assert.deepEqual(actual,before,'comparison must not mutate actual response');
});
test('metadata, other numeric values, missing/extra fields and nonfinite values remain exact',()=>{
  const changes=[
    x=>x.releaseId='old',x=>x.quality='partial',x=>x.value+=Number.EPSILON*4,
    x=>x.series.temperature.samples[0].value+=1e-13,
    x=>x.series.wind_direction.samples[0].validTime='2026-08-31T02:00:00Z',
    x=>x.series.wind_direction.samples[0].value+=1e-9,
    x=>x.series.wind_direction.samples[0].value=null,
    x=>x.series.wind_direction.samples[0].value=NaN,
    x=>x.series.wind_direction.samples[0].value=Infinity,
    x=>x.series.wind_direction.samples[0].value=String(x.series.wind_direction.samples[0].value),
    x=>delete x.series.temperature,x=>x.extra=true,x=>x.series.wind_direction.samples.push({value:2}),
  ];
  for(const change of changes){const actual=structuredClone(expected);change(actual);assert.throws(()=>assertPointPayload(actual,expected));}
});
test('direction comparison cannot turn a missing expected value into a forecast',()=>{
  const missing=structuredClone(expected);missing.series.wind_direction.samples[0].value=null;
  assert.throws(()=>assertPointPayload(expected,missing));
  assert.equal(assertPointPayload(missing,missing).roundedDirectionValues,0);
});
test('normalization preserves the prior exact serialization ordering requirement',()=>{
  const reordered={quality:expected.quality,releaseId:expected.releaseId,value:expected.value,series:expected.series};
  assert.throws(()=>assertPointPayload(reordered,expected),/serialization differs/);
});
test('successful verifier still checks HEAD, both safety modes and all catalog models',async()=>{
  const events=[];await liveVerify(receipt,{read:reader(),report:x=>events.push(x)});
  const passed=events.filter(x=>x.state==='passed').map(x=>x.stage);
  assert.ok(passed.includes('fallback:ledger/index.json:HEAD:release'));
  assert.ok(passed.includes('health:platform:payload'));
  assert.ok(passed.includes('health:data:payload'));
  for(const model of ['ecmwf','gfs','hrrr','aifs'])assert.ok(passed.includes(`catalog:${model}:header`));
});
