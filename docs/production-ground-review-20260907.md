# Exact retained basemap approval for production, 2026-09-07

The owner explicitly authorized review and qualification of the retained staging basemap
for the requested production release after the staging-only restriction was explained.
This is a new production promotion approval of exact retained bytes, not a relabeling of
the historical Atmos staging-only build/installer approval.

Approved inventory: `606fd6a0a883c8927bee9dddb94d7459b0cfc1df347659cda72d6b994d4bef74`.
Archive identity: `sha256:d5a692d524b8b09944d775ccd89dbe5ac17212cff3b4b983e12727b7be011c41`.
Scope: 1365 basemap-ground RGB JPEG tiles, 256x256, zoom 0 through 5, 5,830,276 bytes.
Digest encoding: numeric z/x/y order; UTF-8 path NUL decimal bytes NUL lowercase SHA-256 NUL.

Evidence: the existing strict Python/Pillow checker decoded every tile from the frozen
qualified local artifact and matched the historical retained inventory. At
2026-09-07T14:15:01.261Z, all 1365 live staging URLs returned HTTP 200 image/jpeg and
matched every reviewed size and SHA-256. Staging release: git-ee0e95bd6d24-run-34126163231.
This proves identity and complete decodability of the retained package, not authentication
of an original Natural Earth TIFF or a historical deployment UUID. Those remain unproven.

The production controller now rehashes the complete decoded candidate tile bytes and matches
this exact inventory before its first Cloudflare preflight read. Missing, extra, duplicate,
noncanonical or altered tiles fail. The approval implementation and this record are bound
into the pipeline fingerprint, requiring a new qualified artifact. The earlier staging-only
build pin is unchanged; merely setting its build scope does not authorize promotion.

No experimental sprite/static compression profile is admitted. No data release, standalone
Worker, credentials, DNS, fuse, or human environment approval is changed. Andrew must still
personally approve the production workflow. Deployment and final browser checks are pending.
