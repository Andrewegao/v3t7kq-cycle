// Target-generic Wind100 retention: one read-only planner and one verified executor shared by
// production and staging. A target (production-wind100-retention.mjs, staging-wind100-retention.mjs)
// supplies its buckets, key names, pointer and journal validators and selection checks. This
// module imports only Node built-ins, so it cannot take part in an import cycle.
//
// Two classes of component prefix can be deleted:
// - retired: an entry that left the pointer in a verified journal transition, past 18 hours of
//   grace after its freshUntil, with its selection, catalog and inventory verified;
// - orphan (inline reclaim only, `orphans: true`): a never-activated upload. It is referenced by
//   no entry of the live pointer or of any pointer body in the verified journal window, by no
//   component of a catalog any such entry still inside its grace names, its newest object is at
//   least 48 hours (30-hour forecast lease + 18 hours of grace) old, and any selection written for
//   it is past its own freshUntil + grace. docs/production-wind100-retention.md gives the argument.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

export const GRACE_MS = 18 * 3_600_000;
export const LEASE_MS = 30 * 3_600_000;
// No object in an orphan prefix may be newer than this. Every forecast's freshUntil is at most
// 30 hours after its initialization and every upload follows its initialization, so this age
// also puts any selection for the prefix past freshUntil + grace, the retired-class standard.
export const ORPHAN_MIN_AGE_MS = LEASE_MS + GRACE_MS;
// Hard per-run delete bound: two full recurring prefixes (2 x 4,141 objects) fit.
export const MAX_DELETES = 10_000;
export const DEFAULT_CANDIDATES = 2;
export const DEFAULT_ORPHANS = 2;
// The whole recurring namespace is capped at this many objects by the capacity check.
export const MAX_NAMESPACE_OBJECTS = 50_000;
const MAX_CANDIDATES = 8;
const MAX_ORPHANS = 8;
const MAX_OBJECTS = 10_000;
const MAX_JSON = 512 * 1024;
const MAX_POINTER = 16 * 1024;
const MAX_JOURNALS = 64;
// A scoped delete credential covers at most this many keys of one prefix.
export const CREDENTIAL_KEYS = 250;
const MAX_CONCURRENCY = 16;
// Inline reclaim re-verifies the live pointer once per credential window and runs that window's
// deletes eight at a time. Two serial round trips per key (pointer re-read, then delete) took
// about 0.3 s per object, so a two-prefix plan (8,282 keys) needed ~41 minutes and was killed
// by the 30-minute step bound every run (bake run 39181515197). The approved manual lane keeps
// the executor defaults: a pointer check before every key and one delete at a time.
export const INLINE_RECLAIM = Object.freeze({ batchSize: CREDENTIAL_KEYS, concurrency: 8 });
const SHA = /^[a-f0-9]{64}$/;
const KEY_TAIL = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function parseObject(object, maximum) {
  assert.ok(object && Buffer.isBuffer(object.body) && object.body.length > 0
    && object.body.length <= maximum);
  return JSON.parse(object.body);
}

export function prefixForCatalogId(target, catalogId) {
  assert.ok(catalogId.startsWith(target.catalogIdPrefix));
  return `${target.componentPrefix}${catalogId.slice(target.catalogIdPrefix.length)}/`;
}

export function catalogIdForPrefix(target, prefix) {
  assert.match(prefix, target.prefixPattern);
  return `${target.catalogIdPrefix}${prefix.slice(target.componentPrefix.length, -1)}`;
}

function assertInventory(keys, prefix, maximum) {
  assert.ok(Array.isArray(keys) && keys.length > 0 && keys.length <= maximum);
  assert.equal(keys.length, new Set(keys).size);
  for (const key of keys) {
    assert.ok(key.startsWith(prefix) && key.length > prefix.length && key.length <= 512);
    assert.match(key.slice(prefix.length), KEY_TAIL);
    assert.ok(!key.split('/').includes('..'));
  }
}

