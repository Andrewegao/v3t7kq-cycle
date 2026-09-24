import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRouteBoundary, verifyFeeds } from '../tools/platform-production-feed-routes.mjs';

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
