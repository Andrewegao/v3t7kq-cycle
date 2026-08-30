import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { normalizedBindings, boundedTimeout, transaction } from '../tools/consumer-refresh.mjs';

const SHA = 'e4799774847788708fd9bd3fdef577369e2782c7';
const RELEASE = 'cycle-33333979833';
const prior = { platform: '11111111-1111-1111-1111-111111111111', data: '22222222-2222-2222-2222-222222222222' };
const uploaded = { platform: '33333333-3333-3333-3333-333333333333', data: '44444444-4444-4444-4444-444444444444' };
const foreign = '55555555-5555-5555-5555-555555555555';
const digest = value => createHash('sha256').update(value).digest('hex');

// Execute the actual helper main() with its imports replaced by isolated capabilities.
// No network, subprocess, production credential, disk write, or real wait is available.
function harness(options = {}) {
  let now = Date.parse('2026-08-30T23:00:00Z');
  const startedAt = now;
  const active = { ...prior };
  const calls = [];
  const files = new Map();
  const receiptPath = '/mock/receipt.json';
  const pointer = Buffer.from(JSON.stringify({ releaseId: RELEASE }));
  const configs = {};
  const settings = {};
  const before = {};
  for (const id of ['platform', 'data']) {
    configs[id] = {
      name: `weatherx-${id === 'platform' ? 'platform' : 'data'}-edge-production`,
      account_id: 'a89f9a1af485021fbc60a68b163c7c6e',
      compatibility_date: '2026-08-28', compatibility_flags: ['nodejs_compat'],
      workers_dev: false, routes: [],
      vars: { AUTH_MODE: id === 'platform' ? 'observe' : 'public', DATA_CATALOG_MODE: id === 'platform' ? 'shadow' : 'serve', ...(id === 'platform' ? { BILLING_MODE: 'disabled' } : {}) },
      secrets: { required: ['AUTH_HASH_KEY'] },
    };
    settings[id] = {
      compatibility_date: configs[id].compatibility_date,
      compatibility_flags: configs[id].compatibility_flags,
      bindings: [...Object.entries(configs[id].vars).map(([name, text]) => ({ name, text, type: 'plain_text' })), { name: 'AUTH_HASH_KEY', type: 'secret_text' }],
    };
    before[id] = {
      version: prior[id],
      settingsSha256: digest(JSON.stringify({ bindings: normalizedBindings(settings[id].bindings), compatibility_date: settings[id].compatibility_date, compatibility_flags: settings[id].compatibility_flags, routes: [], crons: [] })),
    };
    const configName = id === 'platform' ? 'wrangler.jsonc' : 'wrangler.data.jsonc';
    const environment = id === 'platform' ? 'production' : 'production-serve';
    files.set(`/mock/atmos/platform/edge/${configName}`, JSON.stringify({ env: { [environment]: configs[id] } }));
  }
  const receipt = { schemaVersion: 1, sha: SHA, release: RELEASE, createdAt: new Date(now).toISOString(), workflowRun: 'test-run', workflowAttempt: '1', before, proof: { pointerSha256: digest(pointer), points: [], fallbacks: [] }, status: 'preflight-passed' };
  files.set(receiptPath, JSON.stringify(receipt));
  let expired = false;
  let concurrent = false;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const fakeProcess = {
    argv: [], execPath: '/mock/node',
    env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'Andrewegao/v3t7kq-cycle', GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'Andrewegao/v3t7kq-cycle/.github/workflows/consumer-refresh.yml@refs/heads/main', GITHUB_RUN_ID: 'test-run', GITHUB_RUN_ATTEMPT: '1', DATA_EDGE_TOKEN: 'fake-data', PLATFORM_EDGE_TOKEN: 'fake-platform' },
    once() {}, removeListener() {},
  };
  const cli = async (_command, args, execution) => {
    const id = args.includes('wrangler.data.jsonc') ? 'data' : 'platform';
    assert.ok(execution.timeout > 0 && execution.timeout <= 180_000);
    if (args[1] === 'versions' && args[2] === 'upload') {
      calls.push(`upload:${id}`);
      return { stdout: `Worker Version ID: ${uploaded[id]}` };
    }
    if (args[1] === 'versions' && args[2] === 'deploy') {
      assert.equal(args[3], `${uploaded[id]}@100%`);
      calls.push(`deploy:${id}`);
      active[id] = uploaded[id];
      if (options.ambiguousDeploy === id) throw Error('simulated lost deploy response');
      return { stdout: '' };
    }
    if (args[1] === 'rollback') {
      assert.equal(args[2], prior[id]);
      calls.push(`rollback:${id}`);
      active[id] = prior[id];
      return { stdout: '' };
    }
    throw Error('unmocked subprocess invocation');
  };
  const fakeFetch = async (input, request) => {
    assert.equal(request.method, 'GET');
    request.signal.throwIfAborted();
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.cloudflare.com');
    if (url.pathname.endsWith('/objects/releases/current.json')) return new Response(pointer);
    if (url.pathname.endsWith('/workers/routes')) return Response.json({ success: true, result: [] });
    const match = /\/scripts\/weatherx-(platform|data)-edge-production\/(.+)$/.exec(url.pathname);
    assert.ok(match, 'every remote read must be explicitly mocked');
    const [, id, suffix] = match;
    if (suffix === 'settings') {
      if (options.concurrentPublisher && id === 'data' && active.platform === uploaded.platform && !concurrent) {
        active.data = foreign;
        concurrent = true;
      }
      return Response.json({ success: true, result: settings[id] });
    }
    if (suffix === 'schedules') return Response.json({ success: true, result: { schedules: [] } });
    if (suffix === 'deployments') {
      const response = Response.json({ success: true, result: { deployments: [{ created_on: '2026-08-30T23:00:00Z', versions: [{ version_id: active[id], percentage: 100 }] }] } });
      if (options.expireAfterFirstActivation && id === 'platform' && active.platform === uploaded.platform && !expired) {
        now = startedAt + 8 * 60_000 + 1;
        expired = true;
      }
      return response;
    }
    if (suffix === `versions/${uploaded[id]}`) {
      calls.push(`inspect-staged:${id}`);
      const resources = { bindings: structuredClone(settings[id].bindings), script_runtime: { compatibility_date: settings[id].compatibility_date, compatibility_flags: settings[id].compatibility_flags } };
      if (options.stagedMismatch === id) resources.bindings[0].text = 'unexpected-mode';
      return Response.json({ success: true, result: { id: uploaded[id], resources } });
    }
    throw Error('unmocked remote read');
  };
  const context = vm.createContext({
    assert, createHash, resolve, dirname, pathToFileURL, fileURLToPath, Buffer, URL, URLSearchParams,
    Request, Response, AbortController, AbortSignal, Date: Clock,
    console: { log() {}, error() {} }, process: fakeProcess,
    execFileSync(command, args) { assert.equal(command, 'git'); return args[0] === 'rev-parse' ? `${SHA}\n` : ''; },
    execFile() { throw Error('direct subprocess forbidden'); }, promisify: () => cli,
    readFileSync(path) { assert.ok(files.has(path), `unmocked file read: ${path}`); return files.get(path); },
    writeFileSync(path, data) { assert.equal(path, receiptPath); files.set(path, data); },
    mkdirSync() {}, existsSync: () => false,
    registerHooks() { throw Error('source importing is outside mocked execute scope'); }, stripTypeScriptTypes() { throw Error('unexpected transpilation'); },
    fetch: fakeFetch, setTimeout(callback, ms) { now += ms; queueMicrotask(callback); },
  });
  const original = readFileSync(new URL('../tools/consumer-refresh.mjs', import.meta.url), 'utf8');
  const executable = original.replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '').replace(/^export /gm, '').replace(/^if\(process\.argv\[1\].*$/m, '');
  vm.runInContext(`${executable}\nglobalThis.reviewMain = main;`, context, { filename: 'isolated-consumer-refresh.mjs' });
  return { active, calls, run: command => context.reviewMain([command, '--atmos', '/mock/atmos', '--receipt', receiptPath, '--release', RELEASE, '--sha', SHA]), receipt: () => JSON.parse(files.get(receiptPath)) };
}

