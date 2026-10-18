import { describe, expect, it, vi } from 'vitest';
import { activeRunInSlot, dispatchForCron, REENABLE_SETTLE_MS } from '../src/index';
import { MAX_CRON_TRIGGERS, SCHEDULER_CRONS, UNDECLARED_CRONS } from '../src/schedules';

const env = {
  GITHUB_DISPATCH_TOKEN: 'test-token',
  GITHUB_OWNER: 'Andrewegao',
  GITHUB_REPO: 'v3t7kq-cycle',
  GITHUB_WORKFLOW: 'catalog-bake.yml',
  SATELLITE_GITHUB_WORKFLOW: 'satellite-archive.yml',
  BAKE_GITHUB_WORKFLOW: 'bake.yml',
  GLOFAS_GITHUB_WORKFLOW: 'glofas-ingest.yml',
  CAMS_GITHUB_WORKFLOW: 'cams-ingest.yml',
  GITHUB_REF: 'main',
  CATALOG_TARGET: 'staging',
} as unknown as CloudflareBindings;

// 02:35:00Z on 2026-10-10: the dedupe window opens ten minutes earlier.
const TICK = Date.parse('2026-10-10T02:35:00Z');
const runs = (workflowRuns: unknown[]) => new Response(JSON.stringify({ total_count: workflowRuns.length, workflow_runs: workflowRuns }), {
  status: 200, headers: { 'content-type': 'application/json' },
});
// Routes the dedupe read (GET .../runs) and the dispatch (POST .../dispatches) separately.
function github(list: () => Response | Promise<Response>, dispatch: () => Response | Promise<Response>) {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).includes('/runs?')) {
      expect(init?.method).toBe('GET');
      return list();
    }
    expect(init?.method).toBe('POST');
    return dispatch();
  });
}
const dispatched = (runId: number) => () => new Response(JSON.stringify({ workflow_run_id: runId }), {
  status: 200, headers: { 'content-type': 'application/json' },
});

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
    // The catalog request is unchanged by the 2026-10-10 lanes: one POST, these five headers.
    expect(init?.method).toBe('POST');
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      accept: 'application/vnd.github+json', authorization: 'Bearer test-token', 'content-type': 'application/json',
      'user-agent': 'weatherx-model-scheduler', 'x-github-api-version': '2026-03-10',
    });
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

  it('dispatches the whole-data bake (all models, no recovery, not Wind100-only) on the Wind100 tick', async () => {
    const fetcher = github(() => runs([]), dispatched(456));
    await expect(dispatchForCron('35 2,8,14,20 * * *', env, fetcher, undefined, TICK)).resolves.toEqual({
      kind: 'whole-bake', model: 'all', runId: 456, dedupe: 'clear',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [listUrl] = fetcher.mock.calls[0]!;
    const list = new URL(String(listUrl));
    expect(list.pathname).toBe('/repos/Andrewegao/v3t7kq-cycle/actions/workflows/bake.yml/runs');
    expect(list.searchParams.get('branch')).toBe('main');
    expect(list.searchParams.get('created')).toBe('>=2026-10-10T02:25:00Z');
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe('https://api.github.com/repos/Andrewegao/v3t7kq-cycle/actions/workflows/bake.yml/dispatches');
    expect(JSON.parse(String(init?.body))).toEqual({
      ref: 'main', inputs: { model: 'all', recovery_run_id: '', staging_wind100_only: false },
    });
  });

  it.each([
    ['23 */6 * * *', 'fusion-issue.yml', { scope: 'full', caller: 'scheduler' }, { kind: 'fusion-issue', scope: 'full' }],
    ['17 */6 * * *', 'staging-search.yml', { action: 'renew', caller: 'scheduler' }, { kind: 'staging-search', action: 'renew' }],
    ['37 1,7,13,19 * * *', 'staging-place-renewal.yml', { family: 'surf' }, { kind: 'place-renewal', family: 'surf' }],
    ['47 5,17 * * *', 'staging-place-renewal.yml', { family: 'all' }, { kind: 'place-renewal', family: 'all' }],
    ['52 9 * * *', 'production-place-renewal.yml', { family: 'tides', caller: 'scheduler' }, { kind: 'production-place-renewal', family: 'tides' }],
  ])('maps %s to its fixed workflow %s and schedule-equivalent inputs', async (cron, workflow, inputs, result) => {
    const fetcher = github(() => runs([]), dispatched(77));
    await expect(dispatchForCron(cron, env, fetcher, undefined, TICK)).resolves.toEqual({ ...result, runId: 77, dedupe: 'clear' });
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe(`https://api.github.com/repos/Andrewegao/v3t7kq-cycle/actions/workflows/${workflow}/dispatches`);
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main', inputs });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
  });

  it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested'])(
    'stands aside when a run of the same workflow is %s inside the slot', async (status) => {
      const fetcher = github(() => runs([
        { id: 1, status: 'completed', event: 'workflow_dispatch' },
        { id: 2, status, event: 'schedule' },
      ]), () => { throw new Error('must not dispatch'); });
      await expect(dispatchForCron('35 2,8,14,20 * * *', env, fetcher, undefined, TICK)).resolves.toEqual({
        kind: 'skipped', lane: 'whole-bake', workflow: 'bake.yml', activeRunId: 2, activeStatus: status, activeEvent: 'schedule',
      });
      expect(fetcher).toHaveBeenCalledOnce();
    });

  it('dispatches when the only runs inside the slot have completed', async () => {
    const fetcher = github(() => runs([{ id: 9, status: 'completed', event: 'schedule' }]), dispatched(10));
    await expect(dispatchForCron('23 */6 * * *', env, fetcher, undefined, TICK)).resolves.toMatchObject({ kind: 'fusion-issue', runId: 10, dedupe: 'clear' });
  });

  it.each([
    ['HTTP 403', () => new Response('forbidden', { status: 403 })],
    ['HTTP 503', () => new Response('unavailable', { status: 503 })],
    ['malformed JSON', () => new Response('{', { status: 200 })],
    ['wrong shape', () => new Response(JSON.stringify({ runs: [] }), { status: 200 })],
    ['oversized body', () => new Response('{}', { status: 200, headers: { 'content-length': String(2_000_000) } })],
    ['network failure', () => { throw new Error('connection reset'); }],
  ])('fails open and dispatches when the slot cannot be read (%s)', async (_label, list) => {
    const fetcher = github(list, dispatched(11));
    await expect(dispatchForCron('17 */6 * * *', env, fetcher, undefined, TICK)).resolves.toEqual({
      kind: 'staging-search', action: 'renew', runId: 11, dedupe: 'unreadable',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('reads the slot as the runs created since ten minutes before the tick, on the dispatch ref', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(runs([]));
    await expect(activeRunInSlot('fusion-issue.yml', env, Date.parse('2026-10-10T06:23:00.250Z'), fetcher)).resolves.toBeNull();
    const [url, init] = fetcher.mock.calls[0]!;
    const list = new URL(String(url));
    expect(list.origin + list.pathname).toBe('https://api.github.com/repos/Andrewegao/v3t7kq-cycle/actions/workflows/fusion-issue.yml/runs');
    expect(Object.fromEntries(list.searchParams)).toEqual({
      branch: 'main', created: '>=2026-10-10T06:13:00Z', per_page: '20', exclude_pull_requests: 'true',
    });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
    await expect(activeRunInSlot('fusion-issue.yml', env, Number.NaN, fetcher)).resolves.toBe('unreadable');
  });

  it.each(['8-59/10 * * * *', '7 * * * *', '23 * * * *'])(
    'never reads before dispatching the unchanged catalog and archive lane %s', async (cron) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
      await dispatchForCron(cron, env, fetcher, undefined, TICK);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]![1]?.method).toBe('POST');
    });

  it('declares exactly the five prioritised triggers the Workers Free account fires', () => {
    expect(MAX_CRON_TRIGGERS).toBe(5);
    expect([...SCHEDULER_CRONS]).toEqual([
      '8-59/10 * * * *', '7 * * * *', '35 2,8,14,20 * * *', '23 */6 * * *', '52 9 * * *',
    ]);
    expect(UNDECLARED_CRONS.filter((cron) => (SCHEDULER_CRONS as readonly string[]).includes(cron))).toEqual([]);
  });

  it('maps every declared trigger, and every undeclared routable cron, to a dispatch plan', async () => {
    for (const cron of [...SCHEDULER_CRONS, ...UNDECLARED_CRONS]) {
      const fetcher = github(() => runs([]), () => new Response(null, { status: 204 }));
      await expect(dispatchForCron(cron, env, fetcher, undefined, TICK)).resolves.toBeTruthy();
    }
  });

  it.each([
    ['15 11,13 * * *', 'glofas'],
    ['40 0,10,12,22 * * *', 'cams'],
  ])('dispatches only the energy %s ingest workflow, with no data choice in the inputs', async (cron, family) => {
    const fetcher = github(() => runs([]), dispatched(789));
    await expect(dispatchForCron(cron, env, fetcher, undefined, TICK)).resolves.toEqual({ kind: 'energy-ingest', family, runId: 789, dedupe: 'clear' });
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe(`https://api.github.com/repos/Andrewegao/v3t7kq-cycle/actions/workflows/${family}-ingest.yml/dispatches`);
    expect(JSON.parse(String(init?.body))).toEqual({ ref: 'main', inputs: { caller: 'scheduler' } });
  });

  it.each([
    ['15 11,13 * * *', { GLOFAS_GITHUB_WORKFLOW: 'bake.yml' }],
    ['40 0,10,12,22 * * *', { CAMS_GITHUB_WORKFLOW: 'glofas-ingest.yml' }],
    ['15 11,13 * * *', { GITHUB_REF: 'feature' }],
  ])('fails closed when an energy ingest workflow or ref drifts: %s %o', async (cron, change) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(dispatchForCron(cron, { ...env, ...change } as never, fetcher)).rejects.toThrow(/unsupported energy (glofas|cams) ingest/);
    expect(fetcher).not.toHaveBeenCalled();
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
    { BAKE_GITHUB_WORKFLOW: 'other.yml' },
    { GITHUB_REF: 'feature' },
  ])('fails closed when the whole-data bake workflow or ref drifts: %o', async (change) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(dispatchForCron('35 2,8,14,20 * * *', { ...env, ...change } as never, fetcher))
      .rejects.toThrow('unsupported whole-data bake workflow or ref');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['23 */6 * * *', '17 */6 * * *', '37 1,7,13,19 * * *', '47 5,17 * * *'])(
    'fails closed before any GitHub call when the ref drifts for %s', async (cron) => {
      const fetcher = vi.fn<typeof fetch>();
      await expect(dispatchForCron(cron, { ...env, GITHUB_REF: 'feature' } as never, fetcher)).rejects.toThrow(/unsupported .* ref/);
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

// GitHub's refusal for a dispatch to a disabled workflow (REST "Create a workflow dispatch event").
const disabledRefusal = () => new Response(JSON.stringify({
  message: "Cannot trigger a 'workflow_dispatch' on a disabled workflow",
  documentation_url: 'https://docs.github.com/rest/actions/workflows#create-a-workflow-dispatch-event',
  status: '422',
}), { status: 422, headers: { 'content-type': 'application/json' } });
const workflowState = (state: string) => () => new Response(JSON.stringify({
  id: 191234567, name: 'WeatherX component bake', path: '.github/workflows/catalog-bake.yml', state,
}), { status: 200, headers: { 'content-type': 'application/json' } });
// Routes POST dispatches, GET workflow and PUT enable; records every call as "METHOD path".
function disabledGithub(dispatches: Array<() => Response>, state: () => Response, enable: () => Response = () => new Response(null, { status: 204 })) {
  const calls: string[] = [];
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/repos/Andrewegao/v3t7kq-cycle/actions/workflows/', '');
    calls.push(`${init?.method} ${path}`);
    if (init?.method === 'PUT') return enable();
    if (init?.method === 'GET') return state();
    const next = dispatches.shift();
    if (!next) throw new Error('unexpected dispatch');
    return next();
  });
  return { fetcher, calls };
}