// A selection for an orphan prefix proves only that publication got that far. It is accepted as
// expired evidence when it is the target's selection kind, names this prefix's catalog, was never
// activated and its forecast left its lease and grace before `now`.
function assertExpiredSelection(target, selected, catalogId, now) {
  assert.ok(selected && typeof selected === 'object' && !Array.isArray(selected));
  assert.equal(selected.kind, target.selectionKind);
  assert.equal(selected.catalogId, catalogId);
  assert.equal(selected.activated, false);
  const initializedAt = Date.parse(selected.initializedAt), freshUntil = Date.parse(selected.freshUntil);
  assert.ok(Number.isFinite(initializedAt) && Number.isFinite(freshUntil));
  assert.ok(freshUntil > initializedAt && freshUntil <= initializedAt + LEASE_MS);
  assert.ok(freshUntil + GRACE_MS <= now);
}

export async function planRetention({ target, io, catalogValidator, now = Date.now,
  maximumCandidates = DEFAULT_CANDIDATES, maximumObjects = MAX_DELETES, policy = target.readPolicy(),
  orphans = false, maximumOrphans = DEFAULT_ORPHANS }) {
  assert.equal(typeof catalogValidator, 'function');
  assert.ok(Number.isSafeInteger(maximumCandidates) && maximumCandidates > 0
    && maximumCandidates <= MAX_CANDIDATES);
  assert.ok(Number.isSafeInteger(maximumObjects) && maximumObjects > 0 && maximumObjects <= MAX_DELETES);
  assert.equal(typeof orphans, 'boolean');
  if (orphans) assert.ok(Number.isSafeInteger(maximumOrphans) && maximumOrphans > 0 && maximumOrphans <= MAX_ORPHANS);
  const { dataBucket } = target;
  const currentObject = await io.get(dataBucket, target.pointerKey, MAX_POINTER);
  const current = target.validatePointer(parseObject(currentObject, MAX_POINTER), now(), policy);
  const currentSha256 = hash(currentObject.body);
  const protectedIds = new Set(current.entries.map(row => row.catalogId));
  // Every entry of the live pointer and of every pointer body inside the verified window.
  const referenced = new Map(current.entries.map(row => [row.catalogId, row]));
  const retired = new Map(), visited = new Set();
  let body = currentObject.body, reachedGenesis = false, reachedJournalStart = false;
  for (let depth = 0; depth < MAX_JOURNALS; depth++) {
    const digest = hash(body);
    assert.ok(!visited.has(digest), 'pointer journal ancestry cycle');
    visited.add(digest);
    // Staging only: a live pointer written before staging journals has no record yet. Nothing is
    // journal-proven retired then, but the live entries stay protected and the orphan rules, which
    // do not rely on the journal, still apply, so the first run after deployment is not stuck at
    // the cap. Any record missing behind a journaled one still aborts the plan.
    const journalObject = target.journalStart && depth === 0
      ? await io.getIfPresent(dataBucket, target.journalKeyFor(digest), MAX_JSON)
      : await io.get(dataBucket, target.journalKeyFor(digest), MAX_JSON);
    if (journalObject == null && target.journalStart && depth === 0) {
      visited.delete(digest); reachedJournalStart = true; break;
    }
    const journal = parseObject(journalObject, MAX_JSON);
    const chain = target.validateJournal(journal, body, now(), policy);
    for (const entry of chain.previous?.entries ?? []) {
      if (!referenced.has(entry.catalogId)) referenced.set(entry.catalogId, entry);
      if (!chain.current.entries.some(row => row.catalogId === entry.catalogId)
        && !protectedIds.has(entry.catalogId) && target.ownsCatalogId(entry.catalogId)) retired.set(entry.catalogId, entry);
    }
    if (!chain.previousBody) { reachedGenesis = true; break; }
    // Staging only: the first journaled transition after journaling began records that its
    // previous pointer has no journal. Its own transition is verified; history stops there.
    if (chain.journalStart) { reachedJournalStart = true; break; }
    body = chain.previousBody;
  }
  // A contiguous, bounded suffix proves its retired entries even when older history is retained.
  assert.ok(visited.size > 0 || reachedJournalStart);
  // The walk saw newest transitions first; reclaim the oldest retirement first so a prefix is
  // collected before it leaves the bounded ancestry window. Pointer and journal integrity
  // failures above abort the plan; a single retired entry that fails its own evidence below is
  // refused (never deleted) and planning continues, so one bad entry cannot block every run.
  const candidates = [], skippedEmptyCatalogIds = [], refusedCatalogIds = [], refusalReasons = {};
  let totalObjects = 0;
  for (const entry of [...retired.values()].reverse()) {
    if (candidates.length >= maximumCandidates) break;
    if (Date.parse(entry.freshUntil) + GRACE_MS > now()) continue;
    const prefix = prefixForCatalogId(target, entry.catalogId);
    let keys, stage = 'inventory-unavailable';
    try {
      keys = await io.listPrefix(prefix, MAX_OBJECTS);
      assert.ok(Array.isArray(keys));
      // An already emptied prefix (an earlier run finished it) is progress, not a candidate.
      if (keys.length === 0) { skippedEmptyCatalogIds.push(entry.catalogId); continue; }
      stage = 'selection-unavailable';
      const selectedObject = await io.get(dataBucket, target.selectionKey(entry.catalogId), MAX_JSON);
      const selected = parseObject(selectedObject, MAX_JSON);
      stage = 'selection-mismatch';
      assert.equal(hash(selectedObject.body), entry.selectionSha256);
      target.verifySelection(selected, entry, policy);
      stage = 'catalog-unavailable';
      const catalogObject = await io.get(dataBucket, target.catalogKey(entry.catalogId), MAX_JSON);
      const catalog = parseObject(catalogObject, MAX_JSON);
      stage = 'catalog-mismatch';
      assert.equal(hash(catalogObject.body), entry.catalogSha256);
      stage = 'catalog-rejected';
      assert.equal(catalogValidator(catalog), true);
      stage = 'component-mismatch';
      assert.deepEqual(Object.keys(catalog.components), ['point-ecmwf']);
      const component = catalog.components['point-ecmwf'];
      assert.equal(component.rootPrefix, prefix);
      assert.equal(component.manifestKey, `${prefix}component.json`);
      assert.equal(component.pointSeries?.descriptor?.runId, entry.runId);
      assert.equal(component.pointSeries?.descriptor?.freshUntil, entry.freshUntil);
      assert.ok(Number.isSafeInteger(component.objectCount) && component.objectCount > 0
        && component.objectCount < MAX_OBJECTS);
      target.verifyCatalog?.(selected, catalog);
      stage = 'inventory-mismatch';
      assertInventory(keys, prefix, component.objectCount + 1);
    } catch {
      // The reason is a stable stage code, so a dry run and its recomputation hash identically.
      refusedCatalogIds.push(entry.catalogId); refusalReasons[entry.catalogId] = stage;
      continue;
    }
    // A prefix that would overrun the run's delete budget waits for the next run.
    if (totalObjects + keys.length > maximumObjects) break;
    totalObjects += keys.length;
    candidates.push({ catalogId: entry.catalogId, runId: entry.runId,
      freshUntil: entry.freshUntil, prefix, keys: keys.sort() });
  }
  const orphanPlan = orphans ? await planOrphans({ target, io, now, referenced, retired,
    maximumOrphans, remainingObjects: maximumObjects - totalObjects }) : null;
  if (orphanPlan) totalObjects += orphanPlan.objects;
  // Fields appear in this order so a plan without orphans or a journal start (the production
  // manual lane) is byte for byte the #440 plan and keeps its planSha256.
  const plan = { schemaVersion: 2, kind: target.planKind,
    pointerSha256: currentSha256, protectedCatalogIds: [...protectedIds].sort(),
    ancestryRecordsChecked: visited.size, reachedGenesis,
    ...(target.journalStart ? { reachedJournalStart } : {}),
    maximumCandidates, maximumObjects,
    skippedEmptyCatalogIds, refusedCatalogIds, refusalReasons, candidates,
    ...(orphanPlan ? { maximumOrphans, orphanInventory: orphanPlan.inventory,
      orphanRefusals: orphanPlan.refusals, orphanCandidates: orphanPlan.candidates } : {}),
    totalObjects };
  assert.ok(plan.totalObjects <= MAX_OBJECTS && plan.totalObjects <= maximumObjects);
  assert.ok(candidates.every(row => !refusedCatalogIds.includes(row.catalogId)));
  for (const row of orphanPlan?.candidates ?? []) {
    assert.ok(!referenced.has(row.catalogId) && !retired.has(row.catalogId) && !protectedIds.has(row.catalogId));
  }
  return { ...plan, planSha256: hash(JSON.stringify(plan)) };
}

