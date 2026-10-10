import {
  ARCHIVE_CRON, CAMS_CRON, DEDUPE_LOOKBACK_MS, FUSION_ISSUE_CRON, GLOFAS_CRON, HRRR_CRON, PLACE_DIRECTORY_CRON,
  PLACE_SURF_CRON, SLOW_CRON, STAGING_SEARCH_CRON, WHOLE_BAKE_CRON,
} from './schedules';
const MAX_ATTEMPTS = 4;
const MAX_ERROR_BYTES = 4_096;
const MAX_RUNS_BYTES = 1_048_576;
// GitHub run states that mean "this lane is already queued or running".
const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested']);

type ModelSelection = 'hrrr' | 'slow';
type EnergyFamily = 'glofas' | 'cams';
type PlaceFamily = 'surf' | 'all';
type Dedupe = 'clear' | 'unreadable';
type DedupedLane = 'whole-bake' | 'fusion-issue' | 'staging-search' | 'place-renewal' | 'energy-ingest';
type DispatchResult =
  | { kind: 'catalog'; model: ModelSelection; runId: number | null }
  | { kind: 'satellite-archive'; policy: 'hourly-tail-v1'; runId: number | null }
  | { kind: 'whole-bake'; model: 'all'; runId: number | null; dedupe: Dedupe }
  | { kind: 'fusion-issue'; scope: 'full'; runId: number | null; dedupe: Dedupe }
  | { kind: 'staging-search'; action: 'renew'; runId: number | null; dedupe: Dedupe }
  | { kind: 'place-renewal'; family: PlaceFamily; runId: number | null; dedupe: Dedupe }
  | { kind: 'energy-ingest'; family: EnergyFamily; runId: number | null; dedupe: Dedupe }
  | { kind: 'skipped'; lane: DedupedLane; workflow: string; activeRunId: number; activeStatus: string; activeEvent: string };
type DispatchPlan =
  | { kind: 'catalog'; workflow: string; model: ModelSelection; inputs: { model: ModelSelection; target: 'staging' | 'production' } }
  | { kind: 'satellite-archive'; workflow: string; policy: 'hourly-tail-v1'; inputs: { policy: 'hourly-tail-v1' } }
  | { kind: 'whole-bake'; workflow: 'bake.yml'; inputs: {
    model: 'all'; recovery_run_id: ''; staging_wind100_only: false;
  } }
  | { kind: 'fusion-issue'; workflow: 'fusion-issue.yml'; inputs: { scope: 'full'; caller: 'scheduler' } }
  | { kind: 'staging-search'; workflow: 'staging-search.yml'; inputs: { action: 'renew'; caller: 'scheduler' } }
  | { kind: 'place-renewal'; workflow: 'staging-place-renewal.yml'; family: PlaceFamily; inputs: { family: PlaceFamily } }
  | { kind: 'energy-ingest'; workflow: 'glofas-ingest.yml' | 'cams-ingest.yml'; family: EnergyFamily; inputs: { caller: 'scheduler' } };
type Fetcher = typeof fetch;
type Sleeper = (delayMs: number) => Promise<void>;
type ActiveRun = { id: number; status: string; event: string };

function requireMainRef(env: CloudflareBindings, lane: string): void {
  if (env.GITHUB_REF !== 'main') throw new Error(`unsupported ${lane} ref`);
}

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
  if (cron === WHOLE_BAKE_CRON) {
    if (env.BAKE_GITHUB_WORKFLOW !== 'bake.yml' || env.GITHUB_REF !== 'main') {
      throw new Error('unsupported whole-data bake workflow or ref');
    }
    // Exactly what the GitHub-native schedule runs: every model, whole maintenance, and the
    // staging and production native 100 m wind publishers. Never a recovery run.
    return { kind: 'whole-bake', workflow: env.BAKE_GITHUB_WORKFLOW,
      inputs: { model: 'all', recovery_run_id: '', staging_wind100_only: false } };
  }
  if (cron === FUSION_ISSUE_CRON) {
    requireMainRef(env, 'fusion issuance');
    // caller=scheduler takes the workflow's scheduled path: the FUSION_ISSUANCE_ENABLED switch and
    // the complete 64-station network. It carries no human confirmation phrase.
    return { kind: 'fusion-issue', workflow: 'fusion-issue.yml', inputs: { scope: 'full', caller: 'scheduler' } };
  }
  if (cron === STAGING_SEARCH_CRON) {
    requireMainRef(env, 'staging search');
    // caller=scheduler takes the scheduled path: renew only, behind STAGING_SEARCH_SCHEDULE_ENABLED.
    return { kind: 'staging-search', workflow: 'staging-search.yml', inputs: { action: 'renew', caller: 'scheduler' } };
  }
  if (cron === PLACE_SURF_CRON || cron === PLACE_DIRECTORY_CRON) {
    requireMainRef(env, 'staging place renewal');
    // The renewal controller hashes its workflow file, so the dispatch uses the existing family
    // input: surf on the surf slots; all three families on the directory and tide slots (one run,
    // so a second pending run can never replace it in the shared staging publication group).
    const family: PlaceFamily = cron === PLACE_SURF_CRON ? 'surf' : 'all';
    return { kind: 'place-renewal', workflow: 'staging-place-renewal.yml', family, inputs: { family } };
  }
  if (cron === GLOFAS_CRON || cron === CAMS_CRON) {
    const family: EnergyFamily = cron === GLOFAS_CRON ? 'glofas' : 'cams';
    const workflow = family === 'glofas' ? env.GLOFAS_GITHUB_WORKFLOW : env.CAMS_GITHUB_WORKFLOW;
    if (workflow !== `${family}-ingest.yml` || env.GITHUB_REF !== 'main') {
      throw new Error(`unsupported energy ${family} ingest workflow or ref`);
    }
    // The workflow takes its run (date / init) from the clock; the dispatch carries no data choice.
    return { kind: 'energy-ingest', workflow, family, inputs: { caller: 'scheduler' } };
  }
  throw new Error(`unsupported scheduler cron: ${cron}`);
}

