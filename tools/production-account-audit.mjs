#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const STRIPE_API_VERSION = '2026-02-25.clover';
export const PRODUCTION_PLATFORM_D1_ID = 'fe83a5d5-c061-44c4-b5e6-92e6871c7f02';
export const PRODUCTION_PLATFORM_D1_NAME = 'weatherx-platform-production';
export const REQUIRED_ATMOS_SHA = '0edbbe243589849c3d56c98b24e5d8b7ab96c522';

const STRIPE_ORIGIN = 'https://api.stripe.com';
const STRIPE_PAGE_SIZE = 100;
const STRIPE_MAX_PAGES = 10_000;
const STRIPE_MAX_PAGE_BYTES = 2 * 1024 * 1024;
const STRIPE_TIMEOUT_MS = 15_000;
const CLOUDFLARE_ORIGIN = 'https://api.cloudflare.com';
const CLOUDFLARE_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const CLOUDFLARE_TIMEOUT_MS = 60_000;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const API_TOKEN = /^[A-Za-z0-9_-]{20,255}$/;
const ID = /^[A-Za-z0-9_-]{1,255}$/;
const SHA = /^[a-f0-9]{40}$/;
const PRICE = /^price_[A-Za-z0-9_]{1,250}$/;

const PLATFORM_QUERIES = Object.freeze({
  users: `SELECT id, stripe_customer_id FROM users ORDER BY id`,
  subscriptions: `SELECT provider_subscription_id, user_id, provider_customer_id, status, current_period_end FROM subscriptions WHERE provider = 'stripe' ORDER BY provider_subscription_id`,
  entitlements: `SELECT user_id, entitlement_key, status, source, valid_until FROM entitlements WHERE source = 'stripe' ORDER BY user_id, entitlement_key`,
  accessPasses: `SELECT provider_checkout_session_id, provider_payment_intent_id, user_id, provider_customer_id, status, pass_days, amount_total, currency, valid_from, valid_until FROM access_passes WHERE provider = 'stripe' ORDER BY provider_checkout_session_id`,
  accessPassRefunds: `SELECT provider_refund_id, provider_payment_intent_id, amount, status FROM access_pass_refunds WHERE provider = 'stripe' ORDER BY provider_refund_id`,
  checkoutAttempts: `SELECT user_id, kind, provider_checkout_session_id, status, expires_at FROM stripe_checkout_attempts WHERE provider = 'stripe' ORDER BY user_id, kind`,
  webhookReview: `SELECT event_id, event_type, outcome, outcome_reason, received_at, processed_at, review_required_at FROM webhook_events WHERE provider = 'stripe' AND (review_required_at IS NOT NULL OR outcome = 'needs_review') ORDER BY event_id`,
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value), 'noncanonical-value');
  if (typeof value === 'number') assert.ok(Number.isFinite(value), 'non-finite-number');
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function object(value, message) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), message);
  return value;
}

function string(value, message, {nullable = false, pattern = ID} = {}) {
  if (nullable && value === null) return null;
  assert.equal(typeof value, 'string', message);
  assert.match(value, pattern, message);
  return value;
}

function integer(value, message, {nullable = false, min = 0} = {}) {
  if (nullable && value === null) return null;
  assert.ok(Number.isSafeInteger(value) && value >= min, message);
  return value;
}

function stripeObjectId(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.id === 'string') return value.id;
  return null;
}

