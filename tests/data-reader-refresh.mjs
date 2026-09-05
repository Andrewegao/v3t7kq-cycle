import assert from 'node:assert/strict';
import test from 'node:test';
import {generateKeyPairSync,privateDecrypt,createDecipheriv} from 'node:crypto';
import { createTransport,safeFailureDiagnostic,encryptInheritanceDiagnostic } from '../tools/gdacs-feed-release.mjs';
import { execute,recover,assertClosure,CLOSURE,assertVersion,makeOperations,SCRIPT,assertBoundary,versionAnnotations } from '../tools/data-reader-refresh.mjs';
const old='00000000-0000-0000-0000-000000000001',ro='00000000-0000-0000-0000-000000000002',full='00000000-0000-0000-0000-000000000003',foreign='00000000-0000-0000-0000-000000000004';
function fixture(){
  let current=old;const writes=[],events=[],saved=[];
  const runtime={compatibility_date:'2026-08-28',compatibility_flags:['nodejs_compat'],usage_model:'standard'};
  const boundary={data:{runtime,settings:{bindings:[{name:'CATALOG_PROMOTION_KEY',type:'secret_text'}],compatibility_date:'2026-08-28',compatibility_flags:['nodejs_compat'],placement:{},usage_model:'standard',observability:{enabled:true},annotations:{'workers/message':'old'}}},routes:['unchanged'],pages:{id:'same'},platform:{version:'unchanged'}};
  const receipt={status:'preflight-passed',createdAt:new Date().toISOString(),beforeVersion:old,sha:'a'.repeat(40),tag:'owned',boundary,pointers:{catalog:'old',whole:'old'}};
  const detail=(id,kind)=>({id,annotations:versionAnnotations(kind,receipt),resources:{bindings:boundary.data.settings.bindings,script_runtime:runtime,script:{etag:'e'.repeat(64)}}});
  const ops={active:async()=>current,boundary:async()=>structuredClone(boundary),pointers:async()=>({...receipt.pointers}),
    upload:async kind=>{writes.push(`upload:${kind}`);return detail(kind==='readonly'?ro:full,kind);},
    version:async id=>detail(id,id===ro?'readonly':'full'),
    deploy:async id=>{writes.push(`deploy:${id}`);current=id;},
    verify:async kind=>{events.push(`verify:${kind}`);},pause:async()=>{},
  };
  return {receipt,ops,writes,events,saved,persist:()=>saved.push(structuredClone(receipt)),setActive:x=>{current=x;},getActive:()=>current};
}
test('uploads both inactive, proves fallback before full, preserves all protected boundaries',async()=>{
  const f=fixture();await execute(f.receipt,f.ops,f.persist);
  assert.equal(f.receipt.status,'passed');assert.deepEqual(f.writes,[`upload:readonly`,`upload:full`,`deploy:${ro}`,`deploy:${full}`]);
  assert.deepEqual(f.events,['verify:readonly','verify:readonly','verify:readonly','verify:full','verify:full','verify:full']);
  assert.ok(f.saved.some(x=>x.intent.activate==='readonly'&&!x.completedAt));
});
test('changed pointer before activation refuses and leaves old active',async()=>{
  const f=fixture();let n=0;f.ops.pointers=async()=>++n===1?f.receipt.pointers:{catalog:'changed',whole:'old'};
  await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(f.getActive(),old);assert.ok(!f.writes.some(x=>x.startsWith('deploy')));
});
for(const key of ['catalog','whole'])test(`after activation changed ${key} pointer never restores incompatible old reader`,async()=>{
  const f=fixture();const verify=f.ops.verify;f.ops.verify=async kind=>{if(kind==='full'){f.ops.pointers=async()=>({...f.receipt.pointers,[key]:'changed'});throw Error('read failure');}return verify(kind);};
  await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(f.getActive(),ro);assert.equal(f.receipt.publicationPaused,true);assert.equal(f.receipt.recoveryPointers[key],'changed');assert.ok(!f.writes.includes(`deploy:${old}`));
});
test('lost deployment response reconciles own current version',async()=>{
  const f=fixture(),deploy=f.ops.deploy;f.ops.deploy=async id=>{await deploy(id);throw Error('timeout');};
  await execute(f.receipt,f.ops,f.persist);assert.equal(f.receipt.status,'passed');assert.equal(f.getActive(),full);
});
test('partial inactive upload cannot activate or infer ownership',async()=>{
  const f=fixture(),upload=f.ops.upload;f.ops.upload=async kind=>{await upload(kind);throw Error('response lost');};
  await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(f.getActive(),old);assert.equal(f.receipt.recovery,'no-active-mutation');
});
test('version read failure before any activation leaves old active',async()=>{
  const f=fixture();f.ops.version=async()=>{throw Error('read failure');};await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(f.getActive(),old);
});
test('recovery gets a fresh deadline after qualification exhaustion',async()=>{
  const f=fixture();let expired=false,resets=0;const active=f.ops.active;
  f.ops.active=async()=>{if(expired)throw Error('deadline expired');return active();};
  f.ops.verify=async kind=>{if(kind==='full'){expired=true;throw Error('deadline expired');}};
  f.ops.resetRecovery=()=>{expired=false;resets++;};
  await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(resets,1);assert.equal(f.getActive(),ro);
});
test('foreign deployment is never overwritten during containment',async()=>{
  const f=fixture();f.ops.verify=async()=>{f.setActive(foreign);throw Error('foreign deploy');};
  await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(f.getActive(),foreign);assert.equal(f.receipt.recovery,'manual-forward-repair-required');assert.deepEqual(f.writes.filter(x=>x.startsWith('deploy')),[`deploy:${ro}`]);
});
test('settings/UI/route drift blocks both qualification and unsafe recovery',async()=>{
  const f=fixture();f.ops.verify=async()=>{f.ops.boundary=async()=>({...f.receipt.boundary,pages:{id:'foreign'}});throw Error('boundary changed');};
  await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(f.receipt.recovery,'manual-forward-repair-required');assert.ok(!f.writes.includes(`deploy:${old}`));
});
test('fallback refusal fails closed without trying older version',async()=>{
  const f=fixture();f.ops.verify=async()=>{throw Error('all reads unavailable');};await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.equal(f.getActive(),ro);assert.equal(f.receipt.recovery,'manual-forward-repair-required');
});
test('expired preflight produces no writes',async()=>{const f=fixture();f.receipt.createdAt=new Date(0).toISOString();await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.deepEqual(f.writes,[]);});
test('closure admits only exact data modules plus optional fallback wrapper',()=>{
  assertClosure(Object.fromEntries(CLOSURE.map(x=>[x,{}])),'full');
  assert.throws(()=>assertClosure(Object.fromEntries([...CLOSURE,'src/index.ts'].map(x=>[x,{}])),'full'));
  assert.throws(()=>assertClosure(Object.fromEntries(CLOSURE.filter(x=>x!=='src/releasePromotion.ts').map(x=>[x,{}])),'full'));
});
test('version source/tag/binding drift rejected',async()=>{const f=fixture();const v=await f.ops.version(ro);v.resources.bindings=[];assert.throws(()=>assertVersion(v,'readonly',f.receipt));});
test('recorded version ID rejects a different valid UUID with otherwise identical proof',async()=>{
  const f=fixture();f.receipt.versions={readonly:ro};const v=await f.ops.version(ro);
  assertVersion(v,'readonly',f.receipt);v.id=foreign;
  assert.throws(()=>assertVersion(v,'readonly',f.receipt),/recorded version identity changed/);
});
test('only exact owned version annotation delta is allowed; all other settings stay exact',()=>{
  const f=fixture();f.receipt.versions={readonly:ro};const current=structuredClone(f.receipt.boundary);
  current.data.settings.annotations={...versionAnnotations('readonly',f.receipt),'workers/triggered_by':'api'};
  assertBoundary(current,f.receipt);
  current.data.settings.annotations.extra='unexpected';assert.throws(()=>assertBoundary(current,f.receipt));delete current.data.settings.annotations.extra;
  current.data.settings.observability.enabled=false;assert.throws(()=>assertBoundary(current,f.receipt));
});
test('inactive version runtime and returned content identity must remain exact',async()=>{
  const f=fixture();f.receipt.versionEtags={readonly:'e'.repeat(64)};
  const v=await f.ops.version(ro);v.resources.script.etag='f'.repeat(64);assert.throws(()=>assertVersion(v,'readonly',f.receipt));
  v.resources.script.etag='e'.repeat(64);v.resources.script_runtime={...v.resources.script_runtime,usage_model:'bundled'};assert.throws(()=>assertVersion(v,'readonly',f.receipt));
});
test('direct API operations only upload inactive version or deploy exact data script',async()=>{
  const f=fixture(),calls=[];
  const transport={api:async(...args)=>{calls.push(args);return {};}};
  const ops=makeOperations(transport,'unused',{bundles:{readonly:{bytes:Buffer.from('code')}}});
  await ops.upload('readonly',f.receipt);await ops.deploy(ro);
  assert.deepEqual(calls.map(x=>[x[0],x[1],x[2].method]),[[SCRIPT+'/versions?bindings_inherit=strict','DATA_EDGE_TOKEN','POST'],[SCRIPT+'/deployments','DATA_EDGE_TOKEN','POST']]);
  assert.equal(typeof calls[0][2].body.get('metadata'),'string','metadata is an ordinary multipart string field, not a file');
  const metadata=JSON.parse(calls[0][2].body.get('metadata'));
  assert.deepEqual(metadata.bindings,[{name:'CATALOG_PROMOTION_KEY',type:'inherit',version_id:old}]);assert.ok(!JSON.stringify(metadata).includes('secret-value'));
  assert.ok(!Object.hasOwn(metadata,'placement'));assert.equal(metadata.usage_model,'standard');assert.ok(!Object.hasOwn(metadata,'observability'));
  f.receipt.boundary.data.settings.placement={mode:'smart',hint:'wnam'};
  await ops.upload('readonly',f.receipt);
  assert.deepEqual(JSON.parse(calls[2][2].body.get('metadata')).placement,{mode:'smart',hint:'wnam'});
});
test('API upload refusal retains only numeric status/codes through the durable receipt',async()=>{
  const f=fixture();const transport=createTransport({tokens:{DATA_EDGE_TOKEN:'never-print-token'},fetchImpl:async()=>Response.json({success:false,errors:[{code:10021,message:'never-print-message',source:{pointer:'never-print-config'}},{code:'never-print-code'},{code:10021},{code:10000}]},{status:400})});
  f.ops.upload=async()=>transport.api(SCRIPT+'/versions','DATA_EDGE_TOKEN',{method:'POST'});
  await assert.rejects(execute(f.receipt,f.ops,f.persist));
  assert.deepEqual(f.receipt.failure,{kind:'cloudflare-api',httpStatus:400,errorCodes:[10021,10000]});
  assert.ok(!JSON.stringify(f.receipt).includes('never-print'));assert.equal(f.receipt.failedStage,'upload-readonly');assert.equal(f.receipt.recovery,'no-active-mutation');assert.equal(f.getActive(),old);
});
test('local version assertion differs from API rejection without leaking its message or actual data',async()=>{
  const f=fixture();f.ops.upload=async()=>{assert.equal('never-print-actual','never-print-expected');};
  await assert.rejects(execute(f.receipt,f.ops,f.persist));assert.deepEqual(f.receipt.failure,{kind:'local-validation'});assert.ok(!JSON.stringify(f.receipt).includes('never-print'));
});
test('non-JSON API errors and network errors keep bounded safe distinct diagnostics',async()=>{
  for(const [fetchImpl,expected] of [[async()=>new Response('never-print-html',{status:502}),{kind:'cloudflare-response',httpStatus:502,errorCodes:[]}],[async()=>{throw Error('never-print-token/url');},{kind:'transport'}]]){
    const transport=createTransport({tokens:{DATA_EDGE_TOKEN:'never-print-token'},fetchImpl});
    await assert.rejects(transport.api(SCRIPT+'/versions','DATA_EDGE_TOKEN'),error=>{assert.deepEqual(error.safeDiagnostic,expected);assert.ok(!String(error).includes('never-print'));return true;});
  }
});
test('diagnostic persistence rejects remote strings and bounds numeric fields',()=>{
  const diagnostic=safeFailureDiagnostic({safeDiagnostic:{kind:'cloudflare-api',httpStatus:'never-print',errorCodes:[null,-1,NaN,Infinity,'never-print',...Array.from({length:20},(_,i)=>1000+i)],body:'never-print',message:'never-print'}});
  assert.deepEqual(diagnostic,{kind:'cloudflare-api',httpStatus:null,errorCodes:Array.from({length:8},(_,i)=>1000+i)});
  assert.deepEqual(safeFailureDiagnostic({safeDiagnostic:{kind:'never-print'}}),{kind:'unexpected'});
});
async function inheritFailure(errors,{status=400,bindings=['CATALOG_PROMOTION_KEY']}={}){
  const transport=createTransport({tokens:{DATA_EDGE_TOKEN:'never-print-token'},fetchImpl:async()=>Response.json({success:false,errors},{status})});
  try{await transport.api(SCRIPT+'/versions?bindings_inherit=strict','DATA_EDGE_TOKEN',{method:'POST',inheritanceBindings:bindings});assert.fail('expected refusal');}catch(error){return safeFailureDiagnostic(error);}
}
test('inherit refusal retains only known reason and reviewed binding through controller receipt',async()=>{
  const f=fixture();
  const transport=createTransport({tokens:{DATA_EDGE_TOKEN:'never-print-token'},fetchImpl:async()=>Response.json({success:false,errors:[{code:10057,message:"inherit binding 'CATALOG_PROMOTION_KEY' is invalid: previous version does not have binding named 'CATALOG_PROMOTION_KEY'"}]},{status:400})});
  f.ops.upload=makeOperations(transport,'unused',{bundles:{readonly:{bytes:Buffer.from('code')}}}).upload;
  await assert.rejects(execute(f.receipt,f.ops,f.persist));
  const {encryptedInheritance,...publicDiagnostic}=f.receipt.failure;
  assert.ok(encryptedInheritance);
  assert.deepEqual(publicDiagnostic,{kind:'cloudflare-api',httpStatus:400,errorCodes:[10057],inheritance:[{reason:'missing-binding',binding:'CATALOG_PROMOTION_KEY'}]});
  assert.equal(f.receipt.recovery,'no-active-mutation');assert.equal(f.getActive(),old);
});
const diagnosticKeys=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
function decryptDiagnostic(envelope){
  const key=privateDecrypt({key:diagnosticKeys.privateKey,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64'));
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(envelope.iv,'base64'));
  decipher.setAAD(Buffer.from(`weatherx-inherit-diagnostic/v1:${envelope.keySha256}`));
  decipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext,'base64')),decipher.final()]));
}
test('encrypted diagnostics privately recover exact bounded errors without plaintext disclosure',()=>{
  const message="inherit binding 'APP_ORIGIN' is invalid: never-print-secret https://never-print.example/token";
  const errors=[{code:10057,message,source:{secret:'never-print-config'}},{code:10021,message:'never-print-other'}];
  const envelope=encryptInheritanceDiagnostic(errors,diagnosticKeys.publicKey);
  assert.deepEqual(decryptDiagnostic(envelope),{version:1,errors:[{code:10057,message}]});
  assert.ok(!JSON.stringify(envelope).includes('never-print'));
  assert.notEqual(envelope.ciphertext,encryptInheritanceDiagnostic(errors,diagnosticKeys.publicKey).ciphertext);
  for(const field of ['ciphertext','tag','iv','wrappedKey']){
    const changed=structuredClone(envelope),bytes=Buffer.from(changed[field],'base64');bytes[0]^=1;changed[field]=bytes.toString('base64');
    assert.throws(()=>decryptDiagnostic(changed));
  }
  const bounded=encryptInheritanceDiagnostic([{code:'10057',message:'never-print'}, {code:10057,message:'x'.repeat(513)},...Array.from({length:12},()=>({code:10057,message:'x'.repeat(512)}))],diagnosticKeys.publicKey);
  assert.equal(decryptDiagnostic(bounded).errors.length,8);
  assert.ok(decryptDiagnostic(bounded).errors.every(x=>x.message.length===512));
});
test('encrypted transport capture is restricted to exact opted-in data reader upload refusal',async()=>{
  for(const changes of [{status:403},{code:'10057'},{code:10021},{path:SCRIPT+'/settings'},{method:'GET'},{tokenName:'PLATFORM_EDGE_TOKEN'},{bindings:[]},{bindings:['never-print']}]){
    const {status=400,code=10057,path=SCRIPT+'/versions?bindings_inherit=strict',method='POST',tokenName='DATA_EDGE_TOKEN',bindings=['APP_ORIGIN']}=changes;
    const transport=createTransport({tokens:{DATA_EDGE_TOKEN:'never-print',PLATFORM_EDGE_TOKEN:'never-print'},fetchImpl:async()=>Response.json({success:false,errors:[{code,message:'never-print'}]},{status})});
    await assert.rejects(transport.api(path,tokenName,{method,inheritanceBindings:bindings}),error=>{assert.ok(!error.safeDiagnostic.encryptedInheritance);assert.ok(!JSON.stringify(error).includes('never-print'));return true;});
  }
});
test('encrypted envelope persistence rejects malformed or plaintext lookalikes',()=>{
  for(const encryptedInheritance of [{ciphertext:'never-print'}, {version:1,algorithm:'never-print',ciphertext:'never-print'}]){
    const result=safeFailureDiagnostic({safeDiagnostic:{kind:'cloudflare-api',httpStatus:400,errorCodes:[10057],encryptedInheritance}});
    assert.ok(!result.encryptedInheritance);assert.ok(!JSON.stringify(result).includes('never-print'));
  }
});
test('inherit no previous version has a fixed classification without reflected text',async()=>{
  assert.deepEqual((await inheritFailure([{code:10057,message:'cannot inherit bindings: no previous version exists'}])).inheritance,[{reason:'no-previous-version'}]);
});
test('inherit unknown reasons, names, controls, oversized messages and embedded secrets are redacted',async()=>{
  for(const message of ["inherit binding 'never-print-secret' is invalid: previous version does not have binding named 'never-print-secret'",'https://never-print.example/token',"inherit binding 'CATALOG_PROMOTION_KEY' is invalid: https://never-print.example/token", "inherit binding 'CATALOG_PROMOTION_KEY' is invalid\nnever-print",'never-print'.repeat(100)]){
    const diagnostic=await inheritFailure([{code:10057,message}]);
    assert.equal(diagnostic.inheritance[0].reason,'unknown');assert.ok(!JSON.stringify(diagnostic).includes('never-print'));
  }
  assert.deepEqual((await inheritFailure([{code:10057,message:"inherit binding 'PLATFORM_DB' is invalid: previous version does not have binding named 'PLATFORM_DB'"}])).inheritance,[{reason:'unknown'}]);
});
test('inherit classification requires numeric 10057, HTTP 400 and explicit boundary opt-in',async()=>{
  const message='cannot inherit bindings: no previous version exists';
  for(const [errors,options] of [[[{code:'10057',message}],{}],[[{code:10057,message}],{status:403}],[[{code:10057,message}],{bindings:[]}],[[{code:10021,message}],{}]])assert.ok(!Object.hasOwn(await inheritFailure(errors,options),'inheritance'));
});
test('inherit diagnostics are capped and re-sanitized before persistence',async()=>{
  const diagnostic=await inheritFailure(Array.from({length:20},()=>({code:10057,message:'cannot inherit bindings: no previous version exists'})));
  assert.equal(diagnostic.inheritance.length,8);
  const input={kind:'cloudflare-api',httpStatus:400,errorCodes:[10057],inheritance:[{reason:'never-print',binding:'never-print',message:'never-print'},{reason:'missing-binding',binding:'CATALOG_PROMOTION_KEY',token:'never-print'}]};
  assert.deepEqual(safeFailureDiagnostic({safeDiagnostic:input}).inheritance,[{reason:'unknown'},{reason:'missing-binding',binding:'CATALOG_PROMOTION_KEY'}]);
});
