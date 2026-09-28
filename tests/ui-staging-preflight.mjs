import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {normalizeLongitude,pointUrl,preflightLocations,requireSelectionMargin,runPreflight,validatePointPayload,formatPreflightFailure} from '../tools/ui-staging-preflight.mjs';

const NOW=Date.parse('2026-09-01T12:30:00Z');
const payload=(model,change={})=>({schemaVersion:1,model,runId:'2026090106',releaseId:'staging-1',initializedAt:'2026-09-01T06:00:00.000Z',generatedAt:'2026-09-01T10:00:00.000Z',freshUntil:'2026-09-01T18:00:00.000Z',quality:'complete',missingFields:[],requestedPoint:{latitude:35,longitude:104},window:{start:'2026-09-01T12:00:00.000Z',end:'2026-09-15T12:00:00.000Z'},series:{temperature:{samples:[{validTime:'2026-09-01T12:00:00.000Z',value:20}]},wind_speed:{samples:[{validTime:'2026-09-01T12:00:00.000Z',value:4}]},wind_direction:{samples:[{validTime:'2026-09-01T12:00:00.000Z',value:270}]}},...change});
const response=(url,model,change={})=>{const parsed=new URL(url);if(parsed.pathname==='/data-atmos/tides/tides.json')return tideResponse(url);return {url:String(url),status:200,headers:new Headers({'x-weatherx-release':'staging-1'}),json:async()=>payload(model,{requestedPoint:{latitude:Number(parsed.searchParams.get('lat')),longitude:Number(parsed.searchParams.get('lon'))},...change})};};

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
  assert.equal(receipt.origin,'https://staging.weatherx.org');assert.equal(receipt.locations,1);assert.equal(receipt.probes,2);assert.equal(calls.length,3);for(const call of calls){assert.equal(call.init.credentials,undefined);assert.doesNotMatch(JSON.stringify(call.init),/token|secret|production/i);}
  await assert.rejects(runPreflight({selection:'none',root:'/unused',now:NOW,fetchImpl:async url=>({...response(url,'ecmwf'),url:'https://weatherx.org/api/v1/point-series/ecmwf'})}));
  await assert.rejects(runPreflight({selection:'none',root:'/unused',now:NOW,fetchImpl:async url=>({...response(url,new URL(url).pathname.endsWith('/gfs')?'gfs':'ecmwf'),headers:new Headers()})}));
  await assert.rejects(runPreflight({selection:'none',root:'/unused',now:NOW,fetchImpl:async url=>response(url,new URL(url).pathname.endsWith('/gfs')?'gfs':'ecmwf',{releaseId:'body-other'})}));
  await assert.rejects(runPreflight({selection:'none',root:'/unused',now:NOW,fetchImpl:async url=>{const model=new URL(url).pathname.endsWith('/gfs')?'gfs':'ecmwf',release=model==='gfs'?'release-gfs':'staging-1';return {...response(url,model,{releaseId:release}),headers:new Headers({'x-weatherx-release':release})};}}));
});
test('release-roster core preflight reads no selection file and proves AIFS plus HRRR at its CONUS point',async()=>{
  const calls=[];const receipt=await runPreflight({selection:'release-roster-core-v1',root:'/path/that/does/not/exist',now:NOW,fetchImpl:async(url,init)=>{
    calls.push({url:new URL(url),init});const model=new URL(url).pathname.split('/').at(-1);return response(url,model);
  }});
  assert.equal(receipt.locations,2);assert.equal(receipt.probes,4);assert.deepEqual(receipt.results.map(row=>row.model),['ecmwf','gfs','aifs','hrrr']);
  assert.deepEqual(calls.map(call=>call.url.pathname),['/api/v1/point-series/ecmwf','/api/v1/point-series/gfs','/api/v1/point-series/aifs','/api/v1/point-series/hrrr','/data-atmos/tides/tides.json']);
  const hrrr=calls.find(call=>call.url.pathname.endsWith('/hrrr')).url;assert.equal(hrrr.searchParams.get('lat'),'39.74');assert.equal(hrrr.searchParams.get('lon'),'-104.99');
  assert.ok(calls.every(call=>call.url.origin==='https://staging.weatherx.org'&&call.init.credentials===undefined));
});
test('release-roster core preflight runs and reports every independent core probe when peers fail',async()=>{
  const calls=[];
  await assert.rejects(runPreflight({selection:'release-roster-core-v1',root:'/unused',now:NOW,batchSize:4,fetchImpl:async url=>{
    const parsed=new URL(url),model=parsed.pathname.split('/').at(-1);calls.push(model);
    if(model==='ecmwf'||model==='hrrr')return {...response(url,model),status:503};
    return response(url,model);
  }}),error=>{
    assert.equal(error instanceof AggregateError,true);assert.equal(error.errors.length,2);
    assert.deepEqual(error.errors.map(item=>item.message.split('\n',1)[0]),[
      'ecmwf@china-default: staging point ecmwf/china-default returned 503',
      'hrrr@hrrr-conus: staging point hrrr/hrrr-conus returned 503',
    ]);
    return true;
  });
  assert.deepEqual(calls,['ecmwf','gfs','aifs','hrrr','tides.json'],'AIFS and HRRR must both run even when a peer fails');
});

