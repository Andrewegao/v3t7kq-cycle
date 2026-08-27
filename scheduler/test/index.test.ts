import { describe, expect, it, vi } from 'vitest';
import { dispatchForCron } from '../src/index';

const env = {
  GITHUB_DISPATCH_TOKEN: 'test-token',
  GITHUB_OWNER: 'Andrewegao',
  GITHUB_REPO: 'v3t7kq-cycle',
  GITHUB_WORKFLOW: 'catalog-bake.yml',
  GITHUB_REF: 'main',
} as CloudflareBindings;

describe('Cloudflare scheduler dispatch bridge', () => {
  it.each([
    ['8-59/10 * * * *', 'hrrr'],
    ['7 * * * *', 'slow'],
  ])('maps %s to the constrained %s dispatch', async (cron, model) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ workflow_run_id: 123 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(dispatchForCron(cron, env, fetcher)).resolves.toEqual({ model, runId: 123 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/Andrewegao/v3t7kq-cycle/actions/workflows/catalog-bake.yml/dispatches');
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main', inputs: { model } });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
  });

  it('retries transient GitHub failures with bounded backoff', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('temporary', { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();
    await expect(dispatchForCron('8-59/10 * * * *', env, fetcher, sleep)).resolves.toEqual({ model: 'hrrr', runId: null });
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
    await expect(dispatchForCron('8-59/10 * * * *', env, fetcher, sleep)).resolves.toEqual({ model: 'hrrr', runId: null });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });
});
