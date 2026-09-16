import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {
  PRODUCTION_PLATFORM_D1_ID,
  REQUIRED_ATMOS_SHA,
  STRIPE_API_VERSION,
  collectPlatformSnapshot,
  collectStripeSnapshot,
  listAllStripe,
  reconcileProductionAccount,
  validateAtmosProductionConfiguration,
} from '../tools/production-account-audit.mjs';

const SUBSCRIPTION_PRICE = 'price_live_subscription_1';
const PASS_PRICE = 'price_live_pass_1';
const USER = 'weatherx_user_1';
const CUSTOMER = 'cus_weatherx_1';
const PERIOD = 1_800_000_000;

function stripeFixture(overrides = {}) {
  return {
    customers: [{id: CUSTOMER, object: 'customer', livemode: true, metadata: {weatherx_user_id: USER}}],
    subscriptions: [{id: 'sub_weatherx_1', object: 'subscription', livemode: true, customer: CUSTOMER, status: 'active', metadata: {weatherx_user_id: USER}, items: {object: 'list', has_more: false, data: [{id: 'si_weatherx_1', current_period_end: PERIOD, price: {id: SUBSCRIPTION_PRICE}}]}}],
    'checkout/sessions': [{id: 'cs_live_pass_1', object: 'checkout.session', livemode: true, customer: CUSTOMER, client_reference_id: USER, metadata: {weatherx_user_id: USER, weatherx_access_kind: 'one_time_pass'}, mode: 'payment', status: 'complete', payment_status: 'paid', subscription: null, payment_intent: 'pi_live_pass_1', amount_total: 2500, currency: 'usd'}],
    refunds: [],
    disputes: [],
    ...overrides,
  };
}

function stripeFetch(resources, calls = []) {
  return async (url, init) => {
    calls.push({url: String(url), init});
    const path = new URL(url).pathname.replace(/^\/v1\//, '');
    const data = resources[path] ?? [];
    return new Response(JSON.stringify({object: 'list', data, has_more: false}), {status: 200, headers: {'content-type': 'application/json'}});
  };
}

function platformFixture(overrides = {}) {
  return {
    users: [{id: USER, stripe_customer_id: CUSTOMER}],
    subscriptions: [{provider_subscription_id: 'sub_weatherx_1', user_id: USER, provider_customer_id: CUSTOMER, status: 'active', current_period_end: PERIOD}],
    entitlements: [{user_id: USER, entitlement_key: 'weather_data', status: 'active', source: 'stripe', valid_until: null}],
    accessPasses: [{provider_checkout_session_id: 'cs_live_pass_1', provider_payment_intent_id: 'pi_live_pass_1', user_id: USER, provider_customer_id: CUSTOMER, status: 'active', pass_days: 30, amount_total: 2500, currency: 'usd', valid_from: 1_700_000_000, valid_until: 1_702_592_000}],
    accessPassRefunds: [],
    checkoutAttempts: [{user_id: USER, kind: 'pass', provider_checkout_session_id: 'cs_live_pass_1', status: 'completed', expires_at: 1_700_001_000}],
    webhookReview: [],
    ...overrides,
  };
}

function platformRunner(rows, calls = []) {
  return async (command, args, options) => {
    calls.push({command, args, options});
    const query = args.at(-1);
    const table = query.includes('FROM users') ? 'users'
      : query.includes('FROM subscriptions') ? 'subscriptions'
      : query.includes('FROM entitlements') ? 'entitlements'
      : query.includes('FROM access_passes ') ? 'accessPasses'
      : query.includes('FROM access_pass_refunds') ? 'accessPassRefunds'
      : query.includes('FROM stripe_checkout_attempts') ? 'checkoutAttempts'
      : query.includes('FROM webhook_events') ? 'webhookReview' : null;
    assert.ok(table, query);
    return {stdout: JSON.stringify([{success: true, results: rows[table]}]), stderr: ''};
  };
}

async function snapshots({stripe = stripeFixture(), platform = platformFixture()} = {}) {
  return {
    stripeSnapshot: await collectStripeSnapshot({apiKey: 'rk_live_fixture_key', fetcher: stripeFetch(stripe)}),
    platformSnapshot: await collectPlatformSnapshot({wranglerPath: '/repo/node_modules/wrangler/bin/wrangler.js', configPath: '/repo/wrangler.jsonc', cwd: '/repo', runner: platformRunner(platform)}),
  };
}

test('Stripe collection paginates exhaustively with a restricted live key and pinned API version', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({url: String(url), init});
    const cursor = new URL(url).searchParams.get('starting_after');
    const data = cursor ? [{id: 'cus_2'}] : [{id: 'cus_1'}];
    return new Response(JSON.stringify({object: 'list', data, has_more: !cursor}), {status: 200});
  };
  assert.deepEqual((await listAllStripe('customers', {apiKey: 'rk_live_read_only', fetcher})).map(row => row.id), ['cus_1', 'cus_2']);
  assert.equal(new URL(calls[0].url).searchParams.get('limit'), '100');
  assert.equal(new URL(calls[1].url).searchParams.get('starting_after'), 'cus_1');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers['stripe-version'], STRIPE_API_VERSION);
  assert.match(calls[0].init.headers.authorization, /^Bearer rk_live_/);
  await assert.rejects(() => listAllStripe('customers', {apiKey: 'sk_live_broad_key', fetcher}), /must-be-restricted-live/);
  await assert.rejects(() => listAllStripe('charges', {apiKey: 'rk_live_read_only', fetcher}), /not-allowlisted/);
});

