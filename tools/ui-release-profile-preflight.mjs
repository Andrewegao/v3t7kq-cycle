#!/usr/bin/env node
// Exercise the actual pinned receipt controller against the protected build profile
// before dependency installation or candidate compilation can consume runner time.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { receiptVerificationEnvironment, validateWind100BuildReceipt } from './ui-release.mjs';
import { profileFor } from './ui-staging-models.mjs';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const CONTROL=resolve(ROOT,'../control');
const MAX_RECEIPT_BYTES=64*1024;
const RECEIPT_ENV_KEYS=[
  'ATMOS_PUBLIC_RELEASE','ATMOS_STAGING_EXPERIMENT_RELEASE','ATMOS_STAGING_RELEASE_ROSTER',
  'ATMOS_STAGING_ACCOUNT_PROFILE','VITE_PRODUCT','VITE_APP','VITE_PLATFORM_ACCOUNT',
  'VITE_PLATFORM_DATA_AUTH','VITE_STAGING_WIND100','VITE_STAGING_WIND100_DYNAMIC',
  'VITE_STAGING_WIND100_CATALOG_ID','VITE_STAGING_WIND100_RUN_ID',
  'VITE_STAGING_WIND100_SELECTION_SHA256',
];

function childEnvironment(env,profile) {
  const values=receiptVerificationEnvironment(profile,env),child={};
  for(const key of RECEIPT_ENV_KEYS)child[key]=values[key]??'';
  for(const key of ['PATH','HOME','TMPDIR','GITHUB_SHA','GITHUB_RUN_ID'])
    if(typeof env[key]==='string'&&env[key]!=='' )child[key]=env[key];
  return child;
}

export function runProfileCompatibilityPreflight({controllerRoot=CONTROL,runnerTemp,env=process.env}={}) {
  assert.ok(typeof runnerTemp==='string'&&runnerTemp!=='','RUNNER_TEMP is required');
  const tempRoot=realpathSync(runnerTemp),script=resolve(controllerRoot,'ops/release/build-release-receipt.mjs');
  const scriptStat=lstatSync(script);
  assert.ok(scriptStat.isFile()&&!scriptStat.isSymbolicLink(),'pinned receipt controller must be a regular file');
  const work=mkdtempSync(join(tempRoot,'ui-release-profile-'));
  try {
    const dist=resolve(work,'dist'),output=resolve(dist,'health/release.json');
    mkdirSync(resolve(dist,'health'),{recursive:true,mode:0o700});
    writeFileSync(resolve(dist,'index.html'),'<title>WeatherX profile preflight</title>\n',{flag:'wx',mode:0o600});
    const profile=profileFor(env.MODEL_SELECTION_SHA256),subprocessEnv=childEnvironment(env,profile);
    const options={env:subprocessEnv,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10_000,maxBuffer:MAX_RECEIPT_BYTES};
    execFileSync(process.execPath,[script,dist,output],options);
    execFileSync(process.execPath,[script,'--verify',dist,output],options);
    const stat=lstatSync(output);
    assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=MAX_RECEIPT_BYTES,
      'pinned receipt controller emitted an invalid receipt');
    const receipt=JSON.parse(readFileSync(output,'utf8'));
    const wind100=validateWind100BuildReceipt(profile,receipt,env);
    return {profile:env.MODEL_SELECTION_SHA256??'none',wind100:wind100??null};
  } finally {
    rmSync(work,{recursive:true,force:true});
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try { process.stdout.write(`${JSON.stringify(runProfileCompatibilityPreflight({runnerTemp:process.env.RUNNER_TEMP}))}\n`); }
  catch(error){ console.error(`UI release profile preflight refused: ${error.message}`); process.exitCode=1; }
}
