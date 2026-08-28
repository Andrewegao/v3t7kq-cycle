import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadSchedulerConfig } from './scripts/live-schedules.mjs';

const { expectedCrons } = await loadSchedulerConfig();
const runtime = await readFile(new URL('./src/schedules.ts', import.meta.url), 'utf8');
const catalogWorkflow = await readFile(new URL('../.github/workflows/catalog-bake.yml', import.meta.url), 'utf8');
const deployWorkflow = await readFile(new URL('../.github/workflows/scheduler-deploy.yml', import.meta.url), 'utf8');

const runtimeCrons = [...runtime.matchAll(/export const \w+_CRON = '([^']+)'/g)].map((match) => match[1]);
const workflowCrons = [...catalogWorkflow.matchAll(/^\s+- cron: '([^']+)'$/gm)].map((match) => match[1]);

assert.deepEqual([...runtimeCrons].sort(), [...expectedCrons].sort(), 'runtime cron mapping must match wrangler triggers');
assert.deepEqual([...workflowCrons].sort(), [...expectedCrons].sort(), 'GitHub fallback crons must match wrangler triggers');
assert.match(catalogWorkflow,
  /github\.event_name == 'workflow_dispatch' \|\| vars\.CATALOG_GITHUB_FALLBACK_DISABLED != 'true'/,
  'GitHub fallback must fail open unless an operator explicitly disables it');
assert.doesNotMatch(catalogWorkflow, /CATALOG_SCHEDULER_ENABLED/,
  'legacy opt-in gating can silently leave the platform without a publisher');
assert.match(deployWorkflow, /working-directory: scheduler[\s\S]*?run: npx wrangler deploy/,
  'guarded deploy must use wrangler deploy so cron triggers are applied');
assert.match(deployWorkflow, /working-directory: scheduler[\s\S]*?run: npm run verify:live/,
  'guarded deploy must verify the live trigger set');
assert.match(deployWorkflow, /secrets\.CLOUDFLARE_WORKERS_API_TOKEN/,
  'scheduler deploy must use its dedicated least-privilege Workers credential');
assert.doesNotMatch(deployWorkflow, /secrets\.CLOUDFLARE_API_TOKEN/,
  'scheduler deploy must not reuse the Pages publication credential');

console.log('scheduler deployment and cron contract: ok');
