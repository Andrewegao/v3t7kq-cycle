import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workflow=readFileSync(new URL('../.github/workflows/bake.yml',import.meta.url),'utf8');
export function validateCollectorSource(text){
  const checkout=text.split('      - name: checkout atmos (private, read-only deploy key)')[1]?.split('      - name:')[0];
  assert.ok(checkout,'collector checkout missing');
  const source=checkout.match(/^          ref: ([a-f0-9]{40})$/m)?.[1];
  assert.ok(source,'collector must use a literal approved commit, never default branch or variable fallback');
  assert.match(checkout,/persist-credentials: false/);
  const verification=text.split('      - name: Verify approved immutable collector before running source')[1]?.split('      - name:')[0];
  assert.ok(verification,'source verification missing');
  assert.ok(verification.includes(`test "$(git rev-parse HEAD)" = "${source}"`),'actual checkout must match approved source');
  assert.ok(verification.includes('git diff --exit-code HEAD'),'tracked source must be clean');
  assert.ok(text.indexOf('name: Verify approved immutable collector before running source')<text.indexOf('name: plan conservative no-change fast path'),'verify source before first collector script');
  assert.doesNotMatch(text,/wrangler pages|UI_PRODUCTION_PAGES_TOKEN|UI_STAGING_PAGES_TOKEN/);
  return source;
}
test('production maintenance uses an immutable approved source before any source script',()=>{
  assert.match(validateCollectorSource(workflow),/^[a-f0-9]{40}$/);
});
test('distributed maintenance never restores unused checkpoint files into its guarded checkout',()=>{
  const bake=workflow.split('\n  bake:\n')[1].split('\n  model-status:\n')[0];
  assert.match(bake,/CORE_MODEL_PACKS_DIR: \$\{\{ runner.temp \}\}\/core-model-packs/);
  assert.doesNotMatch(bake,/ops\/\.maintenance-checkpoint|maintenance_checkpoint.py|MAINTENANCE_CHECKPOINT_ENABLED/);
  assert.match(bake,/name: save rolling verification cache/,'independent rolling observations cache remains');
  assert.match(bake,/name: hydrate and verify current production R2 release/);
});
test('missing, floating, mismatched and dirty-source guards are rejected',()=>{
  // Mutate the production bake job's own checkout, not the regional family checkout that precedes it.
  const at=workflow.indexOf('      - name: checkout atmos (private, read-only deploy key)');assert.ok(at>0);
  const mutate=(fn)=>workflow.slice(0,at)+fn(workflow.slice(at));
  const pinned=mutate(t=>t.replace(/^          ref: [a-f0-9]{40}$/m,'          ref: '+'a'.repeat(40)).replace(/test "\$\(git rev-parse HEAD\)" = "[a-f0-9]{40}"/,'test "$(git rev-parse HEAD)" = "'+'a'.repeat(40)+'"'));
  validateCollectorSource(pinned);
  const tail=pinned.slice(at),head=pinned.slice(0,at);
  for(const candidate of [tail.replace(/^          ref:.*\n/m,''),tail.replace(/^          ref:.*$/m,'          ref: master'),tail.replace(/^          ref:.*$/m,'          ref: ${{ vars.COLLECTOR_SHA }}'),tail.replace('git diff --exit-code HEAD','true'),tail.replace('test "$(git rev-parse HEAD)"','test "wrong"')])assert.throws(()=>validateCollectorSource(head+candidate));
});

