import { describe, expect, it, vi } from 'vitest';
import { dispatchForCron } from '../src/index';

const env = {
  GITHUB_DISPATCH_TOKEN: 'test-token',
  GITHUB_OWNER: 'Andrewegao',
  GITHUB_REPO: 'v3t7kq-cycle',
  GITHUB_WORKFLOW: 'catalog-bake.yml',
  SATELLITE_GITHUB_WORKFLOW: 'satellite-archive.yml',
  WIND100_GITHUB_WORKFLOW: 'bake.yml',
  GITHUB_REF: 'main',
  CATALOG_TARGET: 'staging',
} as unknown as CloudflareBindings;

describe('Cloudflare scheduler dispatch bridge', () => {
  it.each([
    ['8-59/10 * * * *', 'hrrr'],
    ['7 * * * *', 'slow'],
  ])('maps %s to the constrained %s dispatch', async (cron, model) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ workflow_run_id: 123 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(dispatchForCron(cron, env, fetcher)).resolves.toEqual({ kind: 'catalog', model, runId: 123 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/Andrewegao/v3t7kq-cycle/actions/workflows/catalog-bake.yml/dispatches');
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main', inputs: { model, target: 'staging' } });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
  });

  it('dispatches only the archive hourly tail on the archive cron', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await expect(dispatchForCron('23 * * * *', env, fetcher)).resolves.toEqual({
      kind: 'satellite-archive', policy: 'hourly-tail-v1', runId: null,
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/Andrewegao/v3t7kq-cycle/actions/workflows/satellite-archive.yml/dispatches');
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main', inputs: { policy: 'hourly-tail-v1' } });
  });

  it('dispatches only the isolated staging Wind100 path four times daily', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ workflow_run_id: 456 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(dispatchForCron('35 2,8,14,20 * * *', env, fetcher)).resolves.toEqual({
      kind: 'staging-wind100', model: 'ecmwf', runId: 456,
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/Andrewegao/v3t7kq-cycle/actions/workflows/bake.yml/dispatches');
    expect(JSON.parse(String(init?.body))).toEqual({
      ref: 'main', inputs: { model: 'ecmwf', recovery_run_id: '', staging_wind100_only: true },
    });
  });

  it('retries transient GitHub failures with bounded backoff', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();
    await expect(dispatchForCron('8-59/10 * * * *', env, fetcher, sleep)).resolves.toEqual({ kind: 'catalog', model: 'hrrr', runId: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('fails closed without retrying permanent GitHub errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('forbidden', { status: 403 }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();
    await expect(dispatchForCron('7 * * * *', env, fetcher, sleep)).rejects.toThrow('failed (403): forbidden');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejects unknown cron triggers before contacting GitHub', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(dispatchForCron('* * * * *', env, fetcher)).rejects.toThrow('unsupported scheduler cron');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed when the archive workflow binding drifts', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(dispatchForCron('23 * * * *', {
      ...env, SATELLITE_GITHUB_WORKFLOW: 'other.yml',
    } as never, fetcher)).rejects.toThrow('unsupported satellite archive workflow');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { WIND100_GITHUB_WORKFLOW: 'other.yml' },
    { GITHUB_REF: 'feature' },
  ])('fails closed when the staging Wind100 workflow or ref drifts: %o', async (change) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(dispatchForCron('35 2,8,14,20 * * *', { ...env, ...change } as never, fetcher))
      .rejects.toThrow('unsupported staging Wind100 workflow or ref');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails before dispatch when the configured catalog target is not recognized', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(dispatchForCron('7 * * * *', { ...env, CATALOG_TARGET: 'preview' } as never, fetcher))
      .rejects.toThrow('unsupported catalog target');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('exhausts transient errors after four attempts', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('unavailable', { status: 503 }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();
    await expect(dispatchForCron('8-59/10 * * * *', env, fetcher, sleep)).rejects.toThrow('failed (503): unavailable');
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 500, 1000]);
  });

  it('retries indeterminate network failures because model jobs are concurrency-safe and idempotent', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();
    await expect(dispatchForCron('8-59/10 * * * *', env, fetcher, sleep)).resolves.toEqual({ kind: 'catalog', model: 'hrrr', runId: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });
});
