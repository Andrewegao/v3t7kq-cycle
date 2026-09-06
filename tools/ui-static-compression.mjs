// Controller-owned validation. Publisher treats compressed packages as opaque bytes;
// it never imports or executes candidate code. No network, credentials or cloud writes.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {brotliDecompressSync} from 'node:zlib';
import {readFileSync,readdirSync,lstatSync,existsSync,mkdirSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const MANIFEST='static-compression-manifest.json';
const PREFIX='/assets/wxbr11v1-',PREFIX_ROUTE=PREFIX+'*';
const ASSET=/^\/assets\/wxbr11v1-[A-Za-z0-9_][A-Za-z0-9_.-]*-[A-Za-z0-9_-]{8,}\.(js|css)$/;
const HASH=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const MAX_FILE=32*1024*1024,MAX_TOTAL=96*1024*1024;
const security=['strict-transport-security','x-content-type-options','referrer-policy','permissions-policy','x-frame-options','content-security-policy'];
function bytes(file){assert.ok(file);const body=Buffer.from(file.base64,'base64');assert.equal(body.length,file.bytes);assert.equal(hash(body),file.sha256);return body;}
function checkPath(path){assert.match(path,ASSET);assert.ok(path.length<=100);return path;}
function assetRoute(rule){
  assert.equal(typeof rule,'string');
  return rule==='/assets'||rule.startsWith('/assets/')||(rule.endsWith('*')&&'/assets/'.startsWith(rule.slice(0,-1)));
}
function browserAssets(paths){
  const selected=[];
  for(const path of paths){
    assert.equal(typeof path,'string');
    if(path.startsWith(PREFIX)||path.startsWith('/assets/')&&/\.(?:js|css)$/i.test(path))selected.push(checkPath(path));
  }
  assert.ok(selected.length>0&&selected.length<=512,'browser asset inventory must contain 1–512 files');
  assert.equal(new Set(selected).size,selected.length,'duplicate browser asset inventory');
  return selected.sort();
}
function validateRoutes(routes){
  assert.equal(routes.version,1);assert.ok(Array.isArray(routes.include)&&Array.isArray(routes.exclude));
  const all=[...routes.include,...routes.exclude];assert.ok(all.length<=100);
  for(const rule of all)assert.ok(typeof rule==='string'&&rule.length<=100&&/^\/[A-Za-z0-9_./:-]*\*?$/.test(rule)
    &&!rule.includes('//')&&!rule.split('/').some(part=>part==='.'||part==='..'),'unsafe compression route');
  assert.equal(new Set(all).size,all.length,'duplicate compression route');
  return routes;
}
function inventory(root){
  const rows=[];let total=0;
  function walk(dir,prefix=''){
    const stat=lstatSync(dir);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'real directory required');
    for(const name of readdirSync(dir).sort()){
      assert.match(name,/^[A-Za-z0-9_.@+-]+$/);const path=prefix+name,full=resolve(dir,name),s=lstatSync(full);
      assert.ok(!s.isSymbolicLink(),'symlink refused');if(s.isDirectory()){walk(full,path+'/');continue;}
      assert.ok(s.isFile()&&s.size<=MAX_FILE,'bounded regular file required');total+=s.size;assert.ok(total<=MAX_TOTAL);
      const body=readFileSync(full);rows.push({path,bytes:body.length,sha256:hash(body),base64:body.toString('base64')});
    }
  }walk(root);return rows;
}
export function validateCompressionFiles(files,enabled){
  assert.equal(new Set(files.map(f=>f.path)).size,files.length,'duplicate inventory paths');
  const matches=files.filter(f=>f.path===MANIFEST),sidecars=files.filter(f=>f.path.startsWith('__wx_encoded/'));
  if(!enabled){
    assert.equal(matches.length+sidecars.length,0,'compression requires an explicit staging-only profile');
    const routes=JSON.parse(bytes(files.find(f=>f.path==='_routes.json')));
    assert.ok(Array.isArray(routes.include));
    assert.ok(!routes.include.some(assetRoute),'asset Worker routes require the compression profile');
    assert.ok(!files.some(f=>('/'+f.path).startsWith(PREFIX)),'prefixed artifacts require the compression profile');
    return null;
  }
  assert.equal(matches.length,1,'one sealed compression manifest required');assert.ok(matches[0].bytes<=1024*1024);
  const manifest=JSON.parse(bytes(matches[0])),{sealSha256,...payload}=manifest;
  assert.match(sealSha256,HASH);assert.equal(hash(JSON.stringify(payload)),sealSha256,'compression manifest seal mismatch');
  assert.equal(manifest.schemaVersion,1);assert.equal(manifest.qualificationScope,'staging-only-nonpromotable');
  assert.equal(manifest.promotable,false);assert.equal(manifest.standaloneShell,false);assert.equal(manifest.artifactType,'pre-seal-packaging-overlay');
  assert.equal(manifest.origin,'https://staging.weatherx.org');assert.equal(manifest.compression.format,'br');assert.equal(manifest.compression.quality,11);
  assert.deepEqual(Object.keys(manifest.securityHeaders).sort(),security.slice().sort());assert.equal(manifest.securityHeaders['x-content-type-options'],'nosniff');
  assert.ok(Array.isArray(manifest.selectedPaths)&&manifest.selectedPaths.length>0&&manifest.selectedPaths.length<=512);
  assert.equal(new Set(manifest.selectedPaths).size,manifest.selectedPaths.length);
  assert.deepEqual(Object.keys(manifest.entries),manifest.selectedPaths);
  assert.deepEqual(manifest.selectedPaths.slice().sort(),browserAssets(files.map(f=>'/'+f.path)),
    'sealed asset inventory must exhaustively match every emitted browser JS/CSS');
  const expectedSidecars=new Set();let total=0;
  for(const path of manifest.selectedPaths){
    checkPath(path);const entry=manifest.entries[path];assert.match(entry.brSha256,HASH);assert.match(entry.rawSha256,HASH);
    assert.equal(entry.sidecar,`/__wx_encoded/${entry.brSha256}.br`);assert.equal(entry.etag,`"wx-br-${entry.brSha256}"`);
    assert.equal(entry.mime,path.endsWith('.js')?'application/javascript':'text/css');
    assert.ok(Number.isSafeInteger(entry.rawBytes)&&entry.rawBytes>0&&entry.rawBytes<=MAX_FILE);
    assert.ok(Number.isSafeInteger(entry.bytes)&&entry.bytes>0&&entry.bytes<=MAX_FILE);
    const raw=bytes(files.find(f=>f.path===path.slice(1))),br=bytes(files.find(f=>f.path===entry.sidecar.slice(1)));
    assert.equal(raw.length,entry.rawBytes);assert.equal(hash(raw),entry.rawSha256,'compressed asset differs from source shell');
    assert.equal(br.length,entry.bytes);assert.equal(hash(br),entry.brSha256);
    total+=raw.length;assert.ok(total<=MAX_TOTAL);assert.deepEqual(brotliDecompressSync(br,{maxOutputLength:entry.rawBytes}),raw);
    expectedSidecars.add(entry.sidecar.slice(1));
  }
  assert.deepEqual(sidecars.map(f=>f.path).sort(),[...expectedSidecars].sort(),'unexpected compressed sidecar inventory');
  assert.deepEqual(Object.keys(manifest.outputs).sort(),['routes','worker']);
  for(const [name,path]of [['worker','_worker.js'],['routes','_routes.json']]){
    const expected=manifest.outputs[name],body=bytes(files.find(f=>f.path===path));assert.equal(expected.path,path);assert.equal(body.length,expected.bytes);assert.equal(hash(body),expected.sha256);
  }
  assert.equal(hash(bytes(files.find(f=>f.path==='_headers'))),manifest.sources.headers.sha256,'header policy changed');
  const routes=validateRoutes(JSON.parse(bytes(files.find(f=>f.path==='_routes.json'))));
  assert.deepEqual(routes.include.filter(assetRoute),[PREFIX_ROUTE],'asset Worker routes must contain only the fixed compression prefix');
  assert.ok(!routes.exclude.some(assetRoute),'asset exclusion route can bypass compression');
  assert.ok(![...routes.include,...routes.exclude].some(x=>x.startsWith('/__wx_encoded/')),'sidecars must not add Worker routes');
  return manifest;
}

