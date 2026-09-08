import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { target } from '../tools/ui-release.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
function assertSourceIsolation(build) {
  assert.match(build,/^    environment:\n      name: atmos-source-read-ui$/m);
  assert.match(build,/^    if: \$\{\{ github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main' \}\}$/m);
  assert.match(build,/^    permissions:\n      contents: read\n    runs-on:/m);
  assert.doesNotMatch(build,/CLOUDFLARE|UI_CANDIDATE_KEY|PRIVATE_KEY|ATMOS_DEPLOY_KEY|secrets\[|secrets:\s*inherit|toJSON\(secrets\)/);
  assert.deepEqual([...new Set([...build.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m=>m[1]))],['ATMOS_READONLY_KEY']);
  assert.equal((build.match(/ssh-key: \$\{\{ secrets\.ATMOS_READONLY_KEY \}\}/g)||[]).length,2);
  assert.equal((build.match(/persist-credentials: false/g)||[]).length,3);
  assert.match(build,/SOURCE_KEY_PROVISIONED: \$\{\{ secrets\.ATMOS_READONLY_KEY != '' \}\}/);
  const check = build.indexOf('test "$SOURCE_KEY_PROVISIONED" = true');
  assert.ok(check >= 0 && check < build.indexOf('uses: actions/checkout@'),'missing-key refusal precedes every checkout');
}

test('candidate execution uses only the isolated source environment, never publisher keys',()=>{
  const wf=read('.github/workflows/ui-staging.yml');
  const profile=wf.slice(wf.indexOf('\n  profile:\n'),wf.indexOf('\n  build:\n'));
  assert.match(profile,/environment:\s*\n\s*name: ui-staging/);
  assert.match(profile,/UI_STAGING_MODEL_SELECTION_APPROVED_SHA256/);
  assert.match(profile,/UI_STAGING_CORE_PROFILE_APPROVED/);
  assert.match(profile,/UI_STAGING_STATIC_COMPRESSION_APPROVED/);
  assert.doesNotMatch(profile,/CLOUDFLARE|UI_(?:BUILD_PRIVATE_KEY|BUILD_PUBLIC_KEY|CANDIDATE_KEY|STAGING_PAGES_TOKEN)|STAGING_R2|SHARED_R2|ui-release\.mjs (?:build|deploy|retain)/);
  assert.ok(wf.includes('\n  build:\n'),'separate candidate build job required');
  const build=wf.slice(wf.indexOf('\n  build:\n'),wf.indexOf('\n  qualify:\n'));
  assert.match(build,/runs-on: ubuntu-latest/);
  assertSourceIsolation(build);
  assert.doesNotMatch(build,/ui-release\.mjs (?:preflight|deploy|retain)/);
  assert.match(build,/UI_BUILD_PUBLIC_KEY/);
  assert.doesNotMatch(build,/UI_STAGING_STATIC_COMPRESSION_APPROVED|APPROVED_STATIC_COMPRESSION/);
  assert.match(build,/ui-release\.mjs build/);
  assert.match(build,/ui-release\.mjs pack-build/);
  const qualify=wf.slice(wf.indexOf('\n  qualify:\n'));
  assert.match(qualify,/needs: \[profile, build\]/);
  assert.match(qualify,/runs-on: ubuntu-latest/);
  assert.match(qualify,/name: ui-staging/);
  assert.match(qualify,/UI_STAGING_STATIC_COMPRESSION_APPROVED: \$\{\{ vars\.UI_STAGING_STATIC_COMPRESSION_APPROVED \}\}/);
  assert.equal((wf.match(/vars\.UI_STAGING_STATIC_COMPRESSION_APPROVED/g)||[]).length,2);
  assert.doesNotMatch(qualify,/path: atmos|prefix atmos|working-directory: atmos|inputs\.atmos_sha.*\n.*ssh-key/);
  assert.match(qualify,/ui-release\.mjs receive-build/);
  assert.match(qualify,/ui-release\.mjs deploy staging/);
  assert.ok(qualify.indexOf('receive-build')<qualify.indexOf('deploy staging'));
  assert.doesNotMatch(qualify,/actions\/cache|ui-public-shell|npm run build/);
});
test('source isolation contract rejects credential and privilege regressions',()=>{
  const wf=read('.github/workflows/ui-staging.yml');
  const build=wf.slice(wf.indexOf('\n  build:\n'),wf.indexOf('\n  qualify:\n'));
  assertSourceIsolation(build);
  const defects = [
    build.replace('name: atmos-source-read-ui','name: ui-staging'),
    build.replace('name: atmos-source-read-ui','name: ui-production'),
    build.replaceAll('secrets.ATMOS_READONLY_KEY','secrets.ATMOS_DEPLOY_KEY'),
    build.replace('contents: read','contents: write'),
    build.replaceAll('persist-credentials: false','persist-credentials: true'),
    build.replace("github.ref == 'refs/heads/main'","github.ref == 'refs/heads/feature'"),
    build.replace('test "$SOURCE_KEY_PROVISIONED" = true','true'),
    build.replace("secrets.ATMOS_READONLY_KEY != ''",'secrets.ATMOS_READONLY_KEY'),
    build+'\n        env:\n          TOKEN: ${{ secrets.UI_STAGING_PAGES_TOKEN }}\n',
    build+'\n        env:\n          TOKEN: ${{ secrets[inputs.key] }}\n',
  ];
  for (const defect of defects) assert.throws(()=>assertSourceIsolation(defect));
});
test('publisher hardcodes staging target and rejects cross-job, account and local invocations',()=>{
  const env={GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_JOB:'qualify',
    CLOUDFLARE_ACCOUNT_ID:'a89f9a1af485021fbc60a68b163c7c6e',CLOUDFLARE_API_TOKEN:'fixture',UI_PAGES_CONFIG_SHA256:'a'.repeat(64)};
  assert.deepEqual(target('staging',env),{origin:'https://staging.weatherx.org',project:'weatherx-platform-staging'});
  assert.throws(()=>target('production',env));assert.throws(()=>target('unknown',env));
  for(const k of Object.keys(env))assert.throws(()=>target('staging',{...env,[k]:''}));
  for(const job of ['build','promote'])assert.throws(()=>target('staging',{...env,GITHUB_JOB:job}));
  assert.throws(()=>target('staging',{...env,RUNNER_ENVIRONMENT:'self-hosted'}));
  assert.equal(target('production',{...env,GITHUB_JOB:'promote'}).project,'atmos-platform');
});
