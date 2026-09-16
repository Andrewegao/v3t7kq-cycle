// Provisional Lane B handoff consumed by the Cycle release-safety lane.
//
// This file is deliberately the only place where the controller assumes the shape of
// the not-yet-frozen Atmos account/billing contract. A production command MUST refuse
// this contract while status is provisional. Lane B replaces the fixture, supplies an
// actual reviewed controller SHA, and changes the digest before any live rehearsal.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export const PRODUCTION_ACCOUNT_REQUEST = 'production-account-billing-v1';
export const PRODUCTION_ACCOUNT_APPROVAL = 'production-account-billing-v1';
export const PROVISIONAL_CONTROLLER_SHA = '0000000000000000000000000000000000000000';
export const PRODUCTION_ANALYTICS_D1_ID = 'e7247173-c23d-4989-b29e-f95939c820fe';
export const STAGING_PLATFORM_D1_ID = '9501827a-7e4c-4249-806b-d45d5857d9e5';

const ROUTES = Object.freeze([
  'weatherx.org/api/platform/health',
  'weatherx.org/api/platform/aircraft-world',
  'weatherx.org/api/platform/auth/*',
  'weatherx.org/api/platform/billing/*',
  'weatherx.org/api/platform/saved-*',
  'weatherx.org/api/v1/*',
  'weatherx.org/cdn/*',
  'weatherx.org/api/tc/*',
  'weatherx.org/api/gdacs/*',
  'weatherx.org/api/eonet/*',
]);

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value), 'contract contains a noncanonical value');
  if (typeof value === 'number') assert.ok(Number.isFinite(value), 'contract contains a non-finite number');
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export const LANE_B_CONTRACT = deepFreeze({
  schemaVersion: 1,
  contractVersion: 'lane-b-account-contract-v0-provisional',
  status: 'provisional',
  blockingReason: 'Lane B must replace this fixture and provide its reviewed final digest before live use.',
  requiredAtmosControllerSha: PROVISIONAL_CONTROLLER_SHA,
  target: {
    cloudflareAccountId: 'a89f9a1af485021fbc60a68b163c7c6e',
    workerName: 'weatherx-platform-edge-production',
    pagesProject: 'atmos-platform',
    origin: 'https://weatherx.org',
    databaseName: 'weatherx-platform-production',
    routes: ROUTES,
  },
  modes: {
    authMode: 'observe',
    billingMode: 'enabled',
    billingPurchaseMode: 'closed',
    dataAuthMode: 'public',
    stripeEnvironment: 'live',
  },
  // Owner approval has not selected live offers. These exact values cannot be
  // valid Stripe Price IDs and keep even mocked plans visibly non-deployable.
  approvedStripePriceIds: {
    subscription: 'UNUSABLE_PROVISIONAL_OWNER_APPROVAL_REQUIRED_SUBSCRIPTION',
    pass: 'UNUSABLE_PROVISIONAL_OWNER_APPROVAL_REQUIRED_PASS',
  },
  pagesBindings: {
    production: {
      env_vars: {
        AI_ACCESS_CODE: {type: 'secret_text'},
        AI_ACCESS_CODE_CENTRAL: {type: 'secret_text'},
        AI_API_KEY: {type: 'secret_text'},
        FORECAST_FALLBACK_ACCESS: {type: 'secret_text'},
      },
      d1_databases: {WX_ANALYTICS: {id: PRODUCTION_ANALYTICS_D1_ID}},
      services: {},
    },
    preview: {
      env_vars: {},
      d1_databases: {WX_ANALYTICS: {id: PRODUCTION_ANALYTICS_D1_ID}},
      services: {},
    },
  },
  // These are the currently reviewed staging/test Price identifiers. Their
  // appearance anywhere in a production plan or Pages payload is an immediate refusal.
  forbiddenStripePriceIds: [
    'price_1U6XNWPKEj1zQ5ScUsQsdCgp',
    'price_1U6et6PKEj1zQ5Sco1gMbGLe',
  ],
  provisionalBuildReceipt: {
    product: 'lab',
    platformAccount: '1',
    platformDataAuth: 'public',
    accountRelease: 'production-account-billing-v1',
  },
});

export const LANE_B_CONTRACT_DIGEST = createHash('sha256')
  .update(canonical(LANE_B_CONTRACT))
  .digest('hex');

export function assertLaneBContractReady({allowProvisional = false} = {}) {
  assert.match(LANE_B_CONTRACT_DIGEST, /^[a-f0-9]{64}$/);
  if (LANE_B_CONTRACT.status !== 'final') {
    assert.equal(allowProvisional, true,
      `Lane B contract remains provisional (${LANE_B_CONTRACT_DIGEST}); live release use is blocked`);
    assert.equal(LANE_B_CONTRACT.status, 'provisional');
    assert.equal(LANE_B_CONTRACT.requiredAtmosControllerSha, PROVISIONAL_CONTROLLER_SHA);
  }
  return LANE_B_CONTRACT;
}

