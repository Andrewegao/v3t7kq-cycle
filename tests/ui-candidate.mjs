import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gate, FREEZE_UNTIL, REPOSITORY, hash, createCandidate, validateCandidate, readTree,
  validateFiles, safePath, seal, unseal, restore, eligibleRun } from '../tools/ui-candidate.mjs';
import { configurationDigest, pipelineDigest } from '../tools/ui-release.mjs';

const key='ab'.repeat(32), sha='c'.repeat(40), workflow='d'.repeat(40), now=Date.parse('2026-09-01T12:00Z');
function fixture({ ground = false } = {}) {
  const root=mkdtempSync(resolve(tmpdir(),'wx-ui-artifact-test-'));
  const content={'index.html':'<title>WeatherX</title><div id="root"></div>',
    '_worker.js':'export default {fetch: () => new Response("private function implementation")}',
    '_routes.json':'{"version":1,"include":["/api/*"],"exclude":[]}', 'assets/app.js':'public app'};
  const digest=createHash('sha256');
  for(const path of Object.keys(content).sort()){
    const raw=Buffer.from(content[path]);digest.update(path).update('\0').update(String(raw.length)).update('\0').update(raw).update('\0');
    mkdirSync(resolve(root,path,'..'),{recursive:true});writeFileSync(resolve(root,path),raw);
  }
  if (ground) {
    mkdirSync(resolve(root,'basemap-ground/0/0'),{recursive:true});
    writeFileSync(resolve(root,'basemap-ground/0/0/0.jpg'),Buffer.from('reviewed-staging-ground'));
  }
  const receipt={schemaVersion:1,gitSha:sha,workflowRunId:'123',releaseId:`git-${sha.slice(0,12)}-run-123`,
    shellSha256:digest.digest('hex'),indexSha256:hash(content['index.html']),shellFileCount:4,
    shellBytes:Object.values(content).reduce((n,v)=>n+Buffer.byteLength(v),0)};
  mkdirSync(resolve(root,'health'));writeFileSync(resolve(root,'health/release.json'),JSON.stringify(receipt));
  const c=createCandidate(root,{sourceSha:sha,runId:'123',attempt:'1',workflowSha:workflow,pipelineDigest:pipelineDigest()});
  c.qualification={origin:'https://staging.weatherx.org',artifactDigest:c.artifactDigest,
    qualifiedAt:new Date(now-60000).toISOString(),deploymentId:'12345678-1234-1234-1234-123456789abc',
    fullTests:true,weatherLab:true,builtRuntime:true,probes:3};
  return {root,c};
}
const runFixture=()=>({id:123,repository:{full_name:REPOSITORY},path:'.github/workflows/ui-staging.yml',
  event:'workflow_dispatch',head_branch:'main',status:'completed',conclusion:'success',run_attempt:1,head_sha:workflow});
