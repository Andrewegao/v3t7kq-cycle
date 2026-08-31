// Synthetic loopback S3 integration, not a weather bake or a Cloudflare permission audit.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture } from './shared-data.mjs';
import { createTransport, prepare, hash } from '../tools/shared-data.mjs';

assert.ok(process.env.SHARED_DATA_VALIDATOR_MODULE, 'supply the reviewed controller validator path');
const { validatePointSeriesDescriptor } = await import(pathToFileURL(resolve(process.env.SHARED_DATA_VALIDATOR_MODULE)));
const temp=mkdtempSync(resolve(tmpdir(),'wx-shared-s3-')), children=[];
async function server(root, readOnly) {
  mkdirSync(root);
  const child=spawn('rclone',['serve','s3',root,'--addr','127.0.0.1:0','--auth-key','fixture-id,fixture-secret',
    ...(readOnly?['--read-only']:[])],{stdio:['ignore','ignore','pipe']});
  children.push(child);
  return await new Promise((resolve,reject)=>{
    let output=''; const timer=setTimeout(()=>reject(Error('fixture S3 startup timeout')),10000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',()=>{clearTimeout(timer);reject(Error('fixture S3 server exited'));});
    child.stderr.on('data',data=>{
      output+=data;
      const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if(match){clearTimeout(timer);resolve(match[0]);}
    });
  });
}
try {
  const source=resolve(temp,'source'), destination=resolve(temp,'destination');
  const endpoints={read:await server(source,true),write:await server(destination,false)};
  const f=fixture();
  for (const [key,bytes] of f.store) {
    const slash=key.indexOf('/'), kind=key.slice(0,slash), path=resolve(source,`weatherx-${kind}-production`,key.slice(slash+1));
    mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes);
  }
  for (const kind of ['data','components']) mkdirSync(resolve(destination,`weatherx-${kind}-staging`));
  const env={PATH:process.env.PATH,HOME:process.env.HOME,
    SHARED_R2_READ_ACCESS_KEY_ID:'read',SHARED_R2_READ_SECRET_ACCESS_KEY:'fixture-secret',
    STAGING_R2_WRITE_ACCESS_KEY_ID:'write',STAGING_R2_WRITE_SECRET_ACCESS_KEY:'fixture-secret'};
  const execute=(exe,args,options)=>{
    const role=options.env.RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID;
    return execFileSync(exe,args,{...options,env:{...options.env,
      RCLONE_CONFIG_OBJECTS_ENDPOINT:endpoints[role],RCLONE_CONFIG_OBJECTS_PROVIDER:'Other',
      RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID:'fixture-id'}});
  };
  const io=createTransport(env,execute);
  const check=m=>validatePointSeriesDescriptor(m.pointSeries,m.objects);
  const receipt=await prepare(f.pin,io,resolve(temp,'snapshot'),check,Date.parse('2026-08-31T15:00:00Z'));
  assert.equal(receipt.activated,false);
  for (const [key,bytes] of f.store) {
    const slash=key.indexOf('/'), kind=key.slice(0,slash), suffix=key.slice(slash+1);
    assert.equal(hash(readFileSync(resolve(source,`weatherx-${kind}-production`,suffix))),hash(bytes),'source unchanged');
    if(suffix.startsWith('releases/cycle-123/')||kind==='components')
      assert.equal(hash(readFileSync(resolve(destination,`weatherx-${kind}-staging`,suffix))),hash(bytes));
  }
  // Existing bytes may be reused, but an equal-size staging corruption must never qualify.
  const file=resolve(destination,'weatherx-components-staging/components/gfs/gfs-123/index.json');
  writeFileSync(file,Buffer.alloc(readFileSync(file).length,120));
  await assert.rejects(prepare(f.pin,io,resolve(temp,'corrupt-retry'),check,Date.parse('2026-08-31T15:00:00Z')));
  console.log('Synthetic S3 copy/readback, pinned descriptor integration, source immutability and corrupt-retry refusal PASS');
} finally {
  for (const child of children) child.kill('SIGTERM');
}
