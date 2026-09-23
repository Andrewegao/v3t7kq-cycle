import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAbsent, assertOwned } from '../tools/platform-wind100-route.mjs';

const health = { id: 'a'.repeat(32), pattern: 'weatherx.org/api/platform/health',
  script: 'weatherx-platform-edge-production' };
const owned = { id: 'b'.repeat(32),
  pattern: 'weatherx.org/api/platform/production-wind100/*',
  script: 'weatherx-platform-edge-production' };

test('Wind100 route must be new and existing production platform route intact', () => {
  assert.doesNotThrow(() => assertAbsent([health]));
  assert.throws(() => assertAbsent([health, owned]));
  assert.throws(() => assertAbsent([]));
  assert.throws(() => assertAbsent([{ ...health, script: 'another-worker' }]));
});

test('only an owned route may be added without changing the boundary', () => {
  assert.doesNotThrow(() => assertOwned([health], [owned, health], owned));
  assert.throws(() => assertOwned([health], [health, { ...owned, script: 'another-worker' }], owned));
  assert.throws(() => assertOwned([health], [owned], owned));
  assert.throws(() => assertOwned([health], [health, owned, { ...health, id: 'c'.repeat(32) }], owned));
  assert.throws(() => assertOwned([health, owned], [health, owned], owned));
});
