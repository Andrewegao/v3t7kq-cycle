# Search V4 reader closure review — `fac2fc164420`

Status: local compatibility evidence only. This record does not approve an environment
variable, activate a search pointer, dispatch a workflow, deploy a UI, or replace the
required browser qualification of the exact canonical staging release.

## Reviewed identities

- Immutable Search V4 producer: `dfa25e9f473f15d5e2f630fe78c268b73234bd3a`.
- Previously approved UI source: `6121d1695a18465fefb11b239b53caddb5e1977b`.
- Reviewed UI source: `fac2fc164420d4d31870a410c9a877d16ad76fb0`.
- The reviewed source was the current `weatherx-hq/atmos` `origin/master` when fetched on
  2026-09-16. Both the producer and previous UI source are ancestors of it.
- The canonical staging receipt was observed read-only as
  `git-fac2fc164420-run-35045196899`. That observation is not a fresh browser
  qualification and must be re-read immediately before any activation.

## Closure review

Five existing closure files changed between the previous and reviewed sources. Their
new exact SHA-256 values are:

| Path | SHA-256 | Compatibility finding |
| --- | --- | --- |
| `app/src/chrome/Search.tsx` | `ccc1d445d69cebc9494444f43491d79ab3633d1fb8c73ba149ef0f9b991f701e` | Still calls the bounded `loadCore`/`loadMore` reader; retry and idle warm-up do not bypass parsing. |
| `app/src/chrome/searchIndex.ts` | `6a3fcfdca59107060e59380ce1b5fc26bc56a200d13634698db3ee08be3f9400` | V2 family validation and exact `baked_at` pair matching remain fail-closed. The generation change only admits the already-deployed independently baked V1 pair. |
| `app/src/chrome/searchCompose.ts` | `f5892709df1c93acc608f71be1bb534e8bc9bac5e0708493bc5315a7933297f3` | Ranking, stable ordering, airport matching, and place identity were refined after parsing; no index schema or transport check was weakened. |
| `app/src/chrome/searchNormalize.ts` | `08a7619586b832a532a4465436f0d06400b309db9a5aac3ee2409441d85f8b5c` | Adds NFKC and airport query normalization only. |
| `app/src/chrome/searchIntent.ts` | `06daf588a5cf65c8c4981eac5395d3700b9043967338f8fa2f72e939d5517595` | Corrects time/layer intent interpretation only. |

`Search.tsx` also moved formerly inline place and layer source functions into a new direct
dependency. Leaving that file outside the closure would create an unreviewed mutation path,
so the exact boundary is expanded from nine to ten files:

- `app/src/chrome/searchSources.ts` —
  `06dcd924ad857c32a027a02dfd735d6a33eb77d6398b3ee4daae4640437e1c38`.

The other four existing closure files are byte-identical to the prior approval:

- `app/src/chrome/searchShape.ts` — `014802f8bb9f00bc662899384c85e22c1c5e1b51940501e14272bcce4490fc9e`.
- `app/src/chrome/searchLedger.ts` — `77c088ec01def39e24024f60130b6ed5e4887b802d25906022fe687385bedbc1`.
- `app/src/data/gazetteer.ts` — `095c2ad3c8a46154a52e777285c82cd332859bc162c6c646be771de48586b128`.
- `app/src/lib/boundedResponse.ts` — `5260d0cc1035b1f350f321bd91e17af9ddd097cb556c49986f3a545245fa40c2`.

The runtime URLs remain `/data-atmos/search/core.json` and
`/data-atmos/search/more.json`. V2 still requires canonical UTC generation equality before
installing a cross-file pair, exact family contracts, bounded row counts, validated display
rows, coordinates, dictionary columns, binary weights, and station-to-airport links. A
malformed or split V2 pair is not installed.

## Local evidence

All commands used Node `22.21.1` in fresh detached Atmos and fresh Cycle worktrees.

- Exact real-checkout closure proof returned
  `{"uiSourceSha":"fac2fc164420d4d31870a410c9a877d16ad76fb0","searchV4BaseSha":"dfa25e9f473f15d5e2f630fe78c268b73234bd3a","files":10}`.
- Nineteen focused Atmos Search suites passed: 442 passed, 1 existing todo, 0 failed.
  Coverage includes V1/V2 generation behavior, malformed index rejection, real ranking,
  normalization, intent, stable composition/order, fuzzy warm-up batching/cancellation,
  shell mounting/layout, retries, recents, dedupe, and provider behavior.
- The complete Atmos TypeScript project build check (`tsc -b`) and focused ESLint check
  for all six reviewed Search source files passed.
- All Cycle `staging-search*.mjs` publication, transport, build, closure, and reader
  suites passed: 51 passed, 0 failed.
- `git diff --check` passed for all reviewed Search source changes.

These tests establish local compatibility of the exact source and controller closure. They
do not prove the current network path, CDN observation, Pages artifact, or live browser.

## Safe activation and rollback sequence

1. Merge this Cycle closure through normal review; do not change the protected source or
   release allowlists before the merged controller is present on `main`.
2. Re-deploy or identify the exact canonical staging artifact built from the reviewed source,
   then browser-qualify V1 reads, all Search families, SFO/KSFO, failure/retry behavior, and
   unrelated weather/account behavior. Capture the fresh release receipt and shell digest.
3. Only after that review, set the two exact protected approvals to that source and release.
   Inspect the current pointer immediately before activation and use its exact digest for CAS.
4. Activate only the already-reviewed immutable V2 candidate. Verify both unversioned Search
   URLs, release headers, browser behavior, and unchanged production identity.
5. On any mismatch, stop. If no pointer was written, no rollback is needed. If activation was
   confirmed, inspect first and use `revoke` with the exact current pointer digest; do not
   retry an uncertain write. The reader falls back to the prior V1 path after its bounded
   cache interval. UI rollback remains a separate reviewed UI release operation.

No protected variable, workflow, Cloudflare/R2 object, deployment, branch push, or active
worktree was changed while producing this evidence.
