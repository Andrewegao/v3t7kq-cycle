import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {PUBLIC_LOCALE_BETA_REQUEST,PUBLIC_LOCALE_BETA_APPROVAL,PUBLIC_LOCALE_BETA_ATMOS_SHA,
  PUBLIC_LOCALE_BETA_RECEIPT,assertPublicLocaleBetaReady} from '../tools/ui-public-locale-beta.mjs';
import {PUBLIC_LOCALE_BETA_PROFILE,PRODUCTION_ACCOUNT_PROFILE,profileFor,validateProfile,
  productionAccountProfile,publicLocaleBetaProfile,accountServingProductionProfile,requireProductionProfile,
  requireUiProductionProfile,resolveSelectionRequest,requireStagingApproval} from '../tools/ui-staging-models.mjs';
import {PRODUCTION_ACCOUNT_APPROVAL,LANE_B_CONTRACT} from '../tools/production-account-contract.mjs';
import {controlShaFor} from '../tools/ui-candidate.mjs';
import {publicBuildEnvironment,validatePublicModes,pipelineDigest,POLICY_FILES} from '../tools/ui-release.mjs';

test('public RU/KK beta is an exact separate UI-only account profile',()=>{
  assert.deepEqual(profileFor(PUBLIC_LOCALE_BETA_REQUEST),PUBLIC_LOCALE_BETA_PROFILE);
  validateProfile(PUBLIC_LOCALE_BETA_PROFILE);
  assert.equal(productionAccountProfile(PRODUCTION_ACCOUNT_PROFILE),true);
  assert.equal(productionAccountProfile(PUBLIC_LOCALE_BETA_PROFILE),false);
  assert.equal(publicLocaleBetaProfile(PUBLIC_LOCALE_BETA_PROFILE),true);
  assert.equal(accountServingProductionProfile(PUBLIC_LOCALE_BETA_PROFILE),true);
  assert.throws(()=>requireProductionProfile(PUBLIC_LOCALE_BETA_PROFILE),/cannot enter production/);
  assert.equal(PUBLIC_LOCALE_BETA_RECEIPT,'ru-kk-public-beta-v1');
  assert.ok(POLICY_FILES.includes('tools/ui-public-locale-beta.mjs'));
  assert.ok(POLICY_FILES.includes('docs/ui-public-locale-beta.md'));
  assert.notEqual(pipelineDigest(PUBLIC_LOCALE_BETA_PROFILE),pipelineDigest(PRODUCTION_ACCOUNT_PROFILE));
});

test('unreviewed source SHA and absent protected approvals fail closed',()=>{
  assert.equal(PUBLIC_LOCALE_BETA_ATMOS_SHA,'0'.repeat(40));
  assert.throws(()=>assertPublicLocaleBetaReady(),/exact reviewed Atmos/);
  assert.throws(()=>controlShaFor(PUBLIC_LOCALE_BETA_PROFILE),/exact reviewed Atmos/);
  assert.throws(()=>requireUiProductionProfile(PUBLIC_LOCALE_BETA_PROFILE),/exact reviewed Atmos/);
  assert.throws(()=>resolveSelectionRequest(PUBLIC_LOCALE_BETA_REQUEST,undefined,undefined,undefined,undefined,undefined,
    PRODUCTION_ACCOUNT_APPROVAL),/protected public RU\/KK beta/);
  assert.throws(()=>resolveSelectionRequest(PUBLIC_LOCALE_BETA_REQUEST,undefined,undefined,undefined,undefined,undefined,
    undefined,{approvedPublicLocaleBeta:PUBLIC_LOCALE_BETA_APPROVAL}),/protected production account/);
  assert.throws(()=>resolveSelectionRequest(PUBLIC_LOCALE_BETA_REQUEST,undefined,undefined,undefined,undefined,undefined,
    PRODUCTION_ACCOUNT_APPROVAL,{approvedPublicLocaleBeta:PUBLIC_LOCALE_BETA_APPROVAL}),/exact reviewed Atmos/);
  assert.throws(()=>requireStagingApproval({profile:PUBLIC_LOCALE_BETA_PROFILE},{}));
});

test('beta build keeps production account and disables staging-only UI',()=>{
  const env=publicBuildEnvironment(PUBLIC_LOCALE_BETA_PROFILE,null,{
    VITE_PRO_PROTO:'1',VITE_PRO_BILLING:'1',VITE_LOCALE_BETA:'0',VITE_STAGING_WIND100:'1',
    ATMOS_STAGING_LOCALE_BETA_RELEASE:'1',ATMOS_PRODUCTION_ACCOUNT_PROFILE:'wrong',
  });
  assert.equal(env.ATMOS_PUBLIC_RELEASE,'1');
  assert.equal(env.ATMOS_PRODUCTION_ACCOUNT_PROFILE,PRODUCTION_ACCOUNT_APPROVAL);
  assert.equal(env.ATMOS_PUBLIC_LOCALE_BETA_RELEASE,'1');
  assert.equal(env.VITE_LOCALE_BETA,'1');
  assert.equal(env.VITE_PLATFORM_ACCOUNT,'1');
  assert.equal(env.VITE_PLATFORM_DATA_AUTH,'public');
  assert.equal(env.VITE_PRO_PROTO,'0');
  assert.equal(env.VITE_PRO_BILLING,'0');
  assert.equal(env.VITE_STAGING_WIND100,'');
  assert.equal(env.ATMOS_STAGING_LOCALE_BETA_RELEASE,'0');
  const old=publicBuildEnvironment(PRODUCTION_ACCOUNT_PROFILE,null,{});
  assert.equal(old.ATMOS_PUBLIC_LOCALE_BETA_RELEASE,'0');
  assert.equal(old.VITE_LOCALE_BETA,'0');
  assert.deepEqual({...LANE_B_CONTRACT.buildReceipt,localeBeta:PUBLIC_LOCALE_BETA_RECEIPT},
    {product:'lab',platformAccount:'1',platformDataAuth:'public',accountRelease:'production-account-billing-v1',localeBeta:'ru-kk-public-beta-v1'});
  const staging=readFileSync(new URL('../.github/workflows/ui-staging.yml',import.meta.url),'utf8');
  const production=readFileSync(new URL('../.github/workflows/ui-release.yml',import.meta.url),'utf8');
  assert.match(staging,/WX_GROUND_QUALIFICATION_SCOPE: staging-qualification-only/);
  assert.match(staging,/name: full application test gate\n\s+env:\n\s+WX_CI_PROFILE: \$\{\{ .*production-account-ru-kk-beta-v1'.*'public-beta-ci-lab-road-security-v1' \|\| '' \}\}\n\s+run: npm test --prefix atmos\/app/);
  assert.doesNotMatch(production,/WX_GROUND_QUALIFICATION_SCOPE/);
  assert.match(production,/production-account-ru-kk-beta-v1/);
  assert.doesNotMatch(production,/VITE_PRO_PROTO|WIND100/);
});

test('production health still requires purchase creation closed',()=>{
  const health={ok:true,authMode:'observe',billingMode:'enabled',billingPurchaseMode:'closed'};
  const data={ok:true,authMode:'public',catalogMode:'serve'};
  // This check becomes reachable once the reviewed SHA replaces the fail-closed placeholder.
  assert.throws(()=>validatePublicModes('https://weatherx.org',health,data,PUBLIC_LOCALE_BETA_PROFILE),/exact reviewed Atmos/);
  assert.equal(health.billingPurchaseMode,LANE_B_CONTRACT.modes.billingPurchaseMode);
});
