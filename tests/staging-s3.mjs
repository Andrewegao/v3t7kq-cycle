import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createStagingS3, stagingKey } from '../tools/staging-s3.mjs';
const env = { STAGING_R2_ACCOUNT_ID:'a89f9a1af485021fbc60a68b163c7c6e', STAGING_R2_WRITE_ACCESS_KEY_ID:'fixture', STAGING_R2_WRITE_SECRET_ACCESS_KEY:'fixture' };
const bucket='weatherx-data-staging';
const obj = body => ({ Body: Readable.from([body]), ContentLength: Buffer.byteLength(body), ETag:'"fixture"', Metadata:{sha256:'fixture'} });
test('only exact staging buckets and publication prefixes are addressable', () => {
  for (const b of ['weatherx-data-production','weatherx-components-production','other']) assert.throws(()=>stagingKey(b,'releases/current.json'));
  for (const p of ['vault/file','releases/../vault','/releases/a','releases//a']) assert.throws(()=>stagingKey(bucket,p));
  assert.deepEqual(stagingKey(bucket,'releases/current.json'),{Bucket:bucket,Key:'releases/current.json'});
});
test('bounded GET and streaming hash retain byte identity and metadata', async () => {
  const io=createStagingS3(env,{send:async()=>obj('abc')});
  const full=await io.get(bucket,'releases/current.json');
  const digest=await io.hashObject(bucket,'releases/current.json',{maxBytes:3});
  assert.equal(full.body.toString(),'abc'); assert.equal(digest.sha256,full.sha256); assert.equal(digest.body,undefined);
  assert.equal(full.etag,'"fixture"'); assert.deepEqual(full.customMetadata,{sha256:'fixture'});
});
test('short, over-limit and dishonest-length streams fail closed',async()=>{
  for (const object of [obj('abcd'),{...obj('abc'),ContentLength:2},{...obj('ab'),ContentLength:3}]) {
    const io=createStagingS3(env,{send:async()=>object}); await assert.rejects(io.get(bucket,'releases/current.json',{maxBytes:3}));
  }
});
test('only 404 is absence; permission errors are redacted, not treated as missing',async()=>{
  for(const status of [403,404,412,500]){
    const io=createStagingS3(env,{send:async()=>{throw {$metadata:{httpStatusCode:status},message:'PRIVATE SECRET'};}});
    if(status===404)assert.equal(await io.get(bucket,'releases/current.json'),null);
    else await assert.rejects(io.get(bucket,'releases/current.json'),e=>!e.message.includes('PRIVATE'));
  }
});
test('read-only requests retry bounded transient R2 failures while writes never retry',async()=>{
  const calls={get:0,list:0,put:0},client={send:async command=>{
    const name=command.constructor.name;
    if(name==='GetObjectCommand'){
      calls.get+=1;if(calls.get<3)throw {$metadata:{httpStatusCode:503},message:'PRIVATE'};return obj('abc');
    }
    if(name==='ListObjectsV2Command'){
      calls.list+=1;if(calls.list<2)throw {$metadata:{httpStatusCode:429},message:'PRIVATE'};
      return {Contents:[{Key:'releases/a/one',Size:3}]};
    }
    calls.put+=1;throw {$metadata:{httpStatusCode:503},message:'PRIVATE'};
  }};
  const io=createStagingS3(env,client,{pause:async()=>{}});
  assert.equal((await io.hashObject(bucket,'releases/current.json',{maxBytes:3})).bytes,3);
  assert.equal((await io.list(bucket,'releases/a/',{maxObjects:1})).length,1);
  await assert.rejects(io.put(bucket,'releases/current.json','{}',{ifMatch:'"old"'}),e=>e.code==='S3_TRANSIENT'&&!e.message.includes('PRIVATE'));
  assert.deepEqual(calls,{get:3,list:2,put:1});
});
test('CAS writes have exact bucket, key, metadata and precondition; no credential-chain fallback',async()=>{
  const commands=[];const io=createStagingS3(env,{send:async c=>{commands.push(c);return {ETag:'"new"'};}});
  await io.put(bucket,'catalogs/current.json','{}',{ifMatch:'"old"',customMetadata:{'activation-id':'123-1'}});
  assert.equal(commands[0].input.IfMatch,'"old"');assert.equal(commands[0].input.IfNoneMatch,undefined);
  assert.equal(commands[0].input.Bucket,bucket);assert.deepEqual(commands[0].input.Metadata,{'activation-id':'123-1'});
  for(const key of ['vault/x','releases/x/manifest.json','catalogs/unreviewed.json','shared-read/other.json'])await assert.rejects(io.put(bucket,key,'{}',{ifNoneMatch:'*'}));
  await io.put(bucket,'shared-read/pin.json','{}',{ifNoneMatch:'*'});assert.equal(commands.at(-1).input.Key,'shared-read/pin.json');
  await assert.rejects(io.put(bucket,'releases/current.json','{}',{}));
  await assert.rejects(io.put(bucket,'releases/current.json','{}',{ifMatch:'"old"',ifNoneMatch:'*'}));
  assert.throws(()=>createStagingS3({...env,STAGING_R2_WRITE_SECRET_ACCESS_KEY:''}));
});
test('list pagination is bounded, prefix checked, duplicate and stuck pages refused',async()=>{
  let n=0;const io=createStagingS3(env,{send:async()=>++n===1?{IsTruncated:true,NextContinuationToken:'next',Contents:[{Key:'releases/a/one',Size:2}]}:{Contents:[{Key:'releases/a/two',Size:3}]}});
  assert.equal((await io.list(bucket,'releases/a/',{maxObjects:2})).length,2);
  const bad=createStagingS3(env,{send:async()=>({IsTruncated:true,NextContinuationToken:'repeat',Contents:[]})});
  await assert.rejects(bad.list(bucket,'releases/a/',{maxObjects:2}),/pagination/);
  const wrong=createStagingS3(env,{send:async()=>({Contents:[{Key:'vault/no',Size:1}]})});
  await assert.rejects(wrong.list(bucket,'releases/a/',{maxObjects:2}));
});
test('restore preflight preserves ordinary metadata and refuses anything the writer cannot round-trip',async()=>{
  const commands=[],io=createStagingS3(env,{send:async c=>{commands.push(c);return {ETag:'"new"'};}});
  const previous={customMetadata:{source:'https://weatherx.org/a?x=1',note:'two words',empty:''},httpMetadata:{contentType:'application/json',cacheControl:'public, max-age=30'}};
  io.validateRestore(previous);
  await io.put(bucket,'releases/current.json','{}',{ifMatch:'"old"',...previous});
  assert.deepEqual(commands[0].input.Metadata,previous.customMetadata);
  assert.equal(commands[0].input.ContentType,previous.httpMetadata.contentType);
  assert.equal(commands[0].input.CacheControl,previous.httpMetadata.cacheControl);
  for(const extra of [{contentEncoding:'gzip'},{expires:new Date()},{unknown:'value'},{contentType:'bad\nheader'}])
    assert.throws(()=>io.validateRestore({...previous,httpMetadata:{...previous.httpMetadata,...extra}}));
  assert.throws(()=>io.validateRestore({...previous,customMetadata:{note:'bad\nvalue'}}));
  const reader=createStagingS3(env,{send:async()=>({...obj('{}'),ContentEncoding:'gzip'})});
  const read=await reader.get(bucket,'releases/current.json');
  assert.equal(read.httpMetadata.contentEncoding,'gzip');assert.throws(()=>reader.validateRestore(read));
});
