# Production account release controller — implementation contract, not activation

Status: local G3 framework only. This document and its code do not authorize a workflow
dispatch, Cloudflare mutation, D1 migration, Stripe change, Pages deployment, or real charge.

## Current hard block

Lane C is built against one explicit owner-blocked Lane B contract in
`tools/production-account-contract.mjs`:

- contract version: `lane-b-account-contract-v0-provisional`
- exact reviewed Atmos integration candidate: `64065f12326077dca3d8a11316b0151b10ba4d0b`
- contract digest: `e4d460c5e58223ff2ae0e5cf277ab7348cda8935e833e9ec986957cfd4b8de2c`
- production profile digest: `1a9cac5a307a4e97ee240709725a9d4a255b7480a7d585a65543b2bdcf87e931`
- pipeline digest: `6751e43d49d02dc36a6fd17b444aba1b2810be1e9ae28cc694cc91e295905199`

Every normal validation path refuses while the contract is provisional. Tests may pass
`allowProvisional: true` only to exercise mocked transactions. That switch must never appear
in a workflow, CLI, or live adapter. The source and controller identities are now bound to the
exact reviewed Atmos candidate above, but the owner must still approve the exact live Stripe
offers and Price/Product identities before the contract can become final or enter a live rehearsal.
Any final contract change invalidates these digests and requires a fresh candidate qualification.

## Profiles and candidate identity

The existing production-compatible baseline remains the default for `profileFor()` and
`profileFor('none')`. It keeps accounts off and billing disabled. The staging account profile
remains staging-only and cannot enter production.

`profileFor('production-account-billing-v1')` selects a distinct production account profile.
It binds the Lane B contract digest into the encrypted candidate profile. Candidate validation
also requires the exact Lane B build-receipt shape and controller SHA. The release pipeline
digest includes both the contract and transaction framework, so any policy, profile, controller,
or transaction-code change invalidates older candidates.

The transaction candidate binding is derived only from that validated encrypted candidate and
its exact staging qualification receipt. A caller-authored plan cannot mint the binding, and the
provisional override is never applied implicitly. The provisional Stripe subscription/pass values
are deliberately invalid identifiers until the owner chooses exact live Prices; arbitrary
`price_live_*` values are not accepted as substitutes.

The owner-blocked profile is not exposed through a live workflow selector. Adding that selector
requires a final owner-approved contract and separately reviewed workflow change. This prevents
a protected-variable typo from turning an unfinished contract into a deployable profile.

## Execution boundary

`tools/production-account-execution.mjs` is the only release-transaction execution boundary. A
request has an exact action and either `mode=plan` or `mode=execute`. Plan mode forbids mutation
authorization and never invokes a Cloudflare adapter. It may render the provisional
contract only as an explicitly blocked preview. The preview currently reports both the provisional
Lane B contract and missing owner-approved live Stripe Prices.

Execute mode has no provisional override. Before it can call an injected adapter, it independently:

- validates the final contract, candidate, staging qualification, target, artifact and rollback
  identities;
- requires an action-specific authorization containing the exact plan and target digests and the
  literal `AUTHORIZE WEATHERX PRODUCTION MUTATION`, with a maximum 30-minute lifetime;
- obtains a fresh action/transaction/target-bound exclusive-lease proof; and
- durably writes and reads back a sanitized pre-mutation intent receipt.

Every result is written and read back as a separate completed receipt. Failures persist only a safe
failure code; arbitrary provider output and secret values never enter the receipt. Pages preimages
use their own durable receipt identity. The filesystem store uses bounded, mode-0600 JSON envelopes,
atomic replacement, canonical hashed filenames and symlink refusal.

Live Stripe Product and Price IDs are non-secret inputs carried by the release plan, not credentials
or source defaults. They must be exact valid live Price IDs, must equal the final owner-approved Lane
B contract, and remain blocked while the contract contains placeholders. Providing an ID does not
make it approved: finalizing the contract changes its digest and requires a newly bound candidate and
staging qualification.

## G3 transaction separation

Three operations stay independent:

1. **Account Worker preparation.** Validate exact Atmos/controller/profile/pipeline/artifact
   identities; Cloudflare account, Worker, database, origin and route inventory; live Stripe
   declaration; platform health `authMode=observe`, `billingMode=enabled`, and
   `billingPurchaseMode=closed`; live Stripe; separate data health `authMode=public`; exact
   rollback Worker version/deployment/configuration; and old-UI/additive-schema compatibility.
   Upload a new Worker version without activation, read it back, and prove the active deployment
   did not change.
