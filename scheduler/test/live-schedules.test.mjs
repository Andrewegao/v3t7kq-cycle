import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CRON_TRIGGERS, assertExactDispatchBindings, assertExactSchedules, assertExactTarget, fetchLiveSchedules,
  fetchLiveTarget, loadSchedulerConfig,
} from '../scripts/live-schedules.mjs';

const expectedCrons = ['8-59/10 * * * *', '7 * * * *'];

describe('live Cloudflare schedule verification', () => {
  it('accepts Cloudflare\'s documented result.schedules response envelope', () => {
    expect(assertExactSchedules({
      success: true,
      result: {
        schedules: [{ cron: '7 * * * *' }, { cron: '8-59/10 * * * *' }],
      },
    }, expectedCrons)).toEqual(['7 * * * *', '8-59/10 * * * *']);
  });

  it('accepts the exact expected schedule set independent of API order', () => {
    expect(assertExactSchedules({
      success: true,
      result: { schedules: [{ cron: '7 * * * *' }, { cron: '8-59/10 * * * *' }] },
    }, expectedCrons)).toEqual(['7 * * * *', '8-59/10 * * * *']);
  });

  it.each([
    [{ success: true, result: { schedules: [] } }, 'live cron mismatch'],
    [{ success: true, result: { schedules: [{ cron: '7 * * * *' }] } }, 'live cron mismatch'],
    [{ success: true, result: { schedules: [...expectedCrons.map((cron) => ({ cron })), { cron: '0 0 * * *' }] } }, 'live cron mismatch'],
    [{ success: true, result: { schedules: [{ cron: expectedCrons[0] }, { cron: expectedCrons[0] }] } }, 'duplicate cron'],
    [{ success: false, result: { schedules: [] } }, 'malformed schedules response'],
    [{ success: true, result: [] }, 'malformed schedules response'],
  ])('rejects unsafe schedule state %#', (payload, message) => {
    expect(() => assertExactSchedules(payload, expectedCrons)).toThrow(message);
  });

  it('uses the official account-scoped endpoint without exposing the token', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: { schedules: expectedCrons.map((cron) => ({ cron })) },
    }), { status: 200 }));

    await expect(fetchLiveSchedules({
      accountId: 'account id',
      workerName: 'scheduler/name',
      apiToken: 'secret-token',
      expectedCrons,
      fetcher,
    })).resolves.toEqual([...expectedCrons].sort());

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/account%20id/workers/scripts/scheduler%2Fname/schedules');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-token');
  });

  it('fails closed on non-successful Cloudflare responses', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    await expect(fetchLiveSchedules({
      accountId: 'account',
      workerName: 'scheduler',
      apiToken: 'secret-token',
      expectedCrons,
      fetcher,
    })).rejects.toThrow('Cloudflare schedules API failed (403): forbidden');
  });
});

describe('declared trigger limit', () => {
  const reviewed = new URL('../wrangler.jsonc', import.meta.url);

  it('loads the reviewed declaration: five triggers, the Workers Free account limit', async () => {
    const { expectedCrons } = await loadSchedulerConfig(reviewed);
    expect(MAX_CRON_TRIGGERS).toBe(5);
    expect(expectedCrons).toHaveLength(MAX_CRON_TRIGGERS);
  });

  it('refuses a declaration with more triggers than the account fires', async () => {
    const config = JSON.parse(await readFile(reviewed, 'utf8'));
    config.triggers.crons = [...config.triggers.crons, '17 */6 * * *'];
    const path = join(await mkdtemp(join(tmpdir(), 'scheduler-crons-')), 'wrangler.jsonc');
    await writeFile(path, JSON.stringify(config));
    await expect(loadSchedulerConfig(pathToFileURL(path))).rejects.toThrow('fires at most 5 (Workers Free)');
  });
});

describe('live Cloudflare scheduler target verification', () => {
  const expectedVars = { CATALOG_TARGET: 'production', BAKE_GITHUB_WORKFLOW: 'bake.yml', GITHUB_REF: 'main' };
  const bindings = [
    { name: 'CATALOG_TARGET', type: 'plain_text', text: 'production' },
    { name: 'BAKE_GITHUB_WORKFLOW', type: 'plain_text', text: 'bake.yml' },
    { name: 'GITHUB_REF', type: 'plain_text', text: 'main' },
    { name: 'GITHUB_DISPATCH_TOKEN', type: 'secret_text' },
  ];

  it('accepts the exact production plain-text binding', () => {
    expect(assertExactTarget({
      success: true,
      result: { bindings: [{ name: 'CATALOG_TARGET', type: 'plain_text', text: 'production' }] },
    }, 'production')).toBe('production');
  });

  it.each([
    [{ success: true, result: { bindings: [] } }],
    [{ success: true, result: { bindings: [{ name: 'CATALOG_TARGET', type: 'plain_text', text: 'staging' }] } }],
    [{ success: true, result: { bindings: [
      { name: 'CATALOG_TARGET', type: 'plain_text', text: 'production' },
      { name: 'CATALOG_TARGET', type: 'plain_text', text: 'production' },
    ] } }],
  ])('rejects a missing, mismatched, or duplicate target %#', (payload) => {
    expect(() => assertExactTarget(payload, 'production')).toThrow('live catalog target mismatch');
  });

  it('accepts only the exact declared dispatch bindings and the bound dispatch secret', () => {
    expect(assertExactDispatchBindings({ success: true, result: { bindings } }, expectedVars))
      .toEqual({ vars: 3, secrets: 1 });
  });

  it.each([
    [bindings.filter(({ name }) => name !== 'BAKE_GITHUB_WORKFLOW'), 'binding mismatch: BAKE_GITHUB_WORKFLOW'],
    [bindings.map((binding) => binding.name === 'BAKE_GITHUB_WORKFLOW' ? { ...binding, text: 'other.yml' } : binding), 'binding mismatch: BAKE_GITHUB_WORKFLOW'],
    [[...bindings, { name: 'GITHUB_REF', type: 'plain_text', text: 'main' }], 'binding mismatch: GITHUB_REF'],
    [bindings.map((binding) => binding.name === 'GITHUB_REF' ? { ...binding, text: 'feature' } : binding), 'binding mismatch: GITHUB_REF'],
    [bindings.filter(({ name }) => name !== 'GITHUB_DISPATCH_TOKEN'), 'secret missing: GITHUB_DISPATCH_TOKEN'],
    [bindings.map((binding) => binding.name === 'GITHUB_DISPATCH_TOKEN' ? { ...binding, type: 'plain_text', text: 'x' } : binding), 'secret missing: GITHUB_DISPATCH_TOKEN'],
  ])('rejects a missing, mismatched, or duplicate dispatch binding %#', (changed, message) => {
    expect(() => assertExactDispatchBindings({ success: true, result: { bindings: changed } }, expectedVars))
      .toThrow(message);
  });

  it('reads script-and-version settings from the official account-scoped endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: { bindings },
    }), { status: 200 }));
    await expect(fetchLiveTarget({
      accountId: 'account id', workerName: 'scheduler/name', apiToken: 'secret-token',
      expectedTarget: 'production', expectedVars, requiredSecrets: ['GITHUB_DISPATCH_TOKEN'], fetcher,
    })).resolves.toBe('production');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/account%20id/workers/scripts/scheduler%2Fname/settings');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-token');
  });
});
