import { readFile } from 'node:fs/promises';

const MAX_ERROR_BYTES = 2_048;

export async function loadSchedulerConfig(configUrl = new URL('../wrangler.jsonc', import.meta.url)) {
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  const accountId = config.account_id;
  const workerName = config.name;
  const expectedCrons = config.triggers?.crons;
  const expectedTarget = config.vars?.CATALOG_TARGET;
  const expectedVars = config.vars;
  const expectedBakeWorkflow = config.vars?.BAKE_GITHUB_WORKFLOW;
  const expectedRef = config.vars?.GITHUB_REF;
  const requiredSecrets = config.secrets?.required;

  if (typeof accountId !== 'string' || !accountId) throw new Error('wrangler.jsonc is missing account_id');
  if (typeof workerName !== 'string' || !workerName) throw new Error('wrangler.jsonc is missing name');
  if (!Array.isArray(expectedCrons) || expectedCrons.length === 0 ||
      expectedCrons.some((cron) => typeof cron !== 'string' || !cron)) {
    throw new Error('wrangler.jsonc must declare at least one valid cron trigger');
  }
  if (new Set(expectedCrons).size !== expectedCrons.length) {
    throw new Error('wrangler.jsonc contains duplicate cron triggers');
  }
  if (expectedTarget !== 'staging' && expectedTarget !== 'production') {
    throw new Error('wrangler.jsonc must declare a valid CATALOG_TARGET');
  }
  if (expectedBakeWorkflow !== 'bake.yml' || expectedRef !== 'main') {
    throw new Error('wrangler.jsonc must constrain whole-data bake dispatches to bake.yml on main');
  }
  if (!expectedVars || typeof expectedVars !== 'object' ||
      Object.values(expectedVars).some((value) => typeof value !== 'string' || !value)) {
    throw new Error('wrangler.jsonc vars must be non-empty strings');
  }
  if (!Array.isArray(requiredSecrets) || requiredSecrets.join() !== 'GITHUB_DISPATCH_TOKEN') {
    throw new Error('wrangler.jsonc must require exactly the GITHUB_DISPATCH_TOKEN secret');
  }

  return {
    accountId, workerName, expectedCrons, expectedTarget, expectedBakeWorkflow, expectedRef,
    expectedVars: { ...expectedVars }, requiredSecrets: [...requiredSecrets],
  };
}

export function assertExactTarget(payload, expectedTarget) {
  if (!payload || typeof payload !== 'object' || payload.success !== true ||
      !payload.result || typeof payload.result !== 'object' || !Array.isArray(payload.result.bindings)) {
    throw new Error('Cloudflare returned malformed Worker settings');
  }
  const targets = payload.result.bindings.filter((binding) => binding?.name === 'CATALOG_TARGET');
  if (targets.length !== 1 || targets[0]?.type !== 'plain_text' || targets[0]?.text !== expectedTarget) {
    throw new Error(`live catalog target mismatch: expected ${expectedTarget}`);
  }
  return expectedTarget;
}

// Every declared plain-text var must be live exactly once with its declared value, and every
// required secret must be bound (names and types only; secret values are never readable).
export function assertExactDispatchBindings(payload, expectedVars, requiredSecrets = ['GITHUB_DISPATCH_TOKEN']) {
  if (!payload || typeof payload !== 'object' || payload.success !== true ||
      !payload.result || typeof payload.result !== 'object' || !Array.isArray(payload.result.bindings)) {
    throw new Error('Cloudflare returned malformed Worker settings');
  }
  for (const [name, expected] of Object.entries(expectedVars)) {
    const bindings = payload.result.bindings.filter((binding) => binding?.name === name);
    if (bindings.length !== 1 || bindings[0]?.type !== 'plain_text' || bindings[0]?.text !== expected) {
      throw new Error(`live scheduler dispatch binding mismatch: ${name}`);
    }
  }
  for (const name of requiredSecrets) {
    const bindings = payload.result.bindings.filter((binding) => binding?.name === name);
    if (bindings.length !== 1 || bindings[0]?.type !== 'secret_text') {
      throw new Error(`live scheduler secret missing: ${name}`);
    }
  }
  return { vars: Object.keys(expectedVars).length, secrets: requiredSecrets.length };
}

export function assertExactSchedules(payload, expectedCrons) {
  if (!payload || typeof payload !== 'object' || payload.success !== true ||
      !payload.result || typeof payload.result !== 'object' ||
      !Array.isArray(payload.result.schedules)) {
    throw new Error('Cloudflare returned a malformed schedules response');
  }

  const actualCrons = payload.result.schedules.map((entry) => entry?.cron);
  if (actualCrons.some((cron) => typeof cron !== 'string' || !cron)) {
    throw new Error('Cloudflare returned an invalid cron trigger');
  }
  if (new Set(actualCrons).size !== actualCrons.length) {
    throw new Error(`Cloudflare returned duplicate cron triggers: ${JSON.stringify(actualCrons)}`);
  }

  const actual = [...actualCrons].sort();
  const expected = [...expectedCrons].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`live cron mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
  return actual;
}

export async function fetchLiveSchedules({ accountId, workerName, apiToken, expectedCrons, fetcher = fetch }) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/schedules`;
  const response = await fetcher(endpoint, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.text()).slice(0, MAX_ERROR_BYTES);
  if (!response.ok) throw new Error(`Cloudflare schedules API failed (${response.status}): ${body}`);

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('Cloudflare schedules API returned invalid JSON');
  }
  return assertExactSchedules(payload, expectedCrons);
}

export async function fetchLiveTarget({
  accountId, workerName, apiToken, expectedTarget, expectedVars, requiredSecrets, fetcher = fetch,
}) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/workers/scripts/${encodeURIComponent(workerName)}/settings`;
  const response = await fetcher(endpoint, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.text()).slice(0, MAX_ERROR_BYTES);
  if (!response.ok) throw new Error(`Cloudflare Worker settings API failed (${response.status}): ${body}`);

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error('Cloudflare Worker settings API returned invalid JSON');
  }
  assertExactDispatchBindings(payload, expectedVars, requiredSecrets);
  return assertExactTarget(payload, expectedTarget);
}
