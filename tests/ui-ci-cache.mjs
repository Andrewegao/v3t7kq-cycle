import assert from 'node:assert/strict';
import test from 'node:test';
import { lockedPlaywrightVersion } from '../tools/ui-ci-cache.mjs';

const lock=(packages)=>JSON.stringify({lockfileVersion:3,packages:{'':{},...packages}});
test('browser cache key is the exact locked playwright-core version',()=>{
  assert.equal(lockedPlaywrightVersion(lock({'node_modules/playwright-core':{version:'1.61.1'},
    'node_modules/playwright':{version:'1.61.1'},'node_modules/@playwright/test':{version:'1.61.1'}})),'1.61.1');
  assert.equal(lockedPlaywrightVersion(lock({'node_modules/playwright-core':{version:'1.61.1'}})),'1.61.1');
});
test('ambiguous, missing or key-injecting versions are refused',()=>{
  for(const packages of [{},{'node_modules/playwright-core':{}},{'node_modules/playwright-core':{version:'^1.61.1'}},
    {'node_modules/playwright-core':{version:'1.61.1\nkey=x'}},{'node_modules/playwright-core':{version:'1.61.1-beta'}},
    {'node_modules/playwright-core':{version:'1.61.1'},'node_modules/playwright':{version:'1.60.0'}},
    {'node_modules/playwright-core':{version:'1.61.1'},'node_modules/@playwright/test':{version:'1.62.0'}}])
    assert.throws(()=>lockedPlaywrightVersion(lock(packages)),JSON.stringify(packages));
  for(const text of ['','{',JSON.stringify({lockfileVersion:1,dependencies:{}}),'null'])
    assert.throws(()=>lockedPlaywrightVersion(text));
});
