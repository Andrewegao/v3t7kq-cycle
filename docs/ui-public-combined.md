# Combined production Lab Pages profile

`production-account-ru-kk-wind100-onboarding-v2` is a separate, exact-artifact Pages profile for the production account Lab shell with public RU/KK beta, production-native dynamic Wind100, and the reviewed onboarding journey. The profile inherits the production account policy: purchases remain closed, and the billing UI is compiled off. It does not publish weather data or modify the account Worker. Those are separate release gates.

The source pin in `tools/ui-public-combined.mjs`, the source guard pin in `tools/ui-combined-source-guard.mjs`, and all three literal controller refs in the protected UI workflows identify reviewed Atmos master merge commit `ba72f52ff3461b3d235cc94c9fc7b53232dda8c5`. This follow-up changes only the satellite admission test's cold-import fixture setup; application runtime and the reviewed account/onboarding source graph remain unchanged. The exact account and onboarding hashes below are bound into the build sidecar. Keep all five operational source literals identical; a later Atmos master change requires a fresh review and candidate qualification. The protected `ui-staging` environment must set `UI_PRODUCTION_ACCOUNT_PROFILE_APPROVED=production-account-billing-v1`, `UI_PUBLIC_LOCALE_BETA_PROFILE_APPROVED=production-account-ru-kk-beta-v1`, and `UI_PUBLIC_COMBINED_PROFILE_APPROVED=production-account-ru-kk-wind100-onboarding-v2`; the existing UI build, Pages, source-read, and candidate credentials and reviewer gates still apply. No approval variable alone can bypass the source pin.

The build must emit exactly the production account receipt plus `wind100=production-native-dynamic-v2` and `localeBeta=ru-kk-public-beta-v1`. The candidate validator also authenticates `assets/weatherx-production-account-build-v1.json` and every named account/onboarding chunk against the candidate bytes. That sidecar must state `billingUiEnabled=false`, `intro.enabled=true`, and the reviewed onboarding source digests. Staging Wind100 catalog pins and the staging prototype are disallowed. The build flags are `ATMOS_PUBLIC_WIND100_RELEASE=1`, `VITE_PRODUCTION_WIND100=1`, `ATMOS_PUBLIC_LOCALE_BETA_RELEASE=1`, `VITE_LOCALE_BETA=1`, `VITE_ACCOUNT_INTRO=1`, `VITE_PRO_BILLING=0`, and `VITE_PRO_PROTO=0`.

The guarded candidate verifier runs `app/e2e/public-release-journeys.mjs` against the exact staging or production origin with the expected source SHA and release ID. It requires desktop and mobile onboarding completion, isolated browser auth fixtures, no outbound writes or browser errors, real native 100 m Wind data, and the Wind energy reference output chart. Staging binds the sanitized proof, harness digest, and release identity into the encrypted candidate and retains an authenticated downloadable copy. Production repeats the live proof. The proof's Wind freshness is checked when each candidate is qualified; promotion authenticates the retained staging proof without treating a later weather cycle as candidate expiry.

Each onboarding-v2 guarded deploy snapshots the exact current Pages deployment and passes it to the rollback guard as `--expected-previous-id`. After verification, the guard rechecks that its candidate is still canonical and writes a strict success receipt with the previous and candidate deployment IDs plus the source, release, and index identities. Cycle authenticates that receipt, takes another canonical snapshot, and records the guard's candidate ID in the uploaded transaction receipt. A failed deploy retains the armed transaction and any rollback incident instead of manufacturing success evidence. Historical profiles continue to use their pinned controllers and original guard arguments.

After the exact Atmos pin is reviewed, run UI staging qualification with this selector and that source SHA. The existing full app/Weather Lab, real staging, production account proof, ground inventory, protected production promotion, production probes, and rollback apply. Production Wind100 data must independently pass its dedicated publisher/selection/retention release gates before this UI profile is enabled for production visitors.

The combined profile's read-only
preflight validates the existing TC, GDACS, EONET, and legacy hazards feeds with
bounded JSON, age, and geometry checks. The promoted candidate must then pass
the unchanged full weather-feed verifier, including USGS and the four-source
hazards contract, inside the guarded three-success production soak. This is
scoped only to this exact combined profile; earlier profiles retain their full
preflight verifier.

The source guard requires the candidate and Atmos master to be the same
reviewed `ba72f52ff3461b3d235cc94c9fc7b53232dda8c5` commit with a clean checkout and no intervening diff.
Any later master or UI change blocks staging until review.
