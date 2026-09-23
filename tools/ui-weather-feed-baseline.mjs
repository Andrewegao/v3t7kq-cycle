#!/usr/bin/env node
// Read-only preflight for the existing production UI, which predates the USGS route.
// The promoted candidate must still pass the full pinned weather-feed verifier.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const PATHS = Object.freeze([
  ['/api/tc/list', 'features', 55_000],
  ['/api/gdacs/list', 'features', 12_000],
  ['/api/eonet/list', 'events', 12_000],
  ['/api/eonet/fallback', 'events', 12_000],
]);
const MAX_BYTES = 32 * 1024 * 1024;

async function boundedJson(response) {
  const declared = response.headers.get('content-length');
  if (declared != null) assert.ok(/^\d+$/.test(declared) && Number(declared) <= MAX_BYTES,
    'feed response size invalid');
  assert.ok(response.body, 'feed response has no body');
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    assert.ok(size <= MAX_BYTES, 'feed response exceeds bound');
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function verifyBaseline(origin, fetchImpl = fetch) {
  assert.equal(origin, 'https://weatherx.org');
  const receipts = [];
  async function read(path, key, timeout) {
    const response = await fetchImpl(origin + path,
      { redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    const json = /^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '');
    if (response.status === 502 && json) {
      const degraded = await boundedJson(response);
      assert.deepEqual(degraded, { error: 'upstream unavailable' }, `${path}: invalid degraded-source receipt`);
      receipts.push({ path, available: false }); return [];
    }
    assert.ok(response.ok && json, `${path}: expected feed JSON, received HTTP ${response.status}`);
    const data = await boundedJson(response);
    assert.ok(data && Array.isArray(data[key]) && (key !== 'features' || data.type === 'FeatureCollection'),
      `${path}: invalid feed contract`);
    const age = response.headers.get('x-swr-age');
    assert.ok(age != null && /^\d+$/.test(age) && Number(age) < 86_400,
      `${path}: missing or expired feed age`);
    receipts.push({ path, available: true, count: data[key].length, ageSeconds: Number(age) });
    return data[key];
  }
  async function hazards() {
    const path = '/api/hazards';
    const response = await fetchImpl(origin + path,
      { redirect: 'manual', signal: AbortSignal.timeout(55_000) });
    assert.ok(response.ok && /^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? ''),
      'composed hazards are not JSON');
    const data = await boundedJson(response);
    assert.ok(data?.v === 1 && Array.isArray(data.tc) && Array.isArray(data.ev) && Array.isArray(data.bundles),
      'composed hazard contract invalid');
    // The old production snapshot may carry an all-false, three-source legacy
    // status. Direct feeds above must be healthy; the new candidate must prove
    // the full four-source, nonempty composed status in its rollback soak.
    assert.ok(data.feed && ['tc', 'gdacs', 'eonet'].every(key => typeof data.feed[key] === 'boolean')
      && (data.feed.usgs === undefined || typeof data.feed.usgs === 'boolean'),
    'legacy composed hazard feed status invalid');
    const age = response.headers.get('x-swr-age');
    assert.ok(age != null && /^\d+$/.test(age) && Number(age) < 86_400,
      'composed hazard feed age missing or expired');
    receipts.push({ path, available: true, count: data.tc.length + data.ev.length, ageSeconds: Number(age) });
  }
  const requests = PATHS.map(([path, key, timeout]) => read(path, key, timeout));
  requests.push(hazards());
  const [cyclones, gdacs] = await Promise.all(requests);
  const geometry = [];
  for (const [feed, rows] of [['tc', cyclones], ['gdacs', gdacs]]) {
    const event = rows.find(({ properties: p }) => p?.Class === 'Point_Centroid'
      && /^\d{1,16}$/.test(String(p.eventid)) && /^\d{1,16}$/.test(String(p.episodeid))
      && (feed === 'tc' || /^(FL|EQ|WF|DR|VO|TS)$/.test(p.eventtype)));
    if (!event) continue;
    const p = event.properties;
    const query = new URLSearchParams({ eventid: String(p.eventid), episodeid: String(p.episodeid) });
    if (feed === 'gdacs') query.set('eventtype', p.eventtype);
    geometry.push(read(`/api/${feed}/geom?${query}`, 'features', 25_000));
  }
  await Promise.all(geometry);
  assert.ok(receipts.some(receipt => PATHS.some(([path]) => path === receipt.path) && receipt.available),
    'all existing direct weather feeds are unavailable');
  return receipts.sort((a, b) => a.path.localeCompare(b.path));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyBaseline(process.argv[2]).then(feeds => console.log(JSON.stringify({ ok: true, phase: 'existing-production-baseline', feeds })))
    .catch(error => { console.error(`production baseline feed verification failed: ${error.message}`); process.exitCode = 1; });
}