test('platform collection executes only fixed SELECT statements against the exact production database', async () => {
  const calls = [];
  const snapshot = await collectPlatformSnapshot({wranglerPath: '/repo/node_modules/wrangler/bin/wrangler.js', configPath: '/repo/wrangler.jsonc', cwd: '/repo', runner: platformRunner(platformFixture(), calls)});
  assert.equal(snapshot.databaseId, PRODUCTION_PLATFORM_D1_ID);
  assert.equal(calls.length, 7);
  for (const call of calls) {
    assert.equal(call.args[0], 'd1');
    assert.equal(call.args[1], 'execute');
    assert.equal(call.args[2], PRODUCTION_PLATFORM_D1_ID);
    assert.ok(call.args.includes('--remote'));
    assert.ok(call.args.includes('production'));
    assert.match(call.args.at(-1), /^SELECT\b/);
    assert.doesNotMatch(call.args.at(-1), /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i);
    assert.deepEqual(Object.keys(call.options.env).sort(), Object.keys(call.options.env).filter(name => ['PATH', 'HOME', 'CI', 'NO_COLOR', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'].includes(name)).sort());
    assert.equal(call.options.env.STRIPE_PRODUCTION_AUDIT_KEY, undefined);
  }
  assert.doesNotMatch(JSON.stringify(snapshot), /email|checkout_url|idempotency/i);
});

test('a complete matching live Stripe and platform inventory produces a clear deterministic receipt', async () => {
  const input = await snapshots();
  const first = reconcileProductionAccount({...input, candidatePriceIds: {subscription: SUBSCRIPTION_PRICE, pass: PASS_PRICE}});
  const second = reconcileProductionAccount({...input, candidatePriceIds: {subscription: SUBSCRIPTION_PRICE, pass: PASS_PRICE}});
  assert.deepEqual(first, second);
  assert.equal(first.verdict, 'clear');
  assert.equal(first.discrepancyCount, 0);
  assert.equal(first.readOnly, true);
  assert.equal(first.complete, true);
  assert.equal(first.atmosSha, REQUIRED_ATMOS_SHA);
  assert.match(first.receiptDigest, /^[a-f0-9]{64}$/);
});

test('disputes, missing open attempts, webhook review, refunds and entitlement drift block with redacted references', async () => {
  const stripe = stripeFixture({
    'checkout/sessions': [...stripeFixture()['checkout/sessions'], {id: 'cs_live_open_secret', object: 'checkout.session', livemode: true, customer: CUSTOMER, client_reference_id: USER, metadata: {}, mode: 'subscription', status: 'open', payment_status: 'unpaid', subscription: null, payment_intent: null, amount_total: null, currency: null}],
    refunds: [{id: 're_live_secret', object: 'refund', livemode: true, charge: 'ch_live_1', payment_intent: 'pi_live_pass_1', amount: 2500, currency: 'usd', status: 'succeeded'}],
    disputes: [{id: 'dp_live_secret', object: 'dispute', livemode: true, charge: 'ch_live_1', payment_intent: 'pi_live_pass_1', amount: 2500, currency: 'usd', status: 'needs_response'}],
  });
  const platform = platformFixture({
    entitlements: [{user_id: USER, entitlement_key: 'weather_data', status: 'inactive', source: 'stripe', valid_until: null}],
    webhookReview: [{event_id: 'evt_live_secret', event_type: 'charge.dispute.created', outcome: 'needs_review', outcome_reason: 'unhandled_financial_event', received_at: 1_700_000_000, processed_at: null, review_required_at: 1_700_000_001}],
  });
  const receipt = reconcileProductionAccount({...await snapshots({stripe, platform}), candidatePriceIds: {subscription: SUBSCRIPTION_PRICE, pass: PASS_PRICE}});
  assert.equal(receipt.verdict, 'blocked');
  const codes = receipt.discrepancies.map(row => row.code);
  for (const code of ['stripe-open-weatherx-session-missing-attempt', 'stripe-pass-refund-missing-in-platform', 'stripe-dispute-requires-review', 'platform-webhook-review-required', 'weather-data-entitlement-missing-or-inactive']) assert.ok(codes.includes(code), code);
  const serialized = JSON.stringify(receipt);
  for (const secret of ['cs_live_open_secret', 're_live_secret', 'dp_live_secret', 'evt_live_secret', USER, CUSTOMER]) assert.ok(!serialized.includes(secret), secret);
  assert.ok(receipt.discrepancies.every(row => /^[a-z-]+:[a-f0-9]{20}$/.test(row.reference)));
});

test('candidate configuration inspection binds exact source, live modes and production D1 without declaring price approval', () => {
  const config = {name: 'weatherx-platform-edge', env: {production: {name: 'weatherx-platform-edge-production', vars: {APP_ORIGIN: 'https://weatherx.org', AUTH_MODE: 'observe', BILLING_MODE: 'enabled', BILLING_PURCHASE_MODE: 'closed', STRIPE_ENVIRONMENT: 'live', STRIPE_PRICE_ID: SUBSCRIPTION_PRICE, STRIPE_PASS_PRICE_ID: PASS_PRICE}, d1_databases: [{binding: 'PLATFORM_DB', database_name: 'weatherx-platform-production', database_id: PRODUCTION_PLATFORM_D1_ID}]}}};
  const candidate = validateAtmosProductionConfiguration(config);
  assert.deepEqual(candidate.modes, {auth: 'observe', billing: 'enabled', purchases: 'closed', stripe: 'live'});
  assert.equal(candidate.candidatePriceIds.subscription, SUBSCRIPTION_PRICE);
  assert.throws(() => validateAtmosProductionConfiguration({...config, env: {production: {...config.env.production, vars: {...config.env.production.vars, BILLING_PURCHASE_MODE: 'public'}}}}), /purchase-mode-invalid/);
  assert.throws(() => validateAtmosProductionConfiguration(config, 'f'.repeat(40)), /not-reviewed-candidate/);
});

test('workflow is manual, main-only, disabled by default, read-only and retains only the redacted receipt', async () => {
  const workflow = await readFile(new URL('../.github/workflows/production-account-audit.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n  (?:push|schedule|pull_request|workflow_run):/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment:\n      name: production-account-audit/);
  assert.match(workflow, /PRODUCTION_ACCOUNT_AUDIT_ENABLED/);
  assert.match(workflow, /test "\$PRODUCTION_ACCOUNT_AUDIT_ENABLED" = true/);
  assert.match(workflow, /STRIPE_PRODUCTION_AUDIT_KEY/);
  assert.match(workflow, /PLATFORM_PRODUCTION_AUDIT_CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /env -u CLOUDFLARE_ACCOUNT_ID -u CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /env -u STRIPE_PRODUCTION_AUDIT_KEY/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_WORKERS_API_TOKEN|STRIPE_SECRET_KEY|wrangler deploy| d1 migrations apply |curl |fetch\(/);
  assert.match(workflow, /rm -f "\$RUNNER_TEMP\/production-account-audit\/stripe\.json"/);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/production-account-audit\/receipt\.json/);
  assert.doesNotMatch(workflow, /path:.*(?:stripe|platform|candidate)\.json/);
});
