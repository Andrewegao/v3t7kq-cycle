#!/usr/bin/env node
// Read-only planning precedes every production Wind100 deletion. A human-approved plan hash
// is required for the manual workflow, which deletes only journal-retired prefixes; the recurring
// publisher may reclaim journal-proven retired prefixes past grace and provably unreferenced
// never-activated uploads past their minimum age, through the same target-generic planner and
// executor (tools/wind100-retention.mjs) with per-batch pointer checks.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMPONENTS, COMPONENT_PREFIX, DATA, POINTER_KEY, SELECTION_KIND, journalKeyFor, pointerEntry,
  readProductionPolicy, validatePointer, validatePointerJournal, validateSelection } from './production-wind100.mjs';
import { boundedReclaimIo } from './wind100-bounded-step.mjs';
import * as generic from './wind100-retention.mjs';

export { boundedReclaimIo };
export const { DEFAULT_CANDIDATES, INLINE_RECLAIM, MAX_DELETES } = generic;

const ACCOUNT = 'a89f9a1af485021fbc60a68b163c7c6e';
const CATALOG_ID = /^prod-wind100-recurring-[1-9]\d{0,19}-[1-9]\d{0,5}$/;

export const PRODUCTION_TARGET = Object.freeze({
  name: 'production', label: 'Production Wind100',
  planKind: 'weatherx-production-native-wind100-retention-plan',
  account: ACCOUNT, endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  dataBucket: DATA, componentBucket: COMPONENTS, pointerKey: POINTER_KEY, journalKeyFor,
  catalogIdPrefix: 'prod-wind100-recurring-', componentPrefix: COMPONENT_PREFIX,
  prefixPattern: /^components\/point-ecmwf\/prod-wind100-recurring-point-ecmwf-[1-9]\d{0,19}-[1-9]\d{0,5}\/$/,
  selectionKind: SELECTION_KIND,
  selectionKey: catalogId => `production-candidates/wind100/${catalogId}/selection.json`,
  catalogKey: catalogId => `catalogs/snapshots/${catalogId}.json`,
  // Production journals began with the first pointer, so every chain must reach genesis or the
  // 64-record window; a missing link aborts the plan.
  journalStart: false,
  ownsCatalogId: catalogId => CATALOG_ID.test(catalogId),
  readPolicy: readProductionPolicy,
  validatePointer,
  validateJournal: validatePointerJournal,
  verifySelection(selected, entry, policy) {
    validateSelection(selected, Date.parse(selected.createdAt), policy, { allowPrevious: true });
    assert.deepEqual(pointerEntry(selected, entry.selectionSha256,
      Date.parse(selected.createdAt), { policy, allowPrevious: true }), entry);
  },
  status: { reclaimed: 'reclaimed-retired-production-wind100-objects',
    executed: 'deleted-retired-production-wind100-objects' },
});

export function planRetention(options) { return generic.planRetention({ target: PRODUCTION_TARGET, ...options }); }
export function executeRetention(options) { return generic.executeRetention({ target: PRODUCTION_TARGET, ...options }); }
export function reclaimRetired(options) { return generic.reclaimRetired({ target: PRODUCTION_TARGET, ...options }); }
export function retentionNotices(result) { return generic.retentionNotices(result, PRODUCTION_TARGET.label); }
export function scopedDeleteCredentials(parent, prefix, nowSeconds) {
  return generic.scopedDeleteCredentials(PRODUCTION_TARGET, parent, prefix, nowSeconds);
}

// Data-bucket keys the planner may read: pointer, journal, recurring catalogs and selections.
function readKeyAllowed(key) {
  return key === POINTER_KEY || /^production-candidates\/wind100\/journal\/[a-f0-9]{64}\.json$/.test(key)
    || /^catalogs\/snapshots\/prod-wind100-recurring-[1-9]\d{0,19}-[1-9]\d{0,5}\.json$/.test(key)
    || /^production-candidates\/wind100\/prod-wind100-recurring-[1-9]\d{0,19}-[1-9]\d{0,5}\/selection\.json$/.test(key);
}

const loadSdk = () => import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
const BROAD = ['R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY',
  'STAGING_R2_WRITE_ACCESS_KEY_ID', 'STAGING_R2_WRITE_SECRET_ACCESS_KEY'];

