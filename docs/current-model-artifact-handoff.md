# Current-run per-model artifact handoff

Status: source foundation only. This helper does not publish, activate a catalog,
change a workflow pin, or authorize a candidate for production.

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
- every Atmos checkout in the local `bake.yml` to use the same exact producer /
  consumer SHA;
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

## Regional baseline

Regional replacement needs a last-good model manifest for non-regression. The
caller cannot provide a locally generated expectation. The helper invokes the
exact-source Atmos `hydrate-r2-component.sh` against only the staging catalog and
component remotes in an owned temporary directory. The hydrate path authenticates
the catalog pointer/snapshot/component manifest; if that component is absent it
authenticates the immutable whole-release pointer, manifest, inventory and bytes.

For a catalog component the helper independently derives the downloaded tree's
ordered byte inventory and matches its object count and inventory SHA-256 to the
authenticated component manifest. For either path it binds and copies the active
model manifest into the handoff. The output records whether evidence came from a
catalog component or whole-release fallback and its immutable identity/hash.

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
  baseline-manifest.json   # regional only
```

`handoff.json` is a non-authorizing envelope (`publicationAuthorized: false`). It
binds the original GitHub run/attempt/controller/job/artifact and Atmos source,
the preserved receipt hashes, and regional baseline evidence. A future publisher
must consume this envelope without weakening its own current scientific, numeric,
freshness, point-companion, upload, and final-CAS checks.

## Required orchestration before activation

The future workflow should place a publisher after each model's own collector (or
in a per-model reusable workflow), with per-model concurrency. It must inspect the
selected row rather than `needs` on the aggregate matrix. Report each model as one
of `published`, `unchanged`, `withheld`, or `failed`; never claim the entire roster
online because some rows succeeded. The legacy whole-release publisher and all
production controls remain unchanged until that separate integration is reviewed.

## Local evidence

```text
python -m unittest tests.test_current_model_artifact
```

The suite is hermetic: it uses synthetic GitHub metadata/ZIPs and mocked staging
hydration, performs no provider downloads, cloud writes, dispatches, or deploys.
