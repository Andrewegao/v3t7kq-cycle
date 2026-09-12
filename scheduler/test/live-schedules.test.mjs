import { describe, expect, it, vi } from 'vitest';
import {
  assertExactSchedules, assertExactTarget, assertExactWind100DispatchBindings, fetchLiveSchedules, fetchLiveTarget,
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

describe('live Cloudflare scheduler target verification', () => {
  const bindings = [
    { name: 'CATALOG_TARGET', type: 'plain_text', text: 'production' },
    { name: 'WIND100_GITHUB_WORKFLOW', type: 'plain_text', text: 'bake.yml' },
    { name: 'GITHUB_REF', type: 'plain_text', text: 'main' },
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

  it('accepts only the exact staging Wind100 workflow and ref bindings', () => {
    expect(assertExactWind100DispatchBindings({ success: true, result: { bindings } }, 'bake.yml', 'main'))
      .toEqual({ workflow: 'bake.yml', ref: 'main' });
  });

  it.each([
    [bindings.filter(({ name }) => name !== 'WIND100_GITHUB_WORKFLOW')],
    [bindings.map((binding) => binding.name === 'WIND100_GITHUB_WORKFLOW' ? { ...binding, text: 'other.yml' } : binding)],
    [[...bindings, { name: 'GITHUB_REF', type: 'plain_text', text: 'main' }]],
    [bindings.map((binding) => binding.name === 'GITHUB_REF' ? { ...binding, text: 'feature' } : binding)],
  ])('rejects a missing, mismatched, or duplicate staging Wind100 dispatch binding %#', (changed) => {
    expect(() => assertExactWind100DispatchBindings({ success: true, result: { bindings: changed } }, 'bake.yml', 'main'))
      .toThrow('live staging Wind100 dispatch binding mismatch');
  });

  it('reads script-and-version settings from the official account-scoped endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      result: { bindings },
    }), { status: 200 }));
    await expect(fetchLiveTarget({
      accountId: 'account id', workerName: 'scheduler/name', apiToken: 'secret-token',
      expectedTarget: 'production', expectedWind100Workflow: 'bake.yml', expectedRef: 'main', fetcher,
    })).resolves.toBe('production');
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/account%20id/workers/scripts/scheduler%2Fname/settings');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer secret-token');
  });
});
