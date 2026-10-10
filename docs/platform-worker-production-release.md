# Production platform Worker release

`platform-worker-production-release.yml` releases the production platform Worker
`weatherx-platform-edge-production` from an exact Atmos master SHA. It generalises the one-time
[Wind100 Worker release](platform-wind100-worker-release.md): the SHA is an input, the run is
split into a read-only `plan` and a compare-and-swap `release`, and the live proof is the full
production verifier rather than one selector read.

The release is code only. It never attaches or removes routes, never changes secrets, crons,
D1, R2 objects, Pages, Stripe or purchase availability, and never touches the separate data
Worker `weatherx-data-edge-production`, which keeps `weatherx.org/api/v1/point-series/*`,
`/data/*`, `/data-atmos/*`, `/api/platform/data-health*` and `/api/platform/internal/catalog*`.
If a source changes any production binding, secret name, compatibility setting or cron, the
preflight refuses with binding names and counts only. That change needs its own reviewed release.

## Gates

Every run, in both modes:

1. The dispatch must be on Cycle `main`. The confirmation must be
   `PLAN-PRODUCTION-PLATFORM-WORKER:<sha>` or `RELEASE-PRODUCTION-PLATFORM-WORKER:<sha>`, so it
   is bound to both the mode and the source.
2. The Atmos checkout must be exactly `<sha>`, clean, and reachable from `origin/master`.
3. The production config must name the reviewed Worker with `workers_dev=false`. It must have
   `AUTH_MODE=observe`, `BILLING_MODE=enabled`, `BILLING_PURCHASE_MODE=closed` and
   `PRODUCTION_WIND100_DYNAMIC_ENABLED=1`, the health and Wind100 routes, and no data Worker
   route.
4. The Worker gate runs on the exact source:
   - generated bindings and `tsc --noEmit`;
   - `verify-config.mjs production`;
   - the platform unit suite without the separately deployed commercial surfaces;
   - the source-health, GDACS, aircraft and forecast-fallback runtime contracts;
   - `wrangler deploy --dry-run --env production`.
5. A read-only step with the route token records the zone route inventory. The health and Wind100
   routes must be on the platform Worker and the point route on the data Worker. The receipt lists
   declared routes that are not attached, and attached routes that are not declared. It also lists
   `foreignOverlaps`: routes owned by another script whose pattern overlaps a declared platform
   pattern. Cloudflare serves the most specific match, so those routes, not this Worker, answer the
   overlapping paths. Each one becomes a warning annotation and a row in the job summary. The data
   Worker's point route is the only reviewed exception. See
   [GDACS repair route retirement](platform-production-feed-routes.md#gdacs-repair-worker-routes-and-their-retirement-f4-2026-10-10).
6. The Worker preflight runs with the Worker token only:
   - The active version and the latest uploaded settings must both equal the reviewed config
     exactly (bindings, secret names, compatibility date and flags). Crons must equal the reviewed
     set.
   - If the active version carries a reviewed release tag (`wind100-…` or `production-…`), the
     candidate must descend from that source, so production never moves backwards.
   - Health must be exactly
     `{ok:true, authMode:observe, billingMode:enabled, billingPurchaseMode:closed}`.
   - The production Wind100 selector must be valid.
   - The composed hazard and USGS contract must pass.
   - `ops/release/verify-platform-production.sh` must pass once. If production is already
     unhealthy, the release is refused rather than rolled back.

`plan` stops here. It writes the receipt and prints the active version ID in the job summary.

`release` then:

1. Requires the active version to equal `expected_active_version_id` from the plan.
2. Uploads one inactive version tagged `production-<sha12>`, keeping vars, and verifies the
   candidate's own settings against the config. It checks that the upload did not change the
   active version.
3. Activates exactly that version at 100%.
4. Verifies production:
   - The candidate is active, its settings and crons match, health is exact, and the Wind100
     selector is valid and has not regressed. This check retries up to 12 times, 5 seconds apart.
   - Then `verify-platform-production.sh` must pass 3 consecutive times, 15 seconds apart. That
     covers the shell, data health, catalog, data probe, all weather feeds and the point series.
   - The composed hazard/USGS proof runs again.
   - Finally, the candidate must still be the active version.
5. On any failure it restores only the predecessor recorded in this run's receipt, and only while
   this run's candidate is still active. A foreign deployment is never overwritten. The restored
   state is checked with the verifier's `rollback` phase. A separate `always()` step repeats the
   recovery if the job was cancelled.
6. Re-reads the route inventory and fails if it changed.

Receipts are public: the Cycle repository and its artifacts are public. They record:

- source, controller and run identities;
- the previous and candidate versions;
- a count and a hash of the bindings, never names or values;
- crons, the public health/selector/feed proofs, the route rows and the recovery result.

They are retained for 30 days as `platform-worker-production-<mode>-<run>-<attempt>`.

## Credentials

| Name | Scope | Used by |
| --- | --- | --- |
| `ATMOS_DEPLOY_KEY` (repository secret) | read-only Atmos checkout | source checkout |
| `CLOUDFLARE_WORKERS_API_TOKEN` (repository secret) | Workers Scripts read/edit | plan, release and recover steps only |
| `CLOUDFLARE_DATA_EDGE_API_TOKEN` (repository secret) | zone Workers Routes (used read-only here) | the two route inventory steps only (GET) |

No step holds both Cloudflare tokens. The site verifier receives neither. The Worker's runtime
secrets (`AUTH_HASH_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CATALOG_PROMOTION_KEY`)
live on the Worker. Versions inherit them, and the preflight checks only their names.

The job runs in the `production` environment, with deployment branches limited to protected
branches. That environment currently has no required reviewer. Until the owner adds one, the
dispatcher's exact confirmation and the plan's active version ID are the human gates.

## Runbook

```sh
SHA=<exact Atmos master SHA>
gh workflow run platform-worker-production-release.yml -R Andrewegao/v3t7kq-cycle --ref main \
  -f atmos_sha=$SHA -f mode=plan -f confirm=PLAN-PRODUCTION-PLATFORM-WORKER:$SHA
# read "Active version" from the plan run summary or receipt, then:
gh workflow run platform-worker-production-release.yml -R Andrewegao/v3t7kq-cycle --ref main \
  -f atmos_sha=$SHA -f mode=release -f expected_active_version_id=<active version> \
  -f confirm=RELEASE-PRODUCTION-PLATFORM-WORKER:$SHA
```

A failed release that reports `prior-worker-restored-and-verified` needs no action beyond
reviewing the cause.

Stop and inspect, with no retry, if the receipt shows any of:

- `manual-inspection-required`;
- `prior-worker-restored-verification-failed`;
- a foreign-publisher refusal;
- a route boundary failure.

For a deliberate rollback after a passed release, plan and release the previous reviewed SHA.
The downgrade guard refuses an ancestor of the active tagged source, so an emergency restore of
the recorded `previous` version is an owner action through the Cloudflare dashboard.
