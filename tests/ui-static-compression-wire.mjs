import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {brotliCompressSync,gzipSync} from 'node:zlib';
import {verifyStaticCompression} from '../tools/ui-static-compression-wire.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const origin='https://staging.weatherx.org',path='/assets/App-12345678.js',raw=Buffer.from('export const x=1;'),br=brotliCompressSync(raw);
const entry={bytes:br.length,rawBytes:raw.length,brSha256:hash(br),rawSha256:hash(raw),etag:'"sealed"',mime:'application/javascript'};
const manifest={origin,sealSha256:'a'.repeat(64),selectedPaths:[path],entries:{[path]:entry},securityHeaders:{'x-content-type-options':'nosniff'}};
const response=(status,body,headers={})=>({status,body,headers:new Headers(headers)});
async function request(url,{headers,method}){
  assert.equal(url.href,origin+path);
  const encoding=headers['Accept-Encoding'];
  if(headers['If-None-Match']&&encoding==='br')return response(304,Buffer.alloc(0),{etag:entry.etag});
  const h={'content-type':entry.mime,etag:encoding==='br'?entry.etag:'"original"',vary:'Accept-Encoding','x-content-type-options':'nosniff','cache-control':'public, max-age=31536000, immutable'+(encoding==='br'?', no-transform':''),'cloudflare-cdn-cache-control':'no-store'};
  if(encoding!=='identity')h['content-encoding']=encoding;
  return response(200,method==='HEAD'?Buffer.alloc(0):encoding==='br'?br:encoding==='gzip'?gzipSync(raw):raw,h);
}
test('wire gate proves actual Brotli bytes, identity fallback and conditional request',async()=>{
  const proof=await verifyStaticCompression(origin,manifest,request);assert.equal(proof.rows.length,1);assert.equal(proof.rows[0].brSha256,entry.brSha256);
});
test('wire gate permits Cloudflare to strip its private CDN cache control header',async()=>{
  await verifyStaticCompression(origin,manifest,async(...args)=>{const r=await request(...args);r.headers.delete('cloudflare-cdn-cache-control');return r;});
});
test('ordinary variant sequence and cross-encoding validator cannot be hidden by no-cache probes',async()=>{
  const calls=[];
  await verifyStaticCompression(origin,manifest,async(url,options)=>{calls.push(options);return request(url,options);});
  const ordinary=calls.filter(c=>!c.headers['Cache-Control']&&!c.headers['If-None-Match']&&c.method!=='HEAD');
  assert.deepEqual(ordinary.map(c=>c.headers['Accept-Encoding']),['br','identity','gzip','br']);
  assert.ok(calls.some(c=>c.headers['Accept-Encoding']==='identity'&&c.headers['If-None-Match']===entry.etag));
  await assert.rejects(verifyStaticCompression(origin,manifest,async(url,options)=>{
    if(!options.headers['Cache-Control']&&options.headers['Accept-Encoding']==='identity')return request(url,{headers:{'Accept-Encoding':'br'}});
    return request(url,options);
  }));
  await assert.rejects(verifyStaticCompression(origin,manifest,async(url,options)=>{
    if(options.headers['Accept-Encoding']==='identity'&&options.headers['If-None-Match'])return response(304,Buffer.alloc(0),{etag:entry.etag});
    return request(url,options);
  }));
});
test('wire gate refuses silent compression bypass, wrong bytes, headers, and production before requests',async()=>{
  for(const mutate of [r=>{r.body=raw;},r=>{r.headers.delete('content-encoding');},r=>{r.headers.delete('x-content-type-options');},r=>{r.headers.set('etag','"wrong"');}]){
    await assert.rejects(verifyStaticCompression(origin,manifest,async(...args)=>{const r=await request(...args);mutate(r);return r;}));
  }
  let calls=0;await assert.rejects(verifyStaticCompression('https://weatherx.org',manifest,()=>{calls++;}),/staging-only/);assert.equal(calls,0);
});
