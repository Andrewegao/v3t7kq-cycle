#!/usr/bin/env node
// Manual qualification only. The parent creates random conditional disposable objects; it never
// writes release manifests, component manifests, pointers or catalogs, or enables retention.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as releases from './production-releases-retention.mjs';
import * as components from './production-components-retention.mjs';

const PROFILES = {
  releases: { controller: releases, stem: 'PRODUCTION_RELEASES', environment: 'production-releases-retention' },
  components: { controller: components, stem: 'PRODUCTION_COMPONENTS', environment: 'data-production-components-cleanup' },
};
const send = (client, command) => client.send(command, { abortSignal: AbortSignal.timeout(30_000) });
async function denied(client, command) {
  try { const response = await send(client, command); response?.Body?.destroy?.(); }
  catch (error) {
    if (error?.$metadata?.httpStatusCode === 403) return;
    throw Object.assign(new Error('denial must be HTTP 403'), { scopeFailure: 'wrong-denial-status' });
  }
  throw Object.assign(new Error('operation unexpectedly permitted'), { scopeFailure: 'unexpectedly-permitted' });
}
const digest = body => createHash('sha256').update(body).digest('hex');
async function readDisposable(client, sdk, bucket, key, expected) {
  const got = await send(client, new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await got.Body.transformToByteArray();
  assert.equal(digest(body), digest(expected), 'disposable content changed');
}
async function absent(client, sdk, bucket, key) {
  try { await send(client, new sdk.HeadObjectCommand({ Bucket: bucket, Key: key })); }
  catch (error) { if (error?.$metadata?.httpStatusCode === 404) return; throw error; }
  throw new Error('disposable object still exists');
}

export async function proveScope(profile, env, sdk) {
  const startedAt = new Date().toISOString();
  assert.ok(Object.hasOwn(PROFILES, profile));
  const { controller, stem, environment } = PROFILES[profile];
  const policy = controller.readPolicy();
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_WORKFLOW_REF,
    `Andrewegao/v3t7kq-cycle/.github/workflows/production-${profile}-scope-preflight.yml@refs/heads/main`);
  assert.equal(env.GITHUB_JOB, 'scope');
  assert.equal(env.RETENTION_SCOPE_ENVIRONMENT, environment);
  assert.equal(env[`${stem}_R2_ACCOUNT_ID`], policy.accountId);
  assert.equal(env[`${stem}_GC_CONTROLLER_SHA256`], controller.controllerDigest());
  assert.notEqual(env[`${stem}_GC_EXECUTE_ENABLED`], 'true', 'disable retention execution before qualification');
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9]\d{0,19}$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9]\d{0,5}$/);
  const allowed = new Set(['READ_ACCESS_KEY_ID', 'READ_SECRET_ACCESS_KEY', 'DELETE_ACCESS_KEY_ID', 'DELETE_SECRET_ACCESS_KEY']
    .map(suffix => `${stem}_GC_${suffix}`));
  for (const [key, value] of Object.entries(env)) {
    if (value && !allowed.has(key) && (/^(?:AWS_|RCLONE_CONFIG_|CLOUDFLARE_)/.test(key) ||
        /(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY|API_TOKEN|PROMOTION_KEY|CATALOG_ENDPOINT)/.test(key)))
      throw new Error('scope preflight refuses unrelated credentials');
  }
  const credentials = role => ({ accessKeyId: env[`${stem}_GC_${role}_ACCESS_KEY_ID`],
    secretAccessKey: env[`${stem}_GC_${role}_SECRET_ACCESS_KEY`] });
  const read = credentials('READ'), parent = credentials('DELETE');
  for (const value of [read, parent]) {
    assert.match(value.accessKeyId ?? '', /^[A-Za-z0-9]{10,128}$/);
    assert.ok(typeof value.secretAccessKey === 'string' && value.secretAccessKey.length >= 32);
  }
  assert.notEqual(read.accessKeyId, parent.accessKeyId, 'reader and delete parent must differ');
  const bucket = profile === 'releases' ? policy.dataBucket : policy.componentBucket;
  const readBuckets = [...new Set([policy.dataBucket, policy.componentBucket, policy.stagingControlBucket].filter(Boolean))];
  const otherBuckets = ['weatherx-data-production', 'weatherx-components-production', 'weatherx-data-staging'].filter(b => b !== bucket);
  // Random canonical roots and random disposable keys, never a real manifest name. The decimal
  // release id stays within the controller's 20-digit bound; each component id has 128 random bits.
  const uniquePrefix = () => profile === 'releases'
    ? `releases/cycle-9${(BigInt(`0x${randomBytes(16).toString('hex')}`) % 10n ** 19n).toString().padStart(19, '0')}/`
    : `components/ecmwf/ecmwf-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${randomBytes(16).toString('hex')}/`;
  const prefix = uniquePrefix(), adjacent = uniquePrefix();
  assert.notEqual(prefix, adjacent);
  const suffix = `scope-preflight-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${randomBytes(16).toString('hex')}`;
  const ownKey = `${prefix}${suffix}`, adjacentKey = `${adjacent}${suffix}`, ownReadKey = `${prefix}${suffix}-read`;
  const audit = new Map([ownKey, adjacentKey, ownReadKey].map(key => [key, { key, creation: 'not-attempted', cleanup: 'not-needed' }]));
  const body = Buffer.from(`WeatherX disposable retention scope proof ${randomBytes(16).toString('hex')}\n`);
  const config = { region: 'auto', endpoint: `https://${policy.accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true, maxAttempts: 1 };
  const clients = [], created = new Set(), uncertain = new Set();
  const client = credentials => { const c = new sdk.S3Client({ ...config, credentials }); clients.push(c); return c; };
  const step = async (label, operation) => {
    try { return await operation(); } catch (error) { error.scopeStep = label; throw error; }
  };
  let result, failure;
  const createDisposable = async key => {
    uncertain.add(key); audit.get(key).creation = 'uncertain';
    try {
      await send(writer, new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, IfNoneMatch: '*' }));
      created.add(key); uncertain.delete(key); audit.get(key).creation = 'confirmed';
    } catch (error) {
      // Conditional conflict proves no creation; uncertain transport outcomes are checked against
      // the exact random body before cleanup can touch this key.
      if ([409, 412].includes(error?.$metadata?.httpStatusCode)) {
        uncertain.delete(key); audit.get(key).creation = 'conditional-conflict';
      }
      throw error;
    }
  };
  let reader, writer;
  try {
    reader = client(read); writer = client(parent);
    const temporary = client(controller.scopedDeleteCredentials(parent, prefix, policy));
    for (const readBucket of readBuckets)
      await step(`reader-list-${readBucket}`, () => send(reader,
        new sdk.ListObjectsV2Command({ Bucket: readBucket, MaxKeys: 1 })));
    for (const other of otherBuckets)
      await step(`parent-other-bucket-${other}`, () => denied(writer,
        new sdk.ListObjectsV2Command({ Bucket: other, MaxKeys: 1 })));
    for (const key of [ownKey, adjacentKey]) {
      await step('create-disposable', () => createDisposable(key));
      await step('reader-read-disposable', () => readDisposable(reader, sdk, bucket, key, body));
    }
    await step('reader-write-denial', () => denied(reader,
      new sdk.PutObjectCommand({ Bucket: bucket, Key: ownKey, Body: body })));
    await step('reader-delete-denial', () => denied(reader,
      new sdk.DeleteObjectCommand({ Bucket: bucket, Key: adjacentKey })));
    // Positive delete first distinguishes a malformed/expired session from a scoped denial.
    await step('temporary-own-delete', () => send(temporary,
      new sdk.DeleteObjectCommand({ Bucket: bucket, Key: ownKey })));
    await step('verify-own-deleted', () => absent(reader, sdk, bucket, ownKey));
    await step('temporary-adjacent-delete-denial', () => denied(temporary,
      new sdk.DeleteObjectCommand({ Bucket: bucket, Key: adjacentKey })));
    await step('verify-adjacent-preserved', () => readDisposable(reader, sdk, bucket, adjacentKey, body));
    // Use a second exact in-prefix disposable key so GET/HEAD denial cannot be mistaken for 404.
    await step('create-read-disposable', () => createDisposable(ownReadKey));
    for (const [label, Command, input] of [
      ['read', sdk.GetObjectCommand, { Key: ownReadKey }],
      ['head', sdk.HeadObjectCommand, { Key: ownReadKey }],
      ['write', sdk.PutObjectCommand, { Key: ownReadKey, Body: body }],
      ['list', sdk.ListObjectsV2Command, { Prefix: prefix, MaxKeys: 1 }],
    ]) await step(`temporary-${label}-denial`, () => denied(temporary, new Command({ Bucket: bucket, ...input })));
    for (const other of otherBuckets) {
      await step(`temporary-cross-bucket-list-${other}`, () => denied(temporary,
        new sdk.ListObjectsV2Command({ Bucket: other, Prefix: prefix, MaxKeys: 1 })));
      await step(`temporary-cross-bucket-read-${other}`, () => denied(temporary,
        new sdk.GetObjectCommand({ Bucket: other, Key: ownKey })));
    }
    result = { ok: true, profile, readBuckets: readBuckets.length, readerMutationsDenied: true,
      parentOtherBucketsDenied: true, scopedDeleteSucceeded: true, adjacentDeleteDenied: true,
      readHeadWriteListDenied: true, crossBucketAccessDenied: true };
  } catch (error) { failure = error; }
  finally {
    const cleanupFailures = [];
    // Only our confirmed creations, or an ambiguous creation with the exact random body, qualify.
    // Try every cleanup and always close every client, including when another cleanup fails.
    for (const key of uncertain) {
      try {
        await readDisposable(writer, sdk, bucket, key, body); created.add(key); audit.get(key).creation = 'confirmed-after-uncertain-response';
      } catch (error) {
        if (error?.$metadata?.httpStatusCode === 404) audit.get(key).cleanup = 'absent-verified';
        else { audit.get(key).cleanup = 'ownership-unconfirmed'; cleanupFailures.push('unconfirmed-create'); }
      }
    }
    for (const key of created) {
      try {
        await send(writer, new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key }));
        await absent(writer, sdk, bucket, key);
        audit.get(key).cleanup = 'absent-verified';
      } catch { audit.get(key).cleanup = 'failed'; cleanupFailures.push('disposable-cleanup'); }
    }
    for (const c of clients) { try { c.destroy?.(); } catch { cleanupFailures.push('client-close'); } }
    if (cleanupFailures.length) {
      failure ??= Object.assign(new Error('disposable cleanup failed'), { scopeStep: 'cleanup' });
      failure.cleanupFailed = true;
    }
    const receipt = { schemaVersion: 1, kind: 'weatherx-retention-scope-preflight', profile,
      startedAt, finishedAt: new Date().toISOString(), bucket, prefixes: [prefix, adjacent],
      createdObjects: created.size, createdBytes: created.size * body.length, cleanupVerified: cleanupFailures.length === 0,
      disposables: [...audit.values()] };
    if (failure) failure.scopeReceipt = receipt;
    else result.receipt = receipt;
  }
  if (failure) throw failure;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const sdk = await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
    console.log(JSON.stringify(await proveScope(process.argv[2], process.env, sdk)));
  } catch (error) {
    // Fixed labels only: SDK bodies, assertion values and credentials never reach logs.
    if (error?.scopeReceipt) console.log(JSON.stringify({ ok: false, receipt: error.scopeReceipt }));
    const reason = ['wrong-denial-status', 'unexpectedly-permitted'].includes(error?.scopeFailure) ? ` (${error.scopeFailure})` : '';
    console.error(`production retention scope preflight failed at ${error?.scopeStep ?? 'setup'}${reason}${error?.cleanupFailed ? ' (cleanup incomplete)' : ''}`);
    process.exitCode = 1;
  }
}
