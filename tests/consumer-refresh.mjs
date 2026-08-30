import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInputs, normalizedBindings, assertSettings, activeVersion, transaction, verifiedObject, requireFreshDescriptor, saveReceipt, boundedTimeout } from '../tools/consumer-refresh.mjs';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('immutable inputs reject branch names, traversal and injected flags', () => {
  validateInputs('e'.repeat(40), 'cycle-33333979833');
  for (const sha of ['master', 'e'.repeat(39), '--help']) assert.throws(() => validateInputs(sha, 'cycle-1'));
  for (const release of ['../x', 'a/b', '--help', 'x'.repeat(97)]) assert.throws(() => validateInputs('e'.repeat(40), release));
});
const config = {compatibility_date:'2026-08-28', compatibility_flags:['nodejs_compat'], vars:{AUTH_MODE:'public', DATA_CATALOG_MODE:'serve'}, secrets:{required:['AUTH_HASH_KEY']}, r2_buckets:[{binding:'DATA_BUCKET',bucket_name:'weatherx-data-production'}]};
const settings = {compatibility_date:config.compatibility_date, compatibility_flags:config.compatibility_flags, bindings:[{type:'plain_text',name:'AUTH_MODE',text:'public'},{type:'plain_text',name:'DATA_CATALOG_MODE',text:'serve'},{type:'secret_text',name:'AUTH_HASH_KEY'},{type:'r2_bucket',name:'DATA_BUCKET',bucket_name:'weatherx-data-production'}]};
test('settings equality preserves vars, secret names and resource identities', () => {
  assertSettings(config,settings);
  for(const mutate of [s=>s.bindings[0].text='enforce',s=>s.bindings.pop(),s=>s.bindings.push({type:'plain_text',name:'BILLING_MODE',text:'enabled'}),s=>s.bindings[3].bucket_name='staging',s=>s.compatibility_date='2026-08-30']) {
    const changed=structuredClone(settings);mutate(changed);assert.throws(()=>assertSettings(config,changed));
  }
  assert.equal(JSON.stringify(normalizedBindings(settings.bindings)).includes('secret-value'),false);
});
test('meaningful resource restrictions cannot disappear from normalization',()=>{
  for(const [base,extra] of [[{name:'R2',type:'r2_bucket',bucket_name:'x'},{jurisdiction:'eu'}],[{name:'MAIL',type:'send_email'},{allowed_destination_addresses:['test@example.invalid']}],[{name:'Q',type:'queue',queue_name:'queue'},{delivery_delay:300}]]) {
    assert.notDeepEqual(normalizedBindings([base]),normalizedBindings([{...base,...extra}]));
  }
  assert.throws(()=>normalizedBindings([{name:'R2',type:'r2_bucket',bucket_name:'x',unknown_security_restriction:true}]));
});
test('every request is bounded by operation deadline with rollback reserve handled separately',()=>{
  assert.equal(boundedTimeout(30_000,100_000,99_000),1000);
  assert.throws(()=>boundedTimeout(30_000,100_000,100_000));
  assert.equal(boundedTimeout(30_000,340_000,100_000),30_000);
});
test('deployment selection requires a single full version and chronological newest deployment', () => {
  const id='12345678-1234-1234-1234-123456789abc';
  assert.equal(activeVersion({deployments:[{created_on:'2026-08-29',versions:[{version_id:'22345678-1234-1234-1234-123456789abc',percentage:100}]},{created_on:'2026-08-30',versions:[{version_id:id,percentage:100}]}]}),id);
  assert.throws(()=>activeVersion({deployments:[]}));
  assert.throws(()=>activeVersion({deployments:[{created_on:'2026-08-30',versions:[{version_id:id,percentage:50}]}]}));
});
test('manifest bytes enforce exact hash and size', () => {
  const bytes=Buffer.from('test'); const record={bytes:4,sha256:'9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'};
  assert.doesNotThrow(()=>verifiedObject(bytes,record));
  assert.throws(()=>verifiedObject(Buffer.from('fail'),record));
  assert.throws(()=>verifiedObject(bytes,{...record,bytes:3}));
  assert.throws(()=>verifiedObject(bytes,undefined));
});
test('freshness bounds acquisition age rather than future forecast valid time',()=>{
  const now=Date.parse('2026-08-30T23:00:00Z');
  requireFreshDescriptor({freshUntil:'2026-08-31T06:00:00Z'},now);
  assert.throws(()=>requireFreshDescriptor({freshUntil:'2026-08-30T23:15:00Z'},now));
  assert.throws(()=>requireFreshDescriptor({freshUntil:'invalid'},now));
});
test('receipt creates a private parent on a fresh runner',()=>{
  const root=mkdtempSync(join(tmpdir(),'consumer-receipt-test-'));
  try{const path=join(root,'new-directory','receipt.json');saveReceipt(path,{status:'test'});assert.deepEqual(JSON.parse(readFileSync(path)),{status:'test'});}finally{rmSync(root,{recursive:true});}
});
test('transaction verifies after both updates and does not roll back success',async()=>{
  const calls=[]; await transaction(['platform','data'],{deploy:async x=>calls.push(x),verify:async()=>calls.push('verify'),rollback:async x=>calls.push('undo '+x)});
  assert.deepEqual(calls,['platform','data','verify']);
});
test('ambiguous deploy failure attempts reverse rollback including failed target',async()=>{
  const calls=[]; await assert.rejects(transaction(['platform','data'],{deploy:async x=>{calls.push(x);if(x==='data')throw Error('failed')},verify:async()=>calls.push('verify'),rollback:async x=>calls.push('undo '+x)}));
  assert.deepEqual(calls,['platform','data','undo data','undo platform']);
});
test('failed postcheck rolls back both; rollback failure is not success',async()=>{
  const calls=[]; await assert.rejects(transaction(['platform','data'],{deploy:async x=>calls.push(x),verify:async()=>{throw Error('postcheck')},rollback:async x=>{calls.push('undo '+x);if(x==='data')throw Error('rollback failed')}}),/rollback/);
  assert.deepEqual(calls,['platform','data','undo data','undo platform']);
});
