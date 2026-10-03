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
inventory. The October 3 diagnostic inventory exceeded the then-current 25,000 physical
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
without modification. The current pointer must be byte-identical at the initial and final reads; this does not detect intervening changes that return to the same bytes.
This inventory downloads no scientific payload. Its review establishes exact
keys, physical layouts, object sizes, total bytes, and supported export closure.

The successful metadata assessment for catalog
`1410-acb8a859-f0bd-4114-98a1-2b9b34b26499` verified all 22 original schema-one
manifests: 43,699 declared payload objects (36,388 core and 7,311 regional).
Including one `component.json` per prefix predicts 43,721 physical keys and 60
listing pages, or 85 reads with all metadata. These are declared expectations;
only listing can measure actual physical keys and payload sizes. The inventory
allowance is therefore 50,000 keys, independently of the unchanged 25,000-object
export limit. This source change requires a new exact-source execution review
before any inventory dispatch. It authorizes no additional payload transfer.

Inventory limits: 200 S3 HTTP requests, 32 MiB aggregate response bytes, 50,000
listed objects, 1,000 objects per page, 2 MiB response per listing, 64 KiB pointer,
512 KiB snapshot, 1 MiB manifest, 48 MiB plan. The SDK response stream is bounded
before listing XML is parsed. Requests get one attempt, a 10-second connection
limit and 30-second request/socket limits. The whole helper has a 43-minute budget
inside a 45-minute job. Reserve at least 1 GiB plus twice the plan cap locally.
The only retained artifact is the bounded plan and acquisition receipt, for one
day, without compression. Interrupted/failed acquisition is not uploaded.

## Legacy single-export admission

After reviewing the first artifact, commit its exact `inventory-plan.json` bytes
as `ops/train3-baseline/export-plan.json` through the owning integration lane.
Review that new source SHA and plan SHA256 before considering payload transfer.
The measured catalog-1410 inventory is now tracked with SHA256
`9f1855cbdd4dde5f859421c806759d9d5c554bd7f3ab3482e960551f4308e93c`.
Tracking a plan and merging the helper do not authorize its payload transfer.

The low-level legacy export validator supports original schema-one component layouts only. It refuses schema-two
references, packed, or direct authenticated layouts: those need a separate reviewed
transport that preserves their logical closure. It also refuses missing pairs,
changed identities, map/point generation mismatch, more than 25,000 payload objects,
more than 64 MiB per object, or more than 2 GiB aggregate payload. Do not raise these
limits to fit an unknown catalog. Review measured sizes and runner capacity first.
The manual workflow no longer offers legacy `export`, and the CLI explicitly
rejects it before loading a reader. Its old plaintext artifact path cannot be
used as a fallback if encrypted batching fails.

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

## Three separately approved batches and a local join

The manual batch workflow is default-off. Cycle is public. It encrypts every
payload batch before any artifact upload; its only payload output is `batch.age`
and a minimal ciphertext receipt. That receipt contains no original paths,
catalogs, source/run identities or acquisition receipts; those batch records are
inside the encrypted archive. Reviewed tracked source plans, workflow identities,
and previously acquired metadata remain public. Encryption protects scientific
payload bodies and new acquisition receipts. Metadata/inventory retain their
documented behavior. Independent source review, CI and specific
human data/destination approval are required before acquisition. No approved
private Atmos reader path was found.

The measured complete closure contains 43,699 payload objects and 5,449,895,622
bytes. The existing single-export limit still rejects it. `batch-export` uses the
exact original inventory and the tracked `batch-plan.json` digest
`9eafe3a4a3fb3329886f567166c8dfb51b9affd0505ef855d6dba2aab7064c2c`.
Admission verifies all 22 original identities and all eleven map/point pairs before
selecting one fixed batch. The full-plan 6 GiB / 45,000-object allowance applies
only to local metadata validation; each transfer retains the 2 GiB, 25,000-object,
64 MiB/object and 25,100-request limits. No listing occurs during batch export.

| Selection | Payload objects | Payload bytes | Required free scratch bytes |
| --- | ---: | ---: | ---: |
| batch-1 | 13,027 | 1,817,160,950 | 8,342,385,624 |
| batch-2 | 15,464 | 1,819,719,449 | 8,352,619,620 |
| batch-3 | 15,208 | 1,813,015,223 | 8,325,802,716 |

