import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReviewedMaster, EDGE_ONLY_DIFF, REVIEWED_MASTER }
  from '../tools/ui-combined-source-guard.mjs';

test('combined UI pin accepts only the exact reviewed Atmos master', () => {
  assert.doesNotThrow(() => assertReviewedMaster(REVIEWED_MASTER, [...EDGE_ONLY_DIFF]));
  assert.throws(() => assertReviewedMaster('0'.repeat(40), [...EDGE_ONLY_DIFF]));
  assert.throws(() => assertReviewedMaster(REVIEWED_MASTER, [...EDGE_ONLY_DIFF, 'app/src/main.tsx']));
  assert.throws(() => assertReviewedMaster(REVIEWED_MASTER, ['platform/edge/wrangler.jsonc']));
});