test('actual main rejects staged data bindings before either consumer receives traffic', async () => {
  const h = harness({ stagedMismatch: 'data' });
  await assert.rejects(h.run('execute'), /bindings differ/);
  assert.deepEqual(h.calls, ['upload:platform', 'inspect-staged:platform', 'upload:data', 'inspect-staged:data']);
  assert.deepEqual(h.active, prior);
});

test('actual main preserves another publisher and restores only its own activated consumer', async () => {
  const h = harness({ concurrentPublisher: true });
  await assert.rejects(h.run('execute'), /rollback incomplete for data/);
  assert.equal(h.active.data, foreign);
  assert.equal(h.active.platform, prior.platform);
  assert.deepEqual(h.calls.filter(x => /^(deploy|rollback):/.test(x)), ['deploy:platform', 'rollback:platform']);
  assert.equal(h.receipt().status, 'failed');
  await assert.rejects(h.run('recover'), /independent recovery incomplete/);
  assert.equal(h.active.data, foreign);
  assert.equal(h.receipt().recovery, 'incomplete');
});

test('actual main reserves a fresh rollback deadline after first-activation expiry', async () => {
  const h = harness({ expireAfterFirstActivation: true });
  await assert.rejects(h.run('execute'), /prior versions restored/);
  assert.deepEqual(h.active, prior);
  assert.deepEqual(h.calls.filter(x => /^(deploy|rollback):/.test(x)), ['deploy:platform', 'rollback:platform']);
  assert.equal(h.receipt().status, 'failed');
});

test('actual main rolls back both versions when a successful activation loses its response', async () => {
  const h = harness({ ambiguousDeploy: 'data' });
  await assert.rejects(h.run('execute'), /prior versions restored/);
  assert.deepEqual(h.active, prior);
  assert.deepEqual(h.calls.filter(x => /^(deploy|rollback):/.test(x)), ['deploy:platform', 'deploy:data', 'rollback:data', 'rollback:platform']);
});

test('pure transaction does not verify after a deadline prevents the second activation', async () => {
  const calls = [];
  let now = 0;
  await assert.rejects(transaction(['platform', 'data'], {
    deploy: async id => { boundedTimeout(30_000, 10, now); calls.push(`deploy:${id}`); now = 10; },
    verify: async () => assert.fail('verification must not run'),
    rollback: async id => calls.push(`rollback:${id}`),
  }), /prior versions restored/);
  assert.deepEqual(calls, ['deploy:platform', 'rollback:data', 'rollback:platform']);
});
