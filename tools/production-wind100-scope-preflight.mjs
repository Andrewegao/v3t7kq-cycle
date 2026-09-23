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
    if (error?.$metadata?.httpStatusCode === 403) return;
    const failure = new Error(`${label} must return AccessDenied, not another error`);
    failure.scopeFailure = 'wrong-denial-status';
    const status = error?.$metadata?.httpStatusCode;
    failure.scopeStatus = Number.isInteger(status) && status >= 400 && status <= 599
      ? status : 'unavailable';
    const safeCodes = new Set(['InvalidArgument', 'InvalidRequest', 'InvalidToken',
      'ExpiredToken', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'Unauthorized',
      'BadRequest', 'NotImplemented', 'AccessDenied']);
    failure.scopeCode = safeCodes.has(error?.name) ? error.name : 'other';
    throw failure;
  }
  const failure = new Error(`${label} was unexpectedly permitted`);
  failure.scopeFailure = 'unexpectedly-permitted';
  throw failure;
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
  const check = async (step, operation) => {
    try { return await operation(); }
    catch (error) { error.scopeStep = step; throw error; }
  };
  let created = false;
  try {
    // Planning must read both buckets; deletion must be unable to read the data bucket.
    for (const bucket of [DATA, COMPONENTS])
      await check(bucket === DATA ? 'reader-data-list' : 'reader-components-list',
        () => send(reader, new sdk.ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 })));
    await check('delete-parent-data-denial', () => denied(writer,
      new sdk.ListObjectsV2Command({ Bucket: DATA, MaxKeys: 1 }),
      'cleanup delete parent on production data bucket'));

    const body = Buffer.from('WeatherX disposable credential-scope proof\n');
    await check('put-own-disposable', () => send(writer,
      new sdk.PutObjectCommand({ Bucket: COMPONENTS, Key: ownKey, Body: body })));
    created = true;
    await check('put-adjacent-disposable', () => send(writer,
      new sdk.PutObjectCommand({ Bucket: COMPONENTS, Key: adjacentKey, Body: body })));
    await check('reader-write-denial', () => denied(reader,
      new sdk.PutObjectCommand({ Bucket: COMPONENTS, Key: ownKey, Body: body }),
      'cleanup reader write'));
    await check('reader-delete-denial', () => denied(reader,
      new sdk.DeleteObjectCommand({ Bucket: COMPONENTS, Key: adjacentKey }),
      'cleanup reader delete'));
    await check('temporary-adjacent-delete-denial', () => denied(temporary,
      new sdk.DeleteObjectCommand({ Bucket: COMPONENTS, Key: adjacentKey }),
      'temporary delete outside its prefix'));
    await check('temporary-read-denial', () => denied(temporary,
      new sdk.GetObjectCommand({ Bucket: COMPONENTS, Key: ownKey }),
      'temporary read inside its prefix'));
    await check('temporary-write-denial', () => denied(temporary,
      new sdk.PutObjectCommand({ Bucket: COMPONENTS, Key: ownKey, Body: body }),
      'temporary write inside its prefix'));
    await check('temporary-list-denial', () => denied(temporary,
      new sdk.ListObjectsV2Command({ Bucket: COMPONENTS, Prefix: first }),
      'temporary list inside its prefix'));
    await check('temporary-own-delete', () => send(temporary,
      new sdk.DeleteObjectCommand({ Bucket: COMPONENTS, Key: ownKey })));
    return { ok: true, readBuckets: 2, readerMutationDenied: true, parentDataBucketDenied: true,
      adjacentDeleteDenied: true, otherActionsDenied: true, scopedDeleteSucceeded: true };
  } finally {
    // Only uniquely named disposable objects can be touched by this workflow.
    if (created) {
      await check('cleanup-own-disposable', () => send(writer,
        new sdk.DeleteObjectCommand({ Bucket: COMPONENTS, Key: ownKey })));
      await check('cleanup-adjacent-disposable', () => send(writer,
        new sdk.DeleteObjectCommand({ Bucket: COMPONENTS, Key: adjacentKey })));
    }
    reader.destroy?.(); writer.destroy?.(); temporary.destroy?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const sdk = await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
    console.log(JSON.stringify(await proveScope(process.env, sdk)));
  } catch (error) {
    // No SDK error body, headers, assertion values, or credential material goes to the log.
    const reason = ['wrong-denial-status', 'unexpectedly-permitted']
      .includes(error?.scopeFailure) ? ` (${error.scopeFailure})` : '';
    const status = error?.scopeFailure === 'wrong-denial-status'
      ? ` [http-${error.scopeStatus}, ${error.scopeCode}]` : '';
    console.error(`production Wind100 credential scope preflight failed at ${error?.scopeStep ?? 'setup'}${reason}${status}`);
    process.exitCode = 1;
  }
}
