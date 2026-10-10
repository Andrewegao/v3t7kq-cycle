#!/usr/bin/env node
// Approval-gated retention for model components in weatherx-components-production.
//
// Same shape as tools/production-wind100-retention.mjs: a read-only dry run produces a plan and
// its SHA-256; a separately approved execution recomputes the plan from the same baseline,
// requires that exact SHA-256, re-reads the live pointers before every deletion, never writes a
// pointer, catalog or manifest, and deletes at most `maximumDeletesPerRun` objects per run.
//
// Kept (never a candidate):
//   - every component root referenced by a catalog snapshot in the verified parent chain from the
//     baseline pointer back to, and including, the snapshot that was serving at
//     baseline.publishedAt - windowHours (the chain is proven by the pointer's catalogSha256 for
//     the head and each snapshot's stored sha256 metadata, sequence and parent links);
//   - every root those components route objects to (`references-v1` object layouts);
//   - every root referenced by the staging shared-read pin's catalog, expired or not;
//   - every root whose newest object is younger than the window start (uploads in flight,
//     publications that have not activated yet);
//   - everything outside `components/<model>/` and `components/point-<model>/` for the policy
//     models, and every artifact id that is not the publisher's canonical
//     `<component>-<YYYYMMDDTHHMMSSZ>-<epoch seconds | 32 hex>` (Wind100 recurring, place
//     renewals, canaries and experiments are never touched).
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POLICY_PATH = 'tools/production-components-retention-policy.json';
export const PLAN_KIND = 'weatherx-production-components-retention-plan';
const CONTROL_FILES = [
  '.github/workflows/production-components-retention.yml',
  'docs/production-components-retention.md',
  'tools/production-components-retention.mjs',
  POLICY_PATH,
];
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const SHA = /^[a-f0-9]{64}$/;
const HOUR = 3_600_000;
const MAX_POINTER = 16 * 1024;
const MAX_SNAPSHOT = 4 * 1024 * 1024;
const MAX_MANIFEST = 4 * 1024 * 1024;
const LAYOUTS_WITHIN_ROOT = new Set(['packed-v1', 'direct-auth-v1']);
const FORBIDDEN = ['R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'STAGING_R2_WRITE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_SECRET_ACCESS_KEY',
  'PRODUCTION_WIND100_R2_ACCESS_KEY_ID', 'PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY',
  'PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY',
  'CATALOG_ENDPOINT_PRODUCTION', 'CATALOG_PROMOTION_KEY_PRODUCTION', 'CLOUDFLARE_API_TOKEN'];

export const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

export function readPolicy(root = ROOT) {
  const policy = JSON.parse(readFileSync(resolve(root, POLICY_PATH), 'utf8'));
  validatePolicy(policy);
  return policy;
}
export function validatePolicy(p) {
  assert.ok(object(p) && p.schemaVersion === 1 && p.retentionProfileStatus === 'catalog-chain-window-gc-v1');
  assert.equal(p.dataBucket, 'weatherx-data-production');
  assert.equal(p.componentBucket, 'weatherx-components-production');
  assert.equal(p.stagingControlBucket, 'weatherx-data-staging');
  assert.equal(p.catalogPointerKey, 'catalogs/current.json');
  assert.equal(p.stagingPinKey, 'shared-read/pin.json');
  assert.match(p.accountId, /^[a-f0-9]{32}$/);
  assert.ok(Array.isArray(p.models) && p.models.length > 0 && p.models.every(m => /^[a-z][a-z0-9-]{1,30}$/.test(m)));
  assert.ok(Number.isSafeInteger(p.windowHours) && p.windowHours >= 168, 'the window never shrinks below 7 days');
  assert.ok(Number.isSafeInteger(p.maximumPlanAgeHours) && p.maximumPlanAgeHours > 0 && p.maximumPlanAgeHours <= 72);
  assert.ok(Number.isSafeInteger(p.maximumChainSnapshots) && p.maximumChainSnapshots > 0 && p.maximumChainSnapshots <= 20_000);
  assert.ok(Number.isSafeInteger(p.maximumDeletesPerRun) && p.maximumDeletesPerRun > 0 && p.maximumDeletesPerRun <= 1_000_000);
  assert.ok(Number.isSafeInteger(p.deleteConcurrency) && p.deleteConcurrency > 0 && p.deleteConcurrency <= 32);
  assert.ok(object(p.capacity) && Number.isSafeInteger(p.capacity.objects) && p.capacity.objects > 0 &&
    Number.isSafeInteger(p.capacity.bytes) && p.capacity.bytes > 0 && p.capacity.warnRatio > 0 && p.capacity.warnRatio < 1);
  return p;
}
export function controllerDigest(root = ROOT) {
  const digest = createHash('sha256');
  for (const path of [...CONTROL_FILES].sort()) {
    const bytes = readFileSync(resolve(root, path));
    digest.update(`${path}\0${bytes.length}\0`); digest.update(bytes);
  }
  return digest.digest('hex');
}

