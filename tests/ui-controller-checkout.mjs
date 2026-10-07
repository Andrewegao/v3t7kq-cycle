import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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
  const combined=fixture.controllers.find(row=>row.pin==='b3f63183dbcde01e388fda7720726cc53f28134b');
  assert.ok(combined.files.includes('app/e2e/public-release-journeys.mjs'));
  assert.ok(combined.files.includes('app/e2e/staging-account-qualification.mjs'));
  assert.equal(combined.files.length,22);
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
  assert.doesNotMatch(workflow,/actions\/cache|cache: npm|cache-dependency-path|--omit=dev|npm run build|ui-release.mjs build/);
  const release=read('tools/ui-release.mjs');
  assert.match(release,/RELEASE_GUARD_VERIFY_REQUIRED_SUCCESSES:'3'/);
  assert.match(release,/if \(stage === 'production'\) \{ await auditRun\(c\); await exactStaging\(c\); \}/);
});

// Staging build consumes a smaller closure than guarded qualification/production.
const staging=read('.github/workflows/ui-staging.yml');
const buildController=staging.split('      - name: checkout reviewed release controller\n')[1]
  .split('      - uses: actions/setup-node@')[0];
const buildClosure=fixture.stagingBuild;
const controllerRefs=[
  ['production-account-ru-kk-wind100-onboarding-v2','b3f63183dbcde01e388fda7720726cc53f28134b'],
  ['production-account-ru-kk-beta-v1','b9db38dd22eed1da56c6c4dd4140480da7e89153'],
  ['production-account-billing-v1','6fcec22638f6696be71daa2f2e974ebc4b24318e'],
  ['none','25c402db5149daa018e349a34a4beeba1f2dca45'],
];
const baselineController='4dafd26387d5917604deb7379a8d45a994fc5b67';
function stageBuildContract(block){
  const ref=block.match(/^          ref: (.+)$/m)?.[1];
  const expected='${{ '+controllerRefs.map(([selector,pin])=>
    `needs.profile.outputs.model_selection_sha256 == '${selector}' && '${pin}'`).join(' || ')+
    ` || '${baselineController}' }}`;
  assert.equal(ref,expected,'literal controller ref mapping changed');
  const body=block.split('          sparse-checkout: |\n')[1]?.split('          sparse-checkout-cone-mode:')[0];
  assert.ok(body,'build sparse selection is missing');
  const expressions=body.trim().split('\n').map(line=>{
    const match=line.trim().match(/^\$\{\{ needs\.profile\.outputs\.model_selection_sha256 == '([^']+)' && '(\/[^']+)' \|\| '' \}\}$/);
    assert.ok(match,'unexpected sparse condition');
    assert.equal(match[1],buildClosure.profile,'unqualified sparse profile');
    return {selector:match[1],path:match[2]};
  });
  assert.equal(buildClosure.pin,controllerRefs[0][1]);
  assert.deepEqual(expressions.map(row=>row.path),buildClosure.paths.map(path=>'/'+path));
  assert.match(block,/^          sparse-checkout-cone-mode: false$/m);
  assert.doesNotMatch(block,/^          (?:filter|fetch-depth):/m);
  return {pathsFor:selector=>expressions.filter(row=>row.selector===selector).map(row=>row.path)};
}

test('only exact combined-Wind staging build gets the reviewed four-file noncone closure',()=>{
  assert.equal(buildClosure.profile,'production-account-ru-kk-wind100-onboarding-v2');
  assert.deepEqual(buildClosure.paths,['.gitignore','platform/edge/package.json',
    'platform/edge/package-lock.json','ops/release/build-release-receipt.mjs']);
  assert.equal(buildClosure.coneMode,false);
  const contract=stageBuildContract(buildController);
  assert.deepEqual(contract.pathsFor(buildClosure.profile),buildClosure.paths.map(path=>'/'+path));
  for(const profile of ['none','approved','release-roster-core-account-v1',
    'production-account-ru-kk-beta-v1','production-account-billing-v1','unknown'])
    assert.deepEqual(contract.pathsFor(profile),[],'other profiles must retain full checkout');
  assert.match(buildController,/ssh-key: \$\{\{ secrets\.ATMOS_READONLY_KEY \}\}/);
  assert.match(buildController,/persist-credentials: false/);
});

