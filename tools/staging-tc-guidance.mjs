// Manual isolated TC publication preflight. No network or write operation.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
export function gate(env) {
  const identity = {
    GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'publish',
    GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-tc-guidance.yml@refs/heads/main',
    STAGING_DATA_ISOLATION_APPROVED: 'true', STAGING_TC_GUIDANCE_ENABLED: 'true',
    STAGING_R2_ACCOUNT_ID: 'a89f9a1af485021fbc60a68b163c7c6e',
  };
  for (const [key, value] of Object.entries(identity)) assert.equal(env[key], value, `invalid ${key}`);
  assert.match(env.TC_SOURCE_SHA ?? '', /^[a-f0-9]{40}$/, 'exact source SHA required');
  assert.equal(env.TC_SOURCE_SHA, env.STAGING_TC_APPROVED_SOURCE_SHA, 'source has not been qualified');
  for (const key of Object.keys(env)) if (/^(AWS_|RCLONE_|CLOUDFLARE_|CF_API_|R2_ACCESS_|R2_SECRET_|R2_PRODUCTION_|SHARED_R2_|UI_PRODUCTION_|STAGING_WORKER_|CATALOG_)/.test(key)) {
    assert.ok(!env[key], 'unrelated credentials/configuration present');
  }
  assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9][0-9]{0,19}$/);
  assert.match(env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9][0-9]{0,5}$/);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  gate(process.env);
  console.log(JSON.stringify({qualifiedFor:'isolated-tc-candidate',sourceSha:process.env.TC_SOURCE_SHA,activation:false}));
}
