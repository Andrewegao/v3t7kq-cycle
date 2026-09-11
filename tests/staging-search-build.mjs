import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchInput, sourceURL, INPUTS } from '../tools/staging-search-build.mjs';
test('metadata downloads use one immutable release on the fixed staging origin', async () => {
  assert.deepEqual(INPUTS, {
    airports: 'airports/airports.json', metar: 'stations/metar.json', tides: 'tides/tides.json',
    sondes: 'radiosondes/stations.json', storms: 'footprints/swath_storms.json',
  });
  assert.equal(sourceURL('cycle-123', 'airports'), 'https://staging.weatherx.org/data-atmos/_release/cycle-123/airports/airports.json');
  for (const release of ['../../production', 'a?b', '', '/a']) assert.throws(() => sourceURL(release, 'airports'));
  assert.throws(() => sourceURL('cycle-123', 'weather'));
  const bytes = await fetchInput('cycle-123', 'airports', async (url, init) => {
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.deepEqual(init.headers, { 'Accept-Encoding': 'identity' }); assert.ok(init.signal);
    return new Response('{}', { headers: { 'x-weatherx-release': 'cycle-123', 'content-length': '2' } });
  });
  assert.equal(bytes.toString(), '{}');
});
test('wrong snapshot, redirect, truncation and oversized metadata withhold the build', async () => {
  for (const response of [new Response('{}', { status: 302 }), new Response('{}'),
    new Response('{}', { headers: { 'x-weatherx-release': 'different' } }),
    new Response('{}', { headers: { 'x-weatherx-release': 'cycle-123', 'content-length': '3' } }),
    new Response('{}', { headers: { 'x-weatherx-release': 'cycle-123', 'content-length': String(4 * 1024 * 1024 + 1) } }),
    new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { 'x-weatherx-release': 'cycle-123' } })]) {
    await assert.rejects(fetchInput('cycle-123', 'airports', async () => response));
  }
});