// Never-activated uploads. Any failure to prove the reference set or read the namespace skips
// the whole orphan pass with a stable code (retired reclaim is unaffected); a single prefix whose
// selection or inventory cannot be proven is refused with a stable code and kept.
async function planOrphans({ target, io, now, referenced, retired, maximumOrphans, remainingObjects }) {
  const result = { inventory: 'listed', refusals: {}, candidates: [], objects: 0 };
  const referencedPrefixes = new Set();
  try {
    for (const entry of referenced.values()) {
      if (target.ownsCatalogId(entry.catalogId)) referencedPrefixes.add(prefixForCatalogId(target, entry.catalogId));
      // An entry still inside its grace may be served from a cached pointer: every component
      // prefix its hash-verified catalog names is referenced too, whatever its name.
      if (Date.parse(entry.freshUntil) + GRACE_MS <= now()) continue;
      const catalogObject = await io.get(target.dataBucket, target.catalogKey(entry.catalogId), MAX_JSON);
      const catalog = parseObject(catalogObject, MAX_JSON);
      assert.equal(hash(catalogObject.body), entry.catalogSha256);
      assert.ok(catalog.components && typeof catalog.components === 'object');
      for (const component of Object.values(catalog.components)) {
        assert.equal(typeof component?.rootPrefix, 'string');
        referencedPrefixes.add(component.rootPrefix);
      }
    }
  } catch {
    result.inventory = 'referenced-catalog-unavailable';
    return result;
  }
  let rows;
  try {
    rows = await io.listNamespace(MAX_NAMESPACE_OBJECTS);
    assert.ok(Array.isArray(rows) && rows.length <= MAX_NAMESPACE_OBJECTS);
  } catch {
    result.inventory = 'unavailable';
    return result;
  }
  const groups = new Map();
  try {
    for (const row of rows) {
      assert.ok(typeof row?.key === 'string' && row.key.startsWith(target.componentPrefix));
      const end = row.key.indexOf('/', target.componentPrefix.length);
      assert.ok(end > target.componentPrefix.length);
      const prefix = row.key.slice(0, end + 1);
      assert.match(prefix, target.prefixPattern);
      const modified = Date.parse(row.lastModified);
      assert.ok(Number.isFinite(modified) && new Date(modified).toISOString() === row.lastModified);
      const group = groups.get(prefix) ?? { keys: [], newest: -Infinity };
      group.keys.push(row.key); group.newest = Math.max(group.newest, modified);
      groups.set(prefix, group);
    }
  } catch {
    result.inventory = 'invalid';
    return result;
  }
  // Oldest uploads first, so a stuck orphan cannot starve older ones.
  const ordered = [...groups].sort(([a, left], [b, right]) => left.newest - right.newest || (a < b ? -1 : 1));
  for (const [prefix, group] of ordered) {
    if (result.candidates.length >= maximumOrphans) break;
    const catalogId = catalogIdForPrefix(target, prefix);
    if (referenced.has(catalogId) || retired.has(catalogId) || referencedPrefixes.has(prefix)) continue;
    // Too young to rule out a live upload or a pending activation: not refused, just not yet.
    if (group.newest + ORPHAN_MIN_AGE_MS > now()) continue;
    let stage = 'orphan-selection-unavailable', selection = 'absent';
    try {
      const selectedObject = await io.getIfPresent(target.dataBucket, target.selectionKey(catalogId), MAX_JSON);
      if (selectedObject != null) {
        stage = 'orphan-selection-mismatch';
        assertExpiredSelection(target, parseObject(selectedObject, MAX_JSON), catalogId, now());
        selection = 'expired';
      }
      stage = 'orphan-inventory-mismatch';
      assertInventory(group.keys, prefix, MAX_OBJECTS);
    } catch {
      result.refusals[catalogId] = stage;
      continue;
    }
    if (result.objects + group.keys.length > remainingObjects) break;
    result.objects += group.keys.length;
    result.candidates.push({ catalogId, prefix, newestObjectAt: new Date(group.newest).toISOString(),
      selection, keys: group.keys.sort() });
  }
  return result;
}