function metadata(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function nullableStripeId(value) {
  const id = stripeObjectId(value);
  return id === null ? null : string(id, 'invalid-stripe-object-id');
}

function normalizeStripeObject(resource, value) {
  const row = object(value, `stripe-${resource}-not-object`);
  const id = string(row.id, `stripe-${resource}-id-invalid`);
  assert.equal(row.livemode, true, `stripe-${resource}-${id}-not-live`);
  const base = {id, livemode: true};
  if (resource === 'customers') return {...base, weatherxUserId: typeof metadata(row.metadata).weatherx_user_id === 'string' ? metadata(row.metadata).weatherx_user_id : null};
  if (resource === 'subscriptions') {
    const items = object(row.items, `stripe-subscription-${id}-items-invalid`);
    assert.ok(Array.isArray(items.data) && items.has_more === false, `stripe-subscription-${id}-items-incomplete`);
    const priceIds = items.data.map(item => string(nullableStripeId(object(item, 'stripe-subscription-item-invalid').price), 'stripe-subscription-price-invalid', {pattern: PRICE})).sort();
    const itemPeriods = items.data.map(item => object(item, 'stripe-subscription-item-invalid').current_period_end).filter(Number.isSafeInteger);
    const currentPeriodEnd = Number.isSafeInteger(row.current_period_end) ? row.current_period_end : itemPeriods.length ? Math.max(...itemPeriods) : null;
    return {...base, customerId: string(nullableStripeId(row.customer), `stripe-subscription-${id}-customer-invalid`), status: string(row.status, `stripe-subscription-${id}-status-invalid`), currentPeriodEnd: integer(currentPeriodEnd, `stripe-subscription-${id}-period-invalid`, {nullable: true}), weatherxUserId: typeof metadata(row.metadata).weatherx_user_id === 'string' ? metadata(row.metadata).weatherx_user_id : null, priceIds};
  }
  if (resource === 'checkoutSessions') return {...base, customerId: nullableStripeId(row.customer), clientReferenceId: typeof row.client_reference_id === 'string' ? row.client_reference_id : null, weatherxUserId: typeof metadata(row.metadata).weatherx_user_id === 'string' ? metadata(row.metadata).weatherx_user_id : null, accessKind: typeof metadata(row.metadata).weatherx_access_kind === 'string' ? metadata(row.metadata).weatherx_access_kind : null, mode: string(row.mode, `stripe-session-${id}-mode-invalid`), status: string(row.status, `stripe-session-${id}-status-invalid`), paymentStatus: typeof row.payment_status === 'string' ? row.payment_status : null, subscriptionId: nullableStripeId(row.subscription), paymentIntentId: nullableStripeId(row.payment_intent), amountTotal: integer(row.amount_total, `stripe-session-${id}-amount-invalid`, {nullable: true}), currency: typeof row.currency === 'string' ? row.currency : null};
  if (resource === 'refunds') return {...base, chargeId: nullableStripeId(row.charge), paymentIntentId: nullableStripeId(row.payment_intent), amount: integer(row.amount, `stripe-refund-${id}-amount-invalid`), currency: string(row.currency, `stripe-refund-${id}-currency-invalid`, {pattern: /^[a-z]{3}$/}), status: string(row.status, `stripe-refund-${id}-status-invalid`)};
  if (resource === 'disputes') return {...base, chargeId: nullableStripeId(row.charge), paymentIntentId: nullableStripeId(row.payment_intent), amount: integer(row.amount, `stripe-dispute-${id}-amount-invalid`), currency: string(row.currency, `stripe-dispute-${id}-currency-invalid`, {pattern: /^[a-z]{3}$/}), status: string(row.status, `stripe-dispute-${id}-status-invalid`)};
  throw new Error(`unsupported-stripe-resource:${resource}`);
}

function assertUnique(rows, label) {
  const ids = new Set();
  for (const row of rows) {
    assert.ok(!ids.has(row.id), `${label}-duplicate-id:${row.id}`);
    ids.add(row.id);
  }
}

export async function listAllStripe(path, {apiKey, fetcher = fetch, parameters = {}} = {}) {
  assert.match(apiKey ?? '', /^rk_live_[A-Za-z0-9_]+$/, 'stripe-audit-key-must-be-restricted-live');
  assert.match(path, /^(customers|subscriptions|checkout\/sessions|refunds|disputes)$/, 'stripe-list-path-not-allowlisted');
  const rows = [];
  const seen = new Set();
  let startingAfter = null;
  for (let page = 0; page < STRIPE_MAX_PAGES; page++) {
    const url = new URL(`/v1/${path}`, STRIPE_ORIGIN);
    url.searchParams.set('limit', String(STRIPE_PAGE_SIZE));
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, String(value));
    if (startingAfter) url.searchParams.set('starting_after', startingAfter);
    const response = await fetcher(url, {method: 'GET', redirect: 'manual', headers: {authorization: `Bearer ${apiKey}`, accept: 'application/json', 'stripe-version': STRIPE_API_VERSION}, signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS)});
    assert.equal(response.url ? new URL(response.url).origin : STRIPE_ORIGIN, STRIPE_ORIGIN, 'stripe-response-origin-changed');
    assert.ok(response.status >= 200 && response.status < 300, `stripe-list-${path.replace('/', '-')}-http-${response.status}`);
    const declaredLength = Number(response.headers?.get?.('content-length'));
    assert.ok(!Number.isFinite(declaredLength) || declaredLength <= STRIPE_MAX_PAGE_BYTES, 'stripe-page-oversized');
    const raw = await response.text();
    assert.ok(Buffer.byteLength(raw) <= STRIPE_MAX_PAGE_BYTES, 'stripe-page-oversized');
    const body = object(JSON.parse(raw), 'stripe-list-response-invalid');
    assert.equal(body.object, 'list', 'stripe-list-response-not-list');
    assert.equal(typeof body.has_more, 'boolean', 'stripe-list-has-more-invalid');
    assert.ok(Array.isArray(body.data), 'stripe-list-data-invalid');
    for (const item of body.data) {
      const id = string(object(item, 'stripe-list-item-invalid').id, 'stripe-list-item-id-invalid');
      assert.ok(!seen.has(id), `stripe-list-duplicate-id:${id}`);
      seen.add(id); rows.push(item);
    }
    if (!body.has_more) return rows;
    assert.ok(body.data.length > 0, 'stripe-list-empty-continuation');
    const next = string(object(body.data.at(-1), 'stripe-list-cursor-item-invalid').id, 'stripe-list-cursor-invalid');
    assert.notEqual(next, startingAfter, 'stripe-list-cursor-stalled');
    startingAfter = next;
  }
  throw new Error('stripe-list-page-limit-exceeded');
}