const artifactsFixture=()=>[{id:456,name:'ui-candidate-123-1',expired:false,expires_at:'2026-10-01T00:00Z'}];
const check=(c,r=runFixture(),a=artifactsFixture())=>eligibleRun(r,a,{runId:'123',sourceSha:sha,digest:c.artifactDigest,pipelineDigest:pipelineDigest(),candidate:c},now);
test('disabled, missing or pre-expiry activation fails closed even with all other inputs',()=>{
  const env={GITHUB_REPOSITORY:REPOSITORY,GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',
    UI_RELEASES_ENABLED:'true',UI_ISOLATION_APPROVED:'true',UI_DEPLOYMENT_HOLD_UNTIL:FREEZE_UNTIL};
  gate(env,now);
  for(const [k,v] of Object.entries({GITHUB_REPOSITORY:'other/repo',GITHUB_EVENT_NAME:'schedule',GITHUB_REF:'refs/heads/feature',
    UI_RELEASES_ENABLED:'false',UI_ISOLATION_APPROVED:'false',UI_DEPLOYMENT_HOLD_UNTIL:''}))assert.throws(()=>gate({...env,[k]:v},now));
  assert.throws(()=>gate(env,Date.parse(FREEZE_UNTIL)-1));
  assert.throws(()=>gate({...env,UI_DEPLOYMENT_HOLD_UNTIL:'2026-01-01T00:00Z'},Date.parse(FREEZE_UNTIL)-1));
  assert.throws(()=>gate({...env,UI_DEPLOYMENT_HOLD_UNTIL:'2026-10-01T00:00Z'},now));
});
test('ciphertext round-trip restores exact tested bytes, not rebuilt source',()=>{
  const {root,c}=fixture(), blob=seal(c,key), decoded=unseal(blob,key);
  assert.deepEqual(decoded,c); assert.ok(!blob.includes(Buffer.from('private function implementation')));
  const dest=resolve(mkdtempSync(resolve(tmpdir(),'wx-ui-restore-test-')),'dist');restore(decoded,dest);
  assert.deepEqual(readTree(dest),readTree(root));assert.throws(()=>restore(decoded,dest));check(decoded);
});
test('ground files remain artifact-authenticated but outside the shell timing receipt',()=>{
  const {c}=fixture({ground:true});
  assert.ok(c.files.some(file=>file.path==='basemap-ground/0/0/0.jpg'));
  assert.doesNotThrow(()=>validateCandidate(c));
  const changed=structuredClone(c),tile=changed.files.find(file=>file.path==='basemap-ground/0/0/0.jpg');
  tile.base64=Buffer.from('changed-ground').toString('base64');tile.bytes=14;tile.sha256=hash(Buffer.from('changed-ground'));
  assert.throws(()=>validateCandidate(changed),'ground bytes remain bound by artifactDigest');
});
test('encryption is randomized and authenticates contents, header, IV and key',()=>{
  const {c}=fixture(), blob=seal(c,key);assert.ok(!blob.equals(seal(c,key)));
  assert.throws(()=>unseal(blob,'cd'.repeat(32)));assert.throws(()=>seal(c,'bad'));
  for(const index of [0,6,18,34,blob.length-1]){const corrupt=Buffer.from(blob);corrupt[index]^=1;assert.throws(()=>unseal(corrupt,key));}
  assert.throws(()=>unseal(blob.subarray(0,20),key));delete c.qualification;assert.throws(()=>seal(c,key));
});
test('path policy excludes traversal, source, data, secrets and source maps',()=>{
  for(const path of ['/etc/passwd','../x','a/../x','a//x','a\\x','a\0x','.env','a/.env.production',
    'data/a.png','data-atmos/a.json','point-series/x','node_modules/x','functions/x.js','src/a.ts','key.pem','assets/a.js.map'])
    assert.throws(()=>safePath(path),path);
  for(const path of ['_worker.js','_routes.json','assets/app-1.js','health/release.json'])assert.equal(safePath(path),path);
});
test('disk inventory rejects symlinks and untracked data',()=>{
  const {root}=fixture();symlinkSync(resolve(root,'index.html'),resolve(root,'alias.html'));assert.throws(()=>readTree(root));
  const other=fixture();mkdirSync(resolve(other.root,'data'));assert.throws(()=>readTree(other.root));
});
test('inventory rejects hash, byte, encoding, duplicate, missing and file/directory collisions',()=>{
  const {c}=fixture();
  const mutations=[f=>f[0].sha256='0'.repeat(64),f=>f[0].bytes++,f=>f[0].base64+='!',
    f=>f.push(f[0]),f=>f.splice(f.findIndex(x=>x.path==='_worker.js'),1),
    f=>f.push({path:'assets',base64:'',bytes:0,sha256:hash('')})];
  for(const mutate of mutations){const files=structuredClone(c.files);mutate(files);assert.throws(()=>validateFiles(files));}
});
test('receipt, profile, exact source and policy are mandatory',()=>{
  const {c}=fixture();
  for(const mutate of [x=>x.sourceSha='e'.repeat(40),x=>x.runId='124',x=>x.controlSha='a'.repeat(40),
    x=>x.profile.account=true,x=>x.profile.expandedModels=true,x=>x.artifactDigest='0'.repeat(64),
    x=>x.pipelineDigest='invalid',x=>x.attempt='$(echo hi)']){
    const bad=structuredClone(c);mutate(bad);assert.throws(()=>validateCandidate(bad));
  }
  const bad=structuredClone(c), f=bad.files.find(f=>f.path==='health/release.json');
  const receipt=JSON.parse(Buffer.from(f.base64,'base64'));receipt.shellSha256='0'.repeat(64);
  const raw=Buffer.from(JSON.stringify(receipt));Object.assign(f,{base64:raw.toString('base64'),bytes:raw.length,sha256:hash(raw)});
  bad.artifactDigest=validateFiles(bad.files).digest;assert.throws(()=>validateCandidate(bad));
});
for(const [field,value] of Object.entries({event:'push',path:'.github/workflows/bake.yml',head_branch:'evil',status:'in_progress',
  conclusion:'failure',run_attempt:2,head_sha:'f'.repeat(40),id:999,repository:{full_name:'attacker/repo'}})){
  test(`promotion rejects wrong run ${field}`,()=>{const {c}=fixture();assert.throws(()=>check(c,{...runFixture(),[field]:value}));});
}
test('missing, duplicate, expired and wrong-attempt artifacts cannot be promoted',()=>{
  const {c}=fixture(), a=artifactsFixture();
  for(const artifacts of [[],[...a,...a],[{...a[0],expired:true}],[{...a[0],expires_at:'2026-01-01T00:00Z'}],[{...a[0],name:'ui-candidate-123-2'}]])
    assert.throws(()=>check(c,runFixture(),artifacts));
});
test('staging gate evidence, freshness and exact artifact binding required',()=>{
  const {c}=fixture();
  for(const [field,value] of Object.entries({origin:'https://evil.example',artifactDigest:'0'.repeat(64),fullTests:false,weatherLab:false,
    builtRuntime:false,probes:1,deploymentId:'unknown',qualifiedAt:'2025-01-01T00:00Z'})){
    const bad=structuredClone(c);bad.qualification[field]=value;assert.throws(()=>check(bad),field);
  }
  const bad=structuredClone(c);bad.pipelineDigest='0'.repeat(64);assert.throws(()=>check(bad));
});
test('Pages config hash ignores deployment pointer but binds settings, domains and source',()=>{
  const p={name:'staging',production_branch:'main',source:null,domains:['staging.weatherx.org'],deployment_configs:{production:{env_vars:{X:{value:'secret'}}}}};
  const original=configurationDigest(p);
  assert.equal(configurationDigest({...p,canonical_deployment:{id:'new'}}),original);
  assert.equal(configurationDigest({...p,domains:[...p.domains]}),original);
  for(const delta of [{source:{type:'github'}},{domains:['weatherx.org']},{deployment_configs:{production:{}}}])
    assert.notEqual(configurationDigest({...p,...delta}),original);
});
