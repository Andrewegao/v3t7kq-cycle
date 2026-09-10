# Staging place renewal, 2026-09-10

Owner requested automatic surf/paragliding/tide renewal, then ADS-B integration checks and investigation of the missing point wind-energy tab. Production publication, Worker configuration and production credentials are out of scope.

## Acceptance

1. A reviewed scheduled workflow collects real new surf/tide forecasts and runs the existing complete producer/consumer/roster/coverage qualifier before publication. No extension of forecast source timestamps.
2. Paragliding renews the access lease of an exact authenticated, attributed static snapshot. It makes no new survey/freshness claim and does not poll the provider.
3. Families fail independently. Failed collection/proof/remote readback leaves the previous pointer unchanged; expired data remains explicitly unavailable. Updates use immutable objects, completion records and a compare-and-swap pointer.
4. Only the fixed staging bucket and three staging namespaces are writable. No UI or Worker deploy, production writes, plaintext source/data artifacts, or credentials in collection/qualification subprocesses.
5. Source SHA, controller closure and policy are pinned/reviewed. The recurring lane has its own enable switch and does not relax the existing manual seed approval lane.
6. Verify failure cases locally, run fresh CI, review and merge, enable staging-only renewal, run each family successfully, and check served identities/freshness plus unchanged production. Record actual hosted timings and scheduled execution separately from manual qualification.

## Work packages

- Parent: scheduled controller, explicit policy, failure tests and rollout coordination.
- Explorer: exact fresh-collection recipes and dependencies; reuse existing producer and qualifier contracts.
- Independent explorer: missing wind-energy tab execution path and history.
- Independent explorer: ADS-B PR210 conflicts, gates and provider restrictions. No standing provider collection until access/budget requirements are settled.

## Performance boundaries

Reuse existing bounded streaming publication (eight in-flight payload operations), not whole-dataset browser loading. Collect only on an appropriate per-family cadence; retain immutable identities and avoid re-uploading static PG payloads. Do not claim a measured memory or latency improvement before measurement. Provider/download and Actions costs must be included in cadence selection.

## Implementation status

The scheduled controller, source/closure policy, fresh surf/tide collector, failure
tests and workflow are implemented locally. Explicit Node 22 qualification passed for
the retained 11,503-site paragliding snapshot and the fresh
`surf-2026091012-8c8598ee6239` candidate (50 objects, 496,682 bytes, real source expiry
2026-09-11T06:00:00Z). The local broad staging suite, Python 3.12 collector tests,
workflow lint and Linux CPython 3.12 dependency hash resolution pass. A local Node 18
run is unsupported and fails before tests that import Node 22 module hooks; hosted CI
already pins Node 22.

Automatic renewal remains disabled and no staging or production write has occurred.
Remaining work is the real tide collection/qualification result, independent review,
fresh hosted CI, merge, staging-only variable enablement and manual per-family run with
served identity/freshness checks plus an unchanged-production readback. ADS-B and the
missing wind-energy tab remain separate follow-on work packages.

Independent review closed three defects before activation: tide expiry now uses the
earliest event/sample coverage end across every station; all qualification Python
executes with isolated module imports; and the minimum six-hour freshness horizon is
rechecked immediately before conditional activation after remote readback. Fresh Node
22 verification has 250 passing tests, zero failures and two existing skips; the Python
collector has six passing tests. No runtime/UI code changed.

The first real tide pass retained 2,370 valid products but only 1,169 complete stations,
below the unchanged 1,251 minimum. Its frozen checkpoint is being resumed through the
pinned producer for missing products only. This is not a successful qualification yet.
