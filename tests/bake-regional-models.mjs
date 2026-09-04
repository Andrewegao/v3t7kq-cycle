import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BASELINE_PROFILE,requireProductionProfile} from '../tools/ui-staging-models.mjs';

// The seven regional models (ICON, HRRR Alaska, HRDPS, NAM CONUS/Hawaii/Alaska, AROME Antilles)
// are collected by per-provider family jobs inside the production bake workflow and handed to the
// bake job as public display packs. These contracts keep that topology honest: no provider can
// block the release, no family job holds a publication credential, and both jobs run one commit.
const workflow=readFileSync(new URL('../.github/workflows/bake.yml',import.meta.url),'utf8');
const regional=workflow.slice(workflow.indexOf('\n  regional:'),workflow.indexOf('\n  bake:'));
const bake=workflow.slice(workflow.indexOf('\n  bake:'));

test('family jobs run per provider, bounded, on the same approved commit as the bake',()=>{
  assert.ok(regional.length>0&&bake.length>0,'regional job precedes the bake job (the diagnostic extractor reads the bake job to EOF)');
  assert.match(regional,/family: \[icon, hrdps, arome-antilles, noaa\]/);
  assert.match(regional,/fail-fast: false/);assert.match(regional,/max-parallel: 4/);
  assert.match(regional,/timeout-minutes: 55/);assert.match(regional,/timeout-minutes: 45/,'collection step is bounded below the job timeout');
  assert.match(regional,/environment: production/);
  const refs=[...workflow.matchAll(/^          ref: ([a-f0-9]{40})$/gm)].map(m=>m[1]);
  assert.equal(refs.length,2,'two atmos checkouts: the family job and the bake job');
  assert.equal(refs[0],refs[1],'a pack collected from another commit is refused at install; pin both together');
  assert.equal((regional.match(new RegExp(`test "\\$\\(git rev-parse HEAD\\)" = "${refs[0]}"`,'g'))||[]).length,1);
  assert.match(regional,/git diff --exit-code HEAD/);
  assert.match(regional,/persist-credentials: false/);
  assert.match(regional,/fetch-depth: 32/,'the NOAA stager reads producer bytes from git; a full history is not needed');
  assert.match(regional,/noaa\) models="--model hrrr-ak --model nam --model nam-hi --model nam-ak"/,'NOAA nests share one runner sequentially');
  assert.match(regional,/icon\|hrdps\|arome-antilles\) models="--model \$REGIONAL_FAMILY"/);
  assert.match(regional,/data\/bake_regional_models\.py collect \$models/);
  assert.match(regional,/--source-sha "\$\(git rev-parse HEAD\)" --workers 2 --output "\$RUNNER_TEMP\/regional-packs"/);
  for(const use of regional.matchAll(/uses:\s+([^\s]+)@([^\s]+)/g))assert.match(use[2],/^[a-f0-9]{40}$/,use[1]);
});

test('family jobs hold no publication credential and only public display packs leave the runner',()=>{
  assert.doesNotMatch(regional,/R2_|CLOUDFLARE|CATALOG_|PAGES|wrangler|rclone|publish-r2|bake-weatherx|MODEL_INPUT_ARCHIVE_KEY|STAGING_R2/);
  assert.equal((regional.match(/secrets\./g)||[]).length,1,'only the read-only atmos deploy key');
  assert.match(regional,/secrets\.ATMOS_DEPLOY_KEY/);
  assert.match(regional,/name: regional-packs-\$\{\{ matrix\.family \}\}/);
  assert.match(regional,/path: \$\{\{ runner\.temp \}\}\/regional-packs/);
  assert.match(regional,/retention-days: 1/,'four cycles a day of ~230 MB must not accumulate as artifact storage');
  assert.match(regional,/if-no-files-found: warn/);
  assert.match(regional,/hand the display packs \(or abstention receipts\) to the bake job\n\s+if: \$\{\{ always\(\) \}\}/,'an abstention receipt is an outcome, not a job failure');
  assert.doesNotMatch(regional,/actions\/cache/,'weather bytes never enter the Actions cache');
});

test('the bake joins the families but never waits on a provider or fails with one',()=>{
  assert.match(bake,/needs: regional\n\s+if: \$\{\{ always\(\) \}\}/,'a failed or timed-out family only abstains in the roster');
  const receive=bake.split('      - name: receive regional display packs from the family jobs')[1]?.split('      - name:')[0];
  assert.ok(receive,'bake job receives the packs before baking');
  assert.match(receive,/if: \$\{\{ steps\.bake_plan\.outputs\.skip != 'true' \}\}/);
  assert.match(receive,/continue-on-error: true/,'a missing artifact set is an abstention, not a failed cycle');
  assert.match(receive,/actions\/download-artifact@[a-f0-9]{40}/);
  assert.match(receive,/pattern: regional-packs-\*/);assert.match(receive,/merge-multiple: true/);
  assert.match(receive,/path: \$\{\{ runner\.temp \}\}\/regional-packs/);
  assert.ok(bake.indexOf('name: receive regional display packs from the family jobs')<bake.indexOf('name: bake → gate → publish immutable data release'));
  assert.ok(bake.indexOf('name: hydrate and verify current production R2 release')<bake.indexOf('name: receive regional display packs from the family jobs'),
    'the hydrated release is the carry-forward baseline the installer compares against');
  const step=bake.split('      - name: bake → gate → publish immutable data release')[1].split('      - name:')[0];
  assert.match(step,/REGIONAL_PACKS_DIR: \$\{\{ runner\.temp \}\}\/regional-packs/);
  assert.match(bake,/regional-model install \(icon\|hrrr-ak\|hrdps\|nam\|nam-hi\|nam-ak\|arome-antilles\) status=\(fresh\|carried\|absent\)/,'roster outcomes survive the log tail');
});

test('the production UI profile is unchanged: release-carried regional models are data admission, not a build flag',()=>{
  assert.deepEqual(BASELINE_PROFILE,{product:'lab',account:false,expandedModels:false,data:false});
  requireProductionProfile(BASELINE_PROFILE);
});
