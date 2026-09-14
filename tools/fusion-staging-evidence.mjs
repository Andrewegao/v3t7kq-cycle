import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
export const WORKER = 'weatherx-fusion-archive-staging';
export const READER = 'weatherx-fusion-evidence-reader-staging';
export function isolatedArchive(settings, routes, subdomain) {
  assert.ok(settings && Array.isArray(settings.bindings), 'Missing live archive bindings');
  const bindings = settings.bindings;
  assert.equal(bindings.filter(b => b.type !== 'secret_text').length, 1, 'Unexpected archive capability');
  assert.ok(bindings.some(b => b.type === 'r2_bucket' && b.name === 'FUSION_ARCHIVE_BUCKET' && b.bucket_name === WORKER), 'Archive bucket is not staging isolated');
  assert.deepEqual(bindings.filter(b => b.type === 'secret_text').map(b => b.name).sort(), ['FUSION_ARCHIVE_READ_KEY', 'FUSION_ISSUANCE_KEY']);
  assert.ok(Array.isArray(routes) && routes.every(r => r.script !== WORKER), 'Archive must have no customer route');
  assert.match(subdomain, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  return `https://${WORKER}.${subdomain}.workers.dev`;
}
export function collectionSummary(receipt, engine) {
  assert.match(engine, /^[a-f0-9]{40}$/);
  assert.deepEqual(Object.keys(receipt).sort(), ['schemaVersion','sourceGitSha','sourceTreeClean','generatedAt','releaseId','verifyRunId','issued','failed','truthCount','observationAcquisitions','baselineId','networkSha256','published'].sort());
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.sourceGitSha, engine);
  assert.equal(receipt.sourceTreeClean, true);
  assert.equal(receipt.published, true);
  assert.equal(receipt.baselineId, 'builtin-v1', 'Staging evidence cannot activate calibration');
  assert.match(receipt.networkSha256, /^[a-f0-9]{64}$/);
  assert.ok(Number.isFinite(Date.parse(receipt.generatedAt)));
  assert.match(receipt.releaseId, /^[A-Za-z0-9_-]+$/);
  assert.match(receipt.verifyRunId, /^\d{10}$/);
  for (const key of ['issued', 'failed', 'truthCount']) assert.ok(Number.isSafeInteger(receipt[key]) && receipt[key] >= 0);
  assert.equal(receipt.issued + receipt.failed, 64, 'Every frozen station must be accounted for');
  assert.ok(receipt.issued > 0, 'No forecast issued');
  assert.ok(receipt.truthCount > 0, 'No observations recorded');
  assert.equal(receipt.observationAcquisitions?.length, 64, 'Every station needs an independent observation receipt');
  const stationIds = new Set();
  for (const acquisition of receipt.observationAcquisitions) {
    assert.deepEqual(Object.keys(acquisition).sort(), ['stationId','icao','source','requestUrl','requestedAt','receivedAt','responseBytes','responseSha256'].sort());
    assert.match(acquisition.stationId, /^M:[A-Z0-9]{3,8}$/);
    assert.ok(!stationIds.has(acquisition.stationId), 'Observation station receipt is duplicated');
    stationIds.add(acquisition.stationId);
    assert.match(acquisition.icao, /^[A-Z0-9]{3,8}$/);
    assert.equal(acquisition.stationId, `M:${acquisition.icao}`, 'Observation station receipt does not match ICAO');
    assert.equal(acquisition.source, 'noaa-aviationweather-metar');
    const observationUrl = new URL(directObservation(acquisition.requestUrl));
    assert.equal(observationUrl.searchParams.get('ids'), acquisition.icao);
    assert.equal(observationUrl.searchParams.get('hours'), '48');
    assert.equal(observationUrl.searchParams.get('format'), 'json');
    assert.equal([...observationUrl.searchParams].length, 3);
    const requestedAt = Date.parse(acquisition.requestedAt), receivedAt = Date.parse(acquisition.receivedAt);
    assert.ok(Number.isFinite(requestedAt) && Number.isFinite(receivedAt) && receivedAt >= requestedAt);
    assert.ok(Number.isSafeInteger(acquisition.responseBytes) && acquisition.responseBytes > 0 && acquisition.responseBytes <= 4 * 1024 * 1024);
    assert.match(acquisition.responseSha256, /^[a-f0-9]{64}$/);
  }
  return { schemaVersion: 1, kind: 'fusion-staging-collection', recordedAt: receipt.generatedAt,
    sourceGitSha: engine, issued: receipt.issued, failed: receipt.failed, observations: receipt.truthCount,
    observationReceipts: stationIds.size, status: receipt.failed ? 'partial' : 'complete', calibrationEnabled: false };
}
export function isolatedReader(settings, subdomain) {
  const bindings = settings?.bindings;
  assert.ok(Array.isArray(bindings));
  const buckets = bindings.filter(b => b.type === 'r2_bucket');
  assert.deepEqual(buckets.map(b => [b.name, b.bucket_name]).sort(), [
    ['COMPONENT_BUCKET', 'weatherx-fusion-evidence-components-staging'],
    ['DATA_BUCKET', 'weatherx-fusion-evidence-data-staging'],
  ]);
  assert.ok(bindings.every(b => ['r2_bucket', 'plain_text'].includes(b.type)), 'Unexpected reader capability');
  assert.equal(bindings.find(b => b.name === 'DATA_SOURCE_MODE')?.text, 'own');
  assert.match(subdomain, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  return `https://${READER}.${subdomain}.workers.dev`;
}
export function directObservation(url) {
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://aviationweather.gov');
  assert.equal(parsed.pathname, '/api/data/metar');
  assert.equal(parsed.username + parsed.password + parsed.hash, '');
  return url;
}
async function api(path) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/${path}`, {
    headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  // Never include a provider response or credential in an error or retained receipt.
  assert.ok(response.ok, `Read-only isolation preflight failed (${response.status})`);
  assert.ok(response.body);
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) { await reader.cancel(); throw Error('Isolation response too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(body.success, true, 'Isolation API rejected read');
  assert.ok(body.result_info?.total_pages === undefined || body.result_info.total_pages <= 1, 'Isolation inventory requires pagination');
  return body.result;
}
export async function main(mode, directory) {
  const out = resolve(directory); await mkdir(out, { recursive: true });
  if (mode === 'preflight') {
    assert.ok(process.env.CLOUDFLARE_API_TOKEN && process.env.GITHUB_OUTPUT);
    const [settings, reader, zones, domains, domain] = await Promise.all([
      api(`accounts/${ACCOUNT}/workers/scripts/${WORKER}/settings`),
      api(`accounts/${ACCOUNT}/workers/scripts/${READER}/settings`),
      api(`zones?account.id=${ACCOUNT}&per_page=50`),
      api(`accounts/${ACCOUNT}/workers/domains`),
      api(`accounts/${ACCOUNT}/workers/subdomain`),
    ]);
    assert.ok(Array.isArray(zones) && zones.length < 50, 'Route inventory is incomplete');
    const routes = (await Promise.all(zones.map(z => { assert.match(z.id, /^[a-f0-9]{32}$/); return api(`zones/${z.id}/workers/routes`); }))).flat();
    assert.ok(Array.isArray(domains) && domains.every(d => ![WORKER, READER].includes(d.service)), 'Evidence Worker has custom domain');
    const archiveOrigin = isolatedArchive(settings, routes, domain.subdomain);
    assert.ok(routes.every(r => r.script !== READER), 'Evidence reader has customer route');
    const readOrigin = isolatedReader(reader, domain.subdomain);
    await writeFile(resolve(out, 'isolation.json'), JSON.stringify({ schemaVersion: 1, worker: WORKER,
      archiveBucket: WORKER, archiveOrigin, readOrigin, calibrationEnabled: false, checkedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    await appendFile(process.env.GITHUB_OUTPUT, `archive_origin=${archiveOrigin}\nread_origin=${readOrigin}\n`);
  } else if (mode === 'receipt') {
    const summary = collectionSummary(JSON.parse(await readFile(resolve(out, 'collection-receipt.json'), 'utf8')), process.env.ENGINE_SHA);
    await writeFile(resolve(out, 'collection-status.json'), JSON.stringify(summary) + '\n', { flag: 'wx', mode: 0o600 });
    assert.equal(summary.failed, 0, 'Partial collection retained; failed stations are an evidence gap');
  } else if (mode === 'gap') {
    const outcomes = Object.fromEntries(['PREFLIGHT', 'COLLECT', 'RECEIPT', 'PULL', 'SCORE'].map(k => {
      const v = process.env[k + '_OUTCOME']; return [k.toLowerCase(), ['success', 'failure', 'cancelled', 'skipped'].includes(v) ? v : 'unknown'];
    }));
    await writeFile(resolve(out, 'run-status.json'), JSON.stringify({ schemaVersion: 1, kind: 'fusion-staging-run',
      recordedAt: new Date().toISOString(), runId: /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ? process.env.GITHUB_RUN_ID : null,
      outcomes, status: Object.values(outcomes).every(v => v === 'success') ? 'complete' : 'gap', calibrationEnabled: false }) + '\n', { flag: 'wx', mode: 0o600 });
  } else throw Error('Unknown staging evidence operation');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2], process.argv[3]).catch(() => { console.error('Staging evidence gate failed; bounded status is retained where available.'); process.exitCode = 1; });
}
