// Frozen reference: planRetention and its helpers copied verbatim from
// tools/production-wind100-retention.mjs at #440 (6bf866e). Test-only. The generic planner in
// tools/wind100-retention.mjs must reproduce this manual-lane plan, and so its planSha256, byte
// for byte for the same bucket state. Do not edit; delete it once no plan can predate W15.
import assert from 'node:assert/strict';
import { COMPONENT_PREFIX, DATA, POINTER_KEY, hash, journalKeyFor, pointerEntry, readProductionPolicy,
  validatePointer, validatePointerJournal, validateSelection } from '../../../tools/production-wind100.mjs';

const MAX_JSON = 512 * 1024;
const MAX_POINTER = 16 * 1024;
const MAX_JOURNALS = 64;
const MAX_CANDIDATES = 8;
const MAX_OBJECTS = 10_000;
const MAX_DELETES = 10_000;
const DEFAULT_CANDIDATES = 2;
const GRACE_MS = 18 * 3_600_000;
const PLAN_KIND = 'weatherx-production-native-wind100-retention-plan';

function parseObject(object, maximum) {
  assert.ok(object && Buffer.isBuffer(object.body) && object.body.length > 0
    && object.body.length <= maximum);
  return JSON.parse(object.body);
}
function selectionKey(entry) {
  return `production-candidates/wind100/${entry.catalogId}/selection.json`;
}
function catalogKey(entry) { return `catalogs/snapshots/${entry.catalogId}.json`; }
function prefixFor(entry) {
  const invocation = entry.catalogId.slice('prod-wind100-recurring-'.length);
  return `${COMPONENT_PREFIX}${invocation}/`;
}

export async function planRetention({ io, catalogValidator, now = Date.now,
  maximumCandidates = DEFAULT_CANDIDATES, maximumObjects = MAX_DELETES, policy = readProductionPolicy() }) {
  assert.equal(typeof catalogValidator, 'function');
  assert.ok(Number.isSafeInteger(maximumCandidates) && maximumCandidates > 0
    && maximumCandidates <= MAX_CANDIDATES);
  assert.ok(Number.isSafeInteger(maximumObjects) && maximumObjects > 0 && maximumObjects <= MAX_DELETES);
  const currentObject = await io.get(DATA, POINTER_KEY, MAX_POINTER);
  const current = validatePointer(parseObject(currentObject, MAX_POINTER), now(), policy);
  const currentSha256 = hash(currentObject.body);
  const protectedIds = new Set(current.entries.map(row => row.catalogId));
  const retired = new Map(), visited = new Set();
  let body = currentObject.body, reachedGenesis = false;
  for (let depth = 0; depth < MAX_JOURNALS; depth++) {
    const digest = hash(body);
    assert.ok(!visited.has(digest), 'pointer journal ancestry cycle');
    visited.add(digest);
    const journal = parseObject(await io.get(DATA, journalKeyFor(digest), MAX_JSON), MAX_JSON);
    const chain = validatePointerJournal(journal, body, now(), policy);
    for (const entry of chain.previous?.entries ?? []) {
      if (!chain.current.entries.some(row => row.catalogId === entry.catalogId)
        && !protectedIds.has(entry.catalogId)) retired.set(entry.catalogId, entry);
    }
    if (!chain.previousBody) { reachedGenesis = true; break; }
    body = chain.previousBody;
  }
  // A contiguous, bounded suffix proves its retired entries even when older history is retained.
  assert.ok(visited.size > 0);
  // The walk saw newest transitions first; reclaim the oldest retirement first so a prefix is
  // collected before it leaves the bounded ancestry window. Pointer and journal integrity
  // failures above abort the plan; a single retired entry that fails its own evidence below is
  // refused (never deleted) and planning continues, so one bad entry cannot block every run.
  const candidates = [], skippedEmptyCatalogIds = [], refusedCatalogIds = [], refusalReasons = {};
  let totalObjects = 0;
  for (const entry of [...retired.values()].reverse()) {
    if (candidates.length >= maximumCandidates) break;
    if (Date.parse(entry.freshUntil) + GRACE_MS > now()) continue;
    const prefix = prefixFor(entry);
    let keys, stage = 'inventory-unavailable';
    try {
      keys = await io.listPrefix(prefix, MAX_OBJECTS);
      assert.ok(Array.isArray(keys));
      // An already emptied prefix (an earlier run finished it) is progress, not a candidate.
      if (keys.length === 0) { skippedEmptyCatalogIds.push(entry.catalogId); continue; }
      stage = 'selection-unavailable';
      const selectedObject = await io.get(DATA, selectionKey(entry), MAX_JSON);
      const selected = parseObject(selectedObject, MAX_JSON);
      stage = 'selection-mismatch';
      assert.equal(hash(selectedObject.body), entry.selectionSha256);
      validateSelection(selected, Date.parse(selected.createdAt), policy, { allowPrevious: true });
      assert.deepEqual(pointerEntry(selected, entry.selectionSha256,
        Date.parse(selected.createdAt), { policy, allowPrevious: true }), entry);
      stage = 'catalog-unavailable';
      const catalogObject = await io.get(DATA, catalogKey(entry), MAX_JSON);
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
      stage = 'inventory-mismatch';
      assert.ok(keys.length <= component.objectCount + 1);
      assert.equal(keys.length, new Set(keys).size);
      for (const key of keys) {
        assert.ok(key.startsWith(prefix) && key.length > prefix.length && key.length <= 512);
        assert.match(key.slice(prefix.length), /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/);
        assert.ok(!key.split('/').includes('..'));
      }
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
  const plan = { schemaVersion: 2, kind: PLAN_KIND,
    pointerSha256: currentSha256, protectedCatalogIds: [...protectedIds].sort(),
    ancestryRecordsChecked: visited.size, reachedGenesis, maximumCandidates, maximumObjects,
    skippedEmptyCatalogIds, refusedCatalogIds, refusalReasons, candidates, totalObjects };
  assert.ok(plan.totalObjects <= MAX_OBJECTS && plan.totalObjects <= maximumObjects);
  assert.ok(candidates.every(row => !refusedCatalogIds.includes(row.catalogId)));
  return { ...plan, planSha256: hash(JSON.stringify(plan)) };
}
