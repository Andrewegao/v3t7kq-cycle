# Production model component retention

`weatherx-components-production` grew from 578 GB and 4.25 M objects on 2026-09-14 to 1,394 GB
and 10.77 M objects on 2026-10-10, about 31 GB a day. Every publisher writes immutable
`components/<id>/<artifact>/` roots and nothing deleted any of them
(`ops/platform/audit-r2-storage.mjs` in Atmos is audit-only by design). This controller is the
approval-gated cleanup, with the same shape as the
[Wind100 retention](production-wind100-retention.md): a read-only dry run, a plan digest, an
approved execution that recomputes and re-checks before every delete, a bounded number of deletes
per run, and no pointer, catalog or manifest ever written.

The reviewed profile is `catalog-chain-window-gc-v1`
([policy](../tools/production-components-retention-policy.json),
[controller](../tools/production-components-retention.mjs),
[workflow](../.github/workflows/production-components-retention.yml)).

## What is kept

A root is never a candidate when any of these holds:

1. **A catalog snapshot in the window references it.** The planner reads `catalogs/current.json`
   (the baseline) and walks the parent chain. It checks the head snapshot against the pointer's
   `catalogSha256`, and each ancestor against the `sha256` metadata the catalog writer stored with
   it, with `sequence` decreasing by exactly one and `createdAt` never increasing. It keeps walking
   until it has included the snapshot that was serving at `baseline − windowHours` (168 h). Every
   root those snapshots reference is kept. That covers the current catalog, every rollback target
   and every catalog a pinned `_catalog/<id>` read could ask for during the week. A missing,
   altered or non-contiguous link fails the plan.
2. **A kept component routes objects to it.** For each kept model component the planner reads
   `component.json` (checked against the catalog hash). A `references-v1` layout adds every
   `sourceRoots` entry of its routing manifest. `packed-v1` and `direct-auth-v1` stay within their
   own root. Any other layout fails the plan.
3. **The staging shared-read pin references it.** If `weatherx-data-staging/shared-read/pin.json`
   names a production catalog, that catalog's roots are kept, whether or not the pin has expired.
4. **It is recent.** A root with any object newer than the window start is kept. This covers
   uploads still in flight and publications that have not activated yet.
5. **It is out of scope.** v1 covers only `components/<model>/` and `components/point-<model>/` for
   the eleven policy models, and only canonical publisher artifact ids
   (`<component>-<YYYYMMDDTHHMMSSZ>-<epoch seconds or 32 hex>`). The Wind100 recurring prefix,
   observation, place, energy and every other component, and any experiment or canary root are
   never touched.

Everything else in scope is **eligible**. A plan selects the oldest eligible roots, up to
`maximumDeletesPerRun` (500,000) objects. Each selected root is listed in full, and the plan
records its object count, bytes and the SHA-256 of its sorted `[key, size, etag]` rows.

## Plan, approval and execution

1. **Dry run.** Dispatch `production-components-retention.yml` with `dry_run: true`.
   - The job summary shows `planSha256`, the baseline catalog id, the window, kept and held
     totals, eligible totals, what this run would delete, and the **cap line**.
   - The cap line compares bucket objects and bytes with the policy budget (12 M objects, 1.5 TB;
     WARN at 80%, ALARM at 100%). It also shows the totals after the plan, the last-24-hour
     growth and the days until the byte budget at that rate. R2 itself has no per-bucket
     object or byte limit, so the budget is the owner's.
   - The full plan is the `production-components-retention-plan` artifact.
2. **Review and approve.** Set the protected variable `PRODUCTION_COMPONENTS_GC_APPROVED_PLAN_SHA256`
   to that `planSha256`.
3. **Execute.** Dispatch with `dry_run: false` and `baseline_catalog_id` set to the dry run's
   baseline. The execution then:
   - recomputes the whole plan at that baseline and refuses unless its SHA-256 equals the
     approved one. It also refuses unless the live pointer descends from the baseline by
     forward promotions only, with no rollback, no snapshot promoted since references a
     candidate, and the baseline is at most `maximumPlanAgeHours` (48 h) older than the live
     pointer;
   - re-lists each root and requires the recorded key digest;
   - **before every delete**, re-reads `catalogs/current.json` and the staging pin. A new
     pointer is walked back to the last verified head; a rollback, a broken chain or a
     re-promoted candidate stops the run. A changed pin stops the run;
   - deletes each root's `component.json` last, with a 15-minute `DeleteObject`-only credential
     minted per root from the dedicated delete token (the same construction as Wind100).

   A stopped or partial run is replayable: a new dry run plans only what remains.

## Resources (names only; none exist yet)

- Environment `data-production-components-cleanup` with required reviewers, restricted to `main`.
- Secrets, in that environment:
  - `PRODUCTION_COMPONENTS_GC_READ_ACCESS_KEY_ID` and `PRODUCTION_COMPONENTS_GC_READ_SECRET_ACCESS_KEY`:
    Object Read on `weatherx-data-production`, `weatherx-components-production` and
    `weatherx-data-staging` (pin only).
  - `PRODUCTION_COMPONENTS_GC_DELETE_ACCESS_KEY_ID` and `PRODUCTION_COMPONENTS_GC_DELETE_SECRET_ACCESS_KEY`:
    a parent token dedicated to `weatherx-components-production`. It is used only to derive
    per-root `DeleteObject` credentials and must differ from the read token.
- Variables:
  - `PRODUCTION_COMPONENTS_GC_CALL_ENABLED=true` (repository; the job runs at all);
  - `PRODUCTION_COMPONENTS_GC_ENABLED=true`;
  - `PRODUCTION_COMPONENTS_GC_EXECUTE_ENABLED=true` (only when deletion is wanted);
  - `PRODUCTION_COMPONENTS_GC_CONTROLLER_SHA256`, the output of
    `node -e 'import("./tools/production-components-retention.mjs").then(m=>console.log(m.controllerDigest()))'`
    on the merged commit. Any later change to the workflow, this document, the controller or the
    policy invalidates it;
  - `PRODUCTION_COMPONENTS_R2_ACCOUNT_ID=a89f9a1af485021fbc60a68b163c7c6e`;
  - `PRODUCTION_COMPONENTS_GC_APPROVED_PLAN_SHA256`, per approved plan.

The controller refuses to start if the job environment carries any publisher, catalog-promotion,
staging-write, Wind100 or Pages credential.

Before the first execution, prove that the derived credential denies an adjacent prefix and every
non-delete action, using a disposable object, as `production-wind100-scope-preflight.yml` does for
Wind100.

## Expected first dry run

No live listing has been run: R2 credentials were not available when this was written. From the
daily bucket analytics (`r2StorageAdaptiveGroups`), the bucket held 1,394 GB in 10.77 M objects on
10-10 and grew by about 178 GB and 1.37 M objects over the six days from 10-04. A 7-day window
therefore holds roughly 0.2–0.25 TB and 1.6–1.9 M objects. Expect about 1.1 TB and 8.5–9 M
objects eligible. At 500,000 objects per approved run, that is roughly 18 runs (about an hour each) to clear the
backlog. At steady state, after the hourly ECMWF stand-aside, retention keeps about one window of
data.
