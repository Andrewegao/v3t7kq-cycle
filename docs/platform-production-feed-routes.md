# Production feed route repair

This one-time workflow repairs two missing zone routes for the already active production
Platform Worker: `weatherx.org/api/usgs/*` and `weatherx.org/api/hazards`. The exact
Atmos master source is `7497b9815f1f5ca657cda8ed24ad5894afa267e0`. The Worker
declares both routes, but Cloudflare version activation did not attach them. The
guarded UI promotion in Cycle run 35939657856 caught the missing four-feed hazard
contract after deploying Pages and verified its rollback to the prior Pages version.

Dispatch `platform-production-feed-routes.yml` on Cycle main with confirmation
`ATTACH-PRODUCTION-FEED-ROUTES`; approve only that run's protected `production` job.
The workflow reads the full zone route inventory, refuses any pre-existing owner of
either exact pattern, and uses only the dedicated route token. It attaches USGS first,
then composed hazards, recording each returned route ID. It checks that all unrelated
routes remain identical, production account health still has purchases closed, USGS
returns its JSON contract, and the hazards response comes from the scheduled Worker
with the four-feed contract. The live proof allows a bounded two-minute propagation
window after route creation; it never accepts an HTML Pages fallback or an old
three-feed response. A failed proof removes only route IDs created by this run;
an uncertain create response is left for manual inspection instead of speculative
deletion. No Worker version, Pages artifact, data, secrets, or billing state changes.

After a successful route receipt, rerun the exact qualified Pages promotion using
staging run 35937089350, Atmos source 14e1e2579c2ebe0c0e0236c53623a491f110cce3,
artifact digest c8518e3b0ad4dcb5032420767b5a9ef0efa8f66a84e4a7bbda7d15721ddc53dd,
and profile `production-account-ru-kk-wind100-intro-v1`. The UI release fuse issue
from the failed attempt must be reviewed and closed only after the route proof passes.