export async function createRetentionIo(env, injectedSdk, injectedReadClient,
  injectedDeleteClientFactory) {
  assert.equal(env.PRODUCTION_WIND100_R2_ACCOUNT_ID, ACCOUNT);
  assert.ok(env.PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID
    && env.PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY);
  for (const key of ['PRODUCTION_WIND100_R2_ACCESS_KEY_ID', 'PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY', ...BROAD])
    assert.ok(!env[key], `retention refuses ${key}`);
  const sdk = injectedSdk ?? await loadSdk();
  const readClient = injectedReadClient ?? new sdk.S3Client({ region: 'auto', endpoint: PRODUCTION_TARGET.endpoint,
    forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: env.PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID,
      secretAccessKey: env.PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY } });
  return generic.retentionIo({ target: PRODUCTION_TARGET, sdk, readClient, readKeyAllowed,
    deleteClientFactory: injectedDeleteClientFactory,
    deleteParent() {
      assert.ok(env.PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID
        && env.PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY);
      assert.notEqual(env.PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID,
        env.PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID);
      return { accessKeyId: env.PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID,
        secretAccessKey: env.PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY };
    } });
}

// The recurring publisher's own dedicated Wind100 token reads the journal and lists retired
// prefixes; each deletion still goes through a 15-minute DeleteObject-only credential minted
// for one prefix. Cleanup-environment and broad credentials are refused.
export async function createReclaimIo(env, injectedSdk, injectedReadClient, injectedDeleteClientFactory) {
  assert.equal(env.PRODUCTION_WIND100_R2_ACCOUNT_ID, ACCOUNT);
  assert.ok(env.PRODUCTION_WIND100_R2_ACCESS_KEY_ID && env.PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY,
    'dedicated production Wind100 writer credentials are required');
  for (const key of ['PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY',
    'PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY',
    'PRODUCTION_WIND100_GC_APPROVED_PLAN_SHA256', ...BROAD])
    assert.ok(!env[key], `inline reclaim refuses ${key}`);
  const sdk = injectedSdk ?? await loadSdk();
  const credentials = { accessKeyId: env.PRODUCTION_WIND100_R2_ACCESS_KEY_ID,
    secretAccessKey: env.PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY };
  const readClient = injectedReadClient ?? new sdk.S3Client({ region: 'auto', endpoint: PRODUCTION_TARGET.endpoint,
    forcePathStyle: true, maxAttempts: 1, credentials });
  return generic.retentionIo({ target: PRODUCTION_TARGET, sdk, readClient, readKeyAllowed,
    deleteClientFactory: injectedDeleteClientFactory, deleteParent: () => credentials });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // The protected workflow supplies an already reviewed, pinned Atmos source root.
  const { loadCatalogValidator, verifySource } = await import('./staging-wind100.mjs');
  const { controllerDigest } = await import('./production-wind100.mjs');
  const [command, sourceRoot] = process.argv.slice(2);
  try {
    assert.ok(['dry-run', 'execute'].includes(command));
    assert.equal(process.env.GITHUB_ACTIONS, 'true');
    assert.equal(process.env.GITHUB_REPOSITORY, 'Andrewegao/v3t7kq-cycle');
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
    assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
    assert.equal(process.env.GITHUB_WORKFLOW_REF,
      'Andrewegao/v3t7kq-cycle/.github/workflows/production-wind100-retention.yml@refs/heads/main');
    assert.equal(process.env.GITHUB_JOB, 'retention');
    assert.equal(process.env.WIND100_GC_ENVIRONMENT, 'data-production-wind100-cleanup');
    assert.equal(process.env.PRODUCTION_WIND100_GC_ENABLED, 'true');
    assert.equal(process.env.PRODUCTION_WIND100_GC_CONTROLLER_SHA256, controllerDigest());
    if (command === 'execute') assert.equal(process.env.PRODUCTION_WIND100_GC_EXECUTE_ENABLED, 'true');
    verifySource(sourceRoot);
    const validator = await loadCatalogValidator(sourceRoot);
    const io = await createRetentionIo(process.env);
    try {
      const plan = await planRetention({ io, catalogValidator: validator.validate });
      if (command === 'dry-run') process.stdout.write(`${JSON.stringify(plan)}\n`);
      else process.stdout.write(`${JSON.stringify(await executeRetention({ plan, io,
        deleteForPrefix: io.deleteForPrefix,
        catalogValidator: validator.validate,
        approvedPlanSha256: process.env.PRODUCTION_WIND100_GC_APPROVED_PLAN_SHA256 }))}\n`);
    } finally { io.close(); validator.close(); }
  } catch (error) { console.error(`Production Wind100 retention refused: ${error.message}`); process.exitCode = 1; }
}
