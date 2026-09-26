import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  PUBLIC_JOURNEY_AUTH_EVIDENCE,
  PUBLIC_JOURNEY_REQUIRED_STEPS,
  publicJourneyBinding,
  publicJourneyEnvironment,
  requirePublicJourneyBinding,
  validatePublicJourneyProofBytes,
} from '../tools/ui-public-release-journeys.mjs';
import { completedTransactionReceipt, guardTransactionArguments, readGuardSuccessReceipt,
  validateGuardSuccessReceiptBytes } from '../tools/ui-release.mjs';
import { BASELINE_PROFILE, PRODUCTION_ACCOUNT_PROFILE, PUBLIC_LOCALE_BETA_PROFILE,
  PUBLIC_COMBINED_PROFILE } from '../tools/ui-staging-models.mjs';

const sourceSha='a'.repeat(40),releaseId=`git-${'a'.repeat(12)}-run-123`,indexSha256='b'.repeat(64);
const now=Date.parse('2026-09-26T12:30:00.000Z');
function report(stage='staging'){
  const base=stage==='staging'?'https://staging.weatherx.org':'https://weatherx.org';
  const prefix=stage==='staging'?'stage':'prod';
  const journey=viewport=>({viewport,authEvidence:PUBLIC_JOURNEY_AUTH_EVIDENCE,
    mockedAuth:['request-code','verify-code','request-code','verify-code'],blockedWrites:[],pageErrors:[],assetErrors:[],
    steps:[...PUBLIC_JOURNEY_REQUIRED_STEPS],wind:{runId:'2026092612',catalogId:`${prefix}-wind100-recurring-123-1`,
      samples:8,freshUntil:'2026-09-26T14:00:00.000Z',source:'ECMWF IFS 0.25 degree direct open-data GRIB',distinctFromSurface:true}});
  return {startedAt:'2026-09-26T12:00:00.000Z',completedAt:'2026-09-26T12:20:00.000Z',ok:true,base,
    identity:{sourceSha,releaseId,indexSha256,billingUiEnabled:false,introEnabled:true},
    journeys:[journey('desktop'),journey('mobile')]};
}
const encode=value=>Buffer.from(`${JSON.stringify(value)}\n`);

test('controller requires the reviewed account-journey step order',()=>{
  assert.deepEqual(PUBLIC_JOURNEY_REQUIRED_STEPS,[
    'weather-first-paint','welcome-visible','welcome-existing-login','onboarding-place','welcome-to-place',
    'onboarding-purpose','onboarding-place','onboarding-purpose','onboarding-purpose','back-skip-resume',
    'onboarding-see','onboarding-check','onboarding-windows','onboarding-watch','onboarding-complete',
    'onboarding-completed','existing-account-fixture-sign-in','real-native100m-chart',
    'wind-energy-reference-output-chart',
  ]);
});

