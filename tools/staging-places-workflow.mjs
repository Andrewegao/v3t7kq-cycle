// Guarded hosted manual lane. Seed bytes cannot supply executable code or attest qualification.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, lstat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ACCOUNT, KINDS, hash, qualifyPlaces, validateQualification, preparePlaces, activatePlaces, createPlacesS3 } from './staging-places.mjs';
import { downloadSeed, unpackSeed, checkpointEvidence, noPublishCredentials, seedURL } from './staging-places-seed.mjs';
const SHA = /^[a-f0-9]{64}$/;
export function placesGate(env) {
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'places',
    GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-places.yml@refs/heads/main',
    STAGING_PLACES_ENABLED: 'true', STAGING_DATA_ISOLATION_APPROVED: 'true', STAGING_R2_ACCOUNT_ID: ACCOUNT })) assert.equal(env[key], value, `guard ${key}`);
  assert(['prepare', 'activate'].includes(env.PLACES_ACTION)); assert(KINDS.includes(env.PLACES_KIND));
  assert(/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') && env.GITHUB_SHA === env.STAGING_PLACES_APPROVED_WORKFLOW_SHA);
  assert(/^[a-f0-9]{40}$/.test(env.ATMOS_SHA ?? '') && env.ATMOS_SHA === env.STAGING_PLACES_APPROVED_ATMOS_SHA);
  assert.equal(env.PLACES_KIND, env.STAGING_PLACES_APPROVED_FAMILY);
  for (const [input, approved] of [['SEED_SHA256', 'STAGING_PLACES_APPROVED_SEED_SHA256'], ['MANIFEST_SHA256', 'STAGING_PLACES_APPROVED_MANIFEST_SHA256'], ['PLAINTEXT_SHA256', 'STAGING_PLACES_APPROVED_PLAINTEXT_SHA256']]) {
    assert(SHA.test(env[input] ?? '') && env[input] === env[approved], `unapproved ${input}`);
  }
  seedURL(env.PLACES_KIND, env.SEED_TAG);
  assert(SHA.test(env.STAGING_PLACES_APPROVED_QUALIFIER_SHA256 ?? ''), 'reviewed runtime qualifier required');
  for (const key of Object.keys(env)) if (/^(AWS_|RCLONE_|CLOUDFLARE_|CF_API_|R2_|SHARED_R2_|UI_|STAGING_WORKER_)/.test(key)) assert(!env[key], 'foreign credential refused');
  if (env.PLACES_ACTION === 'activate') {
    assert(SHA.test(env.COMPLETION_SHA256 ?? '') && env.COMPLETION_SHA256 === env.STAGING_PLACES_APPROVED_COMPLETION_SHA256);
    assert(env.EXPECTED_POINTER_SHA256 === 'absent' || SHA.test(env.EXPECTED_POINTER_SHA256 ?? ''));
  }
  assert(env.RUNNER_TEMP && resolve(env.RUNNER_TEMP) === env.RUNNER_TEMP && env.GITHUB_WORKSPACE && resolve(env.GITHUB_WORKSPACE) === env.GITHUB_WORKSPACE);
  return { root: resolve(env.RUNNER_TEMP, 'weatherx-staging-places'), source: resolve(env.GITHUB_WORKSPACE, 'control'),
    kind: env.PLACES_KIND, sourceSha: env.ATMOS_SHA, manifestSha256: env.MANIFEST_SHA256 };
}
async function boundedJSON(path, max) { assert.equal(await realpath(path), path); const stat = await lstat(path); assert(stat.isFile() && stat.nlink === 1 && stat.size <= max); const body = await readFile(path); assert(body.length <= max); return JSON.parse(body); }
export function proofScopeArguments(kind, evidence) {
  if (kind === 'tides') { assert.equal(evidence?.kind, 'tide-checkpoint'); return ['--scope', 'staging-partial', '--min-available-stations', '1251']; }
  assert(kind === 'surf' || kind === 'paragliding');
  assert.equal(evidence?.kind, kind === 'surf' ? 'surf-stage' : 'paragliding-snapshot');
  const primary = evidence.files.find(file => file.path === (kind === 'surf' ? 'stage.json' : 'all-sites.json')); assert(primary && SHA.test(primary.sha256));
  return ['--scope', kind === 'surf' ? 'full-pilot' : 'worldwide-snapshot', '--evidence-sha256', primary.sha256];
}
export async function runRuntimeProof(env, context, execute = execFileSync) {
  noPublishCredentials(env); assert(!env.STAGING_PLACES_SEED_KEY, 'qualification cannot hold seed key');
  assert.equal(execute('git', ['rev-parse', 'HEAD'], { cwd: context.source, encoding: 'utf8' }).trim(), context.sourceSha);
  assert.equal(execute('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: context.source, encoding: 'utf8' }).trim(), '', 'reviewed source changed');
  const entry = resolve(context.source, 'app/e2e/qualify-staging-places.mjs');
  let stat; try { stat = await lstat(entry); } catch { throw Error('missing committed candidate runtime qualifier; publication withheld'); }
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 256 * 1024); assert.equal(await realpath(entry), entry);
  assert.equal(hash(await readFile(entry)), env.STAGING_PLACES_APPROVED_QUALIFIER_SHA256, 'unreviewed qualifier executable');
  // Fixed committed entrypoint only, never a path/command supplied by seed, dispatch or proof.
  // The entrypoint must fail unsupported families; unit tests alone cannot mint this receipt.
  // Source checkpoints are a separately authenticated seed namespace, never R2 payloads.
  const checkpoints = resolve(context.root, 'checkpoint'); assert.equal(await realpath(checkpoints), checkpoints, 'authenticated source checkpoints required');
  const evidence = await boundedJSON(resolve(context.root, 'seed-evidence.json'), 4 * 1024 ** 2);
  assert.deepEqual((await checkpointEvidence(checkpoints, context.kind)).document, evidence, 'source evidence changed after authenticated decryption');
  execute(process.execPath, [entry, '--family', context.kind, '--candidate-root', resolve(context.root, 'candidate'), '--source-sha', context.sourceSha,
    '--publisher-module', resolve(env.GITHUB_WORKSPACE, 'cycle/tools/staging-places.mjs'), '--manifest-sha256', context.manifestSha256,
    '--checkpoint-root', checkpoints, ...proofScopeArguments(context.kind, evidence), '--out', resolve(context.root, 'qualification.json')], {
    cwd: context.source, env: { PATH: env.PATH, LANG: 'C.UTF-8', NO_COLOR: '1', TMPDIR: env.RUNNER_TEMP }, stdio: 'pipe', timeout: 20 * 60000, maxBuffer: 65536,
  });
  const candidate = await qualifyPlaces({ kind: context.kind, root: resolve(context.root, 'candidate') }); assert.equal(hash(candidate.manifestBody), context.manifestSha256);
  const proof = await boundedJSON(resolve(context.root, 'qualification.json'), 8192); validateQualification(proof, candidate, context.sourceSha);
  await writeFile(resolve(context.root, 'qualified.json'), JSON.stringify({ sourceSha: context.sourceSha, manifestSha256: context.manifestSha256, qualificationSha256: hash(Buffer.from(JSON.stringify(proof))) }) + '\n', { flag: 'wx', mode: 0o600 });
  return { qualified: true, family: context.kind, identity: candidate.completion.identity, manifestSha256: context.manifestSha256 };
}
async function main(env, action) {
  const context = placesGate(env); if (action === 'gate') return;
  if (action === 'download') { noPublishCredentials(env); assert(!env.STAGING_PLACES_SEED_KEY); assert.equal(await realpath(env.RUNNER_TEMP), env.RUNNER_TEMP); await mkdir(context.root, { mode: 0o700 });
    await downloadSeed({ kind: context.kind, tag: env.SEED_TAG, ciphertextSha256: env.SEED_SHA256, output: resolve(context.root, 'seed.wxps') }); return; }
  assert.equal(await realpath(context.root), context.root);
  if (action === 'decrypt') { noPublishCredentials(env); const candidate = await unpackSeed({ archive: resolve(context.root, 'seed.wxps'), output: resolve(context.root, 'candidate'), evidenceOutput: resolve(context.root, 'checkpoint'), key: env.STAGING_PLACES_SEED_KEY,
    ciphertextSha256: env.SEED_SHA256, plaintextSha256: env.PLAINTEXT_SHA256, ...context });
    assert(candidate.seedEvidence, 'operational qualification requires source evidence');
    await writeFile(resolve(context.root, 'seed-evidence.json'), JSON.stringify(candidate.seedEvidence) + '\n', { flag: 'wx', mode: 0o600 }); return; }
  if (action === 'qualify') { console.log(JSON.stringify(await runRuntimeProof(env, context))); return; }
  assert.equal(action, 'publish'); assert(!env.STAGING_PLACES_SEED_KEY, 'publisher cannot hold seed key');
  const candidate = await qualifyPlaces({ kind: context.kind, root: resolve(context.root, 'candidate') }); assert.equal(hash(candidate.manifestBody), context.manifestSha256);
  const proof = await boundedJSON(resolve(context.root, 'qualification.json'), 8192), qualified = await boundedJSON(resolve(context.root, 'qualified.json'), 8192);
  assert.deepEqual(qualified, { sourceSha: context.sourceSha, manifestSha256: context.manifestSha256, qualificationSha256: hash(Buffer.from(JSON.stringify(proof))) });
  validateQualification(proof, candidate, context.sourceSha);
  if (env.PLACES_ACTION === 'activate') assert.equal(hash(candidate.completionBody), env.COMPLETION_SHA256, 'local completion differs from approval');
  const io = await createPlacesS3(env);
  try {
    const prepared = await preparePlaces(io, candidate, { qualification: proof, approvedSourceSha: context.sourceSha });
    if (env.PLACES_ACTION === 'prepare') { console.log(JSON.stringify(prepared)); return; }
    assert.equal(prepared.completion.sha256, env.COMPLETION_SHA256);
    const end = Math.min(Date.now() + 24 * 3600000, candidate.completion.sourceExpiresAt ? Date.parse(candidate.completion.sourceExpiresAt) : Infinity);
    console.log(JSON.stringify(await activatePlaces(io, { kind: context.kind, identity: candidate.completion.identity, expectedPointerSha256: env.EXPECTED_POINTER_SHA256,
      approvedCompletionSha256: env.COMPLETION_SHA256, expiresAt: new Date(end).toISOString() })));
  } finally { io.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.env, process.argv[2]).catch(() => { console.error('staging place lane refused; inspect pinned qualification and approval gates; no unverified activation'); process.exitCode = 1; });
}
