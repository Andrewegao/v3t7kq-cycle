import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { autoRouteRun, autoRouteSummary, releaseProfileName, RELEASE_PROFILES } from '../tools/ui-release.mjs';
import { profileFor, resolveDispatchSelection, resolveSelectionRequest } from '../tools/ui-staging-models.mjs';
import { REPOSITORY } from '../tools/ui-candidate.mjs';

const SHA='c'.repeat(40), DIGEST='d'.repeat(64);
const env=(change={})=>({GITHUB_EVENT_NAME:'workflow_run',GITHUB_JOB:'resolve',GITHUB_REPOSITORY:REPOSITORY,GITHUB_REF:'refs/heads/main',
  UI_AUTO_PROMOTE_ENABLED:'true',UI_AUTO_PROMOTE_PROFILE:'production-account-ru-kk-wind100-onboarding-v2',
  STAGING_RUN_ID:'555',STAGING_RUN_ATTEMPT:'2',...change});
const run=(change={})=>({id:555,run_attempt:2,repository:{full_name:REPOSITORY},path:'.github/workflows/ui-staging.yml',
  event:'workflow_dispatch',head_branch:'main',status:'completed',conclusion:'success',display_title:`Staging ${SHA}`,...change});
const artifacts=(attempt=2)=>[{name:`ui-build-555-${attempt}`,expired:false,size_in_bytes:10},
  {name:`ui-candidate-555-${attempt}`,expired:false,size_in_bytes:1000},{name:`ui-candidate-summary-555-${attempt}`,expired:false,size_in_bytes:300}];
const summary=(change={})=>Buffer.from(JSON.stringify({sourceSha:SHA,stagingRunId:'555',attempt:'2',artifactDigest:DIGEST,
  deploymentId:'0'.repeat(8)+'-0000-0000-0000-'+'0'.repeat(12),qualifiedAt:'2026-10-05T00:00:00.000Z',
  releaseProfile:'production-account-ru-kk-wind100-onboarding-v2',...change}));

