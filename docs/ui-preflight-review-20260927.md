# UI release preflight review — 2026-09-27

The last production promotion, run 36324862566, succeeded. Read-only checks in
this review confirmed staging and production still serve Atmos e35540607fcf3fc5731aef610411cd67d2dc482e,
release git-e35540607fcf-run-36323141217, with identical index and shell hashes.
Earlier failed runs remain historical evidence; this review does not rerun them.

## Confirmed defects and correction

The early staging data preflight checked point forecasts but omitted
`/data-atmos/tides/tides.json`, which the final platform verifier requires.
Consequently an expired tide lease could survive the early check, consume the
build lane, and fail only after deployment. The cheap preflight now performs one
credential-free GET to that exact staging alias. It requires HTTP 200, JSON MIME,
a release header, and a nonempty complete body. The staging reader continues to
enforce the lease; the probe does not invent a separate tide freshness policy.

The response is streamed and discarded, bounded to 2 MiB and 20 seconds, without
retaining or logging tide payloads. It shares the existing concurrency budget;
there are no retries or production fallback. The live response during review was
426,054 bytes with identity places-noaa-coops-20260927T202741Z. The point-release
consistency check stays separate because tides have an independent publisher.

The CLI previously printed only AggregateError.message, hiding all individual
failed routes. It now prints bounded per-probe diagnostics, retaining the route,
model/location and HTTP failure while stripping control characters and multiline
assertion details. Limits are 12 details and 240 characters per line.

Three regression cases failed on the original implementation, then passed with
the fix. Coverage includes success, HTTP 503, redirects, missing identity, MIME,
size limits, interrupted bodies, cancellation, fetch timeout, concurrency, and
actual CLI stderr. The staging preflight also passed against the live combined
profile. Final candidate verification and rollback remain unchanged. There is no
browser runtime, bundle, data publication, or production configuration change.

## Qualification impact

`tools/ui-staging-preflight.mjs` already participates in the pipeline digest.
After this change is merged, future promotion requires a freshly qualified
staging candidate under the new policy. Existing qualification evidence must not
be reused across the policy change. The already deployed UI remains unaffected.
This review does not repair the separately documented production tide publisher.

## Verification

- `node --test tests/ui-*.mjs tests/production-account-release.mjs`: 275 passed,
  0 failed, 1 existing GNU-timeout test skipped on macOS (Linux CI exercises it).
- `node tools/workflow-inventory.mjs --check`: passed.
- `node scheduler/test-ui-release-contract.mjs`: passed.
- `git diff --check`: passed.
- Live combined-profile staging preflight: both point probes and tide GET passed.
