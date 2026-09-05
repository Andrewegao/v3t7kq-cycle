import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { verifySourceImports, verifyManifestHash, pinnedMapUrl } from '../tools/data-reader-proof.mjs';
import { createHash } from 'node:crypto';
test('whole release uses the producer canonical manifest hash while recording raw bytes',()=>{
  const manifest={schemaVersion:1,releaseId:'cycle-1',objects:[{path:'data/gfs/index.json',bytes:2,sha256:'a'.repeat(64)}]};
  const digest=value=>createHash('sha256').update(value).digest('hex');
  const expected=digest(JSON.stringify(manifest));
  for(const bytes of [Buffer.from(JSON.stringify(manifest)+'\n'),Buffer.from(JSON.stringify(manifest,null,2))]){
    const receipt=verifyManifestHash(bytes,expected);assert.equal(receipt.canonicalSha256,expected);assert.equal(receipt.rawSha256,digest(bytes));assert.notEqual(receipt.rawSha256,expected);
  }
  assert.throws(()=>verifyManifestHash(Buffer.from(JSON.stringify({...manifest,releaseId:'tampered'})),expected));
});
test('transform supports actual sharedRead parameter-property syntax',async()=>{
  const input='export class SharedReadError extends Error { constructor(readonly status: number) { super("read failed"); } }';
  assert.throws(()=>stripTypeScriptTypes(input));
  const output=stripTypeScriptTypes(input,{mode:'transform'});
  const {SharedReadError}=await import('data:text/javascript;base64,'+Buffer.from(output).toString('base64'));
  assert.equal(new SharedReadError(503).status,503);
});
test('catalog proof uses exact reserved immutable path, never ignored query parameters',()=>{
  assert.equal(pinnedMapUrl('90-example','gfs'),'https://weatherx.org/data/_catalog/90-example/gfs/index.json');
  assert.throws(()=>pinnedMapUrl('../escape','gfs'));assert.throws(()=>pinnedMapUrl('90-example','unreviewed'));
});
test('actual approved data/full fallback module closure imports before network',{skip:!process.env.WEATHERX_ATMOS_SOURCE},async()=>{
  await verifySourceImports(process.env.WEATHERX_ATMOS_SOURCE);
});
