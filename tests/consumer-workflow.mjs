import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const readWorkflow = (name) => readFile(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
const [workflow, ci, legacy] = await Promise.all([
  readWorkflow('consumer-refresh.yml'),
  readWorkflow('scheduler-ci.yml'),
  readWorkflow('data-edge-deploy.yml'),
]);
const refresh = workflow.split('\n  consumer-refresh:\n')[1];
assert.ok(refresh, 'consumer refresh is an isolated manual-only workflow job');

assert.match(workflow, /atmosphere_sha:[\s\S]*?type: string[\s\S]*?required: true/,
  'consumer refresh requires immutable source input');
assert.match(workflow, /expected_release:[\s\S]*?type: string[\s\S]*?required: true/);
assert.match(workflow, /confirm:[\s\S]*?type: string[\s\S]*?required: true/);
assert.match(workflow, /\non:\n  workflow_dispatch:/);
assert.doesNotMatch(workflow.split('\npermissions:')[0], /\n  (?:push|pull_request|schedule|workflow_run|workflow_call):/,
  'consumer refresh must never automatically run after a bake or another workflow');
assert.match(workflow, /concurrency:\n  group: weatherx-production-data-edge\n  cancel-in-progress: false/);
assert.doesNotMatch(refresh, /\n    concurrency:/, 'refresh shares the existing production serialization boundary');
assert.match(refresh, /if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' \}\}/);
assert.match(refresh, /\n    environment: production\n/);
assert.match(refresh, /\n    timeout-minutes: 50\n/,
  'the job reserves time for bounded setup, preflight, activation, and independent recovery');

const step = (name) => {
  const value = refresh.split(`      - name: ${name}\n`)[1]?.split('\n      - ')[0];
  assert.ok(value, `required refresh step: ${name}`);
  return value;
};
const validation = step('Require immutable consumer-refresh confirmation');
assert.match(validation, /CONFIRM: \$\{\{ inputs\.confirm \}\}/);
assert.match(validation, /ATMOSPHERE_SHA: \$\{\{ inputs\.atmosphere_sha \}\}/);
assert.match(validation, /EXPECTED_RELEASE: \$\{\{ inputs\.expected_release \}\}/);
const validationScript = validation.split('        run: |\n')[1]
  .split('\n').map((line) => line.startsWith('          ') ? line.slice(10) : line).join('\n');
assert.doesNotMatch(validationScript, /\$\{\{/, 'user inputs must enter shell through environment variables');
const validInput = {
  ...process.env,
  CONFIRM: 'REFRESH-PRODUCTION-CONSUMERS',
  ATMOSPHERE_SHA: 'e4799774847788708fd9bd3fdef577369e2782c7',
  EXPECTED_RELEASE: 'release-20260830T120000Z',
};
const validate = (overrides) => spawnSync('bash', ['-e', '-o', 'pipefail', '-c', validationScript], {
  encoding: 'utf8', env: { ...validInput, ...overrides },
});
assert.equal(validate({}).status, 0, 'the exact confirmation and immutable source are accepted');
assert.equal(validate({ EXPECTED_RELEASE: 'r'.repeat(96) }).status, 0,
  'the workflow accepts the helper maximum release identifier length');
for (const overrides of [
  { CONFIRM: '' }, { CONFIRM: 'ENABLE-PRODUCTION-CATALOG' },
  { ATMOSPHERE_SHA: '' }, { ATMOSPHERE_SHA: 'master' }, { ATMOSPHERE_SHA: 'e479977' },
  { ATMOSPHERE_SHA: `${validInput.ATMOSPHERE_SHA}\n` }, { ATMOSPHERE_SHA: 'A'.repeat(40) },
  { EXPECTED_RELEASE: '' }, { EXPECTED_RELEASE: '../current' }, { EXPECTED_RELEASE: 'release/one' },
  { EXPECTED_RELEASE: 'release; echo unsafe' }, { EXPECTED_RELEASE: 'release\nother' },
  { EXPECTED_RELEASE: 'r'.repeat(97) },
]) {
  assert.notEqual(validate(overrides).status, 0, `invalid refresh input fails closed: ${JSON.stringify(overrides)}`);
}

const cycleCheckout = step('Checkout the exact cycle workflow source');
assert.match(cycleCheckout, /ref: \$\{\{ github\.sha \}\}/);
assert.match(cycleCheckout, /path: cycle\n/);
assert.match(cycleCheckout, /persist-credentials: false/);
assert.match(cycleCheckout, /timeout-minutes: 2\n/);
const atmosCheckout = step('Checkout the exact reviewed Atmos source');
assert.match(atmosCheckout, /repository: Andrewegao\/atmos/);
assert.match(atmosCheckout, /ref: \$\{\{ inputs\.atmosphere_sha \}\}/);
assert.match(atmosCheckout, /fetch-depth: 0/);
assert.match(atmosCheckout, /path: atmos\n/);
assert.match(atmosCheckout, /persist-credentials: false/);
assert.match(atmosCheckout, /timeout-minutes: 2\n/);
assert.match(refresh, /actions\/setup-node@[a-f0-9]{40} # v4\n        timeout-minutes: 2\n/);
const provenance = step('Verify immutable source provenance');
assert.match(provenance, /test "\$\(git -C cycle rev-parse HEAD\)" = "\$CYCLE_SHA"/);
assert.match(provenance, /test "\$\(git -C atmos rev-parse HEAD\)" = "\$ATMOSPHERE_SHA"/);
assert.match(provenance, /git -C atmos merge-base --is-ancestor "\$ATMOSPHERE_SHA" refs\/remotes\/origin\/master/);
assert.doesNotMatch(provenance, /git[^\n]*(?:fetch|pull)/,
  'ancestry uses checkout-fetched history without retaining the private deploy credential');
assert.match(step('Install locked consumer dependencies'), /working-directory: atmos\/platform\/edge\n        run: npm ci/);
assert.match(step('Run the complete consumer release gates'), /working-directory: atmos\/platform\/edge\n        run: npm run check/);
assert.match(step('Run consumer refresh safety contracts'), /node cycle\/tests\/consumer-workflow\.mjs[\s\S]*node --test cycle\/tests\/consumer-refresh\*\.mjs/);
assert.match(step('Install locked consumer dependencies'), /timeout-minutes: 5\n/);
assert.match(step('Run the complete consumer release gates'), /timeout-minutes: 5\n/);
assert.match(step('Run consumer refresh safety contracts'), /timeout-minutes: 2\n/);

for (const [name, command] of [
  ['Capture and validate the unchanged production boundary', 'preflight'],
  ['Refresh both consumers with guarded verification and rollback', 'execute'],
  ['Recover prior consumer versions after an interrupted refresh', 'recover'],
]) {
  const value = step(name);
  assert.match(value, /DATA_EDGE_TOKEN: \$\{\{ secrets\.CLOUDFLARE_DATA_EDGE_API_TOKEN \}\}/);
  assert.match(value, /PLATFORM_EDGE_TOKEN: \$\{\{ secrets\.CLOUDFLARE_WORKERS_API_TOKEN \}\}/);
  assert.match(value, new RegExp(`node cycle/tools/consumer-refresh\\.mjs ${command}`));
  for (const argument of ['--atmos atmos', '--receipt "$REFRESH_RECEIPT"', '--release "$EXPECTED_RELEASE"', '--sha "$ATMOSPHERE_SHA"']) {
    assert.ok(value.includes(argument), `${command} requires ${argument}`);
  }
  assert.doesNotMatch(value, /continue-on-error:/, 'refresh safety steps must fail closed');
  if (command !== 'recover') assert.doesNotMatch(value, /if:/,
    'preflight and execution cannot bypass earlier gates');
}
assert.match(step('Capture and validate the unchanged production boundary'), /timeout-minutes: 6\n/);
assert.match(step('Refresh both consumers with guarded verification and rollback'), /id: refresh\n/);
assert.match(step('Refresh both consumers with guarded verification and rollback'), /timeout-minutes: 14\n/);
const recovery = step('Recover prior consumer versions after an interrupted refresh');
assert.match(recovery, /timeout-minutes: 6\n/);
assert.match(recovery, /if: \$\{\{ always\(\) && \(steps\.refresh\.outcome == 'failure' \|\| steps\.refresh\.outcome == 'cancelled'\) \}\}/,
  'independent recovery handles failures and cancellations but never successful or skipped execution');
assert.ok(refresh.indexOf('name: Run the complete consumer release gates') < refresh.indexOf('consumer-refresh.mjs preflight'));
assert.ok(refresh.indexOf('consumer-refresh.mjs preflight') < refresh.indexOf('consumer-refresh.mjs execute'));
assert.ok(refresh.indexOf('consumer-refresh.mjs execute') < refresh.indexOf('consumer-refresh.mjs recover'));
assert.ok(refresh.indexOf('consumer-refresh.mjs recover') < refresh.indexOf('name: Retain the non-sensitive consumer refresh receipt'));
assert.doesNotMatch(refresh, /wrangler |secret bulk|secrets-file|publish-r2|catalog-bake|bake-weatherx|pages deploy|workflow run/,
  'refresh delegates only bounded consumer deployment, never secrets, data publication, a bake, or Pages');
assert.doesNotMatch(refresh, /secrets\.(?:CLOUDFLARE_API_TOKEN|R2_PRODUCTION_ACCESS_KEY_ID|R2_PRODUCTION_SECRET_ACCESS_KEY)\b/);
const receipt = step('Retain the non-sensitive consumer refresh receipt');
assert.match(receipt, /if: \$\{\{ always\(\) \}\}/);
assert.match(receipt, /actions\/upload-artifact@[a-f0-9]{40}/);
assert.match(receipt, /path: \$\{\{ runner\.temp \}\}\/consumer-refresh\/receipt\.json/);
assert.doesNotMatch(receipt, /path:.*\*/);
assert.match(ci, /"\.github\/workflows\/consumer-refresh\.yml"/);
assert.match(ci, /"tools\/\*\*"/);
assert.match(ci, /node tests\/consumer-workflow\.mjs/);
assert.match(ci, /node --test tests\/consumer-refresh\*\.mjs/);
assert.doesNotMatch(legacy, /CLOUDFLARE_WORKERS_API_TOKEN|consumer-refresh/,
  'existing catalog cutover workflow keeps its dedicated data-edge-only authority');
// This narrow repair intentionally does not change either reviewed legacy file.
// A future intentional cutover redesign must review and update these pins explicitly.
assert.equal(createHash('sha256').update(legacy).digest('hex'),
  '01f1f999cc424172d8064e71a015d56c2bc32577c5bbbcefbae6ef0118273905',
  'legacy bootstrap/shadow/serve workflow remains byte-for-byte unchanged');
assert.equal(createHash('sha256').update(await readFile(
  new URL('../scheduler/test-production-cutover-contract.mjs', import.meta.url),
)).digest('hex'), 'abbecf8b749f54f15ede259b4daa379486ce3b835c831ffd45dcb616aa9c87c6',
  'the existing dedicated data-edge credential contract remains byte-for-byte unchanged');
assert.doesNotMatch(await readWorkflow('scheduler-deploy.yml'), /consumer-refresh|"tools\/\*\*"|"tests\/\*\*"/,
  'adding consumer tooling must not trigger scheduler deployment');

console.log('consumer refresh workflow contracts: ok');