export async function collectStripeSnapshot(options = {}) {
  const specifications = [
    ['customers', 'customers', {}],
    ['subscriptions', 'subscriptions', {status: 'all'}],
    ['checkoutSessions', 'checkout/sessions', {}],
    ['refunds', 'refunds', {}],
    ['disputes', 'disputes', {}],
  ];
  const resources = {};
  for (const [name, path, parameters] of specifications) {
    const raw = await listAllStripe(path, {...options, parameters});
    const rows = raw.map(value => normalizeStripeObject(name, value)).sort((a, b) => a.id.localeCompare(b.id));
    assertUnique(rows, `stripe-${name}`);
    resources[name] = rows;
  }
  const snapshot = {schemaVersion: 1, kind: 'weatherx-production-stripe-audit-snapshot-v1', environment: 'live', apiVersion: STRIPE_API_VERSION, complete: true, resources};
  return Object.freeze({...snapshot, snapshotDigest: digest(snapshot)});
}

function parseCloudflareRows(raw, table) {
  const payload = object(JSON.parse(raw), `platform-${table}-response-invalid`);
  assert.equal(payload.success, true, `platform-${table}-request-failed`);
  assert.ok(Array.isArray(payload.errors) && payload.errors.length === 0, `platform-${table}-request-errors`);
  assert.ok(Array.isArray(payload.result) && payload.result.length === 1, `platform-${table}-result-count-invalid`);
  const result = object(payload.result[0], `platform-${table}-result-invalid`);
  assert.equal(result.success, true, `platform-${table}-query-failed`);
  assert.ok(Array.isArray(result.results), `platform-${table}-rows-invalid`);
  if (result.meta !== undefined) {
    const meta = object(result.meta, `platform-${table}-meta-invalid`);
    assert.notEqual(meta.changed_db, true, `platform-${table}-changed-database`);
    assert.ok(meta.changes === undefined || meta.changes === 0, `platform-${table}-reported-changes`);
    assert.ok(meta.rows_written === undefined || meta.rows_written === 0, `platform-${table}-reported-writes`);
  }
  return result.results;
}

