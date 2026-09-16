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
  createEd25519ProductionApprovalAuthority,
  createMonotonicProductionLeaseAuthority,
  createProductionFenceAcknowledgementAuthority,
  createProductionReceiptStore,
  createTestEd25519ProductionApprovalAuthority,
  createTestFenceAcknowledgementAuthority,
  createTestMonotonicProductionLeaseAuthority,
  createTestProductionAccountExecutor,
  ProductionExecutionError,
  productionExecutionApprovalContext,
  PRODUCTION_APPROVAL_KIND,
  PRODUCTION_FENCE_ACK_KIND,
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

function harness({operation,tamperLease,now=Date.parse('2026-09-16T06:05:00.000Z'),leaseExpires='2026-09-16T06:10:00.000Z'}={}){
  const {publicKey,privateKey}=generateKeyPairSync('ed25519'),leaseKeys=generateKeyPairSync('ed25519');let time=now,acquires=0,reads=0;const receipts=memoryReceipts(),tokens=new Map(),leasesById=new Map();
  const approvals=createTestEd25519ProductionApprovalAuthority({publicKey,issuer:'weatherx-release-owner',audience:'weatherx-production-controller',clock:()=>time});
  const envelope=payload=>({payload,signature:sign(null,Buffer.from(canonical(payload)),leaseKeys.privateKey).toString('base64')});
  const leaseClient={async acquire(expected){acquires++;const predecessorToken=tokens.get(expected.resourceNamespace)??40,fencingToken=predecessorToken+1;tokens.set(expected.resourceNamespace,fencingToken);const payload={schemaVersion:3,kind:PRODUCTION_LEASE_KIND,leaseId:`lease-${fencingToken}`,...structuredClone(expected),predecessorToken,fencingToken,issuedAt:'2026-09-16T06:04:00.000Z',expiresAt:leaseExpires};leasesById.set(payload.leaseId,payload);const signed=envelope(payload);return tamperLease?tamperLease(signed):signed;},async read(leaseId){reads++;return envelope(leasesById.get(leaseId));}};
  const newLeases=()=>createTestMonotonicProductionLeaseAuthority({client:leaseClient,publicKey:leaseKeys.publicKey,issuer:'weatherx-independent-lease-service',audience:'weatherx-production-controller',clock:()=>time});let calls=0;
  const operations=Object.fromEntries(['prepare-worker','recover-worker-preparation','activate-worker','recover-worker-activation','recover-worker-rollback','prepare-pages','apply-pages','recover-pages'].map(action=>[action,async(...args)=>{calls++;if(operation)return operation(...args);return preparedTransaction(args[0].plan);} ]));
  const newExecutor=()=>createTestProductionAccountExecutor({testOnly:true,approvalAuthority:approvals,leaseAuthority:newLeases(),receipts,dependencies:{},validatePlan:value=>value,operations});const executor=newExecutor();
  function authorize(value,{approvalId='approval-1',issuedAt='2026-09-16T06:00:00.000Z',expiresAt='2026-09-16T06:15:00.000Z'}={}){const expected=productionExecutionApprovalContext(value,value.plan);const payload={schemaVersion:2,kind:PRODUCTION_APPROVAL_KIND,approvalId,issuer:'weatherx-release-owner',audience:'weatherx-production-controller',confirmation:PRODUCTION_MUTATION_CONFIRMATION,...expected,issuedAt,expiresAt};value.approval={payload,signature:sign(null,Buffer.from(canonical(payload)),privateKey).toString('base64')};return value;}
  return{executor,authorize,receipts,restartExecutor:newExecutor,get calls(){return calls;},get acquires(){return acquires;},get reads(){return reads;},set time(value){time=value;}};
}

function acknowledgementHarness(){const keys=generateKeyPairSync('ed25519'),issuer='weatherx-test-mutation-broker',audience='weatherx-production-controller';const authority=createTestFenceAcknowledgementAuthority({publicKey:keys.publicKey,issuer,audience});return{authority,sign(reference){const payload={schemaVersion:1,kind:PRODUCTION_FENCE_ACK_KIND,issuer,audience,resourceNamespace:reference.resourceNamespace,leaseId:reference.leaseId,fencingToken:reference.fencingToken,operationDigest:reference.operationDigest,idempotencyKey:reference.idempotencyKey,acknowledgedAt:'2026-09-16T06:04:30.000Z'};return{payload,signature:sign(null,Buffer.from(canonical(payload)),keys.privateKey).toString('base64')};}};}

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

