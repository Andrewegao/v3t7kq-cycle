# Production point reuse

Status: preparation only. No workflow was dispatched, protected variable changed,
historical object removed or production source activated by this change.

This rollout avoids uploading a second copy of an unchanged point forecast during
a same-run map update. It retains the existing schema-1 point component after
authenticated semantic comparison, complete remote byte verification and exact
inventory checks. The existing map/point atomic promotion and epoch/CAS gates
remain authoritative. A real forecast difference takes the normal upload path;
corrupt or incomplete storage stops publication.

Both current-run per-model publishing and the notifier's `catalog-bake.yml`
production path use `CURRENT_RUN_POINT_REUSE_MODEL`:

| Value | Behavior |
| --- | --- |
| Empty / absent | Ordinary publication; reuse disabled |
| One exact model name | Reuse eligible point forecasts only for that model |
| `all` | Reuse eligible point forecasts for every model in the lane |
| Any other value | Refuse before storage credentials |

Start with one model. Staging catalog publishing remains outside this selector.
Packing, map reuse and per-object map references are explicitly disabled. The
existing production reader can consume every resulting object format.

## Source and controller closure

The Atmos candidate layers the bounded bake-throughput changes onto the reviewed
publisher backport from `d8cd45d123f60c30c413c14d46f68113e37468b7`. The final reviewed SHA must
replace the ordinary producer pin in all six affected workflows: `bake.yml`,
`collect-core-model.yml`, `collect-regional-model.yml`,
`publish-current-model-production.yml`, `catalog-bake.yml` and
`staging-wind100-recurring.yml`. Wind100's policy and exact core-source assertion
must match. Its separately qualified augmenter remains pinned to
`9174329db6ca8527569e67f14ef70406dedefb69`.

Record a Git tree comparison showing unchanged acquisition, model processing,
artifact consumers, dependencies and readers. The source change must not relabel
old artifacts: collectors produce new receipts at the new exact source SHA.
Keep retained manual recovery exceptions unchanged.

Reviewed Atmos source: `6abda80d3c72d955a6bb91cef36ccd161bdddc0f`. All six workflow consumers and
Wind100 ordinary-source policy/assertion pin this commit. Source-delta evidence
and the coordinated controller values are recorded below.

The underlying point-reuse publisher commit is
`48be0a6c7cef9a0c831831952cefd80ce967ad2d`. Its reviewed controller digest is
`0603dfa65a52cb1d2eb69ae8719528bb23d8bc6d7605078e511a3acb5f50d879`.
Immutable Git-tree comparison of all 9,175 union paths passed: exactly 11
allowlisted publisher/helper/test/registry/document changes, 9,164 other paths
unchanged, and a clean source checkout. Protected tree IDs are:

| Scope | Unchanged Git tree |
| --- | --- |
| Model acquisition and processing | `d321df4de8f3718fbf5ddbfe4094f204f0652513` |
| App and point consumers | `d9b4faa0b13e2217dee6c57d016e095747cc0e01` |
| Platform readers | `ff962b0459239fb79909d5db9f7f7219b4cdd9c2` |
| Experiments | `9fcd55827dcf828c913ac6ff805e895fbd3bea5c` |