function normalizePlatformRow(table, value) {
  const row = object(value, `platform-${table}-row-invalid`);
  const s = (name, nullable = false, pattern = ID) => string(row[name], `platform-${table}-${name}-invalid`, {nullable, pattern});
  const n = (name, nullable = false) => integer(row[name], `platform-${table}-${name}-invalid`, {nullable});
  if (table === 'users') return {id: s('id'), stripeCustomerId: s('stripe_customer_id', true)};
  if (table === 'subscriptions') return {id: s('provider_subscription_id'), userId: s('user_id'), customerId: s('provider_customer_id', true), status: s('status'), currentPeriodEnd: n('current_period_end', true)};
  if (table === 'entitlements') return {id: `${s('user_id')}:${s('entitlement_key')}`, userId: row.user_id, key: row.entitlement_key, status: s('status'), source: s('source'), validUntil: n('valid_until', true)};
  if (table === 'accessPasses') return {id: s('provider_checkout_session_id'), paymentIntentId: s('provider_payment_intent_id', true), userId: s('user_id'), customerId: s('provider_customer_id', true), status: s('status'), passDays: n('pass_days'), amountTotal: n('amount_total'), currency: s('currency'), validFrom: n('valid_from'), validUntil: n('valid_until')};
  if (table === 'accessPassRefunds') return {id: s('provider_refund_id'), paymentIntentId: s('provider_payment_intent_id'), amount: n('amount'), status: s('status')};
  if (table === 'checkoutAttempts') return {id: `${s('user_id')}:${s('kind')}`, userId: row.user_id, kind: row.kind, sessionId: s('provider_checkout_session_id', true), status: s('status'), expiresAt: n('expires_at', true)};
  if (table === 'webhookReview') return {id: s('event_id'), eventType: s('event_type', false, /^[a-z0-9_.]{1,128}$/), outcome: s('outcome', true), outcomeReason: s('outcome_reason', true), receivedAt: n('received_at'), processedAt: n('processed_at', true), reviewRequiredAt: n('review_required_at', true)};
  throw new Error(`unsupported-platform-table:${table}`);
}

export async function collectPlatformSnapshot({accountId, apiToken, fetcher = fetch} = {}) {
  const normalizedAccountId = typeof accountId === 'string' ? accountId.trim() : '';
  const normalizedApiToken = typeof apiToken === 'string' ? apiToken.trim() : '';
  assert.match(normalizedAccountId, ACCOUNT_ID, 'cloudflare-account-id-invalid');
  assert.match(normalizedApiToken, API_TOKEN, 'cloudflare-audit-token-invalid');
  const url = new URL(`/client/v4/accounts/${normalizedAccountId}/d1/database/${PRODUCTION_PLATFORM_D1_ID}/query`, CLOUDFLARE_ORIGIN);
  const tables = {};
  for (const [table, query] of Object.entries(PLATFORM_QUERIES)) {
    assert.match(query, /^SELECT\b/i, `platform-${table}-query-not-read-only`);
    assert.doesNotMatch(query, /;|--|\/\*|\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA|ATTACH|DETACH|VACUUM)\b/i, `platform-${table}-query-unsafe`);
    const response = await fetcher(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {authorization: `Bearer ${normalizedApiToken}`, accept: 'application/json', 'content-type': 'application/json'},
      body: JSON.stringify({sql: query}),
      signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
    });
    assert.equal(response.url ? new URL(response.url).origin : CLOUDFLARE_ORIGIN, CLOUDFLARE_ORIGIN, `platform-${table}-response-origin-changed`);
    assert.ok(response.status >= 200 && response.status < 300, `platform-${table}-http-${response.status}`);
    const declaredLength = Number(response.headers?.get?.('content-length'));
    assert.ok(!Number.isFinite(declaredLength) || declaredLength <= CLOUDFLARE_RESPONSE_MAX_BYTES, `platform-${table}-response-oversized`);
    const raw = await response.text();
    assert.ok(Buffer.byteLength(raw) <= CLOUDFLARE_RESPONSE_MAX_BYTES, `platform-${table}-response-oversized`);
    const rows = parseCloudflareRows(raw, table).map(value => normalizePlatformRow(table, value)).sort((a, b) => a.id.localeCompare(b.id));
    assertUnique(rows, `platform-${table}`);
    tables[table] = rows;
  }
  const snapshot = {schemaVersion: 1, kind: 'weatherx-production-platform-audit-snapshot-v1', databaseId: PRODUCTION_PLATFORM_D1_ID, databaseName: PRODUCTION_PLATFORM_D1_NAME, complete: true, tables};
  return Object.freeze({...snapshot, snapshotDigest: digest(snapshot)});
}

