# Staging catalog-qualified UI preflight

## Scope

Staging qualification must bind its native-viewport health evidence to the exact
immutable catalog used by its model-index probes. A mutable alias can change between
requests; existence of an object is not a replacement for catalog quality evidence.

`publicModes` now requires staging's shared/configured data source, an available safe
catalog ID, and both core native-viewport flags. It reads ECMWF and GFS indexes through
that ID and rejects MIME, source, authority, model, schema, or run-identity mismatch.
The production health contract and mutable production probe are unchanged.

Root review found that candidate-only quality checks must not run during exact
rollback. Explicit preflight/candidate/rollback phases now preserve old rollback
compatibility: health, auth, billing, shared-reader, mutable catalog authority and
ledger authority remain mandatory; only new-candidate catalog/native qualification
is omitted during rollback. Production keeps its old probes in all phases.

This changes qualification tooling only. It adds no browser requests, runtime memory,
Worker deployment, data publication, credential, environment change, or workflow pin.

## Evidence

- Red tests reproduced the previous missing catalog check and mutable staging path.
- Root rerun: `node --test tests/ui-*.mjs` — 143 passed, zero failed.
- Rollback regression reproduced before the phase fix (two failures); independent
  and root final batteries after the fix: 147 passed, zero failed. Live read-only
  preflight, candidate and rollback data proofs also passed.
- Live read-only staging immutable preflight passed after the isolated health repair.
- Current point preflight passed four probes across two locations.
- Production workflow and controller pins have no diff; `git diff --check` passed.

## Bounded staging cache convergence

The staging candidate alone receives 50 attempts at the existing 15-second spacing,
still requiring three consecutive healthy observations. This covers an inherited
600-second hazards cache lifetime, the 60-second cache-only recovery window, and two
additional successful observations. It does not relax freshness or turn exhaustion
into success: failure still reaches the automatic rollback guard. A staging-only
15-minute GNU timeout terminates the entire read-only verifier process group, so
network deadlines cannot consume the 45-minute job and prevent rollback. Production
and rollback retain their original commands and attempt policy. The regression was
red before the change. The Linux process-group test must pass in CI; it is not claimed
as exercised on this macOS host, which has no GNU timeout.

The owner approved qualified merges and a staging-only deployment on 2026-09-09.
The accompanying Atmos hazards repair is PR #196; private-boundary draft #195 is
excluded. The release fuse may be reset only after recording the diagnosed causes
and fresh candidate validation; this document does not bypass that guard.

## Release status

This is a reviewed local change, not a merged or deployed controller. Existing staging
release fuse #191 remains open. The health-schema cause of the prior rollback is fixed,
but a subsequent full read-only site check found all composed-hazard freshness flags
false. That must be diagnosed and a fresh candidate validated before clearing the fuse.
Do not interpret these focused checks as a full successful UI release or as protection
for proprietary computation that remains in a separate unmerged change.
