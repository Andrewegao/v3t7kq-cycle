#!/usr/bin/env node
// Approval-gated retention for whole immutable data releases in weatherx-data-production.
//
// Same shape as tools/production-components-retention.mjs: a read-only dry run produces a plan and
// its SHA-256; a separately approved execution recomputes the plan at the dry run's `asOf` and
// baseline release, requires that exact SHA-256, re-reads `releases/current.json` and the staging
// shared-read pin before every deletion, never writes a pointer, catalog or manifest, and deletes
// at most `maximumDeletesPerRun` objects per run through per-release DeleteObject-only credentials.
//
// A release id is never a candidate when any of these holds (evaluated as of the plan's `asOf`):
//   - it is the releaseId of `releases/current.json` (the baseline read by the dry run, and the
//     live pointer re-read by the execution and before every delete);
//   - it is among the newest `keepNewestReleases` complete releases by manifest `createdAt`, or by
//     GitHub run id (both orders are kept, so a skewed clock cannot shorten the rollback set);
//   - any of its objects, or its manifest `createdAt`, is newer than `minimumAgeHours`;
//   - it is the releaseId of the staging shared-read pin, expired or not;
//   - the owner lists it in the policy's `keepReleaseIds` (every release activated by hand in the
//     last seven days, since the pointer keeps no history of earlier current releases);
//   - its manifest is missing, unparsable or names more objects than it lists (incomplete or
//     inconsistent upload: reported, never deleted in v1);
//   - its prefix is not `releases/cycle-<digits>/` (`releases/current.json` and every other key are
//     out of scope).
// Planning (dry run and execution) refuses outright while `releases/current.json` does not name
// the newest release by createdAt and by run id: a manual rollback is in effect (or a promotion is
// still pending) and people, not this controller, are in charge of the bucket.
// Catalog snapshots never name a release id (Atmos platform/edge/src/catalog.ts DataCatalog has
// only components), so no catalog is read.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const POLICY_PATH = 'tools/production-releases-retention-policy.json';
export const PLAN_KIND = 'weatherx-production-releases-retention-plan';
const CONTROL_FILES = [
  '.github/workflows/production-releases-retention.yml',
  'docs/production-releases-retention.md',
  'tools/production-releases-retention.mjs',
  POLICY_PATH,
];
const RELEASES = 'releases/';
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const RELEASE_PREFIX = /^releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/$/;
const SCOPED = /^releases\/(cycle-([1-9]\d{0,19}))\/$/;
const SHA = /^[a-f0-9]{64}$/;
const HOUR = 3_600_000;
const MAX_POINTER = 256 * 1024;
const MAX_PIN = 8 * 1024;
const MAX_PROTECTED_OBJECTS = 2_000_000;
const FORBIDDEN = ['R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'STAGING_R2_WRITE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_SECRET_ACCESS_KEY',
  'PRODUCTION_WIND100_R2_ACCESS_KEY_ID', 'PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY',
  'PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY',
  'PRODUCTION_COMPONENTS_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_COMPONENTS_GC_DELETE_SECRET_ACCESS_KEY',
  'CATALOG_ENDPOINT_PRODUCTION', 'CATALOG_PROMOTION_KEY_PRODUCTION', 'CATALOG_ENDPOINT', 'CATALOG_PROMOTION_KEY',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'];
// The bake publisher's token reaches its job as rclone remote settings (bake.yml
// RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID / _SECRET_ACCESS_KEY); any rclone remote setting is refused.
const FORBIDDEN_PREFIXES = ['RCLONE_CONFIG_'];

export const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const isoOf = ms => new Date(ms).toISOString();

export function readPolicy(root = ROOT) {
  const policy = JSON.parse(readFileSync(resolve(root, POLICY_PATH), 'utf8'));
  validatePolicy(policy);
  return policy;
}
export function validatePolicy(p) {
  assert.ok(object(p) && p.schemaVersion === 1 && p.retentionProfileStatus === 'release-pointer-window-gc-v1');
  assert.equal(p.dataBucket, 'weatherx-data-production');
  assert.equal(p.stagingControlBucket, 'weatherx-data-staging');
  assert.equal(p.releasePointerKey, 'releases/current.json');
  assert.equal(p.stagingPinKey, 'shared-read/pin.json');
  assert.match(p.accountId, /^[a-f0-9]{32}$/);
  assert.ok(Number.isSafeInteger(p.keepNewestReleases) && p.keepNewestReleases >= 2 && p.keepNewestReleases <= 200,
    'keepNewestReleases never drops below the runbook\'s two last-good releases');
  assert.ok(Array.isArray(p.keepReleaseIds) && p.keepReleaseIds.length <= 64 && p.keepReleaseIds.every(id => IDENTIFIER.test(id ?? '')) &&
    new Set(p.keepReleaseIds).size === p.keepReleaseIds.length, 'keepReleaseIds is a list of at most 64 distinct release ids');
  assert.ok(Number.isSafeInteger(p.minimumAgeHours) && p.minimumAgeHours >= 72 && p.minimumAgeHours <= 24 * 90,
    'minimumAgeHours never drops below 72 hours');
  assert.ok(Number.isSafeInteger(p.maximumPlanAgeHours) && p.maximumPlanAgeHours > 0 && p.maximumPlanAgeHours <= 48);
  assert.ok(Number.isSafeInteger(p.maximumReleasePrefixes) && p.maximumReleasePrefixes > 0 && p.maximumReleasePrefixes <= 10_000);
  assert.ok(Number.isSafeInteger(p.maximumManifestBytes) && p.maximumManifestBytes > 0 && p.maximumManifestBytes <= 64 * 1024 * 1024);
  assert.ok(Number.isSafeInteger(p.maximumDeletesPerRun) && p.maximumDeletesPerRun > 0 && p.maximumDeletesPerRun <= 1_000_000);
  assert.ok(Number.isSafeInteger(p.deleteConcurrency) && p.deleteConcurrency > 0 && p.deleteConcurrency <= 32);
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
export function scopedRelease(prefix) { return SCOPED.test(prefix ?? ''); }
function scopedId(prefix) {
  const match = SCOPED.exec(prefix ?? '');
  return match ? { releaseId: match[1], runId: match[2] } : null;
}
const byRunDesc = (a, b) => (BigInt(b.runId) > BigInt(a.runId) ? 1 : BigInt(b.runId) < BigInt(a.runId) ? -1 : 0);
const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
export const listingDigest = rows => {
  const digest = createHash('sha256');
  for (const row of rows) digest.update(`${row.key}\0${row.size}\0${row.etag ?? ''}\n`);
  return digest.digest('hex');
};

// --- pointers and manifests -------------------------------------------------------------------
export function parsePointer(body) {
  assert.ok(Buffer.isBuffer(body) && body.length > 0 && body.length <= MAX_POINTER, 'release pointer size');
  let p = null;
  try { p = JSON.parse(body); } catch { /* checked below */ }
  assert.ok(object(p) && p.schemaVersion === 1 && IDENTIFIER.test(p.releaseId ?? '') && Number.isFinite(Date.parse(p.publishedAt)) &&
    Number.isSafeInteger(p.objectCount) && p.objectCount > 0 && /^[a-f0-9]{64}$/i.test(p.manifestSha256 ?? ''),
  'releases/current.json is not a valid release pointer: refusing');
  return p;
}
async function stagingPin(io, policy) {
  const got = await io.getOptional(policy.stagingControlBucket, policy.stagingPinKey, MAX_PIN);
  if (!got) return { sha256: null, releaseId: null };
  let pin = null;
  try { pin = JSON.parse(got.body); } catch { /* checked below */ }
  assert.ok(object(pin) && pin.schemaVersion === 1 && (pin.releaseId === null || IDENTIFIER.test(pin.releaseId ?? '')) &&
    (pin.catalogId == null || IDENTIFIER.test(pin.catalogId)), 'staging shared-read pin is unreadable: refusing to plan');
  return { sha256: hash(got.body), releaseId: pin.releaseId };
}
// What a release's own manifest says about it. Anything but a parseable schema-1 manifest naming
// this release is `manifest-invalid`; the canonical digest is the one the release pointer carries.
export function summarizeManifest(body, releaseId) {
  let m = null;
  try { m = JSON.parse(body); } catch { return { status: 'manifest-invalid', reason: 'not-json' }; }
  if (!object(m) || m.schemaVersion !== 1 || m.releaseId !== releaseId || typeof m.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(m.createdAt)) || !Number.isSafeInteger(m.objectCount) || m.objectCount <= 0 ||
      !Array.isArray(m.objects) || m.objects.length !== m.objectCount ||
      !m.objects.every(o => object(o) && typeof o.path === 'string' && o.path.length > 0 && Number.isSafeInteger(o.bytes)))
    return { status: 'manifest-invalid', reason: 'shape' };
  return { status: 'manifest-valid', createdAt: m.createdAt, objectCount: m.objectCount, manifestSha256: hash(JSON.stringify(m)), manifest: m };
}
async function readManifest(io, policy, prefix) {
  try { return await io.getOptional(policy.dataBucket, `${prefix}manifest.json`, policy.maximumManifestBytes); }
  catch (error) { if (error?.name === 'ObjectTooLarge') return { tooLarge: true }; throw error; }
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
// Every release prefix under `releases/`, each listed in full (paginated) for its object count,
// bytes and newest LastModified. Nothing outside `releases/` is listed.
async function inventory({ io, policy }) {
  const top = await io.listPrefixes(RELEASES);
  assert.ok(top.prefixes.length <= policy.maximumReleasePrefixes, 'more release prefixes than maximumReleasePrefixes: refusing');
  const loose = { objects: top.rows.length, bytes: top.rows.reduce((n, row) => n + row.size, 0) };
  const limit = pool(8);
  const releases = await Promise.all(top.prefixes.map(prefix => limit(async () => {
    assert.ok(RELEASE_PREFIX.test(prefix), `unexpected release prefix ${String(prefix).slice(0, 120)}: refusing`);
    const value = { prefix, objects: 0, bytes: 0, newest: 0 };
    await io.list(prefix, row => { value.objects += 1; value.bytes += row.size; value.newest = Math.max(value.newest, row.lastModified); });
    return value;
  })));
  return { loose, releases: releases.sort((a, b) => (a.prefix < b.prefix ? -1 : 1)) };
}

// Proof that a protected release is whole: its full listing digest, and every path its manifest
// names is listed with the manifest's byte count. Execution repeats this after the last delete.
async function proveProtected({ io, policy, ids }) {
  const proofs = [];
  for (const releaseId of ids) {
    const prefix = `releases/${releaseId}/`;
    const rows = (await io.listRows(prefix, MAX_PROTECTED_OBJECTS)).sort(byKey);
    if (rows.length === 0) { proofs.push({ releaseId, present: false }); continue; }
    const got = await readManifest(io, policy, prefix);
    const summary = got && !got.tooLarge ? summarizeManifest(got.body, releaseId) : { status: got ? 'manifest-invalid' : 'manifest-missing' };
    let manifestCovered = false;
    if (summary.manifest) {
      const sizes = new Map(rows.map(row => [row.key, row.size]));
      manifestCovered = sizes.has(`${prefix}manifest.json`) && summary.manifest.objects.every(o => sizes.get(`${prefix}${o.path}`) === o.bytes);
    }
    proofs.push({ releaseId, present: true, objects: rows.length, listingSha256: listingDigest(rows), manifestCovered });
  }
  return proofs;
}

// --- plan -------------------------------------------------------------------------------------
const HELD_ORDER = ['current', 'live-current', 'staging-pin', 'owner-keep', 'newest', 'incomplete', 'inconsistent', 'recent'];

export async function planRetention({ io, policy, now = Date.now, asOf = null, baselineReleaseId = null, retried = false }) {
  validatePolicy(policy);
  const startedAt = now();
  const liveObject = await io.get(policy.dataBucket, policy.releasePointerKey, MAX_POINTER);
  const live = parsePointer(liveObject.body);
  let asOfMs;
  if (asOf === null) {
    asOfMs = Math.floor(startedAt / 1000) * 1000;
    baselineReleaseId = live.releaseId;
  } else {
    // Execution recomputes the dry run's plan at its own asOf and baseline release, so the age cut
    // and the newest-N set are the ones that were approved.
    assert.ok(iso(asOf), 'execute needs plan_as_of from the approved dry run');
    assert.ok(IDENTIFIER.test(baselineReleaseId ?? ''), 'execute needs baseline_release_id from the approved dry run');
    asOfMs = Date.parse(asOf);
    assert.ok(asOfMs <= startedAt, 'plan_as_of is in the future');
    assert.ok(startedAt - asOfMs <= policy.maximumPlanAgeHours * HOUR, 'approved plan is older than maximumPlanAgeHours; replan');
  }
  const cutoff = asOfMs - policy.minimumAgeHours * HOUR;
  const pin = await stagingPin(io, policy);
  const listing = await inventory({ io, policy });
  const listed = new Map(listing.releases.map(row => [row.prefix, row]));
  for (const id of new Set([baselineReleaseId, live.releaseId]))
    assert.ok(listed.get(`releases/${id}/`)?.objects > 0, `releases/current.json names ${id} but releases/${id}/ lists no objects: refusing`);

  const rows = [], later = [], outOfScope = [];
  const limit = pool(4);
  await Promise.all(listing.releases.map(entry => limit(async () => {
    const scoped = scopedId(entry.prefix);
    if (!scoped) { outOfScope.push(entry); return; }
    const got = await readManifest(io, policy, entry.prefix);
    let summary;
    if (!got) summary = { status: 'manifest-missing' };
    else if (got.tooLarge) summary = { status: 'manifest-invalid', reason: 'oversized' };
    else summary = summarizeManifest(got.body, scoped.releaseId);
    let status = summary.status;
    if (status === 'manifest-valid') {
      // A complete release lists exactly its manifest's objects plus manifest.json, which the
      // publisher uploads last. Fewer objects only results from an interrupted deletion.
      const expected = summary.objectCount + 1;
      status = entry.objects === expected ? 'complete' : entry.objects < expected ? 'partial' : 'surplus';
    }
    if (status === 'complete' && scoped.releaseId === live.releaseId && asOf === null)
      assert.equal(summary.manifestSha256, live.manifestSha256.toLowerCase(), 'releases/current.json and its manifest disagree: refusing');
    const row = { ...scoped, prefix: entry.prefix, objects: entry.objects, bytes: entry.bytes, newest: entry.newest, status,
      reason: summary.reason ?? null, createdAt: summary.createdAt ?? null, manifestSha256: summary.manifestSha256 ?? null };
    // Anything written or created after asOf did not exist for the approved plan: kept, outside it.
    if (row.newest > asOfMs || (row.createdAt && Date.parse(row.createdAt) > asOfMs)) later.push(row); else rows.push(row);
  })));
  for (const list of [rows, later]) list.sort((a, b) => -byRunDesc(a, b));
  // Humans are in control while the live pointer is not the newest release: a manual rollback is
  // in effect, or a publisher has uploaded a complete release it has not promoted yet. Every
  // release with a valid manifest counts, including ones uploaded after asOf. Uploads still in
  // flight have no manifest yet and do not count.
  const manifested = [...rows, ...later].filter(row => row.createdAt !== null);
  const liveRow = manifested.find(row => row.releaseId === live.releaseId);
  assert.ok(liveRow && liveRow.status === 'complete',
    `releases/current.json names ${live.releaseId}, which is not a complete releases/cycle-<digits>/ release: refusing`);
  const newerByCreated = manifested.filter(row => Date.parse(row.createdAt) > Date.parse(liveRow.createdAt)).map(row => row.releaseId);
  const newerByRun = manifested.filter(row => BigInt(row.runId) > BigInt(liveRow.runId)).map(row => row.releaseId);
  if ((newerByCreated.length || newerByRun.length) && !retried) {
    // A bake may have promoted its release between the pointer read and the listing: read the
    // pointer once more and, if it moved, plan again from the start (once).
    const again = await io.get(policy.dataBucket, policy.releasePointerKey, MAX_POINTER);
    if (hash(again.body) !== hash(liveObject.body))
      return planRetention({ io, policy, now, asOf, baselineReleaseId: asOf === null ? null : baselineReleaseId, retried: true });
  }
  assert.ok(newerByCreated.length === 0 && newerByRun.length === 0,
    `releases/current.json names ${live.releaseId} but ${[...new Set([...newerByCreated, ...newerByRun])].sort().join(', ')} ` +
    'is newer: a manual rollback is in effect or a promotion is pending; refusing (roll forward or wait, then plan again)');
  outOfScope.sort((a, b) => (a.prefix < b.prefix ? -1 : 1));

  const complete = rows.filter(row => row.status === 'complete');
  const byCreated = [...complete].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || byRunDesc(a, b))
    .slice(0, policy.keepNewestReleases).map(row => row.releaseId);
  const byRun = [...complete].sort(byRunDesc).slice(0, policy.keepNewestReleases).map(row => row.releaseId);
  const newest = new Set([...byCreated, ...byRun]);
  for (const row of rows) {
    const reasons = [];
    if (row.releaseId === baselineReleaseId) reasons.push('current');
    if (row.releaseId === live.releaseId) reasons.push('live-current');
    if (pin.releaseId !== null && row.releaseId === pin.releaseId) reasons.push('staging-pin');
    if (policy.keepReleaseIds.includes(row.releaseId)) reasons.push('owner-keep');
    if (newest.has(row.releaseId)) reasons.push('newest');
    if (row.status === 'manifest-missing' || row.status === 'manifest-invalid') reasons.push('incomplete');
    if (row.status === 'surplus') reasons.push('inconsistent');
    if (row.newest > cutoff || (row.createdAt && Date.parse(row.createdAt) > cutoff)) reasons.push('recent');
    row.reasons = reasons;
  }
  const eligible = rows.filter(row => row.reasons.length === 0)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || -byRunDesc(a, b));

  const candidates = [];
  let selectedObjects = 0;
  for (const row of eligible) {
    if (selectedObjects + row.objects > policy.maximumDeletesPerRun) break;
    const keys = (await io.listRows(row.prefix, policy.maximumDeletesPerRun)).sort(byKey);
    assert.equal(keys.length, row.objects, `${row.prefix} changed while planning`);
    assert.ok(keys.every(r => r.key.startsWith(row.prefix) && r.key.length > row.prefix.length && r.key.length <= 1024 &&
      !r.key.slice(row.prefix.length).split('/').some(part => part === '' || part === '.' || part === '..')), `${row.prefix} key shape`);
    candidates.push({ releaseId: row.releaseId, prefix: row.prefix, status: row.status, createdAt: row.createdAt,
      manifestSha256: row.manifestSha256, objectCount: keys.length, bytes: keys.reduce((n, r) => n + r.size, 0),
      newestModified: isoOf(row.newest), keysSha256: listingDigest(keys) });
    selectedObjects += keys.length;
  }
  const sum = (list, field) => list.reduce((n, row) => n + row[field], 0);
  const plan = {
    schemaVersion: 1, kind: PLAN_KIND, policySha256: hash(JSON.stringify(policy)),
    asOf: isoOf(asOfMs), baselineReleaseId, minimumAgeCutoff: isoOf(cutoff), keepNewestReleases: policy.keepNewestReleases,
    keepReleaseIds: [...policy.keepReleaseIds].sort(),
    stagingPin: pin,
    eligible: { releases: eligible.length, objects: sum(eligible, 'objects'), bytes: sum(eligible, 'bytes') },
    candidates,
    totals: { releases: candidates.length, objects: sum(candidates, 'objectCount'), bytes: sum(candidates, 'bytes') },
  };
  const planSha256 = hash(JSON.stringify(plan));

  // Report only: live state moves with every bake, so none of it is inside the approved digest.
  const protectedIds = [...new Set([baselineReleaseId, live.releaseId, pin.releaseId, ...policy.keepReleaseIds, ...newest].filter(Boolean))].sort();
  const held = Object.fromEntries([...HELD_ORDER, 'later', 'outOfScope'].map(key => [key, { releases: 0, objects: 0, bytes: 0 }]));
  const hold = (key, row) => { held[key].releases += 1; held[key].objects += row.objects; held[key].bytes += row.bytes; };
  for (const row of rows) if (row.reasons.length) hold(HELD_ORDER.find(key => row.reasons.includes(key)), row);
  for (const row of later) hold('later', row);
  for (const row of outOfScope) hold('outOfScope', row);
  const total = { prefixes: listing.releases.length, objects: sum(listing.releases, 'objects') + listing.loose.objects,
    bytes: sum(listing.releases, 'bytes') + listing.loose.bytes };
  const report = {
    listedAt: isoOf(startedAt),
    livePointer: { releaseId: live.releaseId, publishedAt: live.publishedAt, sha256: hash(liveObject.body) },
    releasesPrefix: { ...total, looseObjects: listing.loose.objects },
    held,
    kept: [...rows.filter(row => row.reasons.length), ...later.map(row => ({ ...row, reasons: ['later'] }))]
      .map(row => ({ releaseId: row.releaseId, reasons: row.reasons, status: row.status, createdAt: row.createdAt,
        objects: row.objects, bytes: row.bytes, newestModified: row.newest ? isoOf(row.newest) : null })),
    incomplete: [...rows, ...later].filter(row => !['complete', 'partial'].includes(row.status))
      .map(row => ({ releaseId: row.releaseId, status: row.status, reason: row.reason, objects: row.objects, bytes: row.bytes })),
    partial: rows.filter(row => row.status === 'partial').map(row => row.releaseId),
    outOfScope: outOfScope.map(row => ({ prefix: row.prefix, objects: row.objects, bytes: row.bytes })),
    order: { newestByCreatedAt: byCreated, newestByRunId: byRun,
      agree: byCreated.length === byRun.length && byCreated.every(id => byRun.includes(id)) },
    protected: await proveProtected({ io, policy, ids: protectedIds }),
    afterThisRun: { objects: total.objects - plan.totals.objects, bytes: total.bytes - plan.totals.bytes },
    afterAllEligible: { objects: total.objects - plan.eligible.objects, bytes: total.bytes - plan.eligible.bytes },
  };
  return { ...plan, planSha256, report };
}