// --- scope ------------------------------------------------------------------------------------
export function scopeIds(policy) { return new Set(policy.models.flatMap(m => [m, `point-${m}`])); }
export function canonicalArtifact(componentId, artifactId) {
  if (typeof artifactId !== 'string' || !artifactId.startsWith(`${componentId}-`)) return false;
  return /^\d{8}T\d{6}Z-(?:[1-9]\d{8,11}|[a-f0-9]{32})$/.test(artifactId.slice(componentId.length + 1));
}
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function scopedRoot(policy, prefix) {
  const match = /^components\/([a-z][a-z0-9-]{1,40})\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})\/$/.exec(prefix ?? '');
  return Boolean(match && scopeIds(policy).has(match[1]) && canonicalArtifact(match[1], match[2]));
}
function rootOf(key) {
  const parts = key.split('/');
  return parts.length >= 4 && parts[0] === 'components' && parts[1] && parts[2] ? `components/${parts[1]}/${parts[2]}/` : null;
}

// --- catalog chain ----------------------------------------------------------------------------
export function parsePointer(body) {
  assert.ok(Buffer.isBuffer(body) && body.length > 0 && body.length <= MAX_POINTER);
  const p = JSON.parse(body);
  assert.ok(object(p) && p.schemaVersion === 2 && IDENTIFIER.test(p.catalogId ?? '') && Number.isSafeInteger(p.sequence) &&
    p.sequence > 0 && iso(p.publishedAt) && SHA.test(p.catalogSha256 ?? '') &&
    (p.previousCatalogId === null || IDENTIFIER.test(p.previousCatalogId ?? '')), 'invalid catalog pointer');
  return p;
}
export function parseSnapshot(body, catalogId) {
  assert.ok(Buffer.isBuffer(body) && body.length > 0 && body.length <= MAX_SNAPSHOT, `snapshot ${catalogId} size`);
  const c = JSON.parse(body);
  assert.ok(object(c) && c.schemaVersion === 2 && Number.isSafeInteger(c.sequence) && c.sequence > 0 && iso(c.createdAt) &&
    (c.parentCatalogId === null || IDENTIFIER.test(c.parentCatalogId ?? '')) && object(c.components) &&
    (c.rollbackOfCatalogId === undefined || IDENTIFIER.test(c.rollbackOfCatalogId)), `invalid catalog snapshot ${catalogId}`);
  const entries = Object.entries(c.components);
  assert.ok(entries.length > 0 && entries.length <= 128, `snapshot ${catalogId} component count`);
  const components = [];
  for (const [id, value] of entries) {
    assert.ok(object(value) && value.componentId === id && IDENTIFIER.test(id) && IDENTIFIER.test(value.artifactId ?? '') &&
      value.rootPrefix === `components/${id}/${value.artifactId}/` && value.manifestKey === `${value.rootPrefix}component.json` &&
      SHA.test(value.manifestSha256 ?? ''), `snapshot ${catalogId} component ${id}`);
    components.push({ componentId: id, rootPrefix: value.rootPrefix, manifestKey: value.manifestKey, manifestSha256: value.manifestSha256 });
  }
  return { catalogId, sequence: c.sequence, createdAt: c.createdAt, parentCatalogId: c.parentCatalogId,
    rollbackOfCatalogId: c.rollbackOfCatalogId ?? null, components };
}
async function snapshot(io, policy, catalogId, expectedSha256 = null) {
  assert.ok(IDENTIFIER.test(catalogId ?? ''), 'invalid catalog id');
  const got = await io.get(policy.dataBucket, `catalogs/snapshots/${catalogId}.json`, MAX_SNAPSHOT);
  const digest = hash(got.body);
  // The head is proven by the pointer; every ancestor by the sha256 the catalog writer stored with it.
  assert.equal(digest, expectedSha256 ?? got.metadata?.sha256, `snapshot ${catalogId} hash does not match its proof`);
  return parseSnapshot(got.body, catalogId);
}

