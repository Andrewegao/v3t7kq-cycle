import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { proveScope } from '../tools/production-retention-scope-preflight.mjs';
import * as releases from '../tools/production-releases-retention.mjs';
import * as components from '../tools/production-components-retention.mjs';

const deny = (status = 403) => Object.assign(new Error('SDK response must never be logged'), { $metadata: { httpStatusCode: status } });
function fixture(profile, { permit = '', denialStatus = 403, failPut = 0, ambiguousPut = false, failCleanup = false, denyOwnDelete = false } = {}) {
  const controller = profile === 'releases' ? releases : components;
  const policy = controller.readPolicy(), stem = `PRODUCTION_${profile.toUpperCase()}`;
  const bucket = profile === 'releases' ? policy.dataBucket : policy.componentBucket;
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'scope', GITHUB_RUN_ID: '35907165187', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: `Andrewegao/v3t7kq-cycle/.github/workflows/production-${profile}-scope-preflight.yml@refs/heads/main`,
    RETENTION_SCOPE_ENVIRONMENT: profile === 'releases' ? 'production-releases-retention' : 'data-production-components-cleanup',
    [`${stem}_R2_ACCOUNT_ID`]: policy.accountId, [`${stem}_GC_CONTROLLER_SHA256`]: controller.controllerDigest(),
    [`${stem}_GC_EXECUTE_ENABLED`]: 'false', [`${stem}_GC_READ_ACCESS_KEY_ID`]: 'READACCESSKEY123456',
    [`${stem}_GC_READ_SECRET_ACCESS_KEY`]: 'r'.repeat(40), [`${stem}_GC_DELETE_ACCESS_KEY_ID`]: 'DELETEACCESSKEY123456',
    [`${stem}_GC_DELETE_SECRET_ACCESS_KEY`]: 'd'.repeat(40) };
  const objects = new Map(), attempts = [], clients = [], puts = [];
  let putCount = 0;
  class Command { constructor(input) { this.input = input; } }
  class ListObjectsV2Command extends Command {}
  class PutObjectCommand extends Command {}
  class DeleteObjectCommand extends Command {}
  class GetObjectCommand extends Command {}
  class HeadObjectCommand extends Command {}
  class S3Client {
    constructor(config) {
      assert.equal(config.maxAttempts, 1);
      this.role = config.credentials.sessionToken ? 'temporary' : config.credentials.accessKeyId === env[`${stem}_GC_READ_ACCESS_KEY_ID`] ? 'reader' : 'parent';
      if (this.role === 'temporary') {
        const jwt = Buffer.from(config.credentials.sessionToken, 'base64').toString().slice(4);
        this.claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url'));
        assert.deepEqual(this.claims.actions, ['DeleteObject']);
        assert.equal(this.claims.bucket, bucket);
        assert.equal(this.claims.exp - this.claims.iat, 900);
        assert.equal(this.claims.paths.prefixPaths.length, 1);
        assert.equal(profile === 'releases' ? controller.scopedRelease(this.claims.paths.prefixPaths[0]) : controller.scopedRoot(policy, this.claims.paths.prefixPaths[0]), true);
      }
      clients.push(this);
    }
    async send(command) {
      const { Bucket, Key } = command.input, type = command.constructor.name;
      const scope = Bucket !== bucket ? 'cross-bucket' : this.role === 'temporary' && Key && !Key.startsWith(this.claims.paths.prefixPaths[0]) ? 'adjacent' : 'own';
      const label = `${this.role}:${type}:${scope}`;
      attempts.push({ role: this.role, type, ...command.input });
      const denied = () => { if (permit !== label) throw deny(denialStatus); };
      if (this.role === 'reader' && [PutObjectCommand, DeleteObjectCommand].includes(command.constructor)) denied();
      if (this.role === 'parent' && Bucket !== bucket) denied();
      if (this.role === 'temporary' && (!(command instanceof DeleteObjectCommand) || scope !== 'own')) denied();
      if (this.role === 'temporary' && command instanceof DeleteObjectCommand && scope === 'own' && denyOwnDelete) throw deny(403);
      const id = `${Bucket}/${Key}`;
      if (command instanceof ListObjectsV2Command) return { Contents: [] };
      if (command instanceof PutObjectCommand) {
        if (this.role === 'parent') {
          putCount++;
          assert.equal(command.input.IfNoneMatch, '*');
          assert.match(Key, /\/scope-preflight-35907165187-1-[a-f0-9]{32}(?:-read)?$/);
          assert.doesNotMatch(Key, /(?:manifest\.json|component\.json|current\.json|catalogs\/)/);
          puts.push(id);
          if (putCount === failPut && !ambiguousPut) throw deny(412);
        }
        objects.set(id, Buffer.from(command.input.Body));
        if (putCount === failPut && ambiguousPut) throw new Error('transport failed after server accepted object');
        return {};
      }
      if (command instanceof DeleteObjectCommand) {
        if (this.role === 'parent') {
          assert.ok(puts.includes(id), 'cleanup can only target a disposable creation');
          if (failCleanup && id === puts[1]) throw new Error('cleanup failed');
        }
        objects.delete(id); return {};
      }
      if (!objects.has(id)) throw deny(404);
      return { Body: { transformToByteArray: async () => objects.get(id) } };
    }
    destroy() { this.closed = true; }
  }
  return { env, stem, sdk: { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand },
    objects, attempts, clients, puts };
}

