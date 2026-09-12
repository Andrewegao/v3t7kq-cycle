import { ARCHIVE_CRON, HRRR_CRON, SLOW_CRON, WIND100_CRON } from './schedules';
const MAX_ATTEMPTS = 4;
const MAX_ERROR_BYTES = 4_096;

type ModelSelection = 'hrrr' | 'slow';
type DispatchResult =
  | { kind: 'catalog'; model: ModelSelection; runId: number | null }
  | { kind: 'satellite-archive'; policy: 'hourly-tail-v1'; runId: number | null }
  | { kind: 'staging-wind100'; model: 'ecmwf'; runId: number | null };
type DispatchPlan =
  | { kind: 'catalog'; workflow: string; model: ModelSelection; inputs: { model: ModelSelection; target: 'staging' | 'production' } }
  | { kind: 'satellite-archive'; workflow: string; policy: 'hourly-tail-v1'; inputs: { policy: 'hourly-tail-v1' } }
  | { kind: 'staging-wind100'; workflow: 'bake.yml'; model: 'ecmwf'; inputs: {
    model: 'ecmwf'; recovery_run_id: ''; staging_wind100_only: true;
  } };
type Fetcher = typeof fetch;
type Sleeper = (delayMs: number) => Promise<void>;

function dispatchForSchedule(cron: string, env: CloudflareBindings): DispatchPlan {
  if (cron === HRRR_CRON || cron === SLOW_CRON) {
    const target: string = env.CATALOG_TARGET;
    if (target !== 'staging' && target !== 'production') {
      throw new Error(`unsupported catalog target: ${target}`);
    }
    const model = cron === HRRR_CRON ? 'hrrr' : 'slow';
    return { kind: 'catalog', workflow: env.GITHUB_WORKFLOW, model, inputs: { model, target } };
  }
  if (cron === ARCHIVE_CRON) {
    if (env.SATELLITE_GITHUB_WORKFLOW !== 'satellite-archive.yml') {
      throw new Error('unsupported satellite archive workflow');
    }
    return { kind: 'satellite-archive', workflow: env.SATELLITE_GITHUB_WORKFLOW,
      policy: 'hourly-tail-v1', inputs: { policy: 'hourly-tail-v1' } };
  }
  if (cron === WIND100_CRON) {
    if (env.WIND100_GITHUB_WORKFLOW !== 'bake.yml' || env.GITHUB_REF !== 'main') {
      throw new Error('unsupported staging Wind100 workflow or ref');
    }
    return { kind: 'staging-wind100', workflow: env.WIND100_GITHUB_WORKFLOW, model: 'ecmwf',
      inputs: { model: 'ecmwf', recovery_run_id: '', staging_wind100_only: true } };
  }
  throw new Error(`unsupported scheduler cron: ${cron}`);
}

function retryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function boundedError(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ERROR_BYTES) {
    await response.body?.cancel();
    return `response body exceeded ${MAX_ERROR_BYTES} bytes`;
  }
  return (await response.text()).slice(0, MAX_ERROR_BYTES);
}

const defaultSleep: Sleeper = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export async function dispatchForCron(
  cron: string,
  env: CloudflareBindings,
  fetcher: Fetcher = fetch,
  sleep: Sleeper = defaultSleep,
): Promise<DispatchResult> {
  const plan = dispatchForSchedule(cron, env);
  const workflow = encodeURIComponent(plan.workflow);
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/workflows/${workflow}/dispatches`;
  const body = JSON.stringify({ ref: env.GITHUB_REF, inputs: plan.inputs });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'weatherx-model-scheduler',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new Error(`GitHub workflow dispatch failed after ${MAX_ATTEMPTS} attempts: ${String(error)}`);
      }
      await sleep(250 * 2 ** attempt);
      continue;
    }

    if (response.ok) {
      const responseBody = response.status === 204 ? null : await boundedError(response);
      let runId: number | null = null;
      if (responseBody) {
        try {
          const value: unknown = JSON.parse(responseBody);
          if (value && typeof value === 'object' && 'workflow_run_id' in value &&
              Number.isSafeInteger(value.workflow_run_id)) runId = Number(value.workflow_run_id);
        } catch {
          // The dispatch succeeded; an unrecognized optional response body does not invalidate it.
        }
      }
      if (plan.kind === 'catalog') return { kind: 'catalog', model: plan.model, runId };
      if (plan.kind === 'satellite-archive') {
        return { kind: 'satellite-archive', policy: plan.policy, runId };
      }
      return { kind: 'staging-wind100', model: plan.model, runId };
    }

    const error = await boundedError(response);
    if (!retryable(response.status) || attempt === MAX_ATTEMPTS - 1) {
      throw new Error(`GitHub workflow dispatch failed (${response.status}): ${error}`);
    }
    await sleep(250 * 2 ** attempt);
  }
  throw new Error('GitHub workflow dispatch exhausted unexpectedly');
}

export default {
  async scheduled(controller, env): Promise<void> {
    const result = await dispatchForCron(controller.cron, env);
    console.log(JSON.stringify({
      event: 'github_workflow_dispatched',
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
      ...result,
      target: result.kind === 'catalog' ? env.CATALOG_TARGET : undefined,
    }));
  },
} satisfies ExportedHandler<CloudflareBindings>;
