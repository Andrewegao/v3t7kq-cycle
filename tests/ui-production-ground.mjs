import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {groundInventoryDigest,verifyProductionGround,APPROVED_GROUND_INVENTORY} from '../tools/ui-production-ground.mjs';
import {POLICY_FILES} from '../tools/ui-release.mjs';
const body=Buffer.from('synthetic, not reviewed imagery'),sha256=createHash('sha256').update(body).digest('hex');
const fixture=()=>Array.from({length:6},(_,z)=>Array.from({length:2**z},(_,x)=>Array.from({length:2**z},(_,y)=>({path:`basemap-ground/${z}/${x}/${y}.jpg`,bytes:body.length,sha256,base64:body.toString('base64')})))).flat(2);
test('ground digest uses numeric z/x/y order, independently of candidate inventory sort',()=>{
 const files=fixture(),h=createHash('sha256');for(const f of files)h.update(`${f.path}\0${f.bytes}\0${f.sha256}\0`);
 const digest=h.digest('hex');
 assert.equal(groundInventoryDigest([...files].reverse()),digest);
 assert.notEqual(digest,APPROVED_GROUND_INVENTORY);
 assert.throws(()=>verifyProductionGround(files),/owner-reviewed/);
});
test('incomplete, extra, duplicate, noncanonical and modified tiles fail closed',()=>{
 for(const change of [f=>f.pop(),f=>f.push({...f[0],path:'basemap-ground/extra.jpg'}),f=>f[1]={...f[0]},f=>f[0].path='basemap-ground/00/0/0.jpg',f=>f[0].base64=Buffer.from('changed').toString('base64'),f=>f[0].bytes++,f=>f[0].sha256='0'.repeat(64)]){
  const files=fixture();change(files);assert.throws(()=>groundInventoryDigest(files));
 }
 assert.throws(()=>verifyProductionGround([]));
});
test('production approval is fingerprinted and checked before any Cloudflare preflight read',()=>{
 assert.ok(POLICY_FILES.includes('tools/ui-production-ground.mjs'));
 assert.ok(POLICY_FILES.includes('docs/production-ground-review-20260907.md'));
 const source=readFileSync(new URL('../tools/ui-release.mjs',import.meta.url),'utf8');
 const preflight=source.slice(source.indexOf('async function preflight(stage)'),source.indexOf('export function requiredSourceGuard'));
 assert.match(preflight,/stage==='production'[\s\S]*?requireProductionProfile\(c.profile\);\s*verifyProductionGround\(c.files\)/);
 assert.ok(preflight.indexOf('verifyProductionGround(c.files)')<preflight.indexOf('await projectSnapshot(stage)'));
});