// Walk from a verified head back along parent links. Stops after the first snapshot created before
// `windowStart` (it was serving at the window start), at the chain's genesis, or at `stopAt`.
export async function walkFrom({ io, policy, head, windowStart = null, stopAt = null, maximum = policy.maximumChainSnapshots }) {
  const chain = [head];
  let child = head;
  while (true) {
    if (stopAt !== null && child.catalogId === stopAt) return { chain, reachedStop: true, reachedGenesis: false };
    if (windowStart !== null && Date.parse(child.createdAt) < windowStart) return { chain, reachedStop: false, reachedGenesis: false };
    if (child.parentCatalogId === null) return { chain, reachedStop: false, reachedGenesis: true };
    assert.ok(chain.length < maximum, 'catalog chain exceeds its bound');
    const parent = await snapshot(io, policy, child.parentCatalogId);
    assert.ok(parent.sequence + 1 === child.sequence && Date.parse(parent.createdAt) <= Date.parse(child.createdAt),
      `catalog chain link ${parent.catalogId} -> ${child.catalogId} is not contiguous`);
    chain.push(parent);
    child = parent;
  }
}
export async function walkChain({ io, policy, pointer, ...options }) {
  const head = await snapshot(io, policy, pointer.catalogId, pointer.catalogSha256);
  assert.ok(head.sequence === pointer.sequence && head.createdAt === pointer.publishedAt &&
    head.parentCatalogId === pointer.previousCatalogId, 'catalog pointer and snapshot disagree');
  return walkFrom({ io, policy, head, ...options });
}

// Component roots a snapshot needs, including the roots its routed map objects live in.
async function referencedRoots({ io, policy, components, manifestCache }) {
  const ids = scopeIds(policy), roots = new Set();
  for (const component of components) {
    roots.add(component.rootPrefix);
    if (!ids.has(component.componentId)) continue;
    const cacheKey = `${component.manifestKey}\0${component.manifestSha256}`;
    let extra = manifestCache.get(cacheKey);
    if (!extra) {
      const got = await io.get(policy.componentBucket, component.manifestKey, MAX_MANIFEST);
      assert.equal(hash(got.body), component.manifestSha256, `${component.manifestKey} does not match its catalog hash`);
      const manifest = JSON.parse(got.body);
      assert.ok(object(manifest) && manifest.componentId === component.componentId && manifest.rootPrefix === component.rootPrefix,
        `${component.manifestKey} identity`);
      extra = [];
      const layout = manifest.objectLayout;
      if (layout != null) {
        assert.ok(object(layout), `${component.manifestKey} object layout`);
        if (layout.kind === 'references-v1') {
          assert.equal(layout.manifestKey, `${component.rootPrefix}.weatherx-object-references-v1.json`);
          const routing = await io.get(policy.componentBucket, layout.manifestKey, MAX_MANIFEST);
          assert.equal(hash(routing.body), layout.manifestSha256, `${layout.manifestKey} hash`);
          const value = JSON.parse(routing.body);
          assert.ok(value?.kind === 'weatherx-map-object-references-v1' && Array.isArray(value.sourceRoots), `${layout.manifestKey} kind`);
          const own = new RegExp(`^components/${escape(component.componentId)}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}/$`);
          for (const source of value.sourceRoots) {
            assert.ok(own.test(source?.rootPrefix ?? ''), `${layout.manifestKey} source root`);
            extra.push(source.rootPrefix);
          }
        } else assert.ok(LAYOUTS_WITHIN_ROOT.has(layout.kind), `unknown object layout ${String(layout.kind).slice(0, 40)}: refusing to plan`);
      }
      manifestCache.set(cacheKey, extra);
    }
    for (const root of extra) roots.add(root);
  }
  return roots;
}

async function stagingPin(io, policy) {
  const got = await io.getOptional(policy.stagingControlBucket, policy.stagingPinKey, MAX_POINTER);
  if (!got) return { sha256: null, catalogId: null };
  const pin = JSON.parse(got.body);
  assert.ok(object(pin) && pin.schemaVersion === 1 && (pin.catalogId === null || IDENTIFIER.test(pin.catalogId ?? '')),
    'staging shared-read pin is unreadable: refusing to plan');
  return { sha256: hash(got.body), catalogId: pin.catalogId };
}

// --- inventory --------------------------------------------------------------------------------
function pool(limit) {
  let active = 0; const waiting = [];
  return async task => {
    while (active >= limit) await new Promise(next => waiting.push(next));
    active += 1;
    try { return await task(); } finally { active -= 1; waiting.shift()?.(); }
  };
}
async function inventory({ io, policy }) {
  const ids = scopeIds(policy), roots = new Map();
  const bucket = { objects: 0, bytes: 0 }, byPrefix = new Map();
  const count = (prefix, size) => {
    const totals = byPrefix.get(prefix) ?? { objects: 0, bytes: 0 };
    totals.objects += 1; totals.bytes += size; bucket.objects += 1; bucket.bytes += size;
    byPrefix.set(prefix, totals);
  };
  const top = await io.listPrefixes('');
  for (const row of top.rows) count('(root)', row.size);
  const prefixes = [];
  for (const prefix of top.prefixes) {
    if (prefix !== 'components/') { prefixes.push(prefix); continue; }
    const children = await io.listPrefixes('components/');
    for (const row of children.rows) count('components/', row.size);
    prefixes.push(...children.prefixes);
  }
  const limit = pool(8);
  await Promise.all(prefixes.map(prefix => limit(() => io.list(prefix, row => {
    count(prefix, row.size);
    const id = /^components\/([^/]+)\/$/.exec(prefix)?.[1];
    if (!id || !ids.has(id)) return;
    const root = rootOf(row.key);
    const value = roots.get(root ?? `${prefix}(loose)`) ?? { prefix: root, componentId: id, objects: 0, bytes: 0, newest: 0 };
    value.objects += 1; value.bytes += row.size; value.newest = Math.max(value.newest, row.lastModified);
    roots.set(root ?? `${prefix}(loose)`, value);
  }))));
  return { roots: [...roots.values()], bucket, byPrefix };
}
const keyDigest = rows => hash(JSON.stringify(rows.map(row => [row.key, row.size, row.etag ?? null])));