// Shared by the approved manual execution and the recurring inline reclaim. The plan is
// recomputed from live state and must match byte for byte. Keys are deleted in batches inside
// one credential window: before each batch the live pointer is re-read and must still hash to
// the plan's pointer and exclude the candidate; a retired candidate must still be past grace and
// an orphan still past its minimum age. Within a batch at most `concurrency` deletes are in
// flight; the first failure stops further dispatch, lets in-flight deletes settle and is
// rethrown (no retries). Once `clock()` reaches `deadline` no further delete is dispatched and
// the partial count is returned. `onProgress` gets one line per batch.
export async function executeVerifiedPlan({ target, plan, io, deleteForPrefix, catalogValidator, now, maximumDeletes,
  policy, batchSize = 1, concurrency = 1, deadline = Infinity, clock = Date.now, onProgress = () => {} }) {
  assert.ok(Number.isSafeInteger(maximumDeletes) && maximumDeletes > 0 && maximumDeletes <= MAX_DELETES);
  assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0 && CREDENTIAL_KEYS % batchSize === 0);
  assert.ok(Number.isSafeInteger(concurrency) && concurrency > 0 && concurrency <= MAX_CONCURRENCY);
  assert.ok(typeof deadline === 'number' && !Number.isNaN(deadline));
  assert.equal(typeof clock, 'function'); assert.equal(typeof onProgress, 'function');
  const { planSha256, ...content } = plan;
  assert.equal(planSha256, hash(JSON.stringify(content)));
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.kind, target.planKind);
  const orphans = Object.hasOwn(plan, 'orphanCandidates');
  assert.deepEqual(plan, await planRetention({ target, io, catalogValidator, now,
    maximumCandidates: plan.maximumCandidates, maximumObjects: plan.maximumObjects, policy,
    ...(orphans ? { orphans: true, maximumOrphans: plan.maximumOrphans } : {}) }),
  `${target.name} retention plan changed since approval`);
  assert.match(plan.pointerSha256, SHA);
  assert.ok(Array.isArray(plan.candidates) && plan.candidates.length <= MAX_CANDIDATES);
  assert.ok(Array.isArray(plan.protectedCatalogIds) && plan.protectedCatalogIds.length <= 2);
  const orphanCandidates = orphans ? plan.orphanCandidates : [];
  assert.ok(Array.isArray(orphanCandidates) && orphanCandidates.length <= MAX_ORPHANS);
  assert.equal(plan.totalObjects, [...plan.candidates, ...orphanCandidates].reduce((n, row) => n + row.keys.length, 0));
  assert.ok(plan.totalObjects <= maximumDeletes, 'retention delete budget exceeded');
  let deleted = 0;
  const report = note => onProgress(`reclaim progress: deleted ${deleted} of ${plan.totalObjects}`
    + (note ? `; ${note}` : ''));
  const outOfTime = () => clock() >= deadline;
  const budgetStop = () => {
    report(`wall-clock budget reached; ${plan.totalObjects - deleted} left for the next run`);
    return { deleted, complete: false };
  };
  report();
  const units = [...plan.candidates.map(row => ({ row, orphan: false })),
    ...orphanCandidates.map(row => ({ row, orphan: true }))];
  for (const { row: candidate, orphan } of units) {
    assert.ok(!plan.protectedCatalogIds.includes(candidate.catalogId));
    assert.match(candidate.prefix, target.prefixPattern);
    assert.equal(candidate.prefix, prefixForCatalogId(target, candidate.catalogId));
    let client;
    try {
      for (let start = 0; start < candidate.keys.length; start += batchSize) {
        if (outOfTime()) return budgetStop();
        if (start % CREDENTIAL_KEYS === 0) {
          client?.close?.();
          client = await deleteForPrefix(candidate.prefix);
        }
        const liveObject = await io.get(target.dataBucket, target.pointerKey, MAX_POINTER);
        const live = target.validatePointer(parseObject(liveObject, MAX_POINTER), now(), policy);
        assert.equal(hash(liveObject.body), plan.pointerSha256,
          `${target.name} pointer changed after dry-run; replan before deletion`);
        assert.ok(!live.entries.some(entry => entry.catalogId === candidate.catalogId),
          'current or rollback candidate cannot be deleted');
        if (orphan) {
          assert.ok(Date.parse(candidate.newestObjectAt) + ORPHAN_MIN_AGE_MS <= now(),
            'orphan prefix is younger than its minimum age');
        } else {
          assert.ok(Date.parse(candidate.freshUntil) + GRACE_MS <= now(),
            'candidate lacks post-expiry grace');
        }
        const batch = candidate.keys.slice(start, start + batchSize);
        for (const key of batch) assert.ok(key.startsWith(candidate.prefix) && key.length > candidate.prefix.length);
        let next = 0, failed = false, failure;
        const worker = async () => {
          while (!failed && next < batch.length && !outOfTime()) {
            const key = batch[next++];
            try { await client.delete(key); deleted++; }
            catch (error) { if (!failed) { failed = true; failure = error; } }
          }
        };
        await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));
        if (failed) {
          report('stopped by a failed delete; no further deletion was attempted');
          throw failure;
        }
        // Without a failure, an undispatched key means the deadline stopped this batch.
        if (next < batch.length) return budgetStop();
        report();
      }
    } finally { client?.close?.(); }
  }
  return { deleted, complete: true };
}

