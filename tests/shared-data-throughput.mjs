// Loopback latency/request-count experiment. No real weather, remote credentials,
// production writes, or claim that these timings represent Cloudflare throughput.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const execute = promisify(execFile), binary = process.env.RCLONE_TEST_BINARY ?? 'rclone';
const plainEnv = { PATH: process.env.PATH, RCLONE_CONFIG: '/dev/null' };
const version = await execute(binary, ['version'], { env: plainEnv, timeout: 10_000, maxBuffer: 65536 });
assert.equal(version.stdout.split(/\r?\n/, 1)[0], 'rclone v1.75.0', 'experiment requires hosted pinned version');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delayMs = 35, listChunk = 12;
const cases = [
  { name: 'baseline', transfers: 4, copyChecks: 8, checks: 4, fast: false },
  { name: 'fast-list-only', transfers: 4, copyChecks: 8, checks: 4, fast: true },
  { name: 'transfers16-only', transfers: 16, copyChecks: 8, checks: 4, fast: false },
  { name: 'readback16-only', transfers: 4, copyChecks: 8, checks: 16, fast: false },
  { name: 'combined', transfers: 16, copyChecks: 16, checks: 16, fast: true },
];
const temp = mkdtempSync(resolve(tmpdir(), 'wx-throughput-fixture-'));
const root = resolve(temp, 's3'), source = resolve(root, 'source', 'tree');
const inventory = Array.from({ length: 64 }, (_, index) => {
  const path = `group-${Math.floor(index / 8)}/layer-${Math.floor(index / 4) % 2}/${String(index % 4).padStart(3, '0')}.bin`;
  const bytes = Buffer.alloc(16 * 1024, index + 1); bytes.writeUInt32LE(index);
  const file = resolve(source, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
  return { path, bytes: bytes.length, sha256: hash(bytes) };
}).sort((a, b) => a.path.localeCompare(b.path));
// rclone-serve initially returned HTTP500 / "file does not exist" during
// concurrent PUT into newly created paths. R2 has no filesystem directories:
// precreate empty fixture parents to exclude that VFS namespace-creation
// behavior, not to hide an R2 failure. No destination object exists, and every
// upload must still issue all 64 PUTs. This remains a synthetic backend limit.
for (const variant of cases) for (const object of inventory)
  mkdirSync(dirname(resolve(root, 'dest-' + variant.name, 'tree', object.path)), { recursive: true });
function inspect(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = prefix + entry.name, full = resolve(dir, entry.name);
    return entry.isDirectory() ? inspect(full, path + '/') : [{ path, bytes: readFileSync(full).length, sha256: hash(readFileSync(full)) }];
  }).sort((a, b) => a.path.localeCompare(b.path));
}

let backend, proxy, stats, backendOutput = '';
const faults = [], pendingTimers = new Set();
const freshStats = () => ({ requests: { LIST: 0, GET: 0, PUT: 0, HEAD: 0 }, continuationLists: 0,
  active: { LIST: 0, GET: 0, PUT: 0, HEAD: 0 }, peak: { LIST: 0, GET: 0, PUT: 0, HEAD: 0 } });
