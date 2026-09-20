# Staging hazard-fallback controller review (`a56ff55a5`)

Reviewed on 2026-09-19 for the protected `ui-staging` account-core, core-roster, and static-compression profiles.

## Decision

Pin the independent staging build and qualification controller to Atmos commit
`a56ff55a5100a911917b62e6388e6ecaaad82b31`. Candidate source must still be the exact current
Atmos master and must descend from the controller; production and baseline controller pins are
unchanged.

## Why the previous pin is no longer compatible

The former staging controller `fac2fc164420d4d31870a410c9a877d16ad76fb0` predates the
resilient hazard fallback contract. Its real-site verifier rejects the structured
`502 application/json {"error":"upstream unavailable"}` response from an unavailable direct
GDACS or TC source even when `/api/hazards` is current and backed by a valid scheduled composite.
Run `35481766168` demonstrated that mismatch: the candidate build passed, but qualification
retried those direct-source 502s for fifteen minutes and rolled Pages back successfully.

The reviewed controller accepts only that exact structured degraded-source receipt, still
requires the composed `/api/hazards` document to be current and structurally valid, and continues
to reject degraded direct feeds in edge-only preflight. Its tests cover all three cases. The
controller also retains the encrypted build handoff, exact-master check, independent publisher,
real-site verification, and rollback guard.

## Scope

This change only advances the independent controller used by non-production staging profiles.
It does not deploy Pages or Workers, alter protected variables, close an incident, or change any
production controller or route.
