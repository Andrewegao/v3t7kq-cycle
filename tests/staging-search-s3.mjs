import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSearchS3 } from '../tools/staging-search-s3.mjs';
import { BUCKET, POINTER_KEY, hash } from '../tools/staging-search.mjs';
const env = { STAGING_R2_ACCOUNT_ID: 'a89f9a1af485021fbc60a68b163c7c6e', STAGING_R2_WRITE_ACCESS_KEY_ID: 'fixture', STAGING_R2_WRITE_SECRET_ACCESS_KEY: 'fixture' };
const key = `staging-candidates/${'a'.repeat(64)}/search/core.json`, body = Buffer.from('{}');
test('SDK adapter has one fixed staging bucket and conditional immutable writes', async () => {
  const commands = [];
  const io = createSearchS3(env, { send: async command => {
    commands.push(command); return command.constructor.name === 'GetObjectCommand' ?
      { Body: Readable.from([body]), ContentLength: body.length, ETag: '"fixture"' } : { ETag: '"new"' };
  } });
  assert.equal((await io.get(key, 100)).sha256, hash(body));
  await io.put(key, body, { ifNoneMatch: '*', sha256: hash(body) });
  await io.put(POINTER_KEY, body, { ifMatch: '"old"', sha256: hash(body) });
  assert.ok(commands.every(c => c.input.Bucket === BUCKET));
  assert.equal(commands[1].input.IfNoneMatch, '*'); assert.equal(commands[2].input.IfMatch, '"old"');
  assert.deepEqual(commands[1].input.Metadata, { sha256: hash(body) });
  for (const target of ['releases/current.json', 'catalogs/current.json', 'shared-read/pin.json', 'weatherx-data-production/x']) {
    assert.throws(() => io.get(target, 100)); await assert.rejects(io.put(target, body, { ifNoneMatch: '*', sha256: hash(body) }));
  }
  await assert.rejects(io.put(key, body, { ifMatch: '"old"', sha256: hash(body) }));
  await assert.rejects(io.put(key, body, { ifNoneMatch: '*', ifMatch: '"old"', sha256: hash(body) }));
  await assert.rejects(io.put(key, body, { ifNoneMatch: '*', sha256: 'bad' }));
  assert.equal(commands.length, 3);
});
test('uncertain writes do not retry and never echo provider secrets', async () => {
  let calls = 0;
  const io = createSearchS3(env, { send: async () => { calls++; throw Error('PRIVATE SECRET'); } });
  await assert.rejects(io.put(key, body, { ifNoneMatch: '*', sha256: hash(body) }), e => !e.message.includes('PRIVATE'));
  assert.equal(calls, 1);
  assert.throws(() => createSearchS3({ ...env, STAGING_R2_WRITE_SECRET_ACCESS_KEY: '' }));
});
