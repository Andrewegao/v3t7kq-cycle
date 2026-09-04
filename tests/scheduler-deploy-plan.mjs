import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,renameSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {deployPlan,schedulerChanged} from '../tools/scheduler-deploy-plan.mjs';
const A='a'.repeat(40),B='b'.repeat(40),event={ref:'refs/heads/main',before:A,after:B};
test('manual dispatch preserves deployment; unchanged runtime skips only deployment',()=>{
  assert.deepEqual(deployPlan('workflow_dispatch',{},B,()=>{throw Error('not needed')}),{deploy:true,reason:'manual'});
  assert.equal(deployPlan('push',event,B,()=>false).deploy,false);
  assert.equal(deployPlan('push',event,B,()=>true).deploy,true);
});
test('missing history, wrong branch/source, errors and unknown result fail closed',()=>{
  for(const e of [{...event,before:'0'.repeat(40)},{...event,before:'main'},{...event,after:A},{...event,ref:'refs/heads/other'}])assert.throws(()=>deployPlan('push',e,B,()=>false));
  assert.throws(()=>deployPlan('push',event,B,()=>{throw Error('missing history')}));
  assert.throws(()=>deployPlan('push',event,B,()=>undefined));
});
test('real git whole-push comparison includes earlier commits and directory renames/deletions',()=>{
  const root=mkdtempSync(join(tmpdir(),'weatherx-scheduler-plan-'));
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
  const commit=()=>{git('add','-A');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');return git('rev-parse','HEAD');};
  try{
    git('init','-q');mkdirSync(join(root,'scheduler'));writeFileSync(join(root,'scheduler','worker.js'),'a');const first=commit();
    writeFileSync(join(root,'workflow.yml'),'pin');const controller=commit();assert.equal(schedulerChanged(first,controller,root),false);
    writeFileSync(join(root,'scheduler','worker.js'),'b');commit();writeFileSync(join(root,'workflow.yml'),'another');const multi=commit();assert.equal(schedulerChanged(controller,multi,root),true);
    renameSync(join(root,'scheduler','worker.js'),join(root,'outside.js'));const moved=commit();assert.equal(schedulerChanged(multi,moved,root),true);
    renameSync(join(root,'outside.js'),join(root,'scheduler','worker.js'));const back=commit();assert.equal(schedulerChanged(moved,back,root),true);
    rmSync(join(root,'scheduler','worker.js'));const removed=commit();assert.equal(schedulerChanged(back,removed,root),true);
    assert.throws(()=>schedulerChanged(A,removed,root));assert.throws(()=>schedulerChanged(removed,first,root));
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('classifier precedes protected deployment and immutable fast-source verification',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/scheduler-deploy.yml',import.meta.url),'utf8');
  assert.match(workflow,/needs: changes\n\s+if: \$\{\{ needs\.changes\.outputs\.deploy == 'true' \}\}/);
  const changes=workflow.split(/^  changes:$/m)[1]?.split(/^  deploy:$/m)[0];
  assert.ok(changes);assert.doesNotMatch(changes,/environment:|secrets\./);assert.match(changes,/fetch-depth: 0/);
  assert.match(workflow,/run: npm run check/);assert.match(workflow,/run: npm run verify:live/);
  const catalog=readFileSync(new URL('../.github/workflows/catalog-bake.yml',import.meta.url),'utf8');
  assert.match(catalog,/ref: a58eff158b56ef2ba25189d2b859315b00893a14/);
  assert.match(catalog,/test "\$\(git rev-parse HEAD\)" = "a58eff158b56ef2ba25189d2b859315b00893a14"/);
});
