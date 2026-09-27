import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { appTestReceipt, verifyAppTestReceipt, receiptForEnvironment, APP_TEST_STEP } from '../tools/ui-app-test-receipt.mjs';

const context={sourceSha:'a'.repeat(40),workflowSha:'b'.repeat(40),runId:'123',attempt:'2',selection:'production-account-ru-kk-wind100-onboarding-v2'};
const job=()=>({name:'app-tests',head_sha:context.workflowSha,run_id:123,run_attempt:2,status:'completed',conclusion:'success',
  steps:[{name:APP_TEST_STEP,status:'completed',conclusion:'success'}]});
const raw=()=>JSON.stringify(appTestReceipt(context));
const env=()=>({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',UI_BUILDS_ENABLED:'true',
  GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',GITHUB_JOB:'app-tests',
  ATMOS_SHA:context.sourceSha,GITHUB_SHA:context.workflowSha,GITHUB_RUN_ID:context.runId,GITHUB_RUN_ATTEMPT:context.attempt,
  MODEL_SELECTION_SHA256:context.selection,WX_CI_PROFILE:'public-beta-ci-lab-road-security-v1'});

test('complete gate accepts only the exact source/profile/workflow/run/attempt',()=>{
  assert.deepEqual(verifyAppTestReceipt(raw(),[job()],context),appTestReceipt(context));
  assert.deepEqual(receiptForEnvironment(env(),context.sourceSha,context.workflowSha),appTestReceipt(context));
  for(const selection of ['none','production-account-billing-v1','production-account-ru-kk-beta-v1',context.selection]){
    const c={...context,selection}; const receipt=appTestReceipt(c);
    assert.deepEqual(verifyAppTestReceipt(JSON.stringify(receipt),[job()],c),receipt);
    assert.equal(receipt.ciProfile,selection.includes('ru-kk')?'public-beta-ci-lab-road-security-v1':'');
  }
});
test('missing, malformed, oversized or expanded receipts fail closed',()=>{
  for(const value of [undefined,'','null','{','x'.repeat(4097),JSON.stringify({...appTestReceipt(context),extra:true})])
    assert.throws(()=>verifyAppTestReceipt(value,[job()],context));
  for(const field of Object.keys(appTestReceipt(context))){
    const r=appTestReceipt(context); delete r[field];
    assert.throws(()=>verifyAppTestReceipt(JSON.stringify(r),[job()],context),field);
  }
});
test('receipts cannot be reused across source, profile, workflow, run or retry',()=>{
  for(const change of [{sourceSha:'c'.repeat(40)},{workflowSha:'c'.repeat(40)},{runId:'124'},{attempt:'3'},{selection:'none'}])
    assert.throws(()=>verifyAppTestReceipt(raw(),[job()],{...context,...change}));
  const r=appTestReceipt(context); r.command='npm run test:fast --prefix atmos/app';
  assert.throws(()=>verifyAppTestReceipt(JSON.stringify(r),[job()],context));
  // A retained prior-attempt output cannot pass even if a jobs listing reports a current attempt.
  assert.throws(()=>verifyAppTestReceipt(JSON.stringify(appTestReceipt({...context,attempt:'1'})),[job()],context));
});
test('GitHub must independently report one completed successful full test job and gate',()=>{
  for(const jobs of [[],[job(),job()]]) assert.throws(()=>verifyAppTestReceipt(raw(),jobs,context));
  for(const change of [{conclusion:'failure'},{conclusion:'cancelled'},{conclusion:'skipped'},{status:'in_progress'},
    {head_sha:'c'.repeat(40)},{run_id:124},{run_attempt:1},{steps:[]},{steps:undefined},
    {steps:[...job().steps,...job().steps]},
    {steps:[{name:APP_TEST_STEP,status:'completed',conclusion:'skipped'}]},
    {steps:[{name:APP_TEST_STEP,status:'in_progress',conclusion:null}]}])
    assert.throws(()=>verifyAppTestReceipt(raw(),[{...job(),...change}],context),JSON.stringify(change));
});
test('receipt producer rejects wrong checkout, runner, activation and CI profile',()=>{
  for(const field of Object.keys(env())) assert.throws(()=>receiptForEnvironment({...env(),[field]:''},context.sourceSha,context.workflowSha),field);
  assert.throws(()=>receiptForEnvironment(env(),'c'.repeat(40),context.workflowSha));
  assert.throws(()=>receiptForEnvironment(env(),context.sourceSha,'c'.repeat(40)));
  assert.throws(()=>receiptForEnvironment({...env(),WX_CI_PROFILE:'full'},context.sourceSha,context.workflowSha));
});
test('full tests are an isolated sibling and qualification waits for authenticated success',()=>{
  const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
  const workflow=read('.github/workflows/ui-staging.yml');
  const build=workflow.split('\n  build:\n')[1].split('\n  app-tests:\n')[0];
  const app=workflow.split('\n  app-tests:\n')[1].split('\n  qualify:\n')[0];
  const qualify=workflow.split('\n  qualify:\n')[1];
  assert.match(build,/Weather Lab release gate/); assert.doesNotMatch(build,/npm test --prefix atmos\/app/);
  assert.match(app,/needs: profile/); assert.match(app,/environment:\n      name: atmos-source-read-ui/);
  assert.match(app,/permissions:\n      contents: read\n/);
  assert.match(app,/ref: \$\{\{ inputs.atmos_sha \}\}/);
  assert.match(app,/ui-combined-source-guard\.mjs/); assert.match(app,/git rev-parse origin\/master/);
  assert.equal((app.match(/persist-credentials: false/g)||[]).length,2);
  assert.deepEqual([...new Set([...app.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m=>m[1]))],['ATMOS_READONLY_KEY']);
  assert.doesNotMatch(app,/actions\/cache|CLOUDFLARE|PRIVATE_KEY|CANDIDATE_KEY|ATMOS_DEPLOY_KEY|pack-build|deploy staging/);
  assert.match(app,/name: full application test gate\n\s+run: npm test --prefix atmos\/app/);
  assert.ok(app.indexOf('ui-app-test-receipt.mjs emit')>app.indexOf('npm test --prefix atmos/app'));
  assert.match(app,/receipt: \$\{\{ steps.evidence.outputs.receipt \}\}/);
  assert.match(qualify,/needs: \[profile, build, app-tests\]/);
  assert.match(qualify,/UI_APP_TEST_RECEIPT: \$\{\{ needs.app-tests.outputs.receipt \}\}/);
  const source=read('tools/ui-release.mjs');
  const receive=source.split('async function receiveBuild()')[1].split('\nfunction environment(')[0];
  assert.ok(receive.indexOf('verifyAppTestReceipt(')<receive.indexOf('unpackBuild('));
  assert.ok(source.split('const POLICY_FILES')[1].split(';')[0].includes('tools/ui-app-test-receipt.mjs'));
});


