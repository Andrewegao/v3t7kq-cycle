import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const workflow=read('.github/workflows/data-reader-refresh.yml'),controller=read('tools/data-reader-refresh.mjs');
test('manual owner-approved production data-only lane, exact immutable checkout',()=>{
  for(const required of ['workflow_dispatch:','environment: production','REFRESH-DATA-READER-ONLY','group: weatherx-production-data-edge','cancel-in-progress: false','repository: weatherx-hq/atmos','merge-base --is-ancestor','persist-credentials: false','npm run check'])assert.ok(workflow.includes(required),required);
  assert.ok(!/^  (schedule|push|workflow_run|repository_dispatch):/m.test(workflow));
  assert.ok(!/workflow run|wrangler deploy|pages deploy|ui-release|catalog-bake|bake\.sh|secret set|variable set/.test(workflow));
  assert.ok(workflow.indexOf('npm run check')<workflow.indexOf('mjs preflight'));
  assert.ok(workflow.indexOf('mjs preflight')<workflow.indexOf('mjs execute'));
});
test('interrupted activation recovery is always attempted and receipts retained',()=>{
  assert.match(workflow,/always\(\).*steps\.refresh\.outcome == 'failure'.*steps\.refresh\.outcome == 'cancelled'/);
  assert.match(workflow,/mjs recover/);assert.match(workflow,/retention-days: 30/);
  assert.match(controller,/data-reader-refresh\.yml@refs\/heads\/main/);
  assert.match(controller,/receipt\.runId,process\.env\.GITHUB_RUN_ID/);
  assert.match(controller,/receipt\.attempt,process\.env\.GITHUB_RUN_ATTEMPT/);
});
test('existing Pages read credential is preferred and checked before expensive work',()=>{
  const selection='PAGES_TOKEN: ${{ secrets.PAGES_READ_TOKEN || secrets.CLOUDFLARE_WORKERS_API_TOKEN }}';
  assert.equal(workflow.split(selection).length-1,4);
  const check=workflow.indexOf('mjs pages-access');assert.ok(check>0);
  for(const later of ['run: npm ci','run: npm run check','mjs preflight','mjs execute'])assert.ok(check<workflow.indexOf(later),later);
  assert.ok(!workflow.includes('UI_PRODUCTION_PAGES_TOKEN'));assert.ok(!workflow.includes('UI_STAGING_PAGES_TOKEN'));
});
test('CLI rejects shell injection and absent owner approval before checkout',()=>{
  const shell=workflow.match(/run: \|\n([\s\S]+?)\n      - name: Checkout exact controller/)[1].split('\n').map(x=>x.slice(10)).join('\n');
  const env={...process.env,CONFIRM:'REFRESH-DATA-READER-ONLY',ATMOSPHERE_SHA:'a'.repeat(40),BOUNDARY_DIGEST:'b'.repeat(64)};
  execFileSync('bash',['-e','-c',shell],{env});
  for(const bad of [{CONFIRM:'yes'},{ATMOSPHERE_SHA:'main'},{BOUNDARY_DIGEST:'$(touch /tmp/forbidden)'}])assert.throws(()=>execFileSync('bash',['-e','-c',shell],{env:{...env,...bad},stdio:'pipe'}));
});
test('new controller contracts are registered in existing CI',()=>{const ci=read('.github/workflows/scheduler-ci.yml');assert.ok(ci.includes('.github/workflows/data-reader-refresh.yml'));assert.ok(ci.includes('node --test tests/data-reader-*.mjs'));});
test('runner-specific receipt path is resolved in a step, never job-level env',()=>{
  const jobEnv=workflow.split('    env:\n')[1].split('    steps:')[0];
  assert.ok(!jobEnv.includes('runner.'),'runner context unavailable in job env');
  assert.ok(workflow.includes('run: echo "REFRESH_RECEIPT=$RUNNER_TEMP/data-reader-refresh/receipt.json" >> "$GITHUB_ENV"'));
});
