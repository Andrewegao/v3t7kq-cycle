import test from 'node:test';
import assert from 'node:assert/strict';
import {linkSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ACCOUNT_CORE_REQUEST as REQUEST, ACCOUNT_APPROVAL as APPROVAL, ACCOUNT_CORE_PROFILE as PROFILE,
  CORE_RELEASE_REQUEST, CORE_RELEASE_PROFILE, BASELINE_PROFILE, STATIC_COMPRESSION_PROFILE,
  profileFor, validateProfile, requireProductionProfile, resolveSelectionRequest, requireStagingApproval,
  staticCompressionProfile, coreReleaseProfile} from '../tools/ui-staging-models.mjs';
import {publicBuildEnvironment,publicModes,requiredSourceGuard,validatePublicModes} from '../tools/ui-release.mjs';
import {CONTROL_SHA,STAGING_CONTROL_SHA,controlShaFor} from '../tools/ui-candidate.mjs';
import {ACCOUNT_PROOF_MAX_BYTES,ACCOUNT_QUALIFICATION_TIMEOUT_MS,accountQualificationBinding,
  accountQualificationEnvironment,accountQualificationRequired,readAccountProofBytes,
  requireAccountQualificationBinding,validateAccountProofBytes} from '../tools/ui-staging-account-proof.mjs';

const NOW=Date.parse('2026-09-08T20:00:00.000Z'),SOURCE='a'.repeat(40),RELEASE='git-aaaaaaaaaaaa-run-123';
const HARNESS='b'.repeat(64);
const STAGING='https://staging.weatherx.org',CATALOG='284-065408ff-7e71-46aa-bdf4-57d3558901d7';
const HEALTH={ok:true,authMode:'public',billingMode:'enabled'};
const DATA={ok:true,catalogMode:'serve',authMode:'public',dataSource:'shared',sharedReadConfigured:true,pin:null,
  catalog:{status:'available',catalogId:CATALOG,nativeViewport:{ecmwf:true,gfs:true}}};
