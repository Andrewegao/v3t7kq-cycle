// Read-only discovery of the exact currently published production snapshot that may be
// reused by the isolated staging data lane. This command has no staging or production
// write credential and never collects, processes, publishes, activates, or deploys.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createTransport,hash,validateCatalog,validateRelease} from './shared-data.mjs';

const REPOSITORY='Andrewegao/v3t7kq-cycle';
const VALIDATOR_SHA='dbc97a26bc239398ffa9ec157a094148961b6451';

export function gate(env){
  assert.equal(env.GITHUB_ACTIONS,'true','selection is cloud-only');
  assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY,REPOSITORY);
  assert.equal(env.GITHUB_EVENT_NAME,'workflow_dispatch');
  assert.equal(env.GITHUB_REF,'refs/heads/main');
  for(const key of ['STAGING_R2_WRITE_ACCESS_KEY_ID','STAGING_R2_WRITE_SECRET_ACCESS_KEY','CLOUDFLARE_API_TOKEN','STAGING_WORKER_API_TOKEN'])
    assert.ok(!env[key],`read-only selector refuses ${key}`);
}

export async function discoverCurrentSelection(io,validatePoints,now=Date.now()){
  const releaseRaw=io.get('data','releases/current.json'),release=JSON.parse(releaseRaw);
  const catalogPointerRaw=io.get('data','catalogs/current.json'),catalogPointer=JSON.parse(catalogPointerRaw);
  const pin={releaseId:release.releaseId,releaseManifestSha256:release.manifestSha256,
    catalogId:catalogPointer.catalogId,catalogSha256:catalogPointer.catalogSha256};
  const manifestRaw=io.get('data',`releases/${pin.releaseId}/manifest.json`),manifest=JSON.parse(manifestRaw);
  const catalogRaw=io.get('data',`catalogs/snapshots/${pin.catalogId}.json`);
  validateRelease(release,manifest,pin,now);
  await validatePoints(manifest.pointSeries,manifest.objects);
  validateCatalog(catalogPointer,catalogRaw,pin,now);
  return {schemaVersion:1,kind:'weatherx-current-staging-source-selection',selection:pin,
    selectionSha256:hash(JSON.stringify(pin)),releasePublishedAt:release.publishedAt,
    catalogPublishedAt:catalogPointer.publishedAt,objectCount:manifest.objectCount,
    discoveredAt:new Date(now).toISOString(),collected:false,processed:false,activated:false,
    stagingWritten:false,productionWritten:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    gate(process.env);
    const control=resolve(process.env.GITHUB_WORKSPACE,'control');
    assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:control,encoding:'utf8'}).trim(),VALIDATOR_SHA);
    execFileSync('git',['diff','--exit-code','HEAD'],{cwd:control,stdio:'pipe'});
    const {validatePointSeriesDescriptor}=await import(pathToFileURL(resolve(control,'ops/platform/validate-point-series.mjs')));
    const io=createTransport(process.env,execFileSync,event=>console.log(JSON.stringify(event)));
    const receipt=await discoverCurrentSelection(io,validatePointSeriesDescriptor,Date.now());
    const output=resolve(process.env.RUNNER_TEMP,'staging-current-selection');
    mkdirSync(output,{recursive:true,mode:0o700});
    writeFileSync(resolve(output,'selection.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify(receipt));
  }catch(error){console.error(`Current staging source selection refused: ${error.message}`);process.exitCode=1;}
}
