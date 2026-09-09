import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ACCOUNT_CORE_REQUEST as REQUEST, ACCOUNT_APPROVAL as APPROVAL, ACCOUNT_CORE_PROFILE as PROFILE,
  CORE_RELEASE_REQUEST, CORE_RELEASE_PROFILE, BASELINE_PROFILE, STATIC_COMPRESSION_PROFILE,
  profileFor, validateProfile, requireProductionProfile, resolveSelectionRequest, requireStagingApproval,
  staticCompressionProfile, coreReleaseProfile} from '../tools/ui-staging-models.mjs';
import {publicBuildEnvironment,validatePublicModes} from '../tools/ui-release.mjs';

test('account profile is exact, opt-in, standard compression, core roster and never promotable',()=>{
  assert.deepEqual(PROFILE,{...CORE_RELEASE_PROFILE,account:true,stagingAccount:APPROVAL});
  assert.equal(profileFor(REQUEST),PROFILE);
  assert.equal(coreReleaseProfile(PROFILE),true);
  assert.equal(staticCompressionProfile(PROFILE),false);
  assert.equal(profileFor('none'),BASELINE_PROFILE);
  assert.throws(()=>requireProductionProfile(PROFILE));
  for(const change of [{account:false},{stagingOnly:false},{data:true},{stagingAccount:'other'},
    {staticCompression:'static-br11-v1'},{modelSelectionSha256:'a'.repeat(64)},{extra:true}])
    assert.throws(()=>validateProfile({...PROFILE,...change}));
  assert.throws(()=>validateProfile({...CORE_RELEASE_PROFILE,account:true}));
});
test('request and authenticated candidate both need independent protected approvals',()=>{
  assert.equal(resolveSelectionRequest(REQUEST,undefined,CORE_RELEASE_REQUEST,undefined,APPROVAL),REQUEST);
  for(const invalid of [undefined,'','true',REQUEST]){
    assert.throws(()=>resolveSelectionRequest(REQUEST,undefined,CORE_RELEASE_REQUEST,undefined,invalid));
    assert.throws(()=>resolveSelectionRequest(REQUEST,undefined,invalid,undefined,APPROVAL));
  }
  const env={MODEL_SELECTION_SHA256:REQUEST,UI_STAGING_CORE_PROFILE_APPROVED:CORE_RELEASE_REQUEST,
    UI_STAGING_ACCOUNT_PROFILE_APPROVED:APPROVAL};
  const c={profile:PROFILE,files:[]};
  assert.equal(requireStagingApproval(c,env),null);
  for(const key of ['UI_STAGING_CORE_PROFILE_APPROVED','UI_STAGING_ACCOUNT_PROFILE_APPROVED'])
    assert.throws(()=>requireStagingApproval(c,{...env,[key]:''}));
  assert.throws(()=>requireStagingApproval(c,{...env,MODEL_SELECTION_SHA256:CORE_RELEASE_REQUEST}));
  assert.throws(()=>requireStagingApproval({profile:CORE_RELEASE_PROFILE,files:[]},env));
  assert.throws(()=>requireStagingApproval({...c,files:[{path:'assets/staging-model-selection.json'}]},env));
  assert.equal(resolveSelectionRequest('none',undefined,CORE_RELEASE_REQUEST,undefined,APPROVAL),'none');
  assert.equal(resolveSelectionRequest(undefined,'b'.repeat(64),CORE_RELEASE_REQUEST,undefined,APPROVAL),'b'.repeat(64));
});
test('profile overrides conflicting caller flags but never expands the old profiles',()=>{
  const env=publicBuildEnvironment(PROFILE,null,{VITE_PLATFORM_ACCOUNT:'0',VITE_PLATFORM_DATA_AUTH:'enforce'});
  assert.equal(env.VITE_PLATFORM_ACCOUNT,'1');assert.equal(env.VITE_PLATFORM_DATA_AUTH,'public');
  assert.equal(env.ATMOS_STATIC_COMPRESSION_PROFILE,'');assert.equal(env.ATMOS_PUBLIC_RELEASE,'0');
  for(const p of [BASELINE_PROFILE,CORE_RELEASE_PROFILE,STATIC_COMPRESSION_PROFILE])
    assert.equal(publicBuildEnvironment(p,null,{VITE_PLATFORM_ACCOUNT:'1'}).VITE_PLATFORM_ACCOUNT,'0');
});
test('only the exact staging account profile accepts the existing enabled backend',()=>{
  const staging='https://staging.weatherx.org',production='https://weatherx.org';
  const data={ok:true,catalogMode:'serve',authMode:'public'};
  const health={ok:true,authMode:'public',billingMode:'enabled'};
  validatePublicModes(staging,health,data,PROFILE);
  for(const p of [BASELINE_PROFILE,CORE_RELEASE_PROFILE,STATIC_COMPRESSION_PROFILE])
    assert.throws(()=>validatePublicModes(staging,health,data,p));
  for(const change of [{ok:false},{authMode:'enforce'},{authMode:'observe'},{billingMode:'disabled'},{billingMode:'unknown'}])
    assert.throws(()=>validatePublicModes(staging,{...health,...change},data,PROFILE));
  for(const change of [{ok:false},{authMode:'enforce'},{catalogMode:'disabled'}])
    assert.throws(()=>validatePublicModes(staging,health,{...data,...change},PROFILE));
  assert.throws(()=>validatePublicModes(production,{...health,authMode:'observe'},data,PROFILE));
  assert.throws(()=>validatePublicModes(production,{...health,authMode:'observe'},data));
  validatePublicModes(production,{...health,authMode:'observe',billingMode:'disabled'},data);
});
test('workflow carries protected account approval without enabling or altering production',()=>{
  const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
  const staging=read('.github/workflows/ui-staging.yml'),prod=read('.github/workflows/ui-release.yml');
  assert.match(staging,/APPROVED_ACCOUNT_PROFILE: \$\{\{ vars\.UI_STAGING_ACCOUNT_PROFILE_APPROVED \}\}/);
  assert.match(staging,/UI_STAGING_ACCOUNT_PROFILE_APPROVED: \$\{\{ vars\.UI_STAGING_ACCOUNT_PROFILE_APPROVED \}\}/);
  assert.match(staging,/default: approved/);
  assert.doesNotMatch(prod,/staging-account-v1|release-roster-core-account-v1|UI_STAGING_ACCOUNT_PROFILE_APPROVED/);
  assert.match(read('tools/ui-release.mjs'),/publicModes\(ORIGINS\[stage\],c\.profile\)/);
  assert.match(read('tools/ui-release.mjs'),/publicModes\(ORIGINS\.staging,c\.profile\)/);
});
test('mode compatibility is checked before upload, not relaxed during rollback',()=>{
  const source=readFileSync(new URL('../tools/ui-release.mjs',import.meta.url),'utf8');
  const preflight=source.slice(source.indexOf('async function preflight(stage)'),source.indexOf('export function requiredSourceGuard'));
  const deploy=source.slice(source.indexOf('async function deploy(stage)'),source.indexOf('async function verify(stage)'));
  const verify=source.slice(source.indexOf('async function verify(stage)'),source.indexOf('function retain()'));
  assert.match(preflight,/requireStagingApproval\(c,process\.env\)/);
  assert.match(preflight,/await publicModes\(ORIGINS\[stage\],c\.profile\)/);
  assert.ok(deploy.indexOf('await preflight(stage)')<deploy.indexOf('guard-pages-deploy.sh'));
  assert.doesNotMatch(preflight,/catch\s*\(/);
  assert.match(verify,/await publicModes\(ORIGINS\[stage\],c\.profile\)/);
});
