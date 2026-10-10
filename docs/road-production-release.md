# Road production release

`road-production-release.yml` publishes an exact Atmos master SHA to `https://road.weatherx.org`
(Cloudflare Pages project `weatherx-road`). Before this workflow, Road was shipped only by the
owner-local Atmos script `ops/platform/deploy-road-shell.sh`. The last release was
`c6d67b56`, built on 2026-08-29.

The Lab UI pipeline (`ui-staging.yml` → `ui-release.yml`) never builds Road. Its controller
forces `VITE_PRODUCT=lab`. This workflow keeps that pipeline's credential split and its
encrypted transport, and reuses the Atmos release guard unchanged.

## Jobs

1. **`build`** (environment `atmos-source-read-ui`). It holds the read-only source key
   `ATMOS_READONLY_KEY` and the public key `UI_BUILD_PUBLIC_KEY`, and no Cloudflare or decryption
   credential.
   - It requires `UI_BUILDS_ENABLED=true`, the exact SHA reachable from `origin/master`, and a
     source that descends from the one `road.weatherx.org/health/release.json` serves now. A Road
     release cannot move backwards.
   - It builds exactly as `deploy-road-shell.sh` does:
     - copy `app/public` without `/data/` and `/data-atmos/`;
     - `ATMOS_CODE_ONLY_BUILD=1 ATMOS_ROAD_PUBLIC_RELEASE=1 VITE_PRODUCT=road VITE_APP=road VITE_PLATFORM_ACCOUNT=0 VITE_PLATFORM_DATA_AUTH=public npm run build`;
     - refuse any data archive;
     - install `app/pages-routes.road.json` as `_routes.json`;
     - write the receipt with the same exported profile.
   - The build adds the ground package scope `WX_GROUND_QUALIFICATION_SCOPE=staging-qualification-only`.
     The Atmos build lanes (CI, the Road preview and Lab staging) set it too. Without it, the
     current Atmos ground package guard refuses the build. The local script predates that guard.
   - Pages Functions are compiled once, like the Lab build, into `_worker.js` with the locked
     Wrangler and compatibility date `2026-06-23` (`app/wrangler.toml`). The build refuses if that
     date changes.
   - Every file passes the public-artifact rules of `tools/ui-candidate.mjs`: no source maps, no
     source, config or data paths, and no credential signatures.
   - The output is encrypted (`WXRB1`), because this repository and its artifacts are public.
     Retention is one day.
2. **`transfer`** (environment `ui-staging`). It holds `UI_BUILD_PRIVATE_KEY` and
   `UI_CANDIDATE_KEY`, has no Cloudflare credential, and makes no source checkout. It decrypts the
   build and re-validates every byte. It binds the envelope to this run, attempt, Cycle SHA and
   Atmos SHA, then reseals it as a Road candidate (`WXRC1`). Road envelopes use their own magic
   and authenticated data, so Lab and Road artifacts can never be read as each other.
3. **`release`** (environment `ui-production`, required reviewer). It holds `ATMOS_DEPLOY_KEY`,
   `UI_CANDIDATE_KEY` and `UI_PRODUCTION_PAGES_TOKEN`.
   - It checks out only the exact source's `ops/release/` and the Wrangler lockfile. It never
     builds or executes candidate source.
   - It applies the Lab activation gate: `UI_RELEASES_ENABLED`, `UI_ISOLATION_APPROVED` and
     `UI_DEPLOYMENT_HOLD_UNTIL`.
   - It unseals and restores the exact bytes and refuses if `road.weatherx.org` changed since the
     build.
   - It records the project's stored production configuration by name: compatibility date,
     variable, D1, KV and R2 names. It requires production branch `main` and Git-triggered
     production deploys off.
   - It runs the Atmos `guard-pages-deploy.sh` from an empty directory, like the Lab release, with
     `--no-bundle` and the locked Wrangler. The guard:
     - re-verifies the receipt against the bytes;
     - pins `RELEASE_GUARD_EXPECTED_GIT_SHA`;
     - checks the release fuse;
     - snapshots the last-good deployment;
     - uploads, then runs `verify-road-production.sh` against the expected release ID, index and
       shell digests;
     - on failure, restores that exact last-good deployment, verifies it, and opens the
       `weatherx-road` release fuse (GitHub issue).
   - A final step binds the guard's success receipt to the candidate.

Because the upload runs outside `app/`, `app/wrangler.toml` is not read. The deployment uses
`weatherx-road`'s stored project configuration, the same way the Lab release treats
`atmos-platform`. The recorded `project-before.json` shows which bindings that is.

## Runbook

```sh
SHA=<exact Atmos master SHA>
gh workflow run road-production-release.yml -R Andrewegao/v3t7kq-cycle --ref main \
  -f atmos_sha=$SHA -f confirm=RELEASE-ROAD:$SHA
```

Wait for `build` and `transfer`, then approve only that run's `ui-production` deployment. The
artifact `road-production-release-<run>-<attempt>` holds:

- `project-before.json`;
- the guard success receipt;
- `release.json` (source, release ID, index digest, artifact digest, previous and new Pages
  deployment IDs);
- any incident.

If the guard reports `restored-and-verified`, Road is back on the prior deployment and the fuse is
open. Review the incident, close the fuse issue, and only then dispatch again. Any other incident
status means inspecting `weatherx-road` in Cloudflare before anything else.
