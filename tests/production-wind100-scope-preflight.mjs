import assert from 'node:assert/strict';
import test from 'node:test';
import { proveScope } from '../tools/production-wind100-scope-preflight.mjs';

const env = {
  GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_RUN_ID: '35907165187',
  GITHUB_RUN_ATTEMPT: '1', PRODUCTION_WIND100_R2_ACCOUNT_ID: 'a89f9a1af485021fbc60a68b163c7c6e',
  PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID: 'READACCESSKEY123456',
  PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY: 'r'.repeat(40),
  PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID: 'DELETEACCESSKEY123456',
  PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY: 'd'.repeat(40),
};
const forbidden = () => Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } });

function fixture({ adjacentAllowed = false, adjacentDeniedStatus = 403,
  readerDataDenied = false, fullClaimsInvalid = false } = {}) {
  const objects = new Set(), attempts = [];
  class Command { constructor(input) { this.input = input; } }
  class ListObjectsV2Command extends Command {}
  class PutObjectCommand extends Command {}
  class DeleteObjectCommand extends Command {}
  class GetObjectCommand extends Command {}
  class S3Client {
    constructor(config) { this.credentials = config.credentials; }
    async send(command) {
      const role = this.credentials.sessionToken ? 'temporary'
        : this.credentials.accessKeyId === env.PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID ? 'reader' : 'parent';
      const { Bucket, Key } = command.input;
      attempts.push([role, command.constructor.name, Bucket, Key]);
      if (role === 'reader') {
        if (readerDataDenied && Bucket === 'weatherx-data-production') throw forbidden();
        if (command instanceof ListObjectsV2Command) return { Contents: [] };
        throw forbidden();
      }
      if (role === 'parent') {
        if (Bucket !== 'weatherx-components-production') throw forbidden();
        if (command instanceof PutObjectCommand) { objects.add(Key); return {}; }
        if (command instanceof DeleteObjectCommand) { objects.delete(Key); return {}; }
        throw forbidden();
      }
      if (!(command instanceof DeleteObjectCommand)) throw forbidden();
      const jwt = Buffer.from(this.credentials.sessionToken, 'base64').toString().slice(4);
      const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
      if (fullClaimsInvalid && claims.actions && claims.scope)
        throw Object.assign(new Error('invalid argument'), { name: 'InvalidArgument',
          $metadata: { httpStatusCode: 400 } });
      if (claims.paths && !Key.startsWith(claims.paths.prefixPaths[0]) && !adjacentAllowed)
        throw Object.assign(new Error('denied'), { name: 'InvalidRequest',
          $metadata: { httpStatusCode: adjacentDeniedStatus } });
      objects.delete(Key);
      return {};
    }
    destroy() {}
  }
  return { sdk: { S3Client, ListObjectsV2Command, PutObjectCommand,
    DeleteObjectCommand, GetObjectCommand }, objects, attempts };
}

test('protected proof denies adjacent deletion and other actions, then cleans disposable objects', async () => {
  const { sdk, objects, attempts } = fixture();
  assert.deepEqual(await proveScope(env, sdk), {
    ok: true, readBuckets: 2, readerMutationDenied: true, parentDataBucketDenied: true,
    adjacentDeleteDenied: true, otherActionsDenied: true, scopedDeleteSucceeded: true,
  });
  assert.equal(objects.size, 0);
  assert.equal(attempts.filter(([role, command]) => role === 'temporary'
    && command === 'DeleteObjectCommand').length, 3);
});

test('an overbroad temporary credential fails the proof and still removes disposable objects', async () => {
  const { sdk, objects } = fixture({ adjacentAllowed: true });
  await assert.rejects(proveScope(env, sdk), error => {
    assert.match(error.message, /temporary delete outside its prefix was unexpectedly permitted/);
    assert.equal(error.scopeStep, 'temporary-adjacent-delete-denial');
    assert.equal(error.scopeFailure, 'unexpectedly-permitted');
    return true;
  });
  assert.equal(objects.size, 0);
});

test('an unexpected denial status is classified without exposing the SDK response', async () => {
  const { sdk, objects } = fixture({ adjacentDeniedStatus: 401 });
  await assert.rejects(proveScope(env, sdk), error => {
    assert.equal(error.scopeStep, 'temporary-adjacent-delete-denial');
    assert.equal(error.scopeFailure, 'wrong-denial-status');
    assert.equal(error.scopeStatus, 401);
    assert.equal(error.scopeCode, 'InvalidRequest');
    assert.match(error.message, /must return AccessDenied/);
    return true;
  });
  assert.equal(objects.size, 0);
});

test('failed reader boundary reports only the fixed operation label', async () => {
  const { sdk, objects } = fixture({ readerDataDenied: true });
  await assert.rejects(proveScope(env, sdk), error => {
    assert.equal(error.scopeStep, 'reader-data-list');
    return true;
  });
  assert.equal(objects.size, 0);
});

test('claim-shape diagnostics remain fail-closed and report only fixed results', async () => {
  const { sdk, objects } = fixture({ fullClaimsInvalid: true });
  await assert.rejects(proveScope(env, sdk), error => {
    assert.equal(error.scopeStep, 'temporary-own-prefix-probe');
    assert.deepEqual(error.claimProbe, {
      'without-actions': 'accepted',
      'without-paths': { status: 400, code: 'InvalidArgument' },
      'scope-only': 'accepted',
      'actions-only': 'accepted',
      'actions-only-no-paths': 'accepted',
    });
    return true;
  });
  assert.equal(objects.size, 0);
});
