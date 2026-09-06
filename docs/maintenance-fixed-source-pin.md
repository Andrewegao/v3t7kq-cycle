# Fixed maintenance source activation

Pin whole maintenance, the two reusable collectors, the paired independent
publisher and the existing core notifier lane to Atmos
`d8cd45d123f60c30c413c14d46f68113e37468b7` (PR #164). The source fixes the
generated-baseline checkout rejection. Cycle #168 already removed unused
whole-checkpoint restore. This is data-source activation, not UI deployment.

The four-workflow artifact source closure moves together. Collector input bytes
and scientific adapters did not change from `3f747957`; new invocations still
carry their actual new source SHA, never relabeled old receipts. Source review
confirmed raw core seal/install uses manifest validation before native bundle
construction, while final component publication requires the native bundle.
An independent synthetic real-format check verified raw admission, refusal of
premature publication, then acceptance after the real native builder, retaining
older non-native history. No publication rule is weakened.

Activation order: wait for old-source independent publishers to finish, verify
the exact merged source CI, merge this reviewed controller change, and set the
protected production environment's `CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA`
to that same SHA. No changes to either enable flag, schedule, per-model locks,
Workers, UI controllers, Pages settings or catalog data pointers are included.
Do not dispatch another full collection merely to recover already published models.

The narrowly scoped manual retained-publication recovery still names original
run 34000676897/source3f747957 and deliberately cannot replay those artifacts
under the new source. It is historical after the original recovery finishes.
Future schedules continue all eleven independent collections/publications at
02:30, 08:30, 14:30 and 20:30 UTC, preserving truthful per-model outcomes.
