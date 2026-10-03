# Train 3 original baseline preparation

Each operation requires a separate reviewed execution request. The manual workflow
defaults to disabled and uses the existing `Andrewegao/v3t7kq-cycle` `data-staging`
environment. Only `SHARED_R2_READ_ACCESS_KEY_ID` and
`SHARED_R2_READ_SECRET_ACCESS_KEY` are consumed. Their current availability and
effective scope across the full selected closure remain unverified. No credential value, account setting, new
permission, provider collection, bake, deployment, R2 write, or production mutation
is needed by this implementation.

The job uses the existing named environment form `name: data-staging`, matching
the scheduler's secret-bearing-workflow contract. The local source gates include
the complete offline commands in scheduler CI and `npm run check --prefix scheduler`
(types, tests, and a local dry build); their results do not authorize acquisition.

The owner must review and authorize the exact integrated Cycle source SHA, expected
current catalog ID, operation, and one-day GitHub artifact retention before setting
`enable_preparation=true`. A merge is not dispatch approval. No run is scheduled automatically.

## Metadata assessment before inventory

Use `operation=metadata` to assess the original manifests before planning a larger
inventory. The October 3 diagnostic inventory exceeded the unchanged 25,000 physical
object cap. It did not establish the failing prefix, total payload bytes, or a
logical export closure. Repeating it or raising caps is not a sizing strategy.

Metadata mode reads the pinned current pointer, its snapshot, up to 22 selected
original component manifests, then the current pointer again. It permits at most
25 GET requests and forbids all listing and payload reads at the HTTP guard.
Worst-case response bodies are 22.625 MiB, within the existing 32 MiB wire budget.
The 48 MiB output cap, scratch capacity check, timeouts, private directories,
atomic completion, cleanup and one-day retention are unchanged.

`metadata-audit.json` preserves original pointer, snapshot and manifest bytes and
reports missing IDs, schema versions, `objectLayout.kind`, logical counts,
generation/point descriptors and original hashes. The eight core components feed
the Atmos local catalog adapter and the eleven-model gates; the other fourteen
regional components feed the eleven-model gates and remain in the assessment.
The result uses a distinct `weatherx-train3-baseline-metadata-v1` kind, which the
export-plan validator rejects. Physical counts and payload bytes remain unknown;
no scientific validation or publication authorization is implied.

Schema-one manifest counts describe payload files. Packed, reference and direct
authenticated schema-two layouts use different physical and logical closures.
The existing exporter and core byte verifier support schema one only. If schema
two appears, review its authenticated logical transport and consumer compatibility
before acquisition. Preserve the original manifests rather than rewriting them.
If declared counts already exceed export caps, stop before listing. Otherwise,
review a bounded listing plan to measure bytes and exact closure separately.

## Separate request: inventory

Read `weatherx-data-production/catalogs/current.json`, its exact snapshot under
`catalogs/snapshots/<catalogId>.json`, and original component manifests in
`weatherx-components-production/components/<id>/<artifactId>/component.json`.
Perform only prefix-scoped `ListObjectsV2` for the 22 selected component prefixes.
The account is `a89f9a1af485021fbc60a68b163c7c6e`. Object GET and scoped listing use
the existing locked S3 client; there is no upload/delete/list-whole-bucket API.

The roster is map/point pairs for `ecmwf`, `gfs`, `hrrr`, `aifs`, `icon`, `hrdps`,
`arome-antilles`, `hrrr-ak`, `nam`, `nam-hi`, and `nam-ak`. Missing pairs are reported.
Original pointer/snapshot/manifest bytes are embedded in the inventory plan,
without modification. The current pointer must remain byte-identical throughout.
This inventory downloads no scientific payload. Its review establishes exact
keys, physical layouts, object sizes, total bytes, and supported export closure.

Inventory limits: 200 S3 HTTP requests, 32 MiB aggregate response bytes, 25,000
listed objects, 1,000 objects per page, 2 MiB response per listing, 64 KiB pointer,
512 KiB snapshot, 1 MiB manifest, 48 MiB plan. The SDK response stream is bounded
before listing XML is parsed. Requests get one attempt, a 10-second connection
limit and 30-second request/socket limits. The whole helper has a 43-minute budget
inside a 45-minute job. Reserve at least 1 GiB plus twice the plan cap locally.
The only retained artifact is the bounded plan and acquisition receipt, for one
day, without compression. Interrupted/failed acquisition is not uploaded.

## Separate request: export

After reviewing the first artifact, commit its exact `inventory-plan.json` bytes
as `ops/train3-baseline/export-plan.json` through the owning integration lane.
Review that new source SHA and plan SHA256, then authorize a separate export run.
No plan is supplied by default in this change. This prevents inventory approval
from implicitly authorizing a larger transfer.

Export supports original schema-one component layouts only. It refuses schema-two
references, packed, or direct authenticated layouts: those need a separate reviewed
transport that preserves their logical closure. It also refuses missing pairs,
changed identities, map/point generation mismatch, more than 25,000 payload objects,
more than 64 MiB per object, or more than 2 GiB aggregate payload. Do not raise these
limits to fit an unknown catalog. Review measured sizes and runner capacity first.

Export performs at most 25,100 S3 reads, with the same finite timeout/no-retry policy.
Raw byte count is capped at 2 GiB plus 32 MiB metadata. Before acquisition, require
free scratch disk of four times the exact payload total plus 1 GiB, accounting for
the original closure, core copies, and upload staging. The retained output is at
most twice the payload plus bounded metadata/receipts (under 4 GiB + 96 MiB), one
day, compression level zero. Runner free capacity is checked rather than assumed.

Every payload is read by its reviewed exact object key, checked against the listed
size, hashed, and compared to the original component inventory digest using the
producer's ordering. No original scientific manifest is reconstructed. Original
regional run manifests remain at their original payload paths, distinct from
`component.json`. The eight core components additionally get the exact layout and
seal expected by Atmos's local catalog adapter. Receipt SHA256 values bind bytes;
they are not scientific qualification or permission to publish.

Output is assembled in a fresh invocation-owned temporary directory, then renamed
to its final artifact directory only after all checks pass. The workflow's final
cleanup deletes only its reserved private output directories. The ephemeral runner
owns final cleanup after a forced termination. No provider endpoint is read.
