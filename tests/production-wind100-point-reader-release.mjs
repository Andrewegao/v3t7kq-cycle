import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expectedBindings } from '../tools/consumer-refresh.mjs';
import { releaseConfig, priorConfig, assertPrevious, assertRoutes, assertPoint,
  sameBoundary, wind100Query, recoveryAction } from '../tools/production-wind100-point-reader-release.mjs';

const root=process.env.ATMOS_ROOT ?? process.env.WEATHERX_ATMOS_SOURCE;
test('production reader config enables Wind100 only in serving data Worker',()=>{
  if(!root)return;
  const raw=JSON.parse(readFileSync(resolve(root,'platform/edge/wrangler.data.jsonc')));
  const candidate=releaseConfig(raw);
  assert.equal(candidate.vars.PRODUCTION_WIND100_DYNAMIC_ENABLED,'1');
  for(const [name,env] of Object.entries(raw.env))if(name!=='production-serve')
    assert.equal(env.vars.PRODUCTION_WIND100_DYNAMIC_ENABLED,undefined);
  const prior=priorConfig(candidate,expectedBindings(candidate).filter(x=>x.name!=='PRODUCTION_WIND100_DYNAMIC_ENABLED'));
  assert.equal(prior.vars.PRODUCTION_WIND100_DYNAMIC_ENABLED,undefined);
  const active={...prior,bindings:expectedBindings(prior)};
  assertPrevious(candidate,active,active);
  assert.throws(()=>assertPrevious(candidate,{...active,bindings:expectedBindings(candidate)},active),
    /previous Wind100 flag was not disabled/);
});

test('route scope includes current specific data-edge point route and fences drift',()=>{
  const candidate={routes:[
    {pattern:'weatherx.org/data/*'},
    {pattern:'weatherx.org/data-atmos/*'},
    {pattern:'weatherx.org/api/platform/internal/catalog*'},
    {pattern:'weatherx.org/api/platform/data-health*'},
  ]};
  const routes=[...candidate.routes.map((row,i)=>({id:String(i),script:'weatherx-data-edge-production',pattern:row.pattern})),
    {id:'point',script:'weatherx-data-edge-production',pattern:'weatherx.org/api/v1/point-series/*'},
    {id:'other',script:'another-worker',pattern:'weatherx.org/api/v1/*'}];
  assert.equal(assertRoutes(routes,candidate).length,6);
  assert.throws(()=>assertRoutes(routes.filter(row=>row.id!=='point'),candidate),/route inventory drift/);
  const boundary={routes:assertRoutes(routes,candidate),schedules:{schedules:[]},
    subdomain:{enabled:false},settings:{bindings:[]}};
  sameBoundary(boundary,structuredClone(boundary));
  assert.throws(()=>sameBoundary(boundary,{...boundary,routes:boundary.routes.slice(1)}),/route boundary changed/);
});

test('point proof requires exact base parity and real finite Wind100 samples',()=>{
  const selector={runId:'2026092312',catalogId:'prod-wind100-recurring-35921335025-1',
    selectionSha256:'a'.repeat(64)};
  const base={schemaVersion:1,model:'ecmwf',runId:selector.runId,releaseId:'base-data-catalog',
    quality:'complete',series:{wind_speed:{samples:[
      {validTime:'2026-09-24T00:00:00.000Z',value:1},
      {validTime:'2026-09-24T03:00:00.000Z',value:2},
    ]}}};
  const point={...base,releaseId:selector.catalogId,series:{...base.series,wind_speed_100m:{samples:[
    {validTime:'2026-09-24T00:00:00.000Z',value:2},
    {validTime:'2026-09-24T03:00:00.000Z',value:3},
  ]}}};
  assertPoint(point,selector,base);
  assert.throws(()=>assertPoint({...point,releaseId:base.releaseId},selector,base),
    /Expected values to be strictly equal/);
  assert.equal(wind100Query(selector).get('catalog'),selector.catalogId);
  assert.throws(()=>assertPoint({...point,series:{...point.series,
    wind_speed_100m:{samples:[{validTime:'x',value:Infinity}]}}},selector,base),/Wind100 samples missing/);
  assert.throws(()=>assertPoint({...point,series:{...point.series,
    wind_speed:{samples:[{validTime:'x',value:99}]}}},selector,base),/base wind-speed samples changed/);
  assert.throws(()=>assertPoint({...point,series:{...point.series,
    wind_speed_100m:{samples:[
      {validTime:'2026-09-24T00:00:00.000Z',value:2},
      {validTime:'2026-09-24T06:00:00.000Z',value:3},
    ]}}},selector,base),/sample times differ/);
});

test('rollback may restore only this run\'s candidate',()=>{
  const receipt={previous:'prior',candidate:'owned'};
  assert.equal(recoveryAction('prior',receipt),'already-restored');
  assert.equal(recoveryAction('owned',receipt),'restore-owned-candidate');
  assert.throws(()=>recoveryAction('foreign',receipt),/foreign Worker deployment/);
});
