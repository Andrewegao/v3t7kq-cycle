# Pinned production consumer refresh

This manual workflow repairs code/data-format skew in the two existing Workers. It is not a data
bake or a UI release. It shares the existing production data-edge concurrency lock and requires
the production environment, main workflow revision, exact reviewed Atmos SHA, exact already
published release ID, and `REFRESH-PRODUCTION-CONSUMERS` confirmation.

The August 30 incident was confirmed from downloaded production bundles: both rejected a v2
point-series descriptor; the platform Worker also lacked the WXPS/gzip reader. The new immutable
release was present and valid. Relabeling its pointer as v1 would select nonexistent JSON packs,
so that is not a repair. The qualified consumer source is e4799774847788708fd9bd3fdef577369e2782c7.

Before any upload, the workflow runs the complete pinned platform tests and checks actual live
bindings, variables, secret names, routes, and crons against that source. It verifies the current
pointer against the complete release manifest, exact v2 chunk inventory and catalog, and decodes
14 hash-verified real packs (ECMWF/GFS at seven locations). No private account records are read.

Both new versions are uploaded without activation and their resources are checked. Only then does
the workflow activate platform followed by data, using explicit version IDs and detecting other
publishers. Versions operations leave routes, cron triggers and queue-consumer configuration in
place; no secret writes, R2 writes, catalog mutations, Pages deployments or feature activation occur.

Live acceptance requires source-bound decoded response equality, pinned/unpinned GET+HEAD fallback parity,
catalog authority, public/serve data health and observe/disabled platform health, repeated after
31 seconds. The receipt contains source/release IDs, hashes and previous/new Worker version IDs,
and public-weather reference payloads, not tokens, raw settings or personal data. Execution has an eight-minute deadline plus a reserved
four-minute recovery budget; a separate workflow recovery step covers failed/interrupted execution.
An abrupt runner loss can still prevent recovery and requires inspection of the retained receipt.

On failure, only this operation's own versions can be restored, and a concurrent publisher is never
overwritten. Restoring old pre-v2 consumers is **not** a claim that v2 data is then healthy. The
workflow reports failure and does not rewrite the data pointer or initiate a bake. Full production
launch qualification (including application, billing, infrastructure and source semantics) remains
separate; successful consumer refresh alone is not launch approval.

Failure receipts include the last named check and up to 16 failed checks, including the exact
health, fallback method/header/body, point-model/location, catalog, activation or postcheck stage.
Only static check identifiers, timestamps and a small error category are retained. Arbitrary
assertion messages, settings values and CLI output are excluded. Diagnostics do not alter recovery.

## Cross-runtime numeric comparison

Refresh 33342375037 restored its prior versions after verification failed. The original error
wrapper omitted the failed assertion; the new stage diagnostics address that evidence gap.
Independent replay of its fourteen real, manifest-hashed packs at identical source e479977 found
four whole-payload hash mismatches between Node 22.21.1 and workerd 1.20260811.1. Only eight
`wind_direction` sample values differed, by at most 5.684341886080802e-14 degrees. All fourteen
Node hashes matched the original receipt; every other field and object key order matched workerd.
Thus whole-response hash equality can falsely reject a correct decoder. This does not prove
which check failed first in that historical rollout or exclude another live failure.

The comparison now permits at most 1e-12 degrees absolute difference **only** for finite derived
`series.wind_direction.samples[].value` numbers before strict equality of the entire payload.
Sample times, coordinates, source/run/release IDs, quality, missing values, array lengths, units,
temperature, wind speed, precipitation and every other field remain exact. Raw pack/manifest
hashes and fallback bytes remain exact. Original and actual response hashes plus numeric-difference
counts/bounds are retained; actual responses are not rewritten. Neither weather source production,
data accuracy gates nor the deployed consumer code changes.
