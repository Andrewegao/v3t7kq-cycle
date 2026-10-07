import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appTestReceipt, verifyAppTestReceipt, receiptForEnvironment, appTestEvidence, appTestEvidenceFromEnvironment,
  boundedJson, selectAtmosCiRun, requireAtmosVerdict, atmosCiEvidence, decideEvidence,
  APP_TEST_STEP, EVIDENCE_STEP, EVIDENCE_JOB, LOCAL_GATE_STEP, ATMOS_API_MAX_BYTES,
  localGateCommands, ciProfileFor, requireAppTestQualification, BETA_CI_PROFILE, FULL_CI_PROFILE } from '../tools/ui-app-test-receipt.mjs';
import { profileFor } from '../tools/ui-staging-models.mjs';

const SHA='a'.repeat(40);
const FULL={path:'full-local'}, CI={path:'atmos-ci',runId:'987',attempt:'2'};
const context=(evidence=FULL)=>({sourceSha:SHA,workflowSha:'b'.repeat(40),runId:'123',attempt:'2',
  selection:'production-account-ru-kk-wind100-onboarding-v2',evidence});
const ciContext=()=>({...context(CI),selection:'none'});
const step=(name,conclusion='success')=>({name,status:'completed',conclusion});
const job=(path='full-local')=>({name:'app-tests',head_sha:'b'.repeat(40),run_id:123,run_attempt:2,status:'completed',conclusion:'success',
  steps:[step(LOCAL_GATE_STEP,path==='full-local'?'skipped':'success'),step(APP_TEST_STEP,path==='full-local'?'success':'skipped')]});
const evidenceJob=(change={})=>({name:EVIDENCE_JOB,head_sha:'b'.repeat(40),run_id:123,run_attempt:2,status:'completed',conclusion:'success',
  steps:[step(EVIDENCE_STEP)],...change});
const jobs=(path='full-local')=>[evidenceJob(),job(path)];
const raw=(c=context())=>JSON.stringify(appTestReceipt(c));
const env=(extra={})=>({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',UI_BUILDS_ENABLED:'true',
  GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_JOB:'app-tests',
  ATMOS_SHA:SHA,GITHUB_SHA:'b'.repeat(40),GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2',
  MODEL_SELECTION_SHA256:context().selection,WX_CI_PROFILE:'public-beta-ci-lab-road-security-v1',
  UI_APP_TEST_EVIDENCE_PATH:'full-local',UI_APP_TEST_ATMOS_RUN_ID:'',UI_APP_TEST_ATMOS_RUN_ATTEMPT:'',...extra});

