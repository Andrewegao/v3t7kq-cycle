import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BASELINE_PROFILE,requireProductionProfile} from '../tools/ui-staging-models.mjs';

// The seven regional models (ICON, HRRR Alaska, HRDPS, NAM CONUS/Hawaii/Alaska, AROME Antilles)
// run alongside four isolated core collectors, then join one publication job. Regional failures
// abstain; incomplete core collection cannot publish. All three job definitions use one source.
const workflow=readFileSync(new URL('../.github/workflows/bake.yml',import.meta.url),'utf8');
const core=workflow.slice(workflow.indexOf('\n  core:'),workflow.indexOf('\n  regional:'));
const regional=workflow.slice(workflow.indexOf('\n  regional:'),workflow.indexOf('\n  bake:'));
const bake=workflow.slice(workflow.indexOf('\n  bake:'));

function assertParallelTopology(source){
  const jobs=Object.fromEntries([...source.matchAll(/^  (core|regional|bake):\n([\s\S]*?)(?=^  [a-z][\w-]*:\n|$(?![\s\S]))/gm)].map(m=>[m[1],m[2]]));
  const models=job=>job.match(/^        model: \[([^\]]+)\]$/m)?.[1].split(',').map(m=>m.trim());
  assert.deepEqual(models(jobs.core),['ecmwf','gfs','hrrr','aifs']);
  assert.deepEqual(models(jobs.regional),['icon','hrdps','arome-antilles','hrrr-ak','nam','nam-hi','nam-ak']);
  assert.equal(new Set([...models(jobs.core),...models(jobs.regional)]).size,11);
  for(const job of [jobs.core,jobs.regional]){
    assert.doesNotMatch(job,/^    (?:needs|if):/m,'collectors must be independently schedulable');
    assert.match(job,/fail-fast: false/);
  }
  assert.match(jobs.core,/max-parallel: 4/);assert.match(jobs.regional,/max-parallel: 7/);
  assert.match(jobs.bake,/needs: \[core, regional\]\n\s+if: \$\{\{ always\(\) && !cancelled\(\) && needs\.core\.result == 'success' \}\}/);
  assert.equal((source.match(/run: bash ops\/bake-weatherx\.sh/g)||[]).length,1,'one joined publisher');
}

test('eleven unique model collectors start independently and join one publisher',()=>{
  assertParallelTopology(workflow);
  for(const mutation of [workflow.replace('model: [ecmwf, gfs, hrrr, aifs]','model: [ecmwf, gfs, hrrr, hrrr]'),
    workflow.replace('\n  core:\n','\n  core:\n    needs: regional\n'),
    workflow.replace('max-parallel: 7','max-parallel: 1'),
    workflow.replace(" && needs.core.result == 'success'",''),
    `${workflow}\n        run: bash ops/bake-weatherx.sh\n`])assert.throws(()=>assertParallelTopology(mutation));
});

test('all collectors and the bake use one approved immutable commit',()=>{
  assert.ok(core.length>0&&regional.length>0&&bake.length>0);
  assert.match(regional,/timeout-minutes: 55/);assert.match(regional,/timeout-minutes: 45/,'collection step is bounded below the job timeout');
  assert.equal((workflow.match(/repository: weatherx-hq\/atmos/g)||[]).length,3);
  const refs=[...workflow.matchAll(/^          ref: ([a-f0-9]{40})$/gm)].map(m=>m[1]);
  assert.equal(refs.length,3);assert.equal(new Set(refs).size,1,'all source identities match');
  for(const job of [core,regional,bake]){
    assert.ok(job.includes(`test "$(git rev-parse HEAD)" = "${refs[0]}"`));
    assert.match(job,/git diff --exit-code HEAD/);assert.match(job,/persist-credentials: false/);
    assert.match(job,/fetch-depth: 32/);assert.match(job,/environment: production/);
  }
  assert.match(core,/data\/bake_model_inputs\.py --model "\$CORE_MODEL"/);
  assert.match(core,/ops\/core_model_artifact\.py seal[\s\S]*--model "\$CORE_MODEL" --source-sha "\$\(git rev-parse HEAD\)"/);
  assert.match(core,/--root "\$GITHUB_WORKSPACE" --run-id "\$GITHUB_RUN_ID"/);
  assert.match(regional,/data\/bake_regional_models\.py collect --model "\$REGIONAL_MODEL"/);
  assert.match(regional,/--source-sha "\$\(git rev-parse HEAD\)" --workers 2 --output "\$RUNNER_TEMP\/regional-packs"/);
  for(const use of `${core}\n${regional}`.matchAll(/uses:\s+([^\s]+)@([^\s]+)/g))assert.match(use[2],/^[a-f0-9]{40}$/,use[1]);
});

