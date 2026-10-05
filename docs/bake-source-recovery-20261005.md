# Whole-data source recovery proposal · 2026-10-05

This local source proposal moves ordinary model collectors and their consumers from Atmos
`7a50f19714f22e04dc610a5aa33d311b7d1dc673` to the qualified merged master
`5e68af94c24517eaaaf6a9d25aec0cadc3d9b135`. It is not an operational approval.
Do not merge, dispatch, or change protected values until independent source review, exact-head
Cycle CI, and the owner's specific production-data activation approval are recorded.
Merging these workflow pins affects the existing recurring production pipeline; absence of a
manual dispatch does not make that merge operationally inert.

## Exact source closure

The whole bake, core collector, regional collector and paired component publisher move together.
The whole bake's encrypted diagnostic names that same actual source. A whole-bake-only change
would reject the collectors' sealed manifests. Both recurring Wind100 workflows also consume
that sealed ECMWF artifact, so their ordinary `CORE_ATMOS_SHA` declarations and policy fields
move with it. The Wind100 scientific backend stays at `9174329db6ca8527569e67f14ef70406dedefb69`,
including its source-closure hashes, geometry, scientific fields, leases and object caps.

The existing source/head/clean-tree checks, run/attempt/artifact admission, original recovery
identities, four-core join, eleven model roster, publication locks, immutable upload/readback,
model nonregression and final pointer/CAS checks remain required. No old receipt is relabeled.
`CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA` and Wind100 controller digest guards remain protected;
this patch neither supplies their values nor bypasses a failed comparison.

## Material Atmos changes being admitted

The source change includes 482 changed paths in the recorded ops/data and selected runtime/
dependency input inventory; that inventory is not the complete transitive app graph. This is
not merely changing three strings. Notable changes include independent atomic METAR/SYNOP/
buoy/OpenAQ producers; three-feed bounded FIRMS with honest thinning/missing-source receipts;
the compact GFS point forecast tail to 336 hours while preserving its 72-hour map budget;
core input, native bundle and baseline validation; and exact-source retirement receipts for
specified stale GEOS-CF or unavailable RTOFS add-ons. Core forecast fields do not become optional.
Producer or API failure can retain old/absent data: successful execution alone cannot prove every
observation family refreshed.

The old Oct5 bake hydrated production `cycle-33979262543` (Sep5), then failed its Weather Lab gate
at 11:16:23 UTC after 133 seconds, before whole-pointer publication. The exact failing assertion
remains in an owner-key encrypted diagnostic, not recovered here. Current Atmos master implements
the documented data/UI split in `docs/OM_EXIT_PLAN.md` §9.5/0F: the four UI checks still run, but
are nonblocking for a data release by default; data/publisher gates remain required. A failed UI
gate withholds the duplicate-bake receipt. This proposal admits that existing source policy;
it does not claim to fix the old assertion. UI code publication retains its blocking UI gate.

Surf and paragliding production pilots remain default-off and are not enabled by these workflows.
NOAA aircraft's production omission remains intentional. Staging places/tides, satellite archive,
catalog-bake's independent source, UI/Worker deployments and all schedules/settings stay outside
this source change. A whole bake cannot restore every layer row by itself.

## Existing scheduled effects and required approvals

The existing 02:30/08:30/14:30/20:30 UTC bake schedule and authenticated external callers remain.
After a merge, fresh ordinary collectors use the new source. Whole maintenance can publish
immutable releases to `weatherx-data-production`, using its existing production environment and
CAS/promotion credentials. Its model rebase, observation/history collection and staging vault
archive/fallback mirror branches retain their existing conditions. It does not deploy UI or Workers.

Read-only GitHub evidence at preparation time shows component publication already enabled, with
protected approved source still `7a50...`; the new paired publisher refuses until an independently
approved exact-source value moves to `5e68...`. The staging Wind100 approved controller currently
names the old digest and must be separately reviewed if preserving that enabled recurring lane.
Production Wind100 and its GC caller flags are currently false: leave them false. Their new source
closure does not authorize activation, retention execution, or digest/readiness setting changes.
Any future production Wind100 activation requires its own newly qualified controller and GC proof.

The concrete protected values and new controller digests are retained in the external
`whole-bake-source-operation-proposal.json`; never copy a digest into an environment as a substitute
for its required qualification. No setting change or manual full-bake run is part of this patch.

## Cost and qualification bounds

Existing workflow limits remain: whole bake 300 minutes, core collector 70 (collection 60), regional
collector 55 (collection 45), paired publisher 90; whole maintenance parallelism 2 and existing
per-model writer locks. Wind100 retains 50,000 prefix objects, 30-hour freshness and a six-hour
minimum forecast lease. Source producers retain their byte/page/rate bounds; FIRMS is bounded at
300 seconds. These are resource/admission limits, not dollar ceilings. New observation feeds and
the GFS point tail add work; no new billed-duration or live-cost measurement is claimed here.

Offline checks verify pin/provenance closure, partial-repin refusal, protected guard retention,
artifact admission, workflow configuration and Wind100 policies. They do not qualify new live
provider bytes, production freshness, all eleven published models, or a production pointer.
Fresh exact-source release evidence and owner authorization remain necessary for live operation.

## Failure and rollback

Preserve failed run/job receipts and the original diagnostic. On a refused or failed publication,
verify the real selected pointers and any immutable upload receipts; do not assume a green collector
means promotion occurred. Do not relax freshness, source, artifact, object or lease gates.

Rollback must revert the coordinated ordinary source/consumer declarations and approved values
together, after respecting active writers and obtaining the same operational authority. Source
reversion alone does not restore a live pointer or hostname. Any actual promoted-data rollback
requires the applicable existing ownership/CAS recovery and exact last-good eligible receipts;
never retag old artifacts, delete unowned objects, or blindly restore the stale Sep5 release.
