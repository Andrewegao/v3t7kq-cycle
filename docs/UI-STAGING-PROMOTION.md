# Manual staging → production UI releases

## Safety boundary

UI releases are never triggered by a push, merge, schedule, data bake, backfill, or another
workflow. Both entry points use `workflow_dispatch` on protected `main`. Production is
manually triggered when Andrew chooses (for example, on a weekend); there is no weekly cron.

This setup does not deploy or change either running website. Both new UI environments are
disabled. The absolute deployment freeze is at least **2026-08-31 11:00 UTC**. Expiry does not
enable anything or authorize a release. Existing deployment workflows remain disabled until
explicit approval. Normal data collection, scoring, archive and R2 publication are separate.

## Release procedure, after activation is separately approved

1. Run **WeatherX UI staging qualification** (`ui-staging.yml`) with the exact current Atmos
   master SHA. It runs all app tests, the existing live Weather Lab gates, builds the public-only
   shell and compiles Pages Functions once. It uses the existing deploy/rollback guard to
   deploy only to `weatherx-platform-staging`, then verifies the actual built website.
2. Test `https://staging.weatherx.org`. A successful workflow retains an encrypted candidate
   and a summary with the source SHA, run ID and artifact digest. Failed qualification never
   produces a promotable artifact. Neither the candidate source nor server code is uploaded
   in plaintext to this public repository.
3. When satisfied, manually run **WeatherX UI production promotion** (`ui-release.yml`), entering
   those three exact values. Approve the separate `ui-production` environment deployment.
   The job downloads that successful run's exact-attempt artifact, authenticates and verifies
   every file, checks staging still serves it, and uploads those same files without a rebuild.
   It does not check out the candidate's current/new master for a rebuild.
4. Production acceptance retains the existing source-bound receipt, three consecutive probes
   15 seconds apart, plus real built-site runtime/layer tests inside the rollback transaction.
   Failure restores the exact prior Pages deployment and opens the existing release fuse.
   Never bypass a fuse or retry until green; diagnose the retained incident first.

Account/billing UI and experimental model expansion are explicitly disabled at build time.
No UI workflow writes data buckets, Workers, bindings, DNS, accounts, billing or Fusion flags.
Changes to those systems require their own separate staging, review and release process.
Public UI releases do not imply that a weather-data update or a backend release has occurred.

## Activation prerequisites — not yet satisfied

At setup, staging serves an older app without `/health/release.json`, and its platform health
reports `authMode=enforce`, `billingMode=enabled`. Production reports public service/observe
and billing disabled. **Do not simply deploy into that mismatch.** Reconcile staging to the
public noncommercial configuration after the freeze, without altering production, and test
its own data/API/OM fallback routes. Reads may use approved immutable production data, but
staging must not have production data-write, account, billing or deployment authority.

Dedicated GitHub environments:

| Environment | Controls | Required later |
| --- | --- | --- |
| `ui-staging` | Protected branches, admin bypass off, independent staging concurrency | `UI_STAGING_PAGES_TOKEN`, `UI_STAGING_ACCOUNT_ID`, reviewed `UI_PAGES_CONFIG_SHA256` |
| `ui-production` | Protected branches, **Andrew required reviewer**, admin bypass off, existing production UI concurrency | `UI_PRODUCTION_PAGES_TOKEN`, reviewed `UI_PAGES_CONFIG_SHA256` |

Both have `UI_RELEASES_ENABLED=false`, `UI_ISOLATION_APPROVED=false` and
`UI_DEPLOYMENT_HOLD_UNTIL=2026-08-31T11:00:00Z`. Both have a shared dedicated random 32-byte
`UI_CANDIDATE_KEY` for AES-256-GCM artifact encryption. The key is not a Cloudflare credential
and is not printed in logs. Rotating it invalidates retained candidates; stage a new candidate.

Provision the Pages credentials separately, audit their effective scopes, and only then record
`UI_ISOLATION_APPROVED=true`. **Different secret names do not prove Cloudflare resource
isolation.** An account-wide Pages token may still reach both projects. Prefer a separate
staging Cloudflare account or an audited resource-restricting deployment broker if project-level
credential restriction is unavailable. Do not copy the existing broad OAuth/production token
into the staging environment to unblock a failed check. Until this review is complete, leave
the activation flags false and the workflows disabled.

The configuration hash is computed by `configurationDigest()` in `tools/ui-release.mjs` from
the read-only Pages project response. It binds the project, branch, domains, Git-source state
and full production-environment configuration without printing secret values. It excludes
volatile deployment pointers. Review the configuration before saving its hash; do not have a
workflow automatically accept whatever config it finds. Both targets must be direct-upload
projects with Git integration absent, branch `main`, and the reviewed compatibility date/flags.

