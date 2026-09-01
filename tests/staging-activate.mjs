import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ACCOUNT, MODELS, hash } from '../tools/shared-data.mjs';
import { activationGate, activatePrepared, recoverActivation, inspectPrepared, assertLiveProof, buildServingCatalog, checked,
  STAGING_DATA_BUCKET as DATA, STAGING_COMPONENT_BUCKET as COMPONENTS, STAGING_ORIGIN as ORIGIN } from '../tools/staging-activate.mjs';

const now = Date.parse('2026-08-31T15:00:00Z'), iso = delta => new Date(now + delta).toISOString();
const encode = value => Buffer.from(JSON.stringify(value) + '\n');
const clone = value => structuredClone(value);
const pointerKeys = ['releases/current.json', 'catalogs/current.json'];

test('diagnostics retain only bounded stage, state and error category', async () => {
  const events = [];
  assert.equal(await checked('candidate:receipt-read', async () => 7, event => events.push(event)), 7);
  await assert.rejects(checked('candidate:whole-inventory', async () => assert.fail('sensitive detail'), event => events.push(event)));
  assert.deepEqual(events, [
    { stage: 'candidate:receipt-read', state: 'started' },
    { stage: 'candidate:receipt-read', state: 'passed' },
    { stage: 'candidate:whole-inventory', state: 'started' },
    { stage: 'candidate:whole-inventory', state: 'failed', kind: 'assertion' },
  ]);
  await assert.rejects(checked('not allowed', async () => {}), /invalid diagnostic stage/);
});