// --- plan -------------------------------------------------------------------------------------
export function capacityLine(policy, totals, after, last24h) {
  const pct = (n, d) => `${(100 * n / d).toFixed(1)}%`;
  const ratio = Math.max(totals.objects / policy.capacity.objects, totals.bytes / policy.capacity.bytes);
  const state = ratio >= 1 ? 'ALARM' : ratio >= policy.capacity.warnRatio ? 'WARN' : 'OK';
  const gb = n => `${(n / 1e9).toFixed(0)} GB`;
  const days = last24h.bytes > 0 ? Math.max(0, (policy.capacity.bytes - totals.bytes) / last24h.bytes) : null;
  return `CAP ${state}: ${policy.componentBucket} holds ${totals.objects.toLocaleString('en-US')} objects / ${gb(totals.bytes)} ` +
    `against the ${policy.capacity.objects.toLocaleString('en-US')} objects / ${gb(policy.capacity.bytes)} budget ` +
    `(${pct(totals.objects, policy.capacity.objects)} / ${pct(totals.bytes, policy.capacity.bytes)}); ` +
    `after this plan ${after.objects.toLocaleString('en-US')} / ${gb(after.bytes)}; ` +
    `last 24 h +${last24h.objects.toLocaleString('en-US')} objects / +${gb(last24h.bytes)}` +
    (days === null ? '' : `, byte budget reached in ${days.toFixed(1)} days at that rate`) +
    `. ${policy.capacity.basis}.`;
}