// The approved manual lane: a human-approved plan hash over journal-retired prefixes only.
export async function executeRetention({ target, plan, io, deleteForPrefix, catalogValidator, approvedPlanSha256,
  now = Date.now, maximumDeletes = MAX_DELETES, policy = target.readPolicy() }) {
  assert.ok(Number.isSafeInteger(maximumDeletes) && maximumDeletes > 0 && maximumDeletes <= MAX_DELETES);
  assert.match(approvedPlanSha256 ?? '', SHA);
  const { planSha256, ...content } = plan;
  assert.equal(planSha256, hash(JSON.stringify(content)));
  assert.equal(planSha256, approvedPlanSha256, 'dry-run plan has not been approved');
  assert.ok(!Object.hasOwn(plan, 'orphanCandidates'), 'the approved lane deletes only journal-retired prefixes');
  const { deleted } = await executeVerifiedPlan({ target, plan, io, deleteForPrefix, catalogValidator, now,
    maximumDeletes, policy });
  return { status: target.status.executed, pointerSha256: plan.pointerSha256, planSha256, deleted };
}

// Recurring-publisher reclaim: the planner only ever proposes journal-retired, unprotected
// prefixes past grace and, with `orphans`, provably unreferenced never-activated uploads past
// their minimum age, so this class needs no human plan hash. The CLI passes INLINE_RECLAIM, a
// wall-clock deadline and a progress logger; a deadline stop is a clean partial result
// (`reclaim-budget-exhausted`) so the capacity check still decides.
export async function reclaimRetired({ target, io, deleteForPrefix, catalogValidator, now = Date.now,
  maximumCandidates = DEFAULT_CANDIDATES, maximumDeletes = MAX_DELETES, policy = target.readPolicy(),
  orphans = false, maximumOrphans = DEFAULT_ORPHANS, batchSize, concurrency, deadline, clock, onProgress }) {
  const plan = await planRetention({ target, io, catalogValidator, now, maximumCandidates,
    maximumObjects: maximumDeletes, policy, orphans, maximumOrphans });
  const summary = { pointerSha256: plan.pointerSha256, planSha256: plan.planSha256,
    candidates: plan.candidates.map(row => row.catalogId),
    skippedEmptyCatalogIds: plan.skippedEmptyCatalogIds, refusedCatalogIds: plan.refusedCatalogIds,
    refusalReasons: plan.refusalReasons,
    ...(orphans ? { orphanCandidates: plan.orphanCandidates.map(row => row.catalogId),
      orphanRefusals: plan.orphanRefusals, orphanInventory: plan.orphanInventory } : {}),
    plannedObjects: plan.totalObjects };
  if (plan.candidates.length === 0 && !(plan.orphanCandidates?.length)) {
    return { status: 'nothing-to-reclaim', ...summary, deleted: 0, remainingObjects: 0 };
  }
  const { deleted, complete } = await executeVerifiedPlan({ target, plan, io, deleteForPrefix, catalogValidator,
    now, maximumDeletes, policy, batchSize, concurrency, deadline, clock, onProgress });
  return { status: complete ? target.status.reclaimed : 'reclaim-budget-exhausted',
    ...summary, deleted, remainingObjects: plan.totalObjects - deleted };
}

