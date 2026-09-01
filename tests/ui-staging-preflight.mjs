import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLongitude,pointUrl,preflightLocations,requireSelectionMargin,runPreflight,validatePointPayload} from '../tools/ui-staging-preflight.mjs';

const NOW=Date.parse('2026-09-01T12:30:00Z');
const payload=(model,change={})=>({schemaVersion:1,model,runId:'2026090106',releaseId:'staging-1',initializedAt:'2026-09-01T06:00:00.000Z',generatedAt:'2026-09-01T10:00:00.000Z',freshUntil:'2026-09-01T18:00:00.000Z',quality:'complete',missingFields:[],requestedPoint:{latitude:35,longitude:104},window:{start:'2026-09-01T12:00:00.000Z',end:'2026-09-15T12:00:00.000Z'},series:{temperature:{samples:[{validTime:'2026-09-01T12:00:00.000Z',value:20}]},wind_speed:{samples:[{validTime:'2026-09-01T12:00:00.000Z',value:4}]},wind_direction:{samples:[{validTime:'2026-09-01T12:00:00.000Z',value:270}]}},...change});
const response=(url,model,change={})=>({url:String(url),status:200,headers:new Headers({'x-weatherx-release':'staging-1'}),json:async()=>payload(model,change)});

test('staging preflight targets only the staging point API and a bounded 14-day window',()=>{
  const url=pointUrl('ecmwf',{lat:35,lon:104},NOW);assert.equal(url.origin,'https://staging.weatherx.org');assert.match(url.pathname,/\/api\/v1\/point-series\/ecmwf$/);
  assert.equal(url.searchParams.get('start'),'2026-09-01T12:00:00.000Z');assert.equal(url.searchParams.get('end'),'2026-09-15T12:00:00.000Z');assert.throws(()=>pointUrl('icon',{lat:35,lon:104},NOW));
});
test('regional centers include normalized dateline domains without duplicate probes',()=>{
  assert.ok(Math.abs(normalizeLongitude(-203.6)-156.4)<1e-9);const locations=preflightLocations({entries:[{model:'ak',grid:{lat0:77.1,lat1:41.6,lon0:-203.6,lon1:-115.75}},{model:'same',grid:{lat0:35,lat1:35,lon0:104,lon1:104}}]});
  assert.deepEqual(locations.map(x=>x.name),['china-default','ak']);assert.ok(locations[1].lon>=-180&&locations[1].lon<180);
});
test('selection preflight reserves expiry margin without advancing the real validation clock',()=>{
  const entry={init:'2026090100'};assert.doesNotThrow(()=>requireSelectionMargin({entries:[entry]},Date.parse('2026-09-01T11:35:00Z')));
  assert.throws(()=>requireSelectionMargin({entries:[entry]},Date.parse('2026-09-01T11:35:00.001Z')));
  assert.throws(()=>requireSelectionMargin({entries:[{init:'2026090118'}]},Date.parse('2026-09-01T17:50:00Z')));
});
test('point payload requires a current non-stale run and finite core variables',()=>{
  const expected={now:NOW,location:{lat:35,lon:104},start:'2026-09-01T12:00:00.000Z',end:'2026-09-15T12:00:00.000Z'};
  assert.equal(validatePointPayload(payload('ecmwf'),'ecmwf',expected).quality,'complete');
  for(const change of [{quality:'stale'},{freshUntil:new Date(NOW+25*60_000-1).toISOString()},{initializedAt:'2026-08-29T00:00:00.000Z'},{model:'gfs'},
    {requestedPoint:{latitude:-10,longitude:-10}},{window:{start:'2020-01-01T00:00:00.000Z',end:'2020-01-02T00:00:00.000Z'}},
    {series:{temperature:{samples:[]},wind_speed:{samples:[{validTime:'2026-09-01T12:00:00.000Z',value:4}]},wind_direction:{samples:[{validTime:'2026-09-01T12:00:00.000Z',value:270}]}}},
    {series:{temperature:{samples:[{validTime:'2020-01-01T00:00:00.000Z',value:20}]},wind_speed:{samples:[{validTime:'2026-09-01T12:00:00.000Z',value:4}]},wind_direction:{samples:[{validTime:'2026-09-01T12:00:00.000Z',value:270}]}}}])
    assert.throws(()=>validatePointPayload(payload('ecmwf',change),'ecmwf',expected));
});
test('baseline preflight is credential-free, probes both models, and rejects redirects or missing release identity',async()=>{
  const calls=[];const receipt=await runPreflight({selection:'none',root:'/unused',now:NOW,fetchImpl:async(url,init)=>{calls.push({url:String(url),init});return response(url,new URL(url).pathname.endsWith('/gfs')?'gfs':'ecmwf');}});
  assert.equal(receipt.origin,'https://staging.weatherx.org');assert.equal(receipt.locations,1);assert.equal(receipt.probes,2);assert.equal(calls.length,2);for(const call of calls){assert.equal(call.init.credentials,undefined);assert.doesNotMatch(JSON.stringify(call.init),/token|secret|production/i);}
  await assert.rejects(runPreflight({selection:'none',root:'/unused',now:NOW,fetchImpl:async url=>({...response(url,'ecmwf'),url:'https://weatherx.org/api/v1/point-series/ecmwf'})}));
  await assert.rejects(runPreflight({selection:'none',root:'/unused',now:NOW,fetchImpl:async url=>({...response(url,new URL(url).pathname.endsWith('/gfs')?'gfs':'ecmwf'),headers:new Headers()})}));
  await assert.rejects(runPreflight({selection:'none',root:'/unused',now:NOW,fetchImpl:async url=>response(url,new URL(url).pathname.endsWith('/gfs')?'gfs':'ecmwf',{releaseId:'body-other'})}));
  await assert.rejects(runPreflight({selection:'none',root:'/unused',now:NOW,fetchImpl:async url=>{const model=new URL(url).pathname.endsWith('/gfs')?'gfs':'ecmwf',release=model==='gfs'?'release-gfs':'staging-1';return {...response(url,model,{releaseId:release}),headers:new Headers({'x-weatherx-release':release})};}}));
});
