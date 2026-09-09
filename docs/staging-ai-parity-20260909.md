# Staging AI account policy — configuration preparation

Owner approved login-only staging AI with at most 100 provider requests per user
per UTC day and 1,000 total provider requests per UTC day, including tool rounds
and retries. Production remains on its existing access-code policy. This change is
only the Cycle configuration guard; it is not a deployment, binding or credential write.

## Policy

- `weatherx-platform-staging`, Pages **production** context (the staging main site):
  admit one atomic account-AI profile or none of it:
  - `AI_API_KEY` as `secret_text`;
  - `AI_AUTH_POLICY=staging-account-v1` as exact `plain_text`;
  - `services.WX_AI_ADMISSION` with exact service
    `weatherx-platform-edge-staging`, environment `production`, and named
    entrypoint `StagingAiAdmission`.
- Cloudflare's Pages project schema requires both `service` and `environment`
  and represents the optional named export as `entrypoint`. The live service's
  read-only metadata identifies `production` as the default environment. The
  controller rejects a missing, renamed or extra field instead of relying on a
  Wrangler-default projection.
- Preview receives no AI secret, policy selector or service. Existing fallback
  policy is preserved; all other backend bindings and unknown variables remain refused.
- Legacy `AI_ACCESS_CODE` and `AI_ACCESS_CODE_CENTRAL` are not admitted by this
  staging profile. Empty AI configuration remains the existing fail-closed/off path.
- `AI_MODEL` and `AI_API_URL` overrides remain refused. Staging uses the shared
  application's existing default DeepSeek endpoint/model, prompts, tools, context
  and streaming implementation, not a staging fork. Deployed UI versions may differ.
- No production policy change. Exact project identity, disabled Git auto-deployment,
  reviewed configuration digest, pipeline/artifact identity and rollback fuse remain.
- API snapshots prove secret names/types and service identity only, not provider-key
  validity or runtime quota enforcement. Never print secret values.

## Runtime dependencies and cost isolation

The owner has placed `AI_API_KEY` only in the staging Pages production context.
No access-code secret is part of the account policy. This guard does not read,
copy, print or validate that secret value.

DeepSeek documents account-level concurrency shared across all API keys:
https://api-docs.deepseek.com/quick_start/rate_limit/
Its FAQ documents per-key usage reporting, not a per-key hard spending cap:
https://api-docs.deepseek.com/faq
Therefore a separate key on the same provider account isolates credentials, NOT
production's quota/balance. The approved 100/user/day and 1,000-total/day limits
must be consumed atomically by `StagingAiAdmission` before each provider request,
including tool rounds and retries. They bound application requests, not currency:
no undocumented provider spending-limit guarantee is claimed. Existing per-request
byte/token/time bounds remain independently mandatory.

## Safe activation order (not executed)

1. Qualify and merge this policy. All policy bytes are already included in the
   pipeline digest; do not relabel an older candidate as qualified by this change.
2. Qualify and deploy the separately reviewed `StagingAiAdmission` named entrypoint
   to `weatherx-platform-edge-staging`. It must validate the existing staging
   HttpOnly account session, atomically enforce both approved counters before every
   provider call, and fail closed. Do not add a production route, database, binding
   or policy. Capture the exact prior Worker version for rollback.
3. In Cloudflare Pages `weatherx-platform-staging` production context, retain the
   existing encrypted `AI_API_KEY`, add the exact `AI_AUTH_POLICY` value and exact
   named service binding above. Do not add access codes, preview bindings or provider
   overrides. Cloudflare documents Pages service bindings here:
   https://developers.cloudflare.com/pages/functions/bindings/#service-bindings
4. Read back names/types/target metadata only, confirm preview empty and all other
   resources unchanged.
   Review and approve the new `UI_PAGES_CONFIG_SHA256` in `ui-staging`; do not use
   a placeholder digest, remove the comparison or auto-approve an observed mismatch.
5. Capture live staging rollback deployment and production UI/Worker identities.
   Run the existing guarded `ui-staging.yml` for the reviewed current Atmos master
   and existing approved account/core profile with standard compression. That UI
   workflow must not itself deploy a Worker, publish data or release production.
6. Verify signed-out `/api/ai` refusal, signed-in JSON and streamed answers, grounded
   `read_point`, short contextual follow-ups, per-user refusal after 100, global
   refusal after 1,000, tool/retry accounting, cross-origin refusal, admission-service
   failure closure and optional-AI isolation from weather. Do not treat mock-provider
   tests or a refusal as a successful provider call. Record redacted outcomes/timing,
   not cookies, credentials, user identifiers or authorization headers.
7. Confirm production release/configuration/Workers unchanged and live weather
   remains usable. Stop and report any failed gate; no fuse bypass. The earlier
   UI's automatic rollback remains intact, but actual provider qualification must
   also be completed before declaring staging AI operational.

## Verification

The focused controller tests cover every partial subset, preview denial,
plaintext/malformed/extra fields, wrong service/environment/entrypoint, legacy access
codes, endpoint/model overrides, unknown secrets/bindings, unchanged production rules
and configuration-digest mismatch. This patch changes no application source/bundle,
Worker, live binding, startup request or runtime allocation. It cannot establish that
the provider key works, quota counters are atomic, the named entrypoint is deployed,
or live latency is acceptable; those remain activation evidence.
