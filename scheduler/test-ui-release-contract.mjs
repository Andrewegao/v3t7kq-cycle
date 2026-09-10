import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const readWorkflow = (name) => readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const [bake, ui, staging, backfill, satellite] = await Promise.all([
  readWorkflow('bake.yml'),
  readWorkflow('ui-release.yml'),
  readWorkflow('ui-staging.yml'),
  readWorkflow('verify-backfill.yml'),
  readWorkflow('satellite-archive.yml'),
]);
const workflowDirectory = new URL('../.github/workflows/', import.meta.url);
const workflowNames = (await readdir(workflowDirectory)).filter((name) => name.endsWith('.yml'));
const localDataWorkflows = new Set(['collect-core-model.yml', 'collect-regional-model.yml', 'publish-current-model-production.yml']);
function validateUse(line, workflowName) {
  const local = line.match(/^    uses: \.\/\.github\/workflows\/([a-z-]+\.yml)$/);
  if (local && ((workflowName === 'bake.yml' && localDataWorkflows.has(local[1])) ||
      (workflowName === 'resume-model-publication.yml' && local[1] === 'publish-current-model-production.yml'))) {
    // Relative reusable workflows resolve at the caller's exact commit. Their
    // own external actions are scanned by this same loop, not exempted.
    assert.ok(workflowNames.includes(local[1]), 'local data workflow must exist');
    return;
  }
  assert.match(line, /@[a-f0-9]{40}(?:\s+#.*)?$/,
    `${workflowName} must pin every external action to a full commit SHA: ${line.trim()}`);
  assert.doesNotMatch(line, /uses:\s+\.\//, 'local reusable calls must be exact reviewed data lanes');
}

function jobBlocks(workflow) {
  const jobs = workflow.split('\njobs:\n')[1];
  assert.ok(jobs, 'workflow must declare jobs');
  const starts = [...jobs.matchAll(/^  ([a-z0-9-]+):\n/gm)];
  return Object.fromEntries(starts.map((match, index) => [
    match[1],
    jobs.slice(match.index, starts[index + 1]?.index),
  ]));
}
for (const bad of ['    uses: ./.github/workflows/unknown.yml', '    uses: ./.github/workflows/collect-core-model.yml@main',
  '    uses: ./.github/workflows/collect-core-model.yml@' + 'a'.repeat(40), '    uses: actions/checkout@main']) {
  assert.throws(() => validateUse(bad, 'bake.yml'));
}
assert.throws(() => validateUse('    uses: ./.github/workflows/collect-core-model.yml', 'ui-release.yml'));
assert.throws(() => validateUse('    uses: ./.github/workflows/collect-core-model.yml', 'resume-model-publication.yml'));
assert.throws(() => validateUse('    uses: ./.github/workflows/publish-current-model-production.yml@main', 'resume-model-publication.yml'));
for (const workflowName of workflowNames) {
  const workflow = await readWorkflow(workflowName);
  for (const line of workflow.split('\n').filter((candidate) => /\buses:/.test(candidate))) {
    validateUse(line, workflowName);
  }
  if (/secrets\./.test(workflow)) {
    if (workflowName === 'resume-model-publication.yml') {
      // A reusable caller cannot declare environment itself. Its ONLY job
      // delegates to the verified production-environment publisher below.
      assert.deepEqual(workflow.split('jobs:\n')[1].match(/^  [a-z-]+:/gm), ['  resume:']);
      assert.doesNotMatch(workflow, /^\s+(?:steps|run):/m);
      assert.equal((workflow.match(/^    uses:/gm)||[]).length, 1);
      assert.match(workflow, /^    uses: \.\/\.github\/workflows\/publish-current-model-production.yml$/m);
      assert.match(await readWorkflow('publish-current-model-production.yml'), /\n    environment: production\n/);
      continue;
    }
    assert.match(workflow, /\n\s{4}environment:\s*(?:production|staging|\n)/,
      `${workflowName} must place secret-bearing jobs behind a protected environment`);
  }
}

const satelliteJobs = jobBlocks(satellite);
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
    : "inputs.policy == 'storm-window-3d-v1' && vars.SATELLITE_ARCHIVE_STORM_PILOT_ENABLED == '1'";
  assert.ok(block.includes(
    `\n    if: \${{ github.event_name == '${event}' && github.ref == 'refs/heads/main' && ${approval} }}\n`,
  ), `${name} must reject the wrong event, ref or independent approval before secrets are available`);
  assert.equal((block.match(/ssh-key: \$\{\{ secrets\.ATMOS_DEPLOY_KEY \}\}/g) || []).length, 1);
  assert.equal((block.match(/persist-credentials: false/g) || []).length, 1,
    `${name} private checkout must not persist its deploy key`);
}

assert.match(bake, /group: weatherx-data-maintenance/,
  'the multi-hour data bake must not occupy the UI release lane');
assert.match(bake, /DATA_PUBLISH_MODE: r2-release/,
  'the multi-hour bake must publish an immutable R2 release instead of Pages');
assert.match(bake, /R2_REMOTE: weatherx:weatherx-data-production/);
assert.match(bake, /R2_PRODUCTION_ACCESS_KEY_ID/);
assert.match(bake, /R2_PRODUCTION_SECRET_ACCESS_KEY/);
assert.doesNotMatch(bake, /CLOUDFLARE_API_TOKEN\b|deploy-atmos\.sh|deploy-code-only\.sh|code_only/,
  'the data-maintenance workflow must have no Pages deployment capability');

assert.match(ui, /group: weatherx-ui-production/,
  'UI releases need their own short production serialization boundary');
assert.match(ui, /environment:[\s\S]*?name: ui-production/);
assert.match(staging, /environment:[\s\S]*?name: ui-staging/);
for (const workflow of [ui, staging]) {
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  (push|schedule|workflow_run|repository_dispatch|workflow_call|pull_request):/m);
  assert.match(workflow, /UI_RELEASES_ENABLED: \$\{\{ vars.UI_RELEASES_ENABLED \}\}/);
  assert.match(workflow, /UI_DEPLOYMENT_HOLD_UNTIL:/);
  assert.match(workflow, /UI_ISOLATION_APPROVED:/);
  assert.doesNotMatch(workflow, /secrets\.CLOUDFLARE_API_TOKEN\b/,'legacy repo-wide Pages key must not bypass environment boundaries');
  assert.match(workflow, /persist-credentials: false/);
}
for (const input of ['atmos_sha','staging_run_id','candidate_digest']) assert.ok(ui.includes(`${input}:`));
assert.match(ui, /node cycle\/tools\/ui-release.mjs download/);
assert.match(ui, /node cycle\/tools\/ui-release.mjs deploy production/);
assert.doesNotMatch(ui, /deploy-code-only|deploy-atmos|npm (?:run )?build|ref: \$\{\{ inputs\.atmos_sha/,
  'production must not rebuild or check out the candidate source');
assert.match(staging, /test "\$ATMOS_SHA" = "\$\(git rev-parse origin\/master\)"/);
assert.match(staging, /ref: \$\{\{ inputs\.atmos_sha \}\}/);
assert.match(staging, /npm test --prefix atmos\/app/);
assert.match(staging, /LIVE_DATA: '1'[\s\S]*?bash ops\/weather-lab-ready.sh/);
assert.match(staging, /VITE_PLATFORM_ACCOUNT: '0'/);
assert.match(staging, /VITE_MODEL_EXPANSION_QUALIFICATION: '0'/);
assert.match(staging, /secrets.UI_STAGING_PAGES_TOKEN/);
assert.doesNotMatch(staging, /UI_PRODUCTION_PAGES_TOKEN/);
assert.match(ui, /secrets.UI_PRODUCTION_PAGES_TOKEN/);
assert.doesNotMatch(ui, /UI_STAGING_PAGES_TOKEN/);
assert.match(staging, /ui-sealed\/\*/);
assert.doesNotMatch(staging, /path:.*(?:app\/dist|app\/functions|control\/|atmos\/)/);
assert.doesNotMatch(backfill, /CLOUDFLARE_API_TOKEN|deploy-atmos|deploy-code-only/,'archive backfill must not publish UI');
assert.doesNotMatch(ui, /R2_PRODUCTION_(?:ACCESS_KEY_ID|SECRET_ACCESS_KEY)|publish-r2-release|bake-weatherx/,
  'the UI lane must not mutate model, ledger, or R2 release state');
assert.match(staging, /node ops\/platform\/test-independent-ui-release\.mjs/);
assert.match(staging, /name: full application test gate[\s\S]*?npm test --prefix atmos\/app/,
  'the release job must independently rerun the complete application tests');
assert.match(staging, /name: Weather Lab release gate[\s\S]*?LIVE_DATA: '1'[\s\S]*?bash ops\/weather-lab-ready\.sh/,
  'the independent UI gate must exercise the live data edge without mirroring data into Pages');
assert.match(ui, /actions\/upload-artifact@[a-f0-9]{40}[\s\S]*?ui-incidents/,
  'rollback evidence must survive a failed UI release');
assert.doesNotMatch(ui, /uses:\s+[^\n#]+@v[0-9]/,
  'production workflows must pin every action to an immutable commit SHA');

console.log('independent UI release workflow contract: ok');
