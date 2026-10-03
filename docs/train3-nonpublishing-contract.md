# Train 3 nonpublishing controller contract

Owner: root integration; local preparer: Train 3 chat. The original preparation
merged in Cycle #357 as `01ce7fedb245a7dac005218c7527666c5a510200`.
The follow-up updates the offline Atmos identity and adds local content binding
contracts, tests and CI registration. Production source pins, environments,
helpers, schedules, publisher jobs and PR338 remain unchanged.

This is a bounded contract, **not a runnable collection workflow**. No validation
workflow YAML is added. `ops/train3-validation-contract.json` describes a future
separate manual workflow with its enable switch defaulting to false, literal
`WEATHERX_DATA_VALIDATION_ONLY=1` / `PUBLISH=0`, four core and seven regional
collectors, and no publisher, Wind100, vault, mirror, promotion, production
environment, credential or shared-cache writer. The proposal pins merged Atmos
source; it does not grant controller execution, publication or deployment authority.

Controller/workflow/closure, runtime and baseline authority digests remain null.
Admission refuses every unresolved pin. It also requires a separately reviewed
fixed toolchain layout, exact binary/lock/toolchain digests and a minimal child
environment with no HOME, BASH_ENV, import configuration or credentials, even
empty ones. These are structural requirements; this validator does not inspect
actual binaries or authenticate the runtime. The future launcher must verify
them **before** executing any shell or private source. The Atmos environment
whitelist is a capability preflight, not an OS network/arbitrary-code sandbox.

## Offline evidence binding

`tools/train3_validation_contract.py` accepts a proposed contract, an explicit
manual request, separately trusted metadata, an observed manifest and staged ZIP
files. It uses only the Python standard library and never launches a collector,
executes source, fetches metadata, extracts an archive or writes artifacts.
Its JSON output always sets execution authorization, publication authorization
and live-collector qualification to false, including successful synthetic cases.

The trusted metadata is **an external trust input**, not something the producer
may supply or choose. This offline checker cannot authenticate GitHub JSON, a
human approval, or a baseline claim. A future separately reviewed authority
must obtain authenticated run/job/artifact metadata and verified baseline
attestations, bind the reviewed source tree and workflow closure, then keep that
authority outside producer control. Passing the same forged JSON as both
arguments provides no authentic evidence and must never be used for activation.

The checker requires exact repository/workflow/controller/source/tree, current
run and attempt, eleven unique successful collector jobs/artifacts, source-
verification/collection/upload time order, artifact lifetime, exact receipt and
point-receipt digests, and sealed fresh/superset baseline attestations. It compares
observations against the independent authority and hashes bounded actual ZIP
bytes without following symbolic or hard links. No previous attempt, production
workflow identity, missing collector, publisher artifact or malformed metadata
can stand in for the declared validation run.

Artifact input directories must be absolute canonical paths with no symlinked
ancestor (on macOS use the resolved `/private/...` temporary path). The checker
opens each directory component no-follow, retains one directory descriptor for
all eleven ZIP reads, opens fixed leaves relative to that descriptor and checks
file identity before/after hashing. Replacing the pathname cannot redirect the
already anchored reads. No-follow directory APIs are required; there is no
weaker portable fallback.

It does not reject extra sibling files, inspect ZIP members or scientifically
validate receipts. Strict
bounded archive extraction, preserved inner receipt identities, freshness,
point companions, superset/nonregression and complete joined-bake gates remain
mandatory future components. ZIP digests alone do not establish those facts.

## Remaining implementation dependencies

1. Freeze a reviewed manual workflow, default-off admission, exact controller
   commit/tree and transitive workflow closure. The proposed workflow path is
   intentionally absent today; supply and review it before any runnable lane.
2. Prepare separate collector wrappers. Existing core/regional workflows select
   the production environment and Atmos `7a50f197…`; they cannot simply be reused
   as this candidate's credential-free validation wrappers. Private checkout
   access needs separately authorized source-only admission or a sealed source
   bundle. No credential or environment provisioning is performed here.
3. Independently authenticate run/attempt/job/upload/artifact metadata and the
   sealed baseline inputs. The existing production helper requires bake.yml's
   four-core/seven-regional/**eleven-publisher** closure. Preserve that check;
   add separate validation artifact authority with zero publishers.
4. Establish fixed startup/PATH, shell/Python/Node binary and dependency-tree
   authority, isolated outputs, provider request/disk limits and failure cleanup.
   Lock digests alone do not authenticate installed dependencies. Stage strict
   archive verification and the real Atmos scientific/nonregression gates.
5. Review the combined implementation and hosted CI, then obtain explicit
   approval for one live nonpublishing run. No provider run, all-eleven-collector
   proof, complete bake, production approval digest, dispatch or publication is
   implied by these offline contracts.

## Local checks

Run from this branch with Python 3.12; all fixtures are tiny synthetic ZIPs:

```sh
python3.12 -I tests/test_train3_validation_contract.py
python3.12 -I tools/train3_validation_contract.py --contract ops/train3-validation-contract.json
```

The first command checks distinguishing refusals and structural bindings. The
second reports unresolved pins and false authorization/qualification fields.
Scheduler CI names the same isolated contract test. Workflow inventory is checked
after that CI-only edit; no live workflow entry or writer metadata is registered.

## Merged source and offline follow-up

Atmos #432 merged the regional input guard correction. Atmos #434 then merged as
`69ea56d9e5f0179cea21d483625022da41e9a5a5`, tree
`2c5e8455ad6ec975159766e06510e8e192a7d92c`. Its squash tree exactly matches
the independently reviewed head and successful ten-job CI integration tree.
The offline blueprint now pins this actual merged identity. Historical #357
evidence remains attached to its original source identity.

This source has the validation-only local adapter: before collection it captures
the externally pinned core catalog bundle, checks eight map/point counterparts,
reuses the existing paired rebase transaction and evaluates freshness/superset
against the original captured baseline without HTTP fallback. The two admitted
baseline inputs are `VALIDATION_CATALOG_BASELINE_DIR` and
`VALIDATION_CATALOG_BASELINE_SHA256`. Production branches and gate policies stay
unchanged. The external digest binds bytes; it does not authenticate their origin.

The new [offline attestation contracts](train3-offline-attestation-contract.md)
check declared baseline-to-seal links, actual bounded toolchain file bytes, and
explicit completed stages/all eleven model proof identities. They never execute
the measured binaries or candidate source. Expected digests still need external
authentication. Success always reports execution, publication, live-collector
and joined-bake qualification false. Scheduler CI runs these synthetic fixtures;
its ordinary dependency cache is not a validation runtime or authority.

A full live joined bake remains unqualified. Nine authority pins and all four
runtime fields remain unresolved; the validation workflow path is still absent.
Future implementation needs a separately reviewed launcher and source closure,
independent issuer/run/artifact authority, complete immutable runtime closure,
authenticated initial workspace and launcher-input mapping, seven regional
baseline payloads, bounded ZIP members/inner receipts and actual scientific gates.
The completion contract hashes supplied workspace/collector/retention declaration
bytes, but does not verify their contents scientifically or establish OS policy.
Output retention and one live nonpublishing run still need owner approval.
