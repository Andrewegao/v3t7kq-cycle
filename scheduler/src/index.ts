import { HRRR_CRON, SLOW_CRON } from './schedules';
const MAX_ATTEMPTS = 4;
const MAX_ERROR_BYTES = 4_096;

type ModelSelection = 'hrrr' | 'slow';
type Fetcher = typeof fetch;
type Sleeper = (delayMs: number) => Promise<void>;

function selectionForCron(cron: string): ModelSelection {
  if (cron === HRRR_CRON) return 'hrrr';
  if (cron === SLOW_CRON) return 'slow';
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
): Promise<{ model: ModelSelection; runId: number | null }> {
  const model = selectionForCron(cron);
  const target = env.CATALOG_TARGET;
  if (target !== 'staging' && target !== 'production') {
    throw new Error(`unsupported catalog target: ${target}`);
  }
  const workflow = encodeURIComponent(env.GITHUB_WORKFLOW);
  const endpoint = `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/workflows/${workflow}/dispatches`;
  const body = JSON.stringify({ ref: env.GITHUB_REF, inputs: { model, target } });

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
      return { model, runId };
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
      model: result.model,
      target: env.CATALOG_TARGET,
      runId: result.runId,
    }));
  },
} satisfies ExportedHandler<CloudflareBindings>;