test('collectors hold no publication credential and upload only their scoped artifacts',()=>{
  for(const job of [core,regional]){
    assert.doesNotMatch(job,/R2_|CLOUDFLARE|CATALOG_|PAGES|wrangler|rclone|publish-r2|bake-weatherx|MODEL_INPUT_ARCHIVE_KEY|STAGING_R2/);
    assert.equal((job.match(/secrets\./g)||[]).length,1,'only the read-only atmos deploy key');
    assert.match(job,/secrets\.ATMOS_DEPLOY_KEY/);assert.doesNotMatch(job,/actions\/cache/);
    assert.match(job,/retention-days: 1/);
  }
  const coreUpload=core.split('      - name: retain only sealed core model inputs for the joined bake')[1];
  assert.match(coreUpload,/name: core-model-packs-\$\{\{ matrix\.model \}\}/);
  assert.match(coreUpload,/path: \$\{\{ runner\.temp \}\}\/core-model-packs/);
  assert.match(coreUpload,/include-hidden-files: true/,'allowlisted point/float sidecars must survive transfer');
  assert.match(coreUpload,/if-no-files-found: error/);
  assert.doesNotMatch(core,/continue-on-error: true|always\(\)/,'failed/unsealed core collection must not upload as success');
  assert.match(regional,/name: regional-packs-\$\{\{ matrix\.model \}\}/);
  assert.match(regional,/path: \$\{\{ runner\.temp \}\}\/regional-packs/);
  assert.match(regional,/retention-days: 1/,'four cycles a day of ~230 MB must not accumulate as artifact storage');
  assert.match(regional,/if-no-files-found: warn/);
  assert.match(regional,/hand the display packs \(or abstention receipts\) to the bake job\n\s+if: \$\{\{ always\(\) \}\}/,'an abstention receipt is an outcome, not a job failure');
});

test('the joined bake requires core artifacts while regional failures remain abstentions',()=>{
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
  const receiveCore=bake.split('      - name: receive sealed core model inputs from all four collectors')[1]?.split('      - name:')[0];
  assert.ok(receiveCore);
  assert.match(receiveCore,/pattern: core-model-packs-\*/);assert.match(receiveCore,/merge-multiple: true/);
  assert.match(receiveCore,/path: \$\{\{ runner\.temp \}\}\/core-model-packs/);
  assert.doesNotMatch(receiveCore,/continue-on-error/,'missing core artifacts cannot be treated as optional');
  const step=bake.split('      - name: bake → gate → publish immutable data release')[1].split('      - name:')[0];
  assert.match(step,/REGIONAL_PACKS_DIR: \$\{\{ runner\.temp \}\}\/regional-packs/);
  assert.match(step,/CORE_MODEL_PACKS_DIR: \$\{\{ runner\.temp \}\}\/core-model-packs/);
  assert.match(bake,/regional-model install \(icon\|hrrr-ak\|hrdps\|nam\|nam-hi\|nam-ak\|arome-antilles\) status=\(fresh\|carried\|absent\)/,'roster outcomes survive the log tail');
});

test('the production UI profile is unchanged: release-carried regional models are data admission, not a build flag',()=>{
  assert.deepEqual(BASELINE_PROFILE,{product:'lab',account:false,expandedModels:false,data:false});
  requireProductionProfile(BASELINE_PROFILE);
});
