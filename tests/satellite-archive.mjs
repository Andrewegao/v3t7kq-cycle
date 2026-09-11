import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';

const workflowPath = new URL('../.github/workflows/satellite-archive.yml', import.meta.url);
const workflow = readFileSync(workflowPath, 'utf8');
const sha256 = payload => createHash('sha256').update(payload).digest('hex');

function literal(name) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}: |`);
  assert.notEqual(start, -1, `${name} literal exists`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith('    ')) break;
    body.push(line ? line.slice(4) : '');
  }
  return body.join('\n');
}

function jobBlocks(source) {
  const jobs = source.split('\njobs:\n')[1];
  assert.ok(jobs, 'workflow must declare jobs');
  const starts = [...jobs.matchAll(/^  ([a-z0-9-]+):\n/gm)];
  return Object.fromEntries(starts.map((match, index) => [
    match[1],
    jobs.slice(match.index, starts[index + 1]?.index),
  ]));
}

const controller = literal('SATELLITE_FAILURE_EVIDENCE_SCRIPT');

function canonical(value) {
  // The controller validates content addressing, not a particular JSON pretty-printing style.
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function writeAddressed(root, relativeDirectory, body) {
  const payload = canonical(body);
  const digest = sha256(payload);
  const path = join(root, relativeDirectory, `${digest}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, payload);
  return { digest, path, payload, relative: `${relativeDirectory}/${digest}.json` };
}

function counts(statuses) {
  const result = { requested: statuses.length, baked: 0, sourceMissing: 0, checkpointVerified: 0, localExisting: 0, error: 0 };
  const names = { baked: 'baked', 'source-missing': 'sourceMissing', 'checkpoint-verified': 'checkpointVerified', 'local-existing': 'localExisting', error: 'error' };
  for (const status of statuses) result[names[status]] += 1;
  return result;
}

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'satellite-failure-evidence-'));
  const root = join(cwd, 'app/public/data-atmos/sat-archive/sat/v1');
  const runner = join(cwd, 'runner');
  mkdirSync(root, { recursive: true });
  mkdirSync(runner);
  return { cwd, root, runner, output: join(cwd, 'github-output') };
}

function runController(f, extra = {}) {
  return spawnSync('python3', ['-c', controller], {
    cwd: f.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      RUNNER_TEMP: f.runner,
      GITHUB_OUTPUT: f.output,
      GITHUB_RUN_ID: '123',
      GITHUB_RUN_ATTEMPT: '2',
      SATELLITE_EVIDENCE_JOB: 'hourly',
      ...extra,
    },
  });
}

function filesBelow(root) {
  const found = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else found.push(relative(root, path).replaceAll('\\', '/'));
    }
  };
  walk(root);
  return found.sort();
}

test('failure artifact keeps only bounded content-addressed acquisition evidence', () => {
  const f = fixture();
  try {
    const receipt = writeAddressed(f.root, 'provenance/batches', {
      schemaVersion: 1,
      kind: 'weatherx-satellite-source-receipt-v1',
      family: 'gmgsi',
      transformVersion: 'fixture-v1',
      frames: [{ outputPath: 'ir/2026/09/10/12.webp', sourceUrl: 'https://example.test/frame' }],
    });
    const successful = writeAddressed(f.root, 'provenance/acquisitions/gmgsi', {
      schemaVersion: 1,
      kind: 'weatherx-satellite-acquisition-run-v1',
      family: 'gmgsi',
      complete: true,
      outcomes: [{ outputPath: 'ir/2026/09/10/12.webp', status: 'baked' }],
      counts: counts(['baked']),
      runErrors: [],
      sourceReceipt: { path: receipt.relative, bytes: receipt.payload.length, sha256: receipt.digest },
    });
    const failed = writeAddressed(f.root, 'provenance/acquisitions/radar-us', {
      schemaVersion: 1,
      kind: 'weatherx-satellite-acquisition-run-v1',
      family: 'radar-us',
      complete: false,
      outcomes: [{ outputPath: 'radar-us/2026/09/10/1200.webp', status: 'local-existing' }],
      counts: counts(['local-existing']),
      runErrors: ['publication finalization failed: catalog is unproven'],
      sourceReceipt: null,
    });
    mkdirSync(join(f.root, 'ir/2026/09/10'), { recursive: true });
    writeFileSync(join(f.root, 'ir/2026/09/10/12.webp'), 'raw-rendered-frame-must-not-leave-runner');
    writeFileSync(join(f.cwd, 'credential.txt'), 'must-not-leave-runner');

    const result = runController(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.output, 'utf8'), 'has_evidence=1\n');
    const target = join(f.runner, 'satellite-acquisition-failure-evidence');
    assert.deepEqual(filesBelow(target), [
      'failure-evidence-manifest.json',
      successful.relative,
      failed.relative,
      receipt.relative,
    ].sort());
    const manifest = JSON.parse(readFileSync(join(target, 'failure-evidence-manifest.json'), 'utf8'));
    assert.equal(manifest.kind, 'weatherx-satellite-failure-evidence-artifact-v1');
    assert.equal(manifest.job, 'hourly');
    assert.deepEqual(manifest.limits, {
      ledgers: 4,
      ledgerBytes: 4 * 1024 * 1024,
      receipts: 4,
      receiptBytes: 32 * 1024 * 1024,
    });
    assert.deepEqual(manifest.files.map(file => file.path).sort(), [successful.relative, failed.relative, receipt.relative].sort());
    for (const file of manifest.files) {
      const payload = readFileSync(join(target, file.path));
      assert.equal(payload.length, file.bytes);
      assert.equal(sha256(payload), file.sha256);
    }
  } finally {
    rmSync(f.cwd, { recursive: true, force: true });
  }
});

