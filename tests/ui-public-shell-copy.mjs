import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {copyPublicShell} from '../tools/ui-release.mjs';
import {ACCOUNT_CORE_PROFILE,TC_RELEASE_PROFILE,BASELINE_PROFILE,CORE_RELEASE_PROFILE,STATIC_COMPRESSION_PROFILE} from '../tools/ui-staging-models.mjs';

// A valid 1x1 WebP. The copy policy checks the envelope; browser qualification
// separately verifies decoding and the real layer menu's runtime asset paths.
const WEBP=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64');
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'wx-shell-copy-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'public'),shell=join(root,'shell');
  for(const dir of ['thumbs','data','data-atmos','basemap-ground','data-fixtures/radiosondes'])mkdirSync(join(source,dir),{recursive:true});
  for(const [path,bytes] of Object.entries({'thumbs/wind.jpg':'legacy','thumbs/wind.webp':WEBP,
    'thumbs/unreviewed.jpg':'keep','thumbs/unreviewed.webp':WEBP,'data/index.json':'private','data-atmos/index.json':'private',
    'basemap-ground/0.pbf':'ground','data-fixtures/radiosondes/stations.json':'fallback','index.html':'shell'}))writeFileSync(join(source,path),bytes);
  return {source,shell};
}
for(const [name,profile] of [['account',ACCOUNT_CORE_PROFILE],['TC',TC_RELEASE_PROFILE]])
test(`exact staging ${name} profile omits only reviewed legacy JPG copies, preserving sources and runtime bytes`,t=>{
  const {source,shell}=fixture(t);
  copyPublicShell(profile,{publicDir:source,shell});
  assert.equal(existsSync(join(shell,'thumbs/wind.jpg')),false);
  assert.equal(readFileSync(join(source,'thumbs/wind.jpg'),'utf8'),'legacy');
  for(const p of ['thumbs/wind.webp','thumbs/unreviewed.jpg','thumbs/unreviewed.webp','basemap-ground/0.pbf','data-fixtures/radiosondes/stations.json','index.html'])assert.deepEqual(readFileSync(join(shell,p)),readFileSync(join(source,p)));
  for(const p of ['data','data-atmos'])assert.equal(existsSync(join(shell,p)),false);
});
test('production-compatible and other profiles retain their existing thumbnail inventory',t=>{
  for(const profile of [BASELINE_PROFILE,CORE_RELEASE_PROFILE,STATIC_COMPRESSION_PROFILE]){
    const {source,shell}=fixture(t);
    copyPublicShell(profile,{publicDir:source,shell});
    assert.equal(readFileSync(join(shell,'thumbs/wind.jpg'),'utf8'),'legacy');
  }
});
test('missing, corrupt or symlink replacement fails before a shell is copied',t=>{
  for(const profile of [ACCOUNT_CORE_PROFILE,TC_RELEASE_PROFILE]) for(const replacement of ['missing','corrupt','symlink','wrong-length']){
    const {source,shell}=fixture(t),webp=join(source,'thumbs/wind.webp');
    rmSync(webp);
    if(replacement==='corrupt')writeFileSync(webp,'not a WebP');
    if(replacement==='symlink')symlinkSync(join(source,'thumbs/unreviewed.jpg'),webp);
    if(replacement==='wrong-length'){const bytes=Buffer.from(WEBP);bytes.writeUInt32LE(1,4);writeFileSync(webp,bytes);}
    assert.throws(()=>copyPublicShell(profile,{publicDir:source,shell}));
    assert.equal(existsSync(shell),false);
  }
});
test('absent reviewed JPG keeps WebP; a symlink JPG is refused',t=>{
  for(const symlink of [false,true]){
    const {source,shell}=fixture(t),jpg=join(source,'thumbs/wind.jpg');
    rmSync(jpg);
    if(symlink){
      symlinkSync(join(source,'thumbs/unreviewed.jpg'),jpg);
      assert.throws(()=>copyPublicShell(ACCOUNT_CORE_PROFILE,{publicDir:source,shell}));
      assert.equal(existsSync(shell),false);
    }else{
      copyPublicShell(ACCOUNT_CORE_PROFILE,{publicDir:source,shell});
      assert.deepEqual(readFileSync(join(shell,'thumbs/wind.webp')),WEBP);
    }
  }
});
test('invalid profiles and an existing destination cannot be used to overwrite a package',t=>{
  const {source,shell}=fixture(t);
  assert.throws(()=>copyPublicShell({...ACCOUNT_CORE_PROFILE,stagingOnly:false},{publicDir:source,shell}));
  mkdirSync(shell);writeFileSync(join(shell,'sentinel'),'keep');
  assert.throws(()=>copyPublicShell(ACCOUNT_CORE_PROFILE,{publicDir:source,shell}));
  assert.equal(readFileSync(join(shell,'sentinel'),'utf8'),'keep');
});
