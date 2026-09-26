import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PUBLIC_COMBINED_REQUEST,PUBLIC_COMBINED_APPROVAL,PUBLIC_COMBINED_ATMOS_SHA,
  PUBLIC_COMBINED_INTRO_SOURCE_SHA256,PUBLIC_COMBINED_ACCOUNT_SOURCES,PUBLIC_COMBINED_SIDECAR,assertPublicCombinedReady,
  PUBLIC_COMBINED_ONBOARDING_SOURCES,
  validateCombinedBuild} from '../tools/ui-public-combined.mjs';
import {PUBLIC_COMBINED_PROFILE,profileFor,validateProfile,publicCombinedProfile,
  publicLocaleBetaProfile,accountServingProductionProfile,requireUiProductionProfile,
  resolveSelectionRequest,requireStagingApproval} from '../tools/ui-staging-models.mjs';
import {PRODUCTION_ACCOUNT_APPROVAL,LANE_B_CONTRACT} from '../tools/production-account-contract.mjs';
import {PUBLIC_LOCALE_BETA_APPROVAL} from '../tools/ui-public-locale-beta.mjs';
import {controlShaFor} from '../tools/ui-candidate.mjs';
import {publicBuildEnvironment,validateWind100BuildReceipt,pipelineDigest,POLICY_FILES} from '../tools/ui-release.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const file=(path,text)=>{const b=Buffer.from(text);return {path,bytes:b.length,sha256:sha(b),base64:b.toString('base64')};};
function fixture(){
  const account=file('assets/account-abc.js','account'),intro=file('assets/intro-xyz.js','intro');
  const info=f=>({path:f.path,bytes:f.bytes,sha256:f.sha256});
  const sidecar={schemaVersion:1,profile:'production-account-billing-v1',
    reviewedSourcesSha256:{...PUBLIC_COMBINED_ACCOUNT_SOURCES},
    accountChunks:[info(account)],billingUiEnabled:false,
    intro:{enabled:true,sourceSha256:PUBLIC_COMBINED_INTRO_SOURCE_SHA256,
      reviewedSourcesSha256:{...PUBLIC_COMBINED_ONBOARDING_SOURCES},chunks:[info(intro)]}};
  const files=[account,intro,file(PUBLIC_COMBINED_SIDECAR,JSON.stringify(sidecar))];
  const receipt={buildProfile:{...LANE_B_CONTRACT.buildReceipt,wind100:'production-native-dynamic-v2',localeBeta:'ru-kk-public-beta-v1'}};
  return {receipt,files,sidecar};
}
test('distinct combined profile requires its exact reviewed source and protected approvals',()=>{
  assert.deepEqual(profileFor(PUBLIC_COMBINED_REQUEST),PUBLIC_COMBINED_PROFILE);
  validateProfile(PUBLIC_COMBINED_PROFILE);
  assert.equal(publicCombinedProfile(PUBLIC_COMBINED_PROFILE),true);
  assert.equal(publicLocaleBetaProfile(PUBLIC_COMBINED_PROFILE),true);
  assert.equal(accountServingProductionProfile(PUBLIC_COMBINED_PROFILE),true);
  assert.equal(PUBLIC_COMBINED_ATMOS_SHA,'9da64b54fadf6efb21302c1504575c75bf5b1d54');
  assert.equal(assertPublicCombinedReady(),PUBLIC_COMBINED_ATMOS_SHA);
  assert.equal(controlShaFor(PUBLIC_COMBINED_PROFILE),PUBLIC_COMBINED_ATMOS_SHA);
  assert.deepEqual(requireUiProductionProfile(PUBLIC_COMBINED_PROFILE),PUBLIC_COMBINED_PROFILE);
  const approvals={approvedPublicLocaleBeta:PUBLIC_LOCALE_BETA_APPROVAL,approvedPublicCombined:PUBLIC_COMBINED_APPROVAL};
  assert.throws(()=>resolveSelectionRequest(PUBLIC_COMBINED_REQUEST,undefined,undefined,undefined,undefined,undefined,undefined,approvals),/protected production account/);
  assert.throws(()=>resolveSelectionRequest(PUBLIC_COMBINED_REQUEST,undefined,undefined,undefined,undefined,undefined,PRODUCTION_ACCOUNT_APPROVAL,{approvedPublicLocaleBeta:PUBLIC_LOCALE_BETA_APPROVAL}),/protected combined/);
  assert.equal(resolveSelectionRequest(PUBLIC_COMBINED_REQUEST,undefined,undefined,undefined,undefined,undefined,PRODUCTION_ACCOUNT_APPROVAL,approvals),PUBLIC_COMBINED_REQUEST);
  assert.throws(()=>requireStagingApproval({profile:PUBLIC_COMBINED_PROFILE},{}));
  assert.ok(POLICY_FILES.includes('tools/ui-public-combined.mjs'));
  assert.ok(POLICY_FILES.includes('docs/ui-public-combined.md'));
  assert.match(pipelineDigest(PUBLIC_COMBINED_PROFILE),/^[a-f0-9]{64}$/);
});
test('combined build flags exclude staging Wind100 and billing UI',()=>{
  const env=publicBuildEnvironment(PUBLIC_COMBINED_PROFILE,null,{VITE_PRO_BILLING:'1',VITE_ACCOUNT_INTRO:'0',VITE_PRODUCTION_WIND100:'0'});
  for(const key of ['ATMOS_PUBLIC_WIND100_RELEASE','VITE_PRODUCTION_WIND100','ATMOS_PUBLIC_LOCALE_BETA_RELEASE','VITE_LOCALE_BETA','VITE_ACCOUNT_INTRO'])assert.equal(env[key],'1');
  for(const key of ['VITE_PRO_BILLING','VITE_PRO_PROTO'])assert.equal(env[key],'0');
  assert.equal(env.VITE_STAGING_WIND100,'');
  assert.equal(validateWind100BuildReceipt(PUBLIC_COMBINED_PROFILE,fixture().receipt,{}),null);
  assert.throws(()=>validateWind100BuildReceipt(PUBLIC_COMBINED_PROFILE,{buildProfile:{wind100:{dynamic:true}}},{}),/production native Wind100/);
});
test('exact sidecar and receipt authenticate intro, account chunks and billing-off',()=>{
  const {receipt,files}=fixture();
  validateCombinedBuild(receipt,files);
  const bad={...receipt,buildProfile:{...receipt.buildProfile,wind100:'staging'}};
  assert.throws(()=>validateCombinedBuild(bad,files),/combined production Lab build receipt/);
  const tamper=(mutate)=>{const f=structuredClone(files),s=JSON.parse(Buffer.from(f[2].base64,'base64'));mutate(s,f);f[2]=file(PUBLIC_COMBINED_SIDECAR,JSON.stringify(s));return f;};
  assert.throws(()=>validateCombinedBuild(receipt,tamper(s=>{s.billingUiEnabled=true;})),/billing UI/);
  assert.throws(()=>validateCombinedBuild(receipt,tamper(s=>{s.intro.enabled=false;})));
  assert.throws(()=>validateCombinedBuild(receipt,tamper(s=>{s.intro.sourceSha256='a'.repeat(64);})),/30a3c65/);
  assert.throws(()=>validateCombinedBuild(receipt,tamper(s=>{s.intro.reviewedSourcesSha256['onboarding\/Icon.tsx']='a'.repeat(64);})),/onboarding sidecar source hashes/);
  assert.throws(()=>validateCombinedBuild(receipt,tamper(s=>{s.intro.chunks=[];})),/one to 64/);
  assert.throws(()=>validateCombinedBuild(receipt,tamper(s=>{s.reviewedSourcesSha256['client.ts']='a'.repeat(64);})),/account sidecar source hashes/);
  assert.throws(()=>validateCombinedBuild(receipt,tamper(s=>{s.intro.chunks[0].path=s.accountChunks[0].path;})),/duplicate production account or intro chunk/);
  assert.throws(()=>validateCombinedBuild(receipt,tamper(s=>{s.intro.chunks[0].sha256='b'.repeat(64);})),/Expected values/);
  assert.throws(()=>validateCombinedBuild(receipt,tamper((s,f)=>{f.splice(1,1);})),/Expected values/);
});
test('protected workflows contain combined choice, exact pins and approval',()=>{
  const staging=readFileSync(new URL('../.github/workflows/ui-staging.yml',import.meta.url),'utf8');
  const release=readFileSync(new URL('../.github/workflows/ui-release.yml',import.meta.url),'utf8');
  assert.match(staging,/APPROVED_PUBLIC_COMBINED: \$\{\{ vars.UI_PUBLIC_COMBINED_PROFILE_APPROVED \}\}/);
  assert.match(staging,/UI_PUBLIC_COMBINED_PROFILE_APPROVED: \$\{\{ vars.UI_PUBLIC_COMBINED_PROFILE_APPROVED \}\}/);
  assert.match(staging,/production-account-ru-kk-wind100-onboarding-v2/);
  assert.match(release,/production-account-ru-kk-wind100-onboarding-v2/);
  for(const workflow of [staging,release])assert.ok(workflow.includes(`production-account-ru-kk-wind100-onboarding-v2' && '${PUBLIC_COMBINED_ATMOS_SHA}'`));
  assert.doesNotMatch(release,/WX_GROUND_QUALIFICATION_SCOPE/);
});
