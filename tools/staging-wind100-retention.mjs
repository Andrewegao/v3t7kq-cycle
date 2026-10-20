#!/usr/bin/env node
// Inline retention for the recurring staging Wind100 publisher: the target-generic planner and
// executor (tools/wind100-retention.mjs) over the staging pointer, its journal and the recurring
// staging component namespace. It reclaims journal-retired prefixes past grace and provably
// unreferenced prefixes at least 48 hours old, before the capacity check.
//
// `node tools/staging-wind100-retention.mjs reclaim SOURCE` is its own CLI entry, so the staging
// controller never imports this module and no import cycle exists. The entry uses no top-level
// await (see production-wind100.mjs and #439).
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACCOUNT, COMPONENTS, DATA, POINTER_KEY, RECURRING_COMPONENT_PREFIX, RECURRING_PUBLICATION_MODE,
  SELECTION_KIND, controllerDigest, journalKeyFor, loadCatalogValidator, pointerEntry, readPolicy,
  recurringGate, validatePointerJournal, validateSelectedCatalog, validateWind100Pointer } from './staging-wind100.mjs';
import { RECLAIM_BUDGET_MS, RECLAIM_IO_TIMEOUT_MS, reportReclaim, runBoundedCli, runInlineReclaim }
  from './wind100-bounded-step.mjs';
import * as generic from './wind100-retention.mjs';

const RECURRING_CATALOG_ID = /^stage-wind100-recurring-[1-9]\d{0,19}-[1-9]\d{0,5}$/;
const LABEL = 'Staging Wind100';

export const STAGING_TARGET = Object.freeze({
  name: 'staging', label: LABEL,
  planKind: 'weatherx-staging-native-wind100-retention-plan',
  account: ACCOUNT, endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  dataBucket: DATA, componentBucket: COMPONENTS, pointerKey: POINTER_KEY, journalKeyFor,
  catalogIdPrefix: 'stage-wind100-recurring-', componentPrefix: RECURRING_COMPONENT_PREFIX,
  prefixPattern: /^components\/point-ecmwf\/stage-wind100-recurring-point-ecmwf-[1-9]\d{0,19}-[1-9]\d{0,5}\/$/,
  selectionKind: SELECTION_KIND,
  selectionKey: catalogId => `staging-candidates/wind100/${catalogId}/selection.json`,
  catalogKey: catalogId => `catalogs/snapshots/${catalogId}.json`,
  // Staging pointers predate staging journals: the first journaled transition marks its previous
  // pointer `pre-journal`, and the verified history stops there instead of aborting.
  journalStart: true,
  // Legacy manual staging entries (stage-wind100-<invocation>) live outside the recurring
  // namespace; they stay protected or referenced but are never reclaim candidates.
  ownsCatalogId: catalogId => RECURRING_CATALOG_ID.test(catalogId),
  readPolicy,
  validatePointer: value => validateWind100Pointer(value),
  validateJournal: (journal, body) => validatePointerJournal(journal, body),
  verifySelection(selected, entry) {
    assert.equal(selected.publicationMode, RECURRING_PUBLICATION_MODE);
    assert.deepEqual(pointerEntry(selected, entry.selectionSha256), entry);
  },
  // The reader verdict is the planner's own `catalog-rejected` stage; this adds the exact
  // point-only shape the staging activator requires.
  verifyCatalog: (selected, catalog) => validateSelectedCatalog(selected, catalog, () => true),
  status: { executed: 'deleted-retired-staging-wind100-objects' },
});

export const { INLINE_RECLAIM, MAX_DELETES } = generic;
// The target always wins over anything a caller passes.
export function planRetention(options) { return generic.planRetention({ ...options, target: STAGING_TARGET }); }
export function reclaimRetired(options) { return generic.reclaimRetired({ ...options, target: STAGING_TARGET }); }
export function retentionNotices(result) { return generic.retentionNotices(result, LABEL); }
export function scopedDeleteCredentials(parent, prefix, nowSeconds) {
  return generic.scopedDeleteCredentials(STAGING_TARGET, parent, prefix, nowSeconds);
}

