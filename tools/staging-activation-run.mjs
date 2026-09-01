// The only real-I/O activation entry point. Hosted manual main, fixed consumer,
// staging-only S3 credentials, no collector and no deployment API credential.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeFileSync,mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { activationGate,activatePrepared,recoverActivation } from './staging-activate.mjs';
import { createStagingS3 } from './staging-s3.mjs';
import { loadConsumer } from './staging-live-proof.mjs';
import { hash } from './shared-data.mjs';

export async function runActivation(command,env=process.env){
  assert.ok(['gate','activate','recover'].includes(command));const ctx=activationGate(env);
  if(command==='gate'){console.log(JSON.stringify({candidateId:ctx.candidateId,sourceSelection:ctx.selection,productionWritten:false}));return;}
  assert.ok(!env.CLOUDFLARE_API_TOKEN&&!env.STAGING_WORKER_API_TOKEN&&!env.UI_CANDIDATE_KEY,'activation does not receive deployment credentials');
  const io=createStagingS3(env);let consumer;
  try{
    const candidate=`staging-candidates/${ctx.candidateId}/activations/${ctx.activationId}/`;
    let result;
    if(command==='recover'){
      const intent=await io.get('weatherx-data-staging',candidate+'intent.json');
      if(!intent){console.log('No serving-pointer intent was created; nothing to recover');return;}
      const journal=await io.get('weatherx-data-staging',candidate+'journal.json');
      if(journal){const parsed=JSON.parse(journal.body);assert.equal(parsed.intentSha256,hash(intent.body));
        if(parsed.state==='complete'){console.log('Activation already passed live proof; completed transaction retained');return;}}
      result=await recoverActivation(ctx,io);assert.equal(result.state,'rolled-back','staging recovery requires attention');
    }else{
      consumer=loadConsumer(resolve(env.GITHUB_WORKSPACE,'control'));
      const deps=await consumer.dependencies(io),verifyLive=deps.verifyLive;
      const events=[],diagnosticDir=resolve(env.RUNNER_TEMP,'staging-activation');
      const report=event=>{
        events.push(event);mkdirSync(diagnosticDir,{recursive:true,mode:0o700});
        writeFileSync(resolve(diagnosticDir,'diagnostics.json'),JSON.stringify({schemaVersion:1,events},null,2)+'\n',{mode:0o600});
      };
      let retainedProofHash;
      deps.verifyLive=async(...args)=>{
        const proof=await verifyLive(...args),body=JSON.stringify(proof);
        const dir=resolve(env.RUNNER_TEMP,'staging-activation');mkdirSync(dir,{recursive:true,mode:0o700});
        writeFileSync(resolve(dir,'live-proof.json'),body,{mode:0o600});
        retainedProofHash=hash(body);return proof;
      };
      result=await activatePrepared(ctx,io,{...deps,report});
      assert.equal(result.liveProofSha256,retainedProofHash,'retained live evidence hash mismatch');
    }
    const output=resolve(env.RUNNER_TEMP,'staging-activation');mkdirSync(output,{recursive:true,mode:0o700});
    writeFileSync(resolve(output,command+'.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
    console.log(JSON.stringify(result));return result;
  }finally{consumer?.close();io.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  runActivation(process.argv[2]).catch(error=>{console.error(`Staging activation stopped: ${error?.recovery?.state??'validation-or-controller-error'}`);process.exitCode=1;});
