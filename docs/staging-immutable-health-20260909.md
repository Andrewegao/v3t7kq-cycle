# Staging catalog-qualified UI preflight

## Scope

Staging qualification must bind its native-viewport health evidence to the exact
immutable catalog used by its model-index probes. A mutable alias can change between
requests; existence of an object is not a replacement for catalog quality evidence.

`publicModes` now requires staging's shared/configured data source, an available safe
catalog ID, and both core native-viewport flags. It reads ECMWF and GFS indexes through
that ID and rejects MIME, source, authority, model, schema, or run-identity mismatch.
The production health contract and mutable production probe are unchanged.

This changes qualification tooling only. It adds no browser requests, runtime memory,
Worker deployment, data publication, credential, environment change, or workflow pin.

## Evidence

- Red tests reproduced the previous missing catalog check and mutable staging path.
- Root rerun: `node --test tests/ui-*.mjs` — 143 passed, zero failed.
- Live read-only staging immutable preflight passed after the isolated health repair.
- Current point preflight passed four probes across two locations.
- Production workflow and controller pins have no diff; `git diff --check` passed.

## Release status

This is a reviewed local change, not a merged or deployed controller. Existing staging
release fuse #191 remains open. The health-schema cause of the prior rollback is fixed,
but a subsequent full read-only site check found all composed-hazard freshness flags
false. That must be diagnosed and a fresh candidate validated before clearing the fuse.
Do not interpret these focused checks as a full successful UI release or as protection
for proprietary computation that remains in a separate unmerged change.