test('real GitHub attempt metadata carries workflow SHA, numeric attempt and complete gate status',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/ui-app-gate-job-36274751260.json',import.meta.url),'utf8'));
  const historical=fixture.job;
  assert.equal(fixture.sourceApi,'repos/Andrewegao/v3t7kq-cycle/actions/runs/36274751260/attempts/1/jobs');
  assert.equal(historical.name,'build');
  assert.equal(historical.head_sha,'fdcbdb439f46ebc00fd55529d51876a76b8c310b');
  assert.equal(historical.run_id,36274751260); assert.equal(historical.run_attempt,1);
  assert.equal(historical.status,'completed'); assert.equal(historical.conclusion,'success');
  const step=historical.steps.find(step=>step.name===APP_TEST_STEP);
  assert.equal(step.status,'completed'); assert.equal(step.conclusion,'success');
  assert.equal(Date.parse(step.completed_at)-Date.parse(step.started_at),408000);
  const c={...context,workflowSha:historical.head_sha,runId:String(historical.run_id),attempt:String(historical.run_attempt)};
  const receipt=JSON.stringify(appTestReceipt(c));
  // Old build success is not app-tests evidence. Adapt only the job name to exercise
  // the actual API field types; this does not claim the sibling job has run in cloud.
  assert.throws(()=>verifyAppTestReceipt(receipt,[historical],c));
  assert.deepEqual(verifyAppTestReceipt(receipt,[{...historical,name:'app-tests'}],c),appTestReceipt(c));
});
