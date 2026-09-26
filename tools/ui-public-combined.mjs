// Exact production Lab UI candidate: public RU/KK, dynamic native Wind100, reviewed onboarding.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LANE_B_CONTRACT } from './production-account-contract.mjs';

export const PUBLIC_COMBINED_REQUEST = 'production-account-ru-kk-wind100-onboarding-v2';
export const PUBLIC_COMBINED_APPROVAL = PUBLIC_COMBINED_REQUEST;
export const PUBLIC_COMBINED_WIND100_RECEIPT = 'production-native-dynamic-v2';
export const PUBLIC_COMBINED_LOCALE_RECEIPT = 'ru-kk-public-beta-v1';
export const PUBLIC_COMBINED_INTRO_SOURCE_SHA256 = '30a3c65cd46cb18b117bc9196be0d7ed8d483c5d7710a42fb5757817026fad7a';
export const PUBLIC_COMBINED_ACCOUNT_SOURCES = Object.freeze({
  'client.ts': 'a06ec9e7d56551dae4fbf07ae552cf296365e5749d5c7e9f47b080f481588f1a',
  'pointSeriesContract.ts': '8a3ae4af11d87a37e954891bbdb43b0907c591c65ca902852bc5a13e2af7d36e',
  'session.ts': '9896c3b9382f5a64e2bad0d43c298c2a4af670cb3e645874d08629caf343e6b3',
  'PlatformAccount.tsx': '9d445087416c6d4651ed0134d9f97d6fbd9149ed411c738e3d26dd5a7ff8a872',
  'accountEntry.ts': '5e168d190409e503cf12ef3501893bf6a757c37fe3558d8e29e018fbbdab532c',
  'accountDoor.ts': '14acf20279baf760cbf5a6890dfcb66d7330b5a353a69f80e802ec34f3d22bcf',
  'PlatformAccountBoundary.tsx': '796337fb0db7a6bb0d9cbbc56b3820a26e263b9107b8f296f8fa0b0a8e9c9580',
  'challenges.ts': 'a32e0786bc5f074bfc96217ba2e69ef1e7536f31ebe014a32e57afec50b3a266',
});
export const PUBLIC_COMBINED_ONBOARDING_SOURCES = Object.freeze({
  'onboarding/Icon.tsx': '5eeaba1dae9c441527fa778ed46629c7aeed3f0248bb846095101fbe7a30b1c0',
  'onboarding/ProductionAccountIntro.tsx': '30a3c65cd46cb18b117bc9196be0d7ed8d483c5d7710a42fb5757817026fad7a',
  'onboarding/arriveOnce.ts': 'b6d00ed02c7cca6f1dc97703d4a1198f6aa7aa7c1a86cd1692c8705f5f9e7674',
  'onboarding/data.ts': '2a54b7bd7bfaa939c289653467bca4431ff3c6b6aa9bfb2116f1527b4a4c5f72',
  'onboarding/extraReads.ts': '725da8ef3634be80d0bd3ec4605e44acefb5984bfaa60a29dc74bd5ef772929e',
  'onboarding/icons.ts': '51958fd6c47166a9e2849198aefefb7b4e5ad954a09c681ea32dfd6ba342a9d1',
  'onboarding/intent.ts': '0111ac4a418eb8a77ffa856e0de499e6943c311529f6622b9e1a562c1f1045fa',
  'onboarding/onboarding.css': '8781fcee214cdda1dd13e4a28a3dad706c685a928b9a0a6c2cb0641e6363e05b',
  'onboarding/screens/AddPlace.tsx': '0c0cbb7ee3374fd0130c0e7de9d51957246a7a23b37def011584114b1ab317f8',
  'onboarding/screens/Check.tsx': '4071f6089602b1cc6ea398fa64568cdd8deff7761504d509ee0afe6121b0757e',
  'onboarding/screens/Purpose.tsx': '57f03edc68f55ab25543ed6f7757a3fa1ac87fba5b2f17c8e6f1312d4cbb967b',
  'onboarding/screens/See.tsx': 'fec8d52b7e9ad9ffeef1c4920d632ff41dd5be06328e6dfaa382155333cae96e',
  'onboarding/screens/Start.tsx': '86d8904823966c1011e71231eda0f77583b593a956a3787cd199177d8252b9d2',
  'onboarding/screens/Watch.tsx': 'ce59077b992405aac3595e50a4d22de4e25934d12874297b6db90330161e0a57',
  'onboarding/screens/WeekChart.tsx': '44c022c1f3e312aa94724aa53387a55724c552857de483b0571b4d88f992831c',
  'onboarding/screens/Windows.tsx': 'f6590d28b811adc7c5f660ac115e7d445b98e2259b77546087b134205ed87dfa',
  'onboarding/screens/addPlace.css': 'fca6644b08396c862d63ec6f4fd72a913ac31a0388c8517973bd26083fed1a90',
  'onboarding/screens/addPlaceMessages.ts': 'c5f21f196dcdc4eb6764b306466050cb393dd940178a2cba46d9fd4f387c2c04',
  'onboarding/screens/stackWhenClipped.ts': 'fb2f83a969ab54471c9e349254deac849b9715727494207dc7cbbfc96c6c7cda',
  'onboarding/screens/startCopy.ts': 'ec022d3dff4dfd53092c53666d12c784eee396bfd5e0df82764dfbef2ec32787',
  'onboarding/shared/chart.ts': 'b87fd82b98e7e7759bc47288ee25a3b5086a39e28559954cf1dfad3278c569b2',
  'onboarding/shared/checkPhase.ts': 'db7142fb5a49c1c2b8f9479162ee4d1fdcdd0675f19320499346dc2ece3a3b31',
  'onboarding/shared/grid.ts': '934c90545721675f2f5da95d61b3533737c99acae2ad012aa777c530438ffe12',
  'onboarding/shared/personas.ts': 'e67a18eb4c88a6a271aa4b43c0d0e76c657ec6a4df3376618a3c7ed502c2085b',
  'onboarding/shared/reads.ts': 'd5d2778e24f25c263e78bac76315e723b3ea14b6547815057eb9820adad06ea6',
  'onboarding/shared/score.ts': '817c68de1d151d97feabba1c3992c64bdf34307b8ad1a57c061059012fd69a6b',
  'onboarding/shared/scoreMotion.ts': 'bcf0e6e99ea3e67fc74f2cc385eca813618e8c684fbd4f49d3afb389d20773cd',
  'onboarding/shared/stormClass.ts': '0c4adf33682a4c074993bb14861e8f4c3c6e124e3dfc1b1ec5bcab3766c80b00',
  'onboarding/shared/units.ts': '6826907c816ed1bd1c6a82e0a66845911b751c9e186f4265ff3eb25de2818f8c',
  'onboarding/shared/verdict.ts': '9c7523fff3573bd31944bb246d30285af33189120ff96027219396790bf11e25',
  'onboarding/shared/watch.ts': '35c46bbfe0ef39e58445cf964bf138bcad26c47de504043e4b1a2b29218e9078',
  'onboarding/sheetSignal.ts': '25726f372bc967f79c902daaf812a2e825ace6d4a876fca31ae87d247784f7b0',
  'onboarding/useIntroScrimWindow.ts': 'b03ae6371a30f6afc99a7f21659dea8a0f44d600d68e51ce422957c24b8c59a6',
  'onboarding/useObData.ts': 'c9d259db928451a62c7ce3a8188b4cce21119ba402f0a8406ead5b8bc1b3ddf0',
});
export const PUBLIC_COMBINED_SIDECAR = 'assets/weatherx-production-account-build-v1.json';
export const PUBLIC_COMBINED_ATMOS_SHA = '9da64b54fadf6efb21302c1504575c75bf5b1d54';

