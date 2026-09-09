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
