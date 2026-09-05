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
browser errors, and each regional menu entry against its own release status.
Regional absence must not hide healthy peers. Its menu checks are not a claim
that every regional layer and expanded forecast has been qualified: the full
eleven-model live acceptance matrix remains separately required by the owner goal.

Evidence: all existing UI controller tests pass with the new profile, including
production rejection, independent probe failure reporting, hourly HRRR cycles,
domain-error schema, source ancestry and receipt validation. Workflow lint passes.
No cloud settings, active bake, production data, or production UI were changed.