test('production factories reject caller-selected trust roots while the reviewed policy is provisional',()=>{
  const keys=generateKeyPairSync('ed25519');
  assert.throws(()=>createEd25519ProductionApprovalAuthority({publicKey:keys.publicKey}),/production-account-trust-policy-provisional/);
  assert.throws(()=>createEd25519ProductionApprovalAuthority({publicKey:keys.publicKey,issuer:'caller'}),/production-approval-authority-options-invalid/);
  assert.throws(()=>createMonotonicProductionLeaseAuthority({client:{},publicKey:keys.publicKey}),/production-account-trust-policy-provisional/);
  assert.throws(()=>createProductionFenceAcknowledgementAuthority({publicKey:keys.publicKey}),/production-account-trust-policy-provisional/);
  const h=harness();assert.throws(()=>createProductionAccountExecutor({approvalAuthority:{},leaseAuthority:{},receipts:h.receipts}),/production-approval-authority-required/);
});

test('the signed lease service advances one physical-resource fence across attempts',async()=>{
  const h=harness();const first=await h.executor.execute(h.authorize(request(),{approvalId:'approval-first'}));const changed=request();changed.plan.candidateBinding.bindingDigest=H('9');const second=await h.restartExecutor().execute(h.authorize(changed,{approvalId:'approval-second'}));
  assert.equal((await h.receipts.read(first.receiptId))[0].record.lease.fencingToken,41);
  assert.equal((await h.receipts.read(second.receiptId))[0].record.lease.fencingToken,42);
  assert.equal(h.calls,2);
});

test('crash or provider failure becomes recovery-required, leaks no secret, and cannot rerun',async()=>{
  const secret='sk_live_SECRET_CANARY_NEVER_PERSIST';const h=harness({operation:async()=>{throw new Error(secret);}}),value=h.authorize(request());
  await assert.rejects(h.executor.execute(value),error=>error.code==='production-operation-recovery-required'&&!error.message.includes(secret));
  const id=`${value.plan.transactionId}:${value.action}:${value.approval.payload.approvalId}`,journal=await h.receipts.read(id),serialized=JSON.stringify(journal);
  assert.deepEqual(journal.map(entry=>entry.state),['intent','recovery-required']);assert.ok(!serialized.includes(secret));assert.equal(journal[1].record.failure.code,'production-operation-failed');
  await assert.rejects(h.executor.execute(value),error=>error.code==='ambiguous-intent-recovery-required');assert.equal(h.calls,1);
});

test('missing mutation acknowledgement persists the exact pending transaction for query-only recovery',async()=>{
  const mutationReference={schemaVersion:1,kind:'weatherx-production-mutation-reference-v1',operation:'worker-activate-version',target:'worker-target',operationDigest:H('6'),idempotencyKey:'wx-pending-1',resourceNamespace:'cloudflare:account:workers:weatherx-platform-edge-production',leaseId:'lease-41',fencingToken:41};
  const h=harness({operation:async(value,_dependencies,_options,_session,input)=>{
    if(value.action==='prepare-worker')return{...preparedTransaction(),pendingMutation:mutationReference};
    assert.deepEqual(input.pendingMutation,mutationReference);return preparedTransaction(input.plan);
  }}),initial=h.authorize(request(),{approvalId:'approval-pending'}),receiptId=`${initial.plan.transactionId}:prepare-worker:approval-pending`;
  await assert.rejects(h.executor.execute(initial),error=>error.code==='production-operation-recovery-required');
  const journal=await h.receipts.read(receiptId),pending=journal[1].record.transaction;
  assert.equal(journal[1].state,'recovery-required');assert.deepEqual(journal[1].record.mutationReference,mutationReference);
  const digest=(await import('node:crypto')).createHash('sha256').update(canonical(pending)).digest('hex');assert.deepEqual(journal[1].record.reference,{receiptId,digest});
  const recovered=await h.executor.execute(h.authorize(request('recover-worker-activation',journal[1].record.reference),{approvalId:'approval-query-recovery'}));
  assert.equal(recovered.state,'completed');assert.equal(h.calls,2);
});