// --- execution --------------------------------------------------------------------------------

// Execution never trusts a plan file: it recomputes the plan at the approved asOf and baseline and
// requires its SHA-256 to equal the approved one. Before every delete it re-reads the release
// pointer (stop if it names a candidate) and the staging pin (stop on any change).
export async function executeRetention({ io, policy, approvedPlanSha256, asOf, baselineReleaseId, deleteForPrefix, now = Date.now }) {
  validatePolicy(policy);
  assert.match(approvedPlanSha256 ?? '', SHA, 'PRODUCTION_RELEASES_GC_APPROVED_PLAN_SHA256 is not set');
  assert.ok(iso(asOf ?? ''), 'execute needs plan_as_of from the approved dry run');
  assert.ok(IDENTIFIER.test(baselineReleaseId ?? ''), 'execute needs baseline_release_id from the approved dry run');
  const replay = await planRetention({ io, policy, now, asOf, baselineReleaseId });
  const { planSha256, report, ...content } = replay;
  assert.equal(planSha256, hash(JSON.stringify(content)));
  assert.equal(planSha256, approvedPlanSha256, 'production release retention plan differs from the approved plan; replan and approve again');
  assert.equal(content.kind, PLAN_KIND);
  assert.ok(content.totals.objects <= policy.maximumDeletesPerRun, 'retention delete budget exceeded');
  assert.ok(content.candidates.every(row => scopedRelease(row.prefix) && row.prefix === `releases/${row.releaseId}/`));
  const candidates = new Set(content.candidates.map(row => row.releaseId));
  assert.ok(!candidates.has(report.livePointer.releaseId), 'releases/current.json names a candidate; stopping');
  assert.ok(report.protected.every(row => !candidates.has(row.releaseId)));
  let aborted = null, deleted = 0;
  const emptied = [];
  async function guard() {
    const [pointerObject, pin] = await Promise.all([
      io.get(policy.dataBucket, policy.releasePointerKey, MAX_POINTER), stagingPin(io, policy)]);
    assert.deepEqual(pin, content.stagingPin, 'staging shared-read pin changed after the dry run; replan');
    const pointer = parsePointer(pointerObject.body);
    assert.ok(!candidates.has(pointer.releaseId), `releases/current.json now names candidate ${pointer.releaseId}; stopping`);
  }
  const limit = pool(policy.deleteConcurrency);
  for (const candidate of content.candidates) {
    const rows = (await io.listRows(candidate.prefix, policy.maximumDeletesPerRun + 1)).sort(byKey);
    assert.ok(rows.length <= candidate.objectCount,
      `${candidate.prefix} grew from ${candidate.objectCount} to ${rows.length} objects since the dry run; replan`);
    assert.equal(listingDigest(rows), candidate.keysSha256, `${candidate.prefix} changed since the dry run; replan`);
    // The manifest goes last so an interrupted release still names itself (a later plan sees it as
    // `partial` and finishes it).
    const manifest = `${candidate.prefix}manifest.json`;
    const keys = rows.map(row => row.key);
    const ordered = [...keys.filter(key => key !== manifest), ...keys.filter(key => key === manifest)];
    // Temporary credentials live 15 minutes: mint one per release and again after 10 minutes.
    const clients = [];
    let current = null, mintedAt = 0;
    const clientFor = () => {
      if (!current || now() - mintedAt > 600_000) {
        mintedAt = now(); current = Promise.resolve(deleteForPrefix(candidate.prefix)); clients.push(current);
      }
      return current;
    };
    try {
      for (const batch of [ordered.filter(key => key !== manifest), ordered.filter(key => key === manifest)]) {
        await Promise.all(batch.map(key => limit(async () => {
          if (aborted) return;
          try {
            assert.ok(key.startsWith(candidate.prefix) && key.length > candidate.prefix.length && key !== policy.releasePointerKey);
            await guard();
            if (aborted) return;
            await (await clientFor()).delete(key);
            deleted += 1;
          } catch (error) { aborted ??= error; }
        })));
        if (aborted) throw Object.assign(new Error(`${aborted.message} (this run sent ${deleted} delete requests before stopping)`), { deleted });
      }
    } finally { for (const client of clients) (await client.catch(() => null))?.close?.(); }
    // Nothing may have been written back meanwhile (for example a re-run of the old bake).
    const left = await io.listRows(candidate.prefix, policy.maximumDeletesPerRun);
    assert.equal(left.length, 0, `${candidate.prefix} still lists ${left.length} objects after its deletion: something wrote into it; stopping`);
    emptied.push(candidate.releaseId);
  }
  // After: the pointer was never written by this run, and every protected release lists exactly
  // what it listed before the first delete, with every manifest path present.
  const pointerAfter = hash((await io.get(policy.dataBucket, policy.releasePointerKey, MAX_POINTER)).body);
  const after = await proveProtected({ io, policy, ids: report.protected.map(row => row.releaseId) });
  const proof = after.map((row, i) => ({ ...row, unchanged: JSON.stringify(row) === JSON.stringify(report.protected[i]) }));
  const changed = proof.filter(row => !row.unchanged).map(row => row.releaseId);
  assert.deepEqual(changed, [], `protected release listing changed during cleanup: ${changed.join(', ')}`);
  return { status: 'deleted-unreferenced-production-releases', planSha256, asOf: content.asOf, baselineReleaseId: content.baselineReleaseId,
    // A concurrent execution of the same plan sends the same requests, and R2 answers 204 either
    // way, so this run reports what it sent and what now lists empty, never a share of the bytes.
    releases: content.candidates.length, deleteRequestsByThisRun: deleted, releasesConfirmedEmpty: emptied.length,
    plannedObjects: content.totals.objects, plannedBytes: content.totals.bytes,
    proof: { pointerBeforeSha256: report.livePointer.sha256, pointerAfterSha256: pointerAfter,
      pointerChangedByAPromotion: pointerAfter !== report.livePointer.sha256, protected: proof } };
}

