# Production account release controller — implementation contract, not activation

Status: local G3 framework only. This document and its code do not authorize a workflow
dispatch, Cloudflare mutation, D1 migration, Stripe change, Pages deployment, or real charge.

## Current hard block

Lane C is built against one explicit owner-blocked Lane B contract in
`tools/production-account-contract.mjs`:

- contract version: `lane-b-account-contract-v0-provisional`
- exact reviewed Atmos integration candidate: `29ff8f58b36d31059b2cd5fb80b3b90224130282`
- contract digest: `1acc28da489682a8200f12c4a4654866950c69047d88bdb9f9c13380dbecb6ba`
- production profile digest: `724b78d9f57ae149e1e57ce90ee457f3b69dff891d388eb7a44828abbcca8fe7`
- pipeline digest: `71a1f2c7f9438cfa869f6c8b2ccfc0aea4fbbd0dc7773ef74dd2c84e3116595f`

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

Execute mode has no provisional override and accepts no caller-supplied clock or lease assertion.
The production factory accepts only module-branded production authorities; separately branded test
authorities can be used only by the explicit test factory. Before an adapter can run, the boundary:

- validates the final contract, candidate, staging qualification, target, artifact and rollback
  identities;
- authenticates an Ed25519-signed, issuer/audience/approval-ID-bound authorization containing the
  exact request, input-receipt, plan and target digests and the literal
  `AUTHORIZE WEATHERX PRODUCTION MUTATION`, with a maximum 30-minute lifetime;
- obtains a fresh approval/action/transaction/request/target-bound lease from an independently
  configured authority, with a monotonically increasing fencing token, maximum ten-minute lifetime
  and at least one minute remaining; and
- durably creates a sanitized pre-mutation intent as the first entry of an append-only journal.

The lease is re-read immediately before every provider mutation and recovery, and its identity and
fencing token are passed into the adapter call. Activation reloads its immutable prepared receipt
from durable storage and rereads the exact prepared Worker version before traffic changes. Signed
approval and lease claims bind the request and input-receipt digests, preventing substitution.

Each result is appended as `completed` or `recovery-required`; entries are never replaced. Exact
completed replays return the recorded result without reacquiring a lease or rerunning the operation,
including after approval expiry. An orphaned intent or recovery-required result cannot be rerun and
requires an explicit recovery action. Provider failures persist only stable error codes; arbitrary
provider output and secret values never enter receipts or errors.

The filesystem journal requires an owner-only mode-0700 trusted anchor and every child directory,
uses create-if-absent entries opened with no-follow and verified by descriptor metadata, writes
mode-0600 bounded envelopes, fsyncs files and directories, and rejects symlinks, gaps, replacement,
unexpected files and ownership/mode drift.

Concrete non-invoked adapters define the production Wrangler argument-vector boundary for Worker
version upload/deploy/rollback and the Pages project API capability boundary. They exact-key and
target-check provider responses, accept no shell strings, never put credentials into command
arguments, and require the current fence on every mutation. No workflow exposes these adapters yet.

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
The execution-boundary suite additionally covers authenticated success, completed replay, crashes,
orphaned intents, approval and lease expiry, monotonic fencing, wrong prepared receipts, exact Worker
readback, secret-bearing provider failures, concrete command/API adapters and hardened append-only
receipt storage.