describe('dispatch to a workflow GitHub disabled for inactivity', () => {
  it('re-enables the workflow once, retries the dispatch once, and logs one structured line', async () => {
    const { fetcher, calls } = disabledGithub([disabledRefusal, () => new Response(null, { status: 204 })], workflowState('disabled_inactivity'));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(dispatchForCron('8-59/10 * * * *', env, fetcher, sleep)).resolves.toEqual({
        kind: 'catalog', model: 'hrrr', runId: null, reenabled: true,
      });
      expect(calls).toEqual(['POST catalog-bake.yml/dispatches', 'GET catalog-bake.yml', 'PUT catalog-bake.yml/enable', 'POST catalog-bake.yml/dispatches']);
      expect(sleep.mock.calls).toEqual([[REENABLE_SETTLE_MS]]);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([{
        event: 'github_workflow_reenabled', cron: '8-59/10 * * * *', workflow: 'catalog-bake.yml', previousState: 'disabled_inactivity',
      }]);
      // The enable request carries the scheduler's own token and API headers.
      const enable = fetcher.mock.calls.find(([, init]) => init?.method === 'PUT')!;
      expect(String(enable[0])).toBe('https://api.github.com/repos/Andrewegao/v3t7kq-cycle/actions/workflows/catalog-bake.yml/enable');
      expect(new Headers(enable[1]?.headers).get('authorization')).toBe('Bearer test-token');
    } finally { log.mockRestore(); }
  });

  it('re-enables at most once: a second refusal after enabling fails the tick', async () => {
    const { fetcher, calls } = disabledGithub([disabledRefusal, disabledRefusal], workflowState('disabled_inactivity'));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(dispatchForCron('7 * * * *', env, fetcher, sleep)).rejects.toThrow(/failed \(422\): .*disabled workflow/);
      expect(calls.filter((call) => call.startsWith('PUT'))).toHaveLength(1);
      expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(2);
    } finally { log.mockRestore(); }
  });

  it.each(['disabled_manually', 'active'])('never re-enables a workflow whose state is %s', async (state) => {
    const { fetcher, calls } = disabledGithub([disabledRefusal], workflowState(state));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(dispatchForCron('8-59/10 * * * *', env, fetcher)).rejects.toThrow(
        new RegExp(`failed \\(422\\): .*not re-enabled: workflow state is ${state}; only disabled_inactivity is re-enabled`));
      expect(calls).toEqual(['POST catalog-bake.yml/dispatches', 'GET catalog-bake.yml']);
      expect(log.mock.calls.map(([line]) => JSON.parse(String(line)).event)).toContain('github_workflow_disabled');
    } finally { log.mockRestore(); }
  });

  it('fails the tick when the state is unreadable or the enable is refused, without retrying the dispatch', async () => {
    for (const [state, enable, reason] of [
      [() => new Response('nope', { status: 403 }), undefined, 'workflow state unreadable \\(403\\)'],
      [workflowState('disabled_inactivity'), () => new Response('forbidden', { status: 403 }), 'enable refused \\(403\\)'],
    ] as const) {
      const { fetcher, calls } = disabledGithub([disabledRefusal], state, enable);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await expect(dispatchForCron('8-59/10 * * * *', env, fetcher)).rejects.toThrow(new RegExp(`not re-enabled: ${reason}`));
        expect(calls.filter((call) => call.startsWith('POST'))).toHaveLength(1);
      } finally { log.mockRestore(); }
    }
  });

  it('leaves every other 422 a permanent failure with no state read', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: 'Unexpected inputs provided: ["x"]' }), { status: 422 }));
    await expect(dispatchForCron('8-59/10 * * * *', env, fetcher)).rejects.toThrow('failed (422)');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