export function assertPublicCombinedReady() {
  assert.match(PUBLIC_COMBINED_ATMOS_SHA, /^[a-f0-9]{40}$/);
  assert.ok(!/^0+$/.test(PUBLIC_COMBINED_ATMOS_SHA),
    'combined public beta requires an exact reviewed Atmos master SHA');
  return PUBLIC_COMBINED_ATMOS_SHA;
}

function exact(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}
const SHA = /^[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateCombinedBuild(receipt, files) {
  assert.deepEqual(receipt?.buildProfile, {
    ...LANE_B_CONTRACT.buildReceipt,
    wind100: PUBLIC_COMBINED_WIND100_RECEIPT,
    localeBeta: PUBLIC_COMBINED_LOCALE_RECEIPT,
  }, 'combined production Lab build receipt differs');
  assert.ok(Array.isArray(files));
  const inventory = new Map(files.map(file => [file.path, file]));
  assert.equal(inventory.size, files.length);
  const sidecarFile = inventory.get(PUBLIC_COMBINED_SIDECAR);
  assert.ok(sidecarFile, 'production account build sidecar is required');
  const sidecarBytes = Buffer.from(sidecarFile.base64, 'base64');
  assert.ok(sidecarBytes.length > 0 && sidecarBytes.length <= 64 * 1024);
  assert.equal(sidecarFile.sha256, digest(sidecarBytes));
  const sidecar = JSON.parse(sidecarBytes);
  exact(sidecar, ['schemaVersion', 'profile', 'reviewedSourcesSha256',
    'accountChunks', 'billingUiEnabled', 'intro']);
  assert.equal(sidecar.schemaVersion, 1);
  assert.equal(sidecar.profile, 'production-account-billing-v1');
  assert.equal(sidecar.billingUiEnabled, false, 'billing UI must remain off');
  exact(sidecar.intro, ['enabled', 'sourceSha256', 'reviewedSourcesSha256', 'chunks']);
  assert.equal(sidecar.intro.enabled, true);
  assert.equal(sidecar.intro.sourceSha256, PUBLIC_COMBINED_INTRO_SOURCE_SHA256);
  assert.deepEqual(sidecar.intro.reviewedSourcesSha256, PUBLIC_COMBINED_ONBOARDING_SOURCES,
    'onboarding sidecar source hashes differ from the reviewed production graph');
  assert.ok(Array.isArray(sidecar.intro.chunks) && sidecar.intro.chunks.length >= 1
    && sidecar.intro.chunks.length <= 64,
  'one to 64 production onboarding chunks are required');
  assert.ok(Array.isArray(sidecar.accountChunks) && sidecar.accountChunks.length > 0
    && sidecar.accountChunks.length <= 8);
  assert.deepEqual(sidecar.reviewedSourcesSha256, PUBLIC_COMBINED_ACCOUNT_SOURCES,
    'account sidecar source hashes differ from the reviewed production sources');
  const seenChunks = new Set();
  for (const chunk of [...sidecar.accountChunks, ...sidecar.intro.chunks]) {
    exact(chunk, ['path', 'bytes', 'sha256']);
    assert.match(chunk.path, /^assets\/[A-Za-z0-9._-]+\.js$/);
    assert.ok(!seenChunks.has(chunk.path), 'duplicate production account or intro chunk');
    seenChunks.add(chunk.path);
    assert.match(chunk.sha256, SHA);
    assert.ok(Number.isSafeInteger(chunk.bytes) && chunk.bytes > 0);
    const file = inventory.get(chunk.path);
    assert.ok(file, `sidecar chunk missing from candidate: ${chunk.path}`);
    assert.equal(file.bytes, chunk.bytes);
    assert.equal(file.sha256, chunk.sha256);
    assert.equal(digest(Buffer.from(file.base64, 'base64')), chunk.sha256);
  }
  return sidecar;
}
