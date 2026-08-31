// Policy/preflight only. Never invokes a producer, publishes, or changes remote configuration.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
export const ORIGIN = 'https://staging.weatherx.org';

export function validateHealth(platform, data) {
  assert.equal(platform?.ok, true);
  assert.equal(platform?.authMode, 'public', 'staging weather reads must not require an account');
  assert.equal(platform?.billingMode, 'disabled', 'staging is noncommercial');
  assert.equal(data?.ok, true);
  assert.equal(data?.authMode, 'public');
  assert.equal(data?.catalogMode, 'serve', 'staging must serve its catalog');
}

async function readHealth(path, fetcher) {
  const response = await fetcher(ORIGIN + path, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200, `${path}: expected HTTP 200`);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i, `${path}: expected JSON`);
  // Health should be tiny; cap bytes even if Content-Length is omitted or dishonest.
  assert.ok(response.body, `${path}: empty health response`);
  const reader = response.body.getReader(); let total = 0; const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.byteLength;
      assert.ok(total <= 8192, `${path}: oversized health response`);
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function preflight(fetcher = fetch) {
  const [platform, data] = await Promise.all([
    readHealth('/api/platform/health', fetcher), readHealth('/api/platform/data-health', fetcher),
  ]);
  validateHealth(platform, data);
  return { origin: ORIGIN, publicWeather: true, billing: false, catalogMode: 'serve' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'preflight') console.log(JSON.stringify(await preflight()));
  else throw Error('usage: staging-data.mjs preflight (read-only)');
}