export function validateAtmosProductionConfiguration(value, atmosSha = REQUIRED_ATMOS_SHA) {
  const config = object(value, 'atmos-wrangler-config-invalid');
  assert.match(atmosSha, SHA, 'atmos-sha-invalid');
  assert.equal(atmosSha, REQUIRED_ATMOS_SHA, 'atmos-sha-not-reviewed-candidate');
  assert.equal(config.name, 'weatherx-platform-edge', 'atmos-worker-name-invalid');
  const production = object(object(config.env, 'atmos-environments-invalid').production, 'atmos-production-environment-missing');
  assert.equal(production.name, 'weatherx-platform-edge-production', 'atmos-production-worker-name-invalid');
  const vars = object(production.vars, 'atmos-production-vars-invalid');
  assert.equal(vars.APP_ORIGIN, 'https://weatherx.org', 'atmos-production-origin-invalid');
  assert.equal(vars.AUTH_MODE, 'observe', 'atmos-production-auth-mode-invalid');
  assert.equal(vars.BILLING_MODE, 'enabled', 'atmos-production-billing-mode-invalid');
  assert.equal(vars.BILLING_PURCHASE_MODE, 'closed', 'atmos-production-purchase-mode-invalid');
  assert.equal(vars.STRIPE_ENVIRONMENT, 'live', 'atmos-production-stripe-mode-invalid');
  const subscription = string(vars.STRIPE_PRICE_ID, 'atmos-production-subscription-price-invalid', {pattern: PRICE});
  const pass = string(vars.STRIPE_PASS_PRICE_ID, 'atmos-production-pass-price-invalid', {pattern: PRICE});
  assert.notEqual(subscription, pass, 'atmos-production-prices-must-differ');
  assert.ok(Array.isArray(production.d1_databases), 'atmos-production-d1-invalid');
  const database = production.d1_databases.find(row => row?.binding === 'PLATFORM_DB');
  assert.ok(database, 'atmos-production-platform-d1-missing');
  assert.equal(database.database_id, PRODUCTION_PLATFORM_D1_ID, 'atmos-production-platform-d1-id-invalid');
  assert.equal(database.database_name, PRODUCTION_PLATFORM_D1_NAME, 'atmos-production-platform-d1-name-invalid');
  const result = {schemaVersion: 1, kind: 'weatherx-production-account-audit-candidate-v1', atmosSha, workerName: production.name, databaseId: database.database_id, modes: {auth: vars.AUTH_MODE, billing: vars.BILLING_MODE, purchases: vars.BILLING_PURCHASE_MODE, stripe: vars.STRIPE_ENVIRONMENT}, candidatePriceIds: {subscription, pass}};
  return Object.freeze({...result, candidateDigest: digest(result)});
}

function verifySnapshot(snapshot, kind) {
  const value = object(snapshot, `${kind}-snapshot-invalid`);
  assert.equal(value.schemaVersion, 1, `${kind}-snapshot-version-invalid`);
  assert.equal(value.kind, `weatherx-production-${kind}-audit-snapshot-v1`, `${kind}-snapshot-kind-invalid`);
  assert.equal(value.complete, true, `${kind}-snapshot-incomplete`);
  const supplied = string(value.snapshotDigest, `${kind}-snapshot-digest-invalid`, {pattern: /^[a-f0-9]{64}$/});
  const {snapshotDigest: _ignored, ...unsigned} = value;
  assert.equal(supplied, digest(unsigned), `${kind}-snapshot-digest-mismatch`);
  return value;
}

