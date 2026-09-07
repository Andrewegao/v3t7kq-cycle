# Production-safe UI controller alignment

Owner request: qualify the current staging application's source with production-safe build
flags, then promote the exact qualified artifact and verify production (2026-09-07).

The baseline controller a58eff required the old English title and predated the native weather
paint proof used by the current UI. Run 34130893385 was cancelled during build, before deployment,
after static inspection showed it would reject the canonical Chinese title.

Baseline staging and production now select the locally validated controller
`25c402db5149daa018e349a34a4beeba1f2dca45`. The production checkout also uses the current
private repository owner. This is not a move to application master. The controller delta is
limited to the canonical title contract, exact native/Deck paint tests, and their tests/docs.
Guard/fuse, upload, authentication, dependency lockfiles, point/feed checks and rollback code
are unchanged between these controller revisions.

Run 34132184403 used b64f31a1 and restored staging after its strict Wind proof rejected
the snapshot. That controller accepted any positive fade opacity as ready, then required
exact .96 in the following proof; it also predated the candidate's opening-owner wait.
25c402db is b64f31a1 plus only that existing opening wait, actual parent/bitmap .96 readiness,
a fresh readiness wait before every snapshot, regression tests and a task note. No strict
pixel, completed-draw, identity or source-byte assertion was relaxed. A deterministic .49
readiness regression failed before the fix and all 90 probe contracts pass afterward.
The exact rejected preview passes the full gate under CPU×6/software GL; the broader local
ready lane passes. Local checks do not replace the new cloud staging qualification.

The baseline profile remains mandatory for production. Experimental sprite/static compression
and staging selections remain prohibited. No credential, approval, configuration digest, data
publication, Worker, or DNS changes are included. A new successful staging qualification is
required because the pipeline fingerprint changes; old artifacts are not reapproved.

Verification: a workflow regression fails with the old baseline pin and passes with the
aligned immutable pin. Run all UI contracts and actionlint before merging. Final staging and
production workflow outcomes remain separate deployment receipts; this change alone deploys
nothing. Andrew must personally approve the protected production environment.
