// Controller-owned raw HTTP qualification. Never executes a candidate module.
import assert from 'node:assert/strict';
import {request as httpsRequest} from 'node:https';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const hash=body=>createHash('sha256').update(body).digest('hex');
function diagnosticHeader(headers,name){
  const value=headers?.get?.(name);return value===null||value===undefined?null:String(value).replace(/[^\x20-\x7e]/g,'?').slice(0,256);
}
function responseDiagnostic(response){
  return {status:Number.isInteger(response?.status)?response.status:null,vary:diagnosticHeader(response?.headers,'vary'),
    'content-encoding':diagnosticHeader(response?.headers,'content-encoding'),etag:diagnosticHeader(response?.headers,'etag'),
    'cf-cache-status':diagnosticHeader(response?.headers,'cf-cache-status'),age:diagnosticHeader(response?.headers,'age')};
}
function failureDetail(error){
  if(error?.code==='ERR_ASSERTION')return String(error.message).replace(/[^\x20-\x7e]/g,'?').slice(0,256);
  if(error?.message==='compression probe exceeds byte limit'||error?.message==='compression wire probe deadline')return error.message;
  const name=/^[A-Za-z][A-Za-z0-9]*$/.test(error?.name)?error.name:'Error';
  const code=/^[A-Z0-9_-]{1,64}$/.test(error?.code)?` code=${error.code}`:'';return `${name}${code}`;
}
function contextualFailure(error,{path,probe,encoding,response}){
  return new Error(`${path}: probe=${probe} encoding=${encoding} failed: ${failureDetail(error)}; response=${JSON.stringify(responseDiagnostic(response))}`);
}
function rawRequest(url,{method='GET',headers={},limit=32*1024*1024,signal}={}){
  return new Promise((resolve,reject)=>{
    // Node's request signal destroys both the request and active response/socket on abort.
    const request=httpsRequest(url,{method,headers,signal},response=>{
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
  const rows=[];let next=0,firstFailure;
  const cancellation=new AbortController();
  async function worker(){
    while(!cancellation.signal.aborted&&next<manifest.selectedPaths.length){
      const path=manifest.selectedPaths[next++],entry=manifest.entries[path];
      const url=new URL(path,origin);
      async function probe(name,encoding,options,verify){
        let response;
        try{
          cancellation.signal.throwIfAborted();
          response=await request(url,{...options,signal:cancellation.signal});
          cancellation.signal.throwIfAborted();
          return verify(response);
        }catch(error){
          // Preserve the first failed assertion, not a peer's cancellation. Abort before
          // any peer can claim another probe/path and drain them before rollback starts.
          if(!firstFailure){
            firstFailure=contextualFailure(error,{path,probe:name,encoding,response});
            cancellation.abort(firstFailure);
          }
          throw firstFailure;
        }
      }
      function verifyBody(response,encoding){
        const {headers,body}=response;
        assert.equal(response.status,200,`${path}: ${encoding} response status`);
        assert.equal(headers.get('content-type')?.split(';')[0],entry.mime,`${path}: ${encoding} content type`);
        const cache=headers.get('cache-control')?.toLowerCase().split(',').map(x=>x.trim());
        assert.ok(cache&&['public','max-age=31536000','immutable'].every(x=>cache.includes(x)),`${path}: immutable browser policy missing`);
        assert.ok(!cache.some(x=>['private','no-cache','no-store','must-revalidate'].includes(x)),`${path}: forbidden browser cache directive`);
        // Cloudflare consumes this private directive instead of forwarding it.
        // https://developers.cloudflare.com/cache/concepts/cdn-cache-control/
        if(headers.has('cloudflare-cdn-cache-control'))assert.equal(headers.get('cloudflare-cdn-cache-control'),'no-store',`${path}: private CDN policy`);
        assert.ok(headers.get('vary')?.toLowerCase().split(',').map(x=>x.trim()).includes('accept-encoding'),`${path}: Vary Accept-Encoding missing`);
        for(const [name,value]of Object.entries(manifest.securityHeaders))assert.equal(headers.get(name),value,`${path}: security header ${name}`);
        const actual=headers.get('content-encoding')||'identity';
        if(encoding==='br'){
          assert.equal(actual,'br',`${path}: sealed Brotli not served`);
          assert.equal(body.length,entry.bytes,`${path}: Brotli byte length`);assert.equal(hash(body),entry.brSha256,`${path}: wire bytes differ`);
          assert.equal(headers.get('etag'),entry.etag,`${path}: Brotli validator`);assert.ok(cache.includes('no-transform'),`${path}: Brotli no-transform policy`);
        }else{
          assert.ok(actual==='identity'||(encoding==='gzip'&&actual==='gzip'),`${path}: wrong encoding variant`);
          const decoded=actual==='gzip'?gunzipSync(body,{maxOutputLength:entry.rawBytes}):body;
          assert.equal(decoded.length,entry.rawBytes,`${path}: ${encoding} decoded byte length`);assert.equal(hash(decoded),entry.rawSha256,`${path}: ${encoding} fallback differs`);
          assert.notEqual(headers.get('etag'),entry.etag,'fallback must not reuse sealed Brotli validator');
        }
        return {encoding:actual,wireBytes:body.length,cacheStatus:headers.get('cf-cache-status'),age:headers.get('age')};
      }
      // Freshness and cache behavior are distinct probes. Ordinary requests must
      // not force revalidation: doing so can hide a cross-encoding cached object.
      await probe('freshness','br',{headers:{'Accept-Encoding':'br','Cache-Control':'no-cache'}},response=>verifyBody(response,'br'));
      const variants=[];
      for(const [index,encoding]of ['br','identity','gzip','br'].entries())variants.push(await probe(`ordinary-${index+1}`,encoding,
        {headers:{'Accept-Encoding':encoding}},response=>verifyBody(response,encoding)));
      await probe('cross-validator','identity',{headers:{'Accept-Encoding':'identity','If-None-Match':entry.etag}},response=>verifyBody(response,'identity'));
      await probe('conditional','br',{headers:{'Accept-Encoding':'br','If-None-Match':entry.etag}},conditional=>{
        assert.equal(conditional.status,304,`${path}: conditional status`);assert.equal(conditional.body.length,0,`${path}: conditional body`);
        assert.equal(conditional.headers.get('etag'),entry.etag,`${path}: conditional validator`);
      });
      await probe('head','br',{method:'HEAD',headers:{'Accept-Encoding':'br'}},head=>{
        assert.equal(head.status,200,`${path}: HEAD status`);assert.equal(head.body.length,0,`${path}: HEAD body`);
        assert.equal(head.headers.get('etag'),entry.etag,`${path}: HEAD validator`);
        assert.equal(head.headers.get('content-encoding'),'br',`${path}: HEAD encoding`);
      });
      rows.push({path,rawBytes:entry.rawBytes,brBytes:entry.bytes,brSha256:entry.brSha256,variants,conditional:304});
    }
  }
  await Promise.allSettled(Array.from({length:Math.min(4,manifest.selectedPaths.length)},()=>worker().catch(error=>{
    // Also fail closed for malformed input/programming errors outside a named probe.
    if(!firstFailure){firstFailure=new Error(`compression worker failed: ${failureDetail(error)}`);cancellation.abort(firstFailure);}
    throw firstFailure;
  })));
  if(firstFailure)throw firstFailure;
  return {schemaVersion:1,origin,sealSha256:manifest.sealSha256,rows:rows.sort((a,b)=>a.path.localeCompare(b.path))};
}