test('receipt binds exact source/profile/workflow/run/attempt and the evidence path',()=>{
  assert.deepEqual(verifyAppTestReceipt(raw(),jobs(),context()),appTestReceipt(context()));
  assert.deepEqual(receiptForEnvironment(env(),SHA,'b'.repeat(40)),appTestReceipt(context()));
  for(const selection of ['none','production-account-billing-v1','production-account-ru-kk-beta-v1',context().selection]){
    const c={...context(),selection}; const receipt=appTestReceipt(c);
    assert.deepEqual(verifyAppTestReceipt(JSON.stringify(receipt),jobs(),c),receipt);
    assert.equal(receipt.ciProfile,selection.includes('ru-kk')?'public-beta-ci-lab-road-security-v1':'');
    assert.deepEqual(receipt.evidence,{path:'full-local',commands:['npm test --prefix atmos/app']});
  }
  const ci=appTestReceipt(ciContext());
  assert.equal(ci.schemaVersion,2);
  assert.deepEqual(ci.evidence,{path:'atmos-ci',repository:'weatherx-hq/atmos',workflow:'.github/workflows/ci.yml',
    job:'ci-verdict',runId:'987',attempt:'2',gatesCiProfile:'full-ci-lab-road-security-v3',
    commands:['npm run gates --prefix atmos/app','npm run test:certify --prefix atmos/app','npx playwright test']});
  // The gates profile follows the selection, never the token: RU/KK selections use public-beta
  // (after the manifest check) on both paths; every other selection uses the full profile.
  assert.equal(BETA_CI_PROFILE,'public-beta-ci-lab-road-security-v1'); assert.equal(FULL_CI_PROFILE,'full-ci-lab-road-security-v3');
  assert.deepEqual(localGateCommands(BETA_CI_PROFILE),['git -C atmos ls-files --error-unmatch ops/release/public-beta-ci-manifest.json',
    'npm run gates --prefix atmos/app','npm run test:certify --prefix atmos/app','npx playwright test']);
  assert.throws(()=>localGateCommands('full-ci-lab-road-security-v3'));
  const beta=appTestReceipt(context(CI));
  assert.equal(beta.ciProfile,BETA_CI_PROFILE); assert.equal(beta.evidence.gatesCiProfile,BETA_CI_PROFILE);
  assert.deepEqual(beta.evidence.commands,localGateCommands(BETA_CI_PROFILE));
  assert.deepEqual(receiptForEnvironment(env({UI_APP_TEST_EVIDENCE_PATH:'atmos-ci',UI_APP_TEST_ATMOS_RUN_ID:'987',UI_APP_TEST_ATMOS_RUN_ATTEMPT:'2'}),SHA,'b'.repeat(40)),beta);
  assert.equal(appTestReceipt(context(FULL)).ciProfile,beta.ciProfile,'same selection, same gates profile on both paths');
  // A receipt claiming another gates profile (or none) is not the evidence this run produced.
  for(const gatesCiProfile of ['public-beta-ci-lab-road-security-v1','',undefined]){
    const forged={...ci,evidence:{...ci.evidence,gatesCiProfile}};
    assert.throws(()=>verifyAppTestReceipt(JSON.stringify(forged),jobs('atmos-ci'),ciContext()));
  }
  assert.deepEqual(verifyAppTestReceipt(JSON.stringify(ci),jobs('atmos-ci'),ciContext()),ci);
  assert.deepEqual(receiptForEnvironment(env({MODEL_SELECTION_SHA256:'none',WX_CI_PROFILE:'',UI_APP_TEST_EVIDENCE_PATH:'atmos-ci',
    UI_APP_TEST_ATMOS_RUN_ID:'987',UI_APP_TEST_ATMOS_RUN_ATTEMPT:'2'}),SHA,'b'.repeat(40)),ci);
  // The largest profile still fits the bounded receipt.
  assert.ok(Buffer.byteLength(raw())<=4096);
});
test('evidence fields are exact',()=>{
  for(const bad of [{},{path:'cached'},{path:'atmos-ci'},{path:'atmos-ci',runId:'0',attempt:'1'},{path:'atmos-ci',runId:'1',attempt:'x'},
    {path:'full-local',runId:'1',attempt:'1'}]) assert.throws(()=>appTestEvidence(bad),JSON.stringify(bad));
  assert.deepEqual(appTestEvidenceFromEnvironment({UI_APP_TEST_EVIDENCE_PATH:'full-local',UI_APP_TEST_ATMOS_RUN_ID:'',UI_APP_TEST_ATMOS_RUN_ATTEMPT:''}),
    {path:'full-local',commands:['npm test --prefix atmos/app']});
  assert.throws(()=>appTestEvidenceFromEnvironment({}));
});
test('missing, malformed, oversized or expanded receipts fail closed',()=>{
  for(const value of [undefined,'','null','{','x'.repeat(4097),JSON.stringify({...appTestReceipt(context()),extra:true})])
    assert.throws(()=>verifyAppTestReceipt(value,jobs(),context()));
  for(const field of Object.keys(appTestReceipt(context()))){
    const r=appTestReceipt(context()); delete r[field];
    assert.throws(()=>verifyAppTestReceipt(JSON.stringify(r),jobs(),context()),field);
  }
});
test('receipts cannot be reused across source, profile, workflow, run, retry or evidence path',()=>{
  for(const change of [{sourceSha:'c'.repeat(40)},{workflowSha:'c'.repeat(40)},{runId:'124'},{attempt:'3'},{selection:'none'}])
    assert.throws(()=>verifyAppTestReceipt(raw(),jobs(),{...context(),...change}));
  const r=appTestReceipt(context()); r.evidence.commands=['npm run test:fast --prefix atmos/app'];
  assert.throws(()=>verifyAppTestReceipt(JSON.stringify(r),jobs(),context()));
  // A retained prior-attempt output cannot pass even if a jobs listing reports a current attempt.
  assert.throws(()=>verifyAppTestReceipt(JSON.stringify(appTestReceipt({...context(),attempt:'1'})),jobs(),context()));
  // A candidate-reachable receipt claiming Atmos evidence fails against the untampered job outputs, and vice versa.
  const claimed=JSON.stringify(appTestReceipt(ciContext()));
  assert.throws(()=>verifyAppTestReceipt(claimed,jobs('atmos-ci'),{...ciContext(),evidence:FULL}));
  assert.throws(()=>verifyAppTestReceipt(claimed,jobs('atmos-ci'),{...ciContext(),evidence:{...CI,runId:'988'}}));
  assert.throws(()=>verifyAppTestReceipt(claimed,jobs('atmos-ci'),{...ciContext(),evidence:{...CI,attempt:'1'}}));
});
test('GitHub must independently report the evidence job and the selected gate succeeded',()=>{
  for(const list of [[],[job()],[evidenceJob()],[evidenceJob(),job(),job()],[evidenceJob(),evidenceJob(),job()]])
    assert.throws(()=>verifyAppTestReceipt(raw(),list,context()),JSON.stringify(list.map(j=>j.name)));
  for(const change of [{conclusion:'failure'},{conclusion:'cancelled'},{conclusion:'skipped'},{status:'in_progress'},
    {head_sha:'c'.repeat(40)},{run_id:124},{run_attempt:1},{steps:[]},{steps:undefined},
    {steps:[...job().steps,...job().steps]},
    {steps:[step(APP_TEST_STEP,'skipped')]},
    {steps:[{name:APP_TEST_STEP,status:'in_progress',conclusion:null}]},
    {steps:[step(LOCAL_GATE_STEP)]}])
    assert.throws(()=>verifyAppTestReceipt(raw(),[evidenceJob(),{...job(),...change}],context()),JSON.stringify(change));
  for(const change of [{conclusion:'failure'},{conclusion:'skipped'},{status:'in_progress'},{head_sha:'c'.repeat(40)},
    {run_id:124},{run_attempt:1},{steps:[]},{steps:[step(EVIDENCE_STEP,'failure')]},{steps:[step(EVIDENCE_STEP),step(EVIDENCE_STEP)]},
    {name:'app-tests'}])
    assert.throws(()=>verifyAppTestReceipt(raw(),[evidenceJob(change),job()],context()),JSON.stringify(change));
  // The evidence step inside a candidate job is not evidence.
  assert.throws(()=>verifyAppTestReceipt(raw(),[{...job(),steps:[step(EVIDENCE_STEP),...job().steps]}],context()));
  const ci=JSON.stringify(appTestReceipt(ciContext()));
  // On the atmos-ci path a successful full gate is not a substitute for the local certification gate.
  for(const steps of [[step(APP_TEST_STEP)],[step(LOCAL_GATE_STEP,'failure')],[step(LOCAL_GATE_STEP,'skipped')],[]])
    assert.throws(()=>verifyAppTestReceipt(ci,[evidenceJob(),{...job('atmos-ci'),steps}],ciContext()),JSON.stringify(steps));
});
test('receipt producer rejects wrong checkout, runner, activation, CI profile and evidence outputs',()=>{
  for(const field of Object.keys(env()).filter(k=>!k.startsWith('UI_APP_TEST_ATMOS')))
    assert.throws(()=>receiptForEnvironment({...env(),[field]:''},SHA,'b'.repeat(40)),field);
  assert.throws(()=>receiptForEnvironment(env(),'c'.repeat(40),'b'.repeat(40)));
  assert.throws(()=>receiptForEnvironment(env(),SHA,'c'.repeat(40)));
  assert.throws(()=>receiptForEnvironment({...env(),WX_CI_PROFILE:'full'},SHA,'b'.repeat(40)));
  // The job-level CI profile must match the selection on the atmos-ci path too.
  assert.throws(()=>receiptForEnvironment(env({WX_CI_PROFILE:'',UI_APP_TEST_EVIDENCE_PATH:'atmos-ci',UI_APP_TEST_ATMOS_RUN_ID:'1',UI_APP_TEST_ATMOS_RUN_ATTEMPT:'1'}),SHA,'b'.repeat(40)),/profile differs/);
  assert.throws(()=>receiptForEnvironment(env({MODEL_SELECTION_SHA256:'none',WX_CI_PROFILE:'',UI_APP_TEST_EVIDENCE_PATH:'atmos-ci'}),SHA,'b'.repeat(40)));
});