Each batch uses at most eight concurrent reads and a 30-minute acquisition budget
inside the unchanged 45-minute job. The helper allows at most 40 minutes overall,
including verification and up to 10 minutes of encryption. Free disk must satisfy four times its reviewed
payload plus 1 GiB before acquisition; a 1 GiB reserve is monitored during writes.
The helper stops scheduling on the first failure, cancels active requests, and
waits for every worker to retire before cleaning its own output. In strict `batch-export`, it requires the reviewed current-pointer bytes before
and after the transfer. A differing pointer stops that mode; another catalog cannot
be substituted or mixed across batches.

The encrypted batch archive retains original bytes and regular core copies under
the existing paths, for one day with upload compression disabled. It has a distinct batch receipt,
`completeBaselineEligible=false`, and **no complete core seal**. Three successful
batch jobs alone do not establish a complete baseline or scientific qualification.
Across all three selections, original plus duplicate core payloads occupy
10,296,080,134 bytes before metadata and archive overhead. Any encrypted transfer
must budget that amount and separately account for local ciphertext staging.

Recipient admission requires separate explicit confirmation, the exact approved
recipient identity, native X25519 `age1` public recipient and its SHA256 without a
newline. A checksum-validating empty encryption probe runs before the R2 reader
is created. SSH, plugin and passphrase forms are refused. The pinned age v1.3.2
distribution has a 32 MiB archive / 128 MiB expanded-tool bound, one attempt and
a 60-second deadline; original executable members and versions are checked before
use. Only public tool bytes are downloaded during tests. Synthetic fixture keys
do not authorize a real recipient.

After independently verifying a complete partial batch, the helper streams only
regular USTAR records directly into age. There is no plaintext archive file.
Encryption has a 4 GiB + 128 MiB archive cap, 4 GiB + 132 MiB ciphertext cap,
50,100-file cap, 64 KiB diagnostic cap, 4 KiB public receipt cap and 1 GiB monitored
disk reserve. It drains its child process on interruption/failure before removing
invocation-owned scratch/output. Plaintext batch scratch is removed before a
successful artifact output is exposed. Missing recipient confirmation, tool drift,
verification failure or encryption failure cannot retain a plaintext fallback.

The credentialless `tools/train3-baseline-decrypt.mjs` decrypts three explicitly
identified ciphertexts using a local-only identity file into private scratch,
with bounded strict archive extraction and exact expected-file admission. No
private key is uploaded, logged or committed. A local identity must be generated
only after specific approval; it is not generated by the acquisition workflow.
The `tools/train3-baseline-join.mjs` join consumes exactly three locally
downloaded, quiescent batch directories, the two reviewed plans, and an explicit
expected Cycle source SHA. It makes no network request. It checks each source,
catalog, plan and batch identity; rejects extra, missing, linked or unsafe paths;
rehashes original payload inventories and core copies; and requires the exact
22-component union. Only a successful join emits the complete eight-core seal
and retains all fourteen regional original closures. The destination must be new.
Space admission uses the authenticated sizes, exact original/core copies, raw
metadata, bounded receipts and seal, filesystem block rounding, and conservative
file/directory metadata allowances. At 4,096-byte allocation blocks, the decoded
batch trees are estimated at 10,884,222,976 bytes and the joined output at
10,895,052,800 bytes. Joining already staged plaintext needs **11,968,827,392
additional free bytes**. Combined decryption and joining needs **22,853,189,632
additional free bytes after ciphertext staging**, before any decryption child
starts. Both include scratch and a 1 GiB reserve.

The three conservative ciphertext bounds plus receipt/directory allocation total
10,376,966,144 bytes. Staging ciphertext, decrypting and joining on one filesystem
therefore requires an estimated **33,230,155,776 free bytes before staging**,
including the reserve. These estimates are recalculated for the destination's
actual allocation block size; they are polled admission checks, not a filesystem
quota or protection against other writers. Free space is checked during writes.
Available capacity must be measured again immediately before staging. This
workflow does not delete unrelated files to make space. Its private temporary
directory and destination reservation are invocation-owned; inputs must remain
locally quiescent.

The local commands require explicit reviewed file digests and source identity:

```text
node tools/train3-baseline-join.mjs PLAN PLAN_SHA BATCH_PLAN BATCH_SHA SOURCE_SHA DESTINATION BATCH1 BATCH2 BATCH3
node tools/train3-baseline-decrypt.mjs PLAN PLAN_SHA BATCH_PLAN BATCH_SHA SOURCE_SHA IDENTITY_FILE TOOLCHAIN_JSON TOOLCHAIN_SHA DESTINATION CIPHERTEXT_INPUTS_JSON CIPHERTEXT_INPUTS_SHA
```

The ciphertext input JSON contains exactly three rows with `ciphertextPath`,
`ciphertextSha256`, `ciphertextBytes`, `receiptPath` and `receiptSha256`. Tool paths
identify the exact verified age distribution and its original executables. Keep
identity and descriptor files private locally; neither is a workflow upload.

