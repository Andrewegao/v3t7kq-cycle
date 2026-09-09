// Guarded orchestration only. This program never writes Workers, DNS, bindings, data or settings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, chmodSync, existsSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {installCompressionOverlay,selectCompressionAssets,validateCompressionFiles} from './ui-static-compression.mjs';
import {verifyStaticCompression} from './ui-static-compression-wire.mjs';
import {staticCompressionProfile} from './ui-staging-models.mjs';
import {verifyProductionGround} from './ui-production-ground.mjs';
import {accountQualificationRequired,runAccountQualification,readAccountProof,accountQualificationBinding,
  requireAccountQualificationBinding} from './ui-staging-account-proof.mjs';
import { controlShaFor, REPOSITORY, MAX_BYTES, gate, hash, createCandidate, validateCandidate,
  readTree, validateFiles, seal, unseal, restore, eligibleRun } from './ui-candidate.mjs';
import { packBuild, unpackBuild, eligibleBuild } from './ui-build-transfer.mjs';
import {profileFor,validateProfile,selectionProfile,coreReleaseProfile,canonical as profileCanonical,readSelection,requireProductionProfile,requireStagingApproval,SELECTION_ASSET,browserEnvironment,validateBrowserReceipt,validateCoreBrowserReceipt} from './ui-staging-models.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL = resolve(ROOT, '../control');
const SOURCE = resolve(ROOT, '../atmos');
const STAGING_RELEASE_GUARD_SHA = '164a469189da2c8303c997d4020b3ae20da84cd7';
const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const ORIGINS = { staging: 'https://staging.weatherx.org', production: 'https://weatherx.org' };
const PROJECTS = { staging: 'weatherx-platform-staging', production: 'atmos-platform' };
const SAFE_CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const CORE_CATALOG_MODELS = ['ecmwf','gfs'];
export const POLICY_FILES = ['.github/workflows/ui-staging.yml', '.github/workflows/ui-release.yml',
  'tools/ui-candidate.mjs', 'tools/ui-build-transfer.mjs', 'tools/ui-release.mjs', 'tools/ui-verify.sh', 'tools/ui-npx.sh',
  'tools/ui-staging-models.mjs','tools/ui-staging-model-browser.mjs','tools/ui-staging-core-browser.mjs','tools/ui-staging-preflight.mjs',
  'tools/ui-staging-account-proof.mjs',
  'tools/ui-static-compression.mjs','tools/ui-static-compression-wire.mjs',
  'tools/ui-production-ground.mjs','docs/production-ground-review-20260907.md'];
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
export const pipelineDigest = (profile=profileFor(),root=ROOT) => hash(POLICY_FILES.map(p => `${p}\0${hash(readFileSync(resolve(root,p)))}`)
  .concat([`profile\0${hash(Buffer.from(profileCanonical(validateProfile(profile))))}`])
  .concat(selectionProfile(profile)?[`staging-selections/${profile.modelSelectionSha256}.json\0${hash(readSelection(root,profile,null).bytes)}`]:[]).join('\n'));
