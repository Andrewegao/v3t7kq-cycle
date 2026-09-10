import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gate} from '../tools/staging-tc-guidance.mjs';
const valid=()=>({GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_JOB:'publish',GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/staging-tc-guidance.yml@refs/heads/main',STAGING_DATA_ISOLATION_APPROVED:'true',STAGING_TC_GUIDANCE_ENABLED:'true',STAGING_R2_ACCOUNT_ID:'a89f9a1af485021fbc60a68b163c7c6e',TC_SOURCE_SHA:'a'.repeat(40),STAGING_TC_APPROVED_SOURCE_SHA:'a'.repeat(40),GITHUB_RUN_ID:'34370000001',GITHUB_RUN_ATTEMPT:'1'});
test('exact manually approved source passes without any credential',()=>assert.doesNotThrow(()=>gate(valid())));
test('every workflow identity and approval is independently required',()=>{
 for(const key of Object.keys(valid())){const env=valid();delete env[key];assert.throws(()=>gate(env),key);}
 for(const patch of [{GITHUB_REF:'refs/heads/feature'},{GITHUB_EVENT_NAME:'schedule'},{RUNNER_ENVIRONMENT:'self-hosted'},{GITHUB_JOB:'foreign'},{TC_SOURCE_SHA:'b'.repeat(40)},{TC_SOURCE_SHA:'main',STAGING_TC_APPROVED_SOURCE_SHA:'main'},{GITHUB_RUN_ID:'1; echo bad'},{GITHUB_RUN_ATTEMPT:'0'},{STAGING_TC_GUIDANCE_ENABLED:'false'}])assert.throws(()=>gate({...valid(),...patch}));
});
test('unrelated credentials or catalog mutation config fail before source access',()=>{
 for(const key of ['AWS_ACCESS_KEY_ID','RCLONE_CONFIG','CLOUDFLARE_API_TOKEN','R2_PRODUCTION_ACCESS_KEY_ID','SHARED_R2_TOKEN','UI_PRODUCTION_TOKEN','STAGING_WORKER_API_TOKEN','CATALOG_ENDPOINT'])assert.throws(()=>gate({...valid(),[key]:'not-a-real-secret'}),key);
 assert.doesNotThrow(()=>gate({...valid(),STAGING_R2_WRITE_ACCESS_KEY_ID:'scoped',STAGING_R2_WRITE_SECRET_ACCESS_KEY:'scoped'}));
});
test('workflow has no automatic activation path and exposes writes only to final publisher',()=>{
 const w=readFileSync(new URL('../.github/workflows/staging-tc-guidance.yml',import.meta.url),'utf8');
 assert.match(w,/workflow_dispatch:/);assert.doesNotMatch(w,/\n  (?:schedule|push|pull_request|workflow_run):/);
 assert.match(w,/permissions:\n  contents: read/);assert.match(w,/name: data-staging/);assert.match(w,/cancel-in-progress: false/);
 assert.doesNotMatch(w,/upload-artifact|wrangler|CATALOG_ENDPOINT|R2_PRODUCTION|UI_PRODUCTION/);
 const gateAt=w.indexOf('Gate exact source'),checkoutAt=w.indexOf('Checkout qualified producer'),bakeAt=w.indexOf('Bake bounded'),publishAt=w.indexOf('Publish immutable');
 assert.ok(gateAt>0&&gateAt<checkoutAt&&checkoutAt<bakeAt&&bakeAt<publishAt);
 for(const secret of ['secrets.STAGING_R2_WRITE_ACCESS_KEY_ID','secrets.STAGING_R2_WRITE_SECRET_ACCESS_KEY'])assert.ok(w.indexOf(secret)>publishAt);
 assert.match(w,/test "\$\(git -C atmos rev-parse HEAD\)" = "\$TC_SOURCE_SHA"/);
 assert.match(w,/node atmos\/ops\/tc\/prepare-staging-tc.mjs publish/);
 assert.doesNotMatch(w,/run:.*\$\{\{ inputs\./);
 for(const line of w.split('\n').filter(l=>l.includes('uses:')))assert.match(line,/@[a-f0-9]{40}/);
 const ci=readFileSync(new URL('../.github/workflows/scheduler-ci.yml',import.meta.url),'utf8');
 assert.ok(ci.includes('.github/workflows/staging-tc-guidance.yml'));assert.ok(ci.includes('tests/staging-*.mjs'));
});
