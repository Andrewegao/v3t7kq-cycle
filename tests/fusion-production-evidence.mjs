import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, productionReceiptHash, validateProductionCollection, validateProductionManifest, validateProductionReadback } from '../tools/fusion-production-evidence.mjs';

const engine = 'a'.repeat(40);
const observations = count => Array.from({ length: count }, (_, index) => {
  const icao = `K${String(index).padStart(3, '0')}`;
  return { stationId: `M:${icao}`, icao, source: 'noaa-aviationweather-metar',
    requestUrl: `https://aviationweather.gov/api/data/metar?ids=${icao}&hours=48&format=json`,
    requestedAt: '2026-09-17T00:00:00.000Z', receivedAt: '2026-09-17T00:00:00.100Z',
    responseBytes: 1200, responseSha256: 'b'.repeat(64), acceptedTruths: 2 };
});
const collection = count => ({ schemaVersion: 1, sourceGitSha: engine, sourceTreeClean: true,
  generatedAt: '2026-09-17T00:00:01.000Z', releaseId: 'cycle-1', verifyRunId: '2026082800',
  issued: count, failed: 0, truthCount: count * 2, observationAcquisitions: observations(count),
  baselineId: 'builtin-v1', networkSha256: 'c'.repeat(64), published: true });
const records = count => Array.from({ length: count }, (_, index) => {
  const stationId = observations(count)[index].stationId;
  return { stationId, issueId: String(index + 1).padStart(64, '0'), issuedAt: '2026-09-17T00:00:02.000Z',
    key: `issues/2026-09-17/${String(index + 101).padStart(64, '0')}.json`, catalogId: 'catalog-2',
    sourceRuns: { ecmwf: '2026091612', gfs: '2026091618' } };
});
const readback = count => { const values = records(count); return { schemaVersion: 1, kind: 'fusion-archive-readback', sourceGitSha: engine,
  generatedAt: '2026-09-17T00:00:03.000Z', records: values, recordsSha256: productionReceiptHash(values), recordCount: count }; };
const manifest = source => ({ schemaVersion: 1, kind: 'fusion-commercial-archive-manifest-receipt', sourceGitSha: engine,
  generatedAt: '2026-09-17T00:00:04.000Z', manifestId: 'd'.repeat(64), archiveCatalogId: 'e'.repeat(64),
  archiveCatalogRevision: 1, recordCount: 64, recordsSha256: source.recordsSha256 });

test('one-station canary and full collection require complete source-bound observations', () => {
  assert.equal(validateProductionCollection(collection(1), engine, 1).status, 'complete');
  assert.equal(validateProductionCollection(collection(64), engine, 64).observationRequests, 64);
  for (const value of [
    { ...collection(1), failed: 1 }, { ...collection(1), issued: 0 }, { ...collection(1), baselineId: 'candidate' },
    { ...collection(1), sourceTreeClean: false }, { ...collection(1), observationAcquisitions: [] },
    { ...collection(1), observationAcquisitions: [{ ...observations(1)[0], requestUrl: 'https://weatherx.org/cdn/metar' }] },
    { ...collection(1), observationAcquisitions: [{ ...observations(1)[0], acceptedTruths: 0 }] },
    { ...collection(1), truthCount: 1 },
  ]) assert.throws(() => validateProductionCollection(value, engine, 1));
});

test('the complete network alone publishes a coherent archive manifest receipt', () => {
  const source = readback(64);
  assert.deepEqual(validateProductionManifest(manifest(source), engine, source), {
    manifestId: 'd'.repeat(64), archiveCatalogId: 'e'.repeat(64), archiveCatalogRevision: 1,
  });
  for (const candidate of [
    { ...manifest(source), recordCount: 63 },
    { ...manifest(source), recordsSha256: 'f'.repeat(64) },
    { ...manifest(source), archiveCatalogRevision: 0 },
  ]) assert.throws(() => validateProductionManifest(candidate, engine, source));
});

test('readback binds every station to exact catalogs and model runs', () => {
  const value = validateProductionReadback(readback(1), engine, 1);
  assert.deepEqual(value.catalogIds, ['catalog-2']);
  assert.deepEqual(value.sourceRuns, ['ecmwf:2026091612', 'gfs:2026091618']);
  for (const candidate of [
    { ...readback(1), recordCount: 0 },
    { ...readback(1), recordsSha256: 'd'.repeat(64) },
    { ...readback(1), records: [{ ...records(1)[0], catalogId: 'bad/id' }] },
    { ...readback(1), records: [{ ...records(1)[0], sourceRuns: { ecmwf: 'latest', gfs: '2026091618' } }] },
  ]) assert.throws(() => validateProductionReadback(candidate, engine, 1));
  const splitCatalog = readback(2); splitCatalog.records[1].catalogId = 'catalog-3';
  splitCatalog.recordsSha256 = productionReceiptHash(splitCatalog.records);
  assert.throws(() => validateProductionReadback(splitCatalog, engine, 2));
});

test('gap output is bounded, secret-free, and immutable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fusion-production-evidence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = Object.fromEntries(['GITHUB_RUN_ID','COLLECT_OUTCOME','RECEIPT_OUTCOME','READBACK_OUTCOME'].map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { GITHUB_RUN_ID: '123', COLLECT_OUTCOME: 'failure', RECEIPT_OUTCOME: 'skipped', READBACK_OUTCOME: 'private error text' });
    await main('gap', root);
    const status = JSON.parse(await readFile(join(root, 'run-status.json'), 'utf8'));
    assert.equal(status.status, 'gap');
    assert.equal(status.outcomes.readback, 'unknown');
    assert.doesNotMatch(JSON.stringify(status), /private error text/);
    await assert.rejects(main('gap', root), { code: 'EEXIST' });
  } finally {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
});

test('infrastructure preflight installs pinned Python dependencies before the platform check', async () => {
  const workflow = await readFile(new URL('../.github/workflows/fusion-infra.yml', import.meta.url), 'utf8');
  const setup = workflow.indexOf('actions/setup-python@a26af69be951a213d495a4c3e4e4022e16d87065');
  const dependencies = workflow.indexOf('Pillow==12.2.0 numpy==2.4.6 eccodes==2.47.0');
  const platformCheck = workflow.indexOf('npm run check --prefix platform/edge');
  const deploy = workflow.indexOf('npx wrangler deploy --env "$TARGET" -c wrangler.fusion-archive.jsonc');
  assert.ok(setup > 0);
  assert.ok(setup < dependencies);
  assert.ok(dependencies < platformCheck);
  assert.ok(platformCheck < deploy);
});
