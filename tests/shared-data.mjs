import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { ACCOUNT, MODELS, hash, gate, safePath, selection, validateRelease, validateCatalog, validateComponent,
  localInventory, compareInventory, transferEnvironment, createTransport, prepare } from '../tools/shared-data.mjs';

const now = Date.parse('2026-08-31T15:00:00Z'), time = new Date(now).toISOString();
const encoded = x => Buffer.from(JSON.stringify(x) + '\n');
const copy = x => structuredClone(x);
const scratch = () => resolve(mkdtempSync(resolve(tmpdir(), 'wx-shared-data-test-')), 'snapshot');
export function fixture() {
  const store = new Map(), writes = [], reads = [];
  const releaseId = 'cycle-123', catalogId = '7-test';
  const objects = ['data/ledger/index.json','data/verify/index.json','data/ledger/accuracy/current.json',
    'data/ledger/accuracy/current.txt','data-atmos/index.json','point-series/index.json'].map(path => {
    const body = Buffer.from(path); store.set(`data/releases/${releaseId}/${path}`, body);
    return {path, bytes:body.length, sha256:hash(body)};
  });
  const pointSeries = { schemaVersion:2, objectCount:1,
    manifestSha256:hash(JSON.stringify(objects.filter(o=>o.path.startsWith('point-series/')))),
    models:Object.fromEntries(['ecmwf','gfs'].map(id => [id,{
      runId:'2026083112', initializedAt:time, generatedAt:time, freshUntil:new Date(now + 3600_000).toISOString(),
      source:'synthetic-schema-fixture', license:{id:'test',redistributionAllowed:true,reviewedAt:time},
      resolutionDegrees:1, nativeCadenceSeconds:3600,
      grid:{lon0:0,lat0:1,lonStep:1,latStep:-1,width:2,height:2}, chunk:{width:2,height:2},
      variables:{temperature:{kind:'instantaneous',units:'degC'}}
    }])) };
  const manifest = {schemaVersion:1, releaseId, createdAt:time, objectCount:objects.length, objects, pointSeries};
  const release = {schemaVersion:1, releaseId, publishedAt:time, objectCount:objects.length, manifestSha256:hash(JSON.stringify(manifest)), pointSeries};
  store.set('data/releases/current.json', encoded(release)); store.set(`data/releases/${releaseId}/manifest.json`, encoded(manifest));
  const components = {};
  for (const id of MODELS) {
    const artifactId = id + '-123', rootPrefix = `components/${id}/${artifactId}/`;
    const body = Buffer.from('qualified ' + id), values = [{path:'index.json', size:body.length, sha256:hash(body)}];
    const m = {schemaVersion:1, componentId:id, artifactId, generationTime:time, completedAt:time, rootPrefix,
      mounts:[`data/${id}/`], objectCount:1, inventorySha256:hash(JSON.stringify(values)),
      quality:{status:'passed',checks:['manifest','inventory','remote_bytes','coverage','freshness','live_superset','horizon','cadence','grid','referenced_bytes']}};
    const raw = encoded(m); components[id] = {...m, manifestKey:rootPrefix+'component.json', manifestSha256:hash(raw)};
    store.set('components/'+rootPrefix+'index.json',body); store.set('components/'+rootPrefix+'component.json',raw);
  }
  const catalog = {schemaVersion:2, sequence:7, parentCatalogId:'6-test', createdAt:time, rollbackEpoch:0, components};
  const catalogRaw = encoded(catalog), catalogPointer = {schemaVersion:2,catalogId,sequence:7,publishedAt:time,previousCatalogId:'6-test',catalogSha256:hash(catalogRaw)};
  store.set('data/catalogs/current.json',encoded(catalogPointer)); store.set(`data/catalogs/snapshots/${catalogId}.json`,catalogRaw);
  const pin = {releaseId,releaseManifestSha256:release.manifestSha256,catalogId,catalogSha256:catalogPointer.catalogSha256};
  const io = {
    get: (kind,key) => { reads.push([kind,key]); const b = store.get(kind+'/'+key); assert.ok(b, 'missing fixture object'); return b; },
    list: (kind,prefix) => [...store.entries()].filter(([p]) => p.startsWith(kind+'/'+prefix+'/')).map(([p,b]) =>
      ({Path:p.slice(kind.length+prefix.length+2),Size:b.length,IsDir:false})),
    download: (kind,prefix,dir) => { for (const item of io.list(kind,prefix)) { const path=resolve(dir,item.Path); mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,store.get(kind+'/'+prefix+'/'+item.Path)); } },
    upload: (kind,prefix,dir) => { writes.push(['upload',kind,prefix,dir]); },
    put: (kind,key,file) => { writes.push(['put',kind,key,readFileSync(file)]); },
  };
  return {store,writes,reads,io,pin,release,manifest,catalog,catalogPointer,catalogRaw};
}
function envFor(pin) { return {GITHUB_ACTIONS:'true',RUNNER_ENVIRONMENT:'github-hosted',GITHUB_REPOSITORY:'Andrewegao/v3t7kq-cycle',
  GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/main',STAGING_DATA_ENABLED:'true',STAGING_DATA_ISOLATION_APPROVED:'true',
  STAGING_R2_ACCOUNT_ID:ACCOUNT,RELEASE_ID:pin.releaseId,RELEASE_MANIFEST_SHA256:pin.releaseManifestSha256,CATALOG_ID:pin.catalogId,
  CATALOG_SHA256:pin.catalogSha256,STAGING_DATA_APPROVED_SELECTION_SHA256:hash(JSON.stringify(pin))}; }