// --- R2 adapter -------------------------------------------------------------------------------
function base64url(value) { return Buffer.from(value).toString('base64url'); }
export function scopedDeleteCredentials(parent, prefix, policy, nowSeconds = Math.floor(Date.now() / 1000)) {
  assert.match(parent.accessKeyId ?? '', /^[A-Za-z0-9]{10,128}$/);
  assert.ok(typeof parent.secretAccessKey === 'string' && parent.secretAccessKey.length >= 32);
  assert.ok(scopedRelease(prefix), 'delete credential scope must be one releases/cycle-<digits>/ prefix');
  assert.ok(Number.isSafeInteger(nowSeconds) && nowSeconds > 0);
  const endpoint = `https://${policy.accountId}.r2.cloudflarestorage.com`;
  const claims = { bucket: policy.dataBucket, actions: ['DeleteObject'],
    paths: { prefixPaths: [prefix], objectPaths: [] }, sub: policy.accountId, iss: parent.accessKeyId,
    aud: new URL(endpoint).host, iat: nowSeconds, exp: nowSeconds + 900 };
  const unsigned = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  const jwt = `${unsigned}.${createHmac('sha256', parent.secretAccessKey).update(unsigned).digest('base64url')}`;
  return { accessKeyId: parent.accessKeyId, secretAccessKey: createHash('sha256').update(jwt).digest('hex'),
    sessionToken: Buffer.from(`jwt/${jwt}`).toString('base64') };
}

