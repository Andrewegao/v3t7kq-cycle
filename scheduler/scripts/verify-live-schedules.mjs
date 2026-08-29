import { setTimeout as sleep } from 'node:timers/promises';
import { fetchLiveSchedules, fetchLiveTarget, loadSchedulerConfig } from './live-schedules.mjs';

const apiToken = process.env.CLOUDFLARE_API_TOKEN;
if (!apiToken) throw new Error('CLOUDFLARE_API_TOKEN is required');

const config = await loadSchedulerConfig();
const attempts = Number.parseInt(process.env.LIVE_SCHEDULE_VERIFY_ATTEMPTS ?? '12', 10);
const delayMs = Number.parseInt(process.env.LIVE_SCHEDULE_VERIFY_DELAY_MS ?? '10000', 10);
if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 30) {
  throw new Error('LIVE_SCHEDULE_VERIFY_ATTEMPTS must be an integer from 1 to 30');
}
if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 60_000) {
  throw new Error('LIVE_SCHEDULE_VERIFY_DELAY_MS must be an integer from 0 to 60000');
}

let lastError;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const [actual, target] = await Promise.all([
      fetchLiveSchedules({ ...config, apiToken }),
      fetchLiveTarget({ ...config, apiToken }),
    ]);
    console.log(`live scheduler verified: ${config.workerName} target=${target} crons=${JSON.stringify(actual)}`);
    process.exitCode = 0;
    lastError = undefined;
    break;
  } catch (error) {
    lastError = error;
    if (attempt < attempts) {
      console.warn(`live scheduler verification attempt ${attempt}/${attempts} failed; retrying`);
      await sleep(delayMs);
    }
  }
}

if (lastError) throw lastError;
