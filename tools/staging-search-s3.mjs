import assert from 'node:assert/strict';
import { S3Client, PutObjectCommand } from '../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js';
import { createStagingS3 } from './staging-s3.mjs';
import { ACCOUNT, BUCKET, POINTER_KEY, allowedSearchKey, hash } from './staging-search.mjs';

export function createSearchS3(env, injectedClient) {
  assert.equal(env.STAGING_R2_ACCOUNT_ID, ACCOUNT);
  assert.ok(env.STAGING_R2_WRITE_ACCESS_KEY_ID && env.STAGING_R2_WRITE_SECRET_ACCESS_KEY, 'staging-only S3 credential required');
  const client = injectedClient ?? new S3Client({ region: 'auto', endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED',
    credentials: { accessKeyId: env.STAGING_R2_WRITE_ACCESS_KEY_ID, secretAccessKey: env.STAGING_R2_WRITE_SECRET_ACCESS_KEY } });
  const reader = createStagingS3(env, client);
  return {
    get(key, maxBytes) {
      allowedSearchKey(key);
      assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 1024 * 1024);
      return reader.get(BUCKET, key, { maxBytes });
    },
    async put(key, body, condition) {
      allowedSearchKey(key);
      assert.ok(Buffer.isBuffer(body) && body.length > 0 && body.length <= (key.endsWith('core.json') || key.endsWith('more.json') ? 1024 * 1024 : 8192));
      assert.equal(hash(body), condition.sha256);
      assert.ok(Boolean(condition.ifMatch) !== Boolean(condition.ifNoneMatch), 'exactly one CAS condition required');
      if (condition.ifMatch) {
        assert.equal(key, POINTER_KEY, 'immutable candidates cannot be overwritten');
        assert.match(condition.ifMatch, /^"[A-Za-z0-9-]+"$/);
      } else assert.equal(condition.ifNoneMatch, '*');
      try {
        const result = await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentLength: body.length,
          IfMatch: condition.ifMatch, IfNoneMatch: condition.ifNoneMatch, Metadata: { sha256: condition.sha256 },
          ContentType: 'application/json', CacheControl: key === POINTER_KEY ? 'no-store' : 'public, max-age=31536000, immutable' }),
        { abortSignal: AbortSignal.timeout(45_000) });
        assert.match(result.ETag ?? '', /^"[A-Za-z0-9-]+"$/);
      } catch {
        throw new Error('staging search write failed or uncertain; inspect before retrying');
      }
    },
    close: () => client.destroy?.(),
  };
}
