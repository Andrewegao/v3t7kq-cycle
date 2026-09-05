# Paired point route activation — Phase 2

This lane adds exactly `weatherx.org/api/v1/point-series/*` to the existing
`weatherx-data-edge-production` Worker. Cloudflare's more-specific route wins
over the existing platform `/api/v1/*` route; that wildcard is preserved intact.
No Worker upload/deployment, Pages/UI change, schedule, settings, secret, weather
bake or data publication is performed. There is no no-script placeholder route.

## Prerequisites

- Phase 1 finished: the full compatible data reader is active, with its exact
  merged source SHA, version UUID and server script ETag taken from the reviewed
  Phase 1 receipt. An active read-only fallback is not eligible.
- A real current catalog contains both ECMWF map/point components and both GFS
  map/point components. Their generation times, point run IDs and newest map runs
  agree; canonical mounts, component manifest hashes and source validators pass.
- Each point descriptor has more than 30 minutes of freshness remaining. Actual
  retained chunks decode finite temperature/wind forecasts for Beijing, Shanghai
  and Chicago. Partial, stale, fallback or wrong-catalog results are rejected.
- Separately, the actual expanded-card request asks for eight variables over a
  14-day window, including `runFallback=current` as the app does. It still must
  serve the exact map run without fallback, preserve source identity, units,
  cadence and valid sample times, and contain finite temperature. Missing optional
  fields are accepted only as explicitly recorded `partial` results; requesting
  14 days does not assert that the model supplies 14 days of coverage. The six
  app-shaped results and missing fields are retained separately as `uiRows`.
- The complete Worker/settings/route/Pages boundary is reviewed and unchanged.
  Only already provisioned read authority is used; no new credentials are created.

Use the manual workflow with `ACTIVATE-POINT-ROUTE-ONLY`, exact source/version/ETag
and reviewed boundary digest. Zeroes print the observed digest and refuse before
mutation; do not approve it without reviewing the state. Source dependency install
and local reader qualification are not a Worker build/deployment.

## Consistency and ownership

Map proof uses the real reserved `/data/_catalog/<id>/<model>/index.json` address
and requires the response's catalog header. The point API has no catalog-pin
parameter: proof captures a coherent snapshot, requests its exact model run,
requires the catalog ID in `X-WeatherX-Release` and response body, and compares
numeric payloads to the actual source decoder. It reads the pointer again after
qualification. Bounded retries allow a 30-second pointer cache to catch up, but
never accept old or stale data. Three live qualification rounds are required.
This is API/source equivalence, not browser acceptance: after activation the
expanded forecast must still be checked in a real browser before claiming the
reported screenshot experience fixed.

The receipt is atomically persisted with create intent before POST and the exact
acknowledged route ID after POST. Recovery can delete only that recorded ID if
its entire tuple is unchanged, it was absent before, and source/UI/platform/
route boundaries still match. A lost POST response is **not** ownership proof:
if no ID was acknowledged, a newly matching route requires manual review rather
than inferred deletion. Lost DELETE responses are reconciled by route absence.

Cloudflare route APIs have no atomic CAS. The shared data-edge workflow lock and
immediate rechecks detect known drift, but do not claim protection against an
arbitrary operator changing the same route between the last check and DELETE.
Detected foreign changes are refused, not overwritten.

## Configuration follow-through

After separately approved Phase 2 activation, add the same one route to Atmos's
reviewed `production-serve.routes` in a separate data-only configuration PR.
Otherwise a future trigger reconciliation could remove it. Do not change the
platform wildcard or bootstrap/shadow configurations. This lane supports a
reviewed source config containing either the original four data routes or those
four plus this exact point route; its before/after expectation is explicit.

Component manifests commit an inventory hash but do not embed per-object records.
This cutover verifies actual hashed component manifests, pinned map byte parity,
strictly decoded point chunks, current catalog/run coherence and freshness. It
does not replace existing producer scientific/inventory qualification gates or
claim a fresh whole-bucket inventory audit.
