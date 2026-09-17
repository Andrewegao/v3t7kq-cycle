#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const STATION = /^M:[A-Z0-9]{3,8}$/;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();
const canonicalJson = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  throw new Error('Readback receipt contains a non-canonical value');
};
export const productionReceiptHash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function validateProductionCollection(receipt, engineSha, expectedStations) {
  assert.match(engineSha, SHA40);
  assert.ok(Number.isSafeInteger(expectedStations) && expectedStations >= 1 && expectedStations <= 64);
  assert.ok(exactKeys(receipt, ['schemaVersion','sourceGitSha','sourceTreeClean','generatedAt','releaseId','verifyRunId',
    'issued','failed','truthCount','observationAcquisitions','baselineId','networkSha256','published']), 'Unexpected collection receipt schema');
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.sourceGitSha, engineSha);
  assert.equal(receipt.sourceTreeClean, true);
  assert.equal(receipt.published, true);
  assert.equal(receipt.baselineId, 'builtin-v1', 'Production evidence capture must not activate calibration');
  assert.match(receipt.releaseId, ID);
  assert.match(receipt.verifyRunId, /^\d{10}$/);
  assert.match(receipt.networkSha256, SHA64);
  assert.ok(Number.isFinite(Date.parse(receipt.generatedAt)));
  assert.equal(receipt.issued, expectedStations);
  assert.equal(receipt.failed, 0);
  assert.ok(Number.isSafeInteger(receipt.truthCount) && receipt.truthCount > 0);
  assert.equal(receipt.observationAcquisitions?.length, expectedStations);
  const stations = new Set();
  let observationBytes = 0;
  for (const item of receipt.observationAcquisitions) {
    assert.ok(exactKeys(item, ['stationId','icao','source','requestUrl','requestedAt','receivedAt','responseBytes','responseSha256','acceptedTruths']));
    assert.match(item.stationId, STATION);
    assert.equal(item.stationId, `M:${item.icao}`);
    assert.equal(item.source, 'noaa-aviationweather-metar');
    assert.ok(!stations.has(item.stationId)); stations.add(item.stationId);
    const url = new URL(item.requestUrl);
    assert.equal(url.origin, 'https://aviationweather.gov');
    assert.equal(url.pathname, '/api/data/metar');
    assert.equal(url.searchParams.get('ids'), item.icao);
    assert.equal(url.searchParams.get('hours'), '48');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal([...url.searchParams].length, 3);
    assert.ok(Number.isFinite(Date.parse(item.requestedAt)) && Date.parse(item.receivedAt) >= Date.parse(item.requestedAt));
    assert.ok(Number.isSafeInteger(item.responseBytes) && item.responseBytes > 0 && item.responseBytes <= 4 * 1024 * 1024);
    assert.match(item.responseSha256, SHA64);
    assert.ok(Number.isSafeInteger(item.acceptedTruths) && item.acceptedTruths > 0);
    observationBytes += item.responseBytes;
  }
  assert.equal(receipt.truthCount, receipt.observationAcquisitions.reduce((sum, item) => sum + item.acceptedTruths, 0));
  return { schemaVersion: 1, kind: 'fusion-production-collection', recordedAt: receipt.generatedAt,
    sourceGitSha: engineSha, releaseId: receipt.releaseId, verifyRunId: receipt.verifyRunId,
    stations: expectedStations, issued: receipt.issued, failed: receipt.failed, truthsSubmitted: receipt.truthCount,
    observationRequests: stations.size, observationBytes, calibrationEnabled: false, status: 'complete' };
}

