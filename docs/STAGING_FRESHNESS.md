# Staging freshness: independent, qualified refresh of data and regional selections

Status: design for review (2026-09-02). Nothing here is implemented or activated. It resolves the
finding that staging degrades on its own during a day: the shared data copy is a one-shot activation
(HRRR/AIFS refuse after 12 h / 18 h, ECMWF/GFS point series fall behind the map run) and the seven
regional model selections are embedded in the UI build (`VITE_STAGING_MODEL_SELECTION_SHA256`), so
they expire 12 h after their cycle unless a new UI release carries a new digest.

## Goals and non-goals

- Keep every existing safeguard: exact source identity, receipt hashes, 12-hour cycle freshness,
  immutable catalogs, rollback, no production authority, no fusion authority.
- Remove the two manual pins that block automation only where an automated, verifiable substitute
  exists; never widen what a lane may write.
- Do not remove or relax the UI's expiry checks. Freshness must come from fresher data, not from a
  longer allowance.

## Track A: scheduled shared-data refresh (core four models)

Today: discovery (`staging-current-selection.yml`) → human sets
`STAGING_DATA_APPROVED_SELECTION_SHA256` → `staging-data.yml` → human sets
`STAGING_DATA_APPROVED_RECEIPT_SHA256` and `STAGING_DATA_ACTIVATION_ENABLED` → `staging-data-activate.yml`.
The human pins bind a specific published production release+catalog. In production, the same pair
is published by the guarded maintenance workflow (`bake.yml`) and recorded in its immutable release
receipt (`releases/<id>/…` with `publishedAt`, manifest hash) and `catalogs/current.json`.

Proposal: one scheduled workflow `staging-data-follow.yml` (cron 40 minutes after each `bake.yml`
slot, plus `workflow_dispatch`) that runs discovery, preparation and activation in one job under the
`data-staging` environment, replacing the two human hashes with these machine checks:

1. The discovered `releaseId` must be the release produced by the most recent **successful**
   `bake.yml` run (Actions API, same repository, `conclusion == success`) and its manifest hash must
   equal the hash recorded in that run's release receipt object. The catalog must be the one
   published by that run or by a later successful `catalog-bake.yml` run.
2. **Coherence gate (new):** for each core model with point series (ECMWF, GFS), the release's
   point-series `runId` must equal the catalog's latest map run for that model; HRRR/AIFS latest map
   runs must be younger than the app thresholds (12 h / 18 h) at activation time plus a 2 h margin.
   If the gate fails, the run stops before any staging write and posts a summary; the previous
   activation stays.
3. Preparation and activation reuse the existing tools unchanged (`shared-data.mjs`,
   `staging-activate.mjs`); the receipt hash is passed from preparation output to activation inside
   the same job instead of through a variable. The activation still writes only staging pointers and
   still verifies every byte.
4. The environment keeps `STAGING_DATA_ENABLED`, `STAGING_DATA_ISOLATION_APPROVED` and gains
   `STAGING_DATA_FOLLOW_ENABLED` (default false) so the owner can stop the follower with one switch.

Result: the four core models on staging are never older than production plus one cycle, and the
point series match the map run by construction.

## Track B: regional selections refreshed without a UI rebuild

Today the UI accepts `/assets/staging-model-selection.json` only if its bytes hash to the build-time
digest. Proposal: replace the build-time **content** pin with a build-time **key** pin.

1. The cycle repo's `staging-model-selection.yml` gains a signing step: an Ed25519 private key held
   only in the `data-staging` environment signs the canonical selection bytes; it writes
   `staging-selections/current.json` (`{bundleSha256, signature, issuedAt, expiresAt}`) plus the
   bundle to `weatherx-data-staging/staging-selections/<sha256>.json` and the pointer
   `staging-selections/current.json`. The pointer is a mutable object in the staging bucket only.
2. The UI build input becomes `VITE_STAGING_MODEL_SELECTION_PUBLIC_KEY` (the public key, reviewed
   and pinned like today's digest). At runtime the loader fetches the pointer from the staging data
   origin, verifies the Ed25519 signature with WebCrypto, requires `expiresAt` in the future and the
   bundle's `entries[].init` within 12 h (unchanged rule), fetches the bundle by its hash, checks the
   hash, and then applies the same `validateSelection` rules as today. Anything else leaves the
   existing choices and shows the existing visible error.
3. The regional collection chain (`model-inputs.yml` → `staging-model-components.yml` ×7 →
   `staging-model-selection.yml`) becomes a scheduled pipeline keyed on the newest cycle whose 49
   leads are published, with the approved-request hashes computed by the workflow from the archive
   completion records instead of a hand-maintained JSON map; the owner-held switches stay:
   `STAGING_MODEL_COMPONENTS_ENABLED`, `STAGING_MODEL_SELECTION_ENABLED`, approved collector and
   validator SHAs.
4. Rotation: a new key means a new UI build; a compromised key is revoked by rebuilding with a new
   public key. The production build never carries the key and never fetches the pointer.

Result: a fresh 12Z selection lands on staging before the 06Z one expires, without touching the UI.

## What stays manual

- Approving collector/validator source SHAs and the public key.
- Any production action. Both tracks read production data read-only and write staging only.

## Verification plan

Track A: unit tests for the coherence gate on synthetic release/catalog fixtures; one dry run with
`STAGING_DATA_FOLLOW_ENABLED=false` proving the gate decision without writes; then one live run and
`scripts/staging-eleven.mjs` expanded-forecast rows reaching `data-forecast-load="ready"` for ECMWF and
GFS without the Open-Meteo fallback.

Track B: unit tests for signature/expiry/hash rejection; a synthetic signed bundle served from a local
origin in the existing `stagingModelContract` tests; then the real-site matrix (`ui-staging-model-browser.mjs`)
against a pointer refresh with no UI redeploy.
