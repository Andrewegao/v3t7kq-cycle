# Staging account qualification diagnostics

Run 34319440121 passed the weather and model checks, then the account browser
qualification refused. Automatic rollback restored the exact previous staging
deployment. The harness wrote a sanitized private receipt, but the child process
exit prevented the controller from retaining its useful failure classification.

The controller now reads that receipt through its existing stable-file,
non-symlink, single-link, 1 MiB bound and projects at most 32 KiB to Actions stderr.
Only closed error/check/category/network/resource enums, canonical timestamps,
trusted controller identities, observed-match booleans and four known completed
case names survive. Asset names, arbitrary errors, URLs, headers, cookies and
request/response bodies are omitted. This is diagnostic evidence, never an
accepted qualification receipt.

No new public artifact or predictable diagnostic output file is created. This
avoids accidentally uploading stale or preexisting bytes when projection fails.
Malformed input or even logger failure cannot mask the original child refusal:
the same error is rethrown to the normal rollback/fuse path. Production and
rollback do not acquire an account qualification step.

Independent review and root verification: 156 UI contract tests, 155 passed,
zero failed, one existing macOS skip for the GNU process-group timeout test.
Linux CI must exercise that platform-specific test. No deployment is claimed by
these local results. Incident fuse #193 remains open pending diagnosed candidate
validation. The account cancellation harness correction is a separate Atmos
change; any staging controller repin must use its reviewed merge, leaving the
production-compatible controller untouched.

The earlier Linux CI run 34323212210 passed all 156 UI contracts, including the GNU
timeout case. Atmos #197 then merged as 53487719eb3ecf8b20f02cdb617487bc4e22d651;
root verified its tree is byte-identical to the reviewed final head 142fedaa.
Both staging workflow conditional refs and STAGING_CONTROL_SHA now use that merge.
The production CONTROL_SHA and production workflow remain unchanged at 25c402db.
Full account qualification on the exact candidate via a byte-preserving localhost
proxy passed normal/slow cold/warm repeats, four account states and thirty lifecycle
cycles. It is not a direct-host or China-device guarantee. Final combined Cycle CI
and normal incident-fuse handling are still required before staging dispatch.
