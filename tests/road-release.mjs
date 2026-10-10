import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PROFILE, seal as sealLab, validateFiles } from '../tools/ui-candidate.mjs';
import {
  bindRun, buildEnvironment, confirmation, packBuild, projectSummary, PROJECT, ROAD_BUILD_ENV, ROAD_RECEIPT_ENV,
  seal, unpackBuild, unseal, validateEnvelope, validateGuardSuccess,
} from '../tools/road-release.mjs';

const SHA = 'cafba441c48a31c623cb38d1e3d4312a7d66ee1c';
const LIVE = 'c6d67b56051d08ea8748c7e0b2cd533f403b2191';
const WORKFLOW_SHA = 'b'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const row = (path, text) => {
  const bytes = Buffer.from(text);
  return { path, bytes: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') };
};
const index = '<!doctype html><title>WeatherX 物流</title><div id="root"></div>';
function envelope({ receipt = {}, extra = [], routes = { version: 1, include: ['/*'], exclude: ['/api/aircraft-observations'] } } = {}) {
  const files = [row('index.html', index), row('_worker.js', 'export default {};'),
    row('_routes.json', JSON.stringify(routes)),
    row('health/release.json', JSON.stringify({ schemaVersion: 1, releaseId: `git-${SHA.slice(0, 12)}-run-77`,
      gitSha: SHA, workflowRunId: '77', indexSha256: hash(Buffer.from(index)), shellSha256: 'a'.repeat(64),
      buildProfile: { product: 'road', platformAccount: '0', platformDataAuth: 'public' }, ...receipt })),
    row('assets/app.js', 'console.log(1)'), ...extra].sort((a, b) => a.path < b.path ? -1 : 1);
  return { schemaVersion: 1, kind: 'weatherx-road-release', project: PROJECT, sourceSha: SHA, liveSourceSha: LIVE,
    runId: '77', attempt: '1', workflowSha: WORKFLOW_SHA, artifactDigest: validateFiles(files, PROFILE).digest, files };
}
const keys = generateKeyPairSync('rsa', { modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const candidateKey = randomBytes(32).toString('hex');

test('confirmation binds the exact Atmos source', () => {
  assert.equal(confirmation(SHA), `RELEASE-ROAD:${SHA}`);
  assert.throws(() => confirmation(SHA.slice(0, 12)));
  assert.throws(() => confirmation(undefined));
});

test('Road build environment mirrors deploy-road-shell.sh and inherits no stray flags', () => {
  assert.deepEqual(ROAD_BUILD_ENV, { ATMOS_CODE_ONLY_BUILD: '1', ATMOS_ROAD_PUBLIC_RELEASE: '1', VITE_PRODUCT: 'road',
    VITE_APP: 'road', VITE_PLATFORM_ACCOUNT: '0', VITE_PLATFORM_DATA_AUTH: 'public',
    WX_GROUND_QUALIFICATION_SCOPE: 'staging-qualification-only' });
  assert.deepEqual(ROAD_RECEIPT_ENV, { VITE_PRODUCT: 'road', VITE_PLATFORM_ACCOUNT: '0', VITE_PLATFORM_DATA_AUTH: 'public' });
  const env = buildEnvironment({ PATH: '/bin', HOME: '/h', GITHUB_RUN_ID: '77', VITE_PRO_PROTO: '1',
    ATMOS_PUBLIC_RELEASE: '1', UI_BUILD_PUBLIC_KEY: 'k', CLOUDFLARE_API_TOKEN: 't' }, ROAD_RECEIPT_ENV);
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', CI: 'true', GITHUB_RUN_ID: '77', ...ROAD_RECEIPT_ENV });
});

test('envelope accepts only an exact public account-off Road shell', () => {
  assert.doesNotThrow(() => validateEnvelope(envelope()));
  assert.throws(() => validateEnvelope(envelope({ receipt: { buildProfile: { product: 'lab', platformAccount: '0', platformDataAuth: 'public' } } })), /Road receipt/);
  assert.throws(() => validateEnvelope(envelope({ receipt: { gitSha: LIVE } })), /source differs/);
  assert.throws(() => validateEnvelope(envelope({ receipt: { workflowRunId: '78' } })), /run differs/);
  assert.throws(() => validateEnvelope(envelope({ receipt: { indexSha256: 'f'.repeat(64) } })), /index digest/);
  assert.throws(() => validateEnvelope(envelope({ routes: { version: 1, include: ['/api/*'], exclude: [] } })), /Road routes/);
  assert.throws(() => validateEnvelope(envelope({ extra: [row('data/ecmwf/index.json', '{}')] })));
  assert.throws(() => validateEnvelope(envelope({ extra: [row('assets/app.js.map', '{}')] })));
  assert.throws(() => validateEnvelope(envelope({ extra: [row('assets/leak.js', 'sk_live_' + 'a'.repeat(24))] })));
  const tampered = envelope(); tampered.files[0] = row(tampered.files[0].path, 'changed');
  assert.throws(() => validateEnvelope(tampered));
  assert.throws(() => validateEnvelope({ ...envelope(), project: 'atmos-platform' }));
  assert.throws(() => validateEnvelope({ ...envelope(), liveSourceSha: 'unknown' }));
});

test('build transport and candidate seal round-trip and never cross with Lab envelopes', () => {
  const value = envelope();
  const blob = packBuild(value, keys.publicKey);
  assert.deepEqual(unpackBuild(blob, keys.privateKey), value);
  const flipped = Buffer.from(blob); flipped[flipped.length - 1] ^= 1;
  assert.throws(() => unpackBuild(flipped, keys.privateKey));
  const sealed = seal(value, candidateKey);
  assert.deepEqual(unseal(sealed, candidateKey), value);
  assert.throws(() => unseal(sealed, randomBytes(32).toString('hex')));
  assert.throws(() => unseal(blob, candidateKey), /not a Road candidate/);
  assert.throws(() => unpackBuild(sealed, keys.privateKey), /not a Road build/);
  // A Lab candidate key holder cannot be handed a Road blob as a Lab candidate, or the reverse.
  assert.throws(() => sealLab(value, candidateKey));
  assert.throws(() => packBuild({ ...value, kind: 'lab' }, keys.publicKey));
});

test('every job binds the envelope to this exact run and source', () => {
  const value = envelope(), context = { sha: SHA, runId: '77', attempt: '1', workflowSha: WORKFLOW_SHA };
  assert.equal(bindRun(value, context), value);
  for (const [key, changed] of [['sha', LIVE], ['runId', '78'], ['attempt', '2'], ['workflowSha', 'c'.repeat(40)]])
    assert.throws(() => bindRun(value, { ...context, [key]: changed }), key);
});

test('guard success receipt must name this project, source, release and index', () => {
  const expected = { sourceSha: SHA, releaseId: `git-${SHA.slice(0, 12)}-run-77`, indexSha256: 'a'.repeat(64) };
  const success = { schemaVersion: 1, project: PROJECT, previousDeploymentId: 'abc-1', candidateDeploymentId: 'def-2', ...expected };
  assert.equal(validateGuardSuccess(success, expected), success);
  assert.throws(() => validateGuardSuccess({ ...success, project: 'atmos-platform' }, expected));
  assert.throws(() => validateGuardSuccess({ ...success, sourceSha: LIVE }, expected));
  assert.throws(() => validateGuardSuccess({ ...success, candidateDeploymentId: 'abc-1' }, expected));
  assert.throws(() => validateGuardSuccess({ ...success, candidateDeploymentId: '' }, expected));
});

test('Pages project summary records names only', () => {
  const project = { name: PROJECT, production_branch: 'main', source: { config: { production_deployments_enabled: false } },
    deployment_configs: { production: { compatibility_date: '2026-06-23', compatibility_flags: [],
      env_vars: { AI_API_KEY: { type: 'secret_text' }, AI_MODEL: { type: 'plain_text', value: 'private-value' } },
      d1_databases: { WX_ANALYTICS: { id: 'e7247173-c23d-4989-b29e-f95939c820fe' } } } } };
  const summary = projectSummary(project);
  assert.deepEqual(summary.environmentVariables, ['AI_API_KEY', 'AI_MODEL']);
  assert.deepEqual(summary.d1, ['WX_ANALYTICS']);
  assert.ok(!JSON.stringify(summary).includes('private-value'));
  assert.ok(!JSON.stringify(summary).includes('e7247173'));
  assert.throws(() => projectSummary({ ...project, name: 'atmos-platform' }));
  assert.throws(() => projectSummary({ ...project, deployment_configs: {} }));
});

test('workflow separates build, transfer and protected publish credentials', () => {
  const source = readFileSync(new URL('../.github/workflows/road-production-release.yml', import.meta.url), 'utf8');
  assert.match(source, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(source, /^\s+(?:push|schedule|workflow_run|pull_request|repository_dispatch|workflow_call):/m);
  const job = name => source.split(/\n  (?=[a-z]+:\n)/).find(block => block.startsWith(`${name}:`));
  const build = job('build'), transfer = job('transfer'), release = job('release');
  assert.match(build, /environment:\n      name: atmos-source-read-ui\n/);
  assert.match(transfer, /environment:\n      name: ui-staging\n/);
  assert.match(release, /environment:\n      name: ui-production\n      url: https:\/\/road\.weatherx\.org/);
  assert.match(transfer, /needs: build/); assert.match(release, /needs: transfer/);
  const secrets = block => [...new Set([...block.matchAll(/secrets\.([A-Z_]+)/g)].map(m => m[1]))].sort();
  assert.deepEqual(secrets(build), ['ATMOS_READONLY_KEY']);
  assert.deepEqual(secrets(transfer), ['UI_BUILD_PRIVATE_KEY', 'UI_CANDIDATE_KEY']);
  assert.deepEqual(secrets(release), ['ATMOS_DEPLOY_KEY', 'UI_CANDIDATE_KEY', 'UI_PRODUCTION_PAGES_TOKEN']);
  // The retained ground package scope stays in the build lane; the publisher never builds.
  assert.doesNotMatch(release, /WX_GROUND_QUALIFICATION_SCOPE|npm run build|npm ci --prefix atmos\/app|\/app\//);
  assert.match(release, /sparse-checkout: \|\n            \/ops\/release\/\n            \/platform\/edge\/package\.json\n            \/platform\/edge\/package-lock\.json\n/);
  assert.match(release, /guard-pages-deploy\.sh" --project weatherx-road --branch main/);
  assert.match(release, /verify-road-production\.sh" https:\/\/road\.weatherx\.org/);
  assert.match(release, /RELEASE_GUARD_EXPECTED_GIT_SHA: \$\{\{ inputs\.atmos_sha \}\}/);
  assert.doesNotMatch(source, /wrangler pages deploy|wrangler deploy|secret put|atmos-platform/);
  assert.match(source, /group: weatherx-road-production\n  cancel-in-progress: false/);
  for (const block of [build, transfer]) assert.match(block, /retention-days: 1/);
  assert.match(release, /issues: write/);
  assert.doesNotMatch(build + transfer, /issues: write|UI_PRODUCTION_PAGES_TOKEN|UI_STAGING_PAGES_TOKEN/);
});