function proof(overrides={}){
  return {schemaVersion:1,startedAt:'2026-09-08T19:58:00.000Z',completedAt:'2026-09-08T19:59:00.000Z',ok:true,
    harnessSha256:HARNESS,failures:[],configuration:{expectedIdentity:{candidateSourceSha:SOURCE,candidateReleaseId:RELEASE}},
    releaseProfiles:{candidate:{sourceSha:SOURCE,releaseId:RELEASE}},privateDiagnostics:'SECRET must not be retained',...overrides};
}
function strictReceiptValidator(receipt,expected){
  assert.equal(expected.candidateSourceSha,SOURCE);assert.equal(expected.candidateReleaseId,RELEASE);
  assert.equal(expected.candidateOrigin,'https://staging.weatherx.org');assert.equal(expected.harnessSha256,HARNESS);
  assert.deepEqual(expected.profiles,['normal','slow']);assert.equal(expected.repeats,2);assert.equal(expected.minLifecycleCycles,30);
  assert.equal(receipt.configuration.expectedIdentity.candidateSourceSha,expected.candidateSourceSha);
  assert.equal(receipt.configuration.expectedIdentity.candidateReleaseId,expected.candidateReleaseId);
  assert.equal(receipt.releaseProfiles.candidate.sourceSha,expected.candidateSourceSha);
  assert.equal(receipt.releaseProfiles.candidate.releaseId,expected.candidateReleaseId);
}

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
  assert.equal(requiredSourceGuard(PROFILE),STAGING_CONTROL_SHA);
  assert.equal(controlShaFor(BASELINE_PROFILE),CONTROL_SHA);
  assert.equal(controlShaFor(PROFILE),STAGING_CONTROL_SHA);
  for(const request of [CORE_RELEASE_REQUEST,'release-roster-core-br11-v1',REQUEST,'a'.repeat(64)])
    assert.equal(controlShaFor(profileFor(request)),STAGING_CONTROL_SHA);
  assert.equal(requiredSourceGuard(BASELINE_PROFILE),null);
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
  assert.equal(env.ATMOS_STAGING_ACCOUNT_PROFILE,APPROVAL);
  assert.equal(env.ATMOS_STATIC_COMPRESSION_PROFILE,'');assert.equal(env.ATMOS_PUBLIC_RELEASE,'0');
  for(const p of [BASELINE_PROFILE,CORE_RELEASE_PROFILE,STATIC_COMPRESSION_PROFILE]) {
    const off=publicBuildEnvironment(p,null,{VITE_PLATFORM_ACCOUNT:'1',ATMOS_STAGING_ACCOUNT_PROFILE:APPROVAL});
    assert.equal(off.VITE_PLATFORM_ACCOUNT,'0');
    assert.equal(off.ATMOS_STAGING_ACCOUNT_PROFILE,'');
  }
});
test('only the exact staging account profile accepts the existing enabled backend',()=>{
  const production='https://weatherx.org';
  validatePublicModes(STAGING,HEALTH,DATA,PROFILE);
  for(const p of [BASELINE_PROFILE,CORE_RELEASE_PROFILE,STATIC_COMPRESSION_PROFILE])
    assert.throws(()=>validatePublicModes(STAGING,HEALTH,DATA,p));
  for(const change of [{ok:false},{authMode:'enforce'},{authMode:'observe'},{billingMode:'disabled'},{billingMode:'unknown'}])
    assert.throws(()=>validatePublicModes(STAGING,{...HEALTH,...change},DATA,PROFILE));
  for(const change of [{ok:false},{authMode:'enforce'},{catalogMode:'disabled'}])
    assert.throws(()=>validatePublicModes(STAGING,HEALTH,{...DATA,...change},PROFILE));
  for(const change of [{dataSource:'own'},{sharedReadConfigured:false}])
    assert.throws(()=>validatePublicModes(STAGING,HEALTH,{...DATA,...change},PROFILE));
  for(const catalog of [undefined,null,{},
    {...DATA.catalog,status:'unavailable'},
    {...DATA.catalog,catalogId:null},
    {...DATA.catalog,catalogId:'../current'},
    {...DATA.catalog,nativeViewport:{ecmwf:false,gfs:true}},
    {...DATA.catalog,nativeViewport:{ecmwf:true,gfs:false}},
  ])assert.throws(()=>validatePublicModes(STAGING,HEALTH,{...DATA,catalog},PROFILE));
  assert.throws(()=>validatePublicModes(production,{...HEALTH,authMode:'observe'},DATA,PROFILE));
  assert.throws(()=>validatePublicModes(production,{...HEALTH,authMode:'observe'},DATA));
  // Production deliberately retains the older health contract without the staging projection.
  validatePublicModes(production,{...HEALTH,authMode:'observe',billingMode:'disabled'},
    {ok:true,catalogMode:'serve',authMode:'public'});
});
function stagingModeFetch(indexChange={}){
  const paths=[];
  const fetcher=async input=>{
    const url=new URL(String(input));paths.push(url.pathname);
    if(url.pathname==='/api/platform/health')return Response.json(HEALTH);
    if(url.pathname==='/api/platform/data-health')return Response.json(DATA);
    const match=new RegExp(`^/data/_catalog/${CATALOG}/(ecmwf|gfs)/index\\.json$`).exec(url.pathname);
    if(match){
      const model=match[1],change=indexChange[model]??indexChange;
      const headers={'Content-Type':'application/json','X-WeatherX-Catalog':CATALOG,
        'X-WeatherX-Data-Source':'shared',...(change.headers??{})};
      if(change.removeHeader)delete headers[change.removeHeader];
      return new Response(JSON.stringify(change.body??{schemaVersion:1,model,
        runs:[{init_time:'2026-09-08T12:00:00Z',path:'runs/2026090812/'}]}),{status:change.status??200,headers});
    }
    if(url.pathname==='/data/ledger/index.json')return Response.json({},
      {headers:{'X-WeatherX-Release':'release-a'}});
    return new Response('missing',{status:404});
  };
  return {fetcher,paths};
}
test('staging public-mode proof binds both model indexes to the attested immutable catalog',async t=>{
  const {fetcher,paths}=stagingModeFetch();t.mock.method(globalThis,'fetch',fetcher);
  await publicModes(STAGING,PROFILE);
  assert.deepEqual(paths,[
    '/api/platform/health','/api/platform/data-health',
    `/data/_catalog/${CATALOG}/ecmwf/index.json`,
    `/data/_catalog/${CATALOG}/gfs/index.json`,
    '/data/ledger/index.json',
  ]);
});
test('staging immutable model proof rejects source, authority and body mismatches',async t=>{
  const cases={
    'missing catalog identity':{removeHeader:'X-WeatherX-Catalog'},
    'different catalog identity':{headers:{'X-WeatherX-Catalog':'other'}},
    'release authority':{headers:{'X-WeatherX-Release':'release-a'}},
    'non-shared source':{headers:{'X-WeatherX-Data-Source':'own'}},
    'wrong MIME':{headers:{'Content-Type':'text/html'}},
    'wrong schema':{body:{schemaVersion:2,model:'ecmwf',runs:[{init_time:'2026-09-08T12:00:00Z',path:'runs/2026090812/'}]}},
    'wrong model':{body:{schemaVersion:1,model:'gfs',runs:[{init_time:'2026-09-08T12:00:00Z',path:'runs/2026090812/'}]}},
    'missing runs':{body:{schemaVersion:1,model:'ecmwf',runs:[]}},
    'malformed run':{body:{schemaVersion:1,model:'ecmwf',runs:[{init_time:'not-a-time',path:'runs/latest/'}]}},
    'mismatched run identity':{body:{schemaVersion:1,model:'ecmwf',runs:[{init_time:'2026-09-08T12:00:00Z',path:'runs/2026090818/'}]}},
  };
  for(const [name,change] of Object.entries(cases))await t.test(name,async t=>{
    const {fetcher,paths}=stagingModeFetch({ecmwf:change});t.mock.method(globalThis,'fetch',fetcher);
    await assert.rejects(publicModes(STAGING,PROFILE));
    assert.deepEqual(paths,[
      '/api/platform/health','/api/platform/data-health',
      `/data/_catalog/${CATALOG}/ecmwf/index.json`,
    ]);
  });
  await t.test('same identity guard covers the second model',async t=>{
    const {fetcher,paths}=stagingModeFetch({gfs:{headers:{'X-WeatherX-Catalog':'other'}}});
    t.mock.method(globalThis,'fetch',fetcher);
    await assert.rejects(publicModes(STAGING,PROFILE));
    assert.deepEqual(paths,[
      '/api/platform/health','/api/platform/data-health',
      `/data/_catalog/${CATALOG}/ecmwf/index.json`,
      `/data/_catalog/${CATALOG}/gfs/index.json`,
    ]);
  });
});
test('production public-mode proof retains its previous health shape and mutable core probe',async t=>{
  const production='https://weatherx.org',paths=[];
  t.mock.method(globalThis,'fetch',async input=>{
    const url=new URL(String(input));paths.push(url.pathname);
    if(url.pathname==='/api/platform/health')return Response.json({ok:true,authMode:'observe',billingMode:'disabled'});
    if(url.pathname==='/api/platform/data-health')return Response.json({ok:true,authMode:'public',catalogMode:'serve'});
    if(url.pathname==='/data/gfs/index.json')return Response.json({runs:[]},
      {headers:{'X-WeatherX-Catalog':'production-current'}});
    if(url.pathname==='/data/ledger/index.json')return Response.json({},
      {headers:{'X-WeatherX-Release':'release-a'}});
    return new Response('missing',{status:404});
  });
  await publicModes(production,BASELINE_PROFILE);
  assert.deepEqual(paths,[
    '/api/platform/health','/api/platform/data-health','/data/gfs/index.json','/data/ledger/index.json',
  ]);
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
test('account browser qualification is candidate-staging-only and receives no credentials',()=>{
  for(const [stage,phase,profile,required] of [
    ['staging','candidate',PROFILE,true],['staging','rollback',PROFILE,false],
    ['production','candidate',PROFILE,false],['staging','candidate',CORE_RELEASE_PROFILE,false],
  ])assert.equal(accountQualificationRequired(stage,phase,profile),required);
  const env=accountQualificationEnvironment({PATH:'/bin',HOME:'/tmp/home',RUNNER_TEMP:'/tmp/runner',LANG:'C',
    GITHUB_TOKEN:'SECRET-gh',CLOUDFLARE_API_TOKEN:'SECRET-cf',UI_CANDIDATE_KEY:'SECRET-ui',
    ATMOS_DEPLOY_KEY:'SECRET-atmos',MODEL_INPUT_ARCHIVE_KEY:'SECRET-model'},
  {sourceSha:SOURCE,releaseId:RELEASE,outputPath:'/tmp/runner/proof.json'});
  assert.deepEqual({...env},{PATH:'/bin',HOME:'/tmp/home',RUNNER_TEMP:'/tmp/runner',LANG:'C',
    BASE:'https://staging.weatherx.org',EXPECTED_SOURCE_SHA:SOURCE,EXPECTED_RELEASE_ID:RELEASE,
    OUT:'/tmp/runner/proof.json',QUALIFICATION_PROFILES:'normal,slow',REPEATS:'2',LIFECYCLE_CYCLES:'30',
    WEATHER_TIMEOUT_MS:'90000',MAX_WEATHER_ABORTS:'20',WEATHER_EVIDENCE:'live staging read-only transport'});
  assert.equal(ACCOUNT_QUALIFICATION_TIMEOUT_MS,15*60*1000);
});
test('account proof is bounded, fresh, identity-bound, harness-bound and sanitized',()=>{
  const accepted=validateAccountProofBytes(Buffer.from(JSON.stringify(proof())),
    {sourceSha:SOURCE,releaseId:RELEASE,harnessSha256:HARNESS},strictReceiptValidator,NOW);
  assert.match(accepted.sha256,/^[a-f0-9]{64}$/);assert.equal(accepted.harnessSha256,HARNESS);
  assert.doesNotMatch(accepted.bytes.toString(),/SECRET|privateDiagnostics/);
  assert.throws(()=>validateAccountProofBytes(Buffer.alloc(ACCOUNT_PROOF_MAX_BYTES+1),
    {sourceSha:SOURCE,releaseId:RELEASE,harnessSha256:HARNESS},strictReceiptValidator,NOW));
  const stale=proof({startedAt:'2026-09-08T19:38:00.000Z',completedAt:'2026-09-08T19:40:00.000Z'});
  assert.throws(()=>validateAccountProofBytes(Buffer.from(JSON.stringify(stale)),
    {sourceSha:SOURCE,releaseId:RELEASE,harnessSha256:HARNESS},strictReceiptValidator,NOW));
  assert.doesNotThrow(()=>validateAccountProofBytes(Buffer.from(JSON.stringify(stale)),
    {sourceSha:SOURCE,releaseId:RELEASE,harnessSha256:HARNESS,requireFresh:false},strictReceiptValidator,NOW));
  for(const invalid of [
    proof({startedAt:'2026-09-08T19:30:00.000Z'}),
    proof({completedAt:'2026-09-08T20:02:00.000Z'}),
    proof({harnessSha256:'c'.repeat(64)}),
  ])assert.throws(()=>validateAccountProofBytes(Buffer.from(JSON.stringify(invalid)),
    {sourceSha:SOURCE,releaseId:RELEASE,harnessSha256:HARNESS},strictReceiptValidator,NOW));
  const wrongIdentity=proof();wrongIdentity.releaseProfiles.candidate.releaseId='other';
  assert.throws(()=>validateAccountProofBytes(Buffer.from(JSON.stringify(wrongIdentity)),
    {sourceSha:SOURCE,releaseId:RELEASE,harnessSha256:HARNESS},strictReceiptValidator,NOW));
});
test('missing proof and proof changes cannot satisfy the candidate binding',()=>{
  const directory=mkdtempSync(join(tmpdir(),'weatherx-account-proof-'));
  try{
    assert.throws(()=>readAccountProofBytes(join(directory,'missing.json')));
    const path=join(directory,'proof.json');writeFileSync(path,JSON.stringify(proof()),{mode:0o600});
    assert.doesNotThrow(()=>readAccountProofBytes(path));
    const symbolic=join(directory,'symbolic.json');symlinkSync(path,symbolic);
    assert.throws(()=>readAccountProofBytes(symbolic));
    const hard=join(directory,'hard.json');linkSync(path,hard);
    assert.throws(()=>readAccountProofBytes(path));
    rmSync(hard);
    writeFileSync(join(directory,'at-limit.json'),Buffer.alloc(ACCOUNT_PROOF_MAX_BYTES,0x20),{mode:0o600});
    assert.equal(readAccountProofBytes(join(directory,'at-limit.json')).length,ACCOUNT_PROOF_MAX_BYTES);
    writeFileSync(join(directory,'oversize.json'),Buffer.alloc(ACCOUNT_PROOF_MAX_BYTES+1),{mode:0o600});
    assert.throws(()=>readAccountProofBytes(join(directory,'oversize.json')));
    const accepted=validateAccountProofBytes(readAccountProofBytes(path),
      {sourceSha:SOURCE,releaseId:RELEASE,harnessSha256:HARNESS},strictReceiptValidator,NOW);
    const candidate={profile:PROFILE,qualification:{...accountQualificationBinding({profile:PROFILE},accepted)}};
    assert.doesNotThrow(()=>requireAccountQualificationBinding(candidate,accepted));
    assert.throws(()=>requireAccountQualificationBinding(candidate,{...accepted,sha256:'d'.repeat(64)}));
    assert.throws(()=>requireAccountQualificationBinding({...candidate,qualification:{}},accepted));
  }finally{rmSync(directory,{recursive:true,force:true});}
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
  assert.match(verify,/accountQualificationRequired\(stage,phase,c\.profile\)/);
  assert.match(verify,/await runAccountQualification\(/);
  assert.ok(verify.indexOf("if \(phase !== 'rollback'\)")<verify.indexOf('await runAccountQualification('));
  assert.match(deploy,/await readAccountProof\(/);
  assert.match(deploy,/accountQualificationBinding\(c,accountProof\)/);
  assert.match(source,/async function retain\(\)/);
  assert.match(source,/requireAccountQualificationBinding\(c,accountProof\)/);
  assert.match(source,/account-qualification\.json/);
});
