// Admission only: never reads credentials, runs private source, or publishes data.
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export function admitSourceProbe(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'hosted Actions required');
  assert.equal(env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle', 'wrong repository');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch', 'manual probe required');
  assert.equal(env.GITHUB_REF, 'refs/heads/main', 'main only');
  assert.equal(env.SOURCE_CHECKOUT_PROBE_ENABLED, 'true', 'owner must provision and enable the probe');
  assert.match(env.ATMOS_SHA ?? '', /^[a-f0-9]{40}$/, 'exact reviewed Atmos SHA required');
  return env.ATMOS_SHA;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(admitSourceProbe(process.env) + '\n'); }
  catch { console.error('source checkout probe refused'); process.exitCode = 1; }
}
