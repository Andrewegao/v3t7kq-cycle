# RU/KK public locale beta Pages profile

The `production-account-ru-kk-beta-v1` UI profile promotes one exact Atmos master
commit through the existing encrypted staging-artifact and protected production
Pages workflow. It is separate from the production account mutation controller.
Only the UI shell and Pages Functions are published; no Worker, D1, Stripe,
binding, data, DNS, or billing configuration is changed.

Before staging qualification, the owner must set the protected `ui-staging`
variables `UI_PRODUCTION_ACCOUNT_PROFILE_APPROVED=production-account-billing-v1`
and `UI_PUBLIC_LOCALE_BETA_PROFILE_APPROVED=production-account-ru-kk-beta-v1`.
The literal beta source/controller SHA in `tools/ui-public-locale-beta.mjs` and
both UI workflows must match the exact reviewed current Atmos master commit.
An all-zero or mismatched SHA blocks selection or publication. The build receipt
must equal the existing production account receipt plus
`localeBeta=ru-kk-public-beta-v1` with no extra build-profile fields.

The beta build sets `ATMOS_PUBLIC_LOCALE_BETA_RELEASE=1` and
`VITE_LOCALE_BETA=1`, retains `ATMOS_PRODUCTION_ACCOUNT_PROFILE=production-account-billing-v1`
and `VITE_PLATFORM_ACCOUNT=1`, and clears staging-only Wind100, prototype
intro, and Pro billing UI flags. The full app test step alone selects Atmos's mechanical public
beta CI lane with `WX_CI_PROFILE=public-beta-ci-lab-road-security-v1`; other UI
profiles keep the ordinary strict app test lane. This profile does not claim
editorial approval or promote the staging account/intro and Wind100 prototypes.

Staging qualification still runs the full application tests, Weather Lab gate,
real staging site checks, and account qualification. The staging build uses
Atmos's `staging-qualification-only` ground scope. Production promotion has a
separate owner-approved exact ground inventory gate in
`tools/ui-production-ground.mjs` and `docs/production-ground-review-20260907.md`.
The production preflight and post-deploy verification require the current live
platform to report `authMode=observe`, `billingMode=enabled`,
`billingPurchaseMode=closed`, and public data reads. Promotion retains the
protected `ui-production` reviewer, exact-artifact identity checks, three
production probes, automatic exact-prior Pages rollback, and release fuse.

Run `ui-staging.yml` on Cycle `main` with the pinned Atmos SHA and
`model_selection_sha256=production-account-ru-kk-beta-v1`. Record the successful
run ID, source SHA, and candidate digest. Then run `ui-release.yml` with those
exact values and `release_profile=production-account-ru-kk-beta-v1`; the owner
reviews the protected production environment before publication.