test('missing runtime input, unreviewed profile and changed controller pin are rejected',()=>{
  stageBuildContract(buildController);
  for(const path of buildClosure.paths){
    const changed=buildController.split('\n').filter(line=>!line.includes(`&& '/${path}'`)).join('\n');
    assert.throws(()=>stageBuildContract(changed),/deep-equal|selection is missing|unexpected sparse/);
  }
  assert.throws(()=>stageBuildContract(buildController.replace(
    `== '${buildClosure.profile}' && '/.gitignore'`,`== 'approved' && '/.gitignore'`)),/unqualified sparse profile/);
  assert.throws(()=>stageBuildContract(buildController.replace(buildClosure.pin,'a'.repeat(40))),/literal controller ref mapping changed/);
});

test('qualify, candidate and Cycle checkouts and the actual controller guard remain complete',()=>{
  const qualify=staging.split('  qualify:\n')[1];
  assert.ok(qualify);
  assert.doesNotMatch(qualify,/sparse-checkout|filter:/);
  assert.equal((staging.match(/sparse-checkout: /g)||[]).length,1);
  assert.equal((staging.match(/with: \{ path: cycle, fetch-depth: 0, persist-credentials: false \}/g)||[]).length,2);
  const candidate=staging.split('      - name: checkout exact candidate Atmos source\n')[1]
    .split('      - name: verify current-master')[0];
  assert.match(candidate,/ref: \$\{\{ inputs\.atmos_sha \}\}/);
  assert.match(candidate,/fetch-depth: 0/);
  assert.doesNotMatch(candidate,/sparse-checkout|filter:/);
  const release=read('tools/ui-release.mjs').split('function controller(')[1].split('export function requireReleaseProfileBinding')[0];
  assert.match(release,/git\(\['rev-parse','HEAD'\], CONTROL\), controlShaFor\(profile\)/);
  assert.match(release,/git\(\['diff','--exit-code','HEAD'\], CONTROL\)/);
  for(const command of ['npm ci --prefix atmos/app','npm ci --prefix control/platform/edge',
    'npm ci --prefix control/app','npx playwright install --with-deps chromium',
    'node cycle/tools/ui-release.mjs deploy staging','bash ops/weather-lab-ready.sh'])
    assert.ok(staging.includes(command),command);
  assert.doesNotMatch(staging,/--omit=dev/);
  // Caches live only in the candidate-domain jobs; the publisher never restores one.
  assert.doesNotMatch(qualify,/actions\/cache|cache: npm|cache-dependency-path/);
  const profileJob=staging.split('\n  profile:\n')[1].split('\n  build:\n')[0];
  assert.doesNotMatch(profileJob,/actions\/cache|cache: npm/);
  // No browser cache anywhere: a planted browser would otherwise outlive its candidate.
  assert.doesNotMatch(staging,/ms-playwright|actions\/cache\/(?:restore|save)|cache: npm|cache-dependency-path/);
  for(const job of ['build','app-tests']){
    const block=staging.split(`\n  ${job}:\n`)[1].split('\n  '+(job==='build'?'app-tests':'qualify')+':\n')[0];
    const uses=[...block.matchAll(/uses: (actions\/cache[^@]*)@([a-f0-9]{40}) # v4\n\s+with:\n\s+path: ([^\n]+)\n\s+key: ([^\n]+)\n\s+restore-keys: ([^\n]+)\n/g)];
    assert.deepEqual(uses.map(m=>[m[1],m[2],m[3],m[4],m[5]]),[['actions/cache','0057852bfaa89a56745cba8c7296529d2fc39830','~/.npm/_cacache',
      "ui-candidate-npm-${{ runner.os }}-${{ hashFiles('atmos/app/package-lock.json', 'control/platform/edge/package-lock.json') }}",
      'ui-candidate-npm-${{ runner.os }}-']],job);
    assert.equal((block.match(/actions\/cache/g)||[]).length,1,job);
    assert.ok(block.indexOf('actions/cache@')<block.indexOf('npm ci --prefix atmos/app'),job);
  }
  // The candidate npm key prefix is unique to the two candidate jobs across every workflow.
  for(const name of readdirSync(new URL('../.github/workflows/',import.meta.url)))
    if(name!=='ui-staging.yml')assert.doesNotMatch(read('.github/workflows/'+name),/ui-candidate-npm/,name);
});