## Explicit recovery of the reviewed historical catalog

`historical-batch-export` additionally requires `historical_baseline_confirmed=true`.
It uses the same exact source, catalog, full-plan, batch-plan and native recipient
admission. It selects only the original reviewed catalog-1410 snapshot, manifests
and payload keys. A different actual `catalogs/current.json` never selects another
snapshot or payload. Strict `batch-export` retains its existing refusal behavior;
there is no automatic fallback.

Historical mode reads and structurally validates the bounded actual current pointer,
then checks the exact approved snapshot and **all selected manifests before any
scientific payload read**. It reads only the fixed reviewed keys and repeats the
original producer inventory hash checks. Finally, it performs the second bounded current-pointer GET and validates its
structure. Under the explicit `historical-observation-v1` policy the two serving
observations may differ: the exact reviewed snapshot, manifests and producer
path/size/SHA256 inventory remain the byte authority. Strict `batch-export` still
requires equality at both read boundaries; neither mode proves continuous
stability or detects intervening ABA changes.

The new private historical acquisition receipt records `currentPointerPolicy`
(`historical-observation-v1`), `observedCurrentPointerBase64` and
`observedCurrentPointerAfterBase64`, each canonical and bounded to 64 KiB
decoded. Independent batch verification checks their structure and recomputes exact GET and wire counts from those bytes. Historical
batch GET totals are 13,037, 15,470 and 15,223 respectively: payload objects plus
selected manifests plus three reads. Wire bytes are payload plus the approved
snapshot and selected manifests plus the actual before and after pointer lengths.
Legacy source `08151f2ea280c052759ff5c80525d40cdbd922ca` historical receipts keep
their original single-observation schema and twice-before-length accounting; no
legacy receipt is rewritten or silently upgraded.
All existing object, aggregate, worker, time, disk and ciphertext retention limits
remain. No listing, provider collection or storage mutation is permitted.

Acquisition, batch and join receipts retain the explicit operation. Decryption
admits only the two known batch operations; a join rejects mixed operations.
The historical pointer files are the original reviewed inventory bytes, rather
than evidence of the currently serving catalog. A complete core seal authenticates
recovered bytes; it does not establish freshness, scientific qualification or
publication authority. The observed batch2 attempt read and hash-verified its
selected payload closure but refused at the final pointer boundary. It did not
establish a successful retained batch or complete baseline. Availability of the
entire remaining closure still requires verification; missing or changed bytes
must fail closed.

Specific human approval for the original catalog-1410 payload, private Mac
destination and recipient has been recorded separately. Source review and merge
do not dispatch acquisition. The final concrete historical operation remains held
for root inspection and coordination. No payload export, join, bake or publication
is established by this source change.


### Exact local compatibility for the retained legacy batch

A newly reviewed join source can reuse the independently verified legacy batch1
only with a separately reviewed, SHA256-pinned compatibility descriptor. Append
`--historical-source-binding SOURCE_BINDING_JSON SOURCE_BINDING_SHA` to either
local command. Without it, scalar source admission remains unchanged and all
batch receipts must match `SOURCE_SHA`.

The descriptor has exactly `schemaVersion: 1`,
`kind: weatherx-train3-historical-source-binding-v1`, the reviewed `catalogId`,
`reviewedPlanSha256`, `reviewedBatchPlanSha256`,
`operation: historical-batch-export`, and three `batches` rows. Each row has exactly
`batchId`, `sourceSha`, and `currentPointerPolicy`. Batch1 must name
`08151f2ea280c052759ff5c80525d40cdbd922ca` with `historical-stable-v1` (inferred
only after exact legacy source and receipt-schema admission). Batches2/3 must
name the explicit new reviewed `SOURCE_SHA` with `historical-observation-v1`.
No other source/policy mapping, extra or duplicate row, missing batch, unknown
field, strict/historical mix, or fallback is accepted even if its digest matches.
The first archive acquisition receipt selects its row by its actual batch ID,
source, operation and policy, independent of input order or filesystem name.

Mapped joining records `joinSourceSha`, `sourceBindingSha256`, and each batch's
source, policy, run identities and original receipt digests. It omits the scalar
`sourceSha` field that would falsely suggest one common acquisition source.
Original catalog, manifest and payload byte checks, private-tree mutation audits,
core seal, age toolchain, recipients, limits and cleanup remain unchanged.
This source correction does not authorize another remote acquisition or private
identity access. Preserve the failed batch2 receipt and its final rotation evidence.
