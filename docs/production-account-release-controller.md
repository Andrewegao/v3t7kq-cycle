# Production account release controller — implementation contract, not activation

Status: local G3 framework only. This document and its code do not authorize a workflow
dispatch, Cloudflare mutation, D1 migration, Stripe change, Pages deployment, or real charge.

## Current hard block

Lane C is built against one explicit owner-blocked Lane B contract in
`tools/production-account-contract.mjs`:

- contract version: `lane-b-account-contract-v0-provisional`
- exact reviewed Atmos integration candidate: `35658a3372e9cb7699cbd52860388d138f967115`
- contract digest: `f88f450b54f8efb9171add602bb4ac8ebba3763cda2aaa65f905f63199c6c896`
- production profile digest: `2ebd8d7b6a93383d1c14863281851edc5434916873ca87a20e91b2b7b28c9485`
- pipeline digest: `523848eb49cecd2a2750e006f7ae974cdb932455a558bd4af8a18eb196cf10d1`

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

`tools/production-account-release.mjs` is intentionally pure and performs no network access. A
future Cloudflare adapter must implement the injected read/upload/activate/rollback methods and:

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
node --test tests/ui-*.mjs tests/production-account-release.mjs
```

The transaction suite covers wrong target/digest, known staging/test identifiers, purchase-open
refusal, exact candidate invalidation, inactive upload, old-UI compatibility, CAS/foreign writer,
interrupted activation, Worker rollback with retained additive schema, and Pages configuration
rollback. These are mocked controller contracts, not live Cloudflare or Stripe receipts.
