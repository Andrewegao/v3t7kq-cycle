import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Owner-approved retained imagery, 2026-09-07. See the production review record.
// This authenticates exact reviewed bytes, not an unproven historical source.
export const APPROVED_GROUND_INVENTORY = '606fd6a0a883c8927bee9dddb94d7459b0cfc1df347659cda72d6b994d4bef74';
export function groundInventoryDigest(files) {
  assert.ok(Array.isArray(files));
  const rows=files.filter(f=>f.path==='basemap-ground'||f.path.startsWith('basemap-ground/'));
  assert.equal(rows.length,1365,'production requires the complete reviewed ground pyramid');
  const byPath=new Map(rows.map(f=>[f.path,f]));
  assert.equal(byPath.size,1365,'duplicate ground tile');
  const h=createHash('sha256');
  for(let z=0;z<=5;z++)for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++){
    const path=`basemap-ground/${z}/${x}/${y}.jpg`,f=byPath.get(path);
    assert.ok(f,`missing canonical ground tile: ${path}`);
    assert.ok(Number.isSafeInteger(f.bytes)&&f.bytes>0&&f.bytes<=1024*1024);
    assert.match(f.sha256??'',/^[a-f0-9]{64}$/);
    const bytes=Buffer.from(f.base64,'base64');
    assert.equal(bytes.toString('base64'),f.base64,'noncanonical ground encoding');
    assert.equal(bytes.length,f.bytes,'ground length changed');
    assert.equal(createHash('sha256').update(bytes).digest('hex'),f.sha256,'ground bytes changed');
    h.update(`${path}\0${f.bytes}\0${f.sha256}\0`);
  }
  return h.digest('hex');
}
export function verifyProductionGround(files) {
  assert.equal(groundInventoryDigest(files),APPROVED_GROUND_INVENTORY,
    'ground differs from the owner-reviewed production inventory');
}
