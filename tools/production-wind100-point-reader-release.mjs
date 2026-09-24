#!/usr/bin/env node
// One exact-source data Worker version. No route, pointer, Pages, or secret writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { activeVersion, assertSettings, normalizedBindings } from './consumer-refresh.mjs';
import { uploadedVersion, validateLiveSelector } from './platform-wind100-worker-release.mjs';

const exec = promisify(execFile);
const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const ZONE = '9dc4df7c3c094ab9a11dd00d378adc26';
const WORKER = 'weatherx-data-edge-production';
export const SOURCE = 'f5dc141ef83f209a4cb7637447f87e1b43da7450';
const WORKFLOW = 'Andrewegao/v3t7kq-cycle/.github/workflows/production-wind100-point-reader-release.yml@refs/heads/main';
const ROOT = 'https://api.cloudflare.com/client/v4';
const SCRIPT = `${ROOT}/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
const ORIGIN = 'https://weatherx.org';
const FLAG = 'PRODUCTION_WIND100_DYNAMIC_ENABLED';
const POINT = '/api/v1/point-series/ecmwf';
const ROUTE = 'weatherx.org/api/v1/point-series/*';
const wait = ms => new Promise(done => setTimeout(done, ms));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a,b,message) => assert.equal(JSON.stringify(a),JSON.stringify(b),message);

export function releaseConfig(raw) {
  assert.equal(raw?.main, 'src/dataEdge.ts');
  assert.equal(raw?.account_id, ACCOUNT);
  const value = { ...raw, ...raw.env?.['production-serve'] };
  delete value.env;
  assert.equal(value.name, WORKER);
  assert.equal(value.workers_dev, false);
  assert.equal(raw.preview_urls, false);
  assert.equal(value.vars?.AUTH_MODE, 'public');
  assert.equal(value.vars?.DATA_CATALOG_MODE, 'serve');
  assert.equal(value.vars?.[FLAG], '1');
  return value;
}

export function priorConfig(candidate, activeBindings) {
  const previous = structuredClone(candidate);
  const flags = activeBindings.filter(binding => binding.name === FLAG);
  assert.ok(flags.length <= 1, 'duplicate live Wind100 flag');
  if (!flags.length) delete previous.vars[FLAG];
  else {
    same(flags[0], { name:FLAG, type:'plain_text', text:'0' }, 'previous Wind100 flag was not disabled');
    previous.vars[FLAG] = '0';
  }
  return previous;
}

export function assertPrevious(candidate, active, latest) {
  const prior = priorConfig(candidate, active.bindings);
  assertSettings(prior, active);
  // The latest draft may differ from the active version after a previous rollback.
  const flags = latest.bindings.filter(binding => binding.name === FLAG);
  assert.ok(flags.length <= 1, 'duplicate latest Wind100 flag');
  assertSettings(flags[0]?.text === '1' ? candidate : prior, latest);
}

export function assertRoutes(routes, candidate) {
  const own = routes.filter(route => route.script === WORKER);
  const wanted = [...candidate.routes.map(route => route.pattern), ROUTE].sort();
  same(own.map(route => route.pattern).sort(), wanted, 'data Worker route inventory drift');
  assert.equal(own.find(route => route.pattern === ROUTE)?.script, WORKER);
  return routes.map(route => ({ id:route.id, pattern:route.pattern,
    script:route.script, request_limit_fail_open:route.request_limit_fail_open ?? false }))
    .sort((a,b) => a.id.localeCompare(b.id));
}

export function assertPoint(value, selector, base) {
  assert.equal(value?.schemaVersion, base.schemaVersion);
  assert.equal(value?.model, 'ecmwf');
  assert.equal(value?.runId, selector.runId);
  assert.equal(value?.releaseId, base.releaseId);
  assert.equal(value?.quality, 'complete');
  same(value.series?.wind_speed, base.series?.wind_speed, 'base wind-speed samples changed');
  const samples = value.series?.wind_speed_100m?.samples;
  assert.ok(Array.isArray(samples) && samples.length >= 2, 'Wind100 samples missing');
  assert.ok(samples.every(sample => Number.isFinite(sample.value) &&
    typeof sample.validTime === 'string'), 'Wind100 samples invalid');
  same(samples.map(sample => sample.validTime),
    base.series.wind_speed.samples.map(sample => sample.validTime),
    'Wind100 sample times differ from base series');
}

function context(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_WORKFLOW_REF, WORKFLOW);
  assert.equal(env.GITHUB_JOB, 'release');
  assert.equal(env.ATMOS_SHA, SOURCE);
  assert.ok(env.DATA_EDGE_TOKEN, 'dedicated data Worker token required');
  assert.ok(!env.PLATFORM_EDGE_TOKEN && !env.UI_PRODUCTION_PAGES_TOKEN,
    'unrelated release credentials are forbidden');
  assert.match(env.RECEIPT ?? '', /^\//);
  assert.match(env.ATMOS_ROOT ?? '', /^\//);
  const head = execFileSync('git',['rev-parse','HEAD'],{cwd:env.ATMOS_ROOT,encoding:'utf8'}).trim();
  assert.equal(head,SOURCE,'source checkout changed');
  execFileSync('git',['diff','--exit-code','HEAD'],{cwd:env.ATMOS_ROOT,stdio:'pipe'});
  const config = releaseConfig(JSON.parse(readFileSync(resolve(env.ATMOS_ROOT,'platform/edge/wrangler.data.jsonc'))));
  return { env, config, wrangler:resolve(env.ATMOS_ROOT,'platform/edge/node_modules/wrangler/bin/wrangler.js'),
    cwd:resolve(env.ATMOS_ROOT,'platform/edge') };
}

async function api(url, token) {
  const response = await fetch(url,{redirect:'error',signal:AbortSignal.timeout(20_000),
    headers:{Authorization:`Bearer ${token}`}});
  assert.equal(response.status,200,'protected API read failed');
  const payload = await response.json();
  assert.equal(payload?.success,true,'protected API read rejected');
  return payload.result;
}

async function publicJson(path) {
  const response = await fetch(`${ORIGIN}${path}`,{redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15_000)});
  assert.equal(response.status,200,`${path} HTTP ${response.status}`);
  return response.json();
}

const baseQuery = new URLSearchParams({lat:'35',lon:'104',variables:'wind_speed',
  start:'2026-09-24T00:00:00.000Z',end:'2026-09-25T00:00:00.000Z'});
export function wind100Query(selector) {
  const query = new URLSearchParams(baseQuery);
  query.set('optionalVariables','wind_speed_100m');
  query.set('run',selector.runId);
  query.set('catalog',selector.catalogId);
  query.set('selection',selector.selectionSha256);
  return query;
}

async function publicBoundary() {
  const [selector,health,base] = await Promise.all([
    publicJson('/api/platform/production-wind100/current'),
    publicJson('/api/platform/data-health'),
    publicJson(`${POINT}?${baseQuery}`),
  ]);
  validateLiveSelector(selector);
  assert.equal(base?.model,'ecmwf');
  assert.equal(base?.quality,'complete');
  assert.equal(base?.runId,selector.runId);
  assert.ok(Array.isArray(base.series?.wind_speed?.samples));
  return {selector,health,base};
}

async function remoteBoundary(ctx) {
  const token=ctx.env.DATA_EDGE_TOKEN;
  const [settings,deployments,routes,schedules,subdomain] = await Promise.all([
    api(`${SCRIPT}/settings`,token), api(`${SCRIPT}/deployments`,token),
    api(`${ROOT}/zones/${ZONE}/workers/routes`,token),api(`${SCRIPT}/schedules`,token),
    api(`${SCRIPT}/subdomain`,token),
  ]);
  const safeSettings={bindings:normalizedBindings(settings.bindings),
    compatibility_date:settings.compatibility_date,
    compatibility_flags:settings.compatibility_flags ?? []};
  return {settings:safeSettings,active:activeVersion(deployments),routes:assertRoutes(routes,ctx.config),
    schedules,subdomain};
}

export function sameBoundary(before,after,{candidateSettings=false}={}) {
  same(after.routes,before.routes,'route boundary changed');
  same(after.schedules,before.schedules,'cron boundary changed');
  same(after.subdomain,before.subdomain,'Worker subdomain boundary changed');
  if (!candidateSettings) same(normalizedBindings(after.settings.bindings),
    normalizedBindings(before.settings.bindings),'binding boundary changed');
}

async function runWrangler(ctx,args) {
  try {
    const {stdout}=await exec(process.execPath,[ctx.wrangler,...args,'--config','wrangler.data.jsonc',
      '--env','production-serve'],{cwd:ctx.cwd,timeout:180_000,maxBuffer:8*1024*1024,encoding:'utf8',
      env:{PATH:process.env.PATH,HOME:process.env.HOME,CI:'true',NO_COLOR:'1',
        CLOUDFLARE_ACCOUNT_ID:ACCOUNT,CLOUDFLARE_API_TOKEN:ctx.env.DATA_EDGE_TOKEN}});
    return stdout;
  } catch { throw Error(`Wrangler ${args[0]} failed`); }
}

function save(path,receipt) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  writeFileSync(path,`${JSON.stringify(receipt,null,2)}\n`,{mode:0o600});
}

async function verifyLive(ctx,receipt) {
  for(let attempt=0;attempt<12;attempt++) {
    try {
      const current=await remoteBoundary(ctx);
      assert.equal(current.active,receipt.candidate,'candidate not active');
      sameBoundary(receipt.before,current,{candidateSettings:true});
      assertSettings(ctx.config,current.settings);
      const {selector,health,base}=await publicBoundary();
      same(selector,receipt.public.selector,'selector changed during release');
      same(health,receipt.public.health,'data health changed during release');
      same(base,receipt.public.base,'base point response changed during release');
      const point=await publicJson(`${POINT}?${wind100Query(selector)}`);
      assertPoint(point,selector,base);
      return {sampleCount:point.series.wind_speed_100m.samples.length,
        pointSha256:hash(point),baseSha256:hash(base)};
    } catch(error) {
      if(attempt===11) throw Error('live Wind100 point reader failed bounded verification',{cause:error});
      await wait(5000);
    }
  }
}

async function recover(ctx,receipt) {
  if(!receipt?.previous||!receipt?.candidate)return 'nothing-to-restore';
  const current=await remoteBoundary(ctx);
  if(recoveryAction(current.active,receipt)==='already-restored')return 'prior-version-already-active';
  sameBoundary(receipt.before,current,{candidateSettings:true});
  await runWrangler(ctx,['rollback',receipt.previous,'--yes',
    '--message','Restore prior data Worker after Wind100 point reader failure']);
  const restored=await remoteBoundary(ctx);
  assert.equal(restored.active,receipt.previous,'rollback not observed');
  sameBoundary(receipt.before,restored,{candidateSettings:true});
  const live=await publicBoundary();
  same(live.base,receipt.public.base,'base point changed after rollback');
  return 'prior-version-restored';
}

export function recoveryAction(active,receipt) {
  if(active===receipt.previous)return 'already-restored';
  assert.equal(active,receipt.candidate,'foreign Worker deployment; refuse rollback');
  return 'restore-owned-candidate';
}

export async function main(command,env=process.env) {
  const ctx=context(env);
  if(command==='recover') {
    if(!existsSync(env.RECEIPT))return {status:'no-receipt'};
    const receipt=JSON.parse(readFileSync(env.RECEIPT));
    const recovery=await recover(ctx,receipt);
    save(env.RECEIPT,{...receipt,recovery});
    return {status:recovery};
  }
  assert.equal(command,'release');
  const before=await remoteBoundary(ctx);
  const previousVersion=await api(`${SCRIPT}/versions/${before.active}`,env.DATA_EDGE_TOKEN);
  assert.equal(previousVersion.id,before.active);
  assertPrevious(ctx.config,{...previousVersion.resources.script_runtime,
    bindings:previousVersion.resources.bindings},before.settings);
  const publicBefore=await publicBoundary();
  const receipt={schemaVersion:1,kind:'production-wind100-point-reader-release',sourceSha:SOURCE,
    controllerSha:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID,attempt:env.GITHUB_RUN_ATTEMPT,
    previous:before.active,before,public:publicBefore,status:'preflight-passed'};
  save(env.RECEIPT,receipt);
  try {
    const uploaded=await runWrangler(ctx,['versions','upload','--keep-vars',
      '--tag',`wind100-point-${SOURCE.slice(0,12)}`,
      '--message','Enable production Wind100 point reader']);
    receipt.candidate=uploadedVersion(uploaded);save(env.RECEIPT,receipt);
    const version=await api(`${SCRIPT}/versions/${receipt.candidate}`,env.DATA_EDGE_TOKEN);
    assertSettings(ctx.config,{...version.resources.script_runtime,bindings:version.resources.bindings});
    const afterUpload=await remoteBoundary(ctx);
    assert.equal(afterUpload.active,receipt.previous,'inactive upload changed active version');
    sameBoundary(before,afterUpload,{candidateSettings:true});
    assertSettings(ctx.config,afterUpload.settings);
    await runWrangler(ctx,['versions','deploy',`${receipt.candidate}@100%`,'--yes',
      '--message','Verified production Wind100 point reader']);
    receipt.status='activation-requested';save(env.RECEIPT,receipt);
    receipt.proof=await verifyLive(ctx,receipt);
    receipt.status='passed';receipt.completedAt=new Date().toISOString();save(env.RECEIPT,receipt);
    return {status:'passed',sourceSha:SOURCE,candidate:receipt.candidate,proof:receipt.proof};
  } catch(error) {
    receipt.status='failed';receipt.failure=error.message;save(env.RECEIPT,receipt);
    try{receipt.recovery=await recover(ctx,receipt);}catch{receipt.recovery='manual-inspection-required';}
    save(env.RECEIPT,receipt);
    throw error;
  }
}

if(process.argv[1] && resolve(process.argv[1])===resolve(import.meta.filename)) {
  main(process.argv[2]).then(result=>console.log(JSON.stringify(result))).catch(error=>{
    console.error(`Data Wind100 point release refused: ${error.message}${error.cause?.message?` (${error.cause.message})`:''}`);
    process.exitCode=1;
  });
}
