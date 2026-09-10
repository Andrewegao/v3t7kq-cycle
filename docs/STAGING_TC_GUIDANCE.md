# Isolated hurricane guidance publication

This manual lane publishes immutable staging-only TC model data without changing
serving pointers or deploying any UI/Worker. It uses the matching Atmos source
producer and strict validator. Forecast and ensemble availability remain per storm
and source; spread is not a calibrated probability cone.

Before dispatch, qualify one exact Atmos commit and set the protected data-staging
variables STAGING_TC_APPROVED_SOURCE_SHA to it, STAGING_TC_GUIDANCE_ENABLED=true,
STAGING_DATA_ISOLATION_APPROVED=true, and the existing STAGING_R2_ACCOUNT_ID. The
existing staging-scoped S3 write secrets are exposed only to the final publisher.
The source SHA input must equal the protected approved source identity. The job
rejects non-main, scheduled, self-hosted or wrong-workflow execution before private
checkout. It has no default source branch, no schedule, and no production path.

The source bake has provider-specific request/byte/time bounds. The publisher
revalidates its full sanitized inventory, source timestamps, source hosts, storm
identity and ensemble geometry. It writes immutable component objects first,
verifies exact downloaded bytes, writes the component manifest and isolated
catalog, then the selection receipt. It never writes catalogs/current.json,
releases/current.json or a shared-read pin. Partial uploads remain unreachable.

The approved UI build must separately embed the returned exact selection bytes
and SHA under the existing staging-only TC build contract. This workflow does not
activate the UI or modify the shared staging Worker. Coordinate any later shared
staging work with its active owner. A local preparation ID must never be passed
off as a genuine Actions publication run.

Validation: `node --test tests/staging-tc-guidance.mjs`, the full
`node --test tests/staging-*.mjs` lane with staging-controller dependencies, and
`actionlint .github/workflows/staging-tc-guidance.yml`. Tests make no cloud writes.

Prepared during the four-track finish goal on September 10. It has not been
merged, dispatched or enabled. The prerequisite UI injection and exact source
approval remain explicit rollout gates, not claims of completed staging service.
