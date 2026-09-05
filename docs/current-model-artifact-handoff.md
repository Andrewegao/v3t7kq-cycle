# Current-run per-model artifact handoff

Status: guarded source foundation only. The eleven reusable publishers are
structurally disabled while their Atmos SHA remains the unqualified `77487534`
placeholder. No workflow pin, environment variable, or catalog was changed.

## Purpose

`tools/current-model-artifact.py` prepares one core or regional model from the
current `bake.yml` run. A successful collector row can be handed to a future
per-model publisher even when a sibling matrix row or the aggregate workflow
fails. This is the transport/provenance half of model failure isolation; the
future caller must still run the Atmos scientific installer, non-regression
gates, immutable uploads, and catalog compare-and-swap.

The existing fixed run `33925520386` recovery bridge remains unchanged. This
helper never relabels an old receipt, rewrites a source SHA, or admits an artifact
from a different producer source.

## Trust boundary

The CLI is invoked with `python -I` in the same workflow run that produced the
artifact. It requires:

- `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`, and `GITHUB_SHA` to exactly match the
  requested run, attempt, and Cycle controller;
- pristine Cycle and Atmos checkouts at those exact SHAs;
- exactly one Atmos checkout in each of `bake.yml` and the three reusable
  workflows, all using the same exact producer / consumer SHA;
- an authenticated GitHub run from repository `1301196656`, the exact workflow
  path, and the exact attempt-specific successful model job;
- successful source-verification, collection, and artifact-upload steps in order;
- exactly one artifact created during that attempt's upload step, with GitHub's
  immutable ID, SHA-256 digest, bounded size, repository provenance, and a live
  retention deadline;
- the existing strict ZIP download and extraction policy (no credential forwarding
  on redirects, traversal, links, duplicate paths, unexpected roots, or unbounded
  expansion);
- unchanged source/model/run identity in the original Atmos receipt. Regional
  display and point-stage receipts must bind the same run and source receipt hash.

A missing, incomplete, failed, explicitly abstained, or expired model is reported
as `status=withheld`. Malformed provenance, archive bytes, receipts, checkouts, or
baseline evidence is fatal. A security failure never falls through as an optional
model absence.

## Shared production-data baseline

The transport helper deliberately never reads staging or production data. After
an artifact is authenticated, the reusable publisher hydrates the current model
from the hard-coded production data/component buckets under the protected
`production` environment. This is the data source actually read by production,
staging, and the shared-data localhost preview. No Pages/UI credential exists in
this lane.

Regional replacement binds the hydrated last-good manifest into the unchanged
Atmos regional installer. Missing components may fall back only through the
authenticated immutable whole-production-release path. Activation therefore
requires the Atmos fix that verifies the catalog pointer and snapshot hash before
examining component absence.

## Interface

```text
python -I tools/current-model-artifact.py \
  --run-id "$GITHUB_RUN_ID" \
  --run-attempt "$GITHUB_RUN_ATTEMPT" \
  --controller-sha "$GITHUB_SHA" \
  --atmos-source-sha "$APPROVED_COMMON_ATMOS_SHA" \
  --atmos-root "$RUNNER_TEMP/atmos" \
  --kind core|regional --model MODEL \
  --output "$RUNNER_TEMP/current-model-handoff" \
  --github-output "$GITHUB_OUTPUT"
```

The output is created atomically outside both source checkouts:

```text
current-model-handoff/
  handoff.json
  packs/...
```

`handoff.json` is a non-authorizing envelope (`publicationAuthorized: false`). It
binds the original GitHub run/attempt/controller/job/artifact and Atmos source,
the preserved receipt hashes, and forecast run. The protected publisher must
consume this envelope without weakening its own current scientific, numeric,
freshness, point-companion, upload, and final-CAS checks.

## Required orchestration before activation

`bake.yml` now has eleven explicit reusable collector callers and eleven matching
publisher callers. Each publisher depends on only its own collector; a sibling
failure cannot hide or delay a healthy model. The original joined maintenance
publisher still receives the same eleven artifact names and retains its existing
production lock and behavior. Publication reports each model independently as
`published`, `unchanged`, `withheld`, or `failed`.

Activation requires the repository caller flag plus the matching protected
production-environment settings (environment-only flags cannot unlock caller jobs):

- `CURRENT_RUN_COMPONENT_PUBLISH_ENABLED=true`
- `CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA=<the exact qualified common SHA>`

The publisher also refuses the current placeholder SHA even if both variables are
mis-set. Update all three reusable Atmos checkout refs and the whole-bake ref,
including their exact source assertions, together. There are no duplicate legacy
collector matrices. Run a publication-disabled cloud canary to confirm GitHub's
exact compound job names (`core (MODEL) / collector` and
`regional (MODEL) / collector`) before enabling publication.
The canary still needs the read-only source checkout key; it must not execute
the production component-publishing jobs. Ordinary whole-data publication remains
an explicitly authorized separate job, not a credential-free simulation.

Activation must pin an exact final Atmos SHA whose `hydrate-r2-component.sh`
validates the catalog pointer/snapshot hash and identity before its missing-component
whole-release fallback. The handoff's common-source guard makes that prerequisite
structural: it must not be wired against the older helper ordering where absence was
examined before catalog integrity.

That SHA must also include the reviewed core and regional artifact consumers,
regional pair-CAS/final freshness headroom, ECMWF same-run repair, normalized
authenticated retained-baseline proof, and all component scientific gates. The
staged catalog/UI reader must already be merged. Owner review of the protected
environment guard is mandatory. This lane repairs shared weather data only; it
cannot deploy the production or staging UI.

## Local evidence

```text
python -m unittest tests.test_current_model_artifact
```

The suite is hermetic: it uses synthetic GitHub metadata/ZIPs and mocked hydration,
performs no provider downloads, cloud writes, dispatches, or deploys.

Latest local evidence: 18 Python handoff tests pass, including twelve per-file
missing/duplicate/drifted checkout mutations. Scheduler types, 23 unit tests,
workflow contracts and Worker deployment dry-run pass. The matching CI Node
contract selection passes 471 tests, with four pre-existing opt-in skips. An
initial broader ad-hoc run lacked the staging-controller SDK dependencies and
used the system rclone 1.74.3 for an opt-in 1.75.0 throughput experiment; that is
not a passing throughput measurement. No cloud latency improvement is claimed
from these local tests.

Same-commit reusable-workflow semantics are documented by
[GitHub](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
The immutable-action guard recognizes only these three exact local data calls
from bake.yml, scans every callee's external actions, and still rejects floating
references and local calls from the production UI workflow.