test('release profile names map exactly onto the four promotable profiles',()=>{
  for(const name of RELEASE_PROFILES) assert.equal(releaseProfileName(profileFor(name)),name);
  assert.equal(releaseProfileName(profileFor('a'.repeat(64))),null,'hash-pinned staging experiment is staging-only');
  assert.equal(releaseProfileName({...profileFor('none'),extra:true}),null);
});
test('routes only the exact successful staging attempt with its armed profile',()=>{
  const route=autoRouteRun(env(),run(),artifacts());
  assert.deepEqual(route,{promote:true,id:'555',attempt:'2',sourceSha:SHA,summaryArtifact:'ui-candidate-summary-555-2'});
  assert.deepEqual(autoRouteSummary(route,summary(),env().UI_AUTO_PROMOTE_PROFILE),{promote:true,staging_run_id:'555',
    staging_run_attempt:'2',atmos_sha:SHA,candidate_digest:DIGEST,release_profile:'production-account-ru-kk-wind100-onboarding-v2'});
});
test('a re-run, staging-only profile or different armed profile is skipped, never substituted',()=>{
  assert.equal(autoRouteRun(env(),run({run_attempt:3}),artifacts(3)).promote,false);
  const route=autoRouteRun(env(),run(),artifacts());
  assert.equal(autoRouteSummary(route,summary({releaseProfile:null}),env().UI_AUTO_PROMOTE_PROFILE).promote,false);
  assert.equal(autoRouteSummary(route,summary({releaseProfile:'none'}),env().UI_AUTO_PROMOTE_PROFILE).promote,false);
});
test('unarmed, foreign or malformed routes fail closed',()=>{
  for(const change of [{UI_AUTO_PROMOTE_ENABLED:''},{UI_AUTO_PROMOTE_PROFILE:''},{UI_AUTO_PROMOTE_PROFILE:'a'.repeat(64)},
    {GITHUB_EVENT_NAME:'workflow_dispatch'},{GITHUB_JOB:'promote'},{GITHUB_REF:'refs/heads/x'},{GITHUB_REPOSITORY:'x/y'},
    {STAGING_RUN_ID:''},{STAGING_RUN_ATTEMPT:'0'}])
    assert.throws(()=>autoRouteRun(env(change),run(),artifacts()),JSON.stringify(change));
  for(const change of [{id:556},{repository:{full_name:'x/y'}},{path:'.github/workflows/ui-staging-tc.yml'},{event:'push'},
    {head_branch:'feature'},{status:'in_progress'},{conclusion:'failure'},{display_title:'Staging main'},{display_title:undefined}])
    assert.throws(()=>autoRouteRun(env(),run(change),artifacts()),JSON.stringify(change));
  for(const list of [[],artifacts().slice(0,2),[...artifacts(),artifacts()[2]],artifacts().map(a=>({...a,expired:true})),
    artifacts().map(a=>a.name.includes('summary')?{...a,size_in_bytes:65*1024}:a)])
    assert.throws(()=>autoRouteRun(env(),run(),list));
  const route=autoRouteRun(env(),run(),artifacts());
  for(const change of [{sourceSha:'e'.repeat(40)},{stagingRunId:'554'},{attempt:'1'},{artifactDigest:'x'},{releaseProfile:'release-roster-core-v1'}])
    assert.throws(()=>autoRouteSummary(route,summary(change),env().UI_AUTO_PROMOTE_PROFILE),JSON.stringify(change));
  for(const bytes of [Buffer.alloc(0),Buffer.from('{'),Buffer.alloc(4097,32)]) assert.throws(()=>autoRouteSummary(route,bytes,'none'));
});
test('promotion re-audits the routed attempt and keeps every existing guard',()=>{
  const source=readFileSync(new URL('../tools/ui-release.mjs',import.meta.url),'utf8');
  const records=source.split('async function runRecords()')[1].split('\nasync function auditRun')[0];
  assert.match(records,/if\(process\.env\.STAGING_RUN_ATTEMPT\) assert\.equal\(String\(r\.run_attempt\),process\.env\.STAGING_RUN_ATTEMPT/);
  const download=source.split('async function download()')[1].split('\nif (process.argv[1]')[0];
  assert.match(download,/^ \{\n  releaseGate\(process\.env\); controller\(\);\n/);
  for(const guard of ['requireReleaseProfileBinding(c.profile)','requireUiProductionProfile(c.profile)','await auditRun(c); await exactStaging(c);'])
    assert.ok(download.includes(guard),guard);
  assert.match(source,/releaseProfile:releaseProfileName\(c\.profile\)\};/);
  assert.match(source,/if\(command==='gate'\) \{ releaseGate\(process\.env\); controller\(\);/);
  assert.match(source,/RELEASE_GUARD_VERIFY_REQUIRED_SUCCESSES:'3',RELEASE_GUARD_VERIFY_SLEEP_SECONDS:'15'/);
  const receive=source.split('async function receiveBuild()')[1].split('\nfunction environment(')[0];
  assert.match(receive,/^ \{\n  gate\(process\.env\);controller\(\);assert\.equal\(process\.env\.GITHUB_JOB,'qualify'\)/,'qualify stays manual-only');
  const staging=readFileSync(new URL('../.github/workflows/ui-staging.yml',import.meta.url),'utf8');
  assert.match(staging,/name: ui-candidate-summary-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\n\s+path: \$\{\{ runner\.temp \}\}\/ui-sealed\/summary\.json\n/);
  const release=readFileSync(new URL('../.github/workflows/ui-release.yml',import.meta.url),'utf8');
  for(const line of ["STAGING_RUN_ATTEMPT: ${{ github.event_name == 'workflow_run' && needs.resolve.outputs.staging_run_attempt || '' }}",
    "STAGING_RUN_ID: ${{ github.event.workflow_run.id }}","STAGING_RUN_ATTEMPT: ${{ github.event.workflow_run.run_attempt }}",
    'run: node cycle/tools/ui-release.mjs resolve-auto'])
    assert.ok(release.includes(line),line);
});

test('omitted staging selection qualifies the armed profile, else approved; explicit values unchanged',()=>{
  for(const profile of RELEASE_PROFILES) assert.equal(resolveDispatchSelection('default','true',profile),profile,'armed');
  for(const enabled of [undefined,'','false','TRUE','1']){
    assert.equal(resolveDispatchSelection('default',enabled,'production-account-ru-kk-wind100-onboarding-v2'),'approved',`not armed: ${enabled}`);
    assert.equal(resolveDispatchSelection('default',enabled,'not-a-profile'),'approved');
  }
  for(const explicit of ['approved','none','production-account-billing-v1','release-roster-core-v1','a'.repeat(64),''])
    for(const enabled of ['true','false']) assert.equal(resolveDispatchSelection(explicit,enabled,'none'),explicit,explicit);
  // The resolved value still passes the unchanged protected-approval resolver.
  assert.equal(resolveSelectionRequest(resolveDispatchSelection('default','false','none'),'b'.repeat(64)),'b'.repeat(64));
  assert.equal(resolveSelectionRequest(resolveDispatchSelection('default','true','none'),'b'.repeat(64)),'none');
  assert.throws(()=>resolveSelectionRequest('default','b'.repeat(64)),/invalid staging selection request/,'sentinel never reaches approvals unresolved');
});
test('armed with an unrecognised profile fails closed, never silently approved',()=>{
  for(const bad of [undefined,'','approved','default','release-roster-core-v1','a'.repeat(64),'None',' none'])
    assert.throws(()=>resolveDispatchSelection('default','true',bad),
      /UI_AUTO_PROMOTE_ENABLED is true but UI_AUTO_PROMOTE_PROFILE .* is not one of none, production-account-billing-v1, production-account-ru-kk-beta-v1, production-account-ru-kk-wind100-onboarding-v2; refusing to fall back to approved/,String(bad));
});
test('profile job resolves the sentinel before approvals using only the arming variables',()=>{
  const staging=readFileSync(new URL('../.github/workflows/ui-staging.yml',import.meta.url),'utf8');
  const profile=staging.split('\n  profile:\n')[1].split('\n  build:\n')[0];
  assert.match(staging,/      model_selection_sha256:\n        description: default \(omitted\) qualifies the armed UI_AUTO_PROMOTE_PROFILE[^\n]*\n        required: false\n        default: default\n/);
  assert.match(profile,/UI_AUTO_PROMOTE_ENABLED: \$\{\{ vars\.UI_AUTO_PROMOTE_ENABLED \}\}\n\s+UI_AUTO_PROMOTE_PROFILE: \$\{\{ vars\.UI_AUTO_PROMOTE_PROFILE \}\}/);
  const resolveAt=profile.indexOf('const requested = resolveDispatchSelection(process.env.REQUESTED_SELECTION,process.env.UI_AUTO_PROMOTE_ENABLED,process.env.UI_AUTO_PROMOTE_PROFILE);');
  assert.ok(resolveAt>0&&resolveAt<profile.indexOf('const selection = resolveSelectionRequest(requested,'));
  assert.doesNotMatch(profile,/secrets\./);
});
