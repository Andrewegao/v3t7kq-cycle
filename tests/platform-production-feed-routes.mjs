import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRouteBoundary, verifyFeeds, verifyFeedsEventually } from '../tools/platform-production-feed-routes.mjs';

const before = [
  { id: 'a'.repeat(32), pattern: 'weatherx.org/api/platform/health', script: 'weatherx-platform-edge-production' },
  { id: 'b'.repeat(32), pattern: 'weatherx.org/api/platform/production-wind100/*', script: 'weatherx-platform-edge-production' },
];
const owned = [
  { id: 'c'.repeat(32), pattern: 'weatherx.org/api/usgs/*', script: 'weatherx-platform-edge-production' },
  { id: 'd'.repeat(32), pattern: 'weatherx.org/api/hazards', script: 'weatherx-platform-edge-production' },
];

test('only two exact owned routes may be added', () => {
  assert.doesNotThrow(() => assertRouteBoundary(before, [...before, ...owned], owned));
  assert.throws(() => assertRouteBoundary(before, [...before, ...owned, { id: 'e'.repeat(32), pattern: 'weatherx.org/api/billing/*', script: 'other' }], owned));
  assert.throws(() => assertRouteBoundary([...before, owned[0]], [...before, ...owned], [owned[1]]));
  assert.throws(() => assertRouteBoundary(before, [...before, { ...owned[0], script: 'other' }], [owned[0]]));
});

test('live proof requires the scheduled four-feed Worker contract', async () => {
  const responses = [
    Response.json({ ok: true, authMode: 'observe', billingMode: 'enabled', billingPurchaseMode: 'closed' }),
    Response.json({ type: 'FeatureCollection', features: [] }),
    Response.json({ v: 1, tc: [], ev: [], bundles: [], feed: { tc: true, gdacs: false, eonet: false, usgs: false } },
      { headers: { 'x-weatherx-hazards-source': 'scheduled' } }),
  ];
  assert.deepEqual(await verifyFeeds(async () => responses.shift()),
    { status: 'verified', usgsStatus: 200, hazardsSource: 'scheduled' });
  const legacy = [
    Response.json({ ok: true, authMode: 'observe', billingMode: 'enabled', billingPurchaseMode: 'closed' }),
    Response.json({ type: 'FeatureCollection', features: [] }),
    Response.json({ v: 1, tc: [], ev: [], bundles: [], feed: { tc: true, gdacs: false, eonet: false } }),
  ];
  await assert.rejects(verifyFeeds(async () => legacy.shift()));
});

test('live proof waits for both newly attached routes to propagate, but remains bounded', async () => {
  let attempts = 0;
  let sleeps = 0;
  const fetchAfterPropagation = async url => {
    if (url.endsWith('/health')) { attempts++; return Response.json({ ok: true, authMode: 'observe', billingMode: 'enabled', billingPurchaseMode: 'closed' }); }
    if (url.endsWith('/usgs/list')) return attempts < 3
      ? new Response('<html>Pages fallback</html>', { status: 404, headers: { 'content-type': 'text/html' } })
      : Response.json({ type: 'FeatureCollection', features: [] });
    return Response.json({ v: 1, tc: [], ev: [], bundles: [], feed: { tc: true, gdacs: false, eonet: false, usgs: false } },
      { headers: { 'x-weatherx-hazards-source': 'scheduled' } });
  };
  assert.equal((await verifyFeedsEventually(fetchAfterPropagation, async () => { sleeps++; })).status, 'verified');
  assert.equal(attempts, 3);
  assert.equal(sleeps, 2);
  await assert.rejects(verifyFeedsEventually(async () => new Response('<html/>', { status: 404 }),
    async () => {}, 2), /production Platform health failed/);
});
