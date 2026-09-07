# Production-safe UI controller alignment

Owner request: qualify the current staging application's source with production-safe build
flags, then promote the exact qualified artifact and verify production (2026-09-07).

The baseline controller a58eff required the old English title and predated the native weather
paint proof used by the current UI. Run 34130893385 was cancelled during build, before deployment,
after static inspection showed it would reject the canonical Chinese title.

Baseline staging and production now select the already staging-qualified controller
`b64f31a1388e8104c18a65a445d156070de5087b`. The production checkout also uses the current
private repository owner. This is not a move to application master. The controller delta is
limited to the canonical title contract, exact native/Deck paint tests, and their tests/docs.
Guard/fuse, upload, authentication, dependency lockfiles, point/feed checks and rollback code
are unchanged between these controller revisions.

The baseline profile remains mandatory for production. Experimental sprite/static compression
and staging selections remain prohibited. No credential, approval, configuration digest, data
publication, Worker, or DNS changes are included. A new successful staging qualification is
required because the pipeline fingerprint changes; old artifacts are not reapproved.

Verification: a workflow regression fails with the old baseline pin and passes with the
aligned immutable pin. Run all UI contracts and actionlint before merging. Final staging and
production workflow outcomes remain separate deployment receipts; this change alone deploys
nothing. Andrew must personally approve the protected production environment.
