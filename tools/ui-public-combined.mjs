// Exact production Lab UI candidate: public RU/KK, dynamic native Wind100, desktop intro.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LANE_B_CONTRACT } from './production-account-contract.mjs';

export const PUBLIC_COMBINED_REQUEST = 'production-account-ru-kk-wind100-intro-v1';
export const PUBLIC_COMBINED_APPROVAL = PUBLIC_COMBINED_REQUEST;
export const PUBLIC_COMBINED_WIND100_RECEIPT = 'production-native-dynamic-v1';
export const PUBLIC_COMBINED_LOCALE_RECEIPT = 'ru-kk-public-beta-v1';
export const PUBLIC_COMBINED_INTRO_SOURCE_SHA256 = 'b21fd3688004d182b667ee870c7c83567a3f2498f2ec786698ef515ab1cd3bdd';
export const PUBLIC_COMBINED_ACCOUNT_SOURCES = Object.freeze({
  'client.ts': 'a06ec9e7d56551dae4fbf07ae552cf296365e5749d5c7e9f47b080f481588f1a',
  'pointSeriesContract.ts': '8a3ae4af11d87a37e954891bbdb43b0907c591c65ca902852bc5a13e2af7d36e',
  'session.ts': '9896c3b9382f5a64e2bad0d43c298c2a4af670cb3e645874d08629caf343e6b3',
  'PlatformAccount.tsx': '2a4c2f8feb2bd8017c7f7104ecc3a7dfdc0ec89daa208c1f79a32526f68b1bae',
  'accountEntry.ts': 'b997aaabe8dc9efa6d8b7b15e385c257ba0e1a33a42456ed55a0c3fc9b51e386',
  'accountDoor.ts': '14acf20279baf760cbf5a6890dfcb66d7330b5a353a69f80e802ec34f3d22bcf',
  'PlatformAccountBoundary.tsx': '796337fb0db7a6bb0d9cbbc56b3820a26e263b9107b8f296f8fa0b0a8e9c9580',
  'challenges.ts': 'a32e0786bc5f074bfc96217ba2e69ef1e7536f31ebe014a32e57afec50b3a266',
});
export const PUBLIC_COMBINED_SIDECAR = 'assets/weatherx-production-account-build-v1.json';
// Replace only with the final reviewed, pushed Atmos master commit.
export const PUBLIC_COMBINED_ATMOS_SHA = 'b9db38dd22eed1da56c6c4dd4140480da7e89153';

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
  exact(sidecar.intro, ['enabled', 'sourceSha256', 'chunks']);
  assert.equal(sidecar.intro.enabled, true);
  assert.equal(sidecar.intro.sourceSha256, PUBLIC_COMBINED_INTRO_SOURCE_SHA256);
  assert.ok(Array.isArray(sidecar.intro.chunks) && sidecar.intro.chunks.length === 1,
    'exactly one production intro chunk is required');
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
