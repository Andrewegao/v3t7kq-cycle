import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const bake=read('.github/workflows/bake.yml');
const core=read('.github/workflows/collect-core-model.yml');
const regional=read('.github/workflows/collect-regional-model.yml');
const publisher=read('.github/workflows/publish-current-model-production.yml');
const catalog=read('.github/workflows/catalog-bake.yml');
const coreModels=['ecmwf','gfs','hrrr','aifs'];
const regionalModels=['icon','hrdps','arome-antilles','hrrr-ak','nam','nam-hi','nam-ak'];
const all=[...coreModels,...regionalModels];

test('manual single-model requests collect only that model; schedules still collect all eleven',()=>{
  assert.match(bake,/default: all\n\s+options: \[all, ecmwf, gfs, hrrr, aifs, icon, hrdps, arome-antilles, hrrr-ak, nam, nam-hi, nam-ak\]/);
  const enabled=[];
  for(const model of all){
    const kind=coreModels.includes(model)?'core':'regional';
    const job=bake.split(`\n  ${kind}-${model}:`)[1].split(/\n  [a-z]/)[0];
    const expression=job.match(/    if: \$\{\{ (.+) \}\}/)?.[1];
    const normal=`inputs.model == '' || inputs.model == 'all' || inputs.model == '${model}'`;
    assert.ok(expression.includes(normal), `${model} normal selector changed`);
    enabled.push([model,selection=>Function('inputs',`return ${normal}`)({model:selection})]);
  }
  for(const selection of ['', 'all',...all,'unknown']){
    const actual=enabled.filter(([,accept])=>accept(selection)).map(([model])=>model);
    assert.deepEqual(actual,selection===''||selection==='all'?all:all.includes(selection)?[selection]:[]);
  }
  assert.match(bake,/cron: '30 2,8,14,20 \* \* \*'/);
  // Whole maintenance still requires all FOUR successful core collectors.
  const maintenance=bake.split('\n  bake:')[1];
  for(const model of coreModels)assert.match(maintenance,new RegExp(`needs.core-${model}.result == 'success'`));
});

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
    assert.match(job,/if: \$\{\{ inputs\.staging_wind100_only != true && \(/);
    assert.doesNotMatch(job.replace(/^    if: .*$/m,''),/staging|PAGES|ui-release/i);
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
    UNQUALIFIED_PLACEHOLDER_SHA:'b'.repeat(40),COMPONENT_KIND:'regional',MODEL:'icon',RETAINED_RUN_ID:''};
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

test('point reuse defaults off, selects one model or all, and refuses invalid policy before credentials',()=>{
  const policy=publisher.split('name: select explicitly enabled schema-1 point reuse before credentials')[1].split('\n      - name:')[0];
  const script=policy.split('        run: |\n')[1];
  assert.ok(script);
  assert.ok(publisher.indexOf('id: point_reuse')<publisher.indexOf('secrets.ATMOS_DEPLOY_KEY'));
  assert.match(policy,/vars.CURRENT_RUN_POINT_REUSE_MODEL/);
  const directory=mkdtempSync(join(tmpdir(),'point-reuse-policy-'));
  let attempt=0;
  const run=(selection,model)=>{
    const output=join(directory,String(++attempt));
    const result=spawnSync('bash',['-e','-u','-c',script],{encoding:'utf8',
      env:{...process.env,POINT_REUSE_MODEL:selection,MODEL:model,GITHUB_OUTPUT:output}});
    return {...result,output:result.status===0?readFileSync(output,'utf8'):''};
  };
  try {
    for(const model of all){
      assert.equal(run('',model).output,'enabled=0\n');
      assert.equal(run('all',model).output,'enabled=1\n');
      for(const selected of all){
        assert.equal(run(selected,model).output,`enabled=${selected===model?1:0}\n`);
      }
    }
    for(const invalid of ['true','1','ALL','ecmwf,gfs',' ecmwf','ecmwf\nenabled=1','$(false)']){
      const result=run(invalid,'ecmwf');
      assert.notEqual(result.status,0,invalid);
      assert.equal(result.stdout,'');
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
  assert.match(publisher,/REUSE_ACTIVE_POINT_COMPONENT: \$\{\{ steps.point_reuse.outputs.enabled \}\}/);
  for(const flag of ['REUSE_ACTIVE_MAP_COMPONENT','REUSE_ACTIVE_MAP_OBJECTS','PACK_COMPONENT_OBJECTS']){
    assert.match(publisher,new RegExp(`${flag}: '0'`));
  }
  assert.doesNotMatch(bake,/REUSE_ACTIVE_POINT_COMPONENT/);
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

test('fast-lane publisher shares exact approved source and reuse switch without enabling staging',()=>{
  const policy=catalog.split('name: qualify production source and select schema-1 point reuse before credentials')[1].split('\n      - name:')[0];
  const script=policy.split('        run: |\n')[1];
  assert.ok(catalog.indexOf('id: point_reuse')<catalog.indexOf('secrets.ATMOS_DEPLOY_KEY'));
  assert.match(policy,/vars.CURRENT_RUN_POINT_REUSE_MODEL/);
  assert.match(policy,/vars.CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA/);
  const directory=mkdtempSync(join(tmpdir(),'catalog-point-reuse-policy-'));
  let attempt=0;
  const good={...process.env,GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main',
    GITHUB_EVENT_NAME:'schedule',CATALOG_TARGET:'production',ATMOS_SHA:'a'.repeat(40),
    APPROVED_SHA:'a'.repeat(40),MODEL:'ecmwf',POINT_REUSE_MODEL:'ecmwf'};
  const run=(changes={})=>{
    const output=join(directory,String(++attempt));
    const result=spawnSync('bash',['-e','-u','-c',script],{encoding:'utf8',env:{...good,...changes,GITHUB_OUTPUT:output}});
    return {...result,output:result.status===0?readFileSync(output,'utf8'):''};
  };
  try {
    assert.equal(run().output,'enabled=1\n');
    assert.equal(run({POINT_REUSE_MODEL:''}).output,'enabled=0\n');
    assert.equal(run({POINT_REUSE_MODEL:'all'}).output,'enabled=1\n');
    assert.equal(run({MODEL:'gfs'}).output,'enabled=0\n');
    assert.equal(run({CATALOG_TARGET:'staging',APPROVED_SHA:'',POINT_REUSE_MODEL:'all'}).output,'enabled=0\n');
    assert.equal(run({CATALOG_TARGET:'staging',APPROVED_SHA:'',POINT_REUSE_MODEL:'invalid',
      GITHUB_REF:'refs/heads/staging-candidate'}).output,'enabled=0\n');
    for(const change of [{APPROVED_SHA:''},{APPROVED_SHA:'b'.repeat(40)},{CATALOG_TARGET:'other'},
      {GITHUB_REF:'refs/heads/branch'},{GITHUB_REPOSITORY:'other/repo'},{GITHUB_EVENT_NAME:'pull_request'},
      {POINT_REUSE_MODEL:'true'},{POINT_REUSE_MODEL:'ecmwf,gfs'}]) {
      const result=run(change);assert.notEqual(result.status,0,JSON.stringify(change));assert.equal(result.stdout,'');
    }
  } finally {rmSync(directory,{recursive:true,force:true});}
  const staging=catalog.split('name: Bake, validate, upload, and CAS-promote one staging model')[1].split('\n      - name:')[0];
  assert.doesNotMatch(staging,/REUSE_ACTIVE_POINT_COMPONENT/);
  assert.equal((catalog.match(/REUSE_ACTIVE_POINT_COMPONENT:/g)||[]).length,1);
  for(const flag of ['REUSE_ACTIVE_MAP_COMPONENT','REUSE_ACTIVE_MAP_OBJECTS','PACK_COMPONENT_OBJECTS']){
    assert.match(catalog,new RegExp(`${flag}: '0'`));
  }
  assert.match(catalog,/group: weatherx-component-\$\{\{/);
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

test('aggregate cost receipts are optional and retained only after successful production publication',()=>{
  for(const source of [publisher,catalog]){
    assert.equal((source.match(/POINT_COMPONENT_PUBLISH_METRICS_FILE:/g)||[]).length,1);
    const receipt=source.split('      - name: retain aggregate point costs only after successful')[1].split('\n      - name:')[0];
    assert.ok(receipt);
    assert.match(receipt,/continue-on-error: true/);
    assert.match(receipt,/actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    assert.match(receipt,/path: \$\{\{ runner.temp \}\}\/point-publication-cost.json/);
    assert.match(receipt,/if-no-files-found: ignore/);
    assert.match(receipt,/retention-days: 14/);
    assert.doesNotMatch(receipt,/component-publish.log|always\(\)|secrets\./);
  }
  assert.match(publisher,/name: retain aggregate point costs[^\n]*\n\s+if: \$\{\{ steps.publish.outputs.status == 'published' \}\}/);
  assert.match(catalog,/name: retain aggregate point costs[^\n]*\n\s+if: \$\{\{ success\(\) && env.CATALOG_TARGET == 'production' \}\}/);
  assert.ok(catalog.lastIndexOf('bash ops/bake-model-component.sh')<catalog.indexOf('name: retain aggregate point costs'));
});