test('expired approvals and short leases fail before operation or intent creation',async()=>{
  const expired=harness(),expiredRequest=expired.authorize(request(),{expiresAt:'2026-09-16T06:04:00.000Z'});
  await assert.rejects(expired.executor.execute(expiredRequest),/approval-not-current/);assert.equal(expired.calls,0);assert.equal(expired.receipts.values.size,0);
  const short=harness({leaseExpires:'2026-09-16T06:05:30.000Z'}),shortRequest=short.authorize(request());
  await assert.rejects(short.executor.execute(shortRequest),/lease-insufficient-remaining-time/);assert.equal(short.calls,0);assert.equal(short.receipts.values.size,0);
  const forged=harness({tamperLease:envelope=>({...envelope,signature:Buffer.alloc(64).toString('base64')})});await assert.rejects(forged.executor.execute(forged.authorize(request())),/lease-signature-invalid/);assert.equal(forged.calls,0);assert.equal(forged.receipts.values.size,0);
});

test('prepared receipts are reloaded by immutable reference and rebound to the authorized plan',async()=>{
  const h=harness(),transaction=preparedTransaction(),sourceId='prod-account-20260916-001:prepare-worker:approval-source';await h.receipts.create(sourceId,{sequence:0,state:'intent',record:{requestDigest:H('4')}});await h.receipts.append(sourceId,0,{sequence:1,state:'completed',record:{transaction}});
  const reference={receiptId:sourceId,digest:(await import('node:crypto')).createHash('sha256').update(canonical(transaction)).digest('hex')};const good=h.authorize(request('activate-worker',reference),{approvalId:'approval-activation'});
  await h.executor.execute(good);assert.equal(h.calls,1);
  const badTransaction=preparedTransaction({...plan(),leaseOwner:'foreign-owner'}),badId='prod-account-20260916-001:prepare-worker:approval-bad';await h.receipts.create(badId,{sequence:0,state:'intent',record:{requestDigest:H('5')}});await h.receipts.append(badId,0,{sequence:1,state:'completed',record:{transaction:badTransaction}});
  const badRef={receiptId:badId,digest:(await import('node:crypto')).createHash('sha256').update(canonical(badTransaction)).digest('hex')};const bad=h.authorize(request('activate-worker',badRef),{approvalId:'approval-wrong-receipt'});
  await assert.rejects(h.executor.execute(bad),/input-receipt-owner-mismatch/);assert.equal(h.calls,1);
});

test('Worker preparation recovery reloads the durable pre-upload intent instead of rerunning upload',async()=>{
  const expectedPlan=plan(),operationIntent={transactionId:expectedPlan.transactionId,leaseOwner:expectedPlan.leaseOwner,
    contractDigest:expectedPlan.contractDigest,planDigest:productionReleasePlanDigest(expectedPlan),plan:structuredClone(expectedPlan),
    uploadTag:'wx-prod-recovery-bound-tag'};
  const h=harness({operation:async(_request,_dependencies,_options,_session,input)=>{
    assert.deepEqual(input,operationIntent);return preparedTransaction(input.plan);
  }}),sourceId='prod-account-20260916-001:prepare-worker:approval-ambiguous';
  await h.receipts.create(sourceId,{sequence:0,state:'intent',record:{requestDigest:H('4'),operationIntent}});
  await h.receipts.append(sourceId,0,{sequence:1,state:'recovery-required',record:{failure:{code:'production-operation-failed'},recoveryInput:operationIntent}});
  const digest=(await import('node:crypto')).createHash('sha256').update(canonical(operationIntent)).digest('hex');
  const result=await h.executor.execute(h.authorize(request('recover-worker-preparation',{receiptId:sourceId,digest}),{approvalId:'approval-recover-preparation'}));
  assert.equal(result.state,'completed');assert.equal(h.calls,1);
});

test('production activation operation rereads the exact prepared Worker version before activation',async()=>{
  const source=await readFile(new URL('../tools/production-account-execution.mjs',import.meta.url),'utf8');const operation=source.slice(source.indexOf("'activate-worker':"),source.indexOf("'recover-worker-activation':"));
  assert.ok(operation.indexOf('readVersion(input.candidate.versionId)')<operation.indexOf('activatePreparedWorker(input'));
  assert.match(operation,/prepared-worker-version-readback-mismatch/);
});