2. **Account Worker activation.** Re-read the exact pre-change deployment and CAS/ownership
   identity, activate only the prepared version, verify purchase-closed/webhook-servicing and
   old-UI contracts, and write before/after receipts. Verification is structured evidence for the
   old UI, closed purchase creation, portal/webhook servicing, public data and Stripe live mode.
   An interrupted activation or rollback is resolved by reading and classifying actual state.
   Rollback is permitted only while the candidate version is still owned by this
   transaction. Worker rollback retains the additive D1 schema; it never attempts a database
   restore.
3. **Pages/service configuration.** In a separate transaction, validate the exact Pages target,
   sanitized before/after configuration digests and payload, and exact-allowlist the retained
   production/preview secret references and analytics D1 identity. Persist the full sanitized
   preimage receipt before mutation; reject the staging D1 identity, staging URLs/resources and
   known test Price IDs; CAS the configuration; and verify both the old UI deployment and exact
   candidate. Recovery classifies unchanged, owned-desired and foreign state. On failure, reverse
   only an owned configuration mutation, reread the entire payload, and retain a recoverable
   receipt if the restore outcome is ambiguous. This transaction never uploads or promotes Pages code.

The final exact-artifact Pages promotion remains the existing G5 mechanism and occurs only after
these G3/G4 dependencies are qualified and explicitly authorized.

## Required adapter behavior

`tools/production-account-release.mjs` is intentionally pure and performs no network access. The
execution boundary accepts a reviewed Cloudflare adapter implementing the injected
read/upload/activate/rollback methods. That adapter must:

- use Workers versions/deployments so upload and activation are separate;
- supply a stable ownership/CAS observation derived from a fresh provider read and exclusive
  control-plane lease; do not claim the Pages PATCH API itself provides compare-and-swap;
- return sanitized identities/digests only—never secret values;
- stop on an unknown outcome, reread state, and classify it as unchanged, owned candidate, or
  foreign writer before any recovery;
- never overwrite a foreign writer, broaden routes, move `/data*` or `/data-atmos*`, restore D1
  automatically, or treat Pages rollback as configuration rollback.

Cloudflare documents that Worker versions and deployments can be separated, while Worker
rollback does not revert connected storage state. Pages deployment rollback changes the active
deployment but is separate from project configuration. Those constraints are why the controller
uses separate receipts and retains additive schema.

## G3 → G4 → G5 operating order

1. Freeze the final Lane B contract, exact Atmos/Cycle/controller SHAs, target inventory,
   rollback identities, policy/profile/pipeline/config digests and exclusive lease. Rerun the
   local transaction suite without the provisional override.
2. Rehearse inactive Worker upload, activation interruption, verification failure, owned
   rollback, foreign-writer refusal, Pages configuration reversal, old/new UI compatibility and
   retained-schema behavior against isolated resources. This is G3 evidence, not production
   permission.
3. At G4, obtain separate explicit approval for each production action: Stripe/config setup,
   D1 recovery capture and migration, inactive Worker upload, Worker activation, and Pages/service
   configuration. Keep purchase creation closed. Record provider readbacks and receipts after
   every action. Do not run these mutations in parallel.
4. Observe the prepared backend under the old public UI. Stop on drift, unknown outcome, failed
   rollback permission, staging reference, test Stripe identifier, purchase exposure, session/
   webhook/email failure, or public-weather regression.
5. At G5, freeze the final configuration and pipeline digests, create a fresh exact candidate,
   qualify it on staging, acquire the production approval for that exact artifact, and use only
   the existing guarded Pages promotion. A G3 receipt or successful inactive upload is not a G5
   approval.
6. G6 owner canary and any real purchase/refund remain separately approved actions. Billing
   servicing stays available while the purchase gate is closed; do not use global billing disable
   as the ordinary post-payment emergency control.

## Local verification

Run with Node 22:

```sh
node --test tests/production-account-release.mjs
node --test tests/production-account-execution.mjs tests/production-account-release.mjs
node --test tests/ui-*.mjs tests/production-account-execution.mjs tests/production-account-release.mjs
```

The transaction suite covers wrong target/digest, known staging/test identifiers, purchase-open
refusal, exact candidate invalidation, inactive upload, old-UI compatibility, CAS/foreign writer,
interrupted activation, Worker rollback with retained additive schema, and Pages configuration
rollback. These are mocked controller contracts, not live Cloudflare or Stripe receipts.
The execution-boundary suite additionally covers blocked planning, no-authorization refusal,
action/target/expiry-bound authorization, input-receipt separation and durable receipt storage.
