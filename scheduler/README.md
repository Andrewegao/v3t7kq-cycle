# WeatherX model scheduler

This scheduled-only Cloudflare Worker dispatches the existing GitHub Actions bake workflow. It is a delivery bridge: all model discovery, quality gates, publishing, and promotion remain in `catalog-bake.yml`.

## Schedule

- `8-59/10 * * * *`: dispatch `hrrr`
- `7 * * * *`: dispatch `slow` (`ecmwf`, `gfs`, and `aifs` in parallel)

The GitHub-native schedules remain enabled during rollout as an independent fallback. Existing workflow concurrency and immutable/no-change promotion behavior make duplicate dispatches safe.

## Credential

Create a fine-grained GitHub personal access token restricted to the `Andrewegao/v3t7kq-cycle` repository with only **Actions: Read and write** permission. Store it as the Worker secret; never commit it or reuse the broader GitHub CLI credential.

```sh
npx wrangler secret put GITHUB_DISPATCH_TOKEN
```

## Verify and deploy

```sh
npm ci
npm run check
npx wrangler deploy
```

Cron changes can take several minutes to propagate. Confirm successful Worker scheduled invocations and matching GitHub workflow-dispatch runs before treating the bridge as operational or advancing the catalog-serving rollout.