export function installCompressionOverlay({dist,overlay,originalWorkerPath,originalRoutesPath}){
  assert.equal(existsSync(resolve(dist,'_worker.js')),false,'cannot overwrite existing Worker');
  assert.equal(existsSync(resolve(dist,MANIFEST)),false,'cannot overwrite existing compression package');
  assert.equal(existsSync(resolve(dist,'__wx_encoded')),false,'cannot overwrite existing sidecars');
  const before=inventory(dist),over=inventory(overlay);
  const final=[...before.filter(f=>f.path!=='_routes.json'),...over];
  const manifest=validateCompressionFiles(final,true);
  const expected=['_worker.js','_routes.json',MANIFEST,...new Set(Object.values(manifest.entries).map(e=>e.sidecar.slice(1)))].sort();
  assert.deepEqual(over.map(f=>f.path).sort(),expected,'unexpected overlay files');
  assert.equal(hash(readFileSync(originalWorkerPath)),manifest.sources.originalWorker.sha256,'original Worker changed');
  const originalRoutes=readFileSync(originalRoutesPath);
  assert.equal(hash(originalRoutes),manifest.sources.originalRoutes.sha256,'original routes changed');
  const original=validateRoutes(JSON.parse(originalRoutes)),merged=JSON.parse(bytes(over.find(f=>f.path==='_routes.json')));
  assert.ok(![...original.include,...original.exclude].some(assetRoute),'original asset routes overlap compression');
  assert.deepEqual(merged,{...original,include:[...original.include,PREFIX_ROUTE]},'routing policy changed beyond compression prefix');
  // Every check precedes writes. A partial local failure has no candidate or release receipt.
  for(const f of over.filter(f=>f.path!=='_routes.json'&&f.path!==MANIFEST)){
    const target=resolve(dist,f.path);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,bytes(f),{flag:'wx',mode:0o600});
  }
  const temporary=resolve(dist,'_routes.compression.tmp');
  writeFileSync(temporary,bytes(over.find(f=>f.path==='_routes.json')),{flag:'wx',mode:0o600});
  try{renameSync(temporary,resolve(dist,'_routes.json'));}finally{if(existsSync(temporary))unlinkSync(temporary);}
  writeFileSync(resolve(dist,MANIFEST),bytes(over.find(f=>f.path===MANIFEST)),{flag:'wx',mode:0o600});
  validateCompressionFiles(inventory(dist),true);
  return manifest;
}

export function selectCompressionAssets(dist,_parseModule){
  // Membership is permanent for this namespace, not inferred from today's startup graph.
  // Including lazy and worker code prevents a previously cached Pages representation from
  // bypassing the Worker when the same immutable asset later becomes mandatory.
  void _parseModule;
  const root=lstatSync(dist);assert.ok(root.isDirectory()&&!root.isSymbolicLink(),'real asset root required');
  return browserAssets(inventory(resolve(dist,'assets')).map(f=>'/assets/'+f.path));
}
