import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { runProfileCompatibilityPreflight } from '../tools/ui-release-profile-preflight.mjs';
import { POLICY_FILES } from '../tools/ui-release.mjs';
import { ACCOUNT_CORE_REQUEST } from '../tools/ui-staging-models.mjs';

const PIN={catalogId:'stage-wind100-recurring-34657769540-1',runId:'2026091112',selectionSha256:'a'.repeat(64)};
const ENV={MODEL_SELECTION_SHA256:ACCOUNT_CORE_REQUEST,GITHUB_SHA:'b'.repeat(40),GITHUB_RUN_ID:'123',
  STAGING_WIND100_UI_ENABLED:'true',STAGING_WIND100_UI_CATALOG_ID:PIN.catalogId,
  STAGING_WIND100_UI_RUN_ID:PIN.runId,STAGING_WIND100_UI_SELECTION_SHA256:PIN.selectionSha256,
  STAGING_WIND100_UI_DYNAMIC:'true',CLOUDFLARE_API_TOKEN:'must-not-reach-profile-check',
  UI_BUILD_PRIVATE_KEY:'must-not-reach-profile-check',ATMOS_READONLY_KEY:'must-not-reach-profile-check'};

function controller(script) {
  const root=mkdtempSync(resolve(tmpdir(),'wx-ui-profile-controller-'));
  mkdirSync(resolve(root,'ops/release'),{recursive:true});
  writeFileSync(resolve(root,'ops/release/build-release-receipt.mjs'),script);
  return root;
}

const OLD=`
import {writeFileSync} from 'node:fs';
const [first,second]=process.argv.slice(2),verify=first==='--verify',output=verify?process.argv[4]:second;
if(process.env.VITE_STAGING_WIND100_DYNAMIC==='1'||process.env.VITE_STAGING_WIND100_CATALOG_ID.includes('recurring'))throw Error('invalid staging Wind100 release profile');
if(!verify)writeFileSync(output,'{}');
`;
const CURRENT=`
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2),verify=args[0]==='--verify',output=verify?args[2]:args[1];
for(const key of ['CLOUDFLARE_API_TOKEN','UI_BUILD_PRIVATE_KEY','ATMOS_READONLY_KEY','STAGING_WIND100_UI_ENABLED'])if(process.env[key])throw Error('credential or approval leaked');
const wind100={catalogId:process.env.VITE_STAGING_WIND100_CATALOG_ID,runId:process.env.VITE_STAGING_WIND100_RUN_ID,selectionSha256:process.env.VITE_STAGING_WIND100_SELECTION_SHA256};
if(verify){const receipt=JSON.parse(readFileSync(output));receipt.buildProfile.wind100.dynamic=true;writeFileSync(output,JSON.stringify(receipt));}
else writeFileSync(output,JSON.stringify({buildProfile:{product:'lab',platformAccount:'1',platformDataAuth:'public',wind100}}));
`;

test('profile preflight rejects an old controller before build work and removes its fixture',()=>{
  const runnerTemp=mkdtempSync(resolve(tmpdir(),'wx-ui-profile-runner-'));
  assert.throws(()=>runProfileCompatibilityPreflight({controllerRoot:controller(OLD),runnerTemp,env:ENV}),/Command failed/);
  assert.deepEqual(readdirSync(runnerTemp),[]);
});

test('profile preflight creates, verifies, and validates the recurring dynamic receipt with no credentials',()=>{
  assert.ok(POLICY_FILES.includes('tools/ui-release-profile-preflight.mjs'));
  const runnerTemp=mkdtempSync(resolve(tmpdir(),'wx-ui-profile-runner-'));
  const result=runProfileCompatibilityPreflight({controllerRoot:controller(CURRENT),runnerTemp,env:ENV});
  assert.deepEqual(result,{profile:'release-roster-core-account-v1',wind100:{...PIN,dynamic:true}});
  assert.deepEqual(readdirSync(runnerTemp),[]);
});