// Operator-facing notices for a plan or reclaim result: a warning per refused retired entry or
// orphan (it is kept, and blocks no other entry) and a one-line step summary.
export function retentionNotices(result, label) {
  const refused = result.refusedCatalogIds ?? [];
  const warnings = refused.map(id => `retired ${id} was refused (${result.refusalReasons?.[id]}) `
    + 'and kept; inspect its selection, catalog and prefix');
  const orphanRefusals = Object.entries(result.orphanRefusals ?? {});
  for (const [id, reason] of orphanRefusals) {
    warnings.push(`never-activated ${id} was refused (${reason}) and kept; inspect its selection and prefix`);
  }
  if (result.orphanInventory && result.orphanInventory !== 'listed') {
    warnings.push(`never-activated uploads were not considered (${result.orphanInventory}); retired reclaim was unaffected`);
  }
  if (result.status === 'reclaim-budget-exhausted') {
    warnings.push(`inline reclaim reached its wall-clock budget after deleting ${result.deleted} of`
      + ` ${result.plannedObjects} planned objects; ${result.remainingObjects} remain for the next run`);
  }
  const ids = rows => (rows ?? []).map(row => (typeof row === 'string' ? row : row.catalogId));
  const candidates = ids(result.candidates);
  let summary = `${label} retention: ${result.status ?? 'plan'}; candidates ${candidates.join(', ') || 'none'};`
    + ` deleted ${result.deleted ?? 0}; skipped empty ${(result.skippedEmptyCatalogIds ?? []).length};`
    + ` refused ${refused.length ? refused.map(id => `${id} (${result.refusalReasons?.[id]})`).join(', ') : 'none'}`;
  if (Object.hasOwn(result, 'orphanCandidates')) {
    summary += `; never-activated ${ids(result.orphanCandidates).join(', ') || 'none'}`
      + ` (inventory ${result.orphanInventory}; refused ${orphanRefusals.length
        ? orphanRefusals.map(([id, reason]) => `${id} (${reason})`).join(', ') : 'none'})`;
  }
  return { warnings, summary };
}