// Sealed inputs authenticate the collector's actual source SHA. Moving only the
// whole bake would refuse those inputs; the paired publisher has the same contract.
export function validateMaintenanceSourceClosure({bake, core, regional, publisher, stagingWind, productionWind, stagingPolicy, productionPolicy}) {
  const source = validateCollectorSource(bake);
  const diagnostic = bake.split('      - name: retain encrypted bake diagnostic receipt\n')[1]
    ?.split('      - name:')[0];
  assert.match(diagnostic ?? '', new RegExp(`^          ATMOS_SHA: ${source}$`, 'm'),
    'encrypted diagnostic must name the source that actually ran');
  for (const [kind, text] of [['core', core], ['regional', regional]]) {
    const checkout = text.split(`      - name: checkout atmos ${kind} collector (same approved commit, read-only deploy key)\n`)[1]
      ?.split('      - name:')[0];
    const pin = checkout?.match(/^          ref: ([a-f0-9]{40})$/m)?.[1];
    assert.equal(pin, source, `${kind} sealed inputs must share the maintenance source`);
    assert.match(checkout, /persist-credentials: false/);
    const verification = text.split(`      - name: Verify approved immutable ${kind} collector before running source\n`)[1]
      ?.split('      - name:')[0];
    assert.ok(verification?.includes(`test "$(git rev-parse HEAD)" = "${source}"`),
      `${kind} actual checkout must match its sealed source`);
    assert.ok(verification.includes('git diff --exit-code HEAD'));
  }
  const publisherPin = publisher.match(/^      ATMOS_SHA: ([a-f0-9]{40})$/m)?.[1];
  const checkout = publisher.split('      - name: checkout exact qualified Atmos component publisher\n')[1]
    ?.split('      - uses:')[0];
  assert.equal(publisherPin, source, 'paired publisher must authenticate this collector source');
  assert.match(checkout ?? '', new RegExp(`^          ref: ${source}$`, 'm'));
  assert.match(checkout, /persist-credentials: false/);
  assert.ok(publisher.includes('test "$(git -C atmos rev-parse HEAD)" = "$ATMOS_SHA"'));
  assert.ok(publisher.includes('git -C atmos diff --exit-code HEAD'));
  // Source closure never supplies or bypasses the separate protected environment approval.
  assert.ok(publisher.includes('APPROVED_SHA: ${{ vars.CURRENT_RUN_COMPONENT_PUBLISH_ATMOS_SHA }}'));
  assert.ok(publisher.includes('test "$APPROVED_SHA" = "$ATMOS_SHA"'));
  assert.ok(publisher.includes('test "$ENABLED" = true'));
  assert.ok(publisher.includes('test "$ATMOS_SHA" != "$UNQUALIFIED_PLACEHOLDER_SHA"'));
  for (const [kind, text, policy] of [
    ['staging', stagingWind, stagingPolicy], ['production', productionWind, productionPolicy],
  ]) {
    assert.match(text, new RegExp(`^      CORE_ATMOS_SHA: ${source}$`, 'm'),
      `${kind} Wind100 must consume the actual ordinary core source`);
    const checkout = text.split('      - name: Checkout the exact ordinary core producer\n')[1]
      ?.split('      - name:')[0];
    assert.match(checkout ?? '', new RegExp(`^          ref: ${source}$`, 'm'));
    assert.match(checkout, /persist-credentials: false/);
    assert.ok(text.includes('--atmos-source-sha "$CORE_ATMOS_SHA"'));
    assert.ok(text.includes('test "$(git -C atmos-core rev-parse HEAD)" = "$CORE_ATMOS_SHA"'));
    assert.equal(policy.coreSourceSha, source);
    assert.equal(policy.sourceSha, '9174329db6ca8527569e67f14ef70406dedefb69',
      'the independently qualified Wind100 backend does not move with ordinary inputs');
    assert.match(text, /^      ATMOS_SHA: 9174329db6ca8527569e67f14ef70406dedefb69$/m);
  }
  return source;
}
const closure = {
  bake: workflow,
  core: readFileSync(new URL('../.github/workflows/collect-core-model.yml', import.meta.url), 'utf8'),
  regional: readFileSync(new URL('../.github/workflows/collect-regional-model.yml', import.meta.url), 'utf8'),
  publisher: readFileSync(new URL('../.github/workflows/publish-current-model-production.yml', import.meta.url), 'utf8'),
  stagingWind: readFileSync(new URL('../.github/workflows/staging-wind100-recurring.yml', import.meta.url), 'utf8'),
  productionWind: readFileSync(new URL('../.github/workflows/production-wind100-recurring.yml', import.meta.url), 'utf8'),
  stagingPolicy: JSON.parse(readFileSync(new URL('../tools/staging-wind100-policy.json', import.meta.url), 'utf8')),
  productionPolicy: JSON.parse(readFileSync(new URL('../tools/production-wind100-policy.json', import.meta.url), 'utf8')),
};
test('reviewed maintenance, sealed collectors, publisher and diagnostic share the exact recovery source', () => {
  assert.equal(validateMaintenanceSourceClosure(closure), '5e68af94c24517eaaaf6a9d25aec0cadc3d9b135');
});
test('a whole-bake-only repin cannot silently relabel sealed collector inputs', () => {
  const original = validateMaintenanceSourceClosure(closure);
  const candidate = {...closure, bake: closure.bake.replaceAll(original, 'a'.repeat(40))};
  assert.throws(() => validateMaintenanceSourceClosure(candidate), /core sealed inputs/);
  for (const member of ['core', 'regional', 'publisher']) {
    assert.throws(() => validateMaintenanceSourceClosure({...closure,
      [member]: closure[member].replaceAll(original, 'b'.repeat(40))}), /must share|must authenticate/);
  }
});
test('mismatched diagnostic identity and bypassed protected source approval remain refused', () => {
  const original = validateMaintenanceSourceClosure(closure);
  const at = closure.bake.indexOf('      - name: retain encrypted bake diagnostic receipt\n');
  const bake = closure.bake.slice(0, at) + closure.bake.slice(at).replace(original, 'c'.repeat(40));
  assert.throws(() => validateMaintenanceSourceClosure({...closure, bake}), /diagnostic/);
  assert.throws(() => validateMaintenanceSourceClosure({...closure,
    publisher: closure.publisher.replace('test "$APPROVED_SHA" = "$ATMOS_SHA"', 'true')}));
});

test('Wind100 ordinary input pins and policies cannot drift or move the qualified backend', () => {
  const source = validateMaintenanceSourceClosure(closure);
  for (const member of ['stagingWind', 'productionWind']) {
    assert.throws(() => validateMaintenanceSourceClosure({...closure,
      [member]: closure[member].replaceAll(source, 'd'.repeat(40))}), /ordinary core source/);
  }
  for (const member of ['stagingPolicy', 'productionPolicy']) {
    assert.throws(() => validateMaintenanceSourceClosure({...closure,
      [member]: {...closure[member], coreSourceSha: 'e'.repeat(40)}}));
    assert.throws(() => validateMaintenanceSourceClosure({...closure,
      [member]: {...closure[member], sourceSha: source}}), /backend does not move/);
  }
});