export async function planRetention({ io, policy, now = Date.now, baselineCatalogId = null }) {
  validatePolicy(policy);
  const startedAt = now();
  const liveObject = await io.get(policy.dataBucket, policy.catalogPointerKey, MAX_POINTER);
  const live = parsePointer(liveObject.body);
  // Execution recomputes the dry run's plan at its baseline: the baseline must be an ancestor of
  // the live pointer reached only by forward promotions (checked below), and young enough.
  const liveSegment = await walkChain({ io, policy, pointer: live, stopAt: baselineCatalogId ?? live.catalogId });
  assert.ok(liveSegment.reachedStop, 'approved baseline is not in the live catalog chain; replan');
  const head = liveSegment.chain[liveSegment.chain.length - 1];
  assert.ok(Date.parse(live.publishedAt) - Date.parse(head.createdAt) <= policy.maximumPlanAgeHours * HOUR,
    'approved baseline is older than maximumPlanAgeHours; replan');
  const windowStart = Date.parse(head.createdAt) - policy.windowHours * HOUR;
  const { chain, reachedGenesis } = await walkFrom({ io, policy, head, windowStart });
  const manifestCache = new Map(), keep = new Set();
  for (const item of chain) for (const root of await referencedRoots({ io, policy, components: item.components, manifestCache })) keep.add(root);
  const pin = await stagingPin(io, policy);
  if (pin.catalogId) {
    const pinned = await snapshot(io, policy, pin.catalogId);
    for (const root of await referencedRoots({ io, policy, components: pinned.components, manifestCache })) keep.add(root);
  }
  // Roots promoted after the baseline (execution only) must not be candidates either.
  const later = new Set();
  for (const item of liveSegment.chain.slice(0, -1)) {
    assert.equal(item.rollbackOfCatalogId, null, 'a rollback happened after the approved baseline; replan');
    for (const root of await referencedRoots({ io, policy, components: item.components, manifestCache })) later.add(root);
  }
  const listing = await inventory({ io, policy });
  const held = { referenced: [0, 0], nonCanonical: [0, 0], recent: [0, 0] };
  const add = (row, key) => { held[key][0] += row.objects; held[key][1] += row.bytes; };
  const eligible = [];
  for (const row of listing.roots) {
    if (row.prefix && (keep.has(row.prefix) || later.has(row.prefix))) add(row, 'referenced');
    else if (!row.prefix || !scopedRoot(policy, row.prefix)) add(row, 'nonCanonical');
    else if (row.newest >= windowStart) add(row, 'recent');
    else eligible.push(row);
  }
  eligible.sort((a, b) => a.newest - b.newest || a.prefix.localeCompare(b.prefix));
  const candidates = [];
  let selectedObjects = 0;
  for (const row of eligible) {
    if (selectedObjects + row.objects > policy.maximumDeletesPerRun) break;
    const rows = await io.listRows(row.prefix, policy.maximumDeletesPerRun);
    assert.equal(rows.length, row.objects, `${row.prefix} changed while planning`);
    assert.ok(rows.every(r => r.key.startsWith(row.prefix) && r.key.length > row.prefix.length && r.key.length <= 1024 &&
      !r.key.slice(row.prefix.length).split('/').some(part => part === '' || part === '.' || part === '..')), `${row.prefix} key shape`);
    candidates.push({ prefix: row.prefix, componentId: row.componentId, objectCount: rows.length,
      bytes: rows.reduce((n, r) => n + r.size, 0), newestModified: new Date(row.newest).toISOString(),
      keysSha256: keyDigest(rows.sort((a, b) => a.key.localeCompare(b.key))) });
    selectedObjects += rows.length;
  }
  const sum = (rows, field) => rows.reduce((n, row) => n + row[field], 0);
  const plan = {
    schemaVersion: 1, kind: PLAN_KIND, policySha256: hash(JSON.stringify(policy)),
    baseline: { catalogId: head.catalogId, sequence: head.sequence, publishedAt: head.createdAt,
      windowStart: new Date(windowStart).toISOString() },
    chain: { snapshots: chain.length, oldestCatalogId: chain[chain.length - 1].catalogId,
      oldestCreatedAt: chain[chain.length - 1].createdAt, reachedGenesis },
    stagingPin: pin,
    keep: { roots: keep.size, rootsSha256: hash([...keep].sort().join('\n')) },
    eligible: { roots: eligible.length, objects: sum(eligible, 'objects'), bytes: sum(eligible, 'bytes') },
    candidates,
    totals: { roots: candidates.length, objects: sum(candidates, 'objectCount'), bytes: sum(candidates, 'bytes') },
  };
  const planSha256 = hash(JSON.stringify(plan));
  const last24h = listing.roots.filter(row => row.newest >= startedAt - 24 * HOUR)
    .reduce((n, row) => ({ objects: n.objects + row.objects, bytes: n.bytes + row.bytes }), { objects: 0, bytes: 0 });
  const after = { objects: listing.bucket.objects - plan.totals.objects, bytes: listing.bucket.bytes - plan.totals.bytes };
  // Report only: live totals move every few minutes, so they are outside the approved digest.
  const report = { listedAt: new Date(startedAt).toISOString(),
    livePointer: { catalogId: live.catalogId, publishedAt: live.publishedAt, sha256: hash(liveObject.body) },
    bucket: listing.bucket, byPrefix: Object.fromEntries([...listing.byPrefix].sort(([a], [b]) => a.localeCompare(b))),
    held: { ...Object.fromEntries(Object.entries(held).map(([k, [objects, bytes]]) => [k, { objects, bytes }])),
      outOfScope: { objects: listing.bucket.objects - sum(listing.roots, 'objects'), bytes: listing.bucket.bytes - sum(listing.roots, 'bytes') } },
    afterAllEligible: { objects: listing.bucket.objects - plan.eligible.objects, bytes: listing.bucket.bytes - plan.eligible.bytes },
    last24h, capacity: capacityLine(policy, listing.bucket, after, last24h) };
  return { ...plan, planSha256, report };
}

// --- execution --------------------------------------------------------------------------------

