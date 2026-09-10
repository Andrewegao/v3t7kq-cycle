import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, realpath, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCOUNT, hash, qualifyPlaces, prefix, pointerKey, allowedKey } from '../tools/staging-places.mjs';
import { placesGate, runRuntimeProof, proofScopeArguments, publishQualifiedPlaces } from '../tools/staging-places-workflow.mjs';
function environment() {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'places',
    GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-places.yml@refs/heads/main',
    STAGING_PLACES_ENABLED: 'true', STAGING_DATA_ISOLATION_APPROVED: 'true', STAGING_R2_ACCOUNT_ID: ACCOUNT,
    GITHUB_SHA: 'a'.repeat(40), STAGING_PLACES_APPROVED_WORKFLOW_SHA: 'a'.repeat(40), ATMOS_SHA: 'b'.repeat(40), STAGING_PLACES_APPROVED_ATMOS_SHA: 'b'.repeat(40),
    PLACES_ACTION: 'prepare', PLACES_KIND: 'tides', STAGING_PLACES_APPROVED_FAMILY: 'tides', SEED_TAG: 'staging-seed',
    SEED_SHA256: 'c'.repeat(64), STAGING_PLACES_APPROVED_SEED_SHA256: 'c'.repeat(64), MANIFEST_SHA256: 'd'.repeat(64), STAGING_PLACES_APPROVED_MANIFEST_SHA256: 'd'.repeat(64),
    PLAINTEXT_SHA256: 'e'.repeat(64), STAGING_PLACES_APPROVED_PLAINTEXT_SHA256: 'e'.repeat(64), STAGING_PLACES_APPROVED_QUALIFIER_SHA256: 'f'.repeat(64),
    RUNNER_TEMP: '/tmp', GITHUB_WORKSPACE: '/work' };
}
test('manual hosted gate binds environment, family, source, workflow and every seed approval', () => {
  const env = environment(); assert.equal(placesGate(env).kind, 'tides');
  for (const [name, value] of Object.entries({ GITHUB_EVENT_NAME: 'schedule', GITHUB_REF: 'refs/heads/dev', RUNNER_ENVIRONMENT: 'self-hosted',
    STAGING_PLACES_ENABLED: 'false', STAGING_DATA_ISOLATION_APPROVED: 'false', ATMOS_SHA: '0'.repeat(40), GITHUB_SHA: '0'.repeat(40),
    SEED_SHA256: '0'.repeat(64), PLAINTEXT_SHA256: '0'.repeat(64), MANIFEST_SHA256: '0'.repeat(64), PLACES_KIND: 'surf',
    STAGING_R2_ACCOUNT_ID: 'foreign', UI_BUILD_PRIVATE_KEY: 'unrelated' })) assert.throws(() => placesGate({ ...env, [name]: value }));
});
test('activation needs exact reviewed completion plus pointer precondition', () => {
  const env = { ...environment(), PLACES_ACTION: 'activate' }; assert.throws(() => placesGate(env));
  Object.assign(env, { COMPLETION_SHA256: '9'.repeat(64), STAGING_PLACES_APPROVED_COMPLETION_SHA256: '9'.repeat(64), EXPECTED_POINTER_SHA256: 'absent', STAGING_PLACES_APPROVED_POINTER_SHA256: 'absent' });
  placesGate(env); assert.throws(() => placesGate({ ...env, EXPECTED_POINTER_SHA256: '' }));
  assert.throws(() => placesGate({ ...env, STAGING_PLACES_APPROVED_POINTER_SHA256: undefined }));
  assert.throws(() => placesGate({ ...env, EXPECTED_POINTER_SHA256: 'a'.repeat(64) }));
  Object.assign(env, { EXPECTED_POINTER_SHA256: 'a'.repeat(64), STAGING_PLACES_APPROVED_POINTER_SHA256: 'a'.repeat(64) }); placesGate(env);
  assert.throws(() => placesGate({ ...env, STAGING_PLACES_APPROVED_POINTER_SHA256: 'absent' }));
});
test('all three proof scopes use exact authenticated evidence pins and tide-only roster policy', () => {
  assert.deepEqual(proofScopeArguments('tides', { kind: 'tide-checkpoint' }), ['--scope', 'staging-partial', '--min-available-stations', '1251']);
  for (const [family, kind, path, scope] of [['surf', 'surf-stage', 'stage.json', 'full-pilot'], ['paragliding', 'paragliding-snapshot', 'all-sites.json', 'worldwide-snapshot']]) {
    const args = proofScopeArguments(family, { kind, files: [{ path, sha256: 'a'.repeat(64) }] }); assert.deepEqual(args, ['--scope', scope, '--evidence-sha256', 'a'.repeat(64)]);
    assert(!args.includes('--min-available-stations')); assert.throws(() => proofScopeArguments(family, { kind: 'tide-checkpoint', files: [] }));
  }
});
test('runtime proof is never fabricated when committed qualifier is missing or credentials are present', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wx-proof-test-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const context = { ...placesGate(environment()), source: root }; let executions = 0;
  const execute = (_, args) => { executions++; return args[0] === 'rev-parse' ? context.sourceSha : ''; };
  await assert.rejects(runRuntimeProof(environment(), context, execute), /missing committed/); assert.equal(executions, 2);
  await assert.rejects(runRuntimeProof({ ...environment(), STAGING_PLACES_SEED_KEY: '1'.repeat(64) }, context, execute));
  await assert.rejects(runRuntimeProof({ ...environment(), STAGING_R2_WRITE_ACCESS_KEY_ID: 'credential' }, context, execute));
});
test('workflow scopes credentials to separate steps and never uploads plaintext or schedules publication', async () => {
  const text = await readFile('.github/workflows/staging-places.yml', 'utf8');
  assert(text.includes('group: weatherx-staging-publication')); assert(text.includes('name: data-staging'));
  assert(!/schedule:|upload-artifact|contents: write|wrangler|bake\.sh|weatherx-data-production/.test(text));
  const steps = text.split(/\n      - /); const decrypt = steps.find(step => step.includes('STAGING_PLACES_SEED_KEY:'));
  assert(decrypt.includes(' decrypt') && !decrypt.includes('STAGING_R2_WRITE_'));
  const writer = steps.find(step => step.includes('STAGING_R2_WRITE_ACCESS_KEY_ID:'));
  assert(writer.includes(' publish') && !writer.includes('STAGING_PLACES_SEED_KEY:'));
  assert(text.indexOf('mjs qualify') < text.indexOf('STAGING_R2_WRITE_ACCESS_KEY_ID:'));
  for (const match of text.matchAll(/uses: ([^\s]+)@([^\s]+)/g)) assert(/^[a-f0-9]{40}$/.test(match[2]));
});
async function publicationFixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wx-place-action-test-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const identity = 'a'.repeat(20), sourceSha = 'b'.repeat(40), encode = value => Buffer.from(JSON.stringify(value) + '\n');
  await mkdir(join(root, `versions/${identity}/cells`), { recursive: true }); await mkdir(join(root, `versions/${identity}/sites`));
  const cell = encode({ revision: identity, sites: [{ id: 1 }] }); await writeFile(join(root, `versions/${identity}/cells/1_2.json`), cell);
  await writeFile(join(root, `versions/${identity}/sites/1.json`), encode({ id: 1, revision: identity }));
  await writeFile(join(root, 'index.json'), encode({ schema: 1, revision: identity, count: 1, cells: [{ key: '1_2', sha256: hash(cell) }] }));
  const candidate = await qualifyPlaces({ kind: 'paragliding', root }), manifestSha256 = hash(candidate.manifestBody), context = { kind: 'paragliding', sourceSha, manifestSha256 };
  const proof = { schemaVersion: 1, kind: context.kind, identity, sourceSha, manifestSha256, checks: { producer: true, consumer: true, coverage: true, roster: true } };
  const objects = new Map(), reads = [], writes = [];
  const io = { async get(key, max, collect = true) { allowedKey(key); reads.push(key); const value = objects.get(key); if (!value) return null; assert(value.body.length <= max);
    return { ...value, bytes: value.body.length, sha256: hash(value.body), ...(collect ? {} : { body: undefined }) }; },
  async put(key, input, condition) { allowedKey(key); writes.push(key); const before = objects.get(key); assert(condition.ifNoneMatch ? !before : before?.etag === condition.ifMatch);
    const body = Buffer.isBuffer(input) ? input : await readFile(input.file); assert.equal(body.length, condition.bytes); assert.equal(hash(body), condition.sha256);
    objects.set(key, { body, etag: `"${writes.length}"`, customMetadata: { sha256: condition.sha256 }, httpMetadata: {} }); } };
  const prepared = await publishQualifiedPlaces(io, candidate, proof, context, { PLACES_ACTION: 'prepare' });
  assert.equal(prepared.activated, false); assert.equal(writes.length, candidate.manifest.files.length + 2); assert(writes.at(-1).endsWith('/completion.json')); assert(!objects.has(pointerKey(context.kind)));
  reads.length = 0; writes.length = 0;
  return { candidate, proof, context, io, objects, reads, writes, base: prefix(context.kind, identity), env: { PLACES_ACTION: 'activate', COMPLETION_SHA256: prepared.completion.sha256, EXPECTED_POINTER_SHA256: 'absent' } };
}
test('activation action reads each prepared payload once and only writes the pointer', async t => {
  const f = await publicationFixture(t); const result = await publishQualifiedPlaces(f.io, f.candidate, f.proof, f.context, f.env);
  assert.equal(result.activated, true); assert.deepEqual(f.writes, [pointerKey(f.context.kind)]);
  for (const file of f.candidate.manifest.files) assert.equal(f.reads.filter(key => key === f.base + file.path).length, 1, file.path);
  assert.equal(f.reads.length, f.candidate.manifest.files.length + 4, 'one payload scan, completion, manifest and pointer before/after');
});
test('activation never repairs missing payload, manifest or completion objects', async t => {
  for (const missing of ['sites/1.json', 'manifest.json', 'completion.json']) {
    const f = await publicationFixture(t); f.objects.delete(f.base + missing);
    await assert.rejects(publishQualifiedPlaces(f.io, f.candidate, f.proof, f.context, f.env)); assert.deepEqual(f.writes, []); assert(!f.objects.has(f.base + missing));
  }
});
test('activation retains exact proof and completion approval before remote reads', async t => {
  const f = await publicationFixture(t);
  await assert.rejects(publishQualifiedPlaces(f.io, f.candidate, f.proof, f.context, { ...f.env, COMPLETION_SHA256: '0'.repeat(64) }));
  await assert.rejects(publishQualifiedPlaces(f.io, f.candidate, { ...f.proof, sourceSha: '0'.repeat(40) }, f.context, f.env));
  assert.deepEqual(f.reads, []); assert.deepEqual(f.writes, []);
});
