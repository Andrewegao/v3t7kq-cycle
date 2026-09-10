// Scheduled staging-only qualification and CAS activation. The manual seed gate is unchanged.
import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, mkdir, realpath, lstat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ACCOUNT, KINDS, LIMITS, hash, qualifyPlaces, validateQualification, validatePointer,
  preparePlaces, activatePlaces, pointerKey, createPlacesS3 } from './staging-places.mjs';
import { noPublishCredentials, downloadSeed, unpackSeed, checkpointEvidence } from './staging-places-seed.mjs';
import { runRuntimeProof } from './staging-places-workflow.mjs';
import { placeFailureDiagnostic } from './staging-places-diagnostics.mjs';
const CYCLE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[a-f0-9]{64}$/;
// Closure pin survives unrelated main commits but not a change to an executable dependency.
export const CLOSURE = ['.github/workflows/staging-place-renewal.yml', 'tools/staging-place-renewal-policy.json',
  'tools/staging-place-renewal.mjs', 'tools/staging-place-collect.py', 'tools/staging-place-python', 'tools/staging-place-renewal-requirements.txt',
  'tools/staging-places-requirements.txt', 'tools/staging-places.mjs', 'tools/staging-places-workflow.mjs',
  'tools/staging-places-seed.mjs', 'tools/staging-places-diagnostics.mjs', 'tools/shared-data.mjs',
  'staging-controller/package.json', 'staging-controller/package-lock.json'];