// ---- Atmos CI evidence: fixtures for the read-only API decision ----
const atmos={full_name:'weatherx-hq/atmos'};
const ciRun=(change={})=>({id:987,run_attempt:2,head_sha:SHA,path:'.github/workflows/ci.yml',repository:atmos,head_repository:atmos,
  event:'push',head_branch:'master',status:'completed',conclusion:'success',...change});
const listing=(...runs)=>({total_count:runs.length,workflow_runs:runs});
const verdict=(change={})=>({name:'ci-verdict',status:'completed',conclusion:'success',head_sha:SHA,run_id:987,run_attempt:2,...change});
const jobsListing=(...jobs)=>({total_count:jobs.length,jobs});
function response(body,{status=200,headers={},redirected=false,type='basic',chunks}={}){
  const bytes=Buffer.from(typeof body==='string'?body:JSON.stringify(body));
  return {status,redirected,type,headers:new Headers(headers),
    body:(async function*(){ for(const c of chunks??[bytes]) yield c; })()};
}
const fetcherFor=(...bodies)=>{const calls=[];const f=async(url,init)=>{calls.push({url,init});const b=bodies.shift();return typeof b==='function'?b():response(b);};f.calls=calls;return f;};

test('success: exact master push ci run whose ci-verdict job succeeded',async()=>{
  assert.deepEqual(selectAtmosCiRun(listing(ciRun()),SHA),{runId:'987',attempt:'2'});
  const f=fetcherFor(listing(ciRun()),jobsListing({name:'app',status:'completed',conclusion:'success'},verdict()));
  assert.deepEqual(await atmosCiEvidence(SHA,'tok',{fetcher:f}),{path:'atmos-ci',runId:'987',attempt:'2'});
  assert.equal(f.calls[0].url,`https://api.github.com/repos/weatherx-hq/atmos/actions/workflows/ci.yml/runs?head_sha=${SHA}&event=push&branch=master&exclude_pull_requests=true&per_page=20`);
  assert.equal(f.calls[1].url,'https://api.github.com/repos/weatherx-hq/atmos/actions/runs/987/attempts/2/jobs?per_page=100');
  for(const call of f.calls){
    assert.equal(call.init.redirect,'error'); assert.equal(call.init.headers.Authorization,'Bearer tok');
    assert.ok(!call.url.includes('tok'),'token never in the URL');
  }
  // The newest run decides; an older success never outvotes a newer failure.
  assert.deepEqual(selectAtmosCiRun(listing(ciRun({id:5,conclusion:'failure'}),ciRun()),SHA),{runId:'987',attempt:'2'});
  assert.throws(()=>selectAtmosCiRun(listing(ciRun(),ciRun({id:988,conclusion:'failure'})),SHA),/did not succeed/);
});
test('wrong sha, other workflow, fork, PR or branch runs are refused',()=>{
  for(const change of [{head_sha:'c'.repeat(40)},{path:'.github/workflows/ci-fast.yml'},{repository:{full_name:'x/atmos'}},
    {head_repository:{full_name:'fork/atmos'}},{event:'pull_request'},{event:'workflow_dispatch'},{head_branch:'feature'},
    {run_attempt:0},{id:-1}])
    assert.throws(()=>selectAtmosCiRun(listing(ciRun(change)),SHA),JSON.stringify(change));
  assert.throws(()=>selectAtmosCiRun(listing(),SHA),/no Atmos ci run/);
  assert.throws(()=>selectAtmosCiRun({total_count:2,workflow_runs:[ciRun()]},SHA),/incomplete/);
  assert.throws(()=>selectAtmosCiRun({total_count:21,workflow_runs:[]},SHA),/bound/);
  assert.throws(()=>selectAtmosCiRun(listing(ciRun(),ciRun()),SHA),/run id/);
  assert.throws(()=>selectAtmosCiRun(listing(ciRun()),'not-a-sha'));
  assert.throws(()=>requireAtmosVerdict(jobsListing(verdict({head_sha:'c'.repeat(40)})),SHA,{runId:'987',attempt:'2'}),/different source/);
});
test('in-progress or failed runs and verdicts are refused',()=>{
  for(const change of [{status:'in_progress',conclusion:null},{status:'queued',conclusion:null},{conclusion:'failure'},
    {conclusion:'cancelled'},{conclusion:'skipped'},{conclusion:'neutral'}])
    assert.throws(()=>selectAtmosCiRun(listing(ciRun(change)),SHA),JSON.stringify(change));
  const run={runId:'987',attempt:'2'};
  for(const jobs of [jobsListing(),jobsListing(verdict(),verdict()),jobsListing(verdict({status:'in_progress',conclusion:null})),
    jobsListing(verdict({conclusion:'failure'})),jobsListing(verdict({conclusion:'skipped'})),jobsListing(verdict({run_id:988})),
    jobsListing(verdict({run_attempt:1})),jobsListing(verdict({name:'ci-verdict-shadow'})),{total_count:101,jobs:[]},{total_count:2,jobs:[verdict()]}])
    assert.throws(()=>requireAtmosVerdict(jobs,SHA,run),JSON.stringify(jobs).slice(0,80));
});
test('redirects, non-200, oversized and non-object bodies are refused without exposing the token',async()=>{
  const url='https://api.github.com/repos/weatherx-hq/atmos/actions/runs/1';
  const refusals=[
    ()=>response('',{status:302,headers:{location:'https://evil.example/'}}),
    ()=>response('',{status:301}),
    ()=>response({},{redirected:true}),
    ()=>response('',{type:'opaqueredirect',status:0}),
    ()=>response({message:'Bad credentials'},{status:401}),
    ()=>response({},{headers:{'content-length':String(ATMOS_API_MAX_BYTES+1)}}),
    ()=>response('',{chunks:[Buffer.alloc(ATMOS_API_MAX_BYTES),Buffer.alloc(1)]}),
    ()=>response('[]'),()=>response('null'),()=>response('{'),
  ];
  for(const r of refusals){
    const error=await boundedJson(url,'secret-token',{fetcher:async()=>r()}).then(()=>null,e=>e);
    assert.ok(error,'refused'); assert.doesNotMatch(String(error.message),/secret-token/);
  }
  await assert.rejects(boundedJson('https://evil.example/x','t',{fetcher:async()=>response({})}),/origin/);
  // A fetch-level redirect error (redirect:'error') propagates as a refusal.
  await assert.rejects(atmosCiEvidence(SHA,'t',{fetcher:async()=>{throw new TypeError('fetch failed: redirect mode is set to error');}}));
  assert.deepEqual(await boundedJson(url,'t',{fetcher:async()=>response({ok:1},{chunks:[Buffer.from('{"ok"'),Buffer.from(':1}')]})}),{ok:1});
});
test('evidence decision falls back to the complete local suite unless Atmos CI evidence is proven',async()=>{
  const base={ATMOS_SHA:SHA};
  assert.deepEqual(await decideEvidence({...base,ATMOS_CI_READ_TOKEN:''}),{path:'full-local',reason:'ATMOS_CI_READ_TOKEN is not provisioned'});
  for(const bodies of [[listing(ciRun({status:'in_progress',conclusion:null}))],[listing(ciRun({head_sha:'c'.repeat(40)}))],
    [listing(ciRun({conclusion:'failure'}))],[listing(ciRun()),jobsListing()],[()=>response('',{status:302})],
    [()=>response('',{chunks:[Buffer.alloc(ATMOS_API_MAX_BYTES+1)]})]]){
    const d=await decideEvidence({...base,ATMOS_CI_READ_TOKEN:'tok-123'},{fetcher:fetcherFor(...bodies)});
    assert.equal(d.path,'full-local'); assert.match(d.reason,/^Atmos CI evidence not proven: /); assert.doesNotMatch(d.reason,/tok-123/);
  }
  assert.deepEqual(await decideEvidence({...base,ATMOS_CI_READ_TOKEN:'t'},{fetcher:fetcherFor(listing(ciRun()),jobsListing(verdict()))}),
    {path:'atmos-ci',runId:'987',attempt:'2'});
  await assert.rejects(decideEvidence({ATMOS_SHA:'main',ATMOS_CI_READ_TOKEN:''}));
});

