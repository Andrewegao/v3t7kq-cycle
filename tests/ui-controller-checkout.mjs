import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const workflow=read('.github/workflows/ui-release.yml');
const fixture=JSON.parse(read('tests/fixtures/ui-controller-dependencies.json'));
const requiredPaths=['app','ops','platform','data','tools','testing','scripts','docs/admin','docs/engineering'];
const controller=workflow.split('      - name: checkout reviewed release controller (not candidate source)\n')[1]
  .split('      - uses: actions/setup-node@')[0];
const paths=controller.split('          sparse-checkout: |\n')[1]?.split('\n')
  .filter(line=>/^            \S/.test(line)).map(line=>line.trim())??[];
const included=(path,selection)=>!path.includes('/')||selection.some(dir=>path===dir||path.startsWith(dir+'/'));
function assertDependencyClosure(selection,record) {
  for(const path of record.files) assert.ok(included(path,selection),`${record.pin}: excluded dependency ${path}`);
}

test('only the pinned Atmos controller is sparse; Cycle ancestry retains full history',()=>{
  assert.deepEqual(paths,requiredPaths);
  assert.match(workflow,/with: \{ path: cycle, fetch-depth: 0, persist-credentials: false \}/);
  assert.equal((workflow.match(/sparse-checkout:/g)||[]).length,1);
  assert.match(controller,/repository: weatherx-hq\/atmos/);
  assert.match(controller,/ssh-key: \$\{\{ secrets.ATMOS_DEPLOY_KEY \}\}/);
  assert.match(controller,/persist-credentials: false/);
  assert.match(controller,/path: control/);
  // Preserve the existing default depth=1 at reviewed literal controller refs.
  assert.doesNotMatch(controller,/fetch-depth:|filter:|sparse-checkout-cone-mode:|inputs\.atmos_sha/);
  const pins=[...controller.matchAll(/'([a-f0-9]{40})'/g)].map(match=>match[1]).sort();
  assert.deepEqual(pins,fixture.controllers.map(row=>row.pin).sort());
  const release=read('tools/ui-release.mjs');
  const audit=release.split('async function auditRun(c) {')[1].split('\nasync function download()')[0];
  assert.match(audit,/git\(\['fetch','--no-tags','origin','main'\]\)/);
  assert.match(audit,/git\(\['merge-base','--is-ancestor',r.head_sha,'origin\/main'\]\)/);
});

test('all four reviewed controller dependency inventories fit the sparse selection',()=>{
  assert.equal(fixture.controllers.length,4);
  for(const record of fixture.controllers){
    assertDependencyClosure(paths,record);
    for(const path of ['ops/release/guard-pages-deploy.sh','ops/release/verify-point-series.mjs',
      'ops/release/test-guard-pages-deploy.mjs','app/e2e/layer-switch-tint.mjs',
      'app/e2e/layer-switch-surface.mjs','app/package-lock.json','platform/edge/package-lock.json'])
      assert.ok(record.files.includes(path),`inventory dropped ${path}`);
    assert.ok(record.externalPackages.includes('playwright'));
    assert.ok(record.externalPackages.includes('pngjs'));
    assert.ok(record.externalPackages.includes('pixelmatch'));
  }
  const combined=fixture.controllers.find(row=>row.pin==='e35540607fcf3fc5731aef610411cd67d2dc482e');
  assert.ok(combined.files.includes('app/e2e/public-release-journeys.mjs'));
});

test('narrowing away dynamically spawned helpers or probe dependencies is rejected',()=>{
  for(const record of fixture.controllers){
    for(const missing of ['app','ops','platform'])
      assert.throws(()=>assertDependencyClosure(paths.filter(path=>path!==missing),record));
  }
  const missingDynamic=[...paths.filter(path=>path!=='ops'),'ops/platform'];
  assert.throws(()=>assertDependencyClosure(missingDynamic,fixture.controllers[0]),/excluded dependency ops\/release\//);
});

test('locked dependency setup, exact artifact promotion and guarded probes remain present',()=>{
  for(const line of ['npm ci --prefix control/platform/edge','npm ci --prefix control/app',
    'cd control/app && npx playwright install --with-deps chromium','node cycle/tools/ui-release.mjs download',
    'node cycle/tools/ui-release.mjs deploy production']) assert.ok(workflow.includes(line),line);
  assert.doesNotMatch(workflow,/actions\/cache|--omit=dev|npm run build|ui-release.mjs build/);
  const release=read('tools/ui-release.mjs');
  assert.match(release,/RELEASE_GUARD_VERIFY_REQUIRED_SUCCESSES:'3'/);
  assert.match(release,/if \(stage === 'production'\) \{ await auditRun\(c\); await exactStaging\(c\); \}/);
});