test('an orphaned intent refuses rerun and demands an explicit recovery action',async()=>{
  const h=harness(),value=h.authorize(request(),{approvalId:'approval-orphan'}),id=`${value.plan.transactionId}:${value.action}:approval-orphan`;await h.receipts.create(id,{sequence:0,state:'intent',record:{requestDigest:value.approval.payload.requestDigest}});
  await assert.rejects(h.executor.execute(value),error=>error.code==='ambiguous-intent-recovery-required');assert.equal(h.calls,0);assert.equal(h.acquires,0);
});

test('maximum component identities produce a valid round-trippable composite receipt reference',async()=>{
  const h=harness(),value=request();value.plan.transactionId=`t${'x'.repeat(158)}`;h.authorize(value,{approvalId:`a${'y'.repeat(158)}`});const result=await h.executor.execute(value);assert.ok(result.receiptId.length>320);validateProductionExecutionRequest(request('activate-worker',result.reference));assert.deepEqual(await h.receipts.read(result.receiptId),h.receipts.values.get(result.receiptId));
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
  const secret='SECRET_CANARY_STDERR',calls=[],acks=acknowledgementHarness(),candidate={versionId:'22222222-2222-2222-2222-222222222222',sourceDigest:H('1'),configDigest:H('2')};
  const deployment={workerName:'weatherx-platform-edge-production',versionId:'old',deploymentId:'deploy-old',configDigest:H('3'),etag:'etag-1',mutationOwner:null};
  const accountId='a89f9a1af485021fbc60a68b163c7c6e',options={testOnly:true,accountId,workerName:deployment.workerName,wranglerPath:'/repo/node_modules/wrangler/bin/wrangler.js',cwd:'/repo/platform/edge',configPath:'/repo/platform/edge/wrangler.jsonc',fenceAcknowledgementAuthority:acks.authority,readFenceAcknowledgement:async()=>{throw new Error('missing');},readResolvedConfig:async()=>({accountId,workerName:deployment.workerName,environment:'production'}),readDeployment:async()=>structuredClone(deployment),readVersion:async()=>structuredClone(candidate),listVersionsByTag:async tag=>[{versionId:candidate.versionId,tag}],runner:async(command,args,execution)=>{calls.push({command,args,execution});return{stdout:`Worker Version ID: ${candidate.versionId}\n`,stderr:'',exitCode:0,fenceAcknowledgement:acks.sign(execution.operationReference)};}};
  const adapter=createCloudflareWorkerCommandAdapter(options),fence={leaseId:'lease-41',fencingToken:41,expiresAt:'2026-09-16T06:10:00.000Z',resourceNamespace:`cloudflare:${accountId}:workers:${deployment.workerName}`},mutationContext={approvalId:'approval-1',requestDigest:H('9')};assert.deepEqual((await adapter.uploadVersion({workerName:deployment.workerName,sourceDigest:H('1'),configDigest:H('2'),tag:'prod-account-1',activate:false,mutationContext,fence})).result,candidate);
  assert.equal(calls[0].command,process.execPath);assert.ok(calls[0].args.includes('versions')&&calls[0].args.includes('upload'));assert.equal(calls[0].execution.fence.fencingToken,41);
  const exactSpec={workerName:deployment.workerName,sourceDigest:H('1'),configDigest:H('2'),tag:'prod-account-1',activate:false,mutationContext,fence},expectedOperationDigest=(await import('node:crypto')).createHash('sha256').update(canonical({operation:'worker-upload-version',target:`worker:${deployment.workerName}`,spec:exactSpec})).digest('hex');assert.equal(calls[0].execution.operationReference.operationDigest,expectedOperationDigest);
  assert.deepEqual(calls[0].args.slice(-8),['--message','WeatherX prod-account-1','--name',deployment.workerName,'--config',options.configPath,'--env','production']);
  const failed=createCloudflareWorkerCommandAdapter({...options,runner:async()=>({stdout:'',stderr:secret,exitCode:1,fenceAcknowledgement:{}})});await assert.rejects(failed.uploadVersion({workerName:deployment.workerName,sourceDigest:H('1'),configDigest:H('2'),tag:'prod-account-1',activate:false,mutationContext,fence}),error=>error.code==='mutation-acknowledgement-unavailable'&&!error.message.includes(secret));
  const throwing=createCloudflareWorkerCommandAdapter({...options,runner:async()=>{throw new Error(secret);}});await assert.rejects(throwing.uploadVersion({workerName:deployment.workerName,sourceDigest:H('1'),configDigest:H('2'),tag:'prod-account-1',activate:false,mutationContext,fence}),error=>error.code==='mutation-acknowledgement-unavailable'&&!error.message.includes(secret)&&!error.cause);
  const malformed=createCloudflareWorkerCommandAdapter({...options,runner:async()=>({stdout:{secret},stderr:'',exitCode:0,fenceAcknowledgement:{}})});await assert.rejects(malformed.uploadVersion({workerName:deployment.workerName,sourceDigest:H('1'),configDigest:H('2'),tag:'prod-account-1',activate:false,mutationContext,fence}),error=>error.code==='mutation-acknowledgement-unavailable'&&!error.message.includes(secret)&&!error.cause);
  const extra=createCloudflareWorkerCommandAdapter({...options,readDeployment:async()=>({...deployment,secret})});await assert.rejects(extra.readDeployment(),error=>error.code==='worker-deployment-response-invalid'&&!error.message.includes(secret));
  const wrongVersion=createCloudflareWorkerCommandAdapter({...options,readVersion:async()=>({...candidate,versionId:'33333333-3333-3333-3333-333333333333'})});await assert.rejects(wrongVersion.readVersion(candidate.versionId),error=>error.code==='worker-version-target-invalid');
  const before=calls.length,mismatch=createCloudflareWorkerCommandAdapter({...options,readResolvedConfig:async()=>({accountId:'0'.repeat(32),workerName:deployment.workerName,environment:'production'})});await assert.rejects(mismatch.uploadVersion({workerName:deployment.workerName,sourceDigest:H('1'),configDigest:H('2'),tag:'prod-account-1',activate:false,mutationContext,fence}),error=>error.code==='cloudflare-config-target-mismatch');assert.equal(calls.length,before);
  const badAck=createCloudflareWorkerCommandAdapter({...options,runner:async()=>({stdout:`Worker Version ID: ${candidate.versionId}\n`,stderr:'',exitCode:0,fenceAcknowledgement:{payload:{secret},signature:''}})});await assert.rejects(badAck.uploadVersion({workerName:deployment.workerName,sourceDigest:H('1'),configDigest:H('2'),tag:'prod-account-1',activate:false,mutationContext,fence}),error=>!error.message.includes(secret));

  let active=structuredClone(deployment),capturedReference,durable,runs=0;
  const ambiguous=createCloudflareWorkerCommandAdapter({...options,readDeployment:async()=>structuredClone(active),readFenceAcknowledgement:async reference=>{assert.deepEqual(reference,capturedReference);if(!durable)throw new Error('missing');return durable;},runner:async(_command,_args,execution)=>{runs++;capturedReference=execution.operationReference;active={...active,versionId:candidate.versionId,deploymentId:'deploy-candidate',configDigest:candidate.configDigest,etag:'etag-2',mutationOwner:'owner'};return{stdout:'',stderr:'',exitCode:0,fenceAcknowledgement:{}};}});
  await assert.rejects(ambiguous.activateVersion({workerName:deployment.workerName,versionId:candidate.versionId,expectedEtag:'etag-1',owner:'owner',mutationContext,fence}),error=>error.code==='mutation-acknowledgement-unavailable'&&error.mutationReference.operationDigest===capturedReference.operationDigest);
  assert.equal((await ambiguous.readDeployment()).versionId,candidate.versionId);assert.equal(runs,1);
  durable=acks.sign(capturedReference);assert.deepEqual(await ambiguous.readMutationAcknowledgement(capturedReference),durable);assert.equal(runs,1);
  await assert.rejects(ambiguous.readMutationAcknowledgement({...capturedReference,operationDigest:H('8')}),error=>error.code==='mutation-acknowledgement-unavailable');
});

