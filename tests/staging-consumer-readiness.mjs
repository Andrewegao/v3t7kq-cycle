import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as controller from '../tools/staging-consumer.mjs';

const OLD=controller.OWNED_REUSE.before,NEW=controller.OWNED_REUSE.version;
const legacy={health:{ok:true,authMode:'public',billingMode:'enabled'},dataHealth:{ok:true,authMode:'public',catalogMode:'serve'}};
const ready={health:{ok:true,authMode:'public',billingMode:'disabled'},dataHealth:{ok:true,authMode:'public',catalogMode:'serve',dataSource:'shared',sharedReadConfigured:true,pin:null,
  sharedRead:{dataBucket:'weatherx-data-production',componentBucket:'weatherx-components-production',pinKey:'shared-read/pin.json'}}};
function setup(pairs=[legacy,ready]){
  let time=0,checks=0;const observed=[];
  const baseline={schemaVersion:1,origin:'https://staging.weatherx.org',beforeVersion:OLD,workflowRun:'123',workflowAttempt:'1',...structuredClone(legacy)};
  return {baseline,observed,checks:()=>checks,args:{baseline,beforeVersion:OLD,workflowRun:'123',workflowAttempt:'1',uploaded:NEW,
    checkOwned:async()=>{checks++;return NEW;},readPair:async()=>structuredClone(pairs.length>1?pairs.shift():pairs[0]),
    observe:async value=>observed.push(value),now:()=>time,sleep:async ms=>{time+=ms;},timeoutMs:75_000,intervalMs:5_000}};
}
test('readiness admits only exact observed old pair until desired runtime, with fresh ownership each round',async()=>{
  const f=setup();await controller.activationReadiness(f.args);
  assert.equal(f.checks(),4);assert.deepEqual(f.observed.map(r=>r.state),['pending-legacy','ready']);
  assert.deepEqual(f.observed.map(r=>r.elapsedMs),[0,5000]);assert.ok(f.observed.every(r=>r.version===NEW));
});
test('legacy baseline is exact, bound to current run/attempt/version, not a reusable old receipt',async()=>{
  for(const mutate of [b=>b.workflowRun='122',b=>b.workflowAttempt='2',b=>b.beforeVersion=NEW,
    b=>b.health.billingMode='disabled',b=>b.dataHealth.extra='SECRET',b=>b.extra=true]){
    const f=setup();mutate(f.baseline);await assert.rejects(controller.activationReadiness(f.args));assert.equal(f.checks(),0);
  }
});
test('perpetual old response reaches deadline and existing guarded transaction restores',async()=>{
  const f=setup([legacy]);let current=OLD,rollback=0,saved;
  await assert.rejects(controller.guardedRepair({before:{version:OLD,state:{}},desired:{},upload:async()=>NEW,
    snapshot:async()=>({version:current,state:{}}),activate:async()=>{current=NEW;},getVersion:async()=>current,
    verify:async()=>controller.activationReadiness(f.args),rollback:async()=>{rollback++;current=OLD;},persist:async r=>{saved=structuredClone(r);}}),/readiness deadline/);
  assert.equal(current,OLD);assert.equal(rollback,1);assert.equal(saved.status,'failed-restored');assert.equal(f.observed.length,15);
});
test('foreign ownership, HTTP failure, unknown or mixed runtime pair fails immediately',async()=>{
  const unknown=structuredClone(legacy);unknown.health.billingMode='unexpected-SECRET';
  for(const override of [{checkOwned:async()=>OLD},{readPair:async()=>{throw Error('HTTP503');}},
    {readPair:async()=>unknown},{readPair:async()=>({health:ready.health,dataHealth:legacy.dataHealth})}]){
    const f=setup();await assert.rejects(controller.activationReadiness({...f.args,...override}));assert.equal(f.observed.length,0);
  }
});
test('late response cannot qualify beyond the deadline or overwrite ownership between probes',async()=>{
  const f=setup([ready]);let calls=0;
  await assert.rejects(controller.activationReadiness({...f.args,checkOwned:async()=>++calls===1?NEW:OLD}));
  const g=setup([ready]);let time=0;
  await assert.rejects(controller.activationReadiness({...g.args,now:()=>time,readPair:async()=>{time=75001;return ready;}}),/readiness deadline/);
  assert.equal(g.observed.length,0);
});
test('readiness never bypasses a subsequent scientific verification failure',async()=>{
  const f=setup([ready]);let current=OLD,rollback=0;
  await assert.rejects(controller.guardedRepair({before:{version:OLD,state:{}},desired:{},upload:async()=>NEW,
    snapshot:async()=>({version:current,state:{}}),activate:async()=>{current=NEW;},getVersion:async()=>current,
    verify:async()=>{await controller.activationReadiness(f.args);throw Error('map point run mismatch');},
    rollback:async()=>{rollback++;current=OLD;},persist:async()=>{}}),/map point run mismatch/);
  assert.equal(current,OLD);assert.equal(rollback,1);
});
test('readiness observations contain only fixed bounded fields, not raw bodies',async()=>{
  const f=setup([ready]);await controller.activationReadiness(f.args);
  assert.deepEqual(Object.keys(f.observed[0]).sort(),['attempt','billingMode','catalogMode','dataSource','elapsedMs','phase','sharedReadConfigured','state','version'].sort());
});
test('readiness deadline also bounds a never-settling health request',async()=>{
  const f=setup();const started=performance.now();
  await assert.rejects(controller.activationReadiness({...f.args,now:()=>performance.now(),timeoutMs:20,
    readPair:async()=>new Promise(()=>{})}),/readiness deadline/);
  assert.ok(performance.now()-started<1000);assert.equal(f.observed.length,0);
});
test('captured baseline cannot be changed by asynchronous observation callbacks',async()=>{
  const f=setup([legacy]);
  await assert.rejects(controller.activationReadiness({...f.args,readPair:async()=>{
    f.baseline.health.billingMode='unexpected';return structuredClone({health:f.baseline.health,dataHealth:f.baseline.dataHealth});
  }}),/unexpected activation health/);
  assert.equal(f.observed.length,0);
});
test('readiness receipt persistence failure still restores and retains only sanitized markers',async()=>{
  const f=setup([ready]);let current=OLD,rollback=0,saved;
  await assert.rejects(controller.guardedRepair({before:{version:OLD,state:{}},desired:{},upload:async()=>NEW,
    snapshot:async()=>({version:current,state:{}}),activate:async()=>{current=NEW;},getVersion:async()=>current,
    verify:async observe=>controller.activationReadiness({...f.args,observe}),rollback:async()=>{rollback++;current=OLD;},
    persist:async r=>{saved=structuredClone(r);if(r.readiness?.length&&r.status!=='failed-restored')throw Error('private disk detail');}}),/private disk detail/);
  assert.equal(current,OLD);assert.equal(rollback,1);assert.equal(saved.status,'failed-restored');
  assert.equal(saved.readiness.length,1);assert.equal(saved.readiness[0].state,'ready');
  assert.ok(!JSON.stringify(saved).includes('private disk detail'));assert.equal(saved.failure.phase,'receipt-persist');
});
test('workflow runs readiness regression and existing full forecast rounds remain mandatory',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/staging-consumer-refresh.yml',import.meta.url),'utf8');
  const source=readFileSync(new URL('../tools/staging-consumer.mjs',import.meta.url),'utf8');
  assert.match(workflow,/tests\/staging-consumer-readiness\.mjs/);
  assert.match(source,/for\(let n=0;n<3;n\+\+\).*verifySharedForecast/);
  assert.match(source,/activationBaseline=\{[\s\S]*readReadinessPair[\s\S]*staging changed during baseline health capture/);
  assert.match(source,/if\(reuse\)await activationReadiness/);
});
