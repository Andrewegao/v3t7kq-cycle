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
`staging-tc-selections/4f39b84b86bcf3e90bb5e54f8296f7231ddfc74363c5e2830a7324a5327a21c7/selection.json`
(570 bytes, SHA-256
`4f39b84b86bcf3e90bb5e54f8296f7231ddfc74363c5e2830a7324a5327a21c7`).
Its retained manifest preserves the actual `2026-09-10T15:57:55Z` source time;
two storms and eight referenced track objects reproduce the selection's
manifest, component, catalog, object, and inventory digests. They are retained as
the bounded UI fixture and remain `local-prepared-not-published`; their catalog ID
is not evidence that R2 contains the objects. The build fails once the selection
is older than the 18-hour TC window. A later selection requires new reviewed bytes,
a new content digest, and a Cycle commit rather than a mutable workflow input.

The workflow checks out controller commit
`f23664837274fc06a4a94b9bb0fc8d7fa1ee8c58`, the merged, CI-qualified TC build guard and
browser-harness lineage. The candidate source remains an explicit 40-character
input and must equal both its checkout HEAD and `origin/master`; the controller
pin must also be its ancestor. The same exact merged commit is the first eligible
current-master source; a later master must retain this ancestry and still match
the explicit workflow input before any build begins.

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

## Reviewed thumbnail packaging follow-up

The account packaging change on Cycle main `b2b56f9` is explicitly extended to
the TC profile after auditing its actual layer-menu readers. Both paths in
`LayerMenu.tsx` request `.webp`; no TC consumer requests the 60 allowlisted source
JPGs. Other profiles and unknown filenames retain their original behavior. A
missing or symlinked WebP, or an invalid RIFF/WEBP envelope or declared file
length, fails closed before omission. This packaging check does not fully decode
arbitrary future WebP payloads; the actual 60 counterparts were independently
decoded for the source audit below.
The source tree retains every JPG; only redundant deployment copies are omitted.

The local copy audit against Atmos `d6133ff91969c0950f606e89b81193a91378a62a`
omitted 60 deployment copies (3,252,026 bytes), retained 4,687 source files
byte-for-byte, and decoded all 60 WebP counterparts with Pillow 12.2.0. The
5,000-file and 96 MiB candidate limits are unchanged. A complete rebuilt candidate
still requires its own package and browser checks; this copy audit alone is not
an Actions run or deployment. TC proof validation also requires exactly one
1440×1000 and one 390×844 result, rejecting duplicate viewport receipts.

The complete local package for the same Atmos source, built with Cycle
`71c1df7db03be2b32ec3827bffea3531177a26d1`, passed `createCandidate` at
2026-09-10 08:06:51 UTC: **4,948 files / 25,731,680 bytes**, artifact digest
`452930552260040de8fc3c354176e8698b37117e8ae6b8542e7cfb775713735b`.
Its schema-only run ID `900005` is explicitly synthetic local qualification;
it is not an Actions run. The current-master deployment identity guard was not
claimed or bypassed for deployment. No artifact was uploaded or deployed.
Manual real-browser checks on that package confirm decoded runtime menu WebPs,
GFS GEFS30/30 and ECMWF ENS50/50 values with the older-run notice, HAFS-A's honest
no-ensemble state at 390×844, and repeatable three-day cloud replay. Browser
error logs were empty. These manual checks supplement the existing automated
fixture proof; they do not stand in for the workflow's future exact-source gate.
