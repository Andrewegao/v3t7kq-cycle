# WeatherX model scheduler

This scheduled-only Cloudflare Worker dispatches the existing GitHub Actions bake workflow. It is a delivery bridge: all model discovery, quality gates, publishing, and promotion remain in `catalog-bake.yml`.

## Schedule

- `8-59/10 * * * *`: dispatch `hrrr`
- `7 * * * *`: dispatch `slow` (`ecmwf`, `gfs`, and `aifs` in parallel)

The GitHub-native schedules are a fail-open independent fallback. Existing workflow
concurrency and immutable/no-change promotion behavior make duplicate dispatches
safe. Leave the fallback on until the Worker has produced at least three HRRR
dispatches and one successful slow dispatch. After that evidence exists, set the
repository variable `CATALOG_GITHUB_FALLBACK_DISABLED=true` to avoid duplicate
no-change jobs. Missing, empty, or misspelled values keep the fallback on.

## Credential

Create a fine-grained GitHub personal access token restricted to the `Andrewegao/v3t7kq-cycle` repository with only **Actions: Read and write** permission. Store it as the Worker secret; never commit it or reuse the broader GitHub CLI credential.

```sh
npx wrangler secret put GITHUB_DISPATCH_TOKEN
```

## Verify and deploy

Production deploys are automatic after a scheduler change reaches `main`, and can
also be retried from the **WeatherX scheduler deploy** workflow. The workflow runs
all release gates, uses `wrangler deploy` so code and triggers are applied together,
then queries Cloudflare and requires the live trigger set to exactly match
`wrangler.jsonc`.

Configure the repository secret `CLOUDFLARE_API_TOKEN` with Workers Scripts edit
permission for account `a89f9a1af485021fbc60a68b163c7c6e`. A missing or
under-scoped token fails before the deployment can be reported successful.

Local validation is read-only:

```sh
npm ci
npm run check
```

Do not use `wrangler versions upload` as the deployment path: it does not apply cron
triggers by itself. If that command is ever used during recovery, follow it with
`wrangler triggers deploy` and `npm run verify:live`. Confirm successful Worker
scheduled invocations and matching GitHub workflow-dispatch runs before disabling
the GitHub fallback or advancing the catalog-serving rollout.