function githubHeaders(env: CloudflareBindings): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
    'User-Agent': 'weatherx-model-scheduler',
    'X-GitHub-Api-Version': '2026-03-10',
  };
}

function workflowUrl(env: CloudflareBindings, workflow: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/actions/workflows/${encodeURIComponent(workflow)}`;
}

// Reads the runs of this workflow on the dispatch ref created since the slot opened (ten minutes
// before the tick, which covers an on-time GitHub-native fallback and an earlier invocation of
// this tick). Any read failure is 'unreadable' and the dispatch proceeds: every deduped workflow
// is concurrency-guarded and idempotent, so a duplicate costs minutes, a missed slot costs data.
export async function activeRunInSlot(
  workflow: string,
  env: CloudflareBindings,
  scheduledTime: number,
  fetcher: Fetcher = fetch,
): Promise<ActiveRun | null | 'unreadable'> {
  if (!Number.isFinite(scheduledTime)) return 'unreadable';
  const since = new Date(scheduledTime - DEDUPE_LOOKBACK_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const query = new URLSearchParams({
    branch: env.GITHUB_REF, created: `>=${since}`, per_page: '20', exclude_pull_requests: 'true',
  });
  try {
    const response = await fetcher(`${workflowUrl(env, workflow)}/runs?${query}`, {
      method: 'GET',
      headers: githubHeaders(env),
      signal: AbortSignal.timeout(10_000),
    });
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (!response.ok || (Number.isFinite(declaredLength) && declaredLength > MAX_RUNS_BYTES)) {
      await response.body?.cancel();
      return 'unreadable';
    }
    const text = await response.text();
    if (text.length > MAX_RUNS_BYTES) return 'unreadable';
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || !('workflow_runs' in value) || !Array.isArray(value.workflow_runs)) {
      return 'unreadable';
    }
    for (const run of value.workflow_runs as unknown[]) {
      if (!run || typeof run !== 'object') continue;
      const { id, status, event } = run as { id?: unknown; status?: unknown; event?: unknown };
      if (Number.isSafeInteger(id) && typeof status === 'string' && ACTIVE_RUN_STATUSES.has(status)) {
        return { id: Number(id), status, event: typeof event === 'string' ? event : 'unknown' };
      }
    }
    return null;
  } catch {
    return 'unreadable';
  }
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
  scheduledTime: number = Date.now(),
): Promise<DispatchResult> {
  const plan = dispatchForSchedule(cron, env);
  let dedupe: Dedupe = 'clear';
  if (plan.kind !== 'catalog' && plan.kind !== 'satellite-archive') {
    const active = await activeRunInSlot(plan.workflow, env, scheduledTime, fetcher);
    if (active === 'unreadable') dedupe = 'unreadable';
    else if (active) {
      return { kind: 'skipped', lane: plan.kind, workflow: plan.workflow,
        activeRunId: active.id, activeStatus: active.status, activeEvent: active.event };
    }
  }
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
      if (plan.kind === 'energy-ingest') return { kind: 'energy-ingest', family: plan.family, runId, dedupe };
      if (plan.kind === 'whole-bake') return { kind: 'whole-bake', model: 'all', runId, dedupe };
      if (plan.kind === 'fusion-issue') return { kind: 'fusion-issue', scope: 'full', runId, dedupe };
      if (plan.kind === 'staging-search') return { kind: 'staging-search', action: 'renew', runId, dedupe };
      return { kind: 'place-renewal', family: plan.family, runId, dedupe };
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
    const result = await dispatchForCron(controller.cron, env, fetch, defaultSleep, controller.scheduledTime);
    console.log(JSON.stringify({
      event: result.kind === 'skipped' ? 'github_workflow_dispatch_skipped' : 'github_workflow_dispatched',
      cron: controller.cron,
      scheduledTime: new Date(controller.scheduledTime).toISOString(),
      ...result,
      target: result.kind === 'catalog' ? env.CATALOG_TARGET : undefined,
    }));
  },
} satisfies ExportedHandler<CloudflareBindings>;
