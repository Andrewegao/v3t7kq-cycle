// Explicit staging-only S3 adapter. No default credential chain, REST token,
// producer execution, bucket mutation, deletion, or arbitrary endpoint option.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js';
import { ACCOUNT, safePath } from './shared-data.mjs';

export function stagingKey(bucket, key) {
  safePath(key.replace(/\/$/, ''));
  assert.ok(bucket === 'weatherx-data-staging' || bucket === 'weatherx-components-staging', 'staging bucket required');
  assert.ok(bucket === 'weatherx-components-staging' ? key.startsWith('components/') :
    /^(releases|catalogs|staging-candidates)\//.test(key), 'object outside staging publication prefixes');
  return { Bucket: bucket, Key: key };
}
const etag = value => { assert.match(value ?? '', /^"[A-Za-z0-9-]+"$/, 'missing/unsafe object ETag'); return value; };
export function validateObjectMetadata(metadata={}) {
  assert.ok(metadata && typeof metadata==='object' && !Array.isArray(metadata));
  assert.ok(Object.entries(metadata).every(([k,v])=>/^[a-z0-9_-]{1,128}$/.test(k) && typeof v==='string' && /^[\x20-\x7e]*$/.test(v) && v.length<=2048), 'unsupported metadata encoding');
  assert.ok(Buffer.byteLength(JSON.stringify(metadata))<=8192,'metadata exceeds budget');
}

const RETRYABLE_READ_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createStagingS3(env, injectedClient, { pause = delay } = {}) {
  assert.equal(env.STAGING_R2_ACCOUNT_ID, ACCOUNT);
  assert.ok(env.STAGING_R2_WRITE_ACCESS_KEY_ID && env.STAGING_R2_WRITE_SECRET_ACCESS_KEY, 'staging S3 credential required');
  const client = injectedClient ?? new S3Client({ region: 'auto', endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    forcePathStyle: true, maxAttempts: 1,
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.STAGING_R2_WRITE_ACCESS_KEY_ID, secretAccessKey: env.STAGING_R2_WRITE_SECRET_ACCESS_KEY } });
  async function send(command, { allowMissing = false, readOnly = false } = {}) {
    const attempts = readOnly ? 4 : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try { return await client.send(command, { abortSignal: AbortSignal.timeout(45_000) }); }
      catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        if (allowMissing && status === 404) return null;
        const retryable = RETRYABLE_READ_STATUS.has(status) || Boolean(error?.$retryable) ||
          error?.name === 'AbortError' || error?.name === 'TimeoutError';
        if (readOnly && retryable && attempt < attempts) {
          await pause(Math.min(2_000, 200 * 2 ** (attempt - 1)));
          continue;
        }
        const failure = new Error(status === 412 ? 'staging object CAS conflict' : 'staging S3 request failed');
        failure.code = status === 412 ? 'CAS_CONFLICT' : retryable ? 'S3_TRANSIENT' : 'S3_FAILURE';
        throw failure; // Never echo SDK requests/credentials/remote error bodies.
      }
    }
  }
  async function read(bucket, key, maxBytes, collect) {
    assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 40 * 1024 ** 3);
    const object = await send(new GetObjectCommand(stagingKey(bucket, key)), { allowMissing: true, readOnly: true });
    if (!object) return null;
    const chunks = [], digest = createHash('sha256'); let bytes = 0;
    try {
      assert.ok(Number.isSafeInteger(object.ContentLength) && object.ContentLength <= maxBytes, 'object exceeds read budget');
      assert.ok(object.Body && object.Body[Symbol.asyncIterator], 'object body missing');
      for await (const chunk of object.Body) {
        bytes += chunk.length; assert.ok(bytes <= maxBytes, 'object exceeds streamed read budget');
        digest.update(chunk); if (collect) chunks.push(Buffer.from(chunk));
      }
      assert.equal(bytes, object.ContentLength, 'truncated object');
      return { bytes, sha256: digest.digest('hex'), etag: etag(object.ETag),
        ...(collect ? { body: Buffer.concat(chunks) } : {}), customMetadata: object.Metadata ?? {},
        httpMetadata: { contentType: object.ContentType, cacheControl: object.CacheControl,
          contentEncoding: object.ContentEncoding, contentLanguage: object.ContentLanguage,
          contentDisposition: object.ContentDisposition, expires: object.Expires } };
    } finally { object.Body?.destroy?.(); }
  }
  return {
    validateRestore: previous => {
      validateObjectMetadata(previous.customMetadata);
      for(const [key,value] of Object.entries(previous.httpMetadata??{})){
        if(value===undefined)continue;
        assert.ok(['contentType','cacheControl'].includes(key),'HTTP metadata cannot be restored exactly');
        assert.ok(typeof value==='string' && /^[\x20-\x7e]*$/.test(value) && value.length<=2048,'unsupported HTTP metadata');
      }
    },
    get: (bucket, key, { maxBytes = 16 * 1024 ** 2 } = {}) => {
      assert.ok(maxBytes <= 32 * 1024 ** 2, 'buffered object budget exceeded'); return read(bucket, key, maxBytes, true);
    },
    hashObject: (bucket, key, { maxBytes }) => read(bucket, key, Math.max(1, maxBytes), false),
    async list(bucket, prefix, { maxObjects }) {
      stagingKey(bucket, prefix); assert.ok(Number.isSafeInteger(maxObjects) && maxObjects > 0 && maxObjects <= 100_001);
      const objects = [], tokens = new Set(); let token;
      do {
        const page = await send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }), { readOnly: true });
        for (const item of page.Contents ?? []) {
          stagingKey(bucket, item.Key); assert.ok(item.Key.startsWith(prefix));
          assert.ok(Number.isSafeInteger(item.Size) && item.Size >= 0);
          objects.push({ key: item.Key, bytes: item.Size }); assert.ok(objects.length <= maxObjects, 'listing exceeds object budget');
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated) { assert.ok(typeof token === 'string' && token && !tokens.has(token), 'invalid/repeated pagination token'); tokens.add(token); }
      } while (token);
      assert.equal(new Set(objects.map(o => o.key)).size, objects.length, 'duplicate listing key');
      return objects;
    },
    async put(bucket, key, body, options) {
      const target = stagingKey(bucket, key);
      assert.equal(bucket, 'weatherx-data-staging', 'activation cannot modify model components');
      assert.ok(key === 'releases/current.json' || key === 'catalogs/current.json' ||
        /^catalogs\/snapshots\/[A-Za-z0-9._-]+\.json$/.test(key) || /^staging-candidates\/[a-f0-9]{64}\/activations\//.test(key), 'write outside activation allowlist');
      assert.ok(Buffer.isBuffer(body) || typeof body === 'string'); assert.ok(Buffer.byteLength(body) <= 2 * 1024 ** 2);
      assert.ok(Boolean(options?.ifMatch) !== Boolean(options?.ifNoneMatch), 'exactly one CAS precondition required');
      if (options.ifMatch) etag(options.ifMatch); else assert.equal(options.ifNoneMatch, '*');
      const metadata = options.customMetadata ?? {};
      validateObjectMetadata(metadata);
      const result = await send(new PutObjectCommand({ ...target, Body: body, ContentLength: Buffer.byteLength(body),
        IfMatch: options.ifMatch, IfNoneMatch: options.ifNoneMatch, Metadata: metadata,
        ContentType: options.httpMetadata?.contentType, CacheControl: options.httpMetadata?.cacheControl }));
      return { etag: etag(result.ETag) };
    },
    close: () => client.destroy?.(),
  };
}
