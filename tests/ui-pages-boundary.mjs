import assert from 'node:assert/strict';
import test from 'node:test';
import { configurationDigest, STAGING_AI_AUTH_POLICY, STAGING_AI_SERVICE,
  stagingEnvVarAllowed, validateProjectSnapshot } from '../tools/ui-release.mjs';

function project(stage = 'staging') {
  return { name: stage === 'staging' ? 'weatherx-platform-staging' : 'atmos-platform', production_branch: 'main', source: null,
    domains: [stage === 'staging' ? 'staging.weatherx.org' : 'weatherx.org'],
    deployment_configs: { production: { compatibility_date: '2026-06-23', compatibility_flags: [], env_vars: {}, d1_databases: {} }, preview: {} },
    canonical_deployment: { latest_stage: { status: 'success' } } };
}
const validate = (p, stage = 'staging') => validateProjectSnapshot(stage, p, configurationDigest(p));
test('direct-upload Pages source may be omitted or null, never another falsy value or Git object', () => {
  for (const stage of ['staging', 'production']) {
    for (const source of [null, undefined]) { const p = project(stage); if (source === undefined) delete p.source; else p.source = source; assert.equal(validate(p, stage), p); }
    for (const source of [{ type: 'github' }, {}, [], false, 0, '', 'github']) { const p = project(stage); p.source = source; assert.throws(() => validate(p, stage)); }
  }
});
test('the real shared production D1 binding blocks staging even if its configuration digest was approved', () => {
  const p = project(); delete p.source;
  for (const context of ['production', 'preview']) p.deployment_configs[context] = {
    env_vars: {}, d1_databases: { WX_ANALYTICS: { id: 'e7247173-c23d-4989-b29e-f95939c820fe' } },
    fail_open: true, always_use_latest_compatibility_date: false, compatibility_date: '2026-06-23', compatibility_flags: [],
    build_image_major_version: 3, usage_model: 'standard',
    wrangler_config_hash: '4565520fc74dd2a7788d723378e2c8bc4677985f6b83b56a341a97bfb7ce8770',
  };
  assert.throws(() => validate(p), /binding|resource/);
  p.deployment_configs.production.d1_databases = {};
  assert.throws(() => validate(p), /preview.d1_databases/);
  p.deployment_configs.preview.d1_databases = {};
  assert.equal(validate(p), p, 'the exact observed metadata is valid only after both shared D1 maps are empty');
});
test('both Pages production and preview reject unapproved backend/secret binding families', () => {
  // Pages API maps are not Wrangler arrays; services and queue_producers are the
  // actual API keys used by Wrangler's Pages download/toEnvironment implementation.
  const fields = ['d1_databases', 'kv_namespaces', 'r2_buckets', 'services', 'service_bindings', 'queue_producers', 'queue_consumers',
    'durable_object_namespaces', 'analytics_engine_datasets', 'ai_bindings', 'hyperdrive_bindings', 'vectorize_bindings',
    'mtls_certificates', 'browsers', 'secret_store_secrets', 'secrets', 'env_vars', 'future_resource_bindings'];
  for (const context of ['production', 'preview']) for (const field of fields) {
    for (const value of [{ RESOURCE: { id: 'must-not-be-reachable' } }, ['resource'], 'resource', false, 0]) {
      const p = project(); p.deployment_configs[context][field] = value;
      assert.throws(() => validate(p), /bindings\/resources must be empty/, `${context}.${field}`);
    }
  }
});
test('unapproved credentials are rejected whether secret_text or disguised as plain_text', () => {
  for (const context of ['production', 'preview']) for (const value of [{ type: 'secret_text' }, { type: 'secret_text', value: 'sensitive-fixture' },
    { type: 'plain_text', value: 'sensitive-fixture' }, { value: 'sensitive-fixture' }]) {
    const p = project(); p.deployment_configs[context].env_vars = { CREDENTIAL: value };
    assert.throws(() => validate(p), error => /env_vars/.test(error.message) && !error.message.includes('sensitive-fixture'));
  }
});
test('empty API maps and supported runtime metadata remain valid without altering their digest', () => {
  const p = project();
  for (const context of ['production', 'preview']) Object.assign(p.deployment_configs[context], {
    d1_databases: {}, kv_namespaces: null, r2_buckets: {}, services: {}, queue_producers: {}, env_vars: {},
    ai_bindings: {}, durable_object_namespaces: {}, analytics_engine_datasets: {},
    compatibility_date: '2026-06-23', compatibility_flags: [], always_use_latest_compatibility_date: false,
    usage_model: 'standard', placement: { mode: 'off' }, limits: { cpu_ms: 10 }, fail_open: false,
    build_image_major_version: 3, wrangler_config_hash: null,
  });
  const before = structuredClone(p), digest = configurationDigest(p); assert.equal(validate(p), p);
  assert.deepEqual(p, before); assert.equal(configurationDigest(p), digest);
  delete p.source; assert.equal(configurationDigest(p), digest); assert.equal(validate(p), p);
});
test('production keeps its existing resource/config policy, public modes and approval digest checks', () => {
  const p = project('production'); p.deployment_configs.production.d1_databases = { WX_ANALYTICS: { id: 'e7247173-c23d-4989-b29e-f95939c820fe' } };
  p.deployment_configs.production.env_vars = { EXISTING: { type: 'secret_text' } };
  assert.equal(validate(p, 'production'), p);
  assert.throws(() => validateProjectSnapshot('production', p, '0'.repeat(64)), /configuration changed/);
  assert.throws(() => validateProjectSnapshot('staging', p, configurationDigest(p)));
});
test('existing exact name/branch/runtime/canonical deployment/config-digest checks still apply', () => {
  for (const change of [p => p.name = 'atmos-platform', p => p.production_branch = 'other',
    p => p.deployment_configs.production.compatibility_date = '2026-01-01',
    p => p.deployment_configs.production.compatibility_flags = ['nodejs_compat'],
    p => p.canonical_deployment.latest_stage.status = 'failure',
    p => p.deployment_configs.production = null, p => p.deployment_configs.extra = {}]) {
    const p = project(); change(p); assert.throws(() => validate(p));
  }
  assert.throws(() => validateProjectSnapshot('unknown', project(), '0'.repeat(64)));
  const p = project(); assert.throws(() => validateProjectSnapshot('staging', p, '0'.repeat(64)), /configuration changed/);
});
test('staging fallback retains its exact noncommercial policy and refuses similarly named keys', () => {
  for (const context of ['production', 'preview']) {
    const p = project(); p.deployment_configs[context].env_vars = { FORECAST_FALLBACK_ACCESS: { type: 'plain_text', value: 'non-commercial' } };
    assert.equal(validate(p), p, context + ' plain_text non-commercial');
    p.deployment_configs[context].env_vars = { FORECAST_FALLBACK_ACCESS: { type: 'secret_text' } };
    assert.equal(validate(p), p, context + ' secret_text by name');
    for (const bad of [{ type: 'plain_text', value: 'customer' }, { type: 'plain_text', value: 'non-commercial', extra: 1 }, { value: 'non-commercial' }, { type: 'json', value: 'non-commercial' }]) {
      p.deployment_configs[context].env_vars = { FORECAST_FALLBACK_ACCESS: bad };
      assert.throws(() => validate(p), /env_vars\.FORECAST_FALLBACK_ACCESS/);
    }
    p.deployment_configs[context].env_vars = { FORECAST_FALLBACK_ACCESS: { type: 'plain_text', value: 'non-commercial' }, FORECAST_FALLBACK_KEY: { type: 'secret_text' } };
    assert.throws(() => validate(p), /env_vars\.FORECAST_FALLBACK_KEY/);
  }
  assert.equal(stagingEnvVarAllowed('FORECAST_FALLBACK_ACCESS', { type: 'plain_text', value: 'non-commercial' }), true);
  assert.equal(stagingEnvVarAllowed('CLOUDFLARE_API_TOKEN', { type: 'secret_text' }), false);
});

