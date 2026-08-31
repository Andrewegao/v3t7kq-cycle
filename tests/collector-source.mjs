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
test('missing, floating, mismatched and dirty-source guards are rejected',()=>{
  const pinned=workflow.replace(/^          ref: [a-f0-9]{40}$/m,'          ref: '+'a'.repeat(40)).replace(/test "\$\(git rev-parse HEAD\)" = "[a-f0-9]{40}"/,'test "$(git rev-parse HEAD)" = "'+'a'.repeat(40)+'"');
  validateCollectorSource(pinned);
  for(const candidate of [pinned.replace(/^          ref:.*\n/m,''),pinned.replace(/^          ref:.*$/m,'          ref: master'),pinned.replace(/^          ref:.*$/m,'          ref: ${{ vars.COLLECTOR_SHA }}'),pinned.replace('git diff --exit-code HEAD','true'),pinned.replace('test "$(git rev-parse HEAD)"','test "wrong"')])assert.throws(()=>validateCollectorSource(candidate));
});