The complete private source-proof JSON has SHA-256
`7dcf700fbe581bb9e305e24fd1ede591bdb9aa6c5d4660c665545c20723ff51f`.
The [publisher-base diff](https://github.com/weatherx-hq/atmos/compare/d8cd45d123f60c30c413c14d46f68113e37468b7...48be0a6c7cef9a0c831831952cefd80ce967ad2d)
has independent review, all 17 required ready suites, full old-platform checks
(12 Vitest files / 454 tests plus publisher and workerd tests), and strict test
inventory passing. Source/dependency specifications are identical outside the
allowed publisher changes; hosted dependency resolution is not a binary
reproducibility claim.

The [bake-throughput delta](https://github.com/weatherx-hq/atmos/compare/48be0a6c7cef9a0c831831952cefd80ce967ad2d...0335a3b0a85b629c8659032a032bbc5ea0911eff)
changes the GFS frame scheduler, verification builder, their tests and test
registries, plus CI action pins required by repository policy. It imports no
other modern-master runtime behavior. Atmos PR #259 passed all six exact-head
jobs. Cycle qualification run 34694293980 then held the actual production GFS
encoding-stage shape: 25 full 73 × 721 × 1440 float32 arrays, waves enabled and
1,460 PNGs. All hashes were identical across two frozen-serial and two bounded
parallel passes. The serial observations were 50.814 s and 50.078 s; parallel
observations were 24.635 s and 25.076 s (2.03× median). Peak process RSS was
7,323.11 MiB and sampled runner availability never fell below 7,716.71 MiB.
The job had no provider or publication authority.

The [GFS point-stage preservation delta](https://github.com/weatherx-hq/atmos/compare/0335a3b0a85b629c8659032a032bbc5ea0911eff...6abda80d3c72d955a6bb91cef36ccd161bdddc0f)
changes only `data/fetch.py` and its regression tests. When a hydrated same-run
GFS map is already complete and enriched but the private point stage is absent,
the collector now rebuilds only that point/float input and leaves the map frames
and manifest byte-for-byte unchanged. New model runs retain the qualified full
parallel encoding and enrichment path. Atmos PR #262 passed all six exact-head
jobs and the 26-suite ready lane.

The resulting Wind100 controller digest is
`622351183ca6d272abd03c4734638482e5e826c7709a2973946b4412ede0dc0e`.
It must replace the protected `STAGING_WIND100_CONTROLLER_SHA256` value only as
part of the authorized activation after older admitted jobs drain.

Companion local checks pass: 148 Node workflow/controller tests, 27 Python
artifact-handoff tests, and full scheduler check including its deployment dry run.
No deployment command without `--dry-run` was executed.

Read-only preflight on 2026-09-12 confirmed the protected production source is
still `0335a3b0a85b629c8659032a032bbc5ea0911eff`; current-run publishing is
enabled and point reuse selection is `all`. In `data-staging`, Wind100 is enabled
and its approved controller digest is
`5b728f1a312fb58095109d864984269abb33f177d0cd81d0fdac7baf58303ca3`.
Re-read these values immediately before any authorized change; they are a
snapshot, not permission to overwrite later owner changes.

## Activation after owner authorization

1. Review the exact final Atmos commit and Cycle diff and require passing checks.
   Keep point reuse disabled while coordinating the complete source closure.
2. Drain old component, Wind100 and whole-maintenance jobs, including queued and
   pending work and dependent publishers. Updating a variable does not revoke a
   running process which has already passed its gate. Both component lanes use
   the same per-model production lock; the joined maintenance lane has its own
   lock and retains its existing catalog rebase.
3. Land the complete Cycle change and immediately coordinate the protected
   `CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA` and
   `STAGING_WIND100_CONTROLLER_SHA256` values. Mismatched values refuse new
   component or Wind100 publication. The whole-maintenance collector has no
   separate source-approval variable, so the merged pin itself activates that
   lane. No reader, scheduler Worker or storage setting change is required.
4. Select one model and use the existing single-model workflow to qualify a
   genuine same-run native-map update. Record controller/source SHAs, schema-1
   manifests, unchanged point key/hash, changed qualified map, successful atomic
   pair, live point readback and avoided upload counts. A normal new forecast
   with different point bytes is a fallback check, not evidence of reuse savings.
5. Expand to `all` only after successful qualification. Inspect receipts from both
   publishing paths and compare subsequent account usage against publication
   counts and source availability. Do not interpret a failed/withheld publish or
   a missing receipt as savings.

Rollback: clear `CURRENT_RUN_POINT_REUSE_MODEL` and drain already admitted reuse
jobs. Keep the new source; all data remains compatible with the existing reader.
If reverting source is necessary, revert the entire six-workflow/policy closure
and coordinate both protected values. Do not restore only one source pin.

## Cost and research interpretation

The previous representative metadata screen found 21 potential daily reuse
candidates, 86,961 object writes and 13.769 GB. If complete byte proof succeeds at
that rate, the conditional marginal opportunity is approximately $11.74/month in
Class A writes plus $3.10 less storage growth during the first 30 days. Actual
Cloudflare invoices also reflect allowances and rounded billing units.

Ordinary publication already downloads each uploaded payload for verification.
Reuse keeps that verification and adds small manifest/control reads; it does not
introduce a second full point download. Retries and actual request totals need
metered confirmation. This first step alone does not ensure an account bill below
$100. Map duplication remains the larger next optimization.

Successful production jobs can retain a small `point-publication-cost` artifact
for 14 days. It contains only schema version, reuse hit, avoided object PUTs,
avoided bytes and a lower bound on verification object GETs. The GitHub artifact
belongs to the exact run/attempt/model and its pinned source checkout. Failed
atomic promotion never publishes this receipt. Missing metrics mean no
measurement, not zero cost; upload failure does not undo a successful weather
publication. These are logical work counts, not metered Cloudflare requests.

Every historical forecast remains available. Duplicate copies of the same point
forecast add no scientific evidence. Fusion improvement must be demonstrated by
joining preserved forecasts to later observations and evaluating a fixed candidate
on future dates. Storage growth by itself is not evidence of model improvement.
