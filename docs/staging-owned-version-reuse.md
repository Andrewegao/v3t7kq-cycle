# One explicitly reviewed staging version reuse

This is a diagnostic reactivation path, not a claim that the original public
probe failure has been fixed. It does not create a new Worker version, inherit
secrets, publish weather data, alter routes/settings, or deploy production/UI.

The manual `staging-consumer-refresh.yml` workflow accepts mode
`reuse-owned-33988771315` only with confirmation `REUSE-STAGING-33988771315`.
Normal upload remains the default and retains its latest-equals-active guard.
Keep the owner-approved exclusive staging Worker change window throughout the
run. Workflow concurrency does not provide a Cloudflare compare-and-swap lock.

## Exact origin and target

- Original workflow run/attempt: `33988771315/1`.
- Original controller: `e85a47db696957887d440e8b37c59fa935c33aae`.
- Source: `0aa9fbed9e179ab2ccb6ac456727b9f33124ddb6`.
- Retained version: `e3d05c37-01c6-479e-baa8-450a6d3eabac`.
- Required active/rollback version: `371277cf-0113-4f9b-91c2-277a31a78d98`.
- Artifact ID `9975982597`, original job `101367107255`.
- ZIP SHA256: `43ec3ca54e9f0033461d1c753464865cf62b32cbfb3da4199a6bca62acead339`.
- Receipt SHA256: `4eb744b4691f0fc76265c30776e9ddde81397058c715c222bc8b3d5cce842b69`.

The transport verifies the exact GitHub repository, workflow, controller,
attempt, job outcomes, artifact identity, expiry and digests. It downloads only
the tiny receipt archive; authenticated GitHub requests never forward their
token to artifact storage. A single bounded regular `receipt.json` is admitted;
no extracted executable, path traversal, symlink, duplicate or extra member is
accepted. The original receipt is retained unchanged inside the new run receipt.

Fresh preflight and execution compare the complete original active snapshot,
desired bindings, runtime, routes, schedules and script-global settings. The
retained version must match its exact ID, creation timestamp, source tag,
upload trigger and reviewed Cloudflare ETag. ETag is an opaque content identity,
not a reproducible source hash. Producer/source lineage is established through
the trusted original workflow receipt and immutable version identity; the tag
alone is not trusted. Hidden secret values are not read or independently proven.

The exact original history plus one owned retained version is checked before
activation, after qualification and before restoration. Existing ownership
checks refuse foreign uploads or activations. Normal three-round public
qualification and freshness/numeric checks remain unchanged. Any failure uses
the existing ownership-guarded restore and bounded diagnostic receipts. Receipt
storage outages cannot prevent restoration, but cannot produce a passing result.

Do not retry automatically, weaken history checks, or substitute another
version if any assertion fails. Investigate the newly retained diagnostic
phase/probe evidence. There is no assumption that the original failure was
merely propagation delay.

## Bounded activation readiness (explicit reuse only)

Before activation, reuse preflight reads both public health endpoints between
unchanged full control-plane snapshots. Only the reviewed old public/enabled
health body and public/serve data-health body without shared-reader markers are
accepted as the baseline. The receipt binds these exact bodies to this run,
attempt and prior active version; historical receipt bodies are not substituted.

After activation, readiness may observe that exact old pair for at most 75
seconds, at intervals of at least 5 seconds. Active version and complete version
history are checked before and after each pair. An unknown or mixed response,
HTTP failure, auth/configuration mismatch, foreign version or foreign upload
refuses immediately. This is not a general retry of a failing qualification.
Only the exact public/disabled/shared-reader health shape ends readiness.

Every accepted observation records a bounded attempt number, elapsed time,
owned version ID and allowlisted body markers. An absent legacy shared-reader
marker is recorded as null, not as proof that configuration is false. No raw
unexpected response or credential is retained. Timeout or receipt-write failure
uses the existing guarded restoration; the exclusive-change window remains
necessary because these checks are not a Cloudflare atomic transaction.

Readiness is not success: all three existing real forecast, numeric, freshness
and map/point identity verification rounds must still pass, followed by final
ownership and full snapshot checks. Normal upload behavior is unchanged.
