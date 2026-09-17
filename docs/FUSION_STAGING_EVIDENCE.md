# Isolated staging forecast evidence

This lane is a manual diagnostic for the isolated `weatherx-fusion-archive-staging` and its own reader. It never deploys Workers, changes buckets, touches a customer route, promotes calibration, or publishes an accuracy claim.

## Why it is manual-only

The staging reader was intentionally populated from a fixed point-data catalog. That catalog expired after the original qualification, so a recurring collector could only produce predictable stale-source failures. The former six-hour schedule is retired rather than silently republishing weather data into an isolated test reader.

Use this workflow only when the staging catalog has been deliberately refreshed and its exact `FUSION_STAGING_ENGINE_SHA` is pinned. Production evidence recording uses the separately guarded `fusion-issue.yml` canary/full path against the live production reader; staging success is not a substitute for its append and exact-readback proof.

## Manual diagnostic

The workflow checks that the archive and reader bind only the dedicated staging buckets, have no customer routes, and acquire independent observations directly from Aviation Weather Center. It collects the 64 frozen stations, pulls seven days from that archive, and scores matches without fitting or publishing calibration. Partial collections fail and remain recorded as bounded gap artifacts.

The workflow may be dispatched only after confirming the staging point catalog is fresh enough for every requested forecast. A successful run proves only that isolated staging transaction. Do not infer recurring reliability, production availability, forecast skill, or public archive coverage.

## Recovery

There is no staging schedule to disable. Cancel any active manual run, preserve immutable records already accepted, and record the gap. Do not delete the archive, rotate keys, deploy a Worker, touch production flags, or rewrite evidence timestamps.

## Local validation

Run `node --test tests/fusion-staging-evidence.mjs tests/fusion-production-evidence.mjs tests/workflow-inventory.mjs tests/workflow-timing.mjs`, `node tools/workflow-inventory.mjs --check`, and `npm run check --prefix scheduler`. These tests exercise isolation, direct-observation boundaries, exact station completeness, readback receipts, and workflow scope; they do not make a live append.
