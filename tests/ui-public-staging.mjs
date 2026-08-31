import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePublicModes } from '../tools/ui-release.mjs';
test('staging requires public/cacheable weather with billing off', () => {
  const data = { ok: true, authMode: 'public', catalogMode: 'serve' };
  validatePublicModes('https://staging.weatherx.org', { ok: true, authMode: 'public', billingMode: 'disabled' }, data);
  for (const authMode of ['observe', 'enforce']) assert.throws(() =>
    validatePublicModes('https://staging.weatherx.org', { ok: true, authMode, billingMode: 'disabled' }, data));
  assert.throws(() => validatePublicModes('https://staging.weatherx.org',
    { ok: true, authMode: 'public', billingMode: 'enabled' }, data));
});
test('production retains its exact previous observe/billing-disabled contract', () => {
  const data = { ok: true, authMode: 'public', catalogMode: 'serve' };
  validatePublicModes('https://weatherx.org', { ok: true, authMode: 'observe', billingMode: 'disabled' }, data);
  assert.throws(() => validatePublicModes('https://weatherx.org', { ok: true, authMode: 'public', billingMode: 'disabled' }, data));
  assert.throws(() => validatePublicModes('https://evil.example', { ok: true, authMode: 'public', billingMode: 'disabled' }, data));
});
