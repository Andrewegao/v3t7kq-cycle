import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, sign} from 'node:crypto';
import {chmod, mkdtemp, readdir, readFile, realpath, symlink, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
  createCloudflarePagesApiAdapter,
  createCloudflareWorkerCommandAdapter,
  createProductionAccountExecutor,
  createProductionReceiptStore,
  createTestEd25519ProductionApprovalAuthority,
  createTestMonotonicProductionLeaseAuthority,
  createTestProductionAccountExecutor,
  ProductionExecutionError,
  productionExecutionApprovalContext,
  PRODUCTION_APPROVAL_KIND,
  PRODUCTION_LEASE_KIND,
  PRODUCTION_MUTATION_CONFIRMATION,
  validateProductionExecutionRequest,
} from '../tools/production-account-execution.mjs';
import {productionReleasePlanDigest} from '../tools/production-account-release.mjs';

const H=character=>character.repeat(64);
function canonical(value){if(Array.isArray(value))return`[${value.map(canonical).join(',')}]`;if(value&&typeof value==='object')return`{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function plan(){return{transactionId:'prod-account-20260916-001',leaseOwner:'release-commander-andrew',contractDigest:H('a'),target:{cloudflareAccountId:'account',workerName:'weatherx-platform-edge-production',pagesProject:'atmos-platform',origin:'https://weatherx.org'},identities:{atmosSha:'a'.repeat(40),controllerSha:'b'.repeat(40),profileDigest:H('b'),pipelineDigest:H('c'),artifactDigest:H('d')},candidateBinding:{bindingDigest:H('e')},stripe:{priceIds:{subscription:'price_live_subscription',pass:'price_live_pass'}}};}
function request(action='prepare-worker',inputReceipt=null){return{schemaVersion:2,kind:'weatherx-production-account-execution-request-v2',mode:'execute',action,plan:plan(),inputReceipt,approval:{payload:{},signature:''}};}
function preparedTransaction(releasePlan=plan()){return{kind:'weatherx-account-worker-transaction-receipt',phase:'prepared',transactionId:releasePlan.transactionId,leaseOwner:releasePlan.leaseOwner,contractDigest:releasePlan.contractDigest,planDigest:productionReleasePlanDigest(releasePlan),plan:structuredClone(releasePlan),candidate:{versionId:'11111111-1111-1111-1111-111111111111',sourceDigest:H('1'),configDigest:H('2')}};}

function memoryReceipts(){const values=new Map();return{values,async create(id,entry){if(values.has(id))throw new ProductionExecutionError('receipt-attempt-exists');values.set(id,[structuredClone(entry)]);},async append(id,expected,entry){const journal=values.get(id);assert.ok(journal);assert.equal(journal.length-1,expected);journal.push(structuredClone(entry));},async read(id){if(!values.has(id))throw new ProductionExecutionError('receipt-not-found');return structuredClone(values.get(id));}};}

function harness({operation,now=Date.parse('2026-09-16T06:05:00.000Z'),leaseExpires='2026-09-16T06:10:00.000Z'}={}){
  const {publicKey,privateKey}=generateKeyPairSync('ed25519');let time=now,acquires=0,reads=0;const receipts=memoryReceipts();
  const approvals=createTestEd25519ProductionApprovalAuthority({publicKey,issuer:'weatherx-release-owner',audience:'weatherx-production-controller',clock:()=>time});
  const leaseClient={async acquire(expected){acquires++;return{schemaVersion:2,kind:PRODUCTION_LEASE_KIND,leaseId:'lease-1',issuer:'weatherx-independent-lease-service',...structuredClone(expected),fencingToken:41,issuedAt:'2026-09-16T06:04:00.000Z',expiresAt:leaseExpires};},async read(){reads++;const expected=leaseClient.expected;return{schemaVersion:2,kind:PRODUCTION_LEASE_KIND,leaseId:'lease-1',issuer:'weatherx-independent-lease-service',...structuredClone(expected),fencingToken:41,issuedAt:'2026-09-16T06:04:00.000Z',expiresAt:leaseExpires};}};
  const originalAcquire=leaseClient.acquire;leaseClient.acquire=async expected=>{leaseClient.expected=structuredClone(expected);return originalAcquire(expected);};
  const leases=createTestMonotonicProductionLeaseAuthority(leaseClient,()=>time);let calls=0;
  const operations=Object.fromEntries(['prepare-worker','activate-worker','recover-worker-activation','recover-worker-rollback','prepare-pages','apply-pages','recover-pages'].map(action=>[action,async(...args)=>{calls++;if(operation)return operation(...args);return preparedTransaction(args[0].plan);} ]));
  const executor=createTestProductionAccountExecutor({testOnly:true,approvalAuthority:approvals,leaseAuthority:leases,receipts,dependencies:{},validatePlan:value=>value,operations});
  function authorize(value,{approvalId='approval-1',issuedAt='2026-09-16T06:00:00.000Z',expiresAt='2026-09-16T06:15:00.000Z'}={}){const expected=productionExecutionApprovalContext(value,value.plan);const payload={schemaVersion:2,kind:PRODUCTION_APPROVAL_KIND,approvalId,issuer:'weatherx-release-owner',audience:'weatherx-production-controller',confirmation:PRODUCTION_MUTATION_CONFIRMATION,...expected,issuedAt,expiresAt};value.approval={payload,signature:sign(null,Buffer.from(canonical(payload)),privateKey).toString('base64')};return value;}
  return{executor,authorize,receipts,get calls(){return calls;},get acquires(){return acquires;},get reads(){return reads;},set time(value){time=value;}};
}

test('request shape has no caller clock or self-asserted lease and requires a signed approval envelope',()=>{
  const value=request();validateProductionExecutionRequest(value);
  assert.throws(()=>validateProductionExecutionRequest({...value,now:0}),/execution-request-invalid/);
  assert.throws(()=>validateProductionExecutionRequest({...value,lease:{held:true}}),/execution-request-invalid/);
  assert.throws(()=>validateProductionExecutionRequest({...value,approval:null}),/approval-envelope-invalid/);
});

test('authenticated success is append-only, fenced, and exact replay is idempotent',async()=>{
  const h=harness({operation:async(_request,_dependencies,_options,session)=>{const proof=await session.recheck();assert.equal(proof.fencingToken,41);return preparedTransaction();}});const value=h.authorize(request());
  const first=await h.executor.execute(value);assert.equal(first.state,'completed');assert.equal(h.calls,1);assert.equal(h.acquires,1);assert.ok(h.reads>=2);
  const journal=await h.receipts.read(first.receiptId);assert.deepEqual(journal.map(entry=>entry.state),['intent','completed']);assert.equal(journal[0].record.lease.fencingToken,41);
  const replay=await h.executor.execute(value);assert.deepEqual(replay,first);assert.equal(h.calls,1);assert.equal(h.acquires,1);
  h.time=Date.parse('2026-09-16T07:00:00.000Z');assert.deepEqual(await h.executor.execute(value),first);assert.equal(h.calls,1);
});

test('production executor rejects test authorities and a lease token must advance for a new attempt',async()=>{
  const h=harness();assert.throws(()=>createProductionAccountExecutor({approvalAuthority:{},leaseAuthority:{},receipts:h.receipts}),/production-approval-authority-required/);
  await h.executor.execute(h.authorize(request(),{approvalId:'approval-first'}));
  await assert.rejects(h.executor.execute(h.authorize(request(),{approvalId:'approval-second'})),/lease-fencing-token-not-monotonic/);
  assert.equal(h.calls,1);
});

test('crash or provider failure becomes recovery-required, leaks no secret, and cannot rerun',async()=>{
  const secret='sk_live_SECRET_CANARY_NEVER_PERSIST';const h=harness({operation:async()=>{throw new Error(secret);}}),value=h.authorize(request());
  await assert.rejects(h.executor.execute(value),error=>error.code==='production-operation-recovery-required'&&!error.message.includes(secret));
  const id=`${value.plan.transactionId}:${value.action}:${value.approval.payload.approvalId}`,journal=await h.receipts.read(id),serialized=JSON.stringify(journal);
  assert.deepEqual(journal.map(entry=>entry.state),['intent','recovery-required']);assert.ok(!serialized.includes(secret));assert.equal(journal[1].record.failure.code,'production-operation-failed');
  await assert.rejects(h.executor.execute(value),error=>error.code==='ambiguous-intent-recovery-required');assert.equal(h.calls,1);
});

test('expired approvals and short leases fail before operation or intent creation',async()=>{
  const expired=harness(),expiredRequest=expired.authorize(request(),{expiresAt:'2026-09-16T06:04:00.000Z'});
  await assert.rejects(expired.executor.execute(expiredRequest),/approval-not-current/);assert.equal(expired.calls,0);assert.equal(expired.receipts.values.size,0);
  const short=harness({leaseExpires:'2026-09-16T06:05:30.000Z'}),shortRequest=short.authorize(request());
  await assert.rejects(short.executor.execute(shortRequest),/lease-insufficient-remaining-time/);assert.equal(short.calls,0);assert.equal(short.receipts.values.size,0);
});

test('prepared receipts are reloaded by immutable reference and rebound to the authorized plan',async()=>{
  const h=harness(),transaction=preparedTransaction(),sourceId='prod-account-20260916-001:prepare-worker:approval-source';await h.receipts.create(sourceId,{sequence:0,state:'intent',record:{requestDigest:H('4')}});await h.receipts.append(sourceId,0,{sequence:1,state:'completed',record:{transaction}});
  const reference={receiptId:sourceId,digest:(await import('node:crypto')).createHash('sha256').update(canonical(transaction)).digest('hex')};const good=h.authorize(request('activate-worker',reference),{approvalId:'approval-activation'});
  await h.executor.execute(good);assert.equal(h.calls,1);
  const badTransaction=preparedTransaction({...plan(),leaseOwner:'foreign-owner'}),badId='prod-account-20260916-001:prepare-worker:approval-bad';await h.receipts.create(badId,{sequence:0,state:'intent',record:{requestDigest:H('5')}});await h.receipts.append(badId,0,{sequence:1,state:'completed',record:{transaction:badTransaction}});
  const badRef={receiptId:badId,digest:(await import('node:crypto')).createHash('sha256').update(canonical(badTransaction)).digest('hex')};const bad=h.authorize(request('activate-worker',badRef),{approvalId:'approval-wrong-receipt'});
  await assert.rejects(h.executor.execute(bad),/input-receipt-owner-mismatch/);assert.equal(h.calls,1);
});

test('production activation operation rereads the exact prepared Worker version before activation',async()=>{
  const source=await readFile(new URL('../tools/production-account-execution.mjs',import.meta.url),'utf8');const operation=source.slice(source.indexOf("async'activate-worker'"),source.indexOf("async'recover-worker-activation'"));
  assert.ok(operation.indexOf('readVersion(input.candidate.versionId)')<operation.indexOf('activatePreparedWorker(input'));
  assert.match(operation,/prepared-worker-version-readback-mismatch/);
});

test('an orphaned intent refuses rerun and demands an explicit recovery action',async()=>{
  const h=harness(),value=h.authorize(request(),{approvalId:'approval-orphan'}),id=`${value.plan.transactionId}:${value.action}:approval-orphan`;await h.receipts.create(id,{sequence:0,state:'intent',record:{requestDigest:value.approval.payload.requestDigest}});
  await assert.rejects(h.executor.execute(value),error=>error.code==='ambiguous-intent-recovery-required');assert.equal(h.calls,0);assert.equal(h.acquires,0);
});

test('approval signature, issuer, audience, request digest and input digest are authenticated',async()=>{
  for(const mutate of[
    value=>{value.approval.signature=Buffer.alloc(64).toString('base64');},
    value=>{value.approval.payload.issuer='caller';},
    value=>{value.approval.payload.audience='another-controller';},
    value=>{value.approval.payload.requestDigest=H('9');},
    value=>{value.approval.payload.inputReceiptDigest=H('8');},
  ]){const h=harness(),value=h.authorize(request());mutate(value);await assert.rejects(h.executor.execute(value));assert.equal(h.calls,0);assert.equal(h.acquires,0);}
});

test('concrete Worker command adapter uses argument arrays, validates exact responses and never exposes command stderr',async()=>{
  const secret='SECRET_CANARY_STDERR',calls=[],candidate={versionId:'22222222-2222-2222-2222-222222222222',sourceDigest:H('1'),configDigest:H('2')};
  const deployment={workerName:'weatherx-platform-edge-production',versionId:'old',deploymentId:'deploy-old',configDigest:H('3'),etag:'etag-1',mutationOwner:null};
  const options={workerName:deployment.workerName,wranglerPath:'/repo/node_modules/wrangler/bin/wrangler.js',cwd:'/repo/platform/edge',configPath:'/repo/platform/edge/wrangler.jsonc',readDeployment:async()=>structuredClone(deployment),readVersion:async()=>structuredClone(candidate),runner:async(command,args,execution)=>{calls.push({command,args,execution});return{stdout:`Worker Version ID: ${candidate.versionId}\n`,stderr:'',exitCode:0};}};
  const adapter=createCloudflareWorkerCommandAdapter(options),fence={leaseId:'lease-1',fencingToken:41,expiresAt:'2026-09-16T06:10:00.000Z'};assert.deepEqual(await adapter.uploadVersion({workerName:deployment.workerName,sourceDigest:H('1'),configDigest:H('2'),tag:'prod-account-1',activate:false,fence}),candidate);
  assert.equal(calls[0].command,process.execPath);assert.ok(calls[0].args.includes('versions')&&calls[0].args.includes('upload'));assert.equal(calls[0].execution.fence.fencingToken,41);
  const failed=createCloudflareWorkerCommandAdapter({...options,runner:async()=>({stdout:'',stderr:secret,exitCode:1})});await assert.rejects(failed.uploadVersion({workerName:deployment.workerName,sourceDigest:H('1'),configDigest:H('2'),tag:'prod-account-1',activate:false,fence}),error=>error.code==='cloudflare-command-failed'&&!error.message.includes(secret));
  const throwing=createCloudflareWorkerCommandAdapter({...options,runner:async()=>{throw new Error(secret);}});await assert.rejects(throwing.uploadVersion({workerName:deployment.workerName,sourceDigest:H('1'),configDigest:H('2'),tag:'prod-account-1',activate:false,fence}),error=>error.code==='cloudflare-command-failed'&&!error.message.includes(secret)&&!error.cause);
  const malformed=createCloudflareWorkerCommandAdapter({...options,runner:async()=>({stdout:{secret},stderr:'',exitCode:0})});await assert.rejects(malformed.uploadVersion({workerName:deployment.workerName,sourceDigest:H('1'),configDigest:H('2'),tag:'prod-account-1',activate:false,fence}),error=>error.code==='cloudflare-command-response-invalid'&&!error.message.includes(secret)&&!error.cause);
  const extra=createCloudflareWorkerCommandAdapter({...options,readDeployment:async()=>({...deployment,secret})});await assert.rejects(extra.readDeployment(),error=>error.code==='worker-deployment-response-invalid'&&!error.message.includes(secret));
  const wrongVersion=createCloudflareWorkerCommandAdapter({...options,readVersion:async()=>({...candidate,versionId:'33333333-3333-3333-3333-333333333333'})});await assert.rejects(wrongVersion.readVersion(candidate.versionId),error=>error.code==='worker-version-target-invalid');
});

test('concrete Pages adapter exact-key and project allowlists reject confused or secret-bearing responses',async()=>{
  const snapshot={projectName:'atmos-platform',configDigest:H('1'),canonicalDeploymentId:'pages-old',etag:'pages-etag',mutationOwner:null,payload:{deployment_configs:{}}},fence={leaseId:'lease-1',fencingToken:41,expiresAt:'2026-09-16T06:10:00.000Z'};
  const adapter=createCloudflarePagesApiAdapter({projectName:'atmos-platform',readProject:async()=>structuredClone(snapshot),patchProject:async()=>({acceptedProject:'atmos-platform'})});
  await adapter.updateProject({projectName:'atmos-platform',payload:snapshot.payload,configDigest:H('2'),expectedEtag:'pages-etag',owner:'owner',fence});
  const confused=createCloudflarePagesApiAdapter({projectName:'atmos-platform',readProject:async()=>({...snapshot,projectName:'staging-project'}),patchProject:async()=>({acceptedProject:'atmos-platform'})});await assert.rejects(confused.readProject(),/pages-project-target-invalid/);
  const secret='SECRET_CANARY_PAGES';const bearing=createCloudflarePagesApiAdapter({projectName:'atmos-platform',readProject:async()=>({...snapshot,secret}),patchProject:async()=>({acceptedProject:'atmos-platform'})});await assert.rejects(bearing.readProject(),error=>error.code==='pages-project-response-invalid'&&!error.message.includes(secret));
  const throwing=createCloudflarePagesApiAdapter({projectName:'atmos-platform',readProject:async()=>{throw new Error(secret);},patchProject:async()=>({acceptedProject:'atmos-platform'})});await assert.rejects(throwing.readProject(),error=>error.code==='pages-project-read-failed'&&!error.message.includes(secret)&&!error.cause);
});

test('filesystem journal is append-only, create-if-absent, no-follow and mode-0700 anchored',async()=>{
  const anchor=await realpath(await mkdtemp(join(tmpdir(),'weatherx-receipt-anchor-')));await chmod(anchor,0o700);const store=await createProductionReceiptStore(join(anchor,'receipts'),{trustedRoot:anchor});
  await store.create('attempt-1',{sequence:0,state:'intent',record:{state:'intent',safe:true}});await store.append('attempt-1',0,{sequence:1,state:'completed',record:{state:'completed',safe:true}});assert.deepEqual((await store.read('attempt-1')).map(item=>item.state),['intent','completed']);
  await assert.rejects(store.create('attempt-1',{sequence:0,state:'intent',record:{state:'intent'}}),error=>error.code==='receipt-attempt-exists');await assert.rejects(store.append('attempt-1',0,{sequence:1,state:'completed',record:{state:'completed'}}),/receipt-sequence-conflict/);
  const [folder]=await readdir(join(anchor,'receipts')),files=await readdir(join(anchor,'receipts',folder));await unlink(join(anchor,'receipts',folder,files[1]));await symlink('/dev/null',join(anchor,'receipts',folder,files[1]));await assert.rejects(store.read('attempt-1'));
  const persisted=await readFile(join(anchor,'receipts',folder,files[0]),'utf8');assert.ok(!persisted.includes('SECRET'));
});