// Execution never trusts a plan file: it recomputes the plan at the approved baseline and requires
// its SHA-256 to equal the approved one. That also proves the live chain descends from the baseline
// by forward promotions only and that nothing promoted since references a candidate.
export async function executeRetention({ io, policy, approvedPlanSha256, baselineCatalogId, deleteForPrefix, now = Date.now }) {
  validatePolicy(policy);
  assert.match(approvedPlanSha256 ?? '', SHA, 'PRODUCTION_COMPONENTS_GC_APPROVED_PLAN_SHA256 is not set');
  assert.ok(IDENTIFIER.test(baselineCatalogId ?? ''), 'execute needs baseline_catalog_id from the approved dry run');
  const replay = await planRetention({ io, policy, now, baselineCatalogId });
  const { planSha256, report, ...content } = replay;
  assert.equal(planSha256, hash(JSON.stringify(content)));
  assert.equal(planSha256, approvedPlanSha256, 'production retention plan differs from the approved plan; replan and approve again');
  assert.equal(content.kind, PLAN_KIND);
  assert.ok(content.totals.objects <= policy.maximumDeletesPerRun, 'retention delete budget exceeded');
  const candidates = new Set(content.candidates.map(row => row.prefix));
  assert.ok(content.candidates.every(row => scopedRoot(policy, row.prefix)));
  let verifiedHead = null, aborted = null;
  const verifiedPointers = new Set();
  let walking = Promise.resolve();
  const manifestCache = new Map();
  // Before every deletion: the live pointer is the verified one or a forward descendant whose new
  // snapshots reference no candidate root, and the staging pin is unchanged. Pointer bytes are
  // read again each time; only the chain walk for a new pointer is shared.
  async function guard(prefix) {
    const [pointerObject, pin] = await Promise.all([
      io.get(policy.dataBucket, policy.catalogPointerKey, MAX_POINTER), stagingPin(io, policy)]);
    assert.deepEqual(pin, content.stagingPin, 'staging shared-read pin changed after the dry run; replan');
    const digest = hash(pointerObject.body);
    if (!verifiedPointers.has(digest)) {
      const run = walking.then(async () => {
        if (verifiedPointers.has(digest)) return;
        const pointer = parsePointer(pointerObject.body);
        const segment = await walkChain({ io, policy, pointer, stopAt: verifiedHead, maximum: 500 });
        assert.ok(segment.reachedStop, 'live catalog no longer descends from the verified head; replan');
        for (const item of segment.chain.slice(0, -1)) {
          assert.equal(item.rollbackOfCatalogId, null, 'a catalog rollback happened during cleanup; replan');
          for (const root of await referencedRoots({ io, policy, components: item.components, manifestCache }))
            assert.ok(!candidates.has(root), `${root} was promoted again; stopping`);
        }
        verifiedHead = pointer.catalogId; verifiedPointers.add(digest);
      });
      walking = run.catch(() => {});
      await run;
    }
    assert.ok(candidates.has(prefix));
  }
  verifiedHead = report.livePointer.catalogId;
  verifiedPointers.add(report.livePointer.sha256);
  const limit = pool(policy.deleteConcurrency);
  let deleted = 0;
  for (const candidate of content.candidates) {
    const rows = (await io.listRows(candidate.prefix, policy.maximumDeletesPerRun)).sort((a, b) => a.key.localeCompare(b.key));
    assert.equal(keyDigest(rows), candidate.keysSha256, `${candidate.prefix} changed since the dry run; replan`);
    // The manifest goes last so an interrupted root still names itself.
    const keys = rows.map(row => row.key);
    const manifest = `${candidate.prefix}component.json`;
    const ordered = [...keys.filter(key => key !== manifest), ...keys.filter(key => key === manifest)];
    // Temporary credentials live 15 minutes: mint one per root and again after 10 minutes.
    const clients = [];
    let current = null, mintedAt = 0;
    const clientFor = () => {
      if (!current || now() - mintedAt > 600_000) {
        mintedAt = now(); current = Promise.resolve(deleteForPrefix(candidate.prefix)); clients.push(current);
      }
      return current;
    };
    try {
      const body = ordered.slice(0, -1), last = ordered.slice(-1);
      for (const batch of [body, last]) {
        await Promise.all(batch.map(key => limit(async () => {
          if (aborted) return;
          try {
            assert.ok(key.startsWith(candidate.prefix) && key.length > candidate.prefix.length);
            await guard(candidate.prefix);
            if (aborted) return;
            await (await clientFor()).delete(key);
            deleted += 1;
          } catch (error) { aborted ??= error; }
        })));
        if (aborted) throw Object.assign(new Error(`${aborted.message} (deleted ${deleted} objects before stopping)`), { deleted });
      }
    } finally { for (const client of clients) (await client.catch(() => null))?.close?.(); }
  }
  return { status: 'deleted-unreferenced-production-model-components', planSha256,
    baselineCatalogId: content.baseline.catalogId, roots: content.candidates.length, deleted, bytes: content.totals.bytes };
}

// --- R2 adapter -------------------------------------------------------------------------------
function base64url(value) { return Buffer.from(value).toString('base64url'); }
export function scopedDeleteCredentials(parent, prefix, policy, nowSeconds = Math.floor(Date.now() / 1000)) {
  assert.match(parent.accessKeyId ?? '', /^[A-Za-z0-9]{10,128}$/);
  assert.ok(typeof parent.secretAccessKey === 'string' && parent.secretAccessKey.length >= 32);
  assert.ok(scopedRoot(policy, prefix), 'delete credential scope must be one canonical model component root');
  assert.ok(Number.isSafeInteger(nowSeconds) && nowSeconds > 0);
  const endpoint = `https://${policy.accountId}.r2.cloudflarestorage.com`;
  const claims = { bucket: policy.componentBucket, actions: ['DeleteObject'],
    paths: { prefixPaths: [prefix], objectPaths: [] }, sub: policy.accountId, iss: parent.accessKeyId,
    aud: new URL(endpoint).host, iat: nowSeconds, exp: nowSeconds + 900 };
  const unsigned = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  const jwt = `${unsigned}.${createHmac('sha256', parent.secretAccessKey).update(unsigned).digest('base64url')}`;
  return { accessKeyId: parent.accessKeyId, secretAccessKey: createHash('sha256').update(jwt).digest('hex'),
    sessionToken: Buffer.from(`jwt/${jwt}`).toString('base64') };
}

