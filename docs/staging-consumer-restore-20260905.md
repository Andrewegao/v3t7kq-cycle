# Restore staging shared weather reader (2026-09-05)

## Scope and observed regression

The owner confirmed that no other task is updating the staging Worker during
this repair. Only `weatherx-platform-edge-staging` may be uploaded/activated.
There is no production Worker, Pages/UI, R2 object, or schedule write in this lane.

The serving staging version at investigation was
`371277cf-0113-4f9b-91c2-277a31a78d98`. It omitted the previously qualified
shared-read variables and enabled test billing. Its own-copy catalog was 41,
while production's independently published catalog was 95. Restoring shared
read means reading finished inputs through existing read-only S3 credentials,
not adding production bucket bindings or copying/rebaking weather locally.

## Reviewed source and preservation

The source pin is `0aa9fbed9e179ab2ccb6ac456727b9f33124ddb6` (Atmos PR149).
Its only configuration change from master `77487534` preserves the existing
staging `STRIPE_ENVIRONMENT=test` marker. The controller's admitted delta is
`AUTH_MODE=public`, `BILLING_MODE=disabled`, and the complete reviewed shared-read
variables. This explicitly disables the regressed billing mode; it does not
remove secrets or change any production configuration.

Both shared secrets already present are inherited without reading replacement
GitHub secret values. A partial pair is refused; a missing pair retains the
separately checked bootstrap path. Full active runtime, bindings, global
settings, all eight staging routes and schedules are checked before and after.
Version history must prove the serving version is latest before inheritance
and that only this operation's new version was added. This is a concurrency
guard, not an atomic Cloudflare compare-and-swap or proof of secret values.

The independent own-copy activation lane retains its historical decoder pin;
upgrading the shared reader must not silently repin that other workflow.

## Qualification and rollback

Before dispatch, run local controller tests and a GET-only live preflight.
Review its exact active-version and settings digest before setting the staging
environment approval variables; never use placeholders to skip review.
The hosted manual workflow uploads an inactive version, verifies its bindings
and full runtime, checks live ownership again, then activates staging only.
Live qualification requires public/noncommercial shared health, catalog-pinned
ECMWF/GFS manifests, exact requested runs, fresh finite temperature samples and
matching response identity. Freshness follows the existing per-model source
contract. Any failed acceptance restores only this operation's prior version,
unless another publisher has taken ownership, in which case it refuses writes.

## Remaining, deliberately separate

A reader repair does not itself change the older staging UI's model gates.
The baseline UI excludes HRRR/AIFS, and the old seven-model selection is expired.
A separately reviewed staging-only release-roster profile and UI qualification
are required. The successful whole bake contains ten usable model point sets;
NAM-HI remains a real cloud-data recovery dependency. No all-eleven completion
or sub-hour bake claim follows from this repair.
