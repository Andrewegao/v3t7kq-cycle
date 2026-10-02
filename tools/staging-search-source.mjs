// Immutable reviewed Search V4 producer. A separately protected exact UI source SHA identifies
// the deployed shell; that commit must descend from this producer and preserve this reader closure.
export const ATMOS_SHA = 'dfa25e9f473f15d5e2f630fe78c268b73234bd3a';
// Reviewed f265 reader/normalization and gazetteer-build pins. Final deployed source must
// still equal its protected exact SHA and every reviewed byte; no final merge SHA is inferred.
export const SEARCH_V4_READER_CLOSURE = Object.freeze({
  'app/src/chrome/Search.tsx': '69aaa185ac45f0f9d699c23b764927eb9a6c2f424902c890e32820fa977da4dc',
  'app/src/chrome/searchIndex.ts': '071b6c483256304729a1e7d5a3d3fdaa6ddfc4470cf01181ac2b98d796365165',
  'app/src/chrome/searchCompose.ts': '96f09ee1315c1fc4f6d34d9f4d4b96e1909c4ac7dc513039014d25232e395cd4',
  'app/src/chrome/searchNormalize.ts': 'c9f10f833bee37efec00764fa74797da979077b80ba412edb17c007bc1da56ec',
  'app/src/chrome/searchIntent.ts': '7cb2df1a5eeb8239e500225555cf51725e33ff536db6229fb2feffc5c3fc90f1',
  'app/src/chrome/searchShape.ts': 'b90b863519c0cb73abde4c00296a6b37d411d01ed6632bd4711850abdb97737c',
  'app/src/chrome/searchLedger.ts': '77c088ec01def39e24024f60130b6ed5e4887b802d25906022fe687385bedbc1',
  'app/src/chrome/searchSources.ts': '8d1452181ebc9a4972341f6774975835239f7490b295fa8df8519ae2d2a0a813',
  'app/src/data/gazetteer.ts': 'f4e83093d3ce6a1c68346bc86995a0585b3222cc7a774e7fd369a62228e390d2',
  'app/src/lib/boundedResponse.ts': 'cc63fdc6187f78752283703b61cc6bb0edde820c86d2b46b3ab8b4066e88acb6',
  'app/src/chrome/searchCoords.ts': '9a44ac34f5335d9e4f2ecf036f745b670aa9dccffb79b441192e4285c55b1e0e',
  'app/src/chrome/searchMessages.ts': '53f8d81ddc7e41f352288894b1a9e8bb0f33e0947802c125ecaec9c472dbce5a',
  'app/src/i18n/localeRegistry.ts': '753b0d6901209ecc3f67b0b2cc701c108d72092ed387feb33f13422131884ab8',
  'app/src/i18n/names.ts': '58825d3d85a6ffe9d639781721a6a3f15796bc524d29b9fc965b5a60925292c6',
  'app/src/i18n/kazakhCountryNames.ts': 'c2dd4393720ab6e9bc8d7178573959e4497d75172a719c25efe712d7cad58077',
  'app/src/i18n/runtime.ts': 'a2a934e868c893084f67d066204c97bf22a42096f27d4cc7d8800b58d33c859d',
  'app/src/data/gazetteerCompact.ts': '07934a0eceafb2c9053827892705974cac9c7ab28d3253c3c51950d6f166a1c8',
  'app/src/build/gazetteerAssets.ts': '1518a4baa5e3a281d6cab184a6b7193d5365edf72bf0c84aee5455588ffc4d20',
  'app/src/engine/warm.ts': '30cef6a09c4bfc5f0bae73d1afc0d977d4d4ec6cb77f0e76d8f5d06cdd42a74a',
  'app/vite.config.ts': '5a302ff0e653db4648a8d84e46e8b254c41e255a66783afa2d2bdb2f4157e8e9',
});
export const STAGING_ORIGIN = 'https://staging.weatherx.org';