function reference(type, id) {
  return `${type}:${createHash('sha256').update(`${type}:${id}`).digest('hex').slice(0, 20)}`;
}

function map(rows) {
  return new Map(rows.map(row => [row.id, row]));
}

export function reconcileProductionAccount({stripeSnapshot, platformSnapshot, candidatePriceIds, atmosSha = REQUIRED_ATMOS_SHA} = {}) {
  const stripe = verifySnapshot(stripeSnapshot, 'stripe');
  const platform = verifySnapshot(platformSnapshot, 'platform');
  assert.match(atmosSha, SHA, 'atmos-sha-invalid');
  assert.equal(atmosSha, REQUIRED_ATMOS_SHA, 'atmos-sha-not-reviewed-candidate');
  object(candidatePriceIds, 'candidate-prices-invalid');
  const subscriptionPrice = string(candidatePriceIds.subscription, 'candidate-subscription-price-invalid', {pattern: PRICE});
  const passPrice = string(candidatePriceIds.pass, 'candidate-pass-price-invalid', {pattern: PRICE});
  assert.notEqual(subscriptionPrice, passPrice, 'candidate-prices-must-differ');

  const discrepancies = [];
  const add = (code, type, id) => discrepancies.push({code, reference: reference(type, id)});
  const users = map(platform.tables.users);
  const customers = map(stripe.resources.customers);
  const customerToUser = new Map();
  for (const user of users.values()) if (user.stripeCustomerId) {
    if (customerToUser.has(user.stripeCustomerId)) add('platform-customer-shared-by-users', 'customer', user.stripeCustomerId);
    customerToUser.set(user.stripeCustomerId, user.id);
    const customer = customers.get(user.stripeCustomerId);
    if (!customer) add('platform-customer-missing-in-stripe', 'customer', user.stripeCustomerId);
    else if (customer.weatherxUserId && customer.weatherxUserId !== user.id) add('customer-user-metadata-mismatch', 'customer', user.stripeCustomerId);
  }
  for (const customer of customers.values()) if (customer.weatherxUserId) {
    const user = users.get(customer.weatherxUserId);
    if (!user) add('stripe-weatherx-customer-user-missing', 'customer', customer.id);
    else if (user.stripeCustomerId !== customer.id) add('stripe-weatherx-customer-link-mismatch', 'customer', customer.id);
  }

  const platformSubscriptions = map(platform.tables.subscriptions);
  const stripeSubscriptions = map(stripe.resources.subscriptions);
  for (const subscription of platformSubscriptions.values()) {
    const remote = stripeSubscriptions.get(subscription.id);
    if (!remote) { add('platform-subscription-missing-in-stripe', 'subscription', subscription.id); continue; }
    if (subscription.customerId !== remote.customerId) add('subscription-customer-mismatch', 'subscription', subscription.id);
    if (subscription.status !== remote.status) add('subscription-status-mismatch', 'subscription', subscription.id);
    if (subscription.currentPeriodEnd !== remote.currentPeriodEnd) add('subscription-period-mismatch', 'subscription', subscription.id);
    const expectedUser = remote.weatherxUserId ?? customerToUser.get(remote.customerId) ?? null;
    if (expectedUser && expectedUser !== subscription.userId) add('subscription-user-mismatch', 'subscription', subscription.id);
  }
  for (const subscription of stripeSubscriptions.values()) {
    const userId = subscription.weatherxUserId ?? customerToUser.get(subscription.customerId) ?? null;
    if (!userId) continue;
    if (!platformSubscriptions.has(subscription.id)) add('stripe-weatherx-subscription-missing-in-platform', 'subscription', subscription.id);
    if (!['canceled', 'incomplete_expired'].includes(subscription.status) && !subscription.priceIds.includes(subscriptionPrice)) add('active-subscription-candidate-price-mismatch', 'subscription', subscription.id);
  }

  const sessions = map(stripe.resources.checkoutSessions);
  const attemptsBySession = new Map(platform.tables.checkoutAttempts.filter(row => row.sessionId).map(row => [row.sessionId, row]));
  for (const attempt of platform.tables.checkoutAttempts) if (attempt.sessionId) {
    const session = sessions.get(attempt.sessionId);
    if (!session) add('checkout-attempt-session-missing-in-stripe', 'session', attempt.sessionId);
    else {
      if (session.clientReferenceId && session.clientReferenceId !== attempt.userId) add('checkout-session-user-mismatch', 'session', session.id);
      if (attempt.kind === 'subscription' && session.mode !== 'subscription') add('checkout-session-mode-mismatch', 'session', session.id);
      if (attempt.kind === 'pass' && (session.mode !== 'payment' || (session.accessKind && session.accessKind !== 'one_time_pass'))) add('checkout-session-mode-mismatch', 'session', session.id);
      if (attempt.status === 'open' && session.status !== 'open') add('checkout-open-state-mismatch', 'session', session.id);
    }
  }
  for (const session of sessions.values()) {
    const userId = session.weatherxUserId ?? session.clientReferenceId ?? (session.customerId ? customerToUser.get(session.customerId) : null);
    if (userId && session.status === 'open' && !attemptsBySession.has(session.id)) add('stripe-open-weatherx-session-missing-attempt', 'session', session.id);
  }

  const passes = map(platform.tables.accessPasses);
  const passPaymentIntents = new Map();
  for (const pass of passes.values()) {
    const session = sessions.get(pass.id);
    if (!session) add('access-pass-session-missing-in-stripe', 'session', pass.id);
    else {
      if (session.mode !== 'payment' || session.accessKind !== 'one_time_pass') add('access-pass-session-kind-mismatch', 'session', pass.id);
      if (session.paymentIntentId !== pass.paymentIntentId) add('access-pass-payment-intent-mismatch', 'session', pass.id);
      if (session.amountTotal !== pass.amountTotal || session.currency !== pass.currency) add('access-pass-amount-mismatch', 'session', pass.id);
      if (session.customerId !== pass.customerId) add('access-pass-customer-mismatch', 'session', pass.id);
    }
    if (pass.paymentIntentId) passPaymentIntents.set(pass.paymentIntentId, pass);
  }

  const platformRefunds = map(platform.tables.accessPassRefunds);
  const stripeRefunds = map(stripe.resources.refunds);
  for (const refund of platformRefunds.values()) {
    const remote = stripeRefunds.get(refund.id);
    if (!remote) add('platform-pass-refund-missing-in-stripe', 'refund', refund.id);
    else if (remote.paymentIntentId !== refund.paymentIntentId || remote.amount !== refund.amount || remote.status !== refund.status) add('pass-refund-state-mismatch', 'refund', refund.id);
  }
  for (const refund of stripeRefunds.values()) if (refund.paymentIntentId && passPaymentIntents.has(refund.paymentIntentId) && !platformRefunds.has(refund.id)) add('stripe-pass-refund-missing-in-platform', 'refund', refund.id);

  const entitlements = new Map(platform.tables.entitlements.map(row => [`${row.userId}:${row.key}`, row]));
  for (const user of users.values()) {
    const subscriptionActive = platform.tables.subscriptions.some(row => row.userId === user.id && ['active', 'trialing'].includes(row.status));
    const activePasses = platform.tables.accessPasses.filter(row => row.userId === user.id && row.status === 'active');
    const entitlement = entitlements.get(`${user.id}:weather_data`);
    if ((subscriptionActive || activePasses.length) && entitlement?.status !== 'active') add('weather-data-entitlement-missing-or-inactive', 'user', user.id);
    if (!subscriptionActive && !activePasses.length && entitlement?.status === 'active' && entitlement.validUntil === null) add('weather-data-entitlement-unbounded-without-source', 'user', user.id);
    if (!subscriptionActive && activePasses.length && entitlement?.status === 'active') {
      const expectedUntil = Math.max(...activePasses.map(row => row.validUntil));
      if (entitlement.validUntil !== expectedUntil) add('weather-data-entitlement-expiry-mismatch', 'user', user.id);
    }
  }

  for (const dispute of stripe.resources.disputes) add('stripe-dispute-requires-review', 'dispute', dispute.id);
  for (const review of platform.tables.webhookReview) add('platform-webhook-review-required', 'event', review.id);

  discrepancies.sort((a, b) => a.code.localeCompare(b.code) || a.reference.localeCompare(b.reference));
  const counts = {
    stripeCustomers: stripe.resources.customers.length,
    stripeSubscriptions: stripe.resources.subscriptions.length,
    stripeCheckoutSessions: stripe.resources.checkoutSessions.length,
    stripeRefunds: stripe.resources.refunds.length,
    stripeDisputes: stripe.resources.disputes.length,
    platformUsers: platform.tables.users.length,
    platformSubscriptions: platform.tables.subscriptions.length,
    platformAccessPasses: platform.tables.accessPasses.length,
    platformCheckoutAttempts: platform.tables.checkoutAttempts.length,
    platformWebhookReviews: platform.tables.webhookReview.length,
  };
  const receipt = {schemaVersion: 1, kind: 'weatherx-production-account-audit-receipt-v1', readOnly: true, complete: true, atmosSha, stripeSnapshotDigest: stripe.snapshotDigest, platformSnapshotDigest: platform.snapshotDigest, candidatePriceDigests: {subscription: reference('price', subscriptionPrice), pass: reference('price', passPrice)}, counts, discrepancyCount: discrepancies.length, discrepancies, verdict: discrepancies.length ? 'blocked' : 'clear'};
  return Object.freeze({...receipt, receiptDigest: digest(receipt)});
}