export async function createRetentionIo(env, policy, injectedSdk, injectedReadClient, injectedDeleteClientFactory) {
  validatePolicy(policy);
  assert.equal(env.PRODUCTION_RELEASES_R2_ACCOUNT_ID, policy.accountId);
  assert.ok(env.PRODUCTION_RELEASES_GC_READ_ACCESS_KEY_ID && env.PRODUCTION_RELEASES_GC_READ_SECRET_ACCESS_KEY);
  for (const key of FORBIDDEN) assert.ok(!env[key], `retention refuses ${key}`);
  for (const key of Object.keys(env)) assert.ok(!FORBIDDEN_PREFIXES.some(prefix => key.startsWith(prefix)) || !env[key], `retention refuses ${key}`);
  const endpoint = `https://${policy.accountId}.r2.cloudflarestorage.com`;
  const sdk = injectedSdk ?? await import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
  const readClient = injectedReadClient ?? new sdk.S3Client({ region: 'auto', endpoint, forcePathStyle: true, maxAttempts: 3,
    credentials: { accessKeyId: env.PRODUCTION_RELEASES_GC_READ_ACCESS_KEY_ID,
      secretAccessKey: env.PRODUCTION_RELEASES_GC_READ_SECRET_ACCESS_KEY } });
  const send = command => readClient.send(command, { abortSignal: AbortSignal.timeout(120_000) });
  const readable = (bucket, key) =>
    (bucket === policy.dataBucket && (key === policy.releasePointerKey || /^releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/manifest\.json$/.test(key))) ||
    (bucket === policy.stagingControlBucket && key === policy.stagingPinKey);
  async function get(bucket, key, maximum) {
    assert.ok(readable(bucket, key), `retention may not read ${bucket}/${key}`);
    const response = await send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!(response.ContentLength <= maximum)) {
      response.Body?.destroy?.();
      throw Object.assign(new Error(`${bucket}/${key} exceeds ${maximum} bytes`), { name: 'ObjectTooLarge' });
    }
    assert.ok(response.ContentLength > 0);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.Body) { bytes += chunk.length; assert.ok(bytes <= response.ContentLength); chunks.push(Buffer.from(chunk)); }
    assert.equal(bytes, response.ContentLength);
    return { body: Buffer.concat(chunks), metadata: response.Metadata ?? {} };
  }
  async function getOptional(bucket, key, maximum) {
    try { return await get(bucket, key, maximum); }
    catch (error) { if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null; throw error; }
  }
  async function pages(input, onPage) {
    const tokens = new Set(); let token;
    do {
      const page = await send(new sdk.ListObjectsV2Command({ Bucket: policy.dataBucket, MaxKeys: 1000, ...input,
        ...(token ? { ContinuationToken: token } : {}) }));
      onPage(page);
      token = page.NextContinuationToken;
      if (token) { assert.ok(!tokens.has(token), 'listing repeated a continuation token'); tokens.add(token); }
      assert.equal(Boolean(token), Boolean(page.IsTruncated), 'listing truncation and continuation token disagree');
    } while (token);
  }
  async function listPrefixes(prefix) {
    assert.equal(prefix, RELEASES, `retention may not list ${prefix}`);
    const prefixes = [], rows = [];
    await pages({ Prefix: prefix, Delimiter: '/' }, page => {
      for (const row of page.CommonPrefixes ?? []) prefixes.push(row.Prefix);
      for (const row of page.Contents ?? []) rows.push({ key: row.Key, size: row.Size });
    });
    return { prefixes, rows };
  }
  async function list(prefix, onRow) {
    assert.ok(RELEASE_PREFIX.test(prefix), `retention may not list ${prefix}`);
    await pages({ Prefix: prefix }, page => {
      for (const row of page.Contents ?? []) {
        assert.ok(row.Key.startsWith(prefix));
        onRow({ key: row.Key, size: row.Size, lastModified: new Date(row.LastModified).valueOf(), etag: row.ETag ?? null });
      }
    });
  }
  async function listRows(prefix, maximum) {
    const rows = [];
    await list(prefix, row => { rows.push(row); assert.ok(rows.length <= maximum, `${prefix} lists more than ${maximum} objects`); });
    return rows;
  }
  async function deleteForPrefix(prefix) {
    assert.ok(scopedRelease(prefix), `retention may not delete under ${prefix}`);
    assert.ok(env.PRODUCTION_RELEASES_GC_DELETE_ACCESS_KEY_ID && env.PRODUCTION_RELEASES_GC_DELETE_SECRET_ACCESS_KEY);
    assert.notEqual(env.PRODUCTION_RELEASES_GC_DELETE_ACCESS_KEY_ID, env.PRODUCTION_RELEASES_GC_READ_ACCESS_KEY_ID, 'delete and read tokens must differ');
    const credentials = scopedDeleteCredentials({ accessKeyId: env.PRODUCTION_RELEASES_GC_DELETE_ACCESS_KEY_ID,
      secretAccessKey: env.PRODUCTION_RELEASES_GC_DELETE_SECRET_ACCESS_KEY }, prefix, policy);
    const client = injectedDeleteClientFactory?.(credentials) ?? new sdk.S3Client({ region: 'auto', endpoint,
      forcePathStyle: true, maxAttempts: 3, credentials });
    return { async delete(key) {
      assert.ok(key.startsWith(prefix) && key.length > prefix.length && key !== policy.releasePointerKey);
      await client.send(new sdk.DeleteObjectCommand({ Bucket: policy.dataBucket, Key: key }),
        { abortSignal: AbortSignal.timeout(120_000) });
    }, close: () => client.destroy?.() };
  }
  return { get, getOptional, listPrefixes, list, listRows, deleteForPrefix, close: () => readClient.destroy?.() };
}

