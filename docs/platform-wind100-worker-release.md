# Production Wind100 platform Worker release

This one-time manual workflow deploys only the production platform Worker from Atmos master
`7497b9815f1f5ca657cda8ed24ad5894afa267e0`. The production Wind100 pointer must
already have passed its protected publication and retention dry run. The release does not
deploy Pages, publish data, change secrets, deploy Stripe, or enable purchases.

The guarded job checks the exact source and Worker first, attaches only the reviewed
`weatherx.org/api/platform/production-wind100/*` route, then uploads and activates
one candidate version. Cloudflare version activation does not attach new routes.
If live verification fails, it restores the previous version and removes only the
route created by that run; a lost route-create response requires manual review
instead of speculative deletion. The separate route receipt is retained with the
Worker receipt.

Dispatch `platform-wind100-worker-release.yml` on Cycle main with confirmation
`RELEASE-PRODUCTION-WIND100-WORKER`. Approve only that run's protected `production`
environment after checking its run ID and source. The workflow runs the complete Worker
checks, validates production configuration and current bindings, uploads an inactive
version, verifies its bindings, then activates that exact version. It checks live health
and the published Wind100 selector. The receipt artifact records the prior and candidate
Worker versions, source and controller revisions, status, and any recovery result.

If live verification fails, recovery restores only the previous version recorded for
this run and refuses to overwrite a different publisher. Inspect the receipt and active
version before retrying; a runner interruption can require manual inspection. Do not
promote the UI unless this release and its live checks pass.
