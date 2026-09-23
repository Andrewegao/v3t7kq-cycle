# Production Wind100 cleanup credential qualification

Before setting `PRODUCTION_WIND100_GC_READY_SHA256` or enabling the publisher, run the manual
`production-wind100-scope-preflight.yml` workflow on `main` in its protected
`data-production-wind100-cleanup` environment. It requires two distinct dedicated tokens:
the read token is Object Read only on `weatherx-data-production` and
`weatherx-components-production`; the delete parent is Object Read & Write only on
`weatherx-components-production`. Save their access key IDs and secret access keys as the four
`PRODUCTION_WIND100_GC_READ_*` and `PRODUCTION_WIND100_GC_DELETE_*` environment secrets.

The job lists at most one object in each bucket with the reader and proves that the delete
parent cannot list the production data bucket. It creates two uniquely named disposable
objects in the production components bucket, proves the reader cannot write or delete them,
and derives the same 15-minute, prefix-restricted
`DeleteObject` credential used by retention, and proves adjacent-prefix deletion plus read,
write, and list operations are denied. It cleans up both disposable objects on the success and
failure paths and logs only the boolean result. If any check or cleanup fails, do not set the
GC-ready digest or enable publication; investigate the credential scope and retry with a fresh
protected run.

The derived credential follows Cloudflare's documented local-signing model for
[temporary R2 credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/),
which supports action and path restrictions under the parent token's bucket permissions.

The workflow never reads or changes the Wind100 pointer, catalog snapshots, production Pages,
the account Worker, or live forecast components. The separate first-publication and retention
dry-run sequence remains in [production-wind100-retention.md](production-wind100-retention.md).
