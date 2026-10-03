# Train 3 nonpublishing controller contract

Owner: root integration; local preparer: Train 3 chat. Base: Cycle
`b65c4de785e8c467598a402332d0e4c246866eb9` (#356). This isolated branch
changes only an offline contract, its validator/tests, CI registration and this
runbook. Existing production source pins, environments, helpers, schedules,
publisher jobs and PR338 remain unchanged.

This is a bounded contract, **not a runnable collection workflow**. No validation
workflow YAML is added. `ops/train3-validation-contract.json` describes a future
separate manual workflow with its enable switch defaulting to false, literal
`WEATHERX_DATA_VALIDATION_ONLY=1` / `PUBLISH=0`, four core and seven regional
collectors, and no publisher, Wind100, vault, mirror, promotion, production
environment, credential or shared-cache writer. The proposal pins the reviewed
Atmos source commit and tree; it does not approve or deploy that source.

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

## Current preparation and joined-bake blocker

This preparation reuses the offline prototype at `590504d` on current Cycle main;
it adds no dispatchable workflow. Scheduler CI gains one isolated fixture command
and a blueprint path filter. Existing scheduler CI uses npm cache; it is ordinary
repository CI, not a zero-writer validation run. All existing production workflow
bytes, source pins, environment declarations, schedules, locks and production
artifact authority are preserved.

The reviewed Atmos source candidate is
`8d69cb2a693c726ef4cede91ec5b53e658b5a812`, tree
`ebd81c538bf4369164f34e0b5a9adf030e6d7b79`, based on merged master
`e4b0e0d44276270fe235471864dbb69f31ca3752`. This is a source-review
identity, not merge, deployment or run authority.

The Atmos validation guard correction admits `REGIONAL_PACKS_DIR`, which the
whole-data assembly consumes, while retaining `REGIONAL_MODEL_PACKS_DIR`, which
the per-component lane consumes. It introduces no writer capability and does not
qualify a complete joined bake.

A full joined bake remains blocked: `ops/bake-weatherx.sh` defaults to
`DATA_PUBLISH_MODE=r2-release` and invokes the existing strict catalog rebase
before its data gates. That rebase requires `CATALOG_R2_REMOTE`/`R2_REMOTE` and
`COMPONENT_R2_REMOTE`; validation admission refuses them and `DATA_PUBLISH_MODE`.
A separately reviewed bounded local or read-only rebase adapter, new source
identity and independent sealed baseline authority are required. Do not inject
production capabilities, skip the rebase/superset gates or describe per-model
success as complete 4+7 validation. The declared eleven-model roster is retained.

The next executable lane also requires authenticated current-attempt artifact
authority, strict bounded ZIP membership and inner seals, toolchain authority,
source-only private checkout admission, output/retention policy and a separately
approved live run. This branch cannot provide those authorities by self-hashing
or copying producer metadata. The unresolved pins remain deliberate refusals.