function base64url(value) { return Buffer.from(value).toString('base64url'); }

// A 15-minute temporary credential restricted to DeleteObject under one prefix of the target's
// component bucket, derived from a parent R2 key.
export function scopedDeleteCredentials(target, parent, prefix, nowSeconds = Math.floor(Date.now() / 1000)) {
  assert.match(parent.accessKeyId ?? '', /^[A-Za-z0-9]{10,128}$/);
  assert.ok(typeof parent.secretAccessKey === 'string' && parent.secretAccessKey.length >= 32);
  assert.match(prefix ?? '', target.prefixPattern);
  assert.ok(Number.isSafeInteger(nowSeconds) && nowSeconds > 0);
  const claims = { bucket: target.componentBucket, actions: ['DeleteObject'],
    paths: { prefixPaths: [prefix], objectPaths: [] }, sub: target.account, iss: parent.accessKeyId,
    aud: new URL(target.endpoint).host, iat: nowSeconds, exp: nowSeconds + 900 };
  const unsigned = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  const jwt = `${unsigned}.${createHmac('sha256', parent.secretAccessKey).update(unsigned).digest('base64url')}`;
  return { accessKeyId: parent.accessKeyId,
    secretAccessKey: createHash('sha256').update(jwt).digest('hex'),
    sessionToken: Buffer.from(`jwt/${jwt}`).toString('base64') };
}