test('exact reviewed snapshot and hosted manual main are mandatory', () => {
  const {pin}=fixture(), env=envFor(pin); assert.deepEqual(gate(env),pin); assert.deepEqual(selection(env),pin);
  for (const key of Object.keys(env)) assert.throws(() => gate({...env,[key]:''}),key);
  for (const patch of [{GITHUB_EVENT_NAME:'schedule'},{GITHUB_REF:'refs/heads/test'},{RUNNER_ENVIRONMENT:'self-hosted'},
    {CATALOG_ID:'new-current'},{STAGING_R2_ACCOUNT_ID:'b'.repeat(32)}]) assert.throws(() => gate({...env,...patch}));
});
test('manifest and catalog validators preserve both independent identities', () => {
  const f=fixture(); validateRelease(f.release,f.manifest,f.pin,now); validateCatalog(f.catalogPointer,f.catalogRaw,f.pin,now);
  for (const c of Object.values(f.catalog.components)) validateComponent(c,f.store.get('components/'+c.manifestKey));
  assert.throws(() => validateRelease(f.release,{...f.manifest,objectCount:1},f.pin,now));
  assert.throws(() => validateCatalog(f.catalogPointer,Buffer.concat([f.catalogRaw,Buffer.from(' ')]),f.pin,now));
});
test('stale, missing accuracy, duplicate and malformed inventory are refused even under a matching hash', () => {
  const f=fixture();
  for (const mutate of [m=>m.objects.pop(),m=>m.objects[0].path='../escape',m=>m.objects.push(m.objects[0]),
    m=>m.objects[2].bytes=0,m=>m.pointSeries.models.ecmwf.freshUntil=time,m=>m.pointSeries.schemaVersion=1]) {
    const m=copy(f.manifest); mutate(m); const digest=hash(JSON.stringify(m));
    assert.throws(() => validateRelease({...f.release,manifestSha256:digest,pointSeries:m.pointSeries},m,{...f.pin,releaseManifestSha256:digest},now));
  }
  assert.throws(() => validateRelease(f.release,f.manifest,f.pin,now+3*86400_000));
});
test('unsupported catalog, component mounts and original gate receipts fail closed', () => {
  const f=fixture();
  for (const mutate of [c=>delete c.components.hrrr,c=>c.components.nam=c.components.gfs,
    c=>c.components.gfs.mounts=['data/ecmwf/'],c=>c.components.gfs.rootPrefix='vault/private/',
    c=>c.components.gfs.quality.checks=['manifest'],c=>c.components.gfs.generationTime='invalid']) {
    const c=copy(f.catalog); mutate(c); const raw=encoded(c), sha=hash(raw);
    assert.throws(() => validateCatalog({...f.catalogPointer,catalogSha256:sha},raw,{...f.pin,catalogSha256:sha},now));
  }
});
test('preparation runs no producer and never activates either environment', async () => {
  const f=fixture(); let validations=0;
  const result=await prepare(f.pin,f.io,scratch(),m=>{assert.deepEqual(m,f.manifest);validations++;},now);
  assert.equal(validations,1); assert.equal(result.objects,10); assert.equal(result.collected,false);
  assert.equal(result.processed,false); assert.equal(result.activated,false); assert.equal(result.productionWritten,false);
  assert.equal(f.writes.length,12); assert.ok(f.writes.every(x=>!x[2].endsWith('/current.json')));
  assert.ok(!f.writes.some(x=>x[2].startsWith('catalogs/snapshots/')));
  assert.equal(f.writes.at(-1)[2],`staging-candidates/${hash(JSON.stringify(f.pin))}/receipt.json`);
});
test('missing/corrupt source and incomplete component never upload or select anything', async () => {
  for (const mutate of [f=>f.store.delete('data/releases/cycle-123/data/ledger/index.json'),
    f=>f.store.set('data/releases/cycle-123/data/ledger/index.json',Buffer.from('corrupt')),
    f=>f.store.set('components/components/hrrr/hrrr-123/index.json',Buffer.from('different')),
    f=>f.store.set('components/components/gfs/gfs-123/unexpected.bin',Buffer.from('extra'))]) {
    const f=fixture(); mutate(f); await assert.rejects(prepare(f.pin,f.io,scratch(),()=>{},now)); assert.equal(f.writes.length,0);
  }
});
test('point descriptor validator failure refuses before object downloads/writes', async () => {
  const f=fixture(); let downloads=0; f.io.download=()=>{downloads++;};
  await assert.rejects(prepare(f.pin,f.io,scratch(),()=>{throw Error('v2 inventory invalid');},now));
  assert.equal(downloads,0); assert.equal(f.writes.length,0);
});
test('transfer failure never writes completed receipt; retries do not overwrite partial local trees', async () => {
  const f=fixture(), root=scratch(); f.io.upload=()=>{throw Error('transfer failed');};
  await assert.rejects(prepare(f.pin,f.io,root,()=>{},now)); assert.equal(f.writes.length,0);
  await assert.rejects(prepare(f.pin,f.io,root,()=>{},now),/EEXIST/);
});
test('local inventory detects symlink, equal-size corruption and exact sorted inventory changes', async () => {
  const root=scratch(); mkdirSync(root); writeFileSync(resolve(root,'a'),'aa');
  const expected=await localInventory(root); writeFileSync(resolve(root,'a'),'bb');
  assert.throws(()=>compareInventory([{...expected[0],sha256:hash('bb')}],expected));
  symlinkSync(resolve(root,'a'),resolve(root,'link')); await assert.rejects(localInventory(root),/non-regular/);
  for (const p of ['/abs','a/../b','a/./b','a//b','a\\b','a\0b','a?b']) assert.throws(()=>safePath(p));
});
test('scoped S3 client strips inherited broad credentials, remotes, config and production write authority', () => {
  const env={PATH:process.env.PATH,HOME:process.env.HOME,SHARED_R2_READ_ACCESS_KEY_ID:'read-id',SHARED_R2_READ_SECRET_ACCESS_KEY:'read-secret',
    STAGING_R2_WRITE_ACCESS_KEY_ID:'write-id',STAGING_R2_WRITE_SECRET_ACCESS_KEY:'write-secret',
    CLOUDFLARE_API_TOKEN:'broad',RCLONE_CONFIG_OTHER_SECRET_ACCESS_KEY:'broad',RCLONE_CONFIG:'/unsafe'};
  assert.equal(transferEnvironment(env,'read').RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID,'read-id');
  assert.equal(transferEnvironment(env,'read').CLOUDFLARE_API_TOKEN,undefined);
  const calls=[], io=createTransport(env,(exe,args,options)=>{calls.push({exe,args,options});return Buffer.from('[]');});
  io.get('data','releases/current.json'); io.list('components','components/gfs/id');
  io.upload('components','components/gfs/id','/scratch/model');
  assert.ok(calls.slice(0,2).every(c=>c.options.env.RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID==='read-id'));
  assert.ok(calls.slice(2).every(c=>c.options.env.RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID==='write-id'));
  assert.ok(calls.slice(2).every(c=>!c.args.some(a=>a.includes('-production/'))));
  assert.ok(calls.at(-1).args.includes('--download'));
  assert.ok(calls[1].args.includes('--no-modtime'));
  assert.ok(calls[1].args.includes('--no-mimetype'));
  assert.throws(()=>io.put('data','releases/current.json','/nope'),/never written/);
  assert.throws(()=>io.put('data','vault/private','/nope'));
  assert.ok(calls.every(c=>!c.args.some(a=>['sync','delete','purge','move'].includes(a))));
});
test('long preparation cannot upload or certify an expired point selection', async () => {
  for (const expiresBeforeUpload of [true, false]) {
    const f=fixture(), events=[];
    const times=expiresBeforeUpload ? [now, now+31*60_000] : [now, now, now+31*60_000];
    await assert.rejects(prepare(f.pin,f.io,scratch(),()=>{},()=>times.shift(),e=>events.push(e)),/freshness margin/);
    assert.ok(!f.writes.some(x=>x[2].endsWith('/receipt.json')));
    if (expiresBeforeUpload) assert.equal(f.writes.length,0);
    else assert.equal(f.writes.filter(x=>x[0]==='upload').length,7);
    assert.equal(events.at(-1).event,'phase-failed');
    assert.equal(events.at(-1).phase,expiresBeforeUpload?'pre-upload-freshness':'pre-receipt-freshness');
  }
});
test('every upload/readback failure prevents all later controls and the completed receipt', async () => {
  for (let failedUpload = 1; failedUpload <= 7; failedUpload++) {
    const f = fixture(); let attempts = 0;
    f.io.upload = () => { if (++attempts === failedUpload) throw Error('readback mismatch'); };
    await assert.rejects(prepare(f.pin, f.io, scratch(), () => {}, now), /readback mismatch/);
    assert.equal(attempts, failedUpload, 'later prefixes must not continue after failed verification');
    assert.equal(f.writes.length, 0, 'no control document or receipt may be written');
  }
});
test('bulk transfer uses bounded parallel workers and recursive listings without weakening byte checks', () => {
  const calls = [], env = { PATH: process.env.PATH, HOME: process.env.HOME,
    SHARED_R2_READ_ACCESS_KEY_ID: 'read', SHARED_R2_READ_SECRET_ACCESS_KEY: 'fixture',
    STAGING_R2_WRITE_ACCESS_KEY_ID: 'write', STAGING_R2_WRITE_SECRET_ACCESS_KEY: 'fixture',
    RCLONE_TRANSFERS: '9999', RCLONE_CHECKERS: '9999', RCLONE_S3_NO_HEAD: 'true' };
  const io = createTransport(env, (exe, args, options) => { calls.push({ args, options }); return Buffer.alloc(0); });
  io.download('data', 'releases/test/data', '/scratch/source');
  io.upload('data', 'releases/test/data', '/scratch/source');
  assert.deepEqual(calls.map(c => c.args[0]), ['copy', 'copy', 'check']);
  for (const { args, options } of calls) {
    assert.ok(args.includes('--fast-list'), 'bulk operations must avoid per-directory traversal');
    assert.equal(args[args.indexOf('--checkers') + 1], '16');
    assert.equal(options.timeout, 45 * 60_000, 'do not mask stalls with a longer timeout');
    for (const key of ['RCLONE_TRANSFERS', 'RCLONE_CHECKERS', 'RCLONE_S3_NO_HEAD']) assert.equal(options.env[key], undefined);
    for (const flag of ['--size-only', '--ignore-checksum', '--s3-no-head', '--no-check-dest', '--ignore-existing'])
      assert.ok(!args.includes(flag), `verification shortcut forbidden: ${flag}`);
  }
  for (const { args } of calls.slice(0, 2)) assert.equal(args[args.indexOf('--transfers') + 1], '16');
  assert.ok(calls[0].args.includes('--max-transfer'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--max-transfer') + 1], '40Gi');
  assert.ok(calls[1].args.includes('--immutable'));
  assert.ok(calls[2].args.includes('--download'), 'readback still consumes and compares the complete bytes');
});
test('stage events identify exact work and preserve the deterministic receipt', async () => {
  const f=fixture(), events=[];
  const receipt=await prepare(f.pin,f.io,scratch(),()=>{},()=>now,e=>events.push(e));
  assert.equal(receipt.activated,false);
  assert.deepEqual(events.filter(x=>x.event==='inventory').map(x=>x.phase),
    ['whole-data','whole-data-atmos','whole-point-series','aifs','ecmwf','gfs','hrrr']);
  assert.equal(events.at(-1).phase,'completed-receipt');
  assert.equal(events.at(-1).event,'phase-complete');
  for (const x of events.filter(x=>x.elapsedMs!==undefined)) assert.ok(Number.isInteger(x.elapsedMs)&&x.elapsedMs>=0);
  assert.ok(events.every(x=>!JSON.stringify(x).includes('snapshot')),'no local paths logged');
  const decoded=JSON.parse(f.writes.at(-1)[3]); assert.deepEqual(decoded,receipt);
});
test('subprocess diagnostics allowlist exit/signal/timeout without leaking remote errors', () => {
  const events=[], env={PATH:process.env.PATH,HOME:process.env.HOME,
    SHARED_R2_READ_ACCESS_KEY_ID:'secret-id',SHARED_R2_READ_SECRET_ACCESS_KEY:'secret-value'};
  const io=createTransport(env,()=>{throw Object.assign(Error('secret-value signed-request'),
    {status:9,signal:'SIGTERM',code:'ETIMEDOUT',stderr:'secret-id cookie',stdout:'private'});},e=>events.push(e));
  assert.throws(()=>io.list('data','releases/synthetic/data'),/^Error: S3 read lsjson failed; snapshot not activated$/);
  assert.deepEqual(events[0],{event:'transfer-start',role:'read',operation:'lsjson'});
  const {elapsedMs,...failed}=events[1];
  assert.ok(elapsedMs>=0);
  assert.deepEqual(failed,{event:'transfer-failed',role:'read',operation:'lsjson',exitCode:9,signal:'SIGTERM',timedOut:true});
  assert.doesNotMatch(JSON.stringify(events),/secret|signed-request|cookie|private/);
});
