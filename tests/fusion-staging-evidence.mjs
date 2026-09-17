import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isolatedArchive, isolatedReader, directObservation, collectionSummary, WORKER } from '../tools/fusion-staging-evidence.mjs';
const settings = {bindings: [{type:'r2_bucket',name:'FUSION_ARCHIVE_BUCKET',bucket_name:WORKER},
  ...['FUSION_ISSUANCE_KEY','FUSION_ARCHIVE_READ_KEY'].map(name=>({type:'secret_text',name}))]};
test('archive capability is only the dedicated staging bucket and scoped keys',()=>{
  assert.equal(isolatedArchive(settings,[],'example'),`https://${WORKER}.example.workers.dev`);
  for(const change of [s=>s.bindings[0].bucket_name='weatherx-fusion-archive-production',s=>s.bindings.push({type:'service',name:'PROD'}),s=>s.bindings.pop()]){
    const s=structuredClone(settings);change(s);assert.throws(()=>isolatedArchive(s,[],'example'));
  }
  assert.throws(()=>isolatedArchive(settings,[{script:WORKER}],'example'));
  assert.throws(()=>isolatedArchive(settings,[],'example.evil.test'));
});
test('shared staging reader is rejected; every input bucket is isolated',()=>{
  const reader={bindings:[{type:'r2_bucket',name:'DATA_BUCKET',bucket_name:'weatherx-fusion-evidence-data-staging'},
    {type:'r2_bucket',name:'COMPONENT_BUCKET',bucket_name:'weatherx-fusion-evidence-components-staging'},
    {type:'plain_text',name:'DATA_SOURCE_MODE',text:'own'}]};
  assert.match(isolatedReader(reader,'example'),/^https:\/\/weatherx-fusion-evidence-reader-staging\./);
  for(const change of [s=>s.bindings[0].bucket_name='weatherx-data-production',s=>s.bindings[2].text='shared',s=>s.bindings.push({type:'service',name:'UPSTREAM'})]){
    const s=structuredClone(reader);change(s);assert.throws(()=>isolatedReader(s,'example'));
  }
});
test('NOAA observation access cannot use WeatherX production or staging proxies',()=>{
  assert.equal(directObservation('https://aviationweather.gov/api/data/metar?ids=ZUCK'), 'https://aviationweather.gov/api/data/metar?ids=ZUCK');
  for(const url of ['https://weatherx.org/cdn/awc/api/data/metar','https://staging.weatherx.org/cdn/awc/api/data/metar','https://aviationweather.gov.evil.test/api/data/metar','https://a:b@aviationweather.gov/api/data/metar']) assert.throws(()=>directObservation(url));
});
const observationAcquisitions=Array.from({length:64},(_,index)=>{
  const icao=`K${String(index).padStart(3,'0')}`;
  return {stationId:`M:${icao}`,icao,source:'noaa-aviationweather-metar',requestUrl:`https://aviationweather.gov/api/data/metar?ids=${icao}&hours=48&format=json`,requestedAt:'2026-09-13T00:00:00.000Z',receivedAt:'2026-09-13T00:00:00.025Z',responseBytes:1200,responseSha256:'c'.repeat(64),acceptedTruths:2};
});
const receipt={schemaVersion:1,sourceGitSha:'a'.repeat(40),sourceTreeClean:true,published:true,baselineId:'builtin-v1',networkSha256:'b'.repeat(64),generatedAt:'2026-09-13T00:00:00Z',releaseId:'release-1',verifyRunId:'2026091300',issued:64,failed:0,truthCount:100,observationAcquisitions};
test('receipt never presents partial or missing stations as complete, or unclean/calibrated output as evidence',()=>{
  assert.equal(collectionSummary(receipt,receipt.sourceGitSha).status,'complete');
  assert.equal(collectionSummary({...receipt,issued:63,failed:1},receipt.sourceGitSha).status,'partial');
  for(const change of [{issued:0,failed:64},{issued:1},{sourceTreeClean:false},{published:false},{sourceGitSha:'c'.repeat(40)},{baselineId:'b'.repeat(64)},{observationAcquisitions:observationAcquisitions.slice(1)},{observationAcquisitions:observationAcquisitions.map((value,index)=>index===1?{...value,stationId:'M:K000'}:value)},{observationAcquisitions:observationAcquisitions.map((value,index)=>index===1?{...value,stationId:'station-1'}:value)},{observationAcquisitions:observationAcquisitions.map((value,index)=>index===1?{...value,stationId:'M:K999'}:value)},{observationAcquisitions:observationAcquisitions.map((value,index)=>index===1?{...value,requestUrl:'https://weatherx.org/cdn/awc'}:value)},{observationAcquisitions:observationAcquisitions.map((value,index)=>index===1?{...value,acceptedTruths:0}:value)}]) assert.throws(()=>collectionSummary({...receipt,...change},receipt.sourceGitSha));
});
test('workflow has no production environment, deployment, candidate fit, control key, or accuracy publication',async()=>{
  const text=await readFile(new URL('../.github/workflows/fusion-staging-evidence.yml',import.meta.url),'utf8');
  assert.match(text,/environment: staging/);assert.match(text,/FUSION_CALIBRATION_RUNTIME_ENABLED: 'false'/);
  assert.doesNotMatch(text,/schedule:|FUSION_STAGING_EVIDENCE_ENABLED/);assert.match(text,/--days 7/);assert.match(text,/run-status.json/);assert.match(text,/snapshot.json/);
  assert.match(text,/--origin "\$READ_ORIGIN" --archive-origin "\$ARCHIVE_ORIGIN" --control-origin "\$CONTROL_ORIGIN"/);
  assert.match(text,/steps\.collect\.outcome == 'success' && steps\.receipt\.outcome == 'success'/);
  assert.doesNotMatch(text,/environment: production|FUSION_PROMOTION_KEY|wrangler deploy|cli\.ts (?:promote|build|evaluate|rollback)/);
  assert.ok(text.indexOf("directObservation(canonicalObservationUrl")<text.indexOf('cli.ts collect --publish'));
});
test('a cancelled or unknown phase produces a bounded immutable gap artifact',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const {main}=await import('../tools/fusion-staging-evidence.mjs');
  const directory=await mkdtemp(join(tmpdir(),'fusion-staging-test-'));
  const keys=['GITHUB_RUN_ID','PREFLIGHT_OUTCOME','COLLECT_OUTCOME','RECEIPT_OUTCOME','PULL_OUTCOME','SCORE_OUTCOME'];
  const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  try {
    Object.assign(process.env,{GITHUB_RUN_ID:'123',PREFLIGHT_OUTCOME:'success',COLLECT_OUTCOME:'cancelled',RECEIPT_OUTCOME:'private diagnostic',PULL_OUTCOME:'skipped',SCORE_OUTCOME:'skipped'});
    await main('gap',directory);
    const result=JSON.parse(await readFile(join(directory,'run-status.json'),'utf8'));
    assert.equal(result.status,'gap');assert.equal(result.outcomes.receipt,'unknown');assert.equal(result.outcomes.collect,'cancelled');
    assert.doesNotMatch(JSON.stringify(result),/private diagnostic/);
    await assert.rejects(main('gap',directory),{code:'EEXIST'});
  } finally {
    for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}
    await rm(directory,{recursive:true,force:true});
  }
});