test('concrete Pages adapter exact-key and project allowlists reject confused or secret-bearing responses',async()=>{
  const acks=acknowledgementHarness(),namespace='cloudflare:a89f9a1af485021fbc60a68b163c7c6e:pages:atmos-platform',snapshot={projectName:'atmos-platform',configDigest:H('1'),canonicalDeploymentId:'pages-old',etag:'pages-etag',mutationOwner:null,payload:{deployment_configs:{}}},fence={leaseId:'lease-41',fencingToken:41,expiresAt:'2026-09-16T06:10:00.000Z',resourceNamespace:namespace};
  const patchProject=async({operationReference})=>({acceptedProject:'atmos-platform',fenceAcknowledgement:acks.sign(operationReference)});
  const mutationContext={approvalId:'approval-1',requestDigest:H('9')},adapter=createCloudflarePagesApiAdapter({testOnly:true,accountId:'a89f9a1af485021fbc60a68b163c7c6e',fenceAcknowledgementAuthority:acks.authority,readFenceAcknowledgement:async()=>{throw new Error('missing');},projectName:'atmos-platform',readProject:async()=>structuredClone(snapshot),patchProject});
  await adapter.updateProject({projectName:'atmos-platform',payload:snapshot.payload,configDigest:H('2'),expectedEtag:'pages-etag',owner:'owner',mutationContext,fence});
  const base={testOnly:true,accountId:'a89f9a1af485021fbc60a68b163c7c6e',fenceAcknowledgementAuthority:acks.authority,readFenceAcknowledgement:async()=>{throw new Error('missing');},projectName:'atmos-platform',patchProject};
  const confused=createCloudflarePagesApiAdapter({...base,readProject:async()=>({...snapshot,projectName:'staging-project'})});await assert.rejects(confused.readProject(),/pages-project-target-invalid/);
  const secret='SECRET_CANARY_PAGES';const bearing=createCloudflarePagesApiAdapter({...base,readProject:async()=>({...snapshot,secret})});await assert.rejects(bearing.readProject(),error=>error.code==='pages-project-response-invalid'&&!error.message.includes(secret));
  const throwing=createCloudflarePagesApiAdapter({...base,readProject:async()=>{throw new Error(secret);}});await assert.rejects(throwing.readProject(),error=>error.code==='pages-project-read-failed'&&!error.message.includes(secret)&&!error.cause);

  let current=structuredClone(snapshot),capturedReference,durable,patches=0;
  const ambiguous=createCloudflarePagesApiAdapter({...base,readProject:async()=>structuredClone(current),readFenceAcknowledgement:async reference=>{assert.deepEqual(reference,capturedReference);if(!durable)throw new Error('missing');return durable;},patchProject:async request=>{patches++;capturedReference=request.operationReference;current={...current,configDigest:request.configDigest,payload:structuredClone(request.payload),etag:'pages-etag-2',mutationOwner:request.owner};return{acceptedProject:'atmos-platform',fenceAcknowledgement:{}};}});
  await assert.rejects(ambiguous.updateProject({projectName:'atmos-platform',payload:snapshot.payload,configDigest:H('2'),expectedEtag:'pages-etag',owner:'owner',mutationContext,fence}),error=>error.code==='mutation-acknowledgement-unavailable'&&error.mutationReference.operationDigest===capturedReference.operationDigest);
  assert.equal((await ambiguous.readProject()).configDigest,H('2'));assert.equal(patches,1);
  durable=acks.sign(capturedReference);assert.deepEqual(await ambiguous.readMutationAcknowledgement(capturedReference),durable);assert.equal(patches,1);
});

