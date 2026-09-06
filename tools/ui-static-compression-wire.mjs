// Controller-owned raw HTTP qualification. Never executes a candidate module.
import assert from 'node:assert/strict';
import {request as httpsRequest} from 'node:https';
import {createHash} from 'node:crypto';
const hash=body=>createHash('sha256').update(body).digest('hex');
function rawRequest(url,{method='GET',headers={},limit=32*1024*1024}={}){
  return new Promise((resolve,reject)=>{
    const request=httpsRequest(url,{method,headers},response=>{
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>limit)response.destroy(new Error('compression probe exceeds byte limit'));else chunks.push(chunk);});
      response.on('error',reject);
      response.on('end',()=>resolve({status:response.statusCode,headers:new Headers(response.headers),body:Buffer.concat(chunks)}));
    });
    const timer=setTimeout(()=>request.destroy(new Error('compression wire probe deadline')),20000);
    request.on('error',reject);request.on('close',()=>clearTimeout(timer));request.end();
  });
}
export async function verifyStaticCompression(origin,manifest,request=rawRequest){
  assert.equal(origin,'https://staging.weatherx.org','compression qualification is staging-only');
  assert.equal(manifest.origin,origin);
  const rows=[];let next=0;
  async function worker(){
    while(next<manifest.selectedPaths.length){
      const path=manifest.selectedPaths[next++],entry=manifest.entries[path];
      const url=new URL(path,origin);
      const br=await request(url,{headers:{'Accept-Encoding':'br','Cache-Control':'no-cache'}});
      assert.equal(br.status,200,`${path}: compressed response status`);
      assert.equal(br.headers.get('content-encoding'),'br',`${path}: sealed Brotli not served`);
      assert.equal(br.body.length,entry.bytes);assert.equal(hash(br.body),entry.brSha256,`${path}: wire bytes differ`);
      assert.equal(br.headers.get('etag'),entry.etag);assert.equal(br.headers.get('content-type')?.split(';')[0],entry.mime);
      assert.equal(br.headers.get('cache-control'),'public, max-age=31536000, immutable, no-transform');
      // Cloudflare consumes this private directive instead of forwarding it.
      // https://developers.cloudflare.com/cache/concepts/cdn-cache-control/
      // Runtime contracts prove emission; its absence on the wire is expected.
      if(br.headers.has('cloudflare-cdn-cache-control'))assert.equal(br.headers.get('cloudflare-cdn-cache-control'),'no-store');
      assert.ok(br.headers.get('vary')?.toLowerCase().split(',').map(x=>x.trim()).includes('accept-encoding'));
      for(const [name,value]of Object.entries(manifest.securityHeaders))assert.equal(br.headers.get(name),value,`${path}: security header ${name}`);
      const plain=await request(url,{headers:{'Accept-Encoding':'identity','Cache-Control':'no-cache'}});
      assert.equal(plain.status,200);assert.ok(!plain.headers.get('content-encoding')||plain.headers.get('content-encoding')==='identity');
      assert.equal(plain.body.length,entry.rawBytes);assert.equal(hash(plain.body),entry.rawSha256,`${path}: identity fallback differs`);
      const conditional=await request(url,{headers:{'Accept-Encoding':'br','If-None-Match':entry.etag}});
      assert.equal(conditional.status,304);assert.equal(conditional.body.length,0);assert.equal(conditional.headers.get('etag'),entry.etag);
      const head=await request(url,{method:'HEAD',headers:{'Accept-Encoding':'br'}});
      assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(head.headers.get('etag'),entry.etag);
      assert.equal(head.headers.get('content-encoding'),'br');
      rows.push({path,rawBytes:plain.body.length,brBytes:br.body.length,brSha256:hash(br.body),conditional:304});
    }
  }
  await Promise.all(Array.from({length:Math.min(4,manifest.selectedPaths.length)},worker));
  return {schemaVersion:1,origin,sealSha256:manifest.sealSha256,rows:rows.sort((a,b)=>a.path.localeCompare(b.path))};
}
