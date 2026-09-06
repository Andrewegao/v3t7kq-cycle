import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {brotliCompressSync} from 'node:zlib';
import {validateCompressionFiles,installCompressionOverlay,selectCompressionAssets} from '../tools/ui-static-compression.mjs';
import {validateCandidate,validateFiles,STAGING_CONTROL_SHA} from '../tools/ui-candidate.mjs';
import {STATIC_COMPRESSION_PROFILE,CORE_RELEASE_PROFILE,requireProductionProfile} from '../tools/ui-staging-models.mjs';
import {requiredSourceGuard,POLICY_FILES} from '../tools/ui-release.mjs';
function reseal(f){
 delete f.manifest.sealSha256;f.manifest.sealSha256=hash(JSON.stringify(f.manifest));
 f.files=f.files.map(row=>row.path==='static-compression-manifest.json'?file(row.path,Buffer.from(JSON.stringify(f.manifest))):row);return f;
}
function rewriteRoutes(f,edit){
 const routes=JSON.parse(Buffer.from(f.files.find(x=>x.path==='_routes.json').base64,'base64'));edit(routes);
 const body=Buffer.from(JSON.stringify(routes));f.files=f.files.map(row=>row.path==='_routes.json'?file(row.path,body):row);
 f.manifest.outputs.routes={path:'_routes.json',bytes:body.length,sha256:hash(body)};return reseal(f);
}
test('exhaustive inventory rejects omitted lazy assets, unsalted JS/CSS, nested JS, and prefixed non-code',()=>{
 for(const path of ['assets/wxbr11v1-lazy-12345678.js','assets/wxbr11v1-lazy-12345678.css','assets/old-12345678.js','assets/old-12345678.css','assets/old-12345678.JS','assets/nested/wxbr11v1-x-12345678.js','assets/wxbr11v1-font-12345678.woff2','assets/wxbr11v1-image-12345678.png']){
  const f=fixture();f.files.push(file(path,Buffer.from('extra')));assert.throws(()=>validateCompressionFiles(f.files,true),/inventory|asset|prefix/i,path);
 }
 const f=fixture();f.files.push(file('assets/font-12345678.woff2',Buffer.from('font')));validateCompressionFiles(f.files,true);
 assert.throws(()=>validateCompressionFiles([...f.files,f.files.find(row=>row.path.startsWith('assets/'))],true),/duplicate|unique/i);
});
test('omitted raw asset, omitted manifest entry, and selected non-code all fail closed',()=>{
 const f=fixture();assert.throws(()=>validateCompressionFiles(f.files.filter(row=>!row.path.startsWith('assets/')),true),/inventory|asset/i);
 const g=fixture();g.manifest.selectedPaths=[];g.manifest.entries={};assert.throws(()=>validateCompressionFiles(reseal(g).files,true));
 const h=fixture(),old=h.manifest.selectedPaths[0],next='/assets/wxbr11v1-font-12345678.woff2';
 h.manifest.selectedPaths=[next];h.manifest.entries={[next]:h.manifest.entries[old]};h.files=h.files.map(row=>row.path===old.slice(1)?{...row,path:next.slice(1)}:row);
 assert.throws(()=>validateCompressionFiles(reseal(h).files,true),/asset|prefix/i);
});
test('prefix routing refuses exclusions, duplicate or missing prefix, broad overlaps, and exact old membership',()=>{
 const edits=[r=>r.include.push('/assets/wxbr11v1-*'),r=>r.include.pop(),r=>r.include[1]='/assets/wxbr11v1-App-12345678.js'];
 for(const list of ['include','exclude'])for(const route of ['/*','/assets*','/assets/*','/assets','/assets/unrelated.png','/assets/wxbr11v1-*'])edits.push(r=>r[list].push(route));
 for(const edit of edits){const f=rewriteRoutes(fixture(),edit);assert.throws(()=>validateCompressionFiles(f.files,true),/asset.*route|compression.*route/i);}
});
test('selector rejects unsalted or nested code, prefix media, symlinks and excessive inventories',()=>{
 const root=mkdtempSync(join(tmpdir(),'wx-compression-select-invalid-'));
 try{
  mkdirSync(join(root,'assets'));
  const paths=['plain-12345678.js','plain-12345678.css','wxbr11v1-font-12345678.woff2','nested/wxbr11v1-x-12345678.js'];
  for(const path of paths){const target=join(root,'assets',path);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,'x');
   assert.throws(()=>selectCompressionAssets(root),/asset|prefix|path/i);rmSync(target);}
  const external=join(root,'external.js'),link=join(root,'assets/wxbr11v1-link-12345678.js');
  writeFileSync(external,'x');symlinkSync(external,link);assert.throws(()=>selectCompressionAssets(root),/symlink/);rmSync(link);
  for(let i=0;i<512;i++)writeFileSync(join(root,'assets',`wxbr11v1-chunk${i}-12345678.js`),'x');
  assert.equal(selectCompressionAssets(root).length,512);
  writeFileSync(join(root,'assets/wxbr11v1-overflow-12345678.js'),'x');
  assert.throws(()=>selectCompressionAssets(root),/512|inventory|limit/i);
 }finally{rmSync(root,{recursive:true,force:true});}
});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const file=(path,bytes)=>({path,bytes:bytes.length,sha256:hash(bytes),base64:bytes.toString('base64')});
function fixture(){
  const raw=Buffer.from('export const exact = 1;'),br=brotliCompressSync(raw),brHash=hash(br),path='/assets/wxbr11v1-App-12345678.js';
  const worker=Buffer.from('export default {fetch(){}};'),routes=Buffer.from('{"version":1,"include":["/api/*","/assets/wxbr11v1-*"],"exclude":[]}\n'),headers=Buffer.from('/*\n  X-Content-Type-Options: nosniff\n');
  const original=Buffer.from('export default {fetch(){return 1}};'),originalRoutes=Buffer.from('{"version":1,"include":["/api/*"],"exclude":[]}');
  const securityHeaders=Object.fromEntries(['strict-transport-security','x-content-type-options','referrer-policy','permissions-policy','x-frame-options','content-security-policy'].map(x=>[x,x==='x-content-type-options'?'nosniff':'fixture']));
  const entry={sidecar:`/__wx_encoded/${brHash}.br`,bytes:br.length,mime:'application/javascript',etag:`"wx-br-${brHash}"`,rawBytes:raw.length,rawSha256:hash(raw),brSha256:brHash};
  const manifest={schemaVersion:1,qualificationScope:'staging-only-nonpromotable',promotable:false,standaloneShell:false,artifactType:'pre-seal-packaging-overlay',origin:'https://staging.weatherx.org',selectedPaths:[path],sources:{originalWorker:{sha256:hash(original)},originalRoutes:{sha256:hash(originalRoutes)},headers:{sha256:hash(headers)},runtime:{sha256:'a'.repeat(64)}},compression:{format:'br',quality:11},securityHeaders,entries:{[path]:entry},outputs:{worker:{path:'_worker.js',bytes:worker.length,sha256:hash(worker)},routes:{path:'_routes.json',bytes:routes.length,sha256:hash(routes)}}};
  manifest.sealSha256=hash(JSON.stringify(manifest));
  return {manifest,original,originalRoutes,files:[file('index.html',Buffer.from('shell')),file(path.slice(1),raw),file('_headers',headers),file('_worker.js',worker),file('_routes.json',routes),file(entry.sidecar.slice(1),br),file('static-compression-manifest.json',Buffer.from(JSON.stringify(manifest)))]};
}
test('compressed metadata and sidecars are refused under baseline profiles',()=>{
  const f=fixture();assert.throws(()=>validateCompressionFiles(f.files,false),/profile/);
  const stripped=f.files.filter(x=>!x.path.startsWith('__wx_encoded/')&&x.path!=='static-compression-manifest.json');
  assert.throws(()=>validateCompressionFiles(stripped,false),/asset.*route/i);
  const uncompressed=stripped.map(x=>x.path==='_routes.json'?file(x.path,f.originalRoutes):x);
  assert.throws(()=>validateCompressionFiles(uncompressed,false),/prefixed.*profile/i);
  assert.doesNotThrow(()=>validateCompressionFiles(uncompressed.filter(x=>!x.path.startsWith('assets/wxbr11v1-')),false));
});
test('only one fixed compression-prefix route is allowed for compressed candidates',()=>{
  for(const rule of ['/assets/extra-12345678.js','/assets/*','/*']){
    const f=fixture(),routes=JSON.parse(Buffer.from(f.files.find(x=>x.path==='_routes.json').base64,'base64'));
    routes.include.push(rule);const body=Buffer.from(JSON.stringify(routes));
    f.manifest.outputs.routes={path:'_routes.json',bytes:body.length,sha256:hash(body)};
    delete f.manifest.sealSha256;f.manifest.sealSha256=hash(JSON.stringify(f.manifest));
    const rows=f.files.map(x=>x.path==='_routes.json'?file(x.path,body):x.path==='static-compression-manifest.json'?file(x.path,Buffer.from(JSON.stringify(f.manifest))):x);
    assert.throws(()=>validateCompressionFiles(rows,true),/asset.*route/i);
  }
});
test('candidate admission requires compression inventory and refuses relabeling to ordinary core',()=>{
  const f=fixture(),sourceSha='a'.repeat(40),runId='123';
  const shell=f.files.slice().sort((a,b)=>a.path<b.path?-1:1),digest=createHash('sha256');
  for(const row of shell)digest.update(row.path).update('\0').update(String(row.bytes)).update('\0').update(Buffer.from(row.base64,'base64')).update('\0');
  const receipt={gitSha:sourceSha,workflowRunId:runId,releaseId:`git-${sourceSha.slice(0,12)}-run-${runId}`,shellSha256:digest.digest('hex'),shellFileCount:shell.length,shellBytes:shell.reduce((n,x)=>n+x.bytes,0),indexSha256:shell.find(x=>x.path==='index.html').sha256};
  const files=[...f.files,file('health/release.json',Buffer.from(JSON.stringify(receipt)))];
  const c={schemaVersion:1,controlSha:STAGING_CONTROL_SHA,profile:STATIC_COMPRESSION_PROFILE,sourceSha,runId,attempt:'1',workflowSha:'b'.repeat(40),pipelineDigest:'c'.repeat(64),files,artifactDigest:validateFiles(files).digest};
  validateCandidate(c);
  assert.throws(()=>validateCandidate({...c,profile:CORE_RELEASE_PROFILE}),/explicit staging-only profile/);
  const without=files.filter(x=>x.path!=='static-compression-manifest.json');
  assert.throws(()=>validateCandidate({...c,files:without,artifactDigest:validateFiles(without).digest}),/manifest required/);
  assert.throws(()=>requireProductionProfile(c.profile),/cannot enter production/);
  assert.equal(requiredSourceGuard(c.profile),'a22db10b3f76ff84c422352e566c879868b45706');
  assert.ok(POLICY_FILES.includes('tools/ui-static-compression.mjs'));
});
test('packaging completes before release receipt and candidate creation',()=>{
  const source=readFileSync(new URL('../tools/ui-release.mjs',import.meta.url),'utf8');
  const start=source.indexOf('async function build()'),end=source.indexOf('function buildGate()',start),build=source.slice(start,end);
  assert.ok(build.indexOf('await packagePagesWorker(')<build.indexOf('build-release-receipt.mjs'));
  assert.ok(build.indexOf('build-release-receipt.mjs')<build.indexOf('createCandidate('));
  assert.match(source,/command==='build'\) await build\(\)/);
  const verify=source.slice(source.indexOf('async function verify(stage)'),source.indexOf('function retain()'));
  assert.ok(verify.indexOf("if (phase !== 'rollback')")<verify.indexOf('await verifyStaticCompression('));
  assert.match(verify,/stage==='staging'&&staticCompressionProfile\(c.profile\)/);
  assert.match(source,/staticCompressionWireSha256:hash\(proof\)/);
});
test('retention keeps the exact hash-bound public wire receipt alongside the encrypted candidate',()=>{
  const source=readFileSync(new URL('../tools/ui-release.mjs',import.meta.url),'utf8');
  const retain=source.slice(source.indexOf('function retain()'),source.indexOf('async function runRecords()'));
  assert.match(retain,/hash\(compressionProof\),c\.qualification\.staticCompressionWireSha256/);
  assert.match(retain,/writeFileSync\(resolve\(out,'compression-wire\.json'\),compressionProof/);
  assert.ok(retain.indexOf('hash(compressionProof)')<retain.indexOf("writeFileSync(resolve(out,'compression-wire.json')"));
});
test('compressed candidate binds raw bytes, sidecars, worker, routes and headers',()=>{
  const f=fixture();validateCompressionFiles(f.files,true);
  for(const path of ['assets/wxbr11v1-App-12345678.js','_worker.js','_routes.json','_headers']){
    const rows=f.files.map(x=>x.path===path?file(path,Buffer.from('tampered')):x);assert.throws(()=>validateCompressionFiles(rows,true));
  }
  assert.throws(()=>validateCompressionFiles(f.files.filter(x=>x.path!=='static-compression-manifest.json'),true));
  assert.throws(()=>validateCompressionFiles([...f.files,file('__wx_encoded/extra.br',Buffer.from('x'))],true));
});
test('installation refuses mismatched source shell before changing existing files',()=>{
  const root=mkdtempSync(join(tmpdir(),'wx-compression-install-'));
  try{
    const f=fixture(),dist=join(root,'dist'),overlay=join(root,'overlay'),original=join(root,'index.js'),routes=join(dist,'_routes.json');
    mkdirSync(dist);mkdirSync(overlay);writeFileSync(original,f.original);writeFileSync(routes,f.originalRoutes);
    for(const row of f.files){const destination=['_worker.js','_routes.json','static-compression-manifest.json'].includes(row.path)||row.path.startsWith('__wx_encoded/')?overlay:dist;const target=join(destination,row.path);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,Buffer.from(row.base64,'base64'));}
    writeFileSync(join(dist,'assets/wxbr11v1-App-12345678.js'),'wrong');
    assert.throws(()=>installCompressionOverlay({dist,overlay,originalWorkerPath:original,originalRoutesPath:routes}));
    assert.equal(readFileSync(routes,'utf8'),f.originalRoutes.toString());
    writeFileSync(join(dist,'assets/wxbr11v1-App-12345678.js'),Buffer.from(f.files.find(x=>x.path.startsWith('assets/')).base64,'base64'));
    installCompressionOverlay({dist,overlay,originalWorkerPath:original,originalRoutesPath:routes});
    assert.equal(readFileSync(join(dist,'_worker.js'),'utf8'),Buffer.from(f.files.find(x=>x.path==='_worker.js').base64,'base64').toString());
    assert.throws(()=>installCompressionOverlay({dist,overlay,originalWorkerPath:original,originalRoutesPath:routes}),/existing|overwrite/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('selection covers every emitted JS/CSS including lazy modules and worker entries',()=>{
  const root=mkdtempSync(join(tmpdir(),'wx-compression-select-'));
  try{
    mkdirSync(join(root,'assets'));
    const names=['index','App','MapView','shared','lazy','fusion.worker','copy.zh'].map(name=>`wxbr11v1-${name}-12345678.js`);
    names.push('wxbr11v1-index-12345678.css','wxbr11v1-lazy-12345678.css');
    for(const name of names)writeFileSync(join(root,'assets',name),'fixture');
    writeFileSync(join(root,'assets/font-12345678.woff2'),'font');
    const parse=()=>{throw Error('exhaustive selection must not parse module closure');};
    assert.deepEqual(selectCompressionAssets(root,parse),names.map(name=>'/assets/'+name).sort());
  }finally{rmSync(root,{recursive:true,force:true});}
});
