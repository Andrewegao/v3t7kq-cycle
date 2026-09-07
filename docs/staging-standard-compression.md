# Owner-approved staging standard-compression release — 2026-09-07

Following rollback incident179, the owner explicitly approved staging using standard Cloudflare
asset compression while retaining the merged opening, lossless sprites and other latency changes.
Production is excluded. This is a new build/profile qualification, not a retry of the rejected
compressed artifact and not a relaxation of the custom Brotli wire checks.

Use the existing protected `release-roster-core-v1` staging profile with exact Atmos master
`1055053838b1841b1ac34746a70ad181c8346720`. The profile now explicitly enables lossless sprites
and requires ancestry of the bug-bashed integration `0eeec07e06e5e48b53d41bf3590218a856432b32`.
Its custom compression flag remains empty even if inherited by the process. Baseline/production
and hash-selected profiles explicitly disable sprites. Source/profile/pipeline digests bind this
change; production still rejects all staging-only profiles.

The core artifact contains no custom compression manifest, sidecars, namespace routes or wrapper.
Normal Pages asset delivery handles HTTP compression; the experimental profile and its strict
wire tests remain intact but are not selected. No settings, credentials, controller pins, data,
Workers or production workflows are changed. Full inventory/hash, staging browser/data gates and
automatic rollback remain required. Lossless sprites must be verified by byte hashes and real
browser requests after deployment; cache headers and compressed application delivery must also
be inspected. No promise of a new measured latency improvement is made here.

Local regression first failed on the old sprite flag and source guard, then passed after this
bounded profile change. Review fresh test/CI evidence before closing issue179 with an audited
resume note and dispatching one staging-only run. Keep the existing old staging release available
for automatic rollback. Do not dispatch production promotion.
