# Same-account shared weather data and isolated staging

## Current implementation versus activation

`staging-data.yml` prepares an immutable copy of already-published weather data on a
GitHub-hosted runner. It does **not** run collectors or meteorological processing, issue a
new forecast, move serving pointers, deploy UI, or write production storage. The original
independent staging collection draft has been removed. No local weather bake is permitted.

The account is `a89f9a1af485021fbc60a68b163c7c6e`; a second Cloudflare account is not required.
Preparation does transfer/copy bytes into staging buckets; this is not zero-transfer reuse.
Once a snapshot is prepared and activated, ordinary UI tests reuse it without another bake.

Production component updates and whole-release maintenance remain unchanged. The latter
is still responsible for observations/truth, accuracy, point-series and vault archival.
Never disable maintenance or attach a UI deployment to either bake.

## Exact shared snapshot

The manual input selects four values: whole release ID, canonical whole-manifest SHA-256,
component catalog ID and exact catalog byte SHA-256. Their canonical selection hash must
match the independently reviewed `STAGING_DATA_APPROVED_SELECTION_SHA256` environment pin.
Current production pointers must identify that selection at acquisition; later production
updates do not rewrite an in-flight immutable copy.

The controller validates both independent identities. It checks the pinned point descriptor
schema and aggregate inventory, required nonempty accuracy/ledger products, original
component gate receipts, freshness margin, model allowlist, every referenced size and
hash, and exact inventories. It uses a fixed reviewed schema validator—not candidate code.
This is byte-preserving reuse of previously published data, not a new meteorological skill
assessment, full point-pack re-decode or attestation of a collector SHA absent from upstream
receipts. New model source admission is not implied.

Only ECMWF/GFS/HRRR/AIFS components are admitted by this initial reuse lane. No weather
producer, Python dependency install, Pages token, Worker token, UI dispatch or local fallback
exists in the workflow. Synthetic local tests exercise orchestration, not weather collection.

No destination upload starts until the entire acquired snapshot passes. Transfers use
immutable-copy mode and download/readback verification. An interrupted upload can leave
inert objects, but no successful preparation receipt or new serving pointer. A repeat
refuses conflicting bytes. No sync/delete/purge operation is available.

Prepared control documents live at `staging-candidates/<selection-sha256>/`; `receipt.json`
is written last and explicitly states `collected:false`, `processed:false`, `activated:false`,
`productionWritten:false`. This is **not a live staging release receipt**.

## Credentials and activation boundaries

The protected `data-staging` environment is main-only with administrator bypass disabled.
Keep `STAGING_DATA_ENABLED=false` and `STAGING_DATA_ISOLATION_APPROVED=false` until the
actual permissions and target identities are audited.

| Credential | Effective permission | Resource scope |
| --- | --- | --- |
| `SHARED_R2_READ_ACCESS_KEY_ID` / `SHARED_R2_READ_SECRET_ACCESS_KEY` | Object Read | `weatherx-data-production`, `weatherx-components-production` only |
| `STAGING_R2_WRITE_ACCESS_KEY_ID` / `STAGING_R2_WRITE_SECRET_ACCESS_KEY` | Object Read & Write | `weatherx-data-staging`, `weatherx-components-staging` only |
| `ATMOS_DEPLOY_KEY` | Source read | Pinned private validator checkout only |

These are bucket-scoped **S3** credentials; R2 Object Read/Write scopes do not work with
the Cloudflare REST object API. Inherited rclone config, remotes and broad API credentials
are excluded from transfer subprocesses. A misleading secret name is not scope evidence.

`weatherx-data-staging` also contains a vault used by archival work. The trusted controller
never copies or mutates that prefix. Bucket scope is not prefix-level isolation: do not
give this write credential to candidate/experimental scripts. Experimental processors need
their own narrower output boundary before activation.

## Separate publication and backend work

Preparation does not select the staging current release/catalog. A guarded activation must
recheck freshness and consumer compatibility, install the catalog's verified custom hash
metadata, serialize against other staging publishers, preserve/restore prior pointers,
and verify actual layer, ledger/accuracy and numeric point responses. Those activation
operations are not implemented by the preparation helper and must not be substituted
with manual object edits or a production-target publisher.

The separate Atmos staging repair makes staging weather reads public/cacheable, disables
billing and adds its missing data-health route. It changes no production configuration.
That source change is not a Worker deployment. The old live staging auth/billing mismatch
must be repaired by a guarded staging-only backend release before UI qualification.

UI build/deploy isolation is documented in `UI-STAGING-PROMOTION.md`: candidate code runs
on a credential-free runner; a fresh trusted publishing job handles staging-only deployment.
Production UI remains a separate manually triggered, owner-approved artifact promotion.
Neither preparing data nor merging these files deploys either website.

## Explicit remaining scope

- Verify scoped credentials with real cloud reads/copies; local S3 fixtures are not that proof.
- Qualify guarded staging backend update and data activation, then the actual staging UI.
- Shared immutable **raw input** archives for experimental processing still need a complete
  source/producer/config/schema manifest. This lane reuses finished releases instead.
- A future approved-collector pin migration is separate; production source selection has not
  been changed here. New models/fusion experiments must remain non-serving until qualified.

References: [R2 scoped S3 permissions](https://developers.cloudflare.com/r2/api/tokens/),
[Cloudflare account-scoped Pages permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
