import assert from 'node:assert/strict';
import test from 'node:test';
import { bindingDrift, disabledPreviousConfig, uploadedVersion, validateLiveSelector, validateReleaseConfig }
  from '../tools/platform-wind100-worker-release.mjs';

const config = { env: { production: { name: 'weatherx-platform-edge-production',
  vars: { APP_ORIGIN: 'https://weatherx.org', AUTH_MODE: 'observe', BILLING_MODE: 'enabled',
    BILLING_PURCHASE_MODE: 'closed', PRODUCTION_WIND100_DYNAMIC_ENABLED: '1' },
  routes: [{ pattern: 'weatherx.org/api/platform/production-wind100/*' }] } } };

test('one-time Worker release requires the reviewed production route and closed purchases', () => {
  assert.equal(validateReleaseConfig(config).vars.PRODUCTION_WIND100_DYNAMIC_ENABLED, '1');
  for (const [key, value] of [
    ['PRODUCTION_WIND100_DYNAMIC_ENABLED', '0'],
    ['BILLING_PURCHASE_MODE', 'public'],
    ['BILLING_MODE', 'disabled'],
  ]) {
    const changed = structuredClone(config); changed.env.production.vars[key] = value;
    assert.throws(() => validateReleaseConfig(changed));
  }
  const noRoute = structuredClone(config);
  noRoute.env.production.routes = [];
  assert.throws(() => validateReleaseConfig(noRoute));
});

test('candidate version and live selector are exact and reject unrelated releases', () => {
  const version = '12345678-1234-1234-1234-123456789abc';
  assert.equal(uploadedVersion(`Worker Version ID: ${version}\n`), version);
  assert.throws(() => uploadedVersion('Uploaded without a version receipt'));
  const selector = { schemaVersion: 1, kind: 'production-native-wind100-selector',
    catalogId: 'prod-wind100-recurring-35921335025-1', runId: '2026092312',
    selectionSha256: 'a'.repeat(64) };
  assert.equal(validateLiveSelector(selector), selector);
  assert.throws(() => validateLiveSelector({ ...selector, catalogId: 'another-run' }));
});

test('binding diagnostic names reviewed mismatches without disclosing live values', () => {
  const reviewed = { vars: { APP_ORIGIN: 'https://weatherx.org', AUTH_MODE: 'observe' },
    secrets: { required: ['SESSION_KEY'] } };
  const actual = [
    { name: 'APP_ORIGIN', type: 'plain_text', text: 'https://weatherx.org' },
    { name: 'AUTH_MODE', type: 'plain_text', text: 'private-value' },
    { name: 'SURPRISE_SECRET', type: 'secret_text' },
  ];
  const result = bindingDrift(reviewed, actual);
  assert.deepEqual(result, { missingOrChangedExpectedNames: ['AUTH_MODE', 'SESSION_KEY'], unexpectedCount: 1 });
  assert.ok(!JSON.stringify(result).includes('private-value'));
  assert.ok(!JSON.stringify(result).includes('SURPRISE_SECRET'));
});

test('prior Worker preflight accepts only absent or exact disabled Wind100 flag', () => {
  const flagName = 'PRODUCTION_WIND100_DYNAMIC_ENABLED';
  const current = { vars: { APP_ORIGIN: 'https://weatherx.org', [flagName]: '1' } };
  assert.deepEqual(disabledPreviousConfig(current, []),
    { vars: { APP_ORIGIN: 'https://weatherx.org' } });
  assert.equal(disabledPreviousConfig(current,
    [{ name: flagName, type: 'plain_text', text: '0' }]).vars[flagName], '0');
  for (const binding of [
    { name: flagName, type: 'plain_text', text: '1' },
    { name: flagName, type: 'secret_text' },
  ]) assert.throws(() => disabledPreviousConfig(current, [binding]));
  assert.throws(() => disabledPreviousConfig(current, [
    { name: flagName, type: 'plain_text', text: '0' },
    { name: flagName, type: 'plain_text', text: '0' },
  ]));
});