test('missing evidence is an honest no-artifact result', () => {
  const f = fixture();
  try {
    const result = runController(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(f.output, 'utf8'), 'has_evidence=0\n');
    assert.throws(() => readdirSync(join(f.runner, 'satellite-acquisition-failure-evidence')));
  } finally {
    rmSync(f.cwd, { recursive: true, force: true });
  }
});

test('digest, count and byte limit violations fail closed without an artifact', () => {
  for (const corruption of ['digest', 'count', 'bytes']) {
    const f = fixture();
    try {
      const directory = join(f.root, 'provenance/acquisitions/gmgsi');
      mkdirSync(directory, { recursive: true });
      if (corruption === 'digest') {
        writeFileSync(join(directory, `${'0'.repeat(64)}.json`), '{}\n');
      } else if (corruption === 'bytes') {
        writeFileSync(join(directory, `${'0'.repeat(64)}.json`), Buffer.alloc(4 * 1024 * 1024 + 1));
      } else {
        for (let index = 0; index < 5; index += 1) {
          writeAddressed(f.root, 'provenance/acquisitions/gmgsi', {
            schemaVersion: 1,
            kind: 'weatherx-satellite-acquisition-run-v1',
            family: 'gmgsi',
            complete: false,
            outcomes: [{ outputPath: `ir/2026/09/10/${String(index).padStart(2, '0')}.webp`, status: 'error' }],
            counts: counts(['error']),
            runErrors: [],
            sourceReceipt: null,
            nonce: index,
          });
        }
      }
      const result = runController(f);
      assert.notEqual(result.status, 0, `${corruption} unexpectedly passed`);
      assert.throws(() => readdirSync(join(f.runner, 'satellite-acquisition-failure-evidence')));
    } finally {
      rmSync(f.cwd, { recursive: true, force: true });
    }
  }
});

