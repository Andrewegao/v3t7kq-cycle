import { readFile } from 'node:fs/promises';

const MAX_ERROR_BYTES = 2_048;

export async function loadSchedulerConfig(configUrl = new URL('../wrangler.jsonc', import.meta.url)) {
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  const accountId = config.account_id;
  const workerName = config.name;
  const expectedCrons = config.triggers?.crons;
  const expectedTarget = config.vars?.CATALOG_TARGET;

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

  return { accountId, workerName, expectedCrons, expectedTarget };
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

export async function fetchLiveTarget({ accountId, workerName, apiToken, expectedTarget, fetcher = fetch }) {
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
  return assertExactTarget(payload, expectedTarget);
}
