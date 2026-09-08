import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {admitSourceProbe} from '../tools/source-checkout-probe.mjs';

const env = {GITHUB_ACTIONS:'true', GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',
  GITHUB_EVENT_NAME:'workflow_dispatch', GITHUB_REF:'refs/heads/main',
  SOURCE_CHECKOUT_PROBE_ENABLED:'true', ATMOS_SHA:'a'.repeat(40)};

test('explicitly enabled hosted main-only manual probe admits exact immutable input', () => {
  assert.equal(admitSourceProbe(env), env.ATMOS_SHA);
});
test('missing owner approval, wrong context, and malformed source fail before credentials', () => {
  for (const key of Object.keys(env)) assert.throws(() => admitSourceProbe({...env,[key]:undefined}),key);
  for (const [key,value] of [
    ['GITHUB_ACTIONS','false'],['GITHUB_REPOSITORY','other/cycle'],['GITHUB_EVENT_NAME','push'],
    ['GITHUB_EVENT_NAME','pull_request'],['GITHUB_EVENT_NAME','schedule'],['GITHUB_REF','refs/heads/feature'],
    ['SOURCE_CHECKOUT_PROBE_ENABLED','false'],['ATMOS_SHA','master'],['ATMOS_SHA','A'.repeat(40)],
    ['ATMOS_SHA','a'.repeat(40)+'\n'],['ATMOS_SHA','$(malicious)'],
  ]) assert.throws(() => admitSourceProbe({...env,[key]:value}),`${key}=${value}`);
});
test('command-line admission emits only the admitted SHA or a fixed refusal', () => {
  const file = fileURLToPath(new URL('../tools/source-checkout-probe.mjs', import.meta.url));
  const good = spawnSync(process.execPath,[file],{env,encoding:'utf8'});
  assert.equal(good.status,0); assert.equal(good.stdout,env.ATMOS_SHA+'\n'); assert.equal(good.stderr,'');
  const marker = 'SYNTHETIC_PRIVATE_INPUT_DO_NOT_PRINT';
  const bad = spawnSync(process.execPath,[file],{env:{...env,ATMOS_SHA:marker},encoding:'utf8'});
  assert.equal(bad.status,1); assert.equal(bad.stdout,'');
  assert.equal(bad.stderr,'source checkout probe refused\n');
  assert.ok(!(bad.stdout+bad.stderr).includes(marker));
});
test('probe has no deployment path, runs no private code, and never falls back to existing source key', () => {
  const workflow = readFileSync(new URL('../.github/workflows/source-checkout-probe.yml', import.meta.url),'utf8');
  const admit = workflow.split('\n  admit:\n')[1].split('\n  source-checkout:\n')[0];
  const source = workflow.split('\n  source-checkout:\n')[1];
  assert.doesNotMatch(workflow,/\b(?:schedule|push|pull_request|workflow_call):/);
  assert.doesNotMatch(admit,/environment:|secrets\./);
  assert.match(source,/needs: admit/);
  assert.match(source,/^    environment:\n      name: atmos-source-read-ui$/m);
  assert.equal((workflow.match(/github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/g)??[]).length,2);
  assert.deepEqual([...new Set([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(m=>m[1]))],['ATMOS_READONLY_KEY']);
  assert.doesNotMatch(workflow,/ATMOS_DEPLOY_KEY|CLOUDFLARE|R2_|upload-artifact|wrangler|npm ci|npm run|bash ops|issues: write|actions: write|id-token: write/);
  assert.equal((workflow.match(/repository: weatherx-hq\/atmos/g)??[]).length,2);
  assert.equal((workflow.match(/sparse-checkout: \/README\.md/g)??[]).length,2);
  assert.equal((workflow.match(/persist-credentials: false/g)??[]).length,3);
  for (const match of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(match[1],/^[\w/-]+@[a-f0-9]{40}$/);
  assert.match(source,/SOURCE_KEY_PROVISIONED: \$\{\{ secrets\.ATMOS_READONLY_KEY != '' \}\}/);
  assert.doesNotMatch(source,/SOURCE_KEY:|SOURCE_KEY_PROVISIONED: \$\{\{ secrets\.ATMOS_READONLY_KEY \}\}/);
  assert.match(source,/test "\$\(git -C candidate rev-parse HEAD\)" = "\$ATMOS_SHA"/);
  assert.ok(source.indexOf('test "$SOURCE_KEY_PROVISIONED" = true') < source.indexOf('repository: weatherx-hq/atmos'));
  const commands = [...source.matchAll(/^        run: (.+)\n((?:          .*\n)*)/gm)].map(([,inline,block]) =>
    inline === '|' ? block.trimEnd().split('\n').map(line=>line.slice(10)).join('\n') : inline);
  assert.equal((source.match(/^\s*run:/gm)??[]).length,3,'no extra credential-job command forms');
  assert.deepEqual([...source.matchAll(/uses: ([^\s]+)/g)].map(m=>m[1]),[
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
  ],'credential job may invoke only the reviewed checkout actions');
  assert.deepEqual(commands,[
    `test "$SOURCE_KEY_PROVISIONED" = true || { echo 'source checkout probe not provisioned'; exit 1; }`,
    'test "$(git -C control rev-parse HEAD)" = 25c402db5149daa018e349a34a4beeba1f2dca45',
    `[[ "$ATMOS_SHA" =~ ^[a-f0-9]{40}$ ]]\ntest "$(git -C candidate rev-parse HEAD)" = "$ATMOS_SHA"\necho 'source checkout probe passed; no build, deployment or data publication performed'`,
  ],'credential job executes only the reviewed identity/presence checks');
});