test('public journey proof binds exact release, onboarding, isolated auth and live Wind100',()=>{
  const proof=validatePublicJourneyProofBytes(encode(report()),{stage:'staging',sourceSha,releaseId},now);
  assert.match(proof.sha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(proof.identity,report().identity);
  const retained=validatePublicJourneyProofBytes(proof.bytes,
    {stage:'staging',sourceSha,releaseId,requireFreshWind:false},Date.parse('2026-09-27T12:00:00Z'));
  assert.equal(retained.sha256,proof.sha256,'weather rotation must not expire retained staging qualification');
  const harnessSha256='c'.repeat(64),candidate={qualification:{...publicJourneyBinding({...proof,harnessSha256})}};
  assert.doesNotThrow(()=>requirePublicJourneyBinding(candidate,{...retained,harnessSha256}));
});

test('public journey proof fails closed on identity, sequence, auth, writes, freshness and scope',()=>{
  const check=mutate=>{const value=report();mutate(value);assert.throws(()=>validatePublicJourneyProofBytes(
    encode(value),{stage:'staging',sourceSha,releaseId},now));};
  check(value=>{value.identity.sourceSha='d'.repeat(40);});
  check(value=>{value.identity.catalogId='rotating-background-catalog';});
  check(value=>{value.journeys[0].steps.splice(4,1);});
  check(value=>{value.journeys[0].mockedAuth=['verify-code','request-code'];});
  check(value=>{value.journeys[0].blockedWrites.push({method:'POST',path:'/api/live'});});
  check(value=>{value.journeys[0].wind.freshUntil='2026-09-26T12:00:00.000Z';});
  check(value=>{value.journeys[0].wind.catalogId='prod-wind100-recurring-123-1';});
});

test('journey invocation environment carries only the exact target identity contract',()=>{
  const outputPath='/tmp/public-release-journeys.json';
  const env=publicJourneyEnvironment({PATH:'/bin',SECRET:'retained-by-browser-environment'},
    {stage:'production',sourceSha,releaseId,outputPath});
  assert.equal(env.BASE,'https://weatherx.org');assert.equal(env.EXPECTED_SOURCE_SHA,sourceSha);
  assert.equal(env.EXPECTED_RELEASE_ID,releaseId);assert.equal(env.OUT,outputPath);
  assert.equal(env.SECRET,undefined);
});

test('guard transaction receipt preserves the exact rollback and candidate deployment IDs',()=>{
  const previous='11111111-1111-1111-1111-111111111111',candidate='22222222-2222-2222-2222-222222222222';
  const armed={schemaVersion:1,stage:'staging',project:'weatherx-platform-staging',status:'armed',
    sourceSha,releaseId,artifactDigest:'d'.repeat(64),expectedPreviousDeploymentId:previous,
    rollbackDeploymentId:previous,candidateDeploymentId:null,capturedAt:'2026-09-26T12:00:00.000Z'};
  const complete=completedTransactionReceipt(armed,candidate,new Date('2026-09-26T12:30:00.000Z'));
  assert.equal(complete.status,'healthy');assert.equal(complete.rollbackDeploymentId,previous);
  assert.equal(complete.candidateDeploymentId,candidate);
  assert.throws(()=>completedTransactionReceipt({...armed,expectedPreviousDeploymentId:candidate},candidate));
  assert.throws(()=>completedTransactionReceipt(armed,previous));
  const release=readFileSync(new URL('../tools/ui-release.mjs',import.meta.url),'utf8');
  assert.match(release,/guardTransactionArguments\(c\.profile,previousDeploymentId,guardSuccessPath\)/);
});

test('only the new combined profile selects the strict guard transaction arguments',()=>{
  const previous='11111111-1111-1111-1111-111111111111',success='/tmp/combined-guard-success.json';
  assert.deepEqual(guardTransactionArguments(PUBLIC_COMBINED_PROFILE,previous,success),[
    '--expected-previous-id',previous,'--success-receipt',success,
  ]);
  for(const legacy of [BASELINE_PROFILE,PRODUCTION_ACCOUNT_PROFILE,PUBLIC_LOCALE_BETA_PROFILE]){
    assert.deepEqual(guardTransactionArguments(legacy,undefined,undefined),[],
      'legacy controller invocation must remain byte-compatible');
    assert.throws(()=>guardTransactionArguments(legacy,previous,success),/legacy UI profiles cannot use/);
  }
  assert.throws(()=>guardTransactionArguments(PUBLIC_COMBINED_PROFILE,undefined,success),/predecessor/);
  assert.throws(()=>guardTransactionArguments(PUBLIC_COMBINED_PROFILE,previous,'relative.json'),/absolute/);
});

test('guard success receipt is exact, candidate-bound and read without following links',()=>{
  const previousDeploymentId='11111111-1111-1111-1111-111111111111';
  const candidateDeploymentId='22222222-2222-2222-2222-222222222222';
  const context={stage:'production',previousDeploymentId,sourceSha,releaseId,indexSha256};
  const receipt={schemaVersion:1,project:'atmos-platform',previousDeploymentId,candidateDeploymentId,
    sourceSha,releaseId,indexSha256};
  const encodeReceipt=value=>Buffer.from(`${JSON.stringify(value)}\n`);
  assert.deepEqual(validateGuardSuccessReceiptBytes(encodeReceipt(receipt),context),receipt);
  const mutate=change=>{const value=structuredClone(receipt);change(value);return encodeReceipt(value);};
  assert.throws(()=>validateGuardSuccessReceiptBytes(mutate(value=>{value.extra=true;}),context),/fields changed/);
  assert.throws(()=>validateGuardSuccessReceiptBytes(mutate(value=>{value.project='weatherx-platform-staging';}),context));
  assert.throws(()=>validateGuardSuccessReceiptBytes(mutate(value=>{value.previousDeploymentId=candidateDeploymentId;}),context));
  assert.throws(()=>validateGuardSuccessReceiptBytes(mutate(value=>{value.candidateDeploymentId=previousDeploymentId;}),context));
  assert.throws(()=>validateGuardSuccessReceiptBytes(mutate(value=>{value.sourceSha='c'.repeat(40);}),context));
  assert.throws(()=>validateGuardSuccessReceiptBytes(mutate(value=>{value.releaseId=`git-${'c'.repeat(12)}-run-123`;}),context));
  assert.throws(()=>validateGuardSuccessReceiptBytes(mutate(value=>{value.indexSha256='c'.repeat(64);}),context));
  assert.throws(()=>validateGuardSuccessReceiptBytes(Buffer.alloc(4097),context),/byte bound/);
  const root=mkdtempSync(resolve(tmpdir(),'wx-ui-guard-success-')),path=resolve(root,'success.json'),link=resolve(root,'link.json');
  try{
    writeFileSync(path,encodeReceipt(receipt),{mode:0o600});
    assert.deepEqual(readGuardSuccessReceipt(path,context),receipt);
    chmodSync(path,0o644);
    assert.throws(()=>readGuardSuccessReceipt(path,context),/bounded regular file/);
    chmodSync(path,0o600);
    symlinkSync(path,link);
    assert.throws(()=>readGuardSuccessReceipt(link,context));
  }finally{rmSync(root,{recursive:true,force:true});}
});
