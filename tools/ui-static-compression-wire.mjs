// Controller-owned raw HTTP qualification. Never executes a candidate module.
import assert from 'node:assert/strict';
import {request as httpsRequest} from 'node:https';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
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
      function verifyBody(response,encoding){
        const {headers,body}=response;
        assert.equal(response.status,200,`${path}: ${encoding} response status`);
        assert.equal(headers.get('content-type')?.split(';')[0],entry.mime);
        const cache=headers.get('cache-control')?.toLowerCase().split(',').map(x=>x.trim());
        assert.ok(cache&&['public','max-age=31536000','immutable'].every(x=>cache.includes(x)),`${path}: immutable browser policy missing`);
        assert.ok(!cache.some(x=>['private','no-cache','no-store','must-revalidate'].includes(x)));
        // Cloudflare consumes this private directive instead of forwarding it.
        // https://developers.cloudflare.com/cache/concepts/cdn-cache-control/
        if(headers.has('cloudflare-cdn-cache-control'))assert.equal(headers.get('cloudflare-cdn-cache-control'),'no-store');
        assert.ok(headers.get('vary')?.toLowerCase().split(',').map(x=>x.trim()).includes('accept-encoding'));
        for(const [name,value]of Object.entries(manifest.securityHeaders))assert.equal(headers.get(name),value,`${path}: security header ${name}`);
        const actual=headers.get('content-encoding')||'identity';
        if(encoding==='br'){
          assert.equal(actual,'br',`${path}: sealed Brotli not served`);
          assert.equal(body.length,entry.bytes);assert.equal(hash(body),entry.brSha256,`${path}: wire bytes differ`);
          assert.equal(headers.get('etag'),entry.etag);assert.ok(cache.includes('no-transform'));
        }else{
          assert.ok(actual==='identity'||(encoding==='gzip'&&actual==='gzip'),`${path}: wrong encoding variant`);
          const decoded=actual==='gzip'?gunzipSync(body,{maxOutputLength:entry.rawBytes}):body;
          assert.equal(decoded.length,entry.rawBytes);assert.equal(hash(decoded),entry.rawSha256,`${path}: ${encoding} fallback differs`);
          assert.notEqual(headers.get('etag'),entry.etag,'fallback must not reuse sealed Brotli validator');
        }
        return {encoding:actual,wireBytes:body.length,cacheStatus:headers.get('cf-cache-status'),age:headers.get('age')};
      }
      // Freshness and cache behavior are distinct probes. Ordinary requests must
      // not force revalidation: doing so can hide a cross-encoding cached object.
      verifyBody(await request(url,{headers:{'Accept-Encoding':'br','Cache-Control':'no-cache'}}),'br');
      const variants=[];
      for(const encoding of ['br','identity','gzip','br'])variants.push(verifyBody(await request(url,{headers:{'Accept-Encoding':encoding}}),encoding));
      verifyBody(await request(url,{headers:{'Accept-Encoding':'identity','If-None-Match':entry.etag}}),'identity');
      const conditional=await request(url,{headers:{'Accept-Encoding':'br','If-None-Match':entry.etag}});
      assert.equal(conditional.status,304);assert.equal(conditional.body.length,0);assert.equal(conditional.headers.get('etag'),entry.etag);
      const head=await request(url,{method:'HEAD',headers:{'Accept-Encoding':'br'}});
      assert.equal(head.status,200);assert.equal(head.body.length,0);assert.equal(head.headers.get('etag'),entry.etag);
      assert.equal(head.headers.get('content-encoding'),'br');
      rows.push({path,rawBytes:entry.rawBytes,brBytes:entry.bytes,brSha256:entry.brSha256,variants,conditional:304});
    }
  }
  await Promise.all(Array.from({length:Math.min(4,manifest.selectedPaths.length)},worker));
  return {schemaVersion:1,origin,sealSha256:manifest.sealSha256,rows:rows.sort((a,b)=>a.path.localeCompare(b.path))};
}