const tideResponse=url=>({url:String(url),status:200,headers:new Headers({
  'content-type':'application/json','x-weatherx-release':'places-noaa-coops-20260901T120000Z'}),
  body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{}'));controller.close();}})});

test('preflight checks the final guard tide alias and fails before build when its lease is unavailable',async()=>{
  for(const status of [200,503]){
    const calls=[];
    const run=runPreflight({now:NOW,fetchImpl:async(url,init)=>{
      const parsed=new URL(url);calls.push(parsed.pathname);
      if(parsed.pathname==='/data-atmos/tides/tides.json'){
        assert.equal(parsed.origin,'https://staging.weatherx.org');assert.equal(init.redirect,'error');
        assert.ok(init.signal instanceof AbortSignal);assert.equal(init.headers.Authorization,undefined);
        return {...tideResponse(url),status};
      }
      return response(url,parsed.pathname.split('/').at(-1));
    }});
    if(status===200){const result=await run;assert.equal(result.tides.releaseId,'places-noaa-coops-20260901T120000Z');}
    else await assert.rejects(run,error=>error instanceof AggregateError&&error.errors.some(e=>e.message.includes('/data-atmos/tides/tides.json')&&e.message.includes('503')));
    assert.ok(calls.includes('/data-atmos/tides/tides.json'));
  }
});

test('tide preflight rejects redirects, missing identity, wrong content type and oversized streams',async()=>{
  for(const change of [
    {url:'https://weatherx.org/data-atmos/tides/tides.json'},
    {headers:new Headers({'content-type':'application/json'})},
    {headers:new Headers({'content-type':'text/html','x-weatherx-release':'r'})},
    {headers:new Headers({'content-type':'application/json','x-weatherx-release':'r','content-length':'999999999'})},
    {body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2*1024*1024+1));controller.close();}})},
    {body:new ReadableStream({start(controller){controller.error(new Error('interrupted body'));}})},
  ]){
    let cancelled=false;
    const body=new ReadableStream({cancel(){cancelled=true;}});
    await assert.rejects(runPreflight({now:NOW,fetchImpl:async url=>new URL(url).pathname==='/data-atmos/tides/tides.json'
      ? {...tideResponse(url),body,...change}:response(url,new URL(url).pathname.split('/').at(-1))}));
    if(!change.body)assert.equal(cancelled,true,'invalid responses must release the stream');
  }
});

test('CLI identifies each failed dependency with bounded diagnostics rather than just a failure count',()=>{
  const preload=`globalThis.fetch=async url=>({url:String(url),status:503,headers:new Headers(),body:null});`;
  const result=spawnSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(preload),
    new URL('../tools/ui-staging-preflight.mjs',import.meta.url).pathname],{
    encoding:'utf8',timeout:5000,env:{...process.env,MODEL_SELECTION_SHA256:'none'},
  });
  assert.equal(result.status,1);
  assert.match(result.stderr,/ecmwf@china-default:.*503/);
  assert.match(result.stderr,/gfs@china-default:.*503/);
  assert.match(result.stderr,/tides.*\/data-atmos\/tides\/tides.json.*503/);
  assert.ok(result.stderr.length<4096);
});

test('diagnostics strip control characters and cap provider error size and count',()=>{
  const error=new AggregateError(Array.from({length:30},()=>new Error('bad\r\t'+ 'x'.repeat(10000)+'\nprivate body')), 'failed');
  const message=formatPreflightFailure(error);
  assert.ok(message.length<4096);assert.equal(message.split('\n').length,13);
  assert.doesNotMatch(message,/private body|[\r\t]/);
});

test('tide probe obeys the shared concurrency budget and reports fetch timeouts',async()=>{
  for(const batchSize of [1,2,4]){
    let active=0,peak=0;const calls=[];
    const receipt=await runPreflight({now:NOW,batchSize,fetchImpl:async url=>{
      active++;peak=Math.max(peak,active);calls.push(new URL(url).pathname);
      await new Promise(resolve=>setImmediate(resolve));active--;
      return response(url,new URL(url).pathname.split('/').at(-1));
    }});
    assert.ok(peak<=batchSize);assert.equal(calls.length,3);assert.equal(receipt.tides.bytes,2);
  }
  await assert.rejects(runPreflight({now:NOW,fetchImpl:async url=>{
    if(new URL(url).pathname==='/data-atmos/tides/tides.json')throw new DOMException('deadline exceeded','TimeoutError');
    return response(url,new URL(url).pathname.split('/').at(-1));
  }}),error=>error.errors.length===1&&/tides.*deadline exceeded/.test(error.errors[0].message));
});
