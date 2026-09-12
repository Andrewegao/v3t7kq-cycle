#!/usr/bin/env node
// Offline projection of exported GitHub metadata. Never fetches, dispatches or writes files.
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_JOBS = 1000;
const MAX_STEPS = 300;
const SETUP = /(?:^Set up job$|^Post |checkout|check out|setup-(?:node|python)|set up (?:node|python)|npm ci|install|dependencies|\bdeps\b|venv|provision.*runtime|system eccodes|playwright chromium)/i;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const boundedLabel = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  check(typeof value === 'string' && value.length <= 500 && !/[\x00-\x1f]/.test(value), 'invalid metadata label');
  return value;
};
const id = value => {
  check(Number.isSafeInteger(value) && value > 0, 'invalid GitHub numeric identity');
  return value;
};

function timestamp(value) {
  if (typeof value !== 'string' || !/^(?:20\d{2}|[3-9]\d{3})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString() === value.replace(/(?<!\.\d{3})Z$/, '.000Z') ? parsed : null;
}

function interval(start, end) {
  const first = timestamp(start), last = timestamp(end);
  return first === null || last === null || last < first ? null : (last - first) / 1000;
}

export function normalizeJobs(input) {
  const pages = Array.isArray(input) ? input : [input];
  check(pages.length > 0 && pages.length <= 100, 'expected bounded GitHub jobs page(s)');
  for (const page of pages) check(object(page) && Array.isArray(page.jobs)
    && Number.isSafeInteger(page.total_count) && page.total_count >= 0 && page.total_count <= MAX_JOBS,
  'expected GitHub jobs response with total_count');
  check(pages.every(page => page.total_count === pages[0].total_count), 'inconsistent paginated job counts');
  const jobs = pages.flatMap(page => page.jobs);
  check(jobs.length === pages[0].total_count, 'incomplete jobs export; include every API page');
  check(new Set(jobs.map(job => id(job.id))).size === jobs.length, 'duplicate exported job identities');
  check(new Set(jobs.map(job => id(job.run_id))).size <= 1, 'jobs from different workflow runs cannot be combined');
  check(new Set(jobs.map(job => id(job.run_attempt))).size <= 1, 'jobs from different attempts cannot be combined');
  check(jobs.every(job => typeof job.head_sha === 'string' && /^[a-f0-9]{40}$/.test(job.head_sha)), 'invalid source identity');
  check(new Set(jobs.map(job => job.head_sha)).size <= 1, 'jobs from different sources cannot be combined');
  return jobs;
}

export function timingReport(input, run) {
  const jobs = normalizeJobs(input);
  if (run !== undefined) {
    check(object(run), 'expected GitHub workflow run response');
    id(run.id); id(run.run_attempt);
    check(typeof run.head_sha === 'string' && /^[a-f0-9]{40}$/.test(run.head_sha), 'invalid workflow source identity');
    check(jobs.every(job => job.run_id === run.id && job.run_attempt === run.run_attempt && job.head_sha === run.head_sha),
      'workflow run identity differs from exported jobs');
  }
  const rows = jobs.map(job => {
    check(Array.isArray(job.steps) && job.steps.length <= MAX_STEPS, 'missing or excessive job steps');
    const steps = job.steps.map((step, index) => {
      const name = boundedLabel(step.name, `step ${index + 1}`);
      const duration = interval(step.started_at, step.completed_at);
      return { name, conclusion: boundedLabel(step.conclusion, 'unknown'),
        classification: SETUP.test(name) ? 'setup-heuristic' : 'other-work', durationSeconds: duration };
    });
    const known = steps.filter(step => step.durationSeconds !== null);
    const queue = interval(job.created_at, job.started_at);
    const duration = interval(job.started_at, job.completed_at);
    return {
      id: job.id, name: boundedLabel(job.name, `job ${job.id}`), status: boundedLabel(job.status, 'unknown'),
      conclusion: boundedLabel(job.conclusion, 'unknown'),
      admissionWaitSeconds: queue, durationSeconds: duration,
      knownSetupSeconds: known.filter(step => step.classification === 'setup-heuristic').reduce((sum, step) => sum + step.durationSeconds, 0),
      knownOtherWorkSeconds: known.filter(step => step.classification === 'other-work').reduce((sum, step) => sum + step.durationSeconds, 0),
      unknownStepTimings: steps.length - known.length,
      steps,
    };
  });
  const totals = Object.create(null);
  for (const row of rows) totals[row.conclusion] = (totals[row.conclusion] ?? 0) + 1;
  const knownDurations = rows.filter(row => row.durationSeconds !== null);
  const completeTimeline = jobs.length > 0 && knownDurations.length === jobs.length
    && jobs.every(job => job.status === 'completed');
  const firstStart = completeTimeline ? Math.min(...jobs.map(job => timestamp(job.started_at))) : null;
  const lastCompletion = completeTimeline ? Math.max(...jobs.map(job => timestamp(job.completed_at))) : null;
  return {
    schemaVersion: 1,
    source: 'offline GitHub metadata export; retrieval time not established',
    runId: jobs[0]?.run_id ?? run?.id ?? null,
    runAttempt: jobs[0]?.run_attempt ?? run?.run_attempt ?? null,
    sourceSha: jobs[0]?.head_sha ?? run?.head_sha ?? null,
    runConclusion: boundedLabel(run?.conclusion, 'unknown'),
    runCreatedToCompletedSeconds: run ? interval(run.created_at, run.completed_at) : null,
    completeJobsSpanSeconds: completeTimeline ? (lastCompletion - firstStart) / 1000 : null,
    runCreatedToLastJobCompletionSeconds: completeTimeline && run
      ? interval(run.created_at, new Date(lastCompletion).toISOString()) : null,
    publicationStatus: 'unknown; workflow and job success are not publication receipts',
    interpretation: [
      'Null durations include missing, malformed, sentinel or reversed timestamps; unknown is never zero.',
      'Admission wait includes any dependency, environment, concurrency and runner wait recorded by job creation/start; it is not pure runner queue time.',
      'Setup is a documented name-based heuristic; other-work is the remaining recorded step time, not a verified scientific stage.',
      'Known step sums exclude unknown timings and can omit setup/teardown or gaps. Overlapping jobs are summed, not treated as critical-path or billable minutes.',
      'Complete jobs span is first job start to last job completion only when every exported job has finished with usable timestamps; it excludes earlier dispatch wait and is not a publication latency measurement.',
      'No live clock, API calls, logs, artifacts or publication receipts are read. Retried attempts require separate exports.',
    ],
    jobCount: rows.length, outcomes: totals,
    knownJobSeconds: knownDurations.reduce((sum, row) => sum + row.durationSeconds, 0),
    unknownJobTimings: rows.length - knownDurations.length,
    longestJobs: [...knownDurations].sort((a, b) => b.durationSeconds - a.durationSeconds || a.id - b.id)
      .slice(0, 10).map(({ id, name, conclusion, durationSeconds }) => ({ id, name, conclusion, durationSeconds })),
    jobs: rows.sort((a, b) => a.id - b.id),
  };
}

async function readJson(path) {
  const info = await stat(path);
  check(info.isFile() && info.size <= MAX_BYTES, 'input must be a JSON file no larger than 8 MiB');
  const bytes = await readFile(path);
  check(bytes.length <= MAX_BYTES, 'input exceeds 8 MiB');
  return JSON.parse(bytes.toString('utf8'));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    check((args.length === 2 || args.length === 4) && args[0] === '--jobs'
      && (args.length === 2 || args[2] === '--run'),
    'usage: node tools/workflow-timing.mjs --jobs jobs.json [--run run.json]');
    const report = timingReport(await readJson(args[1]), args[3] ? await readJson(args[3]) : undefined);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
