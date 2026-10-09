import assert from 'node:assert/strict';
import test from 'node:test';
import { assertReviewedMaster, driftTolerated, EDGE_ONLY_DIFF, REVIEWED_MASTER }
  from '../tools/ui-combined-source-guard.mjs';

const MOVED = 'a'.repeat(40);

test('combined UI pin accepts the exact reviewed Atmos master with no intervening diff', () => {
  assert.doesNotThrow(() => assertReviewedMaster(REVIEWED_MASTER, [...EDGE_ONLY_DIFF]));
  assert.throws(() => assertReviewedMaster(REVIEWED_MASTER, [...EDGE_ONLY_DIFF, 'app/src/main.tsx']));
  assert.throws(() => assertReviewedMaster(REVIEWED_MASTER, ['platform/edge/wrangler.jsonc']));
  assert.throws(() => assertReviewedMaster('not-a-sha', []));
  assert.throws(() => assertReviewedMaster(REVIEWED_MASTER, 'app/src/main.tsx'));
});

test('a moved master is tolerated only when every changed path is outside the UI closure', () => {
  assert.doesNotThrow(() => assertReviewedMaster(MOVED, []));
  assert.doesNotThrow(() => assertReviewedMaster(MOVED, [
    'docs/admin/decisions.md', 'data/fetch_cams.py', 'ops/commercial/publish-source.mjs', 'ops/fusion/run_study.py',
    'platform/edge/src/commercialApi/plans.ts', 'platform/edge/commercial-portal/src/App.tsx',
    'platform/edge/wrangler.commercial-status.jsonc', 'platform/edge/test/commercialApiPlans.test.ts',
    'platform/edge/test/commercialApi/metering.test.ts', 'platform/edge/scripts/test-commercial-api-runtime.mjs',
    'clients/python/README.md', 'experiments/models/x.md', '.github/workflows/ci.yml', 'ops/test_ci_efficiency.py',
  ]));
  for (const refused of ['app/src/main.tsx', 'app/package.json', 'app/package-lock.json', 'app/functions/api/ai.ts',
    'app/public/index.html', 'app/e2e/public-release-journeys.mjs', 'platform/edge/src/index.ts',
    'platform/edge/src/data.ts', 'platform/edge/wrangler.jsonc', 'platform/edge/wrangler.data.jsonc',
    'platform/edge/package.json', 'platform/edge/package-lock.json', 'platform/edge/test/aircraftBudget.test.ts',
    'ops/release/guard-pages-deploy.sh', 'ops/platform/deploy-production-shell.sh', 'ops/bake-weatherx.sh',
    'testing/suites.json', 'tools/testing/network-guard.mjs', 'scripts/release-check-clients.mjs', '.gitignore',
    '../app/src/main.tsx', '/app/src/main.tsx', 'docs/../app/src/main.tsx']) {
    assert.throws(() => assertReviewedMaster(MOVED, ['docs/admin/journal.md', refused]), refused);
    assert.equal(driftTolerated(refused), false, refused);
  }
  assert.throws(() => assertReviewedMaster(MOVED, ['docs/x.md', 'app/src/main.tsx']), /inside the UI closure.*app\/src\/main\.tsx/);
});