test('filesystem journal is append-only, create-if-absent, no-follow and mode-0700 anchored',async()=>{
  const anchor=await realpath(await mkdtemp(join(tmpdir(),'weatherx-receipt-anchor-')));await chmod(anchor,0o700);const store=await createProductionReceiptStore(join(anchor,'receipts'),{trustedRoot:anchor});
  await store.create('attempt-1',{sequence:0,state:'intent',record:{state:'intent',safe:true}});await store.append('attempt-1',0,{sequence:1,state:'completed',record:{state:'completed',safe:true}});assert.deepEqual((await store.read('attempt-1')).map(item=>item.state),['intent','completed']);
  await assert.rejects(store.create('attempt-1',{sequence:0,state:'intent',record:{state:'intent'}}),error=>error.code==='receipt-attempt-exists');await assert.rejects(store.append('attempt-1',0,{sequence:1,state:'completed',record:{state:'completed'}}),/receipt-sequence-conflict/);
  const [folder]=await readdir(join(anchor,'receipts')),files=await readdir(join(anchor,'receipts',folder));await unlink(join(anchor,'receipts',folder,files[1]));await symlink('/dev/null',join(anchor,'receipts',folder,files[1]));await assert.rejects(store.read('attempt-1'));
  const persisted=await readFile(join(anchor,'receipts',folder,files[0]),'utf8');assert.ok(!persisted.includes('SECRET'));
});