// Data-bucket keys the planner may read: the pointer, journal records, and staging catalogs and
// selections (recurring, plus legacy manual ones a referenced entry may still name).
function readKeyAllowed(key) {
  return key === POINTER_KEY || /^staging-candidates\/wind100\/journal\/[a-f0-9]{64}\.json$/.test(key)
    || /^catalogs\/snapshots\/stage-wind100(?:-recurring)?-[1-9]\d{0,19}-[1-9]\d{0,5}\.json$/.test(key)
    || /^staging-candidates\/wind100\/stage-wind100(?:-recurring)?-[1-9]\d{0,19}-[1-9]\d{0,5}\/selection\.json$/.test(key);
}

const loadSdk = () => import('../staging-controller/node_modules/@aws-sdk/client-s3/dist-cjs/index.js');
// Production, shared-read and transport credentials never reach staging retention.
const REFUSED = ['R2_PRODUCTION_ACCESS_KEY_ID', 'R2_PRODUCTION_SECRET_ACCESS_KEY',
  'PRODUCTION_WIND100_R2_ACCESS_KEY_ID', 'PRODUCTION_WIND100_R2_SECRET_ACCESS_KEY',
  'PRODUCTION_WIND100_GC_READ_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_READ_SECRET_ACCESS_KEY',
  'PRODUCTION_WIND100_GC_DELETE_ACCESS_KEY_ID', 'PRODUCTION_WIND100_GC_DELETE_SECRET_ACCESS_KEY',
  'SHARED_R2_READ_ACCESS_KEY_ID', 'SHARED_R2_READ_SECRET_ACCESS_KEY',
  'RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID', 'RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY'];

// The recurring staging job's own writer token reads the pointer, journal and selections and
// lists the recurring namespace; each deletion goes through a 15-minute DeleteObject-only
// credential minted from it for one recurring staging prefix.
export async function createStagingReclaimIo(env, injectedSdk, injectedReadClient, injectedDeleteClientFactory) {
  assert.equal(env.STAGING_R2_ACCOUNT_ID, ACCOUNT);
  assert.ok(env.STAGING_R2_WRITE_ACCESS_KEY_ID && env.STAGING_R2_WRITE_SECRET_ACCESS_KEY,
    'isolated staging writer credentials are required');
  for (const key of REFUSED) assert.ok(!env[key], `staging inline reclaim refuses ${key}`);
  const sdk = injectedSdk ?? await loadSdk();
  const credentials = { accessKeyId: env.STAGING_R2_WRITE_ACCESS_KEY_ID,
    secretAccessKey: env.STAGING_R2_WRITE_SECRET_ACCESS_KEY };
  const readClient = injectedReadClient ?? new sdk.S3Client({ region: 'auto', endpoint: STAGING_TARGET.endpoint,
    forcePathStyle: true, maxAttempts: 1, credentials });
  return generic.retentionIo({ target: STAGING_TARGET, sdk, readClient, readKeyAllowed,
    deleteClientFactory: injectedDeleteClientFactory, deleteParent: () => credentials });
}

export async function main(command, env = process.env, argv = process.argv.slice(3), log = console.log, deps = {}) {
  assert.equal(command, 'reclaim', 'usage: staging-wind100-retention.mjs reclaim SOURCE');
  const policy = readPolicy();
  recurringGate(env, policy, controllerDigest(), 'metadata');
  const clock = deps.clock ?? Date.now;
  const deadline = clock() + (deps.budgetMs ?? RECLAIM_BUDGET_MS);
  return runInlineReclaim({ timeoutMs: deps.ioTimeoutMs ?? RECLAIM_IO_TIMEOUT_MS,
    createIo: () => (deps.createReclaimIo ?? createStagingReclaimIo)(env),
    loadValidator: () => (deps.loadCatalogValidator ?? loadCatalogValidator)(argv[0]),
    async reclaim({ io, validator }) {
      // One `reclaim progress` line per batch, so a killed step still leaves a count.
      const result = await reclaimRetired({ io, deleteForPrefix: io.deleteForPrefix,
        catalogValidator: validator.validate, policy, now: deps.now ?? Date.now, orphans: true,
        ...INLINE_RECLAIM, deadline, clock, onProgress: log });
      reportReclaim(result, retentionNotices, env, log, LABEL);
      return result;
    } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBoundedCli(LABEL, process.argv[2], () => main(process.argv[2]));
}
