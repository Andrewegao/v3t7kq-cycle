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

## GDACS repair Worker routes and their retirement (F4, 2026-10-10)

### How the repair Worker got its routes

- **2026-08-31, cycle run 33355389976** (`gdacs-feed-release.yml` at `63fe091`). The one-time
  bootstrap created `weatherx-gdacs-feed-production` from Atmos `wrangler.gdacs.jsonc`
  (`routes: []`, no bindings, no crons). It then attached three routes by API. GDACS had
  started rejecting the old multi-event MAP request, and the platform Worker did not yet own
  any feed path.
- **2026-09-03, an owner-machine maintenance script.** Recorded in
  `docs/platform/gdacs-api-repair-20260903.md` in Atmos. It uploaded repair version
  `7f59fd78-1e8c-4690-8d27-c1ecc4c7cd2d` from Atmos `9e69105886d` (the new `api.gdacs.org`
  host) and added a fourth route, `weatherx.org/api/tc/list*`.
- **Later.** The platform Worker gained the GDACS SEARCH crawl and declared
  `weatherx.org/api/gdacs/*` and `weatherx.org/api/tc/*`, which are attached. The bootstrap is a
  one-time absent-Worker lane, so nothing ever removed its routes. They are more specific
  than the platform wildcards, so Cloudflare keeps sending the four paths to the frozen bundle.
- **Why the release check missed it.** `platform-worker-production-release.mjs` only compared
  the routes owned by the platform Worker with the routes it declares, so a foreign, more
  specific route looked clean.

### The four routes

From plan run 38025285361, `routes-before.json`. All four belong to `weatherx-gdacs-feed-production`:

| Route ID | Pattern | Falls through to (platform Worker) |
| --- | --- | --- |
| `09f9904da861456e8aa137519ab67c77` | `weatherx.org/api/gdacs/list*` | `weatherx.org/api/gdacs/*` (`f76cca2bbc6e454d88d865827aa535f5`) |
| `704e2f1ea00a45829008b303ae75894c` | `weatherx.org/api/gdacs/geom*` | `weatherx.org/api/gdacs/*` (`f76cca2bbc6e454d88d865827aa535f5`) |
| `e5aaf75591dc428b910ba443dc76d110` | `weatherx.org/api/tc/list*` | `weatherx.org/api/tc/*` (`d495776b49d941cd8b27a6299e5e02c2`) |
| `568f224b50a3416eaee92c7a1ac14cfc` | `weatherx.org/api/tc/geom*` | `weatherx.org/api/tc/*` (`d495776b49d941cd8b27a6299e5e02c2`) |

### What changes for users, and what does not

Read publicly on 2026-10-10:

- **Production `/api/gdacs/list`** carries `x-weatherx-feed: weather-feeds-v2` and no
  `x-request-id`, so the repair Worker answers it. It returns 100 EVENTS4APP rows, including
  TC rows, for example EQ 53 / WF 43 / TC 4.
- **Staging `/api/gdacs/list`** carries `x-request-id`, so the platform Worker answers it. It
  returns the SEARCH crawl of FL/WF/DR/VO/EQ with no TC rows: 253 to 275 events, including
  floods, droughts and volcanoes.
- **`/api/tc/list`** has the same count on both (152).
- **`/api/hazards`**, which the map reads, already comes from the platform Worker's scheduled
  composition on production. It includes FL/DR/VO, so the map layer does not change.
- **Nothing else depends on the repair Worker.** It has no bindings, so it cannot read or write
  R2, KV or D1, and no crons, so it never runs on its own. The platform Worker's scheduled job
  writes `runtime/hazards/v1/gdacs-search.json` (since release run 38025485148; the repair Worker could not).
  Production `/api/gdacs/list` on the platform Worker serves through that R2 selection, so
  after the retirement a cold PoP does not need its own crawl.

### Retirement workflow

`gdacs-route-retire.yml` only changes routes. It never touches a Worker version, secret, cron,
data or Pages, and it never deletes the repair Worker. It runs in the `production` environment
and shares the `weatherx-production-data-edge` concurrency group with the platform Worker
release. Each step holds at most one credential: the Worker read token for version reads, the
route token for route steps, and nothing for the public checks.

Every run, in both modes:

1. **`versions-before`** reads the active version of both Workers.
   - The platform Worker must be tagged `production-<atmos_sha12>`, so the verifier and the
     declared fallthrough come from the source that actually serves.
   - The repair Worker must have no crons and no bindings.
   - The platform Worker must have no service binding to the repair Worker.
