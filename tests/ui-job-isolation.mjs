import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { target } from '../tools/ui-release.mjs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('candidate execution is on a separate hosted runner with no deployment environment or keys',()=>{
  const wf=read('.github/workflows/ui-staging.yml');
  assert.ok(wf.includes('\n  build:\n'),'separate candidate build job required');
  const build=wf.slice(wf.indexOf('\n  build:\n'),wf.indexOf('\n  qualify:\n'));
  assert.match(build,/runs-on: ubuntu-latest/);
  assert.doesNotMatch(build,/environment:|CLOUDFLARE|UI_CANDIDATE_KEY|PRIVATE_KEY|ui-release\.mjs (?:preflight|deploy|retain)/);
  assert.match(build,/UI_BUILD_PUBLIC_KEY/);
  assert.match(build,/ui-release\.mjs build/);
  assert.match(build,/ui-release\.mjs pack-build/);
  const qualify=wf.slice(wf.indexOf('\n  qualify:\n'));
  assert.match(qualify,/needs: build/);
  assert.match(qualify,/runs-on: ubuntu-latest/);
  assert.match(qualify,/name: ui-staging/);
  assert.doesNotMatch(qualify,/path: atmos|prefix atmos|working-directory: atmos|inputs\.atmos_sha.*\n.*ssh-key/);
  assert.match(qualify,/ui-release\.mjs receive-build/);
  assert.match(qualify,/ui-release\.mjs deploy staging/);
  assert.ok(qualify.indexOf('receive-build')<qualify.indexOf('deploy staging'));
  assert.doesNotMatch(qualify,/actions\/cache|ui-public-shell|npm run build/);
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
