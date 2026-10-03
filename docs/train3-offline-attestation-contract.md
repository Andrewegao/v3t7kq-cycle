# Train 3 offline attestation content binding

Scope: standard-library local checks in `tools/train3_offline_attestation.py`.
No workflow, launcher, collector, provider request, bake, publishing capability,
cloud setting or deployment is added. This helper is not an admission token.
The original concrete admission validator still refuses the blueprint's nine
unresolved pins and four unresolved runtime fields.

Each expected SHA must arrive independently from an authenticated authority,
outside producer control. The helper checks exact bounded bytes, not signatures,
issuer authority or approval. Giving it producer-chosen documents and hashes
cannot establish trust. The explicit context is the reviewed Atmos commit/tree
and current run ID/attempt, also supplied independently. JSON keys/types are
strict; floats, duplicate keys, unknown fields, future issue times, expiry and
wrong attempts refuse. Metadata is limited to 1 MiB. Core seals are limited to
16 MiB. Diagnostics omit untrusted inputs.

## Baseline declarations

`weatherx-train3-baseline-attestation-v1` binds source/run context, issuer ID,
issue/expiry, catalog ID and pointer/snapshot digests, the core seal SHA, and all
seven regional map/point baseline manifest SHAs in the reviewed fixed roster.
Freshness, superset and nonregression claims must be literal true. Hash the actual
core seal bytes and link its pointer/snapshot inventory digests to the declaration;
require all eight core map/point manifest identities in that seal.

These checks do not read the core payloads, determine the catalog ID from its
payload, read regional payloads or run science. The Atmos capture/admission code
must still verify its complete seal and actual payload bytes. Independent issuer
authentication and original regional baseline scientific evidence remain external
requirements. Policy booleans are declared claims, never proof by themselves.

## Toolchain declarations and local bytes

`weatherx-train3-toolchain-attestation-v1` declares a Linux architecture, immutable
runner-image digest and network/disk/output policy digests. It fixes shell,
Python and Node entrypoints, regular-copy aliases `bash`, `python3` and `node`,
and the read-only bake-venv mapping from `/validation/toolchain/bake-venv` to
`/validation/source/atmos/data/.venv`. The future launcher must actually establish
this mapping and immutable runtime before any candidate shell or private code.

The fixed inventory must include executable, stdlib, dependency, native-library
and utility roles. These are claimed inventory categories. Presence of a row in
each category cannot prove transitive closure completeness, ELF/shared-library
compatibility, executable permission, actual host image or actual isolation.
Locks remain content identities, not installed-runtime authenticity.

The helper verifies sorted unique relative paths, alias/canonical byte equality,
and exact local directory membership, including no extra empty directories.
It opens canonical absolute roots and files without following links, rejects
hard links/special files, checks consumed-byte size/hash and before/after file
identity, and compares complete inventory fingerprints around the reads. Bounds:
100,000 files, 128 MiB per file, 4 GiB total, 32 path components and 4096 characters.
It never runs a measured file. A passing measurement is not a read-only mount or
a guarantee that the path stays immutable after it returns.

## Completion declarations

`weatherx-train3-completion-attestation-v1` must match independently pinned trusted
completion bytes and the observed complete object. It links baseline authority,
core seal and toolchain hashes, plus independently expected initial-workspace,
collector-proof and retention-policy hashes. The actual supplied bytes of those
three declaration documents are hashed and parsed, but their arbitrary contents
are not interpreted as archive, scientific, filesystem or isolation proof.

The fixed required stages are admission, collectors, assembly, catalog rebase,
freshness/superset, regional validation, point validation, completion and retention.
Each must explicitly complete, with integer times in dependency order and within
the same current run. Baseline and toolchain issue times must precede candidate
startup; completion cannot be future-dated or precede the last stage. Exit zero
alone is insufficient. Fixed model order requires four core and seven regional
rows, validated status, bounded completion time, and distinct per-model map,
point and scientific-gate receipt digests. Optional, missing, carried, borrowed or
skipped evidence cannot replace these rows. Legitimate retained baselines still
need actual gate evidence before they can be represented as validated.

Retention requires explicit original-baseline identity recording, private snapshot
removal, redacted diagnostics and future retention expiry. These remain claims
to be authenticated and checked by future independent code. The helper does not
inspect archive members, inner receipt bytes, stage logs, scientific results,
filesystem cleanup or retained evidence destinations.

The future authority must define and authenticate these document schemas' issuer
and statement collection process. It must independently verify current-attempt
eleven-collector ZIP membership/inner seals, original baseline payloads, actual
workspace seed, request/output/disk policy and real stage/gate evidence. A complete
synthetic object is never live qualification or a substitute for that authority.

## Local checks and CLI

```sh
python3.12 -I tests/test_train3_offline_attestation.py
python3.12 -I tests/test_train3_validation_contract.py
```

The helper's CLI takes absolute canonical file paths for `--context`, `--baseline`,
`--core-seal`, `--toolchain`, `--completion`, `--observation`, `--workspace-proof`,
`--collector-proof` and `--retention-policy`, plus `--toolchain-root`. All document
paths except context/core-seal/observation require an independently supplied
`--<name>-sha256`. The core seal hash comes from the independently pinned baseline
document. On macOS resolve `/var` temporary paths to `/private/var` first.

All successful outputs set `executionAuthorized`, `publicationAuthorized`,
`liveCollectorQualified` and `joinedBakeQualified` to false. `structuralBindingValid`
means only the described declared-authority/content checks passed. No live run is
requested or authorized by this branch.
