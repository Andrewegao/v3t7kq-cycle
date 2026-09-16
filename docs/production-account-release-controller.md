# Production account release controller — implementation contract, not activation

Status: local G3 framework only. This document and its code do not authorize a workflow
dispatch, Cloudflare mutation, D1 migration, Stripe change, Pages deployment, or real charge.

## Current hard block

Lane C is built against one explicit owner-blocked Lane B contract in
`tools/production-account-contract.mjs`:

- contract version: `lane-b-account-contract-v0-provisional`
- exact reviewed Atmos integration candidate: `6c29c7f74731059fdd433b40d7bc21427a605ab9`
- contract digest: `7d23c76a2bbfc07c0506ab85c85823723f9cc526f047fd7f9b328e48bd05a93b`
- production trust-policy digest: `f2795ab9b504b32fdbdcaa957cde134ac91199ae43a8945a041aa1544601d23c`
- production profile digest: `d326eb3fdd9a9d9db2a0834a5edae262d3536b485bfd8d7e8b225f390505444b`
- pipeline digest: `7d885f28cebbb303c098989080b7aa92a5c400f3752b225ed809283b8c9b0459`

Every normal validation path refuses while the contract is provisional. Tests may pass
`allowProvisional: true` only to exercise mocked transactions. That switch must never appear
in a workflow, CLI, or live adapter. The source and controller identities are now bound to the
exact reviewed Atmos candidate above, but the owner must still approve the exact live Stripe
offers and Price/Product identities before the contract can become final or enter a live rehearsal.
Any final contract change invalidates these digests and requires a fresh candidate qualification.
The reviewed trust policy is also deliberately provisional: its approval-owner, lease-service and
mutation-broker public-key fingerprints and issuer identities are unusable placeholders. Production
factories cannot be constructed until those exact non-secret trust roots are owner-finalized in
source, which changes the pipeline digest and requires fresh qualification.

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
  authenticated lease service, whose durable counter increases globally for the physical Worker or
  Pages namespace rather than for a candidate, with a maximum ten-minute lifetime and at least one
  minute remaining; and
- durably creates a sanitized pre-mutation intent as the first entry of an append-only journal.

The lease is re-read immediately before every provider mutation and recovery, and its physical
resource namespace and fencing token are passed into the adapter call. The production executor
accepts only module-branded Worker and Pages adapters. Every mutation must return and preserve a
signed acknowledgement from the independently configured mutation broker for an exact operation
digest and idempotency key binding the complete mutation specification, physical target, approval,
request and fence. Before calling a provider, the executor appends the deterministic exact mutation
reference and recovery input as a `mutation-prepared` checkpoint. Immediately after authenticating
the broker acknowledgement—and before any provider readback—it appends the exact signed evidence as
an `acknowledged` checkpoint. Activation/rollback and Pages update/restore therefore keep distinct
references and checkpoints. Activation reloads its immutable prepared receipt from
durable storage and rereads the exact prepared Worker version before traffic changes. Signed
approval and lease claims bind the request and input-receipt digests, preventing substitution.

A provider readback is never mutation authority. If the callback fails or returns a missing, invalid
or wrong-spec acknowledgement after state changes, the journal records the exact pending mutation
reference and remains `recovery-required`. Recovery may query only that durable signed broker
acknowledgement and reread state; it never repeats the upload, activation, rollback, Pages update or
Pages restore. Only matching acknowledgement plus matching provider state can become a completed
recovery receipt. A process death after the provider call or after acknowledgement authentication
leaves the last append-only checkpoint as a recovery input; the recovery action can authenticate the
persisted signed evidence (or query the same exact broker reference) and read state without remutation.
Once an activation or Pages-update checkpoint exists, recovery authenticates that exact evidence before
classifying provider state. An acknowledged mutation observed temporarily at its old preimage remains
pending; only a genuinely unattempted prepared receipt may complete as interrupted-before-mutation.

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
arguments, and require the current fence on every mutation. The Wrangler boundary always supplies
the exact `--name`, `--config` and production `--env`, and validates the resolved account, Worker and
environment before the command runner is reached. No workflow exposes these adapters yet.

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
   Persist an approval/request-bound pre-upload snapshot and unique upload tag, upload a new Worker
   version without activation, read it back, and prove the active deployment did not change. If the
   upload outcome is ambiguous, a separate recovery action lists only that exact tag, requires one
   match, exact version readback and its exact durable broker acknowledgement, and never re-uploads.
2. **Account Worker activation.** Re-read the exact pre-change deployment and CAS/ownership
   identity, activate only the prepared version, verify purchase-closed/webhook-servicing and
   old-UI contracts, and write before/after receipts. Verification is structured evidence for the
   old UI, closed purchase creation, portal/webhook servicing, public data and Stripe live mode.
   An interrupted activation or rollback is resolved by querying the exact signed mutation
   acknowledgement and then reading and classifying actual state; readback alone is insufficient.
   Rollback is permitted only while the candidate version is still owned by this
   transaction. Worker rollback retains the additive D1 schema; it never attempts a database
   restore.
3. **Pages/service configuration.** In a separate transaction, validate the exact Pages target,
   sanitized before/after configuration digests and payload, accept only the canonical nested
   `compatibility_date`, `compatibility_flags`, `fail_open`, `env_vars`, `d1_databases` and
   `services` runtime schema, and exact-allowlist the retained
   production/preview secret references and analytics D1 identity. Persist the full sanitized
   preimage receipt before mutation; reject the staging D1 identity, staging URLs/resources and
   known test Price IDs; CAS the configuration; and verify both the old UI deployment and exact
   candidate. Recovery authenticates the exact update/restore acknowledgement before it classifies
   unchanged, owned-desired and foreign state. On failure, reverse
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
- stop on an unknown outcome, persist its exact operation reference, and require a durable
  broker acknowledgement before a state readback can complete recovery;
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
orphaned intents, approval and lease expiry, restart/candidate-independent monotonic fencing, wrong
prepared receipts, inactive-upload recovery without re-upload, exact Worker readback, exact-spec
signed broker acknowledgements and query-only ambiguous recovery, secret-bearing provider failures,
concrete command/API adapters and hardened append-only receipt storage.