export async function createRetentionIo(env, policy, injectedSdk, injectedReadClient, injectedDeleteClientFactory) {
  validatePolicy(policy);
  assert.equal(env.PRODUCTION_COMPONENTS_R2_ACCOUNT_ID, policy.accountId);
  assert.ok(env.PRODUCTION_COMPONENTS_GC_READ_ACCESS_KEY_ID && env.PRODUCTION_COMPONENTS_GC_READ_SECRET_ACCESS_KEY);
  for (const key of FORBIDDEN) assert.ok(!env[key], `retention refuses ${key}`);
  const endpoint = `https://${policy.accountId}.r2.cloudflarestorage.com`;
  const sdk = injectedSdk ?? await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
  const readClient = injectedReadClient ?? new sdk.S3Client({ region: 'auto', endpoint, forcePathStyle: true, maxAttempts: 3,
    credentials: { accessKeyId: env.PRODUCTION_COMPONENTS_GC_READ_ACCESS_KEY_ID,
      secretAccessKey: env.PRODUCTION_COMPONENTS_GC_READ_SECRET_ACCESS_KEY } });
  const send = command => readClient.send(command, { abortSignal: AbortSignal.timeout(120_000) });
  const ids = scopeIds(policy);
  const readable = (bucket, key) =>
    (bucket === policy.dataBucket && (key === policy.catalogPointerKey || /^catalogs\/snapshots\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.json$/.test(key))) ||
    (bucket === policy.stagingControlBucket && key === policy.stagingPinKey) ||
    (bucket === policy.componentBucket && (() => {
      const m = /^components\/([a-z][a-z0-9-]{1,40})\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/(component\.json|\.weatherx-object-references-v1\.json)$/.exec(key);
      return Boolean(m && ids.has(m[1]));
    })());
  async function get(bucket, key, maximum) {
    assert.ok(readable(bucket, key), `retention may not read ${bucket}/${key}`);
    const response = await send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
    assert.ok(response.ContentLength > 0 && response.ContentLength <= maximum);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.Body) { bytes += chunk.length; assert.ok(bytes <= response.ContentLength); chunks.push(Buffer.from(chunk)); }
    assert.equal(bytes, response.ContentLength);
    return { body: Buffer.concat(chunks), metadata: response.Metadata ?? {} };
  }
  async function getOptional(bucket, key, maximum) {
    try { return await get(bucket, key, maximum); }
    catch (error) { if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null; throw error; }
  }
  const listable = prefix => /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/$/.test(prefix) ||
    /^components\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/$/.test(prefix) || scopedRoot(policy, prefix);
  async function pages(input, onPage) {
    const tokens = new Set(); let token;
    do {
      const page = await send(new sdk.ListObjectsV2Command({ Bucket: policy.componentBucket, MaxKeys: 1000, ...input,
        ...(token ? { ContinuationToken: token } : {}) }));
      onPage(page);
      token = page.NextContinuationToken;
      if (token) { assert.ok(!tokens.has(token)); tokens.add(token); }
      assert.equal(Boolean(token), Boolean(page.IsTruncated));
    } while (token);
  }
  async function listPrefixes(prefix) {
    assert.ok(prefix === '' || prefix === 'components/');
    const prefixes = [], rows = [];
    await pages({ ...(prefix ? { Prefix: prefix } : {}), Delimiter: '/' }, page => {
      for (const row of page.CommonPrefixes ?? []) prefixes.push(row.Prefix);
      for (const row of page.Contents ?? []) rows.push({ key: row.Key, size: row.Size });
    });
    return { prefixes, rows };
  }
  async function list(prefix, onRow) {
    assert.ok(listable(prefix) && prefix !== 'components/', `retention may not list ${prefix}`);
    await pages({ Prefix: prefix }, page => {
      for (const row of page.Contents ?? []) {
        assert.ok(row.Key.startsWith(prefix));
        onRow({ key: row.Key, size: row.Size, lastModified: new Date(row.LastModified).valueOf(), etag: row.ETag ?? null });
      }
    });
  }
  async function listRows(prefix, maximum) {
    assert.ok(scopedRoot(policy, prefix), `retention may not enumerate ${prefix} for deletion`);
    const rows = [];
    await list(prefix, row => { rows.push(row); assert.ok(rows.length <= maximum); });
    return rows;
  }
  async function deleteForPrefix(prefix) {
    assert.ok(env.PRODUCTION_COMPONENTS_GC_DELETE_ACCESS_KEY_ID && env.PRODUCTION_COMPONENTS_GC_DELETE_SECRET_ACCESS_KEY);
    assert.notEqual(env.PRODUCTION_COMPONENTS_GC_DELETE_ACCESS_KEY_ID, env.PRODUCTION_COMPONENTS_GC_READ_ACCESS_KEY_ID);
    const credentials = scopedDeleteCredentials({ accessKeyId: env.PRODUCTION_COMPONENTS_GC_DELETE_ACCESS_KEY_ID,
      secretAccessKey: env.PRODUCTION_COMPONENTS_GC_DELETE_SECRET_ACCESS_KEY }, prefix, policy);
    const client = injectedDeleteClientFactory?.(credentials) ?? new sdk.S3Client({ region: 'auto', endpoint,
      forcePathStyle: true, maxAttempts: 3, credentials });
    return { async delete(key) {
      assert.ok(key.startsWith(prefix) && key.length > prefix.length);
      await client.send(new sdk.DeleteObjectCommand({ Bucket: policy.componentBucket, Key: key }),
        { abortSignal: AbortSignal.timeout(120_000) });
    }, close: () => client.destroy?.() };
  }
  return { get, getOptional, listPrefixes, list, listRows, deleteForPrefix, close: () => readClient.destroy?.() };
}

