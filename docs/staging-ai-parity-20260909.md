# Staging AI parity — configuration preparation

Owner approved staging AI using the shared implementation with separate credentials,
without changing production. This change is not a deployment or credential write.

## Policy

- `weatherx-platform-staging`, Pages **production** context (the staging main site):
  allow exactly `AI_API_KEY`, `AI_ACCESS_CODE`, `AI_ACCESS_CODE_CENTRAL` as
  `secret_text`, either all three or none. The two access tiers avoid the legacy
  single-workspace-code promotion to central scope. Provision distinct random codes.
- Preview receives no AI credentials. Existing fallback policy is preserved;
  all backend bindings and unknown variables remain refused.
- `AI_MODEL` and `AI_API_URL` overrides remain refused. Staging uses the shared
  application's existing default DeepSeek endpoint/model, prompts, tools, context
  and streaming implementation, not a staging fork. Deployed UI versions may differ.
- No production policy change. Exact project identity, disabled Git auto-deployment,
  reviewed configuration digest, pipeline/artifact identity and rollback fuse remain.
- API snapshots prove secret names/types only, not valid values, distinct access
  codes, provider account isolation or a spending cap. Never print secret values.

## Provisioning blocker and cost isolation

The owner confirmed no dedicated staging provider key exists yet. Neither the
staging Pages project nor the ui-staging GitHub environment currently has one.
Do not copy the production key or repurpose another credential.

DeepSeek documents account-level concurrency shared across all API keys:
https://api-docs.deepseek.com/quick_start/rate_limit/
Its FAQ documents per-key usage reporting, not a per-key hard spending cap:
https://api-docs.deepseek.com/faq
Therefore a new key on the same account isolates credentials, NOT production's
quota/balance. For strict cost/quota isolation, use a dedicated staging provider
account with an owner-selected finite balance and no automatic top-up. No account
purchase, credit purchase or undocumented spending-limit guarantee is authorized
by this policy patch. Existing access checks and per-request byte/token/time bounds
remain; they are not an aggregate monetary cap.

## Safe activation order (not executed)

1. Qualify and merge this policy. All policy bytes are already included in the
   pipeline digest; do not relabel an older candidate as qualified by this change.
2. Obtain a dedicated staging provider key with the chosen cost/quota isolation.
   In Cloudflare Pages `weatherx-platform-staging` → Settings → Variables and
   Secrets, select its production context and add the three names above using
   **Encrypt**. Use unique staging access codes, never production's codes. Do not
   store values in Git, chat, screenshots, CLI arguments or retained artifacts.
   Cloudflare requires secrets before the deployment that uses them:
   https://developers.cloudflare.com/pages/functions/bindings/#secrets
3. Read back names/types only, confirm preview empty and other resources unchanged.
   Review and approve the new `UI_PAGES_CONFIG_SHA256` in `ui-staging`; do not use
   a placeholder digest, remove the comparison or auto-approve an observed mismatch.
4. Capture live staging rollback deployment and production UI/Worker identities.
   Run the existing guarded `ui-staging.yml` for the reviewed current Atmos master
   and existing approved account/core profile with standard compression. No Worker,
   data publication or production release is part of this task.
5. With a staging-only access code supplied privately, verify actual `/api/ai` JSON
   and streamed answers, grounded `read_point`, short contextual follow-ups, wrong
   code 401, cross-origin 403, and optional-AI failure isolation from weather.
   Do not treat mock-provider tests or an HTTP401 as a successful provider call.
   Record redacted outcome/timing, not credentials or authorization headers.
6. Confirm production release/configuration/Workers unchanged and live weather
   remains usable. Stop and report any failed gate; no fuse bypass. The earlier
   UI's automatic rollback remains intact, but actual provider qualification must
   also be completed before declaring staging AI operational.

## Verification

The new complete-set and negative tests first failed on the old policy (8 pass,
2 fail), then passed with the policy (10 pass). Full UI contracts passed locally:
157 pass, one existing platform-dependent skip on macOS. Fresh Linux CI is required.
Combined UI/shared-data/staging-data checks: 178 pass, one existing macOS skip.
The unchanged Atmos relay security suite also passed all 65 tests locally, including
access-code refusal and bounded streaming. These use synthetic provider responses,
not a real dedicated staging key.
Coverage includes every partial subset, preview denial, plaintext/malformed/extra
fields, endpoint/model overrides, unknown secrets, service binding refusal, unchanged
production rules and configuration-digest mismatch. No application source/bundle,
startup request, runtime allocation or extra network hop changes in this patch.
This is not a live AI, China-network or peak-memory qualification.
