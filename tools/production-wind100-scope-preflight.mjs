#!/usr/bin/env node
// Manual, disposable-object proof of the dedicated production Wind100 cleanup boundary.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPONENTS, DATA } from './production-wind100.mjs';
import { scopedDeleteCredentials } from './production-wind100-retention.mjs';

const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;
const PREFIX = 'components/point-ecmwf/prod-wind100-recurring-point-ecmwf-';

async function denied(client, command, label) {
  try {
    await client.send(command, { abortSignal: AbortSignal.timeout(30_000) });
  } catch (error) {
    assert.equal(error?.$metadata?.httpStatusCode, 403,
      `${label} must return AccessDenied, not another error`);
    return;
  }
  assert.fail(`${label} was unexpectedly permitted`);
}

export async function proveScope(env, sdk) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle');
  assert.equal(env.PRODUCTION_WIND100_R2_ACCOUNT_ID, ACCOUNT);
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9]\d{0,19}$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9]\d{0,5}$/);
  const read = { accessKeyId: env.PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID,
    secretAccessKey: env.PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY };
  const parent = { accessKeyId: env.PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID,
    secretAccessKey: env.PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY };
  assert.ok(read.accessKeyId && read.secretAccessKey && parent.accessKeyId && parent.secretAccessKey);
  assert.notEqual(read.accessKeyId, parent.accessKeyId,
    'planning and deletion must use different parent tokens');
  for (const key of ['PRODUCTION_WIND100_R2_ACCESS_KEY_ID',
    'PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY', 'R2_PRODUCTION_ACCESS_KEY_ID',
    'R2_PRODUCTION_SECRET_ACCESS_KEY', 'STAGING_R2_WRITE_ACCESS_KEY_ID',
    'STAGING_R2_WRITE_SECRET_ACCESS_KEY']) assert.ok(!env[key], `scope preflight refuses ${key}`);

  const config = { region: 'auto', endpoint: ENDPOINT, forcePathStyle: true, maxAttempts: 1 };
  const reader = new sdk.S3Client({ ...config, credentials: read });
  const writer = new sdk.S3Client({ ...config, credentials: parent });
  const invocation = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`;
  const first = `${PREFIX}${invocation}/`;
  const adjacent = `${PREFIX}${env.GITHUB_RUN_ID}-${Number(env.GITHUB_RUN_ATTEMPT) + 1}/`;
  const suffix = `scope-preflight-${randomBytes(12).toString('hex')}`;
  const ownKey = `${first}${suffix}`;
  const adjacentKey = `${adjacent}${suffix}`;
  const temporary = new sdk.S3Client({ ...config,
    credentials: scopedDeleteCredentials(parent, first) });
  const send = (client, command) => client.send(command,
    { abortSignal: AbortSignal.timeout(30_000) });
  let created = false;
  try {
    // Planning must read both buckets; deletion must be unable to read the data bucket.
    for (const bucket of [DATA, COMPONENTS])
      await send(reader, new sdk.ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    await denied(writer, new sdk.ListObjectsV2Command({ Bucket: DATA, MaxKeys: 1 }),
      'cleanup delete parent on production data bucket');

    const body = Buffer.from('WeatherX disposable credential-scope proof\n');
    await send(writer, new sdk.PutObjectCommand({ Bucket: COMPONENTS, Key: ownKey, Body: body }));
    created = true;
    await send(writer, new sdk.PutObjectCommand({ Bucket: COMPONENTS, Key: adjacentKey, Body: body }));
    await denied(temporary, new sdk.DeleteObjectCommand({ Bucket: COMPONENTS, Key: adjacentKey }),
      'temporary delete outside its prefix');
    await denied(temporary, new sdk.GetObjectCommand({ Bucket: COMPONENTS, Key: ownKey }),
      'temporary read inside its prefix');
    await denied(temporary, new sdk.PutObjectCommand({ Bucket: COMPONENTS, Key: ownKey, Body: body }),
      'temporary write inside its prefix');
    await denied(temporary, new sdk.ListObjectsV2Command({ Bucket: COMPONENTS, Prefix: first }),
      'temporary list inside its prefix');
    await send(temporary, new sdk.DeleteObjectCommand({ Bucket: COMPONENTS, Key: ownKey }));
    return { ok: true, readBuckets: 2, parentDataBucketDenied: true,
      adjacentDeleteDenied: true, otherActionsDenied: true, scopedDeleteSucceeded: true };
  } finally {
    // Only uniquely named disposable objects can be touched by this workflow.
    if (created) {
      await send(writer, new sdk.DeleteObjectCommand({ Bucket: COMPONENTS, Key: ownKey }));
      await send(writer, new sdk.DeleteObjectCommand({ Bucket: COMPONENTS, Key: adjacentKey }));
    }
    reader.destroy?.(); writer.destroy?.(); temporary.destroy?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const sdk = await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
    console.log(JSON.stringify(await proveScope(process.env, sdk)));
  } catch {
    // No SDK error body, headers, assertion values, or credential material goes to the log.
    console.error('production Wind100 credential scope preflight failed');
    process.exitCode = 1;
  }
}
