# Search V4 reader compatibility review — SF `8b2aa22066ec`

Status: local compatibility evidence only. This patch does not approve protected settings,
activate or renew a search pointer, fetch candidate objects, dispatch a workflow, deploy a
UI/Worker, or qualify a live browser. The expired pointer still requires separately authorized
recovery and fresh candidate-byte/source/release acceptance.

## Immutable identities and historical record

- Search V4 producer remains `dfa25e9f473f15d5e2f630fe78c268b73234bd3a`.
- Previous ten-file reader approval: `fac2fc164420d4d31870a410c9a877d16ad76fb0`.
- Reviewed SF source: `8b2aa22066ecbf736ff3aa133d0c4bf7f332eaad`.
- `staging-search-reader-review-fac2fc164420.md` remains unchanged historical evidence;
  its old source, hashes, tests and observed release are not relabeled as SF qualification.

The previous UI source, rather than the earlier producer, is the comparison baseline.
Nine of its ten pinned files differ in SF; `searchLedger.ts` is byte-identical.

## Bounded sixteen-file closure

| Path | Exact SHA-256 |
| --- | --- |
| `app/src/chrome/Search.tsx` | `69aaa185ac45f0f9d699c23b764927eb9a6c2f424902c890e32820fa977da4dc` |
| `app/src/chrome/searchIndex.ts` | `071b6c483256304729a1e7d5a3d3fdaa6ddfc4470cf01181ac2b98d796365165` |
| `app/src/chrome/searchCompose.ts` | `96f09ee1315c1fc4f6d34d9f4d4b96e1909c4ac7dc513039014d25232e395cd4` |
| `app/src/chrome/searchNormalize.ts` | `c9f10f833bee37efec00764fa74797da979077b80ba412edb17c007bc1da56ec` |
| `app/src/chrome/searchIntent.ts` | `7cb2df1a5eeb8239e500225555cf51725e33ff536db6229fb2feffc5c3fc90f1` |
| `app/src/chrome/searchShape.ts` | `b90b863519c0cb73abde4c00296a6b37d411d01ed6632bd4711850abdb97737c` |
| `app/src/chrome/searchLedger.ts` | `77c088ec01def39e24024f60130b6ed5e4887b802d25906022fe687385bedbc1` |
| `app/src/chrome/searchSources.ts` | `8d1452181ebc9a4972341f6774975835239f7490b295fa8df8519ae2d2a0a813` |
| `app/src/data/gazetteer.ts` | `6be88846dea87a7c2cb9dadaa9bbea8be2ac0d6a590a0b9e7848d73ba77243ea` |
| `app/src/lib/boundedResponse.ts` | `cc63fdc6187f78752283703b61cc6bb0edde820c86d2b46b3ab8b4066e88acb6` |
| `app/src/chrome/searchCoords.ts` | `9a44ac34f5335d9e4f2ecf036f745b670aa9dccffb79b441192e4285c55b1e0e` |
| `app/src/chrome/searchMessages.ts` | `53f8d81ddc7e41f352288894b1a9e8bb0f33e0947802c125ecaec9c472dbce5a` |
| `app/src/i18n/localeRegistry.ts` | `753b0d6901209ecc3f67b0b2cc701c108d72092ed387feb33f13422131884ab8` |
| `app/src/i18n/names.ts` | `58825d3d85a6ffe9d639781721a6a3f15796bc524d29b9fc965b5a60925292c6` |
| `app/src/i18n/kazakhCountryNames.ts` | `c2dd4393720ab6e9bc8d7178573959e4497d75172a719c25efe712d7cad58077` |
| `app/src/i18n/runtime.ts` | `a2a934e868c893084f67d066204c97bf22a42096f27d4cc7d8800b58d33c859d` |

SF externalizes coordinates, copy and geographic-language dependencies. The six added
pins cover `searchCoords`, `searchMessages`, `names`, `localeRegistry`,
`kazakhCountryNames` and the shared locale runtime.

This is a bounded reader/normalization closure, **not a full transitive UI review**.
Additional dependencies include `OsmAttribution`, `proentry/proEntry`, dynamically loaded
`layers/hazardDoor`, `layers/eumetsatFlag`, existing `i18n/index`, `hazards/countryList`,
`data/addressGeocode`, and external `@lingui/core`. Attribution, entry admission, layer
behavior, account and Wind100 compatibility depend on separately qualified exact SF UI
source/profile evidence. These pins do not approve arbitrary later main commits.

## Wire and profile compatibility

Immutable fac2-to-SF source comparison found exact byte equality of the core/more family
contracts (472 bytes), V1/V2 envelope and row definitions (612 bytes), and the 11,958-byte
parser/generation/atomic-pair install/bounded split-pair retry/load-state region.
Runtime URLs remain `/data-atmos/search/core.json` and `/data-atmos/search/more.json`.
V2 still requires matching canonical UTC `baked_at`, exact five nonempty runtime families,
validated coordinates/display/dictionaries/binary weights/station-airport links, and refuses
malformed or split pairs. Existing independently baked V1 generation behavior is preserved.
Transport deadline/body cancellation and row scanning changes do not change this schema.
This source comparison does not qualify any remote candidate bytes.

A separate combined-profile branch accepts exactly these six string keys/values:

```
product=lab
platformAccount=1
platformDataAuth=public
accountRelease=production-account-billing-v1
wind100=production-native-dynamic-v2
localeBeta=ru-kk-public-beta-v1
```

The legacy base and exact Wind100 catalog/run/selection (including its validated dynamic
variant) branches remain unchanged. Mixed profiles, extra/missing keys, other types and
other values fail. Exact approved source/head, clean tree, producer ancestry, bounded
regular non-symlink files and every closure digest remain required. Live verification still
requires exact approved release/source, bounded no-redirect credential-free GETs and the
actual index digest. No source, lease, CAS, candidate, credential or uncertain-write check
is relaxed.

## Validation and recovery boundary

The two regressions were reproduced before implementation: old ten-file pins failed the
independent SF sixteen-file expectation, and the exact six-key receipt was rejected. Tests
also cover each closure entry missing/changed, strict source/ancestry/cleanliness evidence,
all six profile keys and values/types, mixed profiles, source/release/index mismatch and
existing publication/lease/CAS/authorization checks. Current test counts and immutable
patch hashes belong in the external execution receipt, not historical release claims.

Before any separately authorized recovery, merge/review the controller, qualify the exact
canonical UI source/profile, independently inspect candidate pair bytes and source release,
then obtain fresh pointer bytes/ETag for CAS. An expired pointer cannot be revived by renewal.
A preview or reconstructed pointer hash is not publication authorization. No protected
setting, workflow, Cloudflare/R2 object or deployment is changed by this patch. Publishing this
code for review does not authorize data activation or protected setting changes.
