# Production account read-only audit

This workflow closes the inventory gap between the production account database and Stripe without changing either system. It is evidence for a release decision, not release authority and not a repair job. A clear receipt does not enable purchases, approve Stripe Products or Prices, migrate the database, deploy a Worker, or change `weatherx.org`.

## Safety boundary

The workflow is manual, main-only, serialized, and disabled unless the protected `production-account-audit` environment contains all of the following:

- `PRODUCTION_ACCOUNT_AUDIT_ENABLED=true`;
- `PRODUCTION_ACCOUNT_AUDIT_CLOUDFLARE_ACCOUNT_ID=a89f9a1af485021fbc60a68b163c7c6e`;
- `ATMOS_READONLY_KEY`, restricted to reading `weatherx-hq/atmos`;
- `STRIPE_PRODUCTION_AUDIT_KEY`, an `rk_live_` Stripe key with read-only access to Customers, Subscriptions, Checkout Sessions, Refunds, and Disputes; and
- `PLATFORM_PRODUCTION_AUDIT_CLOUDFLARE_API_TOKEN`, restricted to reading D1 database `fe83a5d5-c061-44c4-b5e6-92e6871c7f02`.

Do not substitute the application Stripe secret, a broad Cloudflare deployment token, or another workflow's credentials. Keep required reviewers on the environment. Leave `PRODUCTION_ACCOUNT_AUDIT_ENABLED` false until both restricted credentials and the reviewer policy have been verified.

The controller accepts only Atmos SHA `0edbbe243589849c3d56c98b24e5d8b7ab96c522`, proves that it is the current `weatherx-hq/atmos` master, and verifies the exact production Worker name, D1 identity, origin, and fail-closed account/billing modes from that source. Candidate Price IDs are inventory inputs only; the audit never treats them as owner approval.

## What it reads

Stripe pagination is exhaustive (`limit=100` plus `starting_after`) and uses pinned API version `2026-02-25.clover`. The audit reads every live Customer, Subscription (including canceled), Checkout Session, Refund, and Dispute. It rejects test-mode objects, duplicate IDs, incomplete embedded Subscription items, redirects, oversized pages, stalled cursors, and non-allowlisted Stripe endpoints.

Production D1 access consists only of fixed `SELECT` statements for sanitized fields from users, subscriptions, Stripe entitlements, access passes, access-pass refunds, checkout attempts, and webhook review state. The controller calls Cloudflare's exact account-scoped D1 query endpoint with the hard-coded production database UUID. It rejects redirects, oversized responses, API errors, and any response metadata reporting a write or database change. SQL is not accepted from workflow input.

Stripe and D1 snapshots are collected in parallel into runner-local files. They are never uploaded and are deleted before artifact retention. Emails, checkout URLs, idempotency keys, API keys, webhook secrets, and raw error strings are never selected or included in the receipt.

## Receipt and verdict

The retained artifact contains counts, snapshot digests, candidate Price digests, and discrepancy codes. Object references are one-way truncated SHA-256 labels rather than raw user or Stripe IDs. Output is canonical and deterministic for identical inputs.

The workflow exits nonzero with verdict `blocked` for any discrepancy, including broken Customer ownership, missing or divergent Subscription state, unmatched open Checkout Sessions, access-pass or refund divergence, entitlement drift, any Stripe Dispute, or any webhook already marked for review. There is no automatic repair. An operator must inspect the relevant provider and platform records, resolve the cause through a separately reviewed path, and run a fresh audit.

## Dispatch

Dispatch `.github/workflows/production-account-audit.yml` from Cycle `main` with:

- `atmos_sha`: `0edbbe243589849c3d56c98b24e5d8b7ab96c522`
- `confirm`: `AUDIT-PRODUCTION-ACCOUNT:0edbbe243589849c3d56c98b24e5d8b7ab96c522`

A successful run proves only that the enumerated Stripe and platform inventory matched at that run. Attach its receipt digest to the production release packet and rerun after any billing configuration or data change.