for (const profile of ['releases', 'components']) {
  test(`${profile}: exact controller session proves all boundaries and removes all disposable objects`, async () => {
    const f = fixture(profile);
    const { receipt, ...result } = await proveScope(profile, f.env, f.sdk);
    assert.equal(receipt.createdObjects, 3);
    assert.ok(receipt.createdBytes > 0);
    assert.equal(receipt.cleanupVerified, true);
    assert.equal(receipt.disposables.length, 3);
    assert.ok(receipt.disposables.every(row => row.creation === 'confirmed' && row.cleanup === 'absent-verified'));
    assert.ok(Date.parse(receipt.finishedAt) >= Date.parse(receipt.startedAt));
    assert.ok(receipt.prefixes.every(prefix => receipt.disposables.some(row => row.key.startsWith(prefix))));
    assert.deepEqual(result, { ok: true, profile, readBuckets: profile === 'releases' ? 2 : 3, readerMutationsDenied: true,
      parentOtherBucketsDenied: true, scopedDeleteSucceeded: true, adjacentDeleteDenied: true,
      readHeadWriteListDenied: true, crossBucketAccessDenied: true });
    assert.equal(f.objects.size, 0);
    assert.equal(f.puts.length, 3);
    assert.ok(f.clients.every(c => c.closed));
  });
  for (const permit of ['temporary:DeleteObjectCommand:adjacent', 'temporary:GetObjectCommand:own',
    'temporary:HeadObjectCommand:own', 'temporary:PutObjectCommand:own', 'temporary:ListObjectsV2Command:own',
    'temporary:ListObjectsV2Command:cross-bucket', 'reader:PutObjectCommand:own', 'reader:DeleteObjectCommand:own',
    'parent:ListObjectsV2Command:cross-bucket']) {
    test(`${profile}: fails closed on overbroad ${permit} and cleans every creation`, async () => {
      const f = fixture(profile, { permit });
      await assert.rejects(proveScope(profile, f.env, f.sdk), e => e.scopeFailure === 'unexpectedly-permitted');
      assert.equal(f.objects.size, 0);
      assert.ok(f.clients.every(c => c.closed));
    });
  }
  test(`${profile}: an unusable temporary token fails its positive delete and cleans creations`, async () => {
    const f = fixture(profile, { denyOwnDelete: true });
    await assert.rejects(proveScope(profile, f.env, f.sdk), e => e.scopeStep === 'temporary-own-delete');
    assert.equal(f.objects.size, 0);
    assert.ok(f.clients.every(c => c.closed));
  });
  test(`${profile}: wrong HTTP denial status fails, even for an unusable credential`, async () => {
    const f = fixture(profile, { denialStatus: 401 });
    await assert.rejects(proveScope(profile, f.env, f.sdk), e => e.scopeFailure === 'wrong-denial-status');
    assert.equal(f.objects.size, 0);
  });
  test(`${profile}: rejected second create cleans first key only; uncertain creation is verified and cleaned`, async () => {
    for (const ambiguousPut of [false, true]) {
      const f = fixture(profile, { failPut: 2, ambiguousPut });
      await assert.rejects(proveScope(profile, f.env, f.sdk));
      assert.equal(f.objects.size, 0);
      const cleanup = f.attempts.filter(a => a.role === 'parent' && a.type === 'DeleteObjectCommand');
      assert.equal(cleanup.length, ambiguousPut ? 2 : 1);
      assert.ok(f.clients.every(c => c.closed));
    }
  });
  test(`${profile}: cleanup failure still tries the remaining keys and closes every client`, async () => {
    const f = fixture(profile, { failCleanup: true });
    await assert.rejects(proveScope(profile, f.env, f.sdk), e => {
      assert.equal(e.cleanupFailed, true);
      assert.equal(e.scopeReceipt.cleanupVerified, false);
      assert.equal(e.scopeReceipt.disposables.filter(row => row.cleanup === 'failed').length, 1);
      assert.equal(e.scopeReceipt.disposables.filter(row => row.cleanup === 'absent-verified').length, 2);
      assert.doesNotMatch(JSON.stringify(e.scopeReceipt), /ACCESSKEY|SECRET|SDK response/);
      return true;
    });
    assert.equal(f.objects.size, 1, 'the failed cleanup is reported and the other key is still cleaned');
    assert.equal(f.attempts.filter(a => a.role === 'parent' && a.type === 'DeleteObjectCommand').length, 3);
    assert.ok(f.clients.every(c => c.closed));
  });
  test(`${profile}: admission rejects execution enabled, wrong context and unrelated credentials before any request`, async () => {
    const original = fixture(profile);
    for (const changes of [{ [`${original.stem}_GC_EXECUTE_ENABLED`]: 'true' }, { GITHUB_REF: 'refs/heads/feature' },
      { GITHUB_EVENT_NAME: 'push' }, { GITHUB_JOB: 'retention' }, { RETENTION_SCOPE_ENVIRONMENT: 'production' },
      { [`${original.stem}_GC_CONTROLLER_SHA256`]: '0'.repeat(64) },
      { [`${original.stem}_GC_DELETE_ACCESS_KEY_ID`]: original.env[`${original.stem}_GC_READ_ACCESS_KEY_ID`] },
      { R2_PRODUCTION_ACCESS_KEY_ID: 'publisher' }, { RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID: 'publisher' },
      { CATALOG_PROMOTION_KEY: 'publisher' }, { AWS_SESSION_TOKEN: 'publisher' }, { CLOUDFLARE_API_TOKEN: 'publisher' }]) {
      const f = fixture(profile);
      await assert.rejects(proveScope(profile, { ...f.env, ...changes }, f.sdk));
      assert.equal(f.attempts.length, 0);
    }
  });
  test(`${profile}: workflow is protected manual main-only, locked install, no concurrency or publisher secrets`, () => {
    const workflow = readFileSync(new URL(`../.github/workflows/production-${profile}-scope-preflight.yml`, import.meta.url), 'utf8');
    assert.match(workflow, /^on: workflow_dispatch$/m);
    assert.match(workflow, /if: \$\{\{ github.ref == 'refs\/heads\/main' \}\}/);
    assert.match(workflow, new RegExp(`name: ${profile === 'releases' ? 'production-releases-retention' : 'data-production-components-cleanup'}`));
    assert.doesNotMatch(workflow, /^\s*(?:concurrency|schedule|push|pull_request|workflow_call|workflow_run):/m);
    assert.doesNotMatch(workflow, /: write|retention\.mjs execute|EXECUTE_ENABLED: true/);
    assert.match(workflow, /npm ci --ignore-scripts --prefix staging-controller/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /shell: bash/);
    assert.ok(workflow.includes('if: ${{ always() }}'));
    assert.match(workflow, /retention-days: 7/);
    assert.ok(workflow.includes('tee "$RUNNER_TEMP/'));
    assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(m => m[1]).sort(),
      ['READ_ACCESS_KEY_ID', 'READ_SECRET_ACCESS_KEY', 'DELETE_ACCESS_KEY_ID', 'DELETE_SECRET_ACCESS_KEY'].map(s => `PRODUCTION_${profile.toUpperCase()}_GC_${s}`).sort());
  });
}