function strings(value, path = '$', rows = []) {
  if (typeof value === 'string') rows.push({path, value});
  else if (Array.isArray(value)) value.forEach((item, index) => strings(item, `${path}[${index}]`, rows));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) strings(item, `${path}.${key}`, rows);
  }
  return rows;
}

export function assertProductionIdentifiers(value) {
  for (const {path, value: text} of strings(value)) {
    const lower = text.toLowerCase();
    assert.doesNotMatch(lower, /(?:^|[._:/-])staging(?:$|[._:/-])/, `staging identifier is forbidden in production at ${path}`);
    assert.doesNotMatch(lower, /(?:^|[._:/-])(?:stripe[-_])?test(?:$|[._:/-])|(?:sk|pk)_test_/, `test Stripe identifier is forbidden in production at ${path}`);
    assert.ok(!LANE_B_CONTRACT.forbiddenStripePriceIds.includes(text), `known staging Stripe Price is forbidden in production at ${path}`);
  }
  return value;
}

export function validateProductionPagesConfiguration(payload) {
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload), 'Pages configuration payload is required');
  assertProductionIdentifiers(payload);
  assert.ok(payload.deployment_configs && typeof payload.deployment_configs === 'object'
    && !Array.isArray(payload.deployment_configs), 'Pages deployment configurations are required');
  assert.deepEqual(Object.keys(payload.deployment_configs).sort(), ['preview','production'],
    'production and preview Pages contexts are both required');
  const runtimeFields = new Set(['compatibility_date','compatibility_flags','always_use_latest_compatibility_date',
    'usage_model','placement','limits','fail_open','build_image_major_version','wrangler_config_hash']);
  const resourceFields = new Set(['d1_databases','kv_namespaces','r2_buckets','services','service_bindings',
    'queue_producers','queue_consumers','durable_object_namespaces','analytics_engine_datasets','ai_bindings',
    'hyperdrive_bindings','vectorize_bindings','mtls_certificates','browsers','secret_store_secrets','secrets',
    'env_vars','future_resource_bindings']);
  for (const context of ['production','preview']) {
    const config = payload.deployment_configs[context];
    assert.ok(config && typeof config === 'object' && !Array.isArray(config), `Pages ${context} configuration is required`);
    assert.equal(config.compatibility_date, '2026-06-23', `Pages ${context} compatibility date changed`);
    assert.deepEqual(config.compatibility_flags ?? [], [], `Pages ${context} compatibility flags changed`);
    const expected = LANE_B_CONTRACT.pagesBindings[context];
    const envVars = config.env_vars ?? {};
    assert.ok(envVars && typeof envVars === 'object' && !Array.isArray(envVars), `Pages ${context} env_vars are invalid`);
    assert.deepEqual(Object.keys(envVars).sort(), Object.keys(expected.env_vars).sort(),
      `Pages ${context} env_var names differ from the exact production allowlist`);
    for (const [name, approved] of Object.entries(expected.env_vars)) {
      const entry = envVars[name];
      assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), `Pages ${context}.env_vars.${name} is invalid`);
      assert.deepEqual(Object.keys(entry).sort(), ['type'], `Pages ${context}.env_vars.${name} may contain only its protected type reference`);
      assert.equal(entry.type, approved.type, `Pages ${context}.env_vars.${name} type changed`);
    }
    const databases = config.d1_databases ?? {};
    assert.ok(databases && typeof databases === 'object' && !Array.isArray(databases), `Pages ${context} D1 bindings are invalid`);
    assert.deepEqual(Object.keys(databases).sort(), Object.keys(expected.d1_databases).sort(),
      `Pages ${context} D1 binding names differ from the exact production allowlist`);
    for (const [name, approved] of Object.entries(expected.d1_databases)) {
      const entry = databases[name];
      assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), `Pages ${context}.d1_databases.${name} is invalid`);
      assert.deepEqual(Object.keys(entry).sort(), ['id'], `Pages ${context}.d1_databases.${name} shape changed`);
      assert.equal(entry.id, approved.id, `Pages ${context}.d1_databases.${name} identity changed`);
    }
    assert.deepEqual(config.services ?? {}, expected.services,
      `Pages ${context} service binding names differ from the exact production allowlist`);
    for (const [field, value] of Object.entries(config)) {
      assert.ok(runtimeFields.has(field) || resourceFields.has(field), `Pages ${context}.${field} is not allowlisted`);
      if (!['env_vars','d1_databases','services'].includes(field) && resourceFields.has(field)) {
        assert.ok(value == null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0),
          `Pages ${context}.${field} bindings/resources must be empty`);
      }
    }
  }
  assert.ok(!productionContractCanonical(payload).includes(STAGING_PLATFORM_D1_ID),
    'staging D1 identity is forbidden in production Pages configuration');
  return payload;
}

export function productionContractCanonical(value) {
  return canonical(value);
}
