# Production Wind100 point reader release

The platform Wind100 selector is live, but the more-specific
`weatherx.org/api/v1/point-series/*` route belongs to
`weatherx-data-edge-production`. Atmos source
`f5dc141ef83f209a4cb7637447f87e1b43da7450` adds its production reader
flag. This manual, protected workflow upgrades that data Worker only. It does
not attach routes, publish or delete R2 objects, deploy Pages or Stripe, or
change purchase availability.

Dispatch `production-wind100-point-reader-release.yml` on Cycle `main` with
confirmation `RELEASE-PRODUCTION-WIND100-POINT-READER`. Approve only the exact
run's protected `production` job after checking its run ID, Cycle revision,
and the pinned Atmos revision. The workflow uses the dedicated data Worker
credential and the shared `weatherx-production-data-edge` concurrency group.

The controller checks the active version, latest settings, exact route
inventory, schedules, subdomain, selector, data health, and base ECMWF point
response. It uploads an inactive version, confirms its bindings, activates
that version, and requires real `wind_speed_100m` samples for the current
production catalog/run/selection. Base wind-speed samples, timestamps,
release, and public health must remain unchanged. The non-secret receipt
records the version identities and point proof.

If verification fails, the controller restores only the prior version when
this run's candidate is still active. A foreign deployment or changed route
boundary requires manual inspection. Check the receipt and live base point
response before retrying. The workflow does not claim Wind100 availability
until the exact point request passes independently after release.
