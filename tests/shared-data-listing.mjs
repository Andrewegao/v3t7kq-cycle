// Actual pinned rclone against a loopback-only synthetic S3 server. This proves
// listing request amplification, not Cloudflare throughput or the phase of a past run.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const binary = process.env.RCLONE_TEST_BINARY ?? 'rclone';
const minimalEnv = { PATH: process.env.PATH, RCLONE_CONFIG: '/dev/null' };
const version = await execute(binary, ['version'], { env: minimalEnv, timeout: 10_000, maxBuffer: 64 * 1024 });
assert.equal(version.stdout.split(/\r?\n/, 1)[0], 'rclone v1.75.0', 'use the same pinned rclone as hosted preparation');

const bucket = 'fixture-bucket', pageSize = 8;
const objects = Array.from({ length: 24 }, (_, i) => ({
  key: `frames/group-${i % 3}/${String(i).padStart(3, '0')}.png`, size: 100 + i,
})).sort((a, b) => a.key.localeCompare(b.key));
const byKey = new Map(objects.map(o => [o.key, o]));
let counts;
const faults = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const reply = (status, body = '', headers = {}) => {
    response.writeHead(status, { 'Content-Type': 'application/xml', ...headers }); response.end(body);
  };
  if (request.method === 'GET' && url.pathname === `/${bucket}` && url.searchParams.get('list-type') === '2') {
    counts.lists++;
    const prefix = url.searchParams.get('prefix') ?? '';
    const token = url.searchParams.get('continuation-token') ?? '0';
    if (!/^\d+$/.test(token) || url.searchParams.get('delimiter')) {
      faults.push('unexpected listing shape'); return reply(400);
    }
    const filtered = objects.filter(o => o.key.startsWith(prefix)), offset = Number(token);
    const page = filtered.slice(offset, offset + pageSize), next = offset + page.length;
    if (offset > filtered.length) { faults.push('invalid continuation'); return reply(400); }
    const entries = page.map(o => `<Contents><Key>${o.key}</Key><LastModified>2026-08-31T12:00:00.000Z</LastModified>` +
      `<ETag>"d41d8cd98f00b204e9800998ecf8427e"</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass></Contents>`).join('');
    return reply(200, '<?xml version="1.0" encoding="UTF-8"?>' +
      '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
      `<Name>${bucket}</Name><Prefix>${prefix}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys>` +
      `<IsTruncated>${next < filtered.length}</IsTruncated>` + entries +
      (next < filtered.length ? `<NextContinuationToken>${next}</NextContinuationToken>` : '') + '</ListBucketResult>');
  }
  const key = url.pathname.startsWith(`/${bucket}/`) ? decodeURIComponent(url.pathname.slice(bucket.length + 2)) : null;
  if (request.method === 'HEAD' && byKey.has(key)) {
    counts.objectHeads++;
    return reply(200, '', { 'Content-Type': 'image/png', 'Content-Length': String(byKey.get(key).size),
      'Last-Modified': 'Mon, 31 Aug 2026 12:00:00 GMT', ETag: '"d41d8cd98f00b204e9800998ecf8427e"',
      'x-amz-meta-mtime': '1788177600' });
  }
  // The fixture never serves object GETs and cannot accept any write operation.
  faults.push(`unexpected ${request.method} ${url.pathname}`);
  reply(400, '<Error><Code>InvalidRequest</Code></Error>');
});

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const env = { ...minimalEnv, RCLONE_CONFIG_OBJECTS_TYPE: 's3', RCLONE_CONFIG_OBJECTS_PROVIDER: 'Cloudflare',
    RCLONE_CONFIG_OBJECTS_REGION: 'auto', RCLONE_CONFIG_OBJECTS_ENDPOINT: endpoint,
    RCLONE_CONFIG_OBJECTS_FORCE_PATH_STYLE: 'true', RCLONE_CONFIG_OBJECTS_ACCESS_KEY_ID: 'synthetic-only',
    RCLONE_CONFIG_OBJECTS_SECRET_ACCESS_KEY: 'synthetic-only' };
  async function list(extra) {
    counts = { lists: 0, objectHeads: 0 };
    const { stdout } = await execute(binary, ['lsjson', `objects:${bucket}`, '--recursive', '--files-only',
      '--s3-no-check-bucket', '--retries', '1', '--low-level-retries', '1', '--contimeout', '2s', '--timeout', '5s', ...extra],
    { env, timeout: 20_000, maxBuffer: 1024 * 1024 });
    const values = JSON.parse(stdout).map(({ Path, Size, IsDir }) => ({ Path, Size, IsDir }))
      .sort((a, b) => a.Path.localeCompare(b.Path));
    return { counts: { ...counts }, values };
  }
  const baseline = await list([]), optimized = await list(['--no-modtime', '--no-mimetype']);
  const expected = objects.map(o => ({ Path: o.key, Size: o.size, IsDir: false }));
  assert.deepEqual(faults, [], 'unexpected synthetic S3 request');
  assert.deepEqual(baseline.values, expected, 'default listing lost source identity or size');
  assert.deepEqual(optimized.values, expected, 'optimized listing lost source identity or size');
  assert.equal(baseline.counts.lists, objects.length / pageSize, 'default listing must consume every page');
  assert.equal(optimized.counts.lists, baseline.counts.lists, 'optimization must not omit pagination');
  assert.equal(baseline.counts.objectHeads, objects.length, 'default metadata listing must demonstrate one HEAD per object');
  assert.equal(optimized.counts.objectHeads, 0, 'metadata-free listing must not HEAD objects');
  console.log(JSON.stringify({ test: 'shared-data-listing', rclone: '1.75.0', objects: objects.length,
    baseline: baseline.counts, optimized: optimized.counts, samePathSizeIsDir: true,
    syntheticLoopbackOnly: true, historicalTimeoutCauseProven: false }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