2. **`plan`** (read-only) checks the route table.
   - The four pinned IDs must exist with the exact pattern and script.
   - The repair Worker must own no other route.
   - The new overlap check must flag exactly these four and nothing else.
   - After removal, every probe path must fall through to exactly one platform route, and that
     route must be declared in `wrangler.jsonc` at `atmos_sha`.
   - The job summary prints the exact `retire` command.
3. **`live-before`** proves production is healthy and still served by the repair Worker. It runs:
   - the provenance probes;
   - the list contract;
   - the unchanged Atmos `ops/release/verify-weather-feeds.mjs`;
   - platform health, USGS and the scheduled `/api/hazards`.

`retire` then:

1. **`detach`**
   - Requires the active versions to equal `expected_platform_version` and
     `expected_repair_version` from the plan. The confirmation is bound to the platform version.
   - Re-reads the routes and refuses any drift from this run's plan.
   - Records intent, then sends `DELETE` for each pinned ID in turn. A lost response is
     reconciled by reading, never by a second DELETE.
   - After each delete, the remaining route table must equal the plan minus the IDs removed so far.
2. **`live-after`**
   - Waits up to 3 minutes for every probe path (`/api/gdacs/list`, `?guard=query`,
     `/api/gdacs/geom`, `/api/tc/list`, `/api/tc/geom`) to carry the platform Worker's
     provenance.
   - Then requires 3 consecutive rounds, 15 seconds apart. Each round checks:
     - the `/api/gdacs/list` count and `x-swr-age` under a day;
     - no TC rows, and every row of kind FL/WF/DR/VO/EQ;
     - `/api/tc/list`;
     - the Atmos feed verifier, with every retired path held to the platform Worker;
     - health, USGS and `/api/hazards`.
3. **`routes-after`** proves the route table is the plan minus the four IDs.
4. **`restore`** runs if `detach`, `live-after` or `routes-after` fails or is cancelled.
   - It re-attaches each detached pattern to `weatherx-gdacs-feed-production`, the same
     pattern to the same script; Cloudflare assigns new IDs.
   - It refuses if another script now owns a pattern.
   - It proves the table equals the plan with only those IDs replaced, and waits for the repair
     Worker's provenance on the probe paths.
5. **`versions-after`** proves neither Worker changed and the repair Worker still exists.

Receipts (`versions-*.json`, `plan.json`, `live-*.json`, `receipt.json`, `routes-after.json`)
are retained for 30 days as `gdacs-route-retire-<mode>-<run>-<attempt>`. They hold only route
IDs, patterns and scripts, version IDs, and public feed counts.

```sh
SHA=34efee01d95942145c6dfc79732278728cef0ddf   # source of the active platform Worker (release 38025485148)
gh workflow run gdacs-route-retire.yml -R Andrewegao/v3t7kq-cycle --ref main \
  -f atmos_sha=$SHA -f mode=plan -f confirm=PLAN-GDACS-ROUTE-RETIREMENT
# Read both active versions from the plan summary or versions-before.json, then:
gh workflow run gdacs-route-retire.yml -R Andrewegao/v3t7kq-cycle --ref main \
  -f atmos_sha=$SHA -f mode=retire \
  -f expected_platform_version=<platform active> -f expected_repair_version=<repair active> \
  -f confirm=RETIRE-GDACS-FEED-ROUTES:<platform active>
```

Stop and inspect, with no retry, if the receipt shows `manual-inspection-required` or
`routes-restored-verification-failed`. A manual rollback after a passed retirement uses the
same patterns:

```sh
POST /zones/<zone>/workers/routes {"pattern":"weatherx.org/api/gdacs/list*","script":"weatherx-gdacs-feed-production"}
```

Repeat that for the other three patterns, using the route token.

### After a week

If `/api/gdacs/list`, `/api/gdacs/geom` and `/api/tc/*` stay healthy on the platform Worker
for 7 days, deleting `weatherx-gdacs-feed-production` is a separate owner step. Until then the
Worker stays deployed, routeless and inert, so the restore above remains one dispatch away.
After the deletion, retire `gdacs-feed-release.yml` and its tools as well.

### Overlap guard

`platform-worker-production-release.mjs routes-before` now records `foreignOverlaps` in
`routes-before.json` and the step result. That is every route owned by another script whose
pattern overlaps a pattern the platform Worker declares. Each one is reported as a GitHub
warning and in a job-summary table. The only reviewed exception is the data Worker's
`weatherx.org/api/v1/point-series/*`. The check reports but does not refuse, because a
code-only release cannot change routes. Before the retirement it lists exactly the four routes
above, and afterwards it should list none.