const stateFile = () => resolve(process.env.RUNNER_TEMP, 'ui-candidate.json');
function save(file, value) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
function candidate() { const c = JSON.parse(readFileSync(stateFile())); validateCandidate(c); return c; }
function controller(profile = profileFor(process.env.MODEL_SELECTION_SHA256)) {
  assert.equal(git(['rev-parse','HEAD']),process.env.GITHUB_SHA, 'release workflow checkout changed');
  git(['diff','--exit-code','HEAD']);
  assert.equal(git(['rev-parse','HEAD'], CONTROL), controlShaFor(profile), 'unqualified release controller');
  git(['diff','--exit-code','HEAD'], CONTROL);
}
async function get(url, token, limit = 2 * 1024 * 1024) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'Cache-Control': 'no-cache', ...(token ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } : {}) } });
  assert.equal(response.status, 200, `read failed (${response.status}): ${new URL(url).pathname}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= limit, 'response too large'); chunks.push(chunk); }
  return { bytes: Buffer.concat(chunks), headers: response.headers };
}
const json = async (url, token) => JSON.parse((await get(url, token)).bytes);
const gh = path => json(`https://api.github.com/repos/${REPOSITORY}/${path}`, process.env.GITHUB_TOKEN);
export function target(stage, env=process.env) {
  assert.ok(Object.hasOwn(ORIGINS, stage), 'unknown UI target');
  assert.equal(env.GITHUB_ACTIONS,'true'); assert.equal(env.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(env.GITHUB_JOB,stage==='staging'?'qualify':'promote','wrong publishing job');
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
  assert.ok(env.CLOUDFLARE_API_TOKEN, 'dedicated UI Pages token is missing');
  assert.match(env.UI_PAGES_CONFIG_SHA256 ?? '', /^[a-f0-9]{64}$/, 'reviewed Pages configuration digest is missing');
  return { origin: ORIGINS[stage], project: PROJECTS[stage] };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k,canonical(value[k])]));
  return value;
}
export function configurationDigest(project) {
  // Hash secret/config values without printing them. Volatile deployment pointers are excluded.
  return hash(JSON.stringify(canonical({ name: project.name, production_branch: project.production_branch,
    source: project.source ?? null, domains: project.domains, config: project.deployment_configs?.production })));
}
export const STAGING_ALLOWED_ENV_VARS = Object.freeze({ FORECAST_FALLBACK_ACCESS: 'non-commercial' });
export const STAGING_AI_AUTH_POLICY = 'staging-account-v1';
export const STAGING_AI_SERVICE = Object.freeze({
  service: 'weatherx-platform-edge-staging',
  environment: 'production',
  entrypoint: 'StagingAiAdmission',
});
const STAGING_AI_ENV_NAMES = Object.freeze(['AI_API_KEY', 'AI_AUTH_POLICY']);
export function stagingEnvVarAllowed(name, entry, context = 'production') {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  // The account-backed relay is available only in the staging project's main context.
  // API snapshots redact the provider secret value: this proves type/shape, not key
  // validity or the approved user/global counters. Live policy probes remain required.
  if (name === 'AI_API_KEY') return context === 'production'
    && entry.type === 'secret_text'
    && Object.keys(entry).every(key => key === 'type' || key === 'value')
    && (!Object.hasOwn(entry, 'value') || typeof entry.value === 'string');
  if (name === 'AI_AUTH_POLICY') return context === 'production'
    && entry.type === 'plain_text' && entry.value === STAGING_AI_AUTH_POLICY
    && Object.keys(entry).every(key => key === 'type' || key === 'value');
  if (!Object.hasOwn(STAGING_ALLOWED_ENV_VARS, name)) return false;
  // A plain_text entry must carry exactly the approved value; a secret_text entry (set through
  // `wrangler pages secret put`) carries no value in the API payload and is accepted by name only.
  if (entry.type === 'plain_text') return entry.value === STAGING_ALLOWED_ENV_VARS[name] && Object.keys(entry).every(key => key === 'type' || key === 'value');
  if (entry.type === 'secret_text') return Object.keys(entry).every(key => key === 'type' || key === 'value');
  return false;
}
function stagingServiceBindingAllowed(name, entry, context) {
  if (context !== 'production' || name !== 'WX_AI_ADMISSION'
    || entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  return entry.service === STAGING_AI_SERVICE.service
    && entry.environment === STAGING_AI_SERVICE.environment
    && entry.entrypoint === STAGING_AI_SERVICE.entrypoint
    && Object.keys(entry).length === 3
    && Object.keys(STAGING_AI_SERVICE).every(key => Object.hasOwn(entry, key));
}
export function validateStagingPagesBindings(project) {
  // Pages "production" means the main branch of THIS staging project, not WeatherX
  // production. Neither context may give the shell direct database/storage access;
  // the sole capability below may validate a session and consume bounded AI quota.
  // Only the fallback and the explicitly reviewed account-backed AI profile are
  // allowed. A secret mislabeled plain_text must never become an exception.
  // Runtime-only API metadata is allowlisted; future nonempty resource maps fail closed.
  const runtimeFields = new Set(['compatibility_date', 'compatibility_flags', 'always_use_latest_compatibility_date',
    'usage_model', 'placement', 'limits', 'fail_open', 'build_image_major_version', 'wrangler_config_hash']);
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const configs = project.deployment_configs;
  assert.ok(record(configs) && record(configs.production), 'staging Pages production configuration is missing');
  for (const [context, config] of Object.entries(configs)) {
    assert.ok(context === 'production' || context === 'preview', 'unreviewed staging Pages configuration context');
    if (context === 'preview' && config == null) continue;
    assert.ok(record(config), 'invalid staging Pages configuration');
    for (const [field, value] of Object.entries(config)) {
      if (runtimeFields.has(field)) continue;
      if (field === 'env_vars' && record(value)) {
        for (const [name, entry] of Object.entries(value)) assert.ok(stagingEnvVarAllowed(name, entry, context), `staging Pages ${context}.env_vars.${name} bindings/resources must be empty unless explicitly approved by the staging environment policy`);
        continue;
      }
      if (field === 'services' && record(value)) {
        for (const [name, entry] of Object.entries(value)) assert.ok(stagingServiceBindingAllowed(name, entry, context),
          `staging Pages ${context}.services.${name} is not the approved staging AI admission binding; other bindings/resources must be empty`);
        continue;
      }
      assert.ok(value === null || value === undefined || (record(value) && Object.keys(value).length === 0),
        `staging Pages ${context}.${field} bindings/resources must be empty`);
    }
    const envVars = record(config.env_vars) ? config.env_vars : {};
    const services = record(config.services) ? config.services : {};
    const aiEnvCount = STAGING_AI_ENV_NAMES.filter(name => Object.hasOwn(envVars, name)).length;
    const aiServiceCount = Object.hasOwn(services, 'WX_AI_ADMISSION') ? 1 : 0;
    assert.ok((aiEnvCount === 0 && aiServiceCount === 0)
      || (context === 'production' && aiEnvCount === STAGING_AI_ENV_NAMES.length && aiServiceCount === 1),
    `staging Pages ${context} requires the complete staging account AI profile or none of it`);
  }
}
export function describeConfiguration(project) {
  const prod = project.deployment_configs?.production ?? {};
  const vars = Object.entries(prod.env_vars ?? {}).map(([name, entry]) => `${name}:${entry?.type ?? 'unknown'}`).sort();
  return `production_branch=${project.production_branch}, domains=[${(project.domains ?? []).join(',')}], env_vars=[${vars.join(',')}], compatibility_date=${prod.compatibility_date}`;
}
export function validateProjectSnapshot(stage, p, expectedDigest) {
  assert.ok(Object.hasOwn(PROJECTS, stage), 'unknown UI target');
  const project = PROJECTS[stage];
  assert.equal(p.name, project); assert.equal(p.production_branch, 'main');
  assert.ok(p.source === null || p.source === undefined, 'Git-linked Pages projects cannot bypass staging/manual gates');
  if (stage === 'staging') validateStagingPagesBindings(p);
  const observedDigest = configurationDigest(p);
  // The refusal names both digests and the non-sensitive shape of the change (variable names and
  // types, domains, compatibility) so the reviewer can approve without a Cloudflare token; values
  // are never printed.
  assert.equal(observedDigest, expectedDigest, `Pages configuration changed or is not approved (observed ${observedDigest}, approved ${expectedDigest ?? 'none'}; ${describeConfiguration(p)})`);
  assert.equal(p.deployment_configs?.production?.compatibility_date, '2026-06-23', 'compile/runtime compatibility mismatch');
  assert.deepEqual(p.deployment_configs?.production?.compatibility_flags ?? [], [], 'unreviewed compatibility flags');
  assert.equal(p.canonical_deployment?.latest_stage?.status, 'success');
  return p;
}
async function projectSnapshot(stage) {
  if(stage==='production') requireProductionProfile(candidate().profile);
  const { project } = target(stage);
  const payload = await json(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${project}`, process.env.CLOUDFLARE_API_TOKEN);
  assert.equal(payload.success, true);
  return validateProjectSnapshot(stage, payload.result, process.env.UI_PAGES_CONFIG_SHA256);
}
export function validatePublicModes(origin, health, data, profile=profileFor(),phase='candidate') {
  assert.ok(Object.values(ORIGINS).includes(origin));
  assert.ok(['preflight','candidate','rollback'].includes(phase), 'unknown UI verification phase');
  validateProfile(profile);
  if(origin===ORIGINS.production)requireProductionProfile(profile);
  // Staging has public/cacheable weather reads; production's reviewed platform
  // remains observe while its separate data Worker owns the public data routes.
  assert.equal(health.ok, true);
  assert.equal(health.authMode, origin === ORIGINS.staging ? 'public' : 'observe');
  assert.equal(health.billingMode, profile.account ? 'enabled' : 'disabled');
  assert.equal(data.ok, true); assert.equal(data.catalogMode, 'serve');
  if (origin === ORIGINS.staging) {
    assert.equal(data.authMode, 'public');
    assert.equal(data.dataSource, 'shared');
    assert.equal(data.sharedReadConfigured, true);
    // An exact rollback must remain verifiable when candidate-only catalog
    // qualification disappears. The shared/public read contract remains mandatory.
    if (phase === 'rollback') return null;
    assert.equal(data.catalog?.status, 'available');
    assert.match(data.catalog?.catalogId ?? '', SAFE_CATALOG_ID, 'staging catalog identity is invalid');
    for (const model of CORE_CATALOG_MODELS) {
      assert.equal(data.catalog?.nativeViewport?.[model], true, `${model} native viewport is not qualified`);
    }
    return data.catalog.catalogId;
  }
  return null;
}
export function standaloneWeatherFeedVerificationRequired(stage, phase) {
  assert.ok(Object.hasOwn(ORIGINS, stage), 'unknown UI target');
  assert.ok(['preflight','candidate','rollback'].includes(phase), 'unknown UI verification phase');
  // Production must already be healthy before a release starts. Candidate feed
  // checks run inside verify-platform-production.sh's bounded consecutive soak;
  // do not append a second single-shot probe that can reject a healthy soak on
  // one transient upstream response. Rollback verifies the exact prior build's
  // approved capabilities and therefore never adds a candidate-only feed probe.
  return phase === 'preflight' && stage === 'production';
}
function verifyWeatherFeeds(stage) {
  run('node', [resolve(CONTROL,'ops/release/verify-weather-feeds.mjs'), ORIGINS[stage]]);
}
export async function publicModes(origin,profile=profileFor(),phase='candidate') {
  assert.ok(Object.values(ORIGINS).includes(origin));
  const health = await json(`${origin}/api/platform/health`);
  const data = await json(`${origin}/api/platform/data-health`);
  const catalogId = validatePublicModes(origin, health, data,profile,phase);
  if (origin === ORIGINS.staging && phase !== 'rollback') {
    for (const model of CORE_CATALOG_MODELS) {
      const core = await get(`${origin}/data/_catalog/${catalogId}/${model}/index.json`);
      assert.match(core.headers.get('content-type')??'',/^application\/json(?:;|$)/i,
        `${model} immutable index must be JSON`);
      assert.equal(core.headers.get('x-weatherx-catalog'),catalogId,`${model} immutable catalog identity changed`);
      assert.equal(core.headers.get('x-weatherx-data-source'),'shared',`${model} immutable index did not use the shared source`);
      assert.equal(core.headers.get('x-weatherx-release'),null,`${model} immutable index used whole-release authority`);
      const index=JSON.parse(core.bytes.toString('utf8'));
      assert.equal(index?.schemaVersion,1,`${model} immutable index schema changed`);
      assert.equal(index?.model,model,`${model} immutable index model changed`);
      assert.ok(Array.isArray(index?.runs)&&index.runs.length>0,`${model} immutable index has no runs`);
      for(const run of index.runs){
        const time=typeof run?.init_time==='string'?Date.parse(run.init_time):Number.NaN;
        assert.ok(Number.isFinite(time),`${model} immutable index has an invalid run time`);
        const iso=new Date(time).toISOString();
        assert.equal(run.path,`runs/${iso.slice(0,4)}${iso.slice(5,7)}${iso.slice(8,10)}${iso.slice(11,13)}/`,
          `${model} immutable index run identity changed`);
      }
    }
  } else {
    // Production and an exact staging rollback retain the reviewed mutable-alias
    // probe. Candidate/preflight staging alone requires immutable catalog proof.
    const core = await get(`${origin}/data/gfs/index.json`);
    assert.ok(core.headers.get('x-weatherx-catalog'), 'core model must use catalog authority');
  }
  const ancillary = await get(`${origin}/data/ledger/index.json`);
  assert.ok(ancillary.headers.get('x-weatherx-release'), 'ledger must use whole-release authority');
}
async function preflight(stage) {
  // Artifact authority is checked before even a read-only production CF API call.
  const c=candidate();
  if(stage==='production') { requireProductionProfile(c.profile); verifyProductionGround(c.files); }
  else requireStagingApproval(c,process.env);
  gate(process.env); controller();
  await projectSnapshot(stage); await publicModes(ORIGINS[stage],c.profile,'preflight');
  if (standaloneWeatherFeedVerificationRequired(stage, 'preflight')) verifyWeatherFeeds(stage);
}
export function requiredSourceGuard(profile) {
  validateProfile(profile);
  if (profile.account) return controlShaFor(profile);
  if (staticCompressionProfile(profile)) return '0eeec07e06e5e48b53d41bf3590218a856432b32';
  if (coreReleaseProfile(profile)) return '0eeec07e06e5e48b53d41bf3590218a856432b32';
  return profile.stagingOnly ? STAGING_RELEASE_GUARD_SHA : null;
}
function sourceIdentity(profile) {
  assert.match(process.env.ATMOS_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.equal(git(['rev-parse','HEAD'], SOURCE), process.env.ATMOS_SHA);
  assert.equal(git(['rev-parse','origin/master'], SOURCE), process.env.ATMOS_SHA, 'stage the exact current-master source');
  git(['diff','--exit-code','HEAD'], SOURCE);
  if (requiredSourceGuard(profile)) git(['merge-base','--is-ancestor',requiredSourceGuard(profile),'HEAD'], SOURCE);
}
export function publicBuildEnvironment(profile,selection,env=process.env) {
  validateProfile(profile);
  const selected=selectionProfile(profile),core=coreReleaseProfile(profile);
  if (selected) {
    assert.ok(Buffer.isBuffer(selection?.bytes), 'staging experiment selection bytes are required');
    assert.equal(hash(selection.bytes),profile.modelSelectionSha256,'staging experiment selection differs from profile');
  } else assert.equal(selection,null,'non-selection build cannot carry a staging selection');
  return {...env,ATMOS_CODE_ONLY_BUILD:'1',ATMOS_PUBLIC_RELEASE:profile.stagingOnly?'0':'1',
    ATMOS_STATIC_COMPRESSION_PROFILE:staticCompressionProfile(profile)?'static-br11-v1':'',
    VITE_SPRITE_WEBP_QUALIFICATION:core?'1':'0',
    ATMOS_STAGING_EXPERIMENT_RELEASE:profile.stagingOnly?'1':'0',VITE_PRODUCT:'lab',VITE_APP:'lab',VITE_PLATFORM_ACCOUNT:profile.account?'1':'0',
    ATMOS_STAGING_ACCOUNT_PROFILE:profile.account?'staging-account-v1':'',
    ...(profile.account?{VITE_PLATFORM_DATA_AUTH:'public'}:{}),
    ATMOS_STAGING_RELEASE_ROSTER:core?'1':'0',VITE_MODEL_EXPANSION_QUALIFICATION:profile.stagingOnly?'1':'0',VITE_MODEL_LOCAL_BASE:'',
    VITE_STAGING_MODEL_ADMISSION:selected?'1':'0',VITE_STAGING_MODEL_SELECTION_SHA256:profile.modelSelectionSha256??''};
}
export function installPagesWorker(workerOut,dist) {
  assert.deepEqual(readdirSync(workerOut),['index.js'], 'Pages Functions build emitted unexpected modules');
  const source=readFileSync(resolve(workerOut,'index.js'));
  assert.ok(source.length>0,'Pages Functions build emitted an empty Worker');
  const prefix=source.subarray(0,1024).toString('utf8');
  assert.doesNotMatch(prefix,/Content-Disposition:\s*form-data/i,
    'Pages Functions build emitted a multipart upload bundle instead of JavaScript');
  const target=resolve(dist,'_worker.js');
  assert.equal(existsSync(target),false,'Pages Functions build must not overwrite an existing Worker');
  const syntaxProbe=resolve(workerOut,'syntax-probe.mjs');
  writeFileSync(syntaxProbe,source,{flag:'wx',mode:0o600});
  try { run(process.execPath,['--check',syntaxProbe]); } finally { unlinkSync(syntaxProbe); }
  writeFileSync(target,source,{flag:'wx',mode:0o600});
}
export async function packagePagesWorker(profile,{app,dist,workerOut,overlay}) {
  validateProfile(profile);
  if (!staticCompressionProfile(profile)) { installPagesWorker(workerOut,dist); return; }
  // Candidate modules run ONLY on the credential-free build runner. The publishing
  // runner independently validates the resulting opaque bytes through ui-candidate.
  assert.deepEqual(readdirSync(workerOut),['index.js'],'Pages Functions build emitted unexpected modules');
  const {packageStaticCompression}=await import(pathToFileURL(resolve(app,'scripts/package-static-compression.mjs')).href);
  const originalWorkerPath=resolve(workerOut,'index.js'),originalRoutesPath=resolve(dist,'_routes.json');
  await packageStaticCompression({originalWorkerPath,originalRoutesPath,assetRoot:dist,
    selectedPaths:selectCompressionAssets(dist),outputDir:overlay,
    origin:ORIGINS.staging,qualificationScope:'staging-only-nonpromotable'});
  installCompressionOverlay({dist,overlay,originalWorkerPath,originalRoutesPath});
}
async function build() {
  buildGate(); controller();
  const profile=profileFor(process.env.MODEL_SELECTION_SHA256),selection=readSelection(ROOT,profile);
  sourceIdentity(profile);
  const app = resolve(SOURCE, 'app'), shell = resolve(process.env.RUNNER_TEMP, 'ui-public-shell');
  mkdirSync(shell, { mode: 0o700 });
  run('rsync',['-a','--exclude','/data/','--exclude','/data-atmos/',`${app}/public/`,`${shell}/`]);
  assert.ok(!existsSync(resolve(shell,SELECTION_ASSET)),'candidate source must not supply selection policy');
  if(selection){mkdirSync(dirname(resolve(shell,SELECTION_ASSET)),{recursive:true,mode:0o700});writeFileSync(resolve(shell,SELECTION_ASSET),selection.bytes,{flag:'wx',mode:0o600});}
  run('npm',['run','build'],{cwd:app,env:{...publicBuildEnvironment(profile,selection),ATMOS_PUBLIC_SHELL_DIR:shell}});
  const dist = resolve(app,'dist');
  // Compile once BEFORE qualification; production must never discover/recompile functions/.
  // Wrangler 4.123+ writes a multipart upload envelope for --outfile. Build
  // through --outdir, then admit only the single executable module that Pages
  // advanced mode expects as dist/_worker.js.
  const workerOut=resolve(process.env.RUNNER_TEMP,'ui-pages-worker');mkdirSync(workerOut,{mode:0o700});
  run(resolve(CONTROL,'platform/edge/node_modules/.bin/wrangler'), ['pages','functions','build',resolve(app,'functions'),
    '--project-directory',app,'--outdir',workerOut,'--output-routes-path',resolve(dist,'_routes.json'),
    '--compatibility-date','2026-06-23','--minify','--sourcemap=false'], {cwd:app});
  await packagePagesWorker(profile,{app,dist,workerOut,overlay:resolve(process.env.RUNNER_TEMP,'ui-static-compression-overlay')});
  run('node',[resolve(CONTROL,'ops/release/build-release-receipt.mjs'),dist,resolve(dist,'health/release.json')],{env:publicBuildEnvironment(profile,selection)});
  const c = createCandidate(dist,{sourceSha:process.env.ATMOS_SHA,runId:process.env.GITHUB_RUN_ID,
    attempt:process.env.GITHUB_RUN_ATTEMPT,workflowSha:process.env.GITHUB_SHA,pipelineDigest:pipelineDigest(profile),profile});
  save(stateFile(),c);
}
function buildGate() {
  assert.equal(process.env.GITHUB_ACTIONS,'true');assert.equal(process.env.RUNNER_ENVIRONMENT,'github-hosted');
  assert.equal(process.env.GITHUB_REPOSITORY,REPOSITORY);
  assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_dispatch');assert.equal(process.env.GITHUB_REF,'refs/heads/main');
  assert.equal(process.env.GITHUB_JOB,'build');assert.equal(process.env.UI_BUILDS_ENABLED,'true');
  assert.ok(process.env.UI_BUILD_PUBLIC_KEY?.includes('BEGIN PUBLIC KEY'));
  for(const k of ['CLOUDFLARE_API_TOKEN','UI_BUILD_PRIVATE_KEY','UI_CANDIDATE_KEY']) assert.equal(process.env[k],undefined);
  readSelection(ROOT,profileFor(process.env.MODEL_SELECTION_SHA256));
}
function pack() {
  buildGate();controller();
  const out=resolve(process.env.RUNNER_TEMP,'ui-build');mkdirSync(out,{mode:0o700});
  writeFileSync(resolve(out,'build.wxub'),packBuild(candidate(),process.env.UI_BUILD_PUBLIC_KEY),{flag:'wx',mode:0o600});
}
async function receiveBuild() {
  gate(process.env);controller();assert.equal(process.env.GITHUB_JOB,'qualify');
  const id=process.env.GITHUB_RUN_ID, attempt=process.env.GITHUB_RUN_ATTEMPT;
  assert.match(id??'',/^[1-9][0-9]{0,19}$/);assert.match(attempt??'',/^[1-9][0-9]{0,19}$/);
  const r=await gh(`actions/runs/${id}`), a=await gh(`actions/runs/${id}/artifacts?per_page=100`);
  const jobs=await gh(`actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`);
  assert.ok(a.total_count<=100 && jobs.total_count<=100);
  const name=`ui-build-${id}-${attempt}`, matches=a.artifacts.filter(x=>x.name===name);
  assert.equal(matches.length,1);assert.equal(matches[0].expired,false);
  assert.ok(matches[0].size_in_bytes<MAX_BYTES*2+1024);
  const out=resolve(process.env.RUNNER_TEMP,'ui-build-download');mkdirSync(out,{mode:0o700});
  run('gh',['run','download',id,'--repo',REPOSITORY,'--name',name,'--dir',out],{env:{...process.env,GH_TOKEN:process.env.GITHUB_TOKEN}});
  assert.deepEqual(readdirSync(out),['build.wxub']);
  assert.ok(statSync(resolve(out,'build.wxub')).size<=MAX_BYTES*2+1024);
  const c=unpackBuild(readFileSync(resolve(out,'build.wxub')),process.env.UI_BUILD_PRIVATE_KEY);
  requireStagingApproval(c,process.env);
  eligibleBuild(c,r,jobs.jobs,a.artifacts,{runId:id,attempt,workflowSha:process.env.GITHUB_SHA,
    sourceSha:process.env.ATMOS_SHA,pipelineDigest:pipelineDigest(c.profile),profile:profileFor(process.env.MODEL_SELECTION_SHA256)});
  // Candidate source is absent. Treat every artifact file as opaque data, never execute it.
  restore(c,resolve(process.env.RUNNER_TEMP,'ui-stage-dist'));save(stateFile(),c);
}
function environment(c) {
  const r = validateCandidate(c);
  const adapters=resolve(process.env.RUNNER_TEMP,'ui-upload-bin'); mkdirSync(adapters,{recursive:true,mode:0o700});
  writeFileSync(resolve(adapters,'npx'),readFileSync(resolve(ROOT,'tools/ui-npx.sh')),{mode:0o700});
  chmodSync(resolve(adapters,'npx'),0o700);
  return {...process.env, PATH:`${adapters}:${resolve(CONTROL,'platform/edge/node_modules/.bin')}:${process.env.PATH}`,
    UI_WRANGLER_BIN:resolve(CONTROL,'platform/edge/node_modules/.bin/wrangler'),
    RELEASE_GUARD_INCIDENT_DIR:resolve(process.env.RUNNER_TEMP,'ui-incidents'),
    RELEASE_GUARD_FUSE_MODE:'github',RELEASE_GUARD_EXPECTED_GIT_SHA:c.sourceSha,
    RELEASE_GUARD_VERIFY_REQUIRED_SUCCESSES:'3',RELEASE_GUARD_VERIFY_SLEEP_SECONDS:'15',
    UI_CONTROL_ROOT:CONTROL,UI_CYCLE_ROOT:ROOT,WEATHERX_EXPECTED_RELEASE_ID:r.releaseId};
}
export function platformVerificationEnvironment(stage,phase,env=process.env) {
  assert.ok(Object.hasOwn(ORIGINS,stage),'unknown UI target');
  assert.ok(['candidate','rollback'].includes(phase),'unknown UI verification phase');
  // The staging candidate can legitimately inherit a just-refreshed 600-second hazards document;
  // its one-shot cache-only recovery is not eligible until another 60 seconds later. Keep the
  // ordinary three-success/15-second soak intact, but give only this candidate transaction enough
  // bounded observations to see that convergence. Production and exact rollback retain the pinned
  // verifier's existing attempt policy byte-for-byte through the original environment object.
  return stage==='staging'&&phase==='candidate'
    ? {...env,RELEASE_GUARD_VERIFY_ATTEMPTS:'50'}
    : env;
}
async function exactStaging(c) {
  // Conservative: promotion refuses if staging has since changed; never promote an unreviewed
  // latest build just because a previous build passed. Restage if this receipt is no longer live.
  const { bytes } = await get(`${ORIGINS.staging}/health/release.json?candidate=${c.artifactDigest}`);
  assert.equal(hash(bytes), c.files.find(f=>f.path==='health/release.json').sha256, 'staging no longer serves this candidate');
  const index = await get(`${ORIGINS.staging}/?candidate=${c.artifactDigest}`);
  assert.equal(hash(index.bytes), c.files.find(f=>f.path==='index.html').sha256);
  await publicModes(ORIGINS.staging,c.profile,'candidate');
}
async function deploy(stage) {
  await preflight(stage);
  const c = candidate();
  if (stage === 'production') { await auditRun(c); await exactStaging(c); }
  const dist = stage === 'staging' ? resolve(process.env.RUNNER_TEMP,'ui-stage-dist') : resolve(process.env.RUNNER_TEMP,'ui-promote-dist');
  assert.equal(validateFiles(readTree(dist,c.profile),c.profile).digest,c.artifactDigest, 'deploy bytes differ from candidate');
  const env = environment(c);
  // Work outside the Atmos app: no wrangler config discovery, no Functions discovery/rebuild.
  const uploadCwd=resolve(process.env.RUNNER_TEMP,'ui-upload-cwd'); mkdirSync(uploadCwd,{recursive:true,mode:0o700});
  run('bash',[resolve(CONTROL,'ops/release/guard-pages-deploy.sh'),'--project',PROJECTS[stage],
    '--branch','main','--dir',dist,'--receipt',resolve(dist,'health/release.json'),'--',
    'bash',resolve(ROOT,'tools/ui-verify.sh'),stage], {cwd:uploadCwd,env});
  assert.equal(validateFiles(readTree(dist,c.profile),c.profile).digest,c.artifactDigest, 'deployment modified artifact');
  if (stage === 'staging') {
    const p = await projectSnapshot(stage); await exactStaging(c);
    const selection=requireStagingApproval(c,process.env),modelProof=c.profile.stagingOnly?readFileSync(resolve(process.env.RUNNER_TEMP,'ui-model-browser.json')):null;
    if(modelProof&&selectionProfile(c.profile))validateBrowserReceipt(modelProof,selection,{sourceSha:c.sourceSha,releaseId:validateCandidate(c).releaseId,selectionSha256:c.profile.modelSelectionSha256});
    if(modelProof&&coreReleaseProfile(c.profile))validateCoreBrowserReceipt(modelProof,{sourceSha:c.sourceSha,releaseId:validateCandidate(c).releaseId});
    c.qualification = {origin:ORIGINS.staging, deploymentId:p.canonical_deployment.id,
      artifactDigest:c.artifactDigest,qualifiedAt:new Date().toISOString(),fullTests:true,weatherLab:true,builtRuntime:true,probes:3};
    if(modelProof&&selectionProfile(c.profile))Object.assign(c.qualification,{modelSelectionSha256:c.profile.modelSelectionSha256,modelBrowserReceiptSha256:hash(modelProof),modelBrowserModels:selection.entries.length});
    if(modelProof&&coreReleaseProfile(c.profile))Object.assign(c.qualification,{coreProfile:c.profile.releaseRosterCore,coreBrowserReceiptSha256:hash(modelProof),coreBrowserModels:2});
    if(c.profile.account){
      const accountProof=await readAccountProof({runnerTemp:process.env.RUNNER_TEMP,controlRoot:CONTROL,
        sourceSha:c.sourceSha,releaseId:validateCandidate(c).releaseId});
      Object.assign(c.qualification,accountQualificationBinding(c,accountProof));
    }
    if(staticCompressionProfile(c.profile)){
      const proof=readFileSync(resolve(process.env.RUNNER_TEMP,'ui-compression-wire.json'));
      const manifest=validateCompressionFiles(c.files,true),wire=JSON.parse(proof);
      assert.equal(wire.origin,ORIGINS.staging);assert.equal(wire.sealSha256,manifest.sealSha256);
      assert.deepEqual(wire.rows.map(r=>r.path).sort(),manifest.selectedPaths.slice().sort());
      Object.assign(c.qualification,{staticCompressionSealSha256:manifest.sealSha256,staticCompressionWireSha256:hash(proof),staticCompressionAssets:wire.rows.length});
    }
    save(stateFile(),c);
  }
}
async function verify(stage) {
  const c=candidate();
  const phase=process.env.RELEASE_GUARD_PHASE==='rollback'?'rollback':'candidate';
  if(stage==='production')requireProductionProfile(c.profile);
  else if(phase!=='rollback')requireStagingApproval(c,process.env);
  controller(); await projectSnapshot(stage); await publicModes(ORIGINS[stage],c.profile,phase);
  if (stage === 'production' && phase !== 'rollback') await exactStaging(candidate());
  const verifier=resolve(CONTROL,'ops/release/verify-platform-production.sh');
  if(stage==='staging'&&phase==='candidate') {
    // GNU timeout's default (non-foreground) mode owns a separate process group. A direct KILL
    // therefore bounds the read-only verifier and every curl/node descendant even when a shell
    // exits on TERM before timeout can escalate the rest of its group.
    run('/usr/bin/timeout',['--signal=KILL','15m','bash',verifier,ORIGINS[stage]],
      {env:platformVerificationEnvironment(stage,phase)});
  } else run('bash',[verifier,ORIGINS[stage]]);
  if (phase !== 'rollback') {
    // Real built-site checks inside the rollback transaction, not after declaring success.
    if(stage==='staging'&&staticCompressionProfile(c.profile)) {
      const proof=await verifyStaticCompression(ORIGINS.staging,validateCompressionFiles(c.files,true));
      save(resolve(process.env.RUNNER_TEMP,'ui-compression-wire.json'),proof);
    }
    run('node',[resolve(CONTROL,'app/e2e/weather-lab-only-runtime.mjs')], {cwd:resolve(CONTROL,'app'),env:{...process.env,BASE:ORIGINS[stage]}});
    run('node',[resolve(CONTROL,'app/e2e/layer-switch-tint.mjs')], {cwd:resolve(CONTROL,'app'),env:{...process.env,BASE:ORIGINS[stage]}});
    if(stage==='staging'&&selectionProfile(c.profile)){
      const selectionFile=resolve(process.env.RUNNER_TEMP,'ui-browser-selection.json');
      writeFileSync(selectionFile,Buffer.from(c.files.find(f=>f.path===SELECTION_ASSET).base64,'base64'),{mode:0o600});
      run('node',[resolve(ROOT,'tools/ui-staging-model-browser.mjs')],{cwd:ROOT,env:browserEnvironment(process.env,{
        BASE:ORIGINS.staging,UI_CONTROL_ROOT:CONTROL,UI_SELECTION_FILE:selectionFile,UI_SELECTION_SHA256:c.profile.modelSelectionSha256,
        WEATHERX_EXPECTED_RELEASE_ID:validateCandidate(c).releaseId,UI_EXPECTED_SOURCE_SHA:c.sourceSha,
        UI_MODEL_BROWSER_OUTPUT:resolve(process.env.RUNNER_TEMP,'ui-model-browser.json')})});
    }
    if(stage==='staging'&&coreReleaseProfile(c.profile))run('node',[resolve(ROOT,'tools/ui-staging-core-browser.mjs')],{cwd:ROOT,env:browserEnvironment(process.env,{
      BASE:ORIGINS.staging,UI_CONTROL_ROOT:CONTROL,WEATHERX_EXPECTED_RELEASE_ID:validateCandidate(c).releaseId,UI_EXPECTED_SOURCE_SHA:c.sourceSha,
      UI_MODEL_BROWSER_OUTPUT:resolve(process.env.RUNNER_TEMP,'ui-model-browser.json')})});
    if(accountQualificationRequired(stage,phase,c.profile))await runAccountQualification({candidate:c,
      releaseId:validateCandidate(c).releaseId,runnerTemp:process.env.RUNNER_TEMP,controlRoot:CONTROL});
  }
}
async function retain() {
  const c=candidate(), out=resolve(process.env.RUNNER_TEMP,'ui-sealed');
  let compressionProof,accountProof;
  const selection=requireStagingApproval(c,process.env);
  if(selectionProfile(c.profile)){assert.equal(c.qualification?.modelSelectionSha256,c.profile.modelSelectionSha256);assert.equal(c.qualification?.modelBrowserModels,selection.entries.length);assert.match(c.qualification?.modelBrowserReceiptSha256??'',/^[a-f0-9]{64}$/);}
  if(coreReleaseProfile(c.profile)){assert.equal(c.qualification?.coreProfile,c.profile.releaseRosterCore);assert.equal(c.qualification?.coreBrowserModels,2);assert.match(c.qualification?.coreBrowserReceiptSha256??'',/^[a-f0-9]{64}$/);}
  if(c.profile.account){accountProof=await readAccountProof({runnerTemp:process.env.RUNNER_TEMP,controlRoot:CONTROL,
    sourceSha:c.sourceSha,releaseId:validateCandidate(c).releaseId,requireFresh:false});requireAccountQualificationBinding(c,accountProof);}
  if(staticCompressionProfile(c.profile)){
    const manifest=validateCompressionFiles(c.files,true);
    assert.equal(c.qualification?.staticCompressionSealSha256,manifest.sealSha256);
    assert.equal(c.qualification?.staticCompressionAssets,manifest.selectedPaths.length);
    assert.match(c.qualification?.staticCompressionWireSha256??'',/^[a-f0-9]{64}$/);
    compressionProof=readFileSync(resolve(process.env.RUNNER_TEMP,'ui-compression-wire.json'));
    assert.equal(hash(compressionProof),c.qualification.staticCompressionWireSha256,'wire receipt changed after qualification');
  }
  mkdirSync(out,{mode:0o700});
  writeFileSync(resolve(out,'candidate.wxui'),seal(c,process.env.UI_CANDIDATE_KEY),{mode:0o600});
  // Controller-produced public paths/hashes/cache observations only; no bodies, server code,
  // request headers or credentials. Preserve the exact proof bound into the encrypted candidate.
  if(compressionProof)writeFileSync(resolve(out,'compression-wire.json'),compressionProof,{mode:0o600});
  if(accountProof)writeFileSync(resolve(out,'account-qualification.json'),accountProof.bytes,{flag:'wx',mode:0o600});
  const summary={sourceSha:c.sourceSha,stagingRunId:c.runId,attempt:c.attempt,artifactDigest:c.artifactDigest,
    deploymentId:c.qualification.deploymentId,qualifiedAt:c.qualification.qualifiedAt};
  save(resolve(out,'summary.json'),summary);
  if(process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Qualified UI candidate\n\nSource: \`${c.sourceSha}\`\n\nStaging run: \`${c.runId}\`\n\nArtifact digest: \`${c.artifactDigest}\`\n\nProduction remains unchanged.\n`,{flag:'a'});
}
async function runRecords() {
  const id = process.env.STAGING_RUN_ID;
  assert.match(id ?? '', /^[1-9][0-9]{0,19}$/);
  const r=await gh(`actions/runs/${id}`), a=await gh(`actions/runs/${id}/artifacts?per_page=100`);
  assert.ok(a.total_count<=100,'too many artifacts'); return {r,artifacts:a.artifacts};
}
async function auditRun(c) {
  const {r,artifacts}=await runRecords();
  eligibleRun(r,artifacts,{runId:process.env.STAGING_RUN_ID,sourceSha:process.env.ATMOS_SHA,
    digest:process.env.CANDIDATE_DIGEST,pipelineDigest:pipelineDigest(),candidate:c});
  git(['fetch','--no-tags','origin','main']);
  git(['merge-base','--is-ancestor',r.head_sha,'origin/main']);
}
async function download() {
  gate(process.env); controller();
  const {r,artifacts}=await runRecords();
  assert.equal(r.repository?.full_name,REPOSITORY); assert.equal(r.path,'.github/workflows/ui-staging.yml');
  assert.equal(r.event,'workflow_dispatch'); assert.equal(r.head_branch,'main'); assert.equal(r.conclusion,'success');
  const name=`ui-candidate-${r.id}-${r.run_attempt}`, match=artifacts.filter(a=>a.name===name);
  assert.equal(match.length,1); assert.equal(match[0].expired,false);
  assert.ok(match[0].size_in_bytes < MAX_BYTES*2,'encrypted download exceeds limit');
  const out=resolve(process.env.RUNNER_TEMP,'ui-download'); mkdirSync(out,{mode:0o700});
  run('gh',['run','download',String(r.id),'--repo',REPOSITORY,'--name',name,'--dir',out],{env:{...process.env,GH_TOKEN:process.env.GITHUB_TOKEN}});
  assert.deepEqual(readdirSync(out).sort(),['candidate.wxui','summary.json']);
  assert.ok(statSync(resolve(out,'candidate.wxui')).size<MAX_BYTES*2);
  const c=unseal(readFileSync(resolve(out,'candidate.wxui')),process.env.UI_CANDIDATE_KEY);
  requireProductionProfile(c.profile);
  await auditRun(c); await exactStaging(c);
  save(stateFile(),c); restore(c,resolve(process.env.RUNNER_TEMP,'ui-promote-dist'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command,stage]=process.argv.slice(2);
  try {
    if(command==='gate') { gate(process.env); controller(); assert.equal(git(['rev-parse','HEAD']),process.env.GITHUB_SHA); }
    else if(command==='build-gate') { buildGate(); controller(); }
    else if(command==='pack-build') pack();
    else if(command==='receive-build') await receiveBuild();
    else if(command==='preflight') await preflight(stage);
    else if(command==='build') await build();
    else if(command==='deploy') await deploy(stage);
    else if(command==='verify') await verify(stage);
    else if(command==='retain') await retain();
    else if(command==='download') await download();
    else throw Error('unknown UI release command');
  } catch(error) { console.error(`UI release refused: ${error.message}`); process.exitCode=1; }
}
