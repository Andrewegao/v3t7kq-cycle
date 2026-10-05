import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { gate, FREEZE_UNTIL, REPOSITORY } from '../tools/ui-candidate.mjs';

const directory = new URL('../.github/workflows/', import.meta.url);
const workflows = Object.fromEntries(readdirSync(directory).filter(n => /\.ya?ml$/.test(n))
  .map(n => [n, readFileSync(new URL(n, directory), 'utf8')]));
const executable = source => source.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
const dataKeys = ['ATMOS_DEPLOY_KEY', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY'];
// Whole-release publication now uses the same production-only catalog CAS authority.
// These credentials cannot deploy a Pages application.
const maintenanceKeys = [...dataKeys, 'CATALOG_ENDPOINT_PRODUCTION', 'CATALOG_PROMOTION_KEY_PRODUCTION'];
const componentKeys = [...dataKeys, 'CATALOG_ENDPOINT', 'CATALOG_ENDPOINT_PRODUCTION',
  'CATALOG_PROMOTION_KEY', 'CATALOG_PROMOTION_KEY_PRODUCTION'];

function assertDataOnly(source, allowedKeys) {
  const text = executable(source);
  assert.doesNotMatch(text, /secrets\s*\[|secrets:\s*inherit/);
  for (const [, key] of text.matchAll(/secrets\.([A-Za-z0-9_]+)/g))
    assert.ok(allowedKeys.includes(key), `data job must not receive ${key}`);
  assert.doesNotMatch(text, /(?:actions|contents|deployments):\s*write|write-all/);
  assert.doesNotMatch(text, /\bpages\s+(?:deploy|deployment)|deploy-(?:atmos|code-only)\.sh|guard-pages-deploy|ui-release\.mjs/);
  assert.doesNotMatch(text, /gh\s+(?:workflow\s+run|api)|\/dispatches\b|workflow_dispatch\s*\(/);
  assert.doesNotMatch(text, /uses:\s*[^\n]*(?:ui-release|ui-staging)/);
}

function assertBakeDataOnly(source) {
  // Provider access is confined to this execution step; it is not a shared data credential.
  const text = executable(source);
  const marker = '      - name: bake → gate → publish immutable data release\n';
  const parts = text.split(marker);
  assert.equal(parts.length, 2, 'one whole-bake execution step is required');
  const execution = parts[1].split(/^      - /m)[0];
  const envs = [...execution.matchAll(/^        env:\n((?:^          .*\n|^\s*\n)*)/gm)];
  assert.equal(envs.length, 1, 'one whole-bake execution environment is required');
  const providerLine = '          OPENAQ_API_KEY: ${{ secrets.OPENAQ_API_KEY }}\n';
  assert.ok(envs[0][1].includes(providerLine), 'OpenAQ key belongs only in the execution env');
  assert.match(execution, /^        run: bash ops\/bake-weatherx\.sh$/m);
  const withoutProvider = text.replace(providerLine, '');
  assert.doesNotMatch(withoutProvider, /\bOPENAQ_API_KEY\b/, 'OpenAQ reference outside its one execution env');
  source = withoutProvider;
  const blocks = [...source.matchAll(/^  staging-wind100:\n[\s\S]*?(?=^  [a-z][a-z0-9-]*:|$(?![\s\S]))/gm)];
  assert.equal(blocks.length, 1, 'one isolated recurring wind caller is required');
  const block = blocks[0][0];
  assert.match(block, /^    uses: \.\/\.github\/workflows\/staging-wind100-recurring.yml$/m);
  assert.doesNotMatch(block, /^\s+(?:steps|run|env):/m);
  assertDataOnly(block, ['ATMOS_DEPLOY_KEY', 'STAGING_R2_WRITE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_SECRET_ACCESS_KEY']);
  const productionBlocks = [...source.matchAll(/^  production-wind100:\n[\s\S]*?(?=^  [a-z][a-z0-9-]*:|$(?![\s\S]))/gm)];
  assert.equal(productionBlocks.length, 1, 'one protected production Wind100 caller is required');
  const productionBlock = productionBlocks[0][0];
  assert.match(productionBlock, /^    uses: \.\/\.github\/workflows\/production-wind100-recurring\.yml$/m);
  assert.doesNotMatch(productionBlock, /^\s+(?:steps|run|env):/m);
  assertDataOnly(productionBlock, ['ATMOS_DEPLOY_KEY', 'PRODUCTION_WIND100_R2_ACCESS_KEY_ID',
    'PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY']);
  // Staging writer slots remain forbidden everywhere else in the legacy bake.
  assertDataOnly(source.replace(block, '').replace(productionBlock, ''), maintenanceKeys);
}

test('both data bakes and legacy backfill have no UI credential or dispatch capability', () => {
  assertBakeDataOnly(workflows['bake.yml']);
  assertDataOnly(workflows['catalog-bake.yml'], componentKeys);
  assertDataOnly(workflows['verify-backfill.yml'], ['ATMOS_DEPLOY_KEY']);
  for (const name of ['collect-core-model.yml', 'collect-regional-model.yml'])
    assertDataOnly(workflows[name], ['ATMOS_DEPLOY_KEY']);
  assertDataOnly(workflows['publish-current-model-production.yml'], maintenanceKeys);
  assertDataOnly(workflows['resume-model-publication.yml'], maintenanceKeys);
  assertDataOnly(workflows['production-wind100-recurring.yml'], ['ATMOS_DEPLOY_KEY',
    'PRODUCTION_WIND100_R2_ACCESS_KEY_ID', 'PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY']);
  assertDataOnly(workflows['production-wind100-retention.yml'], ['ATMOS_DEPLOY_KEY',
    'PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY',
    'PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY']);
  assertDataOnly(workflows['production-wind100-scope-preflight.yml'], [
    'PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY',
    'PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY']);
  assert.match(workflows['bake.yml'], /DATA_PUBLISH_MODE: r2-release/);
  assert.match(workflows['catalog-bake.yml'], /bash ops\/bake-model-component\.sh/);
});

test('OpenAQ provider key is accepted only in its exact whole-bake execution environment', () => {
  const source = workflows['bake.yml'];
  const line = '          OPENAQ_API_KEY: ${{ secrets.OPENAQ_API_KEY }}\n';
  assertBakeDataOnly(source);
  const without = source.replace(line, '');
  for (const [name, changed] of [
    ['unnamed following consumer', source.replace(/(      - name: bake → gate → publish immutable data release\n[^]*?)        env:\n(?:          .*\n)+?(?=        run: bash ops\/bake-weatherx\.sh)/,
      '$1').replace('        run: bash ops/bake-weatherx.sh\n',
      '        run: bash ops/bake-weatherx.sh\n      - uses: actions/example@v1\n        env:\n' + line)],
    ['missing', without],
    ['duplicate', source.replace(line, line + line)],
    ['global', source + '\nenv:\n' + line],
    ['moved to diagnostics', without.replace('          ATMOS_SHA:', line + '          ATMOS_SHA:')],
    ['not a secret', source.replace('secrets.OPENAQ_API_KEY', 'vars.OPENAQ_API_KEY')],
    ['new secret', source.replace('secrets.OPENAQ_API_KEY', 'secrets.OTHER_PROVIDER_KEY')],
    ['dynamic secret', source.replace('secrets.OPENAQ_API_KEY', 'secrets[inputs.key]')],
    ['different env key', source.replace('OPENAQ_API_KEY:', 'OTHER_KEY:')],
    ['wrong execution', source.replace('run: bash ops/bake-weatherx.sh', 'run: bash ops/other.sh')],
    ['not in env', source.replace(line, '').replace('        run: bash ops/bake-weatherx.sh',
      '        with:\n' + line + '        run: bash ops/bake-weatherx.sh')],
    ['extra UI key inside allowed step', source.replace(line, line + '          TOKEN: ${{ secrets.UI_PRODUCTION_PAGES_TOKEN }}\n')],
  ]) assert.throws(() => assertBakeDataOnly(changed), name);
  for (const [name, allowed] of [['catalog-bake.yml', componentKeys],
    ['publish-current-model-production.yml', maintenanceKeys], ['resume-model-publication.yml', maintenanceKeys]]) {
    assert.throws(() => assertDataOnly(workflows[name] + '\n' + line, allowed), name);
  }
});

test('boundary contracts reject legacy key, new UI key, dispatch, inherited secrets and direct upload', () => {
  for (const violation of ['TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}',
    'TOKEN: ${{ secrets.CATALOG_PROMOTION_KEY }}',
    'TOKEN: ${{ secrets.UI_PRODUCTION_PAGES_TOKEN }}', 'TOKEN: ${{ secrets[inputs.key] }}',
    'secrets: inherit', 'actions: write', 'run: gh workflow run ui-release.yml',
    'run: curl https://api.github.com/repos/owner/repo/actions/workflows/ui-release.yml/dispatches',
    'run: npx wrangler pages deploy dist', 'run: bash deploy-atmos.sh']) {
    assert.throws(() => assertBakeDataOnly(`${workflows['bake.yml']}\n${violation}`), violation);
  }
});

test('staging writer slots remain confined to the non-executable wind caller', () => {
  assert.throws(() => assertBakeDataOnly(workflows['bake.yml'] + '\nTOKEN: ${{ secrets.STAGING_R2_WRITE_ACCESS_KEY_ID }}'));
  assert.throws(() => assertBakeDataOnly(workflows['bake.yml'].replace(
    'uses: ./.github/workflows/staging-wind100-recurring.yml', 'uses: ./.github/workflows/collect-core-model.yml')));
});

test('only the protected promotion workflow references the production UI credential', () => {
  for (const [name, source] of Object.entries(workflows)) {
    assert.doesNotMatch(source, /secrets\.CLOUDFLARE_API_TOKEN\b/, `${name}: retired repository-wide Pages credential`);
    if (name !== 'ui-release.yml') assert.doesNotMatch(source, /secrets\.UI_PRODUCTION_PAGES_TOKEN\b/, name);
  }
  assert.match(workflows['ui-release.yml'], /\n    environment:\n      name: ui-production\n/);
  assert.match(workflows['ui-release.yml'], /CLOUDFLARE_API_TOKEN: \$\{\{ secrets.UI_PRODUCTION_PAGES_TOKEN \}\}/);
  assert.match(workflows['gdacs-feed-release.yml'], /PAGES_TOKEN: \$\{\{ secrets.PAGES_READ_TOKEN \}\}/);
});

test('both UI entry points are manual only; bake completion cannot trigger promotion', () => {
  for (const name of ['ui-release.yml', 'ui-staging.yml']) {
    const source = workflows[name];
    const events = source.slice(source.indexOf('\non:\n') + 1, source.indexOf('\npermissions:'));
    assert.match(events, /^on:\n  workflow_dispatch:/);
    assert.deepEqual(events.split('\n').filter(l => /^  [a-z_]+:/.test(l)).map(l => l.trim().split(':')[0]),
      ['workflow_dispatch']);
  }
});

test('retained ground-package approval is scoped to staging and never production', () => {
  assert.match(workflows['ui-staging.yml'], /WX_GROUND_QUALIFICATION_SCOPE: staging-qualification-only/);
  assert.doesNotMatch(workflows['ui-release.yml'], /WX_GROUND_QUALIFICATION_SCOPE/);
});

test('runtime gate rejects every nonmanual event and every unprotected ref', () => {
  const env = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/main', UI_RELEASES_ENABLED: 'true', UI_ISOLATION_APPROVED: 'true',
    UI_DEPLOYMENT_HOLD_UNTIL: FREEZE_UNTIL };
  const now = Date.parse(FREEZE_UNTIL) + 1;
  gate(env, now);
  for (const event of ['schedule', 'push', 'workflow_run', 'workflow_call', 'repository_dispatch', 'pull_request', ''])
    assert.throws(() => gate({ ...env, GITHUB_EVENT_NAME: event }, now));
  for (const ref of ['refs/heads/feature', 'refs/tags/main', 'refs/pull/1/merge', ''])
    assert.throws(() => gate({ ...env, GITHUB_REF: ref }, now));
});
