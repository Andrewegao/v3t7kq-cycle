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

Live acceptance requires exact decoded response hashes, pinned/unpinned GET+HEAD fallback parity,
catalog authority, public/serve data health and observe/disabled platform health, repeated after
31 seconds. The receipt contains source/release IDs, hashes and previous/new Worker version IDs,
not tokens, raw settings or personal data. Execution has an eight-minute deadline plus a reserved
four-minute recovery budget; a separate workflow recovery step covers failed/interrupted execution.
An abrupt runner loss can still prevent recovery and requires inspection of the retained receipt.

On failure, only this operation's own versions can be restored, and a concurrent publisher is never
overwritten. Restoring old pre-v2 consumers is **not** a claim that v2 data is then healthy. The
workflow reports failure and does not rewrite the data pointer or initiate a bake. Full production
launch qualification (including application, billing, infrastructure and source semantics) remains
separate; successful consumer refresh alone is not launch approval.