test('hourly and backfill failure retention remain protected and secret-free', () => {
  const satelliteJobs = jobBlocks(workflow);
  const satelliteSecretJobs = Object.entries(satelliteJobs)
    .filter(([, block]) => /secrets\./.test(block))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(satelliteSecretJobs, ['backfill', 'backfill-plan', 'hourly']);
  for (const name of satelliteSecretJobs) {
    const block = satelliteJobs[name];
    const event = name === 'hourly' ? 'schedule' : 'workflow_dispatch';
    assert.match(block, /\n    environment:\n      name: satellite-archive\n/,
      `${name} must use the dedicated protected satellite environment`);
    const approval = name === 'hourly'
      ? "vars.SATELLITE_ARCHIVE_ENABLED == '1'"
      : "((inputs.policy == 'storm-window-3d-v1' && vars.SATELLITE_ARCHIVE_STORM_PILOT_ENABLED == '1') || (inputs.policy == 'rolling-year-v1' && vars.SATELLITE_ARCHIVE_ROLLING_YEAR_ENABLED == '1'))";
    assert.ok(block.includes(
      `\n    if: \${{ github.event_name == '${event}' && github.ref == 'refs/heads/main' && ${approval} }}\n`,
    ), `${name} must reject the wrong event, ref or independent approval before secrets are available`);
    assert.equal((block.match(/ssh-key: \$\{\{ secrets\.ATMOS_DEPLOY_KEY \}\}/g) || []).length, 1);
    assert.equal((block.match(/persist-credentials: false/g) || []).length, 1,
      `${name} private checkout must not persist its deploy key`);
  }
  assert.equal((workflow.match(/stage bounded acquisition evidence after failure/g) ?? []).length, 2);
  assert.equal((workflow.match(/retain bounded acquisition evidence after failure/g) ?? []).length, 2);
  assert.equal((workflow.match(/actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/g) ?? []).length, 2);
  assert.equal((workflow.match(/if: \$\{\{ failure\(\) \}\}/g) ?? []).length, 2);
  assert.equal((workflow.match(/failure\(\) && steps\.acquisition_failure_evidence\.outputs\.has_evidence == '1'/g) ?? []).length, 2);
  assert.equal((workflow.match(/path: \$\{\{ runner\.temp \}\}\/satellite-acquisition-failure-evidence/g) ?? []).length, 2);
  assert.equal((workflow.match(/retention-days: 14/g) ?? []).length, 2);
  assert.equal((workflow.match(/vars\.SATELLITE_ARCHIVE_ENABLED == '1'/g) ?? []).length, 1);
  assert.equal((workflow.match(/vars\.SATELLITE_ARCHIVE_STORM_PILOT_ENABLED == '1'/g) ?? []).length, 2);
  assert.equal((workflow.match(/inputs\.policy == 'storm-window-3d-v1'/g) ?? []).length, 2);
  assert.equal((workflow.match(/vars\.SATELLITE_ARCHIVE_ROLLING_YEAR_ENABLED == '1'/g) ?? []).length, 2);
  assert.match(satelliteJobs.backfill, /max-parallel: 4/);
  assert.match(satelliteJobs.backfill, /fromJson\(needs.backfill-plan.outputs.month_shards\)/);
  assert.match(satelliteJobs.backfill, /PUBLISH_LATEST: '0'/);
  assert.match(workflow, /--max-inclusive-days 3/);
  assert.match(workflow, /data\/run_satellite_archive_month_shard.py/);
  assert.match(workflow, /SAT_MAX_HTTP_REQUESTS: '432'/);
  assert.match(workflow, /SAT_MAX_SOURCE_BYTES: '2376000000'/);
  assert.match(workflow, /SAT_MAX_OUTPUT_BYTES: '216000000'/);
  assert.match(workflow, /RADAR_MAX_HTTP_REQUESTS: '432'/);
  assert.match(workflow, /RADAR_MAX_SOURCE_BYTES: '4320000000'/);
  assert.match(workflow, /RADAR_MAX_OUTPUT_BYTES: '432000000'/);
  assert.match(workflow, /PUBLISH_VERIFY_MAX_OBJECTS: '648'/);
  assert.match(workflow, /PUBLISH_VERIFY_MAX_BYTES: '648000000'/);
  assert.match(workflow, /PUBLISH_MAX_CLASS_A_OPERATIONS: '660'/);
  assert.match(workflow, /PUBLISH_MAX_CLASS_B_OPERATIONS: '3300'/);
  assert.equal((workflow.match(/environment:\n      name: satellite-archive/g) ?? []).length, 3);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 3);
  for (const name of ['hourly', 'backfill-plan', 'backfill']) {
    const block = satelliteJobs[name];
    assert.match(block, /ARCHIVE_BUDGET_SCOPE: \$\{\{ vars\.SATELLITE_ARCHIVE_BUDGET_SCOPE \|\| 'account' \}\}/);
    assert.match(block, /ARCHIVE_END_DATE: \$\{\{ vars\.SATELLITE_ARCHIVE_BUDGET_END_DATE \}\}/);
    assert.match(block, /ARCHIVE_EXISTING_BYTES: \$\{\{ vars\.SATELLITE_ARCHIVE_EXISTING_BYTES \}\}/);
    assert.match(block, /ARCHIVE_SCOPED_HORIZON_MONTHS: '12'/);
    assert.match(block, /ARCHIVE_MAX_SCOPED_USD: '10'/);
    assert.ok(block.indexOf('run: bash ops/satellite/check-account-budget.sh') < block.indexOf('      - uses: actions/setup-python')
      || name === 'backfill-plan', 'budget must precede downloads and publishing');
  }
  for (const match of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(match[1], /^[\w/-]+@[a-f0-9]{40}$/);
  const retentionBlocks = workflow.split('      - name: retain bounded acquisition evidence after failure\n').slice(1)
    .map(block => block.split('\n      - name:')[0]);
  for (const block of retentionBlocks) {
    assert.doesNotMatch(block, /secrets\.|R2_|ATMOS_DEPLOY_KEY|rclone|curl|\.webp|latest\.json/);
  }
  assert.doesNotMatch(controller, /R2_|SECRET|TOKEN|credential|\.webp['"]|latest\.json|rclone|requests|urlopen/);
});

test('month runner receives exact shard and producer policy separately from budget policy', () => {
  const step = workflow.split('      - name: run bounded transactions for ${{ matrix.month.month }}\n')[1]
    .split('      - name: stage bounded acquisition evidence')[0];
  assert.match(step, /MONTH_SHARD_JSON: \$\{\{ toJson\(matrix.month\) \}\}/);
  assert.match(step, /MONTH_SHARD_POLICY: \$\{\{ inputs.policy \}\}/);
  assert.match(step, /ARCHIVE_POLICY: rolling-year-v1/);
  assert.match(step, /ARCHIVE_END_DATE: \$\{\{ vars.SATELLITE_ARCHIVE_BUDGET_END_DATE \}\}/);
  assert.match(step, /ARCHIVE_BUDGET_SCOPE:/);
  assert.match(step, /PUBLISH_LATEST: '0'/);
  const script = step.split('        run: >-\n')[1].trim().split('\n').map(line => line.trim()).join(' ');
  const cwd = mkdtempSync(join(tmpdir(), 'satellite-month-shard-'));
  try {
    const executable = join(cwd, 'data/.venv/bin/python');
    mkdirSync(dirname(executable), { recursive: true });
    writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGUMENT_LOG"\n');
    chmodSync(executable, 0o700);
    const shard = JSON.stringify({ month: '2026-09', chunks: [{ from: '2026-09-10', to: '2026-09-10' }] });
    for (const policy of ['rolling-year-v1', 'storm-window-3d-v1']) {
      const log = join(cwd, 'args');
      execFileSync('bash', ['-c', script], { cwd, env: {
        ...process.env, MONTH_SHARD_JSON: shard, MONTH_SHARD_POLICY: policy,
        ARCHIVE_POLICY: 'rolling-year-v1', ARGUMENT_LOG: log,
      } });
      assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [
        'data/run_satellite_archive_month_shard.py', '--shard-json', shard, '--policy', policy,
      ]);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('workflow and controller syntax are valid', { skip: process.platform !== 'darwin' }, () => {
  execFileSync('python3', ['-c', 'import sys; compile(sys.stdin.read(), "<workflow>", "exec")'], { input: controller, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('/opt/homebrew/bin/actionlint', ['-shellcheck=', '-pyflakes=', workflowPath.pathname], { stdio: 'pipe' });
});


test('rclone installer metadata cannot collide with rclone runtime options', () => {
  const names = [...workflow.matchAll(/^\s+(RCLONE_[A-Z0-9_]+):/gm)].map(match => match[1]);
  assert.deepEqual([...new Set(names)].sort(), [
    'RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID', 'RCLONE_CONFIG_WEATHERX_ENDPOINT',
    'RCLONE_CONFIG_WEATHERX_PROVIDER', 'RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY',
    'RCLONE_CONFIG_WEATHERX_TYPE',
  ]);
  assert.match(workflow, /SATELLITE_RCLONE_RELEASE: v1\.75\.0/);
  assert.doesNotMatch(workflow, /RCLONE_VERSION|RCLONE_SHA256/);
});


test('hourly and backfill shell helpers inherit the installed Python environment', () => {
  const jobs = jobBlocks(workflow);
  for (const name of ['hourly', 'backfill']) {
    const setup = jobs[name].split('name: venv + python deps')[1].split('name: install rclone')[0];
    assert.match(setup, /echo "\$PWD\/data\/\.venv\/bin" >> "\$GITHUB_PATH"/);
    assert.match(setup, /export PATH="\$PWD\/data\/\.venv\/bin:\$PATH"/);
    assert.match(setup, /PYTHONPATH=data python3 -c/);
    assert.match(setup, /assert sys\.prefix != sys\.base_prefix/);
    assert.ok(setup.indexOf('pip install') < setup.indexOf('PYTHONPATH=data'));
  }
});
