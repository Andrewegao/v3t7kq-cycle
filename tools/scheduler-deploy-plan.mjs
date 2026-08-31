// No Cloudflare access. Workflow-only changes run CI without redeploying an
// unchanged scheduler. Explicit manual dispatch retains normal deployment gates.
import assert from 'node:assert/strict';
import {readFileSync,appendFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
const SHA=/^[a-f0-9]{40}$/;
export function deployPlan(eventName,event,sha,compare){
  assert.match(sha??'',SHA);assert.ok(['push','workflow_dispatch'].includes(eventName));
  if(eventName==='workflow_dispatch')return {deploy:true,reason:'manual'};
  assert.equal(event.ref,'refs/heads/main');assert.equal(event.after,sha);
  assert.match(event.before??'',SHA);assert.notEqual(event.before,'0'.repeat(40),'unproven push history');
  const changed=compare(event.before,event.after);
  assert.equal(typeof changed,'boolean');
  return {deploy:changed,reason:changed?'scheduler-tree-changed':'scheduler-tree-unchanged'};
}
export function schedulerChanged(before,after,cwd=process.cwd()){
  for(const sha of [before,after]){
    assert.match(sha,SHA);
    assert.equal(execFileSync('git',['rev-parse','--verify',`${sha}^{commit}`],{cwd,encoding:'utf8',stdio:'pipe'}).trim(),sha);
  }
  execFileSync('git',['merge-base','--is-ancestor',before,after],{cwd,stdio:'pipe'});
  // Entire pushed range, including deletions and renames across the directory.
  const r=spawnSync('git',['diff','--quiet',before,after,'--','scheduler/'],{cwd,stdio:'pipe'});
  assert.ok(!r.error && [0,1].includes(r.status),'scheduler comparison failed');
  return r.status===1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    assert.equal(process.env.GITHUB_REPOSITORY,'Andrewegao/v3t7kq-cycle');
    assert.equal(process.env.GITHUB_REF,'refs/heads/main');
    const result=deployPlan(process.env.GITHUB_EVENT_NAME,JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH)),process.env.GITHUB_SHA,schedulerChanged);
    appendFileSync(process.env.GITHUB_OUTPUT,`deploy=${result.deploy}\n`);
    console.log(JSON.stringify(result));
  }catch{console.error('Scheduler deployment plan refused unverified history');process.exitCode=1;}
}