export async function controllerDigest(root = CYCLE) {
  const rows = [];
  for (const file of CLOSURE) {
    const path = resolve(root, file), stat = await lstat(path);
    assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && await realpath(path) === path);
    rows.push([file, hash(await readFile(path))]);
  }
  return hash(Buffer.from(JSON.stringify(rows)));
}
export function isolatedPythonArguments(entry, args = []) {
  assert.equal(resolve(entry), entry, 'isolated Python entrypoint must be absolute');
  return ['-I', '-B', entry, ...args];
}
export function renewalGate(env, policy, digest) {
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_REF: 'refs/heads/main', GITHUB_JOB: 'renew',
    GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-place-renewal.yml@refs/heads/main',
    STAGING_PLACES_RENEWAL_ENABLED: 'true', STAGING_DATA_ISOLATION_APPROVED: 'true', STAGING_R2_ACCOUNT_ID: ACCOUNT })) {
    assert.equal(env[key], value, `guard ${key}`);
  }
  assert(['schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME));
  assert(KINDS.includes(env.PLACES_KIND));
  assert(/^[a-f0-9]{40}$/.test(policy.sourceSha) && env.ATMOS_SHA === policy.sourceSha, 'unapproved source');
  assert(policy.schemaVersion === 1 && SHA.test(policy.qualifierSha256));
  assert(SHA.test(digest) && env.STAGING_PLACES_RENEWAL_CONTROLLER_SHA256 === digest, 'unapproved controller closure');
  assert(policy.minimumForecastLeaseHours === 6 && policy.leaseHours === 24);
  for (const key of Object.keys(env)) if (/^(AWS_|RCLONE_|CLOUDFLARE_|CF_API_|R2_|SHARED_R2_|UI_|STAGING_WORKER_)/.test(key)) assert(!env[key], 'foreign credential refused');
  for (const path of [env.RUNNER_TEMP, env.GITHUB_WORKSPACE]) assert(path && resolve(path) === path);
  let run;
  if (env.GITHUB_EVENT_NAME === 'schedule') {
    assert([policy.surfSchedule, policy.directoryTideSchedule].includes(env.RENEWAL_SCHEDULE), 'unknown schedule');
    run = env.PLACES_KIND === 'surf' ? env.RENEWAL_SCHEDULE === policy.surfSchedule : env.RENEWAL_SCHEDULE === policy.directoryTideSchedule;
  } else {
    assert(['all', ...KINDS].includes(env.REQUESTED_FAMILY));
    run = env.REQUESTED_FAMILY === 'all' || env.REQUESTED_FAMILY === env.PLACES_KIND;
  }
  return { run, kind: env.PLACES_KIND, sourceSha: policy.sourceSha,
    source: resolve(env.GITHUB_WORKSPACE, 'control'), root: resolve(env.RUNNER_TEMP, `weatherx-place-renewal-${env.PLACES_KIND}`) };
}
async function json(path, max = 8192) {
  assert.equal(await realpath(path), path);
  const stat = await lstat(path); assert(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size <= max);
  const bytes = await readFile(path); assert(bytes.length <= max); return JSON.parse(bytes);
}
export function readPriorPointer(object, kind, now) {
  if (!object) return null;
  assert(Buffer.isBuffer(object.body) && object.body.length === object.bytes && hash(object.body) === object.sha256);
  assert.equal(object.customMetadata?.sha256, object.sha256); assert(!object.httpMetadata?.contentEncoding);
  const pointer = JSON.parse(object.body);
  // An expired *valid* lease may be replaced, never an unvalidated/corrupted pointer.
  assert(Date.parse(pointer.createdAt) <= now);
  validatePointer(pointer, Date.parse(pointer.createdAt)); assert.equal(pointer.kind, kind);
  return pointer;
}
export async function renewQualified(io, candidate, proof, policy, { clock = Date.now, report } = {}) {
  validateQualification(proof, candidate, policy.sourceSha);
  const { kind, identity, sourceExpiresAt } = candidate.completion;
  const before = await io.get(pointerKey(kind), LIMITS.completionBytes, true);
  const prior = readPriorPointer(before, kind, clock());
  const minimum = policy.minimumForecastLeaseHours * 3600000;
  const remaining = () => sourceExpiresAt === null ? Infinity : Date.parse(sourceExpiresAt) - clock();
  assert(remaining() >= minimum, 'candidate needs six hours of real remaining source freshness');
  if (kind === 'paragliding') {
    assert.equal(identity, policy.paragliding.identity, 'unreviewed static directory');
    assert.equal(hash(candidate.manifestBody), policy.paragliding.manifestSha256);
    if (prior) assert.equal(prior.identity, identity, 'do not replace a newer approved static directory');
  } else if (prior) {
    assert(Date.parse(sourceExpiresAt) >= Date.parse(prior.sourceExpiresAt), 'forecast freshness rollback refused');
    // Tide windows collected on the same UTC day can have the same coverage end.
    // Their fixed-width dataset timestamps provide the required same-window ordering.
    if (kind === 'tides') {
      assert(/^noaa-coops-\d{8}T\d{6}Z$/.test(identity) && /^noaa-coops-\d{8}T\d{6}Z$/.test(prior.identity),
        'noncanonical tide identity');
      assert(identity >= prior.identity, 'newer tide dataset rollback refused');
    }
  }
  // Never refresh a newer manual snapshot with an older scheduled one. For an exact
  // retained PG snapshot, preparation verifies existing objects and makes zero PUTs.
  await preparePlaces(io, candidate, { qualification: proof, approvedSourceSha: policy.sourceSha, clock, report });
  assert(remaining() >= minimum, 'candidate lost freshness margin during upload');
  const expiresAt = new Date(Math.min(clock() + policy.leaseHours * 3600000,
    sourceExpiresAt === null ? Infinity : Date.parse(sourceExpiresAt))).toISOString();
  return activatePlaces(io, { kind, identity, expectedPointerSha256: before?.sha256 ?? 'absent',
    approvedCompletionSha256: hash(candidate.completionBody), clock, expiresAt,
    minimumSourceHorizonMs: minimum, report });
}
function safeExecute(command, args, context, env, timeout) {
  // Private source/forecast body never goes to public Actions logs; child receives
  // only its tools path and inert locale/temp values, not parent GitHub/R2 secrets.
  return execFileSync(command, args, { cwd: context.source, env: { PATH: env.PATH, LANG: 'C.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1', TMPDIR: env.RUNNER_TEMP }, encoding: 'utf8', stdio: 'pipe', timeout, maxBuffer: 65536 });
}
export async function verifyLive(candidate, fetcher = fetch, sleep = delay) {
  const { kind, identity } = candidate.completion;
  const indexPath = kind === 'tides' ? 'catalog.json' : 'index.json';
  const detail = candidate.manifest.files.find(row => kind === 'surf' ? row.path.startsWith('spots/')
    : kind === 'tides' ? row.path.startsWith('stations/') : row.path.startsWith('sites/'));
  assert(detail, 'representative detail missing');
  const urls = kind === 'surf' ? ['/data/surf/index.json', `/data/_release/${identity}/surf/${detail.path}`]
    : kind === 'paragliding' ? ['/data/paragliding/index.json', `/data/paragliding/versions/${identity}/${detail.path}`]
      : ['/data-atmos/tides/v2/catalog.json', `/data-atmos/tides/v2/versions/${identity}/${detail.path}`];
  const receipts = [candidate.manifest.files.find(row => row.path === indexPath), detail];
  // Pointer caches are bounded to30s. Read-only retries permit propagation, never another PUT.
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      for (let i = 0; i < urls.length; i++) {
        const response = await fetcher(new URL(urls[i], 'https://staging.weatherx.org'), {
          redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(20000) });
        let bytes = 0; const chunks = [];
        try {
          assert.equal(response.status, 200);
          assert.equal(response.headers.get('x-weatherx-data-source'), 'own');
          assert.equal(response.headers.get('x-weatherx-release'), kind === 'surf' ? identity : `places-${identity}`);
          assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
          assert(/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? ''));
          for await (const chunk of response.body) { bytes += chunk.length; assert(bytes <= receipts[i].bytes); chunks.push(Buffer.from(chunk)); }
          assert.equal(bytes, receipts[i].bytes); assert.equal(hash(Buffer.concat(chunks)), receipts[i].sha256);
        } finally { if (!response.body?.locked) await response.body?.cancel().catch(() => {}); }
      }
      return { liveVerified: true, family: kind, identity, requests: 2 };
    } catch (error) { if (attempt === 4) throw error; await sleep(10000); }
  }
}
async function main(env, action) {
  const policy = await json(resolve(CYCLE, 'tools/staging-place-renewal-policy.json'));
  const digest = await controllerDigest();
  if (action === 'digest') { console.log(digest); return; }
  const context = renewalGate(env, policy, digest);
  if (action === 'plan') {
    noPublishCredentials(env); assert(!env.STAGING_PLACES_SEED_KEY);
    assert(env.GITHUB_OUTPUT); await appendFile(env.GITHUB_OUTPUT, `run=${context.run}\n`); return;
  }
  assert(context.run, 'family not selected by this event');
  if (action === 'collect') {
    noPublishCredentials(env); assert(!env.STAGING_PLACES_SEED_KEY && context.kind !== 'paragliding');
    assert.equal(safeExecute('git', ['rev-parse', 'HEAD'], context, env, 10000).trim(), context.sourceSha);
    assert.equal(safeExecute('git', ['status', '--porcelain'], context, env, 10000).trim(), '');
    safeExecute('python3', isolatedPythonArguments(resolve(CYCLE, 'tools/staging-place-collect.py'),
      ['--source', context.source, '--root', context.root, '--family', context.kind]), context, env, 45 * 60000);
    console.log(JSON.stringify({ family: context.kind, collected: true })); return;
  }
  if (action === 'download') {
    noPublishCredentials(env); assert(!env.STAGING_PLACES_SEED_KEY && context.kind === 'paragliding');
    await mkdir(context.root, { mode: 0o700 });
    await downloadSeed({ kind: context.kind, tag: policy.paragliding.tag, ciphertextSha256: policy.paragliding.ciphertextSha256, output: resolve(context.root, 'seed.wxps') }); return;
  }
  assert.equal(await realpath(context.root), context.root);
  if (action === 'verify-live') {
    noPublishCredentials(env); assert(!env.STAGING_PLACES_SEED_KEY);
    const candidate = await qualifyPlaces({ kind: context.kind, root: resolve(context.root, 'candidate') });
    console.log(JSON.stringify(await verifyLive(candidate))); return;
  }
  if (action === 'decrypt') {
    noPublishCredentials(env); assert(context.kind === 'paragliding');
    await unpackSeed({ archive: resolve(context.root, 'seed.wxps'), output: resolve(context.root, 'candidate'), evidenceOutput: resolve(context.root, 'checkpoint'),
      key: env.STAGING_PLACES_SEED_KEY, kind: context.kind, sourceSha: policy.paragliding.sourceSha,
      manifestSha256: policy.paragliding.manifestSha256, ciphertextSha256: policy.paragliding.ciphertextSha256, plaintextSha256: policy.paragliding.plaintextSha256 }); return;
  }
  if (action === 'qualify') {
    noPublishCredentials(env); assert(!env.STAGING_PLACES_SEED_KEY);
    const candidate = await qualifyPlaces({ kind: context.kind, root: resolve(context.root, 'candidate') });
    const evidence = await checkpointEvidence(resolve(context.root, 'checkpoint'), context.kind);
    await writeFile(resolve(context.root, 'seed-evidence.json'), JSON.stringify(evidence.document) + '\n', { flag: 'wx', mode: 0o600 });
    context.manifestSha256 = hash(candidate.manifestBody);
    const result = await runRuntimeProof({ ...env, STAGING_PLACES_APPROVED_QUALIFIER_SHA256: policy.qualifierSha256 }, context);
    console.log(JSON.stringify(result)); return;
  }
  assert.equal(action, 'publish'); assert(!env.STAGING_PLACES_SEED_KEY);
  const candidate = await qualifyPlaces({ kind: context.kind, root: resolve(context.root, 'candidate') });
  const proof = await json(resolve(context.root, 'qualification.json'));
  const qualified = await json(resolve(context.root, 'qualified.json'));
  assert.deepEqual(qualified, { sourceSha: context.sourceSha, manifestSha256: hash(candidate.manifestBody),
    qualificationSha256: hash(Buffer.from(JSON.stringify(proof))) });
  const io = await createPlacesS3(env);
  try { console.log(JSON.stringify(await renewQualified(io, candidate, proof, policy, { report: row => console.log(JSON.stringify(row)) }))); }
  finally { io.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.env, process.argv[2]).catch(error => {
    console.error(JSON.stringify(placeFailureDiagnostic(error)));
    console.error('Staging family renewal stopped. Previous pointer is retained unless the verified conditional activation completed; inspect before retry.');
    process.exitCode = 1;
  });
}
