// Unqualified build transport is NOT a production candidate. The builder has only
// a public encryption key; only the isolated staging publisher can decrypt it.
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createPublicKey, createPrivateKey,
  publicEncrypt, privateDecrypt, randomBytes, constants } from 'node:crypto';
import { validateCandidate, MAX_BYTES, REPOSITORY, PROFILE } from './ui-candidate.mjs';
const MAGIC=Buffer.from('WXUB1\0');
function key(pem, privatePart=false) {
  assert.ok(typeof pem==='string' && pem.includes(privatePart?'BEGIN PRIVATE KEY':'BEGIN PUBLIC KEY'),'missing build transport key');
  const k=privatePart?createPrivateKey(pem):createPublicKey(pem);
  assert.equal(k.asymmetricKeyType,'rsa');
  assert.ok(k.asymmetricKeyDetails.modulusLength>=3072 && k.asymmetricKeyDetails.modulusLength<=4096);
  return k;
}
function unqualified(c) { validateCandidate(c); assert.equal(c.qualification,undefined,'builder cannot attest staging qualification'); }
export function packBuild(c, publicKey) {
  unqualified(c);
  const secret=randomBytes(32), iv=randomBytes(12);
  const wrapped=publicEncrypt({key:key(publicKey),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},secret);
  const prefix=Buffer.alloc(8);MAGIC.copy(prefix);prefix.writeUInt16BE(wrapped.length,6);
  const aad=Buffer.concat([prefix,wrapped]), cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(aad);
  const body=Buffer.concat([cipher.update(JSON.stringify(c)),cipher.final()]);
  assert.ok(body.length<=MAX_BYTES*2);
  return Buffer.concat([aad,iv,cipher.getAuthTag(),body]);
}
export function unpackBuild(blob, privateKey) {
  assert.ok(blob.length>420 && blob.length<=MAX_BYTES*2+1024);
  assert.ok(blob.subarray(0,6).equals(MAGIC),'not an unqualified build envelope');
  const length=blob.readUInt16BE(6);assert.ok(length===384||length===512);
  const start=8+length;assert.ok(blob.length>start+28);
  const secret=privateDecrypt({key:key(privateKey,true),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},blob.subarray(8,start));
  assert.equal(secret.length,32);
  const cipher=createDecipheriv('aes-256-gcm',secret,blob.subarray(start,start+12));
  cipher.setAAD(blob.subarray(0,start));cipher.setAuthTag(blob.subarray(start+12,start+28));
  const c=JSON.parse(Buffer.concat([cipher.update(blob.subarray(start+28)),cipher.final()]));
  unqualified(c);return c;
}
export function eligibleBuild(c, run, jobs, artifacts, context) {
  unqualified(c);
  assert.deepEqual(c.profile,context.profile??PROFILE,'build differs from requested profile');
  assert.equal(run.repository?.full_name,REPOSITORY);
  assert.equal(run.path,'.github/workflows/ui-staging.yml');
  assert.equal(run.event,'workflow_dispatch');assert.equal(run.head_branch,'main');
  assert.equal(String(run.id),context.runId);assert.equal(String(run.run_attempt),context.attempt);
  assert.equal(run.head_sha,context.workflowSha);
  assert.equal(c.runId,context.runId);assert.equal(c.attempt,context.attempt);
  assert.equal(c.workflowSha,context.workflowSha);assert.equal(c.sourceSha,context.sourceSha);
  assert.equal(c.pipelineDigest,context.pipelineDigest);
  const matches=jobs.filter(j=>j.name==='build');assert.equal(matches.length,1,'one build job required');
  assert.equal(matches[0].status,'completed');assert.equal(matches[0].conclusion,'success');
  assert.equal(matches[0].head_sha,context.workflowSha);
  const a=artifacts.filter(x=>x.name===`ui-build-${context.runId}-${context.attempt}`);
  assert.equal(a.length,1);assert.equal(a[0].expired,false);
  assert.ok(a[0].size_in_bytes>0&&a[0].size_in_bytes<MAX_BYTES*2+1024);
  return a[0];
}
