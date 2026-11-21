// The production platform Worker's public health contract, shared by every lane that verifies it.
// Atmos 3087a055bb (2026-10-20) added `build: { sourceSha }`: the commit the Worker was deployed from (`SOURCE_SHA`
// var), or null when unstamped. Code-only lanes upload with --keep-vars and add no binding, so their candidates report
// null. `build` is admitted only in that exact shape; every other field must equal HEALTH (key order ignored).
import assert from 'node:assert/strict';

export const HEALTH = Object.freeze({ ok: true, authMode: 'observe', billingMode: 'enabled', billingPurchaseMode: 'closed' });

export function assertHealth(health) {
  assert.ok(health && typeof health === 'object' && !Array.isArray(health), 'production platform health is not an object');
  const { build, ...rest } = health;
  assert.deepStrictEqual(rest, { ...HEALTH }, 'production platform health contract changed');
  if (!Object.hasOwn(health, 'build')) return health;
  assert.ok(build && typeof build === 'object' && !Array.isArray(build)
    && JSON.stringify(Object.keys(build)) === '["sourceSha"]', 'production platform health build field changed');
  assert.ok(build.sourceSha === null || (typeof build.sourceSha === 'string' && /^[a-f0-9]{40}$/.test(build.sourceSha)),
    'production platform health build.sourceSha is not a commit');
  return health;
}
