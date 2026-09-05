import {readFileSync, mkdtempSync, mkdirSync, rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/bake.yml', import.meta.url), 'utf8');
const sections = {
  core: workflow.slice(workflow.indexOf('\n  core:'), workflow.indexOf('\n  regional:')),
  regional: workflow.slice(workflow.indexOf('\n  regional:'), workflow.indexOf('\n  bake:')),
};
const step = (job, name) => {
  const value = job.split(`      - name: ${name}\n`)[1]?.split('      - name:')[0];
  assert.ok(value, `missing ${name}`);
  return value;
};
for (const [kind, job] of Object.entries(sections)) {
  test(`${kind} rejects unsupported recovery before work, normal schedules remain fresh`, () => {
    const guard = step(job, 'reject unsupported recovery before any collector work');
    assert.ok(job.indexOf('reject unsupported recovery') < job.indexOf('uses: actions/checkout'));
    const script = guard.split('        run: |\n')[1].split('\n').map(line => line.replace(/^          /, '')).join('\n');
    for (const [run, event, ref, status] of [
      ['', 'schedule', 'refs/heads/main', 0], ['', 'workflow_dispatch', 'refs/heads/main', 0],
      ['33925520386', 'workflow_dispatch', 'refs/heads/main', 0],
      ['evil', 'workflow_dispatch', 'refs/heads/main', 1],
      ['33925520386', 'schedule', 'refs/heads/main', 1],
      ['33925520386', 'workflow_dispatch', 'refs/heads/feature', 1],
    ]) {
      const result = spawnSync('/bin/bash', ['-ec', script], {encoding: 'utf8', env: {
        RECOVERY_RUN_ID: run, GITHUB_EVENT_NAME: event, GITHUB_REF: ref, PATH: '/usr/bin:/bin',
      }});
      assert.equal(result.status, status, `${kind} ${run} ${event} ${ref}: ${result.stderr}`);
    }
  });

  test(`${kind} token is recovery-step scoped; only a positive admission suppresses collection`, () => {
    const recovery = step(job, `recover only compatible completed ${kind} inputs`);
    assert.match(recovery, /id: recovery/);
    assert.match(recovery, /if: \$\{\{ inputs\.recovery_run_id != '' \}\}/);
    assert.match(recovery, /timeout-minutes: 15/);
    assert.match(recovery, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(recovery, /test "\$\(git -C cycle-controller rev-parse HEAD\)" = "\$GITHUB_SHA"/);
    assert.match(recovery, /test ! -e "\$RUNNER_TEMP\/recovery-controller"/);
    assert.match(recovery, /mv cycle-controller "\$RUNNER_TEMP\/recovery-controller"/);
    assert.ok(recovery.indexOf('mv cycle-controller') < recovery.indexOf('data/.venv/bin/python'));
    assert.match(recovery, /python "\$RUNNER_TEMP\/recovery-controller\/tools\/recover-model-inputs\.py"/);
    assert.match(recovery, /--current-source-sha "\$\(git rev-parse HEAD\)"/);
    assert.equal((job.match(/GH_TOKEN:/g) || []).length, 1);
    assert.doesNotMatch(job.replace(recovery, ''), /github\.token/);
    assert.doesNotMatch(recovery, /R2_|CATALOG_|PAGES|wrangler|curl|continue-on-error|secrets\./);
    const collectName = kind === 'core'
      ? 'collect one core model and seal its map, point and float inputs'
      : 'collect one regional model for the newest complete cycle (one older-cycle fallback)';
    assert.match(step(job, collectName), /if: \$\{\{ steps\.recovery\.outputs\.reused != 'true' \}\}/);
    const checkout = step(job, 'checkout this reviewed recovery controller');
    assert.match(checkout, /repository: Andrewegao\/v3t7kq-cycle/);
    assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/);
    assert.match(checkout, /persist-credentials: false/);
    assert.ok(job.includes('path: ${{ runner.temp }}/' + (kind === 'core' ? 'core-model-packs' : 'regional-packs')));
  });
}
test('only an optional manual input enables recovery; one publisher and all gates remain', () => {
  assert.match(workflow, /recovery_run_id:[\s\S]*?required: false\n\s+default: ''/);
  assert.match(workflow, /permissions:\n\s+contents: read\n\s+actions: read/);
  assert.equal((workflow.match(/run: bash ops\/bake-weatherx.sh/g) || []).length, 1);
  assert.match(workflow, /needs: \[core, regional\]/);
  assert.match(workflow, /needs\.core\.result == 'success' && \(inputs\.recovery_run_id == '' \|\| needs\.regional\.result == 'success'\)/);
  const regionalDownload = step(workflow, 'receive regional display packs from the family jobs');
  assert.match(regionalDownload, /continue-on-error: \$\{\{ inputs\.recovery_run_id == '' \}\}/);
  const transfer = step(workflow, 'verify every recovery transfer before assembly');
  assert.match(transfer, /--verify-transfers --run-id "\$RECOVERY_RUN_ID"/);
  assert.match(transfer, /--core-packs "\$RUNNER_TEMP\/core-model-packs" --regional-packs "\$RUNNER_TEMP\/regional-packs"/);
  assert.doesNotMatch(transfer, /continue-on-error|GH_TOKEN|secrets\./);
  assert.ok(workflow.indexOf('verify every recovery transfer before assembly') < workflow.indexOf('name: bake → gate → publish immutable data release'));
  assert.match(step(workflow, 'bake → gate → publish immutable data release'), /WEATHERX_RECOVERY_RUN_ID: \$\{\{ inputs\.recovery_run_id \|\| '' \}\}/);
  for (const recovery of ['', '33925520386']) {
    for (const core of ['success', 'failure']) {
      for (const regional of ['success', 'failure']) {
        const canPublish = core === 'success' && (recovery === '' || regional === 'success');
        if (recovery !== '' && regional === 'failure') assert.equal(canPublish, false);
        if (recovery === '' && core === 'success') assert.equal(canPublish, true);
      }
    }
  }
  assert.doesNotMatch(workflow, /pages deploy|UI_PRODUCTION_PAGES_TOKEN|skip.gates|relabel/i);
});

test('recovery controller relocation preserves the producer clean-source snapshot', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'weatherx-recovery-checkout-test-'));
  try {
    const atmos = join(temporary, 'atmos');
    const controller = join(atmos, 'cycle-controller');
    const runner = join(temporary, 'runner');
    mkdirSync(controller, {recursive: true});
    mkdirSync(runner);
    const git = (cwd, ...args) => {
      const result = spawnSync('git', ['-C', cwd, ...args], {encoding: 'utf8'});
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    for (const repo of [atmos, controller]) {
      git(repo, 'init', '--quiet');
      git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '--allow-empty', '-m', 'fixture');
    }
    assert.match(git(atmos, 'status', '--porcelain', '--untracked-files=all'), /cycle-controller/);
    const recovery = step(sections.regional, 'recover only compatible completed regional inputs');
    const script = recovery.split('        run: |\n')[1].split('          data/.venv/bin/python')[0]
      .split('\n').map(line => line.replace(/^          /, '')).join('\n');
    const result = spawnSync('/bin/bash', ['-ec', script], {cwd: atmos, encoding: 'utf8', env: {
      ...process.env, RUNNER_TEMP: runner, GITHUB_SHA: git(controller, 'rev-parse', 'HEAD'),
    }});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(atmos, 'status', '--porcelain', '--untracked-files=all'), '');
    assert.equal(git(join(runner, 'recovery-controller'), 'status', '--porcelain'), '');
  } finally {
    rmSync(temporary, {recursive: true, force: true});
  }
});