// All numeric values and inventories below are synthetic protocol fixtures, not
// real weather qualification. Real source-pack decoding is the adapter's mandatory
// verifyLive dependency and is intentionally not faked into a production receipt.
function fixture() {
  const store = new Map(), writes = [], reads = [], hooks = {};
  let active = 0, maxActive = 0;
  const keyFor = (bucket, key) => `${bucket}/${key}`;
  function save(bucket, key, body, customMetadata = {}, httpMetadata = {}) {
    // Content-derived ETags model the important R2 property: metadata-only changes
    // do not produce a new body CAS token. Activation body markers must carry identity.
    store.set(keyFor(bucket, key), { body: Buffer.from(body), etag: `"${hash(body)}"`, customMetadata, httpMetadata });
  }
  const releaseId = 'cycle-123', catalogId = '34-source', runId = '2026083112';
  const objects = ['data/ledger/index.json', 'data/verify/index.json', 'data/ledger/accuracy/current.json',
    'data/ledger/accuracy/current.txt', 'data-atmos/index.json', ...['ecmwf', 'gfs'].map(m => `point-series/v2/${m}/${runId}/chunks/0/0.bin.gz`)].map(path => {
    const body = Buffer.from(path); save(DATA, `releases/${releaseId}/${path}`, body);
    return { path, bytes: body.length, sha256: hash(body) };
  });
  const pointSeries = { schemaVersion: 2, models: Object.fromEntries(['ecmwf', 'gfs'].map(model => [model,
    { runId, initializedAt: iso(0), generatedAt: iso(0), freshUntil: iso(2 * 3600_000) }])) };
  const manifest = { schemaVersion: 1, releaseId, createdAt: iso(0), objectCount: objects.length, objects, pointSeries };
  const release = { schemaVersion: 1, releaseId, publishedAt: iso(0), objectCount: objects.length, manifestSha256: hash(JSON.stringify(manifest)), pointSeries };
  save(DATA, `releases/${releaseId}/manifest.json`, encode(manifest));
  const components = {};
  for (const id of MODELS) {
    const artifactId = `${id}-123`, rootPrefix = `components/${id}/${artifactId}/`, body = Buffer.from(`qualified-${id}`);
    const inventory = [{ path: 'index.json', size: body.length, sha256: hash(body) }];
    const m = { schemaVersion: 1, componentId: id, artifactId, generationTime: iso(0), completedAt: iso(0), rootPrefix,
      mounts: [`data/${id}/`], objectCount: 1, inventorySha256: hash(JSON.stringify(inventory)),
      quality: { status: 'passed', checks: ['manifest', 'inventory', 'remote_bytes', 'coverage', 'freshness', 'live_superset', 'horizon', 'cadence', 'grid', 'referenced_bytes'] } };
    const raw = encode(m); components[id] = { ...m, manifestKey: `${rootPrefix}component.json`, manifestSha256: hash(raw) };
    save(COMPONENTS, `${rootPrefix}component.json`, raw); save(COMPONENTS, `${rootPrefix}index.json`, body);
  }
  const catalog = { schemaVersion: 2, sequence: 34, parentCatalogId: '33-source', createdAt: iso(0), rollbackEpoch: 0, components };
  const catalogRaw = encode(catalog);
  const catalogPointer = { schemaVersion: 2, catalogId, sequence: 34, publishedAt: iso(0), previousCatalogId: '33-source', catalogSha256: hash(catalogRaw) };
  const selection = { releaseId, releaseManifestSha256: release.manifestSha256, catalogId, catalogSha256: catalogPointer.catalogSha256 };
  const candidateId = hash(JSON.stringify(selection)), prefix = `staging-candidates/${candidateId}/`;
  save(DATA, `${prefix}release-pointer.json`, encode(release)); save(DATA, `${prefix}catalog-pointer.json`, encode(catalogPointer));
  save(DATA, `${prefix}catalog.json`, catalogRaw);
  const receipt = { schemaVersion: 1, candidateId, selection,
    objects: objects.length + 4, bytes: objects.reduce((n, o) => n + o.bytes, 0) + MODELS.reduce((n, m) => n + Buffer.byteLength(`qualified-${m}`), 0),
    collected: false, processed: false, activated: false, productionWritten: false,
    producerSource: 'preserved upstream receipts; no new collector-source attestation',
    components: Object.values(components).map(c => ({ model: c.componentId, artifactId: c.artifactId, manifestSha256: c.manifestSha256 })) };
  save(DATA, `${prefix}receipt.json`, encode(receipt));
  const ctx = { selection, candidateId, activationId: '100-1', sourceSha: 'a'.repeat(40), receiptSha256: hash(encode(receipt)) };
  const oldManifest = clone(manifest); oldManifest.releaseId = 'cycle-old'; oldManifest.createdAt = iso(-3600_000);
  for (const p of Object.values(oldManifest.pointSeries.models)) { p.runId = '2026083106'; p.initializedAt = iso(-6 * 3600_000); p.freshUntil = iso(3600_000); }
  const oldRelease = { ...release, releaseId: 'cycle-old', publishedAt: iso(-3600_000), manifestSha256: hash(JSON.stringify(oldManifest)), pointSeries: oldManifest.pointSeries };
  const oldCatalog = clone(catalog); oldCatalog.sequence = 36; oldCatalog.createdAt = iso(-3600_000); oldCatalog.parentCatalogId = '35-old'; oldCatalog.rollbackEpoch = 2;
  for (const c of Object.values(oldCatalog.components)) { c.artifactId += '-old'; c.generationTime = iso(-3600_000); }
  const oldPointer = { ...catalogPointer, catalogId: '36-old', sequence: 36, publishedAt: oldCatalog.createdAt, previousCatalogId: '35-old', catalogSha256: hash(encode(oldCatalog)) };
  save(DATA, 'releases/current.json', encode(oldRelease), { keep: 'release' }, { contentType: 'application/json', cacheControl: 'no-store' });
  save(DATA, 'catalogs/current.json', encode(oldPointer), { keep: 'catalog' }, { contentType: 'application/json', cacheControl: 'no-store' });
  save(DATA, 'releases/cycle-old/manifest.json', encode(oldManifest));
  save(DATA, 'catalogs/snapshots/36-old.json', encode(oldCatalog), { sha256: oldPointer.catalogSha256 });
  const old = pointerKeys.map(key => clone(store.get(keyFor(DATA, key))));
  const io = {
    validateRestore: previous => {
      assert.ok(previous.customMetadata && previous.httpMetadata);
      assert.ok(Object.values(previous.customMetadata).every(value => typeof value === 'string'));
    },
    get: async (bucket, key, options) => {
      assert.ok([DATA, COMPONENTS].includes(bucket)); reads.push([bucket, key]); await hooks.beforeGet?.(bucket, key);
      const value = store.get(keyFor(bucket, key)); if (!value) return null;
      assert.ok(value.body.length <= options.maxBytes); return { ...clone(value), body: Buffer.from(value.body) };
    },
    list: async (bucket, prefix) => [...store].filter(([key]) => key.startsWith(`${bucket}/${prefix}`))
      .map(([key, value]) => ({ key: key.slice(bucket.length + 1), bytes: value.body.length })),
    hashObject: async (bucket, key, options) => {
      active++; maxActive = Math.max(maxActive, active); await setImmediate();
      try { await hooks.beforeHash?.(bucket, key); const value = store.get(keyFor(bucket, key)); assert.ok(value); assert.ok(value.body.length <= options.maxBytes);
        return { bytes: value.body.length, sha256: hash(value.body) }; } finally { active--; }
    },
    put: async (bucket, key, body, options) => {
      assert.equal(bucket, DATA); await hooks.beforePut?.(key, body, options);
      const current = store.get(keyFor(bucket, key));
      assert.ok(options.ifMatch || options.ifNoneMatch === '*');
      if (options.ifMatch ? current?.etag !== options.ifMatch : current) throw Error('CAS precondition failed');
      save(bucket, key, body, options.customMetadata, options.httpMetadata); writes.push({ bucket, key, body: Buffer.from(body), options });
      await hooks.afterPut?.(key, body, options); return { etag: store.get(keyFor(bucket, key)).etag };
    },
  };
  const healthy = { origin: ORIGIN, authMode: 'public', billingMode: 'disabled', dataMode: 'serve', ok: true };
  const proof = { ...healthy, selection, servingCatalog: buildServingCatalog(ctx, oldPointer, oldCatalog, catalog, now).pointer, sourceVerified: true,
    points: ['ecmwf', 'gfs'].flatMap(model => Array.from({ length: 7 }, (_, i) => {
      const packPath = `point-series/v2/${model}/${runId}/chunks/0/0.bin.gz`;
      return { model, runId, releaseId, coordinates: [i * 10, i * 5], status: 200, complete: true,
        packPath, packSha256: objects.find(o => o.path === packPath).sha256, responseSha256: hash(`synthetic-response-${i}-${model}`),
        numericMatch: true, values: { temperature: [1, 2], wind_speed: [3, 4], wind_direction: [5, 6], precipitation: [0, 1] } };
    })) };
  let validations = 0;
  const deps = { now: () => now, validatePoints: async m => { assert.deepEqual(m, manifest); validations++; },
    validateServingPointers: async ({ release: r, catalogPointer: c, catalog: stagedCatalog }) => {
      const derived = buildServingCatalog(ctx, oldPointer, oldCatalog, catalog, now);
      assert.deepEqual(r, { ...release, stagingActivation: { id: ctx.activationId, sourceSha: ctx.sourceSha } });
      assert.deepEqual(c, { ...derived.pointer, stagingActivation: { id: ctx.activationId, sourceSha: ctx.sourceSha } });
      assert.deepEqual(stagedCatalog, derived.catalog);
    },
    verifyConsumer: async () => healthy, verifyLive: async ({ servingCatalog }) => ({ ...proof, servingCatalog }) };
  return { ctx, io, deps, hooks, store, writes, reads, old, oldManifest, oldCatalog, manifest, release, catalog, catalogPointer, receipt, proof, healthy,
    save, keyFor, prefix, maxActive: () => maxActive, validations: () => validations };
}
const current = (f, key) => f.store.get(f.keyFor(DATA, key));
const currentJSON = (f, key) => JSON.parse(current(f, key).body);
const assertRestored = f => pointerKeys.forEach((key, i) => {
  assert.equal(hash(current(f, key).body), hash(f.old[i].body));
  assert.deepEqual(current(f, key).customMetadata, f.old[i].customMetadata);
  assert.deepEqual(current(f, key).httpMetadata, f.old[i].httpMetadata);
});
function envFor(ctx) { return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/staging-data-activate.yml@refs/heads/main',
  GITHUB_JOB: 'activate', STAGING_DATA_ENABLED: 'true', STAGING_DATA_ISOLATION_APPROVED: 'true', STAGING_DATA_ACTIVATION_ENABLED: 'true',
  STAGING_R2_ACCOUNT_ID: ACCOUNT, RELEASE_ID: ctx.selection.releaseId, RELEASE_MANIFEST_SHA256: ctx.selection.releaseManifestSha256,
  CATALOG_ID: ctx.selection.catalogId, CATALOG_SHA256: ctx.selection.catalogSha256, STAGING_DATA_APPROVED_SELECTION_SHA256: ctx.candidateId,
  STAGING_DATA_APPROVED_RECEIPT_SHA256: ctx.receiptSha256, GITHUB_SHA: ctx.sourceSha, GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1' }; }

test('only exact hosted manual main activation identity and approved receipt are accepted', () => {
  const { ctx } = fixture(), env = envFor(ctx); assert.deepEqual(activationGate(env), ctx);
  for (const key of Object.keys(env)) assert.throws(() => activationGate({ ...env, [key]: '' }), key);
  for (const change of [{ GITHUB_EVENT_NAME: 'schedule' }, { GITHUB_REF: 'refs/heads/topic' }, { GITHUB_JOB: 'build' },
    { RUNNER_ENVIRONMENT: 'self-hosted' }, { GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('staging', 'production') }])
    assert.throws(() => activationGate({ ...env, ...change }));
});
test('full source readback then fourteen numeric proofs activate staging only with bounded concurrency and durable intent', async () => {
  const f = fixture(); const result = await activatePrepared(f.ctx, f.io, f.deps);
  assert.equal(result.activated, true); assert.equal(result.productionWritten, false); assert.equal(f.validations(), 1);
  assert.ok(f.maxActive() > 1 && f.maxActive() <= 8);
  assert.equal(currentJSON(f, 'releases/current.json').releaseId, f.ctx.selection.releaseId);
  assert.equal(currentJSON(f, 'catalogs/current.json').catalogId, '37-staging-100-1');
  assert.deepEqual(currentJSON(f, 'releases/current.json').stagingActivation, { id: f.ctx.activationId, sourceSha: f.ctx.sourceSha });
  assert.equal(currentJSON(f, `${f.prefix}release-pointer.json`).stagingActivation, undefined);
  assert.equal(currentJSON(f, `${f.prefix}catalog-pointer.json`).stagingActivation, undefined);
  const servingCatalog = currentJSON(f, 'catalogs/snapshots/37-staging-100-1.json');
  assert.equal(servingCatalog.sequence, 37); assert.equal(servingCatalog.parentCatalogId, '36-old'); assert.equal(servingCatalog.rollbackEpoch, 2);
  assert.deepEqual(servingCatalog.components, f.catalog.components);
  assert.equal(current(f, 'catalogs/snapshots/37-staging-100-1.json').customMetadata.sha256, result.servingCatalog.catalogSha256);
  assert.equal(currentJSON(f, `${f.prefix}catalog.json`).sequence, 34);
  assert.equal(hash(current(f, `${f.prefix}catalog.json`).body), f.ctx.selection.catalogSha256);
  const intentIndex = f.writes.findIndex(x => x.key.endsWith('/intent.json'));
  assert.ok(intentIndex >= 0 && f.writes.findIndex(x => pointerKeys.includes(x.key)) > intentIndex);
  assert.equal(JSON.parse(f.writes.at(-1).body).state, 'complete');
  assert.ok(f.writes.every(w => w.bucket === DATA && !w.key.includes('vault') && (w.options.ifMatch || w.options.ifNoneMatch)));
  assert.ok(f.reads.every(([bucket]) => [DATA, COMPONENTS].includes(bucket)));
  await assert.rejects(recoverActivation(f.ctx, f.io), /completed activation/);
});
test('bad receipt approval, bytes, extras, missing files and real descriptor failure cause no writes', async () => {
  for (const change of [f => f.ctx.receiptSha256 = 'f'.repeat(64),
    f => current(f, `${f.prefix}receipt.json`).body = encode({ ...f.receipt, processed: true }),
    f => current(f, `releases/${f.ctx.selection.releaseId}/data/ledger/index.json`).body.fill(1),
    f => f.store.delete(f.keyFor(DATA, `releases/${f.ctx.selection.releaseId}/data/ledger/accuracy/current.txt`)),
    f => f.save(DATA, `releases/${f.ctx.selection.releaseId}/unexpected`, Buffer.from('extra')),
    f => f.save(COMPONENTS, 'components/gfs/gfs-123/index.json', Buffer.from('corrupt')),
    f => f.deps.validatePoints = async () => { throw Error('real descriptor invalid'); }]) {
    const f = fixture(); change(f); await assert.rejects(activatePrepared(f.ctx, f.io, f.deps)); assert.equal(f.writes.length, 0);
  }
});
test('even a newly approved receipt cannot misrepresent transfer counts or processing status', async () => {
  for (const patch of [{ objects: 1 }, { bytes: 0 }, { activated: true }, { productionWritten: true }, { components: [] }, { collected: true }]) {
    const f = fixture(), body = encode({ ...f.receipt, ...patch }); current(f, `${f.prefix}receipt.json`).body = body; f.ctx.receiptSha256 = hash(body);
    await assert.rejects(activatePrepared(f.ctx, f.io, f.deps)); assert.equal(f.writes.length, 0);
  }
});
test('health must be public, billing disabled, serving and exact staging before writes', async () => {
  for (const patch of [{ ok: false }, { authMode: 'enforce' }, { billingMode: 'enabled' }, { dataMode: 'shadow' }, { origin: 'https://weatherx.org' }]) {
    const f = fixture(); f.deps.verifyConsumer = async () => ({ ...f.healthy, ...patch });
    await assert.rejects(activatePrepared(f.ctx, f.io, f.deps)); assert.equal(f.writes.length, 0);
  }
});
test('actual consumer pointer validators are mandatory and rejection occurs before any writes', async () => {
  for (const validate of [undefined, async () => { throw Error('pinned reader rejects pointer'); }]) {
    const f = fixture(); f.deps.validateServingPointers = validate;
    await assert.rejects(activatePrepared(f.ctx, f.io, f.deps)); assert.equal(f.writes.length, 0);
  }
});
test('serving marker makes different activations content-distinct without mutating immutable source', async () => {
  const left = fixture(), right = fixture(); right.ctx.activationId = '101-1';
  await activatePrepared(left.ctx, left.io, left.deps); await activatePrepared(right.ctx, right.io, right.deps);
  for (const key of pointerKeys) assert.notEqual(hash(current(left, key).body), hash(current(right, key).body));
  for (const key of ['release-pointer.json', 'catalog-pointer.json', 'catalog.json'])
    assert.equal(hash(current(left, left.prefix + key).body), hash(current(right, right.prefix + key).body));
});
test('both previous serving pointers are mandatory, no delete or bootstrap is attempted', async () => {
  for (const key of pointerKeys) { const f = fixture(); f.store.delete(f.keyFor(DATA, key));
    await assert.rejects(activatePrepared(f.ctx, f.io, f.deps), /required object missing/); assert.equal(f.writes.length, 0); }
});
test('both previous metadata records must pass restore transport preflight before any write', async () => {
  for (const role of ['release', 'catalog']) {
    const f = fixture(), checked = [];
    f.io.validateRestore = previous => { checked.push(previous.customMetadata.keep); if (previous.customMetadata.keep === role) throw Error('unsupported old metadata'); };
    await assert.rejects(activatePrepared(f.ctx, f.io, f.deps), /unsupported old metadata/);
    assert.equal(f.writes.length, 0); assert.ok(checked.includes(role));
  }
  const f = fixture(); f.io.validateRestore = undefined;
  await assert.rejects(activatePrepared(f.ctx, f.io, f.deps), /restore metadata preflight/); assert.equal(f.writes.length, 0);
});
test('freshness is rechecked after inventory readback before any activation', async () => {
  const f = fixture(); let clock = now; f.deps.now = () => clock;
  f.hooks.beforeHash = () => { clock = now + 2 * 3600_000; };
  await assert.rejects(activatePrepared(f.ctx, f.io, f.deps), /freshness margin/); assert.equal(f.writes.length, 0);
});
test('whole and component non-regression reject newer previous authorities', async () => {
  for (const mutate of [f => {
    const old = currentJSON(f, 'releases/current.json'); old.publishedAt = iso(1_000); f.save(DATA, 'releases/current.json', encode(old));
  }, f => {
    const old = currentJSON(f, 'catalogs/current.json'), catalog = clone(f.oldCatalog); catalog.components.gfs.generationTime = iso(1_000);
    old.catalogSha256 = hash(encode(catalog)); f.save(DATA, 'catalogs/current.json', encode(old)); f.save(DATA, 'catalogs/snapshots/36-old.json', encode(catalog));
  }]) { const f = fixture(); mutate(f); await assert.rejects(activatePrepared(f.ctx, f.io, f.deps)); assert.equal(f.writes.length, 0); }
});
test('existing immutable snapshot requires exact bytes and hash metadata, never overwritten to repair it', async () => {
  for (const [body, metadata] of [[Buffer.from('wrong'), {}], [null, {}], [null, { sha256: 'f'.repeat(64) }]]) {
    const f = fixture(); const candidate = buildServingCatalog(f.ctx, currentJSON(f, 'catalogs/current.json'), f.oldCatalog, f.catalog, now);
    f.save(DATA, 'catalogs/snapshots/37-staging-100-1.json', body ?? candidate.body, metadata);
    await assert.rejects(activatePrepared(f.ctx, f.io, f.deps)); assert.equal(f.writes.length, 0);
  }
});
test('oversized durable intent and invalid staging lineage fail before the first write', async () => {
  for (const mutate of [f => {
    const previous = currentJSON(f, 'releases/current.json'); previous.unused = 'x'.repeat(2 * 1024 ** 2);
    f.save(DATA, 'releases/current.json', encode(previous));
  }, f => {
    const previous = currentJSON(f, 'catalogs/current.json'); previous.publishedAt = iso(-2000);
    f.save(DATA, 'catalogs/current.json', encode(previous));
  }, f => {
    const old = currentJSON(f, 'catalogs/current.json'), catalog = clone(f.oldCatalog); catalog.rollbackEpoch = -1;
    old.catalogSha256 = hash(encode(catalog)); f.save(DATA, 'catalogs/current.json', encode(old)); f.save(DATA, 'catalogs/snapshots/36-old.json', encode(catalog));
  }]) {
    const f = fixture(); mutate(f); await assert.rejects(activatePrepared(f.ctx, f.io, f.deps)); assert.equal(f.writes.length, 0);
  }
});
test('freshness expiring during live verification causes rollback rather than accepting expired data', async () => {
  const f = fixture(); let clock = now; f.deps.now = () => clock;
  f.deps.verifyLive = async () => { clock += 2 * 3600_000; return f.proof; };
  await assert.rejects(activatePrepared(f.ctx, f.io, f.deps), /rolled-back/); assertRestored(f);
});
test('journal failure after first pointer selection is rolled back with no skipped durable intent', async () => {
  const f = fixture(); let failed = false;
  f.hooks.beforePut = (key, body) => {
    if (!failed && key.endsWith('/journal.json') && JSON.parse(body).state === 'activating') { failed = true; throw Error('journal lost'); }
  };
  await assert.rejects(activatePrepared(f.ctx, f.io, f.deps), /rolled-back/); assertRestored(f);
  assert.equal(JSON.parse(f.writes.at(-1).body).state, 'rolled-back');
});
test('failed second pointer write and failed post-publication numeric proof restore exact original pointers and metadata', async () => {
  for (const mode of ['second-pointer', 'numeric', 'late-health']) {
    const f = fixture(); let healthCalls = 0;
    if (mode === 'second-pointer') f.hooks.beforePut = key => { if (key === 'catalogs/current.json') throw Error('write unavailable'); };
    if (mode === 'numeric') f.deps.verifyLive = async () => ({ ...f.proof, sourceVerified: false });
    if (mode === 'late-health') f.deps.verifyConsumer = async () => ++healthCalls === 1 ? f.healthy : { ...f.healthy, authMode: 'enforce' };
    await assert.rejects(activatePrepared(f.ctx, f.io, f.deps), /rolled-back/); assertRestored(f);
  }
});
test('crash between pointer CAS and journal update is recoverable from durable ownership metadata', async () => {
  const f = fixture(); let crashed = false;
  f.hooks.afterPut = key => { if (key === 'releases/current.json') { crashed = true; throw Error('process lost after successful put'); } };
  f.hooks.beforeGet = () => { if (crashed) throw Error('process unavailable'); };
  await assert.rejects(activatePrepared(f.ctx, f.io, f.deps), /recovery-required/);
  f.hooks.afterPut = undefined; f.hooks.beforeGet = undefined;
  const result = await recoverActivation(f.ctx, f.io); assert.equal(result.state, 'rolled-back'); assertRestored(f);
  assert.equal((await recoverActivation(f.ctx, f.io)).state, 'rolled-back');
});
test('rollback never overwrites another publisher, including identical candidate bytes with different owner', async () => {
  for (const identical of [false, true]) {
    const f = fixture(); let competing;
    f.deps.verifyLive = async () => {
      competing = identical ? current(f, 'releases/current.json').body : encode({ releaseId: 'someone-else' });
      f.save(DATA, 'releases/current.json', competing, { 'activation-id': '200-1' }); throw Error('health failed');
    };
    await assert.rejects(activatePrepared(f.ctx, f.io, f.deps), /recovery-conflict/);
    assert.equal(hash(current(f, 'releases/current.json').body), hash(competing));
    assert.equal(current(f, 'releases/current.json').customMetadata['activation-id'], '200-1');
    assert.equal(hash(current(f, 'catalogs/current.json').body), hash(f.old[1].body));
  }
});
test('rollback CAS detects concurrent writer after ownership GET without overriding it', async () => {
  const f = fixture(); let recovering = false;
  f.deps.verifyLive = async () => { recovering = true; throw Error('reject candidate'); };
  f.hooks.beforePut = key => {
    if (recovering && key === 'releases/current.json') f.save(DATA, key, encode({ releaseId: 'concurrent' }), { other: 'publisher' });
  };
  await assert.rejects(activatePrepared(f.ctx, f.io, f.deps), /recovery-conflict/);
  assert.equal(currentJSON(f, 'releases/current.json').releaseId, 'concurrent');
});
test('changed pointer after successful live proof cannot be reported as a successful activation', async () => {
  const f = fixture(); f.deps.verifyLive = async () => { f.save(DATA, 'catalogs/current.json', encode({ catalogId: 'newer' })); return f.proof; };
  await assert.rejects(activatePrepared(f.ctx, f.io, f.deps), /recovery-conflict/);
  assert.equal(currentJSON(f, 'catalogs/current.json').catalogId, 'newer');
});
test('numeric proof must match each model/run/release/source pack and contain finite values', async () => {
  const f = fixture(), prepared = await inspectPrepared(f.ctx, f.io, f.deps);
  for (const mutate of [p => p.points.pop(), p => p.points[0].status = 503, p => p.points[0].complete = false,
    p => p.points[0].runId = 'old', p => p.points[0].releaseId = 'old', p => p.points[0].packSha256 = 'f'.repeat(64),
    p => p.points[0].packPath = p.points[7].packPath, p => p.points[0].numericMatch = false,
    p => p.points[0].values.temperature = [NaN], p => p.points[0].values.wind_direction = [],
    p => p.points[0].coordinates = [200, 0], p => p.selection = { ...p.selection, catalogId: 'wrong' },
    p => p.servingCatalog = { ...p.servingCatalog, catalogId: f.ctx.selection.catalogId },
    p => p.points.slice(0, 7).forEach(x => x.coordinates = [0, 0])]) {
    const proof = clone(f.proof); mutate(proof); assert.throws(() => assertLiveProof(proof, prepared, f.ctx, f.proof.servingCatalog));
  }
});
test('tampered recovery intent or journal is rejected before pointer writes', async () => {
  for (const part of ['intent', 'journal']) {
    const f = fixture(); let crashed = false;
    f.hooks.afterPut = key => { if (key === 'releases/current.json') { crashed = true; throw Error('crash'); } };
    f.hooks.beforeGet = () => { if (crashed) throw Error('offline'); };
    await assert.rejects(activatePrepared(f.ctx, f.io, f.deps)); f.hooks.beforeGet = undefined; f.hooks.afterPut = undefined;
    const key = `${f.prefix}activations/100-1/${part}.json`, value = currentJSON(f, key);
    if (part === 'intent') value.pointers[0].key = 'vault/private.json'; else value.intentSha256 = 'f'.repeat(64);
    f.save(DATA, key, encode(value)); const writes = f.writes.length;
    await assert.rejects(recoverActivation(f.ctx, f.io)); assert.equal(f.writes.length, writes);
  }
});