export function planSummary(plan) {
  const gb = n => `${(n / 1e9).toFixed(1)} GB`;
  return [`## Production component retention plan`, '',
    `planSha256 \`${plan.planSha256}\` · baseline catalog \`${plan.baseline.catalogId}\` (${plan.baseline.publishedAt}) · window from ${plan.baseline.windowStart}`, '',
    `- Chain: ${plan.chain.snapshots} verified snapshots back to \`${plan.chain.oldestCatalogId}\` (${plan.chain.oldestCreatedAt}); staging pin ${plan.stagingPin.catalogId ?? 'none'}.`,
    `- Kept roots: ${plan.keep.roots}. Held: referenced ${plan.report.held.referenced.objects.toLocaleString('en-US')} objects / ${gb(plan.report.held.referenced.bytes)}, ` +
      `recent ${plan.report.held.recent.objects.toLocaleString('en-US')} / ${gb(plan.report.held.recent.bytes)}, ` +
      `not canonical ${plan.report.held.nonCanonical.objects.toLocaleString('en-US')} / ${gb(plan.report.held.nonCanonical.bytes)}, ` +
      `outside the model prefixes ${plan.report.held.outOfScope.objects.toLocaleString('en-US')} / ${gb(plan.report.held.outOfScope.bytes)}.`,
    `- Eligible (unreferenced, older than the window): ${plan.eligible.roots} roots, ${plan.eligible.objects.toLocaleString('en-US')} objects, ${gb(plan.eligible.bytes)}.`,
    `- This run deletes: ${plan.totals.roots} roots, ${plan.totals.objects.toLocaleString('en-US')} objects, ${gb(plan.totals.bytes)}.`,
    `- ${plan.report.capacity}`, ''].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command] = process.argv.slice(2);
  try {
    assert.ok(['dry-run', 'execute'].includes(command));
    const env = process.env;
    assert.equal(env.GITHUB_ACTIONS, 'true');
    assert.equal(env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle');
    assert.equal(env.GITHUB_REF, 'refs/heads/main');
    assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(env.GITHUB_WORKFLOW_REF, 'Andrewegao/v3t7kq-cycle/.github/workflows/production-components-retention.yml@refs/heads/main');
    assert.equal(env.GITHUB_JOB, 'retention');
    assert.equal(env.COMPONENTS_GC_ENVIRONMENT, 'data-production-components-cleanup');
    assert.equal(env.PRODUCTION_COMPONENTS_GC_ENABLED, 'true');
    assert.equal(env.PRODUCTION_COMPONENTS_GC_CONTROLLER_SHA256, controllerDigest());
    if (command === 'execute') assert.equal(env.PRODUCTION_COMPONENTS_GC_EXECUTE_ENABLED, 'true');
    const policy = readPolicy();
    const io = await createRetentionIo(env, policy);
    try {
      if (command === 'dry-run') {
        const plan = await planRetention({ io, policy });
        process.stdout.write(`${JSON.stringify(plan)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(await executeRetention({ io, policy, deleteForPrefix: io.deleteForPrefix,
          baselineCatalogId: env.INPUT_BASELINE_CATALOG_ID ?? '',
          approvedPlanSha256: env.PRODUCTION_COMPONENTS_GC_APPROVED_PLAN_SHA256 }))}\n`);
      }
    } finally { io.close(); }
  } catch (error) { console.error(`Production component retention refused: ${error.message}`); process.exitCode = 1; }
}
