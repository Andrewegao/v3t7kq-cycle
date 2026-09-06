import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const bake=read('.github/workflows/bake.yml');
const core=read('.github/workflows/collect-core-model.yml');
const regional=read('.github/workflows/collect-regional-model.yml');
const publisher=read('.github/workflows/publish-current-model-production.yml');
const coreModels=['ecmwf','gfs','hrrr','aifs'];
const regionalModels=['icon','hrdps','arome-antilles','hrrr-ak','nam','nam-hi','nam-ak'];
const all=[...coreModels,...regionalModels];

test('eleven reusable collectors each unlock only their matching publisher',()=>{
  for(const model of coreModels){
    assert.match(bake,new RegExp(`^  core-${model}:\\n    name: core \\(${model}\\)\\n    uses: \\./\\.github/workflows/collect-core-model\\.yml`,'m'));
    assert.match(bake,new RegExp(`^  publish-${model}:\\n    needs: core-${model}\\n`,'m'));
  }
  for(const model of regionalModels){
    assert.match(bake,new RegExp(`^  regional-${model}:\\n    name: regional \\(${model}\\)\\n    uses: \\./\\.github/workflows/collect-regional-model\\.yml`,'m'));
    assert.match(bake,new RegExp(`^  publish-${model}:\\n    needs: regional-${model}\\n`,'m'));
  }
  assert.equal((bake.match(/uses: \.\/\.github\/workflows\/collect-core-model\.yml/g)||[]).length,4);
  assert.equal((bake.match(/uses: \.\/\.github\/workflows\/collect-regional-model\.yml/g)||[]).length,7);
  assert.equal((bake.match(/uses: \.\/\.github\/workflows\/publish-current-model-production\.yml/g)||[]).length,11);
  assert.equal(new Set(all).size,11);
});

test('collectors preserve artifact names, gates, and credential isolation',()=>{
  assert.match(core,/name: core-model-packs-\$\{\{ inputs\.model \}\}/);
  assert.match(regional,/name: regional-packs-\$\{\{ inputs\.model \}\}/);
  for(const source of [core,regional]){
    assert.match(source,/environment: production/);
    assert.match(source,/persist-credentials: false/);
    assert.equal((source.match(/secrets\./g)||[]).length,1);
    assert.doesNotMatch(source,/R2_PRODUCTION|CATALOG_ENDPOINT|CATALOG_PROMOTION|PAGES/);
  }
  assert.match(core,/data\/bake_model_inputs\.py --model "\$CORE_MODEL"/);
  assert.match(core,/ops\/core_model_artifact\.py seal/);
  assert.match(regional,/data\/bake_regional_models\.py collect --model "\$REGIONAL_MODEL"/);
  assert.match(regional,/if: \$\{\{ always\(\) \}\}/);
});

test('publisher is disabled by default and structurally production-data-only',()=>{
  for(const model of all){
    const job=bake.split(`\n  publish-${model}:`)[1].split(/\n  [a-z]/)[0];
    assert.match(job,/CURRENT_RUN_COMPONENT_PUBLISH_ENABLED == 'true'/);
    assert.doesNotMatch(job,/staging|PAGES|ui-release/i);
  }
  assert.match(publisher,/test "\$ATMOS_SHA" != "\$UNQUALIFIED_PLACEHOLDER_SHA"/);
  assert.match(publisher,/CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA/);
  assert.match(publisher,/weatherx:weatherx-data-production/g);
  assert.match(publisher,/weatherx:weatherx-components-production/g);
  assert.doesNotMatch(publisher,/weatherx-data-staging|weatherx-components-staging|UI_PRODUCTION|pages deploy/i);
  assert.match(publisher,/group: weatherx-component-production-\$\{\{ inputs\.model \}\}/);
  assert.match(publisher,/cancel-in-progress: false/);
});

test('actual initial publisher guard rejects branch, event, missing approval and old source before credentials',()=>{
  const guard=publisher.split('        run: |\n')[1].split('\n      - name:')[0];
  const good={...process.env,GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main',
    GITHUB_EVENT_NAME:'workflow_dispatch',ENABLED:'true',APPROVED_SHA:'a'.repeat(40),ATMOS_SHA:'a'.repeat(40),
    UNQUALIFIED_PLACEHOLDER_SHA:'b'.repeat(40),COMPONENT_KIND:'regional',MODEL:'icon'};
  const run=env=>spawnSync('bash',['-e','-u','-c',guard],{env,encoding:'utf8'});
  assert.equal(run(good).status,0);
  assert.equal(run({...good,GITHUB_EVENT_NAME:'schedule'}).status,0);
  for(const change of [{GITHUB_REPOSITORY:'other/repo'},{GITHUB_REF:'refs/heads/feature'},
    {GITHUB_EVENT_NAME:'pull_request'},{ENABLED:''},{APPROVED_SHA:'c'.repeat(40)},
    {UNQUALIFIED_PLACEHOLDER_SHA:'a'.repeat(40)},{MODEL:'../ecmwf'}]) {
    const result=run({...good,...change});assert.notEqual(result.status,0,JSON.stringify(change));
    assert.equal(result.stdout,'');
  }
});

test('per-model authentication precedes production baseline and publication credentials',()=>{
  const auth=publisher.indexOf('name: authenticate and copy only this completed collector artifact');
  const baseline=publisher.indexOf('name: hydrate authenticated current production component baseline');
  const publish=publisher.indexOf('name: validate and publish only the selected production data component');
  assert.ok(auth>0&&auth<baseline&&baseline<publish);
  const authBlock=publisher.slice(auth,baseline);
  assert.match(authBlock,/GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(authBlock,/R2_PRODUCTION|CATALOG_PROMOTION_KEY/);
  assert.match(publisher,/REGIONAL_INPUT_RECEIPT_SHA256/);
  assert.match(publisher,/REGIONAL_POINT_RECEIPT_SHA256/);
  assert.match(publisher,/CORE_INPUT_MANIFEST_SHA256/);
  assert.match(publisher,/echo "status=\$status"/);
});

test('whole maintenance publisher remains single and waits on all existing artifacts',()=>{
  assert.equal((bake.match(/run: bash ops\/bake-weatherx\.sh/g)||[]).length,1);
  assert.match(bake,/group: weatherx-data-maintenance/);
  for(const model of all){
    const dependency=coreModels.includes(model)?`core-${model}`:`regional-${model}`;
    assert.match(bake,new RegExp(`needs: \\[[^\\]]*${dependency}`));
  }
  assert.match(bake,/pattern: core-model-packs-\*/);
  assert.match(bake,/pattern: regional-packs-\*/);
});

test('summary keeps each model outcome independent',()=>{
  const summary=bake.split('\n  component-publish-status:')[1].split('\n  bake:')[0];
  assert.ok(summary);
  for(const model of all){
    assert.match(summary,new RegExp(`publish-${model}`));
  }
  assert.match(summary,/published\|unchanged\|withheld\|failed/);
  assert.doesNotMatch(summary,/exit 1.*failed|needs\..*result == 'success'.*needs\..*result == 'success'/s);
});
