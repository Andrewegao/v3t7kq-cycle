import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyBaseline } from '../tools/ui-weather-feed-baseline.mjs';

const feature = { type: 'FeatureCollection', features: [] };
const events = { events: [] };
const hazards = { v: 1, tc: [], ev: [], bundles: [],
  feed: { tc: false, gdacs: false, eonet: false } };
const fixtures = new Map([
  ['/api/tc/list', feature], ['/api/gdacs/list', feature],
  ['/api/eonet/list', events], ['/api/eonet/fallback', events],
  ['/api/hazards', hazards],
]);
const reply = (body, age = '10') => new Response(JSON.stringify(body),
  { status: 200, headers: { 'content-type': 'application/json', 'x-swr-age': age } });

test('legacy production preflight checks existing feeds without pretending USGS exists', async () => {
  const seen = [];
  const result = await verifyBaseline('https://weatherx.org', async url => {
    const path = new URL(url).pathname; seen.push(path);
    assert.ok(fixtures.has(path), `unexpected request ${path}`);
    return reply(fixtures.get(path));
  });
  assert.equal(result.length, 5);
  assert.equal(seen.includes('/api/usgs/list'), false);
  assert.ok(seen.includes('/api/hazards'));
});

test('legacy baseline still rejects stale or malformed existing feeds', async () => {
  await assert.rejects(verifyBaseline('https://weatherx.org', async url => {
    const path = new URL(url).pathname;
    return reply(fixtures.get(path), path === '/api/gdacs/list' ? '86400' : '10');
  }), /expired feed age/);
  await assert.rejects(verifyBaseline('https://weatherx.org', async url => {
    const path = new URL(url).pathname;
    return reply(path === '/api/eonet/list' ? { events: 'bad' } : fixtures.get(path));
  }), /invalid feed contract/);
  await assert.rejects(verifyBaseline('https://staging.weatherx.org', async () => reply(feature)));
});
