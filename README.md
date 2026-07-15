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

Data sources are all open (ECMWF open data CC-BY-4.0 via AWS Open Data, NOAA GFS/HRRR/RTOFS).
