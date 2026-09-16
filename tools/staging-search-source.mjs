// Immutable reviewed Search V4 producer. A separately protected exact UI source SHA identifies
// the deployed shell; that commit must descend from this producer and preserve this reader closure.
export const ATMOS_SHA = 'dfa25e9f473f15d5e2f630fe78c268b73234bd3a';
export const SEARCH_V4_READER_CLOSURE = Object.freeze({
  'app/src/chrome/Search.tsx': 'ccc1d445d69cebc9494444f43491d79ab3633d1fb8c73ba149ef0f9b991f701e',
  'app/src/chrome/searchIndex.ts': '6a3fcfdca59107060e59380ce1b5fc26bc56a200d13634698db3ee08be3f9400',
  'app/src/chrome/searchCompose.ts': 'f5892709df1c93acc608f71be1bb534e8bc9bac5e0708493bc5315a7933297f3',
  'app/src/chrome/searchNormalize.ts': '08a7619586b832a532a4465436f0d06400b309db9a5aac3ee2409441d85f8b5c',
  'app/src/chrome/searchIntent.ts': '06daf588a5cf65c8c4981eac5395d3700b9043967338f8fa2f72e939d5517595',
  'app/src/chrome/searchShape.ts': '014802f8bb9f00bc662899384c85e22c1c5e1b51940501e14272bcce4490fc9e',
  'app/src/chrome/searchLedger.ts': '77c088ec01def39e24024f60130b6ed5e4887b802d25906022fe687385bedbc1',
  // Search.tsx moved its formerly inline place/layer source functions here. Keep the extraction
  // inside the exact boundary so a later source-only edit cannot bypass reader review.
  'app/src/chrome/searchSources.ts': '06dcd924ad857c32a027a02dfd735d6a33eb77d6398b3ee4daae4640437e1c38',
  'app/src/data/gazetteer.ts': '095c2ad3c8a46154a52e777285c82cd332859bc162c6c646be771de48586b128',
  'app/src/lib/boundedResponse.ts': '5260d0cc1035b1f350f321bd91e17af9ddd097cb556c49986f3a545245fa40c2',
});
export const STAGING_ORIGIN = 'https://staging.weatherx.org';