export function validateProductionReadback(receipt, engineSha, expectedStations) {
  assert.ok(exactKeys(receipt, ['schemaVersion','kind','sourceGitSha','generatedAt','records','recordsSha256','recordCount']));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, 'fusion-archive-readback');
  assert.equal(receipt.sourceGitSha, engineSha);
  assert.equal(receipt.recordCount, expectedStations);
  assert.equal(receipt.records?.length, expectedStations);
  assert.match(receipt.recordsSha256, SHA64);
  assert.equal(receipt.recordsSha256, productionReceiptHash(receipt.records));
  assert.ok(Number.isFinite(Date.parse(receipt.generatedAt)));
  const stations = new Set(), issues = new Set(), keys = new Set();
  for (const record of receipt.records) {
    assert.ok(exactKeys(record, ['stationId','issueId','issuedAt','key','catalogId','sourceRuns']));
    assert.match(record.stationId, STATION);
    assert.match(record.issueId, SHA64);
    assert.match(record.catalogId, ID);
    assert.ok(Number.isFinite(Date.parse(record.issuedAt)));
    assert.match(record.key, /^issues\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{64}\.json$/);
    assert.ok(!stations.has(record.stationId)); stations.add(record.stationId);
    assert.ok(!issues.has(record.issueId)); issues.add(record.issueId);
    assert.ok(!keys.has(record.key)); keys.add(record.key);
    assert.deepEqual(Object.keys(record.sourceRuns).sort(), ['ecmwf', 'gfs']);
    assert.match(record.sourceRuns.ecmwf, /^\d{10}$/);
    assert.match(record.sourceRuns.gfs, /^\d{10}$/);
  }
  assert.equal(new Set(receipt.records.map(record => record.catalogId)).size, 1, 'A run must remain on one point catalog');
  assert.equal(new Set(receipt.records.map(record => record.sourceRuns.ecmwf)).size, 1, 'A run must remain on one ECMWF cycle');
  assert.equal(new Set(receipt.records.map(record => record.sourceRuns.gfs)).size, 1, 'A run must remain on one GFS cycle');
  return { schemaVersion: 1, kind: 'fusion-production-run', recordedAt: receipt.generatedAt,
    sourceGitSha: engineSha, stations: expectedStations, readbackVerified: expectedStations,
    catalogIds: [...new Set(receipt.records.map(record => record.catalogId))].sort(),
    sourceRuns: [...new Set(receipt.records.flatMap(record => Object.entries(record.sourceRuns).map(([model, runId]) => `${model}:${runId}`)))].sort(),
    status: 'complete', calibrationEnabled: false };
}

export function validateProductionManifest(receipt, engineSha, readback) {
  assert.ok(exactKeys(receipt, ['schemaVersion','kind','sourceGitSha','generatedAt','manifestId','archiveCatalogId',
    'archiveCatalogRevision','recordCount','recordsSha256']));
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.kind, 'fusion-commercial-archive-manifest-receipt');
  assert.equal(receipt.sourceGitSha, engineSha);
  assert.equal(receipt.recordCount, 64);
  assert.equal(receipt.recordsSha256, readback.recordsSha256);
  assert.match(receipt.manifestId, SHA64);
  assert.match(receipt.archiveCatalogId, SHA64);
  assert.ok(Number.isSafeInteger(receipt.archiveCatalogRevision) && receipt.archiveCatalogRevision >= 1);
  assert.ok(Number.isFinite(Date.parse(receipt.generatedAt)));
  return { manifestId: receipt.manifestId, archiveCatalogId: receipt.archiveCatalogId,
    archiveCatalogRevision: receipt.archiveCatalogRevision };
}

export async function main(mode, directory) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const engineSha = process.env.ENGINE_SHA ?? '';
  const expectedStations = Number(process.env.EXPECTED_STATIONS);
  if (mode === 'receipt') {
    const collection = validateProductionCollection(JSON.parse(await readFile(resolve(root, 'collection-receipt.json'), 'utf8')), engineSha, expectedStations);
    await writeFile(resolve(root, 'collection-status.json'), JSON.stringify(collection) + '\n', { flag: 'wx', mode: 0o600 });
  } else if (mode === 'readback') {
    const source = resolve(process.env.READBACK_RECEIPT ?? '');
    const receipt = JSON.parse(await readFile(source, 'utf8'));
    const readback = validateProductionReadback(receipt, engineSha, expectedStations);
    const manifest = expectedStations === 64
      ? validateProductionManifest(JSON.parse(await readFile(resolve(process.env.MANIFEST_RECEIPT ?? ''), 'utf8')), engineSha, receipt)
      : null;
    await writeFile(resolve(root, 'run-status.json'), JSON.stringify({ ...readback, ...(manifest ? { archiveManifest: manifest } : {}) }) + '\n',
      { flag: 'wx', mode: 0o600 });
  } else if (mode === 'gap') {
    const outcomes = Object.fromEntries(['COLLECT','RECEIPT','READBACK'].map(key => {
      const value = process.env[`${key}_OUTCOME`];
      return [key.toLowerCase(), ['success','failure','cancelled','skipped'].includes(value) ? value : 'unknown'];
    }));
    await writeFile(resolve(root, 'run-status.json'), JSON.stringify({ schemaVersion: 1, kind: 'fusion-production-run',
      recordedAt: new Date().toISOString(), runId: /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ? process.env.GITHUB_RUN_ID : null,
      outcomes, status: 'gap', calibrationEnabled: false }) + '\n', { flag: 'wx', mode: 0o600 });
  } else throw new Error('Expected receipt, readback, or gap');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2], process.argv[3]).catch(() => {
    console.error('Production Fusion evidence gate failed; inspect the retained bounded status.');
    process.exitCode = 1;
  });
}
