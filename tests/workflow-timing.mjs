import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { timingReport } from '../tools/workflow-timing.mjs';

const instant = seconds => `2026-09-12T00:00:${String(seconds).padStart(2, '0')}Z`;
const fixture = () => ({ total_count: 2, jobs: [
  { id: 1, run_id: 20, run_attempt: 1, head_sha: 'a'.repeat(40), name: 'collector',
    status: 'completed', conclusion: 'success', created_at: instant(0), started_at: instant(5), completed_at: instant(30),
    steps: [{ name: 'Install dependencies', started_at: instant(5), completed_at: instant(10), conclusion: 'success' },
      { name: 'Collect', started_at: instant(10), completed_at: instant(30), conclusion: 'success' }] },
  { id: 2, run_id: 20, run_attempt: 1, head_sha: 'a'.repeat(40), name: 'publisher',
    status: 'completed', conclusion: 'failure', created_at: instant(0), started_at: instant(30), completed_at: instant(50),
    steps: [{ name: 'Publish', started_at: instant(30), completed_at: instant(50), conclusion: 'failure' }] },
] });

test('reports waits, heuristic setup, other work, outcomes and longest jobs without claiming publication', () => {
  const report = timingReport(fixture());
  assert.deepEqual({ ...report.outcomes }, { success: 1, failure: 1 });
  assert.equal(report.jobs[0].admissionWaitSeconds, 5);
  assert.equal(report.jobs[0].knownSetupSeconds, 5);
  assert.equal(report.jobs[0].knownOtherWorkSeconds, 20);
  assert.equal(report.longestJobs[0].id, 1);
  assert.equal(report.knownJobSeconds, 45);
  assert.equal(report.runCreatedToCompletedSeconds, null);
  assert.equal(report.completeJobsSpanSeconds, 45);
  assert.match(report.publicationStatus, /^unknown/);
  assert.match(report.interpretation.join(' '), /not pure runner queue/);
});

test('missing, malformed, pseudo and negative timestamps remain unknown including skipped steps', () => {
  for (const start of [undefined, null, '', 'bad', '0001-01-01T00:00:00Z', '1970-01-01T00:00:00Z',
    '2026-02-30T00:00:00Z', instant(59)]) {
    const input = fixture();
    Object.assign(input.jobs[0], { started_at: start, conclusion: 'skipped' });
    Object.assign(input.jobs[0].steps[0], { started_at: start, conclusion: 'skipped' });
    const report = timingReport(input);
    assert.equal(report.jobs[0].durationSeconds, null, String(start));
    assert.equal(report.jobs[0].steps[0].durationSeconds, null, String(start));
    assert.equal(report.jobs[0].unknownStepTimings, 1);
    assert.equal(report.outcomes.skipped, 1);
    assert.equal(report.unknownJobTimings, 1);
    assert.equal(report.completeJobsSpanSeconds, null);
  }
});

test('valid millisecond timestamps and a matching run export are supported', () => {
  const input = fixture(); input.jobs[0].completed_at = '2026-09-12T00:00:30.500Z';
  const report = timingReport(input, { id: 20, run_attempt: 1, head_sha: 'a'.repeat(40),
    conclusion: 'success', created_at: instant(0), completed_at: instant(50) });
  assert.equal(report.jobs[0].durationSeconds, 25.5);
  assert.equal(report.runCreatedToCompletedSeconds, 50);
  assert.equal(report.runCreatedToLastJobCompletionSeconds, 50);
  assert.equal(report.runConclusion, 'success');
  assert.match(report.publicationStatus, /^unknown/);
});

test('offline CLI rejects oversized inputs and unknown options, emits only its bounded projection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'weatherx-timing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'jobs.json');
  const script = new URL('../tools/workflow-timing.mjs', import.meta.url).pathname;
  const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  await writeFile(path, JSON.stringify({ ...fixture(), rawLogs: 'DO_NOT_COPY_THIS_INPUT_FIELD' }));
  const result = run(['--jobs', path]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).jobCount, 2);
  assert.doesNotMatch(result.stdout, /DO_NOT_COPY_THIS_INPUT_FIELD/);
  assert.notEqual(run(['--jobs', path, '--publish']).status, 0);
  await writeFile(path, ' '.repeat(8 * 1024 * 1024 + 1));
  const oversized = run(['--jobs', path]);
  assert.notEqual(oversized.status, 0);
  assert.match(oversized.stderr, /no larger than 8 MiB/);
});

test('pagination must be complete and duplicates, mixed runs, attempts, or sources are refused', () => {
  const input = fixture();
  assert.equal(timingReport(input.jobs.map(job => ({ total_count: 2, jobs: [job] }))).jobCount, 2);
  for (const mutate of [
    value => value.total_count++,
    value => value.total_count = 1001,
    value => value.jobs[1].id = 1,
    value => value.jobs[1].run_id++,
    value => value.jobs[1].run_attempt++,
    value => value.jobs[1].head_sha = 'b'.repeat(40),
    value => value.jobs[1].steps = undefined,
    value => value.jobs[1].name = 'bad\nlabel',
  ]) { const value = fixture(); mutate(value); assert.throws(() => timingReport(value)); }
  assert.throws(() => timingReport(input, { id: 21, run_attempt: 1, head_sha: 'a'.repeat(40) }), /identity differs/);
});