export function planSummary(plan) {
  const gb = n => `${(n / 1e9).toFixed(1)} GB`;
  const n = value => value.toLocaleString('en-US');
  const held = Object.entries(plan.report.held).filter(([, v]) => v.releases > 0)
    .map(([key, v]) => `${key} ${v.releases} (${n(v.objects)} objects / ${gb(v.bytes)})`).join(', ');
  const lines = [`## Production whole-release retention plan`, '',
    `planSha256 \`${plan.planSha256}\` · plan_as_of \`${plan.asOf}\` · baseline_release_id \`${plan.baselineReleaseId}\``, '',
    `- Releases under \`releases/\`: ${plan.report.releasesPrefix.prefixes} prefixes, ${n(plan.report.releasesPrefix.objects)} objects, ${gb(plan.report.releasesPrefix.bytes)}.`,
    `- Kept: newest ${plan.keepNewestReleases} complete releases (by createdAt ${plan.report.order.agree ? 'and run id agree' : 'and run id DISAGREE; both kept'}), anything newer than ${plan.minimumAgeCutoff}, the current release, the staging pin (${plan.stagingPin.releaseId ?? 'none'}) and the owner's keepReleaseIds (${plan.keepReleaseIds.join(', ') || 'none'}).`,
    `- Held by first reason: ${held || 'nothing'}.`,
    `- Eligible: ${plan.eligible.releases} releases, ${n(plan.eligible.objects)} objects, ${gb(plan.eligible.bytes)}.`,
    `- This run deletes: ${plan.totals.releases} releases, ${n(plan.totals.objects)} objects, ${gb(plan.totals.bytes)}` +
      (plan.candidates.length ? ` (${plan.candidates[0].releaseId} … ${plan.candidates[plan.candidates.length - 1].releaseId}).` : '.'),
    `- After this run: ${n(plan.report.afterThisRun.objects)} objects / ${gb(plan.report.afterThisRun.bytes)} under \`releases/\`; after all eligible: ${n(plan.report.afterAllEligible.objects)} / ${gb(plan.report.afterAllEligible.bytes)}.`,
    `- Protected and proven whole (every manifest path listed): ${plan.report.protected.filter(row => row.present && row.manifestCovered).map(row => `\`${row.releaseId}\``).join(', ') || 'none'}.`];
  const absent = plan.report.protected.filter(row => !row.present || !row.manifestCovered);
  if (absent.length) lines.push(`- WARNING protected but not whole or absent: ${absent.map(row => row.releaseId).join(', ')}.`);
  if (plan.report.incomplete.length)
    lines.push(`- Incomplete or inconsistent, kept and reported: ${plan.report.incomplete.map(row => `${row.releaseId} (${row.status}, ${n(row.objects)} objects)`).join(', ')}.`);
  if (plan.report.partial.length) lines.push(`- Partially deleted by an earlier run: ${plan.report.partial.join(', ')}.`);
  if (plan.report.outOfScope.length) lines.push(`- Out of scope (not cycle-<digits>): ${plan.report.outOfScope.map(row => row.prefix).join(', ')}.`);
  return `${lines.join('\n')}\n`;
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
    assert.equal(env.GITHUB_WORKFLOW_REF, 'Andrewegao/v3t7kq-cycle/.github/workflows/production-releases-retention.yml@refs/heads/main');
    assert.equal(env.GITHUB_JOB, 'retention');
    assert.equal(env.RELEASES_GC_ENVIRONMENT, 'production-releases-retention');
    assert.equal(env.PRODUCTION_RELEASES_GC_ENABLED, 'true');
    assert.equal(env.PRODUCTION_RELEASES_GC_CONTROLLER_SHA256, controllerDigest());
    if (command === 'execute') assert.equal(env.PRODUCTION_RELEASES_GC_EXECUTE_ENABLED, 'true');
    else assert.ok(!env.PRODUCTION_RELEASES_GC_DELETE_ACCESS_KEY_ID && !env.PRODUCTION_RELEASES_GC_DELETE_SECRET_ACCESS_KEY,
      'the dry run never holds the delete token');
    const policy = readPolicy();
    const io = await createRetentionIo(env, policy);
    try {
      if (command === 'dry-run') {
        process.stdout.write(`${JSON.stringify(await planRetention({ io, policy }))}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(await executeRetention({ io, policy, deleteForPrefix: io.deleteForPrefix,
          asOf: env.INPUT_PLAN_AS_OF ?? '', baselineReleaseId: env.INPUT_BASELINE_RELEASE_ID ?? '',
          approvedPlanSha256: env.PRODUCTION_RELEASES_GC_APPROVED_PLAN_SHA256 }))}\n`);
      }
    } finally { io.close(); }
  } catch (error) { console.error(`Production release retention refused: ${error.message}`); process.exitCode = 1; }
}
