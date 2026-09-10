# Isolated hurricane guidance publication

This manual lane publishes immutable staging-only TC model data without changing
serving pointers or deploying any UI/Worker. It uses the matching Atmos source
producer and strict validator. Forecast and ensemble availability remain per storm
and source; spread is not a calibrated probability cone.

Before dispatch, qualify one exact Atmos commit and set the protected data-staging
variables STAGING_TC_APPROVED_SOURCE_SHA to it, STAGING_TC_GUIDANCE_ENABLED=true,
STAGING_DATA_ISOLATION_APPROVED=true, and the existing STAGING_R2_ACCOUNT_ID. The
existing staging-scoped S3 write secrets are exposed only to the final publisher.
The source SHA input must equal the protected approved source identity. The job
rejects non-main, scheduled, self-hosted or wrong-workflow execution before private
checkout. It has no default source branch, no schedule, and no production path.

The source bake has provider-specific request/byte/time bounds. The publisher
revalidates its full sanitized inventory, source timestamps, source hosts, storm
identity and ensemble geometry. It writes immutable component objects first,
verifies exact downloaded bytes, writes the component manifest and isolated
catalog, then the selection receipt. It never writes catalogs/current.json,
releases/current.json or a shared-read pin. Partial uploads remain unreachable.

The approved UI build must separately embed the returned exact selection bytes
and SHA under the existing staging-only TC build contract. This workflow does not
activate the UI or modify the shared staging Worker. Coordinate any later shared
staging work with its active owner. A local preparation ID must never be passed
off as a genuine Actions publication run.

## Isolated UI profile

The fixed `release-roster-core-tc-v1` profile is deliberately separate from
`release-roster-core-account-v1`. Atmos rejects TC release flags when
`VITE_PLATFORM_ACCOUNT=1`, while the current shared staging release intentionally
keeps its reviewed account surface. `.github/workflows/ui-staging-tc.yml` therefore
builds an account-off artifact and qualifies it only on loopback. It does not call
the Pages deploy controller, receive a Pages or Cloudflare credential, or change
`staging.weatherx.org`. Its output is an encrypted, non-promotable build plus a
sanitized local browser receipt.

The reviewed input is
`staging-tc-selections/112f801de98c63d2b9017eddecf416e4e83ea673c21ce08001d48a2fca0345c5/selection.json`
(578 bytes, SHA-256
`112f801de98c63d2b9017eddecf416e4e83ea673c21ce08001d48a2fca0345c5`).
Its local manifest and four referenced track objects reproduce the selection's
manifest, component, catalog, object, and inventory digests. They are retained as
the bounded UI fixture and remain `local-prepared-not-published`; their catalog ID
is not evidence that R2 contains the objects. The build fails once the selection
is older than the 18-hour TC window. A later selection requires new reviewed bytes,
a new content digest, and a Cycle commit rather than a mutable workflow input.

The workflow checks out controller commit
`0b5ccc8335b1147b13f4c525a126b82bf026ed88`, the reviewed TC build guard and
browser-harness lineage. The candidate source remains an explicit 40-character
input and must equal both its checkout HEAD and `origin/master`; the controller
pin must also be its ancestor. Atmos master `4ec0b8baa1d33ca56d50e5e9797eca74293bd19b`
did not contain this lineage when the profile was prepared, so it is correctly
ineligible. Local integration `d1ad27cbb268247aef369b0eb806ab5e94ada263`
contains the TC lineage and current master changes but is not called an
Actions-qualified artifact while it remains unmerged.

A local build-only check of `d1ad27cbb268247aef369b0eb806ab5e94ada263`
emitted exactly 5,008 candidate files, which correctly exceeds the unchanged
5,000-file admission ceiling. The redundant baseline source-thumbnail cleanup
must land before this profile can produce an admissible artifact; TC qualification
does not raise the ceiling. The same build passed the isolated browser harness at
1440×1000 and 390×844 with the pinned Lowell manifest and exact GFS/ECMWF track
objects. The harness gives general forecast requests a controlled 503, exercises
the UI recovery card, and then mounts the TC-only surface; the full application
and Weather Lab gates remain separate workflow prerequisites. This is evidence
for the unmerged build candidate, not an Actions run, shared-staging deployment,
or qualification of the general weather data plane.

Required protected approvals are `UI_STAGING_CORE_PROFILE_APPROVED=release-roster-core-v1`
and `UI_STAGING_TC_PROFILE_APPROVED=staging-tc-guidance-v1`. The existing UI staging
workflow, default request, account approval, Pages project, and promotion workflow
are unchanged.

Validation: `node --test tests/staging-tc-guidance.mjs tests/ui-staging-tc-profile.mjs`, the full UI test lane with staging-controller dependencies, and `actionlint .github/workflows/ui-staging-tc.yml`. Tests make no cloud writes.

Prepared during the four-track finish goal on September 10. It has not been
merged, dispatched or enabled. The prerequisite UI injection and exact source
approval remain explicit rollout gates, not claims of completed staging service.
