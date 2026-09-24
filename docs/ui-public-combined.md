# Combined production Lab Pages profile

`production-account-ru-kk-wind100-intro-v1` is a separate, exact-artifact Pages profile for the production account Lab shell with public RU/KK beta, production-native dynamic Wind100, and the desktop account intro. The profile inherits the production account policy: purchases remain closed, and the billing UI is compiled off. It does not publish weather data or modify the account Worker. Those are separate release gates.

The source pin in `tools/ui-public-combined.mjs` and the literal controller refs in both protected UI workflows identify reviewed Atmos master commit `54e40231b54b906bbb4568bbc94d8f3551baab18` (including the full-height Wind resize repair in PR #353). Keep these pins identical; a later source change requires a fresh review and candidate qualification. The protected `ui-staging` environment must set `UI_PRODUCTION_ACCOUNT_PROFILE_APPROVED=production-account-billing-v1`, `UI_PUBLIC_LOCALE_BETA_PROFILE_APPROVED=production-account-ru-kk-beta-v1`, and `UI_PUBLIC_COMBINED_PROFILE_APPROVED=production-account-ru-kk-wind100-intro-v1`; the existing UI build, Pages, source-read, and candidate credentials and reviewer gates still apply. No approval variable alone can bypass the source pin.

The build must emit exactly the production account receipt plus `wind100=production-native-dynamic-v1` and `localeBeta=ru-kk-public-beta-v1`. The candidate validator also authenticates `assets/weatherx-production-account-build-v1.json` and every named account/intro chunk against the candidate bytes. That sidecar must state `billingUiEnabled=false`, `intro.enabled=true`, and the reviewed intro source digest. Staging Wind100 catalog pins and the staging prototype are disallowed. The build flags are `ATMOS_PUBLIC_WIND100_RELEASE=1`, `VITE_PRODUCTION_WIND100=1`, `ATMOS_PUBLIC_LOCALE_BETA_RELEASE=1`, `VITE_LOCALE_BETA=1`, `VITE_ACCOUNT_INTRO=1`, `VITE_PRO_BILLING=0`, and `VITE_PRO_PROTO=0`.

After the exact Atmos pin is reviewed, run UI staging qualification with this selector and that source SHA. The existing full app/Weather Lab, real staging, production account proof, ground inventory, protected production promotion, production probes, and rollback apply. Production Wind100 data must independently pass its dedicated publisher/selection/retention release gates before this UI profile is enabled for production visitors.

The combined profile's read-only
preflight validates the existing TC, GDACS, EONET, and legacy hazards feeds with
bounded JSON, age, and geometry checks. The promoted candidate must then pass
the unchanged full weather-feed verifier, including USGS and the four-source
hazards contract, inside the guarded three-success production soak. This is
scoped only to this exact combined profile; earlier profiles retain their full
preflight verifier.

The source guard now requires the candidate and Atmos master to be the same
reviewed `54e40231…` commit with a clean checkout and no intervening diff.
Any later master or UI change blocks staging until review.