Do not set `prevent_self_review=true` with Andrew as the sole reviewer: he must be able to
trigger and approve his weekend release. The explicit approval is a human operating policy,
not proof that an API user with his permissions could never approve a deployment. Agents and
automations must not approve the production environment on his behalf.

## Artifact and source guarantees

- All Actions references are full SHA pins. A separately checked-out, reviewed Atmos control
  commit is pinned in both workflows and the helper. Its existing guard/fuse/rollback code is
  unchanged. Updating this pin requires review and new staging qualification.
- Candidate identity includes source SHA, workflow SHA, run/attempt IDs, public build profile,
  per-file sizes/SHA-256, complete inventory digest, and the existing app release receipt.
- The private server bundle is compiled once into `_worker.js`; an extremely narrow adapter
  runs the guard's upload with `--no-bundle --upload-source-maps=false`, from an empty directory
  outside the source checkout. This prevents implicit Functions discovery or config reloading.
- AES-GCM authenticates the encrypted bundle. Promotion independently binds it to a successful
  manual staging run, unique nonexpired artifact, exact source/digest inputs and the current
  release-pipeline fingerprint. Traversal, symlinks, source/data archives, extra files, wrong
  receipt/source, wrong attempts and changed bytes fail closed. Restore never overlays a tree.
- Retention is 90 days; qualification is usable for at most 30 days and only while staging
  still serves the candidate. A policy change, overwritten staging site or expired artifact
  requires new qualification. There is no fallback to rebuilding or deploying latest master.
- The staged build retains its staging **build** run ID in production's release receipt. The
  production **promotion** is a separate workflow run. This is expected, not stale provenance.

## Remaining qualification and activation work

Local tests/CI are code evidence, not a live rollout receipt. After credentials/isolation and
staging parity are approved, perform a staging-only qualification and an intentional failing
staging verification to exercise actual rollback/fuse behavior. Inspect the encrypted artifact
handoff and real browser results. Only then enable production promotion for Andrew's explicit
manual action. No production test deployment is part of this setup.

The local legacy `com.weatherx.bake` LaunchAgent remains disabled. `verify-backfill.yml` no
longer has any Pages token/deploy step; it qualifies and caches archive inputs only. Normal
data maintenance remains the R2 publisher, with no Pages credential. Retired alternate UI
release paths must not be re-enabled as shortcuts around this protocol.

## Legacy authority retirement and approval audit

- `bake.yml` (whole maintenance), `catalog-bake.yml` (fast components) and
  `verify-backfill.yml` (archive preparation) have explicit data/read-only credential
  allowlists in `tests/ui-approval-boundary.mjs`. They cannot gain Pages credentials,
  UI publication commands, workflow dispatches or write-capable GitHub job permissions
  without failing the required CI contract. These are source regression checks; the
  environment reviewer and credential isolation are the actual authorization controls.
- Remove the obsolete **repository-level** `CLOUDFLARE_API_TOKEN` from both
  `Andrewegao/v3t7kq-cycle` and `Andrewegao/atmos`. Otherwise an old workflow rerun could
  still receive its historical broad Pages key even after its current YAML is repaired.
  Never re-add this key to unblock an old run. Requalify using the staged promotion path.
- The disabled GDACS repair uses `PAGES_READ_TOKEN` solely for a read-only Pages boundary
  snapshot. It needs a separately provisioned, verified **Pages Read** token before future
  use. This credential is not provisioned by this change. Keep the workflow disabled;
  do not reuse a Pages Edit token or the protected production promotion credential.
- On the old Mac checkout, the known local `deploy-atmos.sh` entry is retired with an
  immediate refusal; its bake no longer has a Pages fallback and defaults to nonpublishing.
  The launch definition is disabled and explicitly sets `PUBLISH=0`. These are local
  protections, not changes to the active GitHub R2 maintenance pipeline.
- Before enabling a release, read back `ui-production`: Andrew must remain the required
  reviewer, administrator bypass must be off and protected-branch deployment policy must
  remain enabled. Only that environment may hold the dedicated production Pages token.
  No agent or scheduled task may submit an approval on Andrew's behalf.

This follows the standard protected-environment approval, least-privilege credential and
immutable-artifact promotion pattern. It is not a claim that a Cloudflare/GitHub account
administrator cannot alter controls or deploy with a separate privileged credential.
Audit account-level access separately; keep production credentials out of normal developer
and staging jobs. Removing a GitHub secret entry does not revoke the underlying provider
token or any independent local OAuth session. Those require their own scoped access review.
