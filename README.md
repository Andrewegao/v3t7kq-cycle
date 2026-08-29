# v3t7kq-cycle

Unattended data freshness loop, on GitHub Actions' free public-repo minutes.
This repo is deliberately thin: one workflow that checks out the private app repo
read-only and runs its own `ops/bake-weatherx.sh` cycle — all bake logic lives with
the app, so the laptop launchd loop and this workflow can never drift apart.

**Cycle (4×/day, ~20 min after each ECMWF publication):**
mirror live data tree → fetch ECMWF/GFS/HRRR → enrich GFS add-on layers → marine +
air bakes → freshness/variable gate vs live → one atomic Cloudflare Pages deploy.
Any failure keeps the live site untouched.

**Secrets**
- `ATMOS_DEPLOY_KEY` — read-only deploy key on the private app repo (configured).
- `CLOUDFLARE_API_TOKEN` — Pages edit token; until it is set, cycles run `PUBLISH=0`
  (bake-only validation, deploys skipped). Create: Cloudflare dashboard → My Profile →
  API Tokens → template "Edit Cloudflare Workers"/Pages, scope to the account, then
  `gh secret set CLOUDFLARE_API_TOKEN -R Andrewegao/v3t7kq-cycle`.
- `CLOUDFLARE_DATA_EDGE_API_TOKEN` — account-owned, expiring credential used only by
  the guarded production data-edge workflow. Scope account permissions to Workers
  Scripts write and Workers R2 Storage read; scope zone permissions to `weatherx.org`
  Workers Routes write and Zone read. The pinned D1 binding does not require D1 API
  access. Never reuse the Pages or scheduler token for this Worker.
- `R2_PRODUCTION_ACCESS_KEY_ID` + `R2_PRODUCTION_SECRET_ACCESS_KEY` — account-owned
  R2 S3 credentials used only by production component publishing, bootstrap, and the
  rollback drill. Grant Object Read & Write on exactly `weatherx-data-production` and
  `weatherx-components-production`; do not grant staging buckets or R2 administration.
  Keep this credential separate from Pages, scheduler, and data-edge deployment.

Data sources are all open (ECMWF open data CC-BY-4.0 via AWS Open Data, NOAA GFS/HRRR/RTOFS).
