import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
const lane=read('.github/workflows/resume-model-publication.yml');
const publisher=read('.github/workflows/publish-current-model-production.yml');
test('resume is manual main, one fixed retained run, and no duplicate acquisition',()=>{
  assert.match(lane,/workflow_dispatch:/);assert.doesNotMatch(lane,/schedule:|workflow_run:|push:/);
  assert.match(lane,/github\.ref == 'refs\/heads\/main'/);
  assert.match(lane,/retained_run_id: '34000676897'/);
  assert.match(lane,/max-parallel: 11/);assert.match(lane,/fail-fast: false/);
  assert.doesNotMatch(lane,/steps:|run:|collect-core|collect-regional|bake-weatherx|secrets:\s*inherit/);
  assert.equal((lane.match(/uses:/g)||[]).length,1);
  assert.match(lane,/uses: \.\/\.github\/workflows\/publish-current-model-production.yml/);
});
test('retained publication preserves the authenticated original producer run',()=>{
  assert.match(publisher,/--retained-run-id "\$RETAINED_RUN_ID"/);
  assert.match(publisher,/CORE_INPUT_RUN_ID="\$producer_run"/);
  assert.match(publisher,/REGIONAL_INPUT_RUN_ID="\$producer_run"/);
  assert.doesNotMatch(publisher,/(?:CORE|REGIONAL)_INPUT_RUN_ID="\$GITHUB_RUN_ID"/);
});
test('retained mode has additional exact workflow and run guards before credentials',()=>{
  const guard=publisher.split('        run: |\n')[1].split('\n      - name:')[0];
  const env={...process.env,GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',GITHUB_REF:'refs/heads/main',
    GITHUB_EVENT_NAME:'workflow_dispatch',ENABLED:'true',APPROVED_SHA:'a'.repeat(40),ATMOS_SHA:'a'.repeat(40),
    UNQUALIFIED_PLACEHOLDER_SHA:'b'.repeat(40),COMPONENT_KIND:'regional',MODEL:'icon',RETAINED_RUN_ID:'34000676897',
    GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/resume-model-publication.yml@refs/heads/main'};
  const run=e=>spawnSync('bash',['-e','-u','-c',guard],{env:e,encoding:'utf8'});
  assert.equal(run(env).status,0);
  for(const change of [{RETAINED_RUN_ID:'34000676898'}, {GITHUB_EVENT_NAME:'schedule'},
    {GITHUB_WORKFLOW_REF:'Andrewegao/v3t7kq-cycle/.github/workflows/bake.yml@refs/heads/main'},
    {GITHUB_REF:'refs/heads/test'}, {APPROVED_SHA:'c'.repeat(40)}])assert.notEqual(run({...env,...change}).status,0);
});