// Read, list and per-prefix scoped delete over exactly the target's retention key space.
// `readKeyAllowed(key)` admits the data-bucket keys the planner may read.
export function retentionIo({ target, sdk, readClient, deleteParent, deleteClientFactory, readKeyAllowed }) {
  const send = command => readClient.send(command, { abortSignal: AbortSignal.timeout(120_000) });
  async function read(bucket, key, maximum, missing) {
    assert.equal(bucket, target.dataBucket);
    assert.ok(readKeyAllowed(key));
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_JSON);
    let response;
    try { response = await send(new sdk.GetObjectCommand({ Bucket: target.dataBucket, Key: key })); }
    catch (error) { if (missing && error?.$metadata?.httpStatusCode === 404) return null; throw error; }
    assert.ok(response.ContentLength > 0 && response.ContentLength <= maximum);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.Body) {
      bytes += chunk.length; assert.ok(bytes <= response.ContentLength);
      chunks.push(Buffer.from(chunk));
    }
    assert.equal(bytes, response.ContentLength);
    return { body: Buffer.concat(chunks), etag: response.ETag };
  }
  const get = (bucket, key, maximum = MAX_JSON) => read(bucket, key, maximum, false);
  // Only an orphan's selection may be absent; every other read treats absence as an error.
  const getIfPresent = (bucket, key, maximum = MAX_JSON) => read(bucket, key, maximum, true);
  async function listPrefix(prefix, maximum) {
    assert.match(prefix, target.prefixPattern);
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_OBJECTS);
    const keys = [], tokens = new Set(); let token;
    do {
      const page = await send(new sdk.ListObjectsV2Command({ Bucket: target.componentBucket,
        Prefix: prefix, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }));
      for (const row of page.Contents ?? []) {
        assert.ok(row.Key.startsWith(prefix)); keys.push(row.Key);
        assert.ok(keys.length <= maximum);
      }
      token = page.NextContinuationToken;
      if (token) { assert.ok(!tokens.has(token)); tokens.add(token); }
      assert.equal(Boolean(token), Boolean(page.IsTruncated));
    } while (token);
    return keys;
  }
  // The whole recurring namespace with each object's server-side LastModified (orphan ages).
  async function listNamespace(maximum) {
    assert.ok(Number.isSafeInteger(maximum) && maximum > 0 && maximum <= MAX_NAMESPACE_OBJECTS);
    const rows = [], tokens = new Set(); let token;
    do {
      const page = await send(new sdk.ListObjectsV2Command({ Bucket: target.componentBucket,
        Prefix: target.componentPrefix, MaxKeys: 1000, ...(token ? { ContinuationToken: token } : {}) }));
      for (const row of page.Contents ?? []) {
        assert.ok(typeof row.Key === 'string' && row.Key.startsWith(target.componentPrefix));
        const modified = row.LastModified instanceof Date ? row.LastModified : new Date(row.LastModified);
        assert.ok(Number.isFinite(modified.getTime()));
        rows.push({ key: row.Key, lastModified: modified.toISOString() });
        assert.ok(rows.length <= maximum);
      }
      token = page.NextContinuationToken;
      if (token) { assert.ok(!tokens.has(token)); tokens.add(token); }
      assert.equal(Boolean(token), Boolean(page.IsTruncated));
    } while (token);
    return rows;
  }
  async function deleteForPrefix(prefix) {
    const credentials = scopedDeleteCredentials(target, deleteParent(), prefix);
    const client = deleteClientFactory?.(credentials) ?? new sdk.S3Client({ region: 'auto', endpoint: target.endpoint,
      forcePathStyle: true, maxAttempts: 1, credentials });
    return { async delete(key) {
      assert.ok(key.startsWith(prefix) && key.length > prefix.length);
      await client.send(new sdk.DeleteObjectCommand({ Bucket: target.componentBucket, Key: key }),
        { abortSignal: AbortSignal.timeout(120_000) });
    }, close: () => client.destroy?.() };
  }
  return { get, getIfPresent, listPrefix, listNamespace, deleteForPrefix, close: () => readClient.destroy?.() };
}