test('evidence job has no candidate; app-tests runs one selected gate; qualify binds the evidence job outputs',()=>{
  const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
  const workflow=read('.github/workflows/ui-staging.yml');
  const evidence=workflow.split('\n  atmos-evidence:\n')[1].split('\n  build:\n')[0];
  const build=workflow.split('\n  build:\n')[1].split('\n  app-tests:\n')[0];
  const app=workflow.split('\n  app-tests:\n')[1].split('\n  qualify:\n')[0];
  const qualify=workflow.split('\n  qualify:\n')[1];
  // The read token exists in exactly one place: the evidence job, which never checks out or runs the candidate.
  assert.equal((workflow.match(/ATMOS_CI_READ_TOKEN/g)||[]).length,2);
  assert.equal((evidence.match(/ATMOS_CI_READ_TOKEN/g)||[]).length,2);
  assert.match(evidence,new RegExp(`name: ${EVIDENCE_STEP}\\n\\s+id: atmos_ci\\n\\s+env:\\n\\s+ATMOS_CI_READ_TOKEN: \\$\\{\\{ secrets\\.ATMOS_CI_READ_TOKEN \\}\\}\\n\\s+run: node cycle/tools/ui-app-test-receipt\\.mjs evidence$`));
  assert.deepEqual([...new Set([...evidence.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m=>m[1]))],['ATMOS_CI_READ_TOKEN']);
  assert.doesNotMatch(evidence,/repository:|ssh-key|path: atmos|atmos\/app|npm |npx |actions\/cache|CLOUDFLARE|PRIVATE_KEY|CANDIDATE_KEY/);
  assert.match(evidence,/environment:\n      name: atmos-ci-evidence\n/);
  assert.match(evidence,/permissions:\n      contents: read\n/);
  assert.match(evidence,/needs: profile\n/);
  assert.equal((evidence.match(/uses: actions\/checkout@/g)||[]).length,1);
  assert.match(evidence,/with: \{ path: cycle, persist-credentials: false \}/);
  for(const output of ['path: ${{ steps.atmos_ci.outputs.path }}','atmos_run_id: ${{ steps.atmos_ci.outputs.atmos_run_id }}',
    'atmos_run_attempt: ${{ steps.atmos_ci.outputs.atmos_run_attempt }}']) assert.ok(evidence.includes(output),output);
  assert.match(build,/Weather Lab release gate/); assert.doesNotMatch(build,/npm test --prefix atmos\/app|test:certify|playwright test|npm run gates|ATMOS_CI/);
  assert.match(app,/needs: \[profile, atmos-evidence\]/); assert.match(app,/environment:\n      name: atmos-source-read-ui/);
  assert.match(app,/permissions:\n      contents: read\n/);
  assert.match(app,/ref: \$\{\{ inputs.atmos_sha \}\}/);
  assert.match(app,/ui-combined-source-guard\.mjs/); assert.match(app,/git rev-parse origin\/master/);
  assert.equal((app.match(/persist-credentials: false/g)||[]).length,2);
  assert.deepEqual([...new Set([...app.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m=>m[1]))],['ATMOS_READONLY_KEY']);
  assert.doesNotMatch(app,/CLOUDFLARE|PRIVATE_KEY|CANDIDATE_KEY|ATMOS_DEPLOY_KEY|pack-build|deploy staging|steps\.atmos_ci|ui-app-test-receipt\.mjs evidence/);
  // The static gates take the job-level, selection-derived WX_CI_PROFILE (the same one the full
  // suite uses); only RU/KK proves the manifest first. No inline profile override exists.
  assert.match(app,/name: local certification and visual gate\n\s+if: \$\{\{ needs\.atmos-evidence\.outputs\.path == 'atmos-ci' \}\}\n\s+run: \|\n\s+if \[ -n "\$WX_CI_PROFILE" \]; then git -C atmos ls-files --error-unmatch ops\/release\/public-beta-ci-manifest\.json; fi\n\s+npm run gates --prefix atmos\/app\n\s+npm run test:certify --prefix atmos\/app\n\s+cd atmos\/app && npx playwright test\n/);
  assert.equal((app.match(/npm run gates/g)||[]).length,1);
  assert.doesNotMatch(app,/WX_CI_PROFILE=/,'no inline profile override');
  assert.equal((app.match(/^      WX_CI_PROFILE: /gm)||[]).length,1,'one job-level selection-derived profile');
  assert.match(app,/^      WX_CI_PROFILE: \$\{\{ \(needs\.profile\.outputs\.model_selection_sha256 == 'production-account-ru-kk-beta-v1' \|\| needs\.profile\.outputs\.model_selection_sha256 == 'production-account-ru-kk-wind100-onboarding-v2'\) && 'public-beta-ci-lab-road-security-v1' \|\| '' \}\}$/m);
  assert.doesNotMatch(evidence,/WX_CI_PROFILE/);
  assert.ok(app.indexOf('ui-app-test-receipt.mjs emit')>app.indexOf('npm test --prefix atmos/app'));
  assert.ok(app.indexOf('ui-app-test-receipt.mjs emit')>app.indexOf('npx playwright test'));
  for(const line of ['UI_APP_TEST_EVIDENCE_PATH: ${{ needs.atmos-evidence.outputs.path }}',
    'UI_APP_TEST_ATMOS_RUN_ID: ${{ needs.atmos-evidence.outputs.atmos_run_id }}','UI_APP_TEST_ATMOS_RUN_ATTEMPT: ${{ needs.atmos-evidence.outputs.atmos_run_attempt }}']){
    assert.ok(app.includes(line),line); assert.ok(qualify.includes(line),line);
  }
  assert.match(app,/receipt: \$\{\{ steps.evidence.outputs.receipt \}\}/);
  assert.doesNotMatch(app,/evidence_path:|atmos_run_id: \$\{\{/,'candidate job never republishes the evidence outputs');
  assert.match(qualify,/needs: \[profile, build, atmos-evidence, app-tests\]/);
  assert.ok(qualify.includes('UI_APP_TEST_RECEIPT: ${{ needs.app-tests.outputs.receipt }}'));
  assert.doesNotMatch(qualify,/actions\/cache|cache: npm|cache-dependency-path/);
  const source=read('tools/ui-release.mjs');
  const receive=source.split('async function receiveBuild()')[1].split('\nfunction environment(')[0];
  assert.ok(receive.indexOf('verifyAppTestReceipt(')<receive.indexOf('unpackBuild('));
  assert.match(receive,/evidence:appTestEvidenceFromEnvironment\(process\.env\)/);
  assert.match(source,/const appTestEvidence=appTestEvidenceFromEnvironment\(process\.env,ciProfileFor\(c\.profile\)\);/);
  assert.match(source,/fullTests:appTestEvidence\.path==='full-local',\n\s+weatherLab:true,builtRuntime:true,probes:3,appTestEvidence\};/);
  const policy=source.split('const POLICY_FILES')[1].split(';')[0];
  assert.ok(policy.includes('tools/ui-app-test-receipt.mjs')); assert.ok(!policy.includes('ui-ci-cache'));
});

test('real GitHub attempt metadata carries workflow SHA, numeric attempt and complete gate status',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/ui-app-gate-job-36274751260.json',import.meta.url),'utf8'));
  const historical=fixture.job;
  assert.equal(fixture.sourceApi,'repos/Andrewegao/v3t7kq-cycle/actions/runs/36274751260/attempts/1/jobs');
  assert.equal(historical.name,'build');
  assert.equal(historical.head_sha,'fdcbdb439f46ebc00fd55529d51876a76b8c310b');
  assert.equal(historical.run_id,36274751260); assert.equal(historical.run_attempt,1);
  assert.equal(historical.status,'completed'); assert.equal(historical.conclusion,'success');
  const gate=historical.steps.find(s=>s.name===APP_TEST_STEP);
  assert.equal(gate.status,'completed'); assert.equal(gate.conclusion,'success');
  assert.equal(Date.parse(gate.completed_at)-Date.parse(gate.started_at),408000);
  const c={...context(),workflowSha:historical.head_sha,runId:String(historical.run_id),attempt:String(historical.run_attempt)};
  const receipt=JSON.stringify(appTestReceipt(c));
  // Old build success is not app-tests evidence. Adapt only the job name and add the evidence step
  // (which predates this record) to exercise the actual API field types; no cloud run is claimed.
  assert.throws(()=>verifyAppTestReceipt(receipt,[historical],c));
  assert.throws(()=>verifyAppTestReceipt(receipt,[{...historical,name:'app-tests'}],c),/one atmos-evidence job/);
  // The evidence job postdates this record; synthesise it from the same real field types.
  const evidence={...historical,name:EVIDENCE_JOB,steps:[{...gate,name:EVIDENCE_STEP}]};
  assert.deepEqual(verifyAppTestReceipt(receipt,[evidence,{...historical,name:'app-tests'}],c),appTestReceipt(c));
});

