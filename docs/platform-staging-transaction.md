# Platform staging backend transaction

The manual `WeatherX platform staging transaction` workflow is the only hosted entrypoint in this
repository for the Atmos staging rehearsal packet. It executes exactly one backend stage per
dispatch against the packet's frozen staging Worker and D1 identities. It cannot deploy Pages,
change secrets, target production, or run candidate code that is not the current Atmos `master`.

The workflow is inert until it is merged to Cycle `main` and an owner separately configures the
protected `platform-staging` GitHub environment. Do not create that environment or its credentials
from an unreviewed branch.

## Owner configuration

Configure `platform-staging` with required reviewers, no self-review, and deployment branches
limited to `main`. Disable administrator bypass if the repository policy permits it. Add only:

- environment variable `PLATFORM_STAGING_TRANSACTIONS_ENABLED=true`;
- environment variable `PLATFORM_STAGING_CLOUDFLARE_ACCOUNT_ID=a89f9a1af485021fbc60a68b163c7c6e`;
- environment secret `ATMOS_READONLY_KEY`, a read-only deploy key for `weatherx-hq/atmos`;
- environment secret `PLATFORM_STAGING_CLOUDFLARE_API_TOKEN`, a dedicated token scoped to the
  frozen staging account/resources required by the packet's inventory and selected stage.

Use a new token, not a production workflow token. At minimum, the packet needs the current
Cloudflare permission groups for Workers Scripts, D1, Workers R2 Storage, Cloudflare Pages, and
Workers Routes: read for inventory/export and edit only where Worker deploy, rollback, or migration
requires it. The candidate also declares Queue, email, and Analytics Engine bindings, so validate the
exact permissions required by its pinned Wrangler release before enabling deploy. Cloudflare grants
several of these permissions at account scope rather than per Worker or database; the reviewed
packet's frozen resource map is therefore an essential second fence, not a substitute for minimizing
the token. Do not add DNS, Pages edit, R2 edit, billing, or user permissions for this workflow.

## Dispatch

Use the workflow on Cycle `main`. Supply the exact 40-character SHA currently at Atmos `master`,
choose one stage, and type `RUN-STAGING:<stage>:<atmos_sha>` exactly. The supported sequence is:

1. `configuration` checks required staging secret names without reading or changing values.
2. `backup` exports the current staging D1 database and hashes the nonempty export.
3. `migration` applies only the candidate's pending migrations to staging D1.
4. `worker-deploy` verifies the staging config and deploys only the staging Worker.
5. `worker-rollback` is an incident action and additionally requires the last-good version ID and
   the exact single 100%-active current version ID from a fresh inventory.

Review the prior stage artifact before approving the next dispatch. Never dispatch migration and
Worker deployment concurrently. The shared concurrency group serializes this controller, but it
does not prove another external operator is absent; stop if the packet reports fingerprint drift.

Each run creates a thirty-minute staging lease and a ten-minute stage authorization. Immediately
before execution, the Atmos packet revalidates the authorization, lease, current inventory,
canonical command digest, and rollback compare-and-swap where applicable. It writes a durable
create-once intent before spawning a remote command and a separate create-once result afterward.
The workflow uploads the plan, inventories, authorization, intent, result, and D1 backup when
present as the uniquely named seven-day artifact
`platform-staging-<stage>-<run-id>-<run-attempt>`.

An intent without a result is an ambiguous outcome. Do not retry. Inspect current staging state,
preserve the artifact, and create a new dispatch only after reconciliation. A successful staging
stage does not authorize another stage, a Pages release, an Atmos merge, or any production action.