try {
  // Anonymous synthetic server: no request signing is evaluated or forwarded to
  // any external address. Clients receive only fixed dummy credentials below.
  backend = spawn(binary, ['serve', 's3', root, '--addr', '127.0.0.1:0'], { env: plainEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  const backendUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('fixture server startup timeout')), 10_000);
    backend.once('error', error => { clearTimeout(timer); reject(error); });
    backend.once('exit', () => { clearTimeout(timer); reject(Error('fixture server exited')); });
    backend.stderr.on('data', chunk => {
      backendOutput = (backendOutput + chunk).slice(-65536);
      const address = backendOutput.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (address) { clearTimeout(timer); resolve(address); }
    });
  });
  stats = freshStats();
  proxy = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url, 'http://127.0.0.1');
    const bucket = url.pathname.split('/')[1];
    const isList = incoming.method === 'GET' && url.searchParams.get('list-type') === '2';
    const kind = isList ? 'LIST' : incoming.method;
    if (!['LIST', 'GET', 'HEAD', 'PUT'].includes(kind) ||
        !(bucket === 'source' || cases.some(c => bucket === 'dest-' + c.name)) ||
        (kind === 'PUT' && (!bucket.startsWith('dest-') || url.pathname.split('/').length < 3))) {
      faults.push(`unexpected ${incoming.method} ${url.pathname}`); outgoing.writeHead(400); outgoing.end(); return;
    }
    const counted = stats;
    counted.requests[kind]++; counted.active[kind]++;
    counted.peak[kind] = Math.max(counted.peak[kind], counted.active[kind]);
    if (isList && url.searchParams.has('continuation-token')) counted.continuationLists++;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; counted.active[kind]--; } };
    outgoing.once('close', finish); outgoing.once('finish', finish);
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      const upstream = httpRequest(backendUrl + incoming.url, { method: incoming.method, headers: incoming.headers }, response => {
        outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing);
      });
      upstream.once('error', () => { faults.push('loopback upstream failure'); outgoing.writeHead(502); outgoing.end(); });
      incoming.once('aborted', () => upstream.destroy()); incoming.pipe(upstream);
    }, delayMs);
    pendingTimers.add(timer);
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const env = { ...plainEnv, RCLONE_CONFIG_OBJECTS_TYPE: 's3', RCLONE_CONFIG_OBJECTS_PROVIDER: 'Other',
    RCLONE_CONFIG_OBJECTS_REGION: 'auto', RCLONE_CONFIG_OBJECTS_ENDPOINT: `http://127.0.0.1:${proxy.address().port}`,
    RCLONE_CONFIG_OBJECTS_FORCE_PATH_STYLE: 'true', RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID: 'synthetic',
    RCLONE_CONFIG_OBJECTS_SECRET_ACCESS_KEY: 'synthetic' };
  const common = ['--s3-no-check-bucket', '--s3-list-version', '2', '--s3-list-chunk', String(listChunk),
    '--retries', '1', '--low-level-retries', '1', '--contimeout', '3s', '--timeout', '10s'];
  async function run(args) {
    return execute(binary, [...args, ...common], { env, timeout: 60_000, maxBuffer: 1024 * 1024 });
  }
  // Prime source directory metadata before timing; all measured cases start with
  // fresh local directories and separate initially empty destination buckets.
  await run(['lsjson', 'objects:source/tree', '--recursive', '--files-only', '--no-modtime', '--no-mimetype']);
  async function measured(args) {
    assert.ok(Object.values(stats.active).every(n => n === 0)); stats = freshStats();
    const started = performance.now(); await run(args);
    assert.ok(Object.values(stats.active).every(n => n === 0));
    const { requests, continuationLists, peak } = stats;
    return structuredClone({ elapsedMs: Math.round(performance.now() - started), requests, continuationLists, peak });
  }
  const results = [];
  for (const variant of cases) {
    const local = resolve(temp, variant.name), destination = `objects:dest-${variant.name}/tree`;
    mkdirSync(local);
    const fast = variant.fast ? ['--fast-list'] : [];
    const copyFlags = ['--transfers', String(variant.transfers), '--checkers', String(variant.copyChecks), ...fast];
    const download = await measured(['copy', 'objects:source/tree', local, ...copyFlags]);
    assert.deepEqual(inspect(local), inventory, 'downloaded bytes or complete inventory differ');
    const upload = await measured(['copy', local, destination, '--immutable', ...copyFlags]);
    assert.deepEqual(inspect(resolve(root, 'dest-' + variant.name, 'tree')), inventory, 'uploaded bytes differ');
    const readback = await measured(['check', local, destination, '--download', '--checkers', String(variant.checks), ...fast]);
    assert.equal(download.requests.GET, inventory.length, 'download must read every object exactly once');
    assert.equal(upload.requests.PUT, inventory.length, 'fresh upload must write every object exactly once');
    assert.equal(readback.requests.GET, inventory.length, 'verification must read every remote object');
    assert.ok(download.peak.GET <= variant.transfers && upload.peak.PUT <= variant.transfers, 'transfer concurrency exceeds selected bound');
    assert.ok(readback.peak.GET <= variant.checks, 'readback concurrency exceeds selected bound');
    const corruptPath = resolve(root, 'dest-' + variant.name, 'tree', inventory[0].path);
    const bad = Buffer.alloc(inventory[0].bytes, 254); writeFileSync(corruptPath, bad);
    await assert.rejects(run(['check', local, destination, '--download', '--checkers', String(variant.checks), ...fast]),
      error => error.code === 1 && /group-0\/layer-0\/000\.bin: contents differ/.test(error.stderr ?? '') &&
        /1 differences found/.test(error.stderr ?? '') && /63 matching files/.test(error.stderr ?? '') &&
        !/InternalError|operation error S3|StatusCode:\s*5/.test(error.stderr ?? ''),
      'same-size corruption must fail on actual downloaded byte mismatch, not a transport failure');
    assert.equal(hash(readFileSync(corruptPath)), hash(bad), 'read-only verification changed corrupt object');
    const result = { ...variant, download, upload, readback, fullBytesVerified: true, sameSizeCorruptionRefused: true };
    results.push(result); console.log(JSON.stringify({ event: 'throughput-case', ...result }));
  }
  assert.deepEqual(inspect(source), inventory, 'source changed');
  assert.deepEqual(faults, [], 'unexpected fixture operation');
  assert.ok(results.some(r => r.download.continuationLists > 0), 'experiment must exercise ListV2 pagination');
  console.log(JSON.stringify({ event: 'throughput-summary', rclone: '1.75.0', objects: inventory.length,
    bytes: inventory.reduce((n, o) => n + o.bytes, 0), requestDelayMs: delayMs, listChunk,
    syntheticLoopbackOnly: true, cloudThroughputClaim: false, results }));
} catch (error) {
  // Only synthetic loopback logs exist in this experiment; never add this to
  // the real transfer controller, whose remote stderr is deliberately hidden.
  console.error(JSON.stringify({ event: 'synthetic-throughput-failure', backendOutput, faults }));
  throw error;
} finally {
  for (const timer of pendingTimers) clearTimeout(timer);
  if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
  if (backend && backend.exitCode === null) {
    const ended = new Promise(resolve => backend.once('exit', resolve)); backend.kill('SIGTERM'); await ended;
  }
}
