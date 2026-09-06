# Staging release-roster core profile

`release-roster-core-v1` is an explicit staging-only UI profile. It enables the
existing AIFS and HRRR choices and consumes the independently admitted regional
release roster without embedding the expired hash-selected experiment asset.
The production promotion path rejects this profile before Cloudflare operations.
Account UI remains off; no local weather model base is admitted.

Dependency: Atmos commit `ed8065275eefa5e6e530ce37d1133a3baf1026c5` (PR150), or its
descendant on master. Source ancestry is checked before building. Existing ordinary
and hash-selected profile guards remain unchanged. The pipeline digest binds the
exact profile and browser checker as well as its other reviewed policy files.

After source and controller review, staging approval must explicitly set
`UI_STAGING_CORE_PROFILE_APPROVED=release-roster-core-v1`. This document does not
activate that setting or dispatch a deployment. The data reader must be healthy
first. UI releases remain manual; a bake does not publish UI.

The built-site gate checks AIFS Wind and HRRR Temperature, map/point run identity,
finite values, changed weather pixels, HRRR domain boundaries, rapid switching,
browser errors, and each regional menu entry against the same independent-catalog-or-
release-roster admission policy as the app. A valid, fresh same-origin component catalog
may supersede an older release-roster row; malformed authoritative catalog metadata
refuses that model rather than falling back to the roster.

Core raster readiness is a paint receipt, not a scheduled Deck layer. After each model
selection the gate fixes the test camera, activates the field afresh, and requires an
accepted completed Deck generation bound to the exact model, run, immutable base,
cursor, current intent and camera. The OFF capture likewise requires a newer completed
generation with authored zero opacity or removal. The visible pixel-change threshold is
unchanged. A screenshot is retained only when the same completed identity is valid
immediately before and after that capture; a raced capture is discarded and retried
within a fixed bound. Failed runs retain the secret-free browser receipt beside rollback evidence,
so independent per-model errors are not reduced to the wrapper assertion.
Regional absence must not hide healthy peers. Its menu checks are not a claim
that every regional layer and expanded forecast has been qualified: the full
eleven-model live acceptance matrix remains separately required by the owner goal.

Evidence: all existing UI controller tests pass with the new profile, including
production rejection, independent probe failure reporting, hourly HRRR cycles,
domain-error schema, source ancestry and receipt validation. Workflow lint passes.
No cloud settings, active bake, production data, or production UI were changed.

2026-09-06 repair verification: the old checker also failed on restored staging
`git-e0d4af2b831d-run-34011687277`, not only on the attempted rollout. Its roster-only
expectation wrongly excluded AROME despite a fresh catalog component, and its HRRR
props-only wait could capture the preceding model before regional camera movement.
The original failed run 34022427736 did not retain row details, so these are reproduced
control defects, not an assertion that its lost receipt contained no other errors.
The repaired gate passed a credential-free local run against that real restored site:
AIFS Wind and HRRR Temperature with exact completed draws, pixel ratios 1.0 and
0.9993748, finite same-run point values, HRRR outside-domain refusal, all seven regional
menu entries, and rapid AIFS-to-HRRR switching. The resulting receipt also passes the
independent publisher validator. Catalog was `127-a0a24801-2d48-4359-9fba-badcfcee21fa`.
All 88 UI controller tests pass. Same-generation redraws and newer completed generations
are covered separately; a scheduled but undrawn newer generation remains rejected.
This validates the test repair; it does not itself deploy the new UI candidate.