const aiProfile = () => ({
  env_vars: {
    AI_API_KEY: { type: 'secret_text' },
    AI_AUTH_POLICY: { type: 'plain_text', value: STAGING_AI_AUTH_POLICY },
  },
  services: { WX_AI_ADMISSION: { ...STAGING_AI_SERVICE } },
});
test('staging AI admits only the complete account-policy profile in its production context', () => {
  const p = project(); Object.assign(p.deployment_configs.production, aiProfile());
  const before = structuredClone(p);
  assert.equal(validate(p), p);
  assert.deepEqual(p, before);
  p.deployment_configs.production.env_vars.FORECAST_FALLBACK_ACCESS = { type: 'plain_text', value: 'non-commercial' };
  assert.equal(validate(p), p);
  assert.throws(() => validateProjectSnapshot('staging', p, configurationDigest(project())), /configuration changed/);
  assert.equal(stagingEnvVarAllowed('AI_API_KEY', { type: 'secret_text' }, 'production'), true);
  assert.equal(stagingEnvVarAllowed('AI_AUTH_POLICY', { type: 'plain_text', value: STAGING_AI_AUTH_POLICY }, 'production'), true);
  for (const name of ['AI_API_KEY', 'AI_AUTH_POLICY']) {
    assert.equal(stagingEnvVarAllowed(name, p.deployment_configs.production.env_vars[name], 'preview'), false);
    for (const entry of [{ type: 'plain_text', value: 'sensitive-fixture' }, { type: 'secret_text', value: {} },
      { type: 'secret_text', extra: 'sensitive-fixture' }, null, [], { value: 'sensitive-fixture' }]) {
      const bad = project(); Object.assign(bad.deployment_configs.production, aiProfile());
      bad.deployment_configs.production.env_vars[name] = entry;
      assert.throws(() => validate(bad), error => /env_vars/.test(error.message) && !error.message.includes('sensitive-fixture'));
    }
  }
});
test('partial AI configuration, preview credentials, legacy codes and extra resources remain refused', () => {
  for (let mask = 1; mask < 7; mask++) {
    const p = project(), profile = aiProfile();
    if (!(mask & 1)) delete profile.env_vars.AI_API_KEY;
    if (!(mask & 2)) delete profile.env_vars.AI_AUTH_POLICY;
    if (!(mask & 4)) delete profile.services.WX_AI_ADMISSION;
    Object.assign(p.deployment_configs.production, profile);
    assert.throws(() => validate(p), /complete staging account AI profile/);
  }
  const preview = project(); Object.assign(preview.deployment_configs.preview, aiProfile());
  assert.throws(() => validate(preview), /preview/);
  for (const name of ['AI_ACCESS_CODE', 'AI_ACCESS_CODE_CENTRAL', 'AI_MODEL', 'AI_API_URL', 'AI_EXTRA_KEY', 'CLOUDFLARE_API_TOKEN', 'STRIPE_SECRET_KEY']) {
    const p = project(); Object.assign(p.deployment_configs.production, aiProfile());
    p.deployment_configs.production.env_vars[name] = { type: 'secret_text' };
    assert.throws(() => validate(p), /env_vars/);
  }
  for (const mutate of [
    p => p.deployment_configs.production.services.WX_AI_ADMISSION.service = 'weatherx-platform-edge-production',
    p => p.deployment_configs.production.services.WX_AI_ADMISSION.environment = 'staging',
    p => p.deployment_configs.production.services.WX_AI_ADMISSION.entrypoint = 'OtherEntrypoint',
    p => { delete p.deployment_configs.production.services.WX_AI_ADMISSION.service; },
    p => { delete p.deployment_configs.production.services.WX_AI_ADMISSION.environment; },
    p => { delete p.deployment_configs.production.services.WX_AI_ADMISSION.entrypoint; },
    p => { p.deployment_configs.production.services.WX_AI_ADMISSION = null; },
    p => { p.deployment_configs.production.services.WX_AI_ADMISSION = []; },
    p => p.deployment_configs.production.services.WX_AI_ADMISSION.extra = 'sensitive-fixture',
    p => { p.deployment_configs.production.services = { OTHER: { ...STAGING_AI_SERVICE } }; },
    p => { p.deployment_configs.production.service_bindings = p.deployment_configs.production.services; delete p.deployment_configs.production.services; },
  ]) {
    const p = project(); Object.assign(p.deployment_configs.production, aiProfile()); mutate(p);
    assert.throws(() => validate(p), error => /service|profile|binding/.test(error.message) && !error.message.includes('sensitive-fixture'));
  }
});
test('production validation remains independent from the staging AI profile policy', () => {
  const p = project('production'); Object.assign(p.deployment_configs.production, aiProfile());
  p.deployment_configs.production.env_vars.AI_ACCESS_CODE = { type: 'secret_text' };
  p.deployment_configs.production.services.EXTRA = { service: 'production-worker', environment: 'production' };
  assert.equal(validate(p, 'production'), p);
});
