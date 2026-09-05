# Staging reader failure diagnostics

The staging-only repair run 33988771315 restored its previous Worker version after
qualification failed, but its receipt did not identify which public probe failed.
The deployed candidate remains inactive. This change does not retry that repair,
change its source pin, or relax version ownership or configuration checks.

Receipts now retain a bounded list of public probe statuses and fixed failure
phases. They never retain exception text, bodies, headers, credentials, or CLI
stderr. Original failures survive rollback; recovery failures are separate.

A failed receipt write must not prevent ownership-checked rollback. Independent
review reproduced this fault in the first draft; regression tests now prove that
even a permanent receipt-storage outage restores our version and still refuses
to roll back another publisher's version. Lost evidence cannot qualify a release.

Validation: 84 tests passed, one existing optional test skipped across the consumer,
diagnostic, shared-read, live-proof, and scoped-S3 suites; independent focused
review passed 43 tests and reproduced successful restoration under disk failure.
Workflow lint and whitespace checks pass. Production UI, data, and Workers are
unchanged. A subsequent repair requires separate live-boundary review, not a blind
rerun: the latest uploaded staging version currently differs from its active one.