function argumentsMap(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert.match(argv[index] ?? '', /^--[a-z-]+$/, 'invalid-option');
    assert.ok(argv[index + 1] && !argv[index + 1].startsWith('--'), `missing-option-value:${argv[index]}`);
    result[argv[index].slice(2)] = argv[index + 1];
  }
  return result;
}

async function json(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

async function output(path, value) {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
}

async function main(argv) {
  const [command, ...rest] = argv;
  const options = argumentsMap(rest);
  if (command === 'collect-stripe') {
    assert.deepEqual(Object.keys(options).sort(), ['output'], 'collect-stripe-options-invalid');
    return output(options.output, await collectStripeSnapshot({apiKey: process.env.STRIPE_PRODUCTION_AUDIT_KEY}));
  }
  if (command === 'collect-platform') {
    assert.deepEqual(Object.keys(options).sort(), ['output'], 'collect-platform-options-invalid');
    return output(options.output, await collectPlatformSnapshot({accountId: process.env.CLOUDFLARE_ACCOUNT_ID, apiToken: process.env.CLOUDFLARE_API_TOKEN}));
  }
  if (command === 'inspect-config') {
    assert.deepEqual(Object.keys(options).sort(), ['atmos-sha', 'config', 'output'], 'inspect-config-options-invalid');
    return output(options.output, validateAtmosProductionConfiguration(await json(options.config), options['atmos-sha']));
  }
  if (command === 'reconcile') {
    assert.deepEqual(Object.keys(options).sort(), ['atmos-sha', 'output', 'pass-price', 'platform', 'stripe', 'subscription-price'], 'reconcile-options-invalid');
    const receipt = reconcileProductionAccount({stripeSnapshot: await json(options.stripe), platformSnapshot: await json(options.platform), candidatePriceIds: {subscription: options['subscription-price'], pass: options['pass-price']}, atmosSha: options['atmos-sha']});
    await output(options.output, receipt);
    if (receipt.verdict !== 'clear') process.exitCode = 2;
    return;
  }
  throw new Error('usage: production-account-audit.mjs collect-stripe|collect-platform|reconcile [options]');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
