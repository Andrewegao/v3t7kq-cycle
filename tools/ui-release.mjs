// Guarded orchestration only. This program never writes Workers, DNS, bindings, data or settings.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONTROL_SHA, REPOSITORY, MAX_BYTES, gate, hash, createCandidate, validateCandidate,
  readTree, validateFiles, seal, unseal, restore, eligibleRun } from './ui-candidate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL = resolve(ROOT, '../control');
const SOURCE = resolve(ROOT, '../atmos');
const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const ORIGINS = { staging: 'https://staging.weatherx.org', production: 'https://weatherx.org' };
const PROJECTS = { staging: 'weatherx-platform-staging', production: 'atmos-platform' };
const POLICY_FILES = ['.github/workflows/ui-staging.yml', '.github/workflows/ui-release.yml',
  'tools/ui-candidate.mjs', 'tools/ui-release.mjs', 'tools/ui-verify.sh', 'tools/ui-npx.sh'];
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options });
const git = (args, cwd = ROOT) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
export const pipelineDigest = () => hash(POLICY_FILES.map(p => `${p}\0${hash(readFileSync(resolve(ROOT,p)))}`).join('\n'));
const stateFile = () => resolve(process.env.RUNNER_TEMP, 'ui-candidate.json');
function save(file, value) { mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); }
function candidate() { const c = JSON.parse(readFileSync(stateFile())); validateCandidate(c); return c; }
function controller() {
  assert.equal(git(['rev-parse','HEAD']),process.env.GITHUB_SHA, 'release workflow checkout changed');
  git(['diff','--exit-code','HEAD']);
  assert.equal(git(['rev-parse','HEAD'], CONTROL), CONTROL_SHA, 'unqualified release controller');
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
function target(stage) {
  assert.ok(Object.hasOwn(ORIGINS, stage), 'unknown UI target');
  assert.match(process.env.CLOUDFLARE_ACCOUNT_ID ?? '', /^[a-f0-9]{32}$/);
  if (stage === 'production') assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
  assert.ok(process.env.CLOUDFLARE_API_TOKEN, 'dedicated UI Pages token is missing');
  assert.match(process.env.UI_PAGES_CONFIG_SHA256 ?? '', /^[a-f0-9]{64}$/, 'reviewed Pages configuration digest is missing');
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
async function projectSnapshot(stage) {
  const { project } = target(stage);
  const payload = await json(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${project}`, process.env.CLOUDFLARE_API_TOKEN);
  assert.equal(payload.success, true); const p = payload.result;
  assert.equal(p.name, project); assert.equal(p.production_branch, 'main');
  assert.equal(p.source, null, 'Git-linked Pages projects cannot bypass staging/manual gates');
  assert.equal(configurationDigest(p), process.env.UI_PAGES_CONFIG_SHA256, 'Pages configuration changed or is not approved');
  assert.equal(p.deployment_configs?.production?.compatibility_date, '2026-06-23', 'compile/runtime compatibility mismatch');
  assert.deepEqual(p.deployment_configs?.production?.compatibility_flags ?? [], [], 'unreviewed compatibility flags');
  assert.equal(p.canonical_deployment?.latest_stage?.status, 'success');
  return p;
}
export async function publicModes(origin) {
  assert.ok(Object.values(ORIGINS).includes(origin));
  const health = await json(`${origin}/api/platform/health`);
  assert.equal(health.ok, true); assert.equal(health.authMode, 'observe'); assert.equal(health.billingMode, 'disabled');
  const data = await json(`${origin}/api/platform/data-health`);
  assert.equal(data.ok, true); assert.equal(data.catalogMode, 'serve');
  const core = await get(`${origin}/data/gfs/index.json`);
  assert.ok(core.headers.get('x-weatherx-catalog'), 'core model must use catalog authority');
  const ancillary = await get(`${origin}/data/ledger/index.json`);
  assert.ok(ancillary.headers.get('x-weatherx-release'), 'ledger must use whole-release authority');
}
async function preflight(stage) {
  gate(process.env); controller();
  await projectSnapshot(stage); await publicModes(ORIGINS[stage]);
  run('node', [resolve(CONTROL,'ops/release/verify-weather-feeds.mjs'), ORIGINS[stage]]);
}
function sourceIdentity() {
  assert.match(process.env.ATMOS_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.equal(git(['rev-parse','HEAD'], SOURCE), process.env.ATMOS_SHA);
  assert.equal(git(['rev-parse','origin/master'], SOURCE), process.env.ATMOS_SHA, 'stage the exact current-master source');
  git(['diff','--exit-code','HEAD'], SOURCE);
}
function build() {
  gate(process.env); controller(); sourceIdentity();
  const app = resolve(SOURCE, 'app'), shell = resolve(process.env.RUNNER_TEMP, 'ui-public-shell');
  mkdirSync(shell, { mode: 0o700 });
  run('rsync',['-a','--exclude','/data/','--exclude','/data-atmos/',`${app}/public/`,`${shell}/`]);
  run('npm',['run','build'],{cwd:app, env:{...process.env, ATMOS_CODE_ONLY_BUILD:'1', ATMOS_PUBLIC_RELEASE:'1',
    ATMOS_PUBLIC_SHELL_DIR:shell,VITE_PRODUCT:'lab',VITE_APP:'lab',VITE_PLATFORM_ACCOUNT:'0',
    VITE_MODEL_EXPANSION_QUALIFICATION:'0',VITE_MODEL_LOCAL_BASE:''}});
  const dist = resolve(app,'dist');
  // Compile once BEFORE qualification; production must never discover/recompile functions/.
  run(resolve(CONTROL,'platform/edge/node_modules/.bin/wrangler'), ['pages','functions','build',resolve(app,'functions'),
    '--project-directory',app,'--outfile',resolve(dist,'_worker.js'),'--output-routes-path',resolve(dist,'_routes.json'),
    '--compatibility-date','2026-06-23','--minify','--sourcemap=false'], {cwd:app});
  run('node',[resolve(CONTROL,'ops/release/build-release-receipt.mjs'),dist,resolve(dist,'health/release.json')]);
  const c = createCandidate(dist,{sourceSha:process.env.ATMOS_SHA,runId:process.env.GITHUB_RUN_ID,
    attempt:process.env.GITHUB_RUN_ATTEMPT,workflowSha:process.env.GITHUB_SHA,pipelineDigest:pipelineDigest()});
  save(stateFile(),c);
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
async function exactStaging(c) {
  // Conservative: promotion refuses if staging has since changed; never promote an unreviewed
  // latest build just because a previous build passed. Restage if this receipt is no longer live.
  const { bytes } = await get(`${ORIGINS.staging}/health/release.json?candidate=${c.artifactDigest}`);
  assert.equal(hash(bytes), c.files.find(f=>f.path==='health/release.json').sha256, 'staging no longer serves this candidate');
  const index = await get(`${ORIGINS.staging}/?candidate=${c.artifactDigest}`);
  assert.equal(hash(index.bytes), c.files.find(f=>f.path==='index.html').sha256);
  await publicModes(ORIGINS.staging);
}
async function deploy(stage) {
  await preflight(stage);
  const c = candidate();
  if (stage === 'production') { await auditRun(c); await exactStaging(c); }
  const dist = stage === 'staging' ? resolve(SOURCE,'app/dist') : resolve(process.env.RUNNER_TEMP,'ui-promote-dist');
  assert.equal(validateFiles(readTree(dist)).digest,c.artifactDigest, 'deploy bytes differ from candidate');
  const env = environment(c);
  // Work outside the Atmos app: no wrangler config discovery, no Functions discovery/rebuild.
  const uploadCwd=resolve(process.env.RUNNER_TEMP,'ui-upload-cwd'); mkdirSync(uploadCwd,{recursive:true,mode:0o700});
  run('bash',[resolve(CONTROL,'ops/release/guard-pages-deploy.sh'),'--project',PROJECTS[stage],
    '--branch','main','--dir',dist,'--receipt',resolve(dist,'health/release.json'),'--',
    'bash',resolve(ROOT,'tools/ui-verify.sh'),stage], {cwd:uploadCwd,env});
  assert.equal(validateFiles(readTree(dist)).digest,c.artifactDigest, 'deployment modified artifact');
  if (stage === 'staging') {
    const p = await projectSnapshot(stage); await exactStaging(c);
    c.qualification = {origin:ORIGINS.staging, deploymentId:p.canonical_deployment.id,
      artifactDigest:c.artifactDigest,qualifiedAt:new Date().toISOString(),fullTests:true,weatherLab:true,builtRuntime:true,probes:3};
    save(stateFile(),c);
  }
}
async function verify(stage) {
  controller(); await projectSnapshot(stage); await publicModes(ORIGINS[stage]);
  if (stage === 'production' && process.env.RELEASE_GUARD_PHASE !== 'rollback') await exactStaging(candidate());
  run('bash',[resolve(CONTROL,'ops/release/verify-platform-production.sh'),ORIGINS[stage]]);
  if (process.env.RELEASE_GUARD_PHASE !== 'rollback') {
    // Real built-site checks inside the rollback transaction, not after declaring success.
    run('node',[resolve(CONTROL,'app/e2e/weather-lab-only-runtime.mjs')], {cwd:resolve(CONTROL,'app'),env:{...process.env,BASE:ORIGINS[stage]}});
    run('node',[resolve(CONTROL,'app/e2e/layer-switch-tint.mjs')], {cwd:resolve(CONTROL,'app'),env:{...process.env,BASE:ORIGINS[stage]}});
  }
}
function retain() {
  const c=candidate(), out=resolve(process.env.RUNNER_TEMP,'ui-sealed');
  mkdirSync(out,{mode:0o700});
  writeFileSync(resolve(out,'candidate.wxui'),seal(c,process.env.UI_CANDIDATE_KEY),{mode:0o600});
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
  await auditRun(c); await exactStaging(c);
  save(stateFile(),c); restore(c,resolve(process.env.RUNNER_TEMP,'ui-promote-dist'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command,stage]=process.argv.slice(2);
  try {
    if(command==='gate') { gate(process.env); controller(); assert.equal(git(['rev-parse','HEAD']),process.env.GITHUB_SHA); }
    else if(command==='preflight') await preflight(stage);
    else if(command==='build') build();
    else if(command==='deploy') await deploy(stage);
    else if(command==='verify') await verify(stage);
    else if(command==='retain') retain();
    else if(command==='download') await download();
    else throw Error('unknown UI release command');
  } catch(error) { console.error(`UI release refused: ${error.message}`); process.exitCode=1; }
}
