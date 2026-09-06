import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generateKeyPairSync,privateDecrypt,createDecipheriv} from 'node:crypto';
import {retain} from '../tools/component-publish-diagnostic.mjs';
test('diagnostics retain only encrypted bounded private output and reject invalid inputs',()=>{
  const root=mkdtempSync(join(tmpdir(),'wx-private-component-'));
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048,
    publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
  const input=join(root,'log'),output=join(root,'receipt.json'),meta={model:'hrrr',runId:'34001865145',sourceSha:'a'.repeat(40)};
  try{
    assert.equal(retain(input,output,meta,publicKey),false);assert.equal(existsSync(output),false);
    const raw='x'.repeat(30000)+'SYNTHETIC_PRIVATE_URL_TOKEN';writeFileSync(input,raw);
    assert.equal(retain(input,output,meta,publicKey),true);
    const serialized=readFileSync(output,'utf8');assert.ok(!serialized.includes('SYNTHETIC_PRIVATE_URL_TOKEN'));
    const r=JSON.parse(serialized),e=r.encryptedTail;assert.equal(r.capturedBytes,16384);assert.equal(r.logBytes,raw.length);
    assert.equal(r.publishable,false);assert.ok(serialized.length<40000);
    const key=privateDecrypt({key:privateKey,oaepHash:'sha256'},Buffer.from(e.wrappedKey,'base64'));
    const d=createDecipheriv('aes-256-gcm',key,Buffer.from(e.iv,'base64'));
    d.setAAD(Buffer.from('weatherx-nam-hi-diagnostic/v1:'+e.keySha256));d.setAuthTag(Buffer.from(e.tag,'base64'));
    const clear=JSON.parse(Buffer.concat([d.update(Buffer.from(e.ciphertext,'base64')),d.final()]));
    assert.equal(Buffer.from(clear.stderr,'base64').toString(),raw.slice(-16384));key.fill(0);
    assert.throws(()=>retain(input,output,{...meta,model:'../../secret'},publicKey));
    symlinkSync(input,join(root,'linked'));assert.throws(()=>retain(join(root,'linked'),output,meta,publicKey));
  }finally{rmSync(root,{recursive:true,force:true});}
});
