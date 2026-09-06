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
test('missing Vary reports the exact probe and only allowlisted response metadata',async()=>{
  const secret='must-not-appear-in-wire-diagnostics';
  await assert.rejects(verifyStaticCompression(origin,manifest,async(...args)=>{
    const r=await request(...args);r.headers.delete('vary');r.headers.set('cf-cache-status','HIT');r.headers.set('age','209748');
    r.headers.set('set-cookie',`session=${secret}`);r.headers.set('authorization',`Bearer ${secret}`);r.headers.set('x-private-debug',secret);
    return r;
  }),error=>{
    const message=String(error);
    assert.match(message,/\/assets\/App-12345678\.js/);assert.match(message,/freshness/);assert.match(message,/encoding=br/);
    assert.match(message,/"status":200/);assert.match(message,/"vary":null/);assert.match(message,/"content-encoding":"br"/);
    assert.match(message,/\\"sealed\\"/);assert.match(message,/"cf-cache-status":"HIT"/);assert.match(message,/"age":"209748"/);
    const metadata=JSON.parse(message.slice(message.indexOf('response=')+'response='.length));
    assert.deepEqual(Object.keys(metadata).sort(),['age','cf-cache-status','content-encoding','etag','status','vary']);
    assert.doesNotMatch(message,new RegExp(secret));assert.doesNotMatch(message,/set-cookie|authorization|x-private-debug|export const x/);
    return true;
  });
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
test('first wire failure cancels peers and never schedules remaining assets',async()=>{
  const paths=Array.from({length:12},(_,i)=>`/assets/wxbr11v1-test${i}-12345678.js`);
  const many={...manifest,selectedPaths:paths,entries:Object.fromEntries(paths.map(p=>[p,entry]))};
  const started=[],aborted=[];
  const result=verifyStaticCompression(origin,many,async(url,options)=>{
    started.push(url.pathname);
    if(url.pathname===paths[0]){
      await new Promise(resolve=>setImmediate(resolve));
      const r=await request(new URL(origin+path),options);r.headers.delete('vary');return r;
    }
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{cleanup();request(new URL(origin+path),options).then(resolve,reject);},40);
      const abort=()=>{clearTimeout(timer);cleanup();aborted.push(url.pathname);reject(options.signal.reason);};
      const cleanup=()=>options.signal?.removeEventListener('abort',abort);
      options.signal?.addEventListener('abort',abort,{once:true});
    });
  });
  await assert.rejects(result,error=>{
    assert.match(error.message,/test0-12345678/);assert.match(error.message,/Vary Accept-Encoding missing/);return true;
  });
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.deepEqual(started,paths.slice(0,4),'failure must not leave peers walking the inventory');
  assert.deepEqual(aborted.sort(),paths.slice(1,4).sort(),'all active peers must receive cancellation');
});
