import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv } from 'node:crypto';
import { qualifyPlaces, hash, LIMITS, validateManifest } from '../tools/staging-places.mjs';
import { packSeed, unpackSeed, checkpointEvidence, downloadSeed, seedURL, noPublishCredentials, MAX_ARCHIVE } from '../tools/staging-places-seed.mjs';
const key = '1'.repeat(64), sourceSha = 'a'.repeat(40), encode = row => Buffer.from(JSON.stringify(row) + '\n');
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wx-seed-test-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'input'), identity = 'a'.repeat(20); await mkdir(join(input, `versions/${identity}/sites`), { recursive: true }); await mkdir(join(input, `versions/${identity}/cells`));
  const cell = encode({ revision: identity, sites: [{ id: 1 }] }); await writeFile(join(input, `versions/${identity}/cells/1_2.json`), cell);
  await writeFile(join(input, `versions/${identity}/sites/1.json`), encode({ id: 1, revision: identity }));
  await writeFile(join(input, 'index.json'), encode({ schema: 1, revision: identity, count: 1, cells: [{ key: '1_2', sha256: hash(cell) }] }));
  const candidate = await qualifyPlaces({ kind: 'paragliding', root: input }); const archive = join(root, 'seed.wxps');
  const receipt = await packSeed({ candidate, key, sourceSha, output: archive }); return { root, candidate, archive, receipt };
}
test('dedicated authenticated seed roundtrips exact bytes with private permissions and no proof fabrication', async t => {
  const f = await fixture(t), output = join(f.root, 'out'); const candidate = await unpackSeed({ archive: f.archive, output, key, ...f.receipt });
  assert.deepEqual(candidate.manifestBody, f.candidate.manifestBody); assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(output, 'index.json'))).mode & 0o777, 0o600); assert.equal(candidate.qualification, undefined);
  assert.equal(hash(await readFile(f.archive)), f.receipt.ciphertextSha256);
});
test('wrong key, tampered ciphertext, plaintext pin, source pin and manifest pin refuse extraction', async t => {
  const f = await fixture(t);
  for (const change of [{ key: '2'.repeat(64) }, { plaintextSha256: '0'.repeat(64) }, { sourceSha: 'b'.repeat(40) }, { manifestSha256: '0'.repeat(64) }]) {
    const output = join(f.root, 'out'); await assert.rejects(unpackSeed({ archive: f.archive, output, key, ...f.receipt, ...change })); await assert.rejects(stat(output));
  }
  const body = await readFile(f.archive); body[30] ^= 1; await writeFile(f.archive, body);
  await assert.rejects(unpackSeed({ archive: f.archive, output: join(f.root, 'out'), key, ...f.receipt }));
});
test('authenticated malicious archive cannot introduce traversal, duplicate entries or unexpected trailing bytes', async t => {
  const f = await fixture(t);
  for (const mutation of [manifest => { manifest.files[0].path = '../escape.json'; }, manifest => { manifest.files.push(manifest.files[0]); }, null]) {
    const manifest = structuredClone(f.candidate.manifest); mutation?.(manifest);
    const header = encode({ schemaVersion: 1, kind: 'paragliding', identity: manifest.identity, sourceSha, manifestSha256: hash(encode(manifest)), manifest, evidence: null });
    const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
    const tail = mutation ? [] : [...await Promise.all(f.candidate.manifest.files.map(file => readFile(f.candidate.local.get(file.path).file))), Buffer.from('extra')];
    const plain = Buffer.concat([size, header, ...tail]); const magic = Buffer.from('WXPS1\0'), iv = Buffer.alloc(12, 1);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv); cipher.setAAD(magic);
    const body = Buffer.concat([magic, iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]); const archive = join(f.root, 'bad.wxps'); await writeFile(archive, body);
    await assert.rejects(unpackSeed({ archive, output: join(f.root, 'out'), key, kind: 'paragliding', sourceSha, manifestSha256: hash(encode(manifest)), ciphertextSha256: hash(body), plaintextSha256: hash(plain) }));
    await assert.rejects(stat(join(f.root, 'out'))); await assert.rejects(stat(join(f.root, 'escape.json')));
  }
});
test('seed unpack refuses symlink input and existing output without touching existing bytes', async t => {
  const f = await fixture(t); const linked = join(f.root, 'linked'); await symlink(f.archive, linked);
  await assert.rejects(unpackSeed({ archive: linked, output: join(f.root, 'out'), key, ...f.receipt }));
  const output = join(f.root, 'out'); await mkdir(output); await writeFile(join(output, 'keep'), 'owned');
  await assert.rejects(unpackSeed({ archive: f.archive, output, key, ...f.receipt })); assert.equal(await readFile(join(output, 'keep'), 'utf8'), 'owned');
});
test('download only allows exact public Cycle release asset and bounded unauthenticated GitHub asset redirect', async t => {
  const f = await fixture(t), body = await readFile(f.archive), calls = [];
  await downloadSeed({ kind: 'paragliding', tag: 'places-seed-20260910', ciphertextSha256: hash(body), output: join(f.root, 'download'), fetchImpl: async (url, options) => {
    calls.push({ url, options }); return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset?sig=opaque' } }) : new Response(body);
  } });
  assert.equal(calls[0].url, seedURL('paragliding', 'places-seed-20260910')); assert(calls.every(row => row.options.credentials === 'omit' && row.options.redirect === 'manual' && !row.options.headers.Authorization));
  for (const location of ['https://evil.example/x', 'http://release-assets.githubusercontent.com/x', 'https://user@release-assets.githubusercontent.com/x']) await assert.rejects(downloadSeed({ kind: 'surf', tag: 'seed', ciphertextSha256: hash(body), output: join(f.root, 'bad'), fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) }));
  await assert.rejects(downloadSeed({ kind: 'surf', tag: 'seed', ciphertextSha256: hash(body), output: join(f.root, 'large'), fetchImpl: async () => new Response('x', { headers: { 'content-length': String(MAX_ARCHIVE + 1) } }) }));
  await assert.rejects(downloadSeed({ kind: 'surf', tag: 'seed', ciphertextSha256: '0'.repeat(64), output: join(f.root, 'wrong'), fetchImpl: async () => new Response(body) })); await assert.rejects(stat(join(f.root, 'wrong')));
});
test('transport rejects foreign credentials and unsafe release names', () => {
  for (const name of ['UI_CANDIDATE_KEY', 'UI_BUILD_PRIVATE_KEY', 'STAGING_R2_WRITE_ACCESS_KEY_ID', 'CLOUDFLARE_API_TOKEN']) assert.throws(() => noPublishCredentials({ [name]: 'secret' }));
  for (const tag of ['../tag', 'a/b', 'a%20b', 'a?query', 'a#fragment']) assert.throws(() => seedURL('surf', tag));
});
test('frozen tide evidence is authenticated separately, preserves absence and never enters publisher inventory', async t => {
  const f = await fixture(t), root = join(f.root, 'tides'), checkpoint = join(f.root, 'checkpoint'), datasetId = 'noaa-coops-test';
  await mkdir(join(root, `v2/versions/${datasetId}/stations/1`), { recursive: true }); await mkdir(join(checkpoint, 'products/1'), { recursive: true });
  const source = { provider: 'NOAA CO-OPS' }, datum = { id: 'MLLW' };
  await writeFile(join(root, `v2/versions/${datasetId}/stations/1/window.json`), encode({ schemaVersion: 2, datasetId, stationId: '1', source, datum }));
  await writeFile(join(root, 'v2/catalog.json'), encode({ schemaVersion: 2, datasetId, source, datum, stations: [{ id: '1', sampleCoverage: { endMs: Date.now() + 9 * 86400000 }, packs: [{ path: `versions/${datasetId}/stations/1/window.json` }] }] }));
  await writeFile(join(root, 'tides.json'), encode({ stations: [] }));
  await writeFile(join(checkpoint, 'manifest.json'), encode({ kind: 'weatherx-tide-fetch', stations: [{ id: '1' }, { id: '2' }] }));
  await writeFile(join(checkpoint, 'products/1/6.json'), encode({ source: 'six-minute-source' })); await writeFile(join(checkpoint, 'products/1/hilo.json'), encode({ source: 'event-source' }));
  const candidate = await qualifyPlaces({ kind: 'tides', root }), evidence = await checkpointEvidence(checkpoint), archive = join(f.root, 'tides.wxps');
  const receipt = await packSeed({ candidate, evidence, sourceSha, key, output: archive });
  const output = join(f.root, 'tides-out'), evidenceOutput = join(f.root, 'checkpoint-out');
  const restored = await unpackSeed({ archive, output, evidenceOutput, key, ...receipt });
  assert.deepEqual(restored.manifest, candidate.manifest); assert(restored.manifest.files.every(file => !file.path.includes('products')));
  assert.deepEqual((await checkpointEvidence(evidenceOutput)).document, evidence.document); await assert.rejects(stat(join(evidenceOutput, 'products/2')));
  await mkdir(join(checkpoint, 'products/3')); await writeFile(join(checkpoint, 'products/3/6.json'), '{}'); await assert.rejects(checkpointEvidence(checkpoint), /outside frozen roster/);
  await assert.rejects(packSeed({ candidate: f.candidate, evidence, sourceSha, key, output: join(f.root, 'mixed.wxps') }));
});
test('PG large source evidence streams separately without raising payload limits or allowing extra filenames', async t => {
  const f = await fixture(t), root = join(f.root, 'evidence'); await mkdir(root);
  await writeFile(join(root, 'all-sites.json'), Buffer.alloc(LIMITS.fileBytes + 1, 32)); await writeFile(join(root, 'manifest.json'), '{}');
  const evidence = await checkpointEvidence(root, 'paragliding'), archive = join(f.root, 'pg-evidence.wxps');
  const receipt = await packSeed({ candidate: f.candidate, evidence, sourceSha, key, output: archive });
  const restored = await unpackSeed({ archive, output: join(f.root, 'pg-out'), key, ...receipt }); assert.deepEqual(restored.seedEvidence, evidence.document);
  assert.equal(restored.manifest.files.length, f.candidate.manifest.files.length);
  const large = structuredClone(f.candidate.manifest); large.files[0].bytes = LIMITS.fileBytes + 1; assert.throws(() => validateManifest(large));
  await writeFile(join(root, 'extra.json'), '{}'); await assert.rejects(checkpointEvidence(root, 'paragliding'), /unsafe family/);
  await assert.rejects(checkpointEvidence(root, 'surf'));
});
test('surf evidence accepts exactly its real stage filename and no PG or tide namespace', async t => {
  const f = await fixture(t), root = join(f.root, 'evidence'); await mkdir(root); await writeFile(join(root, 'stage.json'), '{}');
  const evidence = await checkpointEvidence(root, 'surf'); assert.equal(evidence.document.kind, 'surf-stage'); assert.deepEqual(evidence.document.files.map(file => file.path), ['stage.json']);
  await assert.rejects(checkpointEvidence(root, 'paragliding')); await assert.rejects(checkpointEvidence(root, 'tides'));
});