test('sealed qualification: fullTests reflects the evidence path, never claims the full suite on atmos-ci',()=>{
  const none=profileFor('none'),beta=profileFor('production-account-ru-kk-wind100-onboarding-v2');
  const full={fullTests:true,appTestEvidence:appTestEvidence(FULL)};
  const ci={fullTests:false,appTestEvidence:appTestEvidence(CI,'')};
  const betaCi={fullTests:false,appTestEvidence:appTestEvidence(CI,BETA_CI_PROFILE)};
  requireAppTestQualification(full,none); requireAppTestQualification(full,beta);
  requireAppTestQualification(ci,none); requireAppTestQualification(betaCi,beta);
  requireAppTestQualification({fullTests:true},none); // pre-evidence candidates stay full-suite only
  for(const [q,p] of [[{fullTests:false},none],[{},none],[{...ci,fullTests:true},none],[{...full,fullTests:false},none],
    [ci,beta],[betaCi,none],[{...ci,appTestEvidence:{...ci.appTestEvidence,commands:[]}},none],
    [{...ci,appTestEvidence:{...ci.appTestEvidence,extra:1}},none]])
    assert.throws(()=>requireAppTestQualification(q,p),JSON.stringify(q).slice(0,80));
  assert.equal(ciProfileFor(beta),BETA_CI_PROFILE); assert.equal(ciProfileFor(none),'');
  const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
  assert.match(read('tools/ui-candidate.mjs'),/requireAppTestQualification\(q, candidate\.profile\); assert\.equal\(q\?\.weatherLab, true\)/);
  assert.match(read('tools/production-account-release.mjs'),/requireAppTestQualification\(qualification, candidate\.profile\);/);
});
