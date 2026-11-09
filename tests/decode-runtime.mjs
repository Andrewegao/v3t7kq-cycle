import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const paths = ['collect-core-model.yml', 'collect-regional-model.yml', 'publish-current-model-production.yml', 'catalog-bake.yml', 'bake.yml'];
export function validateDecodeRuntime(text, name) {
  assert.doesNotMatch(text, /apt-get|libeccodes-dev|dpkg --configure/, `${name}: decoding must not wait for the unrelated Ubuntu development-package tree`);
  const install = text.indexOf('/bin/pip install --only-binary=eccodes,eccodeslib,eckitlib -r ');
  const check = text.indexOf('/bin/python -m eccodes selfcheck');
  assert.ok(install >= 0 && check > install, `${name}: check the installed native wheels before producer work`);
  assert.match(text, /assert sys.platform == "linux" and sys.version_info\[:2\] == \(3, 12\)/);
  assert.match(text, /assert version\("eccodeslib"\) == "2.48.2.27"/);
  assert.match(text, /assert version\("eckitlib"\) == "2.2.0.27"/);
  assert.match(text, /assert eccodes.codes_get_api_version\(\) == "2.48.2"/);
  assert.match(text, /for packing in \("grid_simple", "grid_ccsds", "grid_jpeg"\):/);
  assert.match(text, /assert list\(eccodes.codes_get_values\(decoded\)\) == values/);
  assert.match(text, /finally:\n\s+eccodes.codes_release\(decoded\)\n\s+finally:\n\s+eccodes.codes_release\(handle\)/);
  assert.doesNotMatch(text.slice(install, text.indexOf('\n          PYCODE', check)), /\|\| true|continue-on-error/);
}
for (const name of paths) {
  test(`${name} provisions and verifies the native wheel runtime without apt`, () => {
    validateDecodeRuntime(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8'), name);
  });
}
test('dependency regression and a missing native probe fail the contract', () => {
  const text = readFileSync(new URL('../.github/workflows/collect-core-model.yml', import.meta.url), 'utf8');
  for (const candidate of [text + '\nsudo apt-get install -y libeccodes-dev\n',
    text.replace('/bin/python -m eccodes selfcheck', '/bin/python -V'),
    text.replace('assert list(eccodes.codes_get_values(decoded)) == values', 'pass')]) {
    assert.throws(() => validateDecodeRuntime(candidate, 'mutated'));
  }
});

const url = 'https://github.com/rclone/rclone/releases/download/v1.75.0/rclone-v1.75.0-linux-amd64.zip';
const archiveSha = 'aa2804e08f48250e71009c727124b6341cd0288465804a9a09d14663cabafbaa';
const execute = promisify(execFile);

function archiveCommands(name) {
  const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), 'utf8');
  const start = workflow.indexOf('          archive="');
  const last = 'sudo install -m 0755 "$RUNNER_TEMP/rclone-v1.75.0-linux-amd64/rclone" /usr/local/bin/rclone';
  const end = workflow.indexOf(last, start) + last.length;
  const install = workflow.slice(start, end);
  const shell = install.split('\n').map(line => line.replace(/^ {10}/, '')).join('\n');
  const checksumOffset = shell.indexOf("printf '%s  %s\\n'");
  return {install, versionTail: workflow.slice(end, end + 120), checksumOffset, download: shell.slice(0, checksumOffset),
    throughChecksum: shell.slice(0, shell.indexOf('\nunzip '))};
}

async function archiveFixture(t, commands, responses, {checksum = false, shortTransferTimeout = false} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'weatherx-rclone-download-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const requests = [], payload = Buffer.from('inert synthetic archive bytes; never executed\n');
  const server = createServer((request, response) => {
    requests.push({method: request.method, url: request.url, headers: request.headers});
    const reply = responses[Math.min(requests.length - 1, responses.length - 1)];
    if (reply.stall) return; // Zero headers/body bytes until the actual curl transfer timeout.
    response.writeHead(reply.status, {'Content-Type': 'application/zip', ...reply.headers});
    response.end(reply.status === 200 ? payload : 'synthetic transient or permanent refusal');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const local = `http://127.0.0.1:${server.address().port}/rclone-v1.75.0-linux-amd64.zip`;
  // Shorten only the per-transfer duration for the controlled stalled fixture;
  // the production 120s limit is asserted separately. Original535 has no retry.
  const target = (shortTransferTimeout ? '--max-time 0.2 ' : '') + local;
  const command = (checksum ? commands.throughChecksum : commands.download).replace(url, target)
    + '\nprintf "download-accepted\\n"\n';
  let result;
  try {
    result = {...await execute('/bin/bash', ['-e', '-o', 'pipefail', '-c', command], {
      env: {PATH: '/usr/bin:/bin', HOME: root, RUNNER_TEMP: root}, timeout: 15_000, maxBuffer: 64 * 1024,
    }), code: 0};
  } catch (error) {
    result = {code: error.code, signal: error.signal, killed: error.killed, stdout: error.stdout, stderr: error.stderr};
  }
  assert.ok(requests.every(request => request.method === 'GET' && request.url === '/rclone-v1.75.0-linux-amd64.zip'));
  assert.ok(requests.every(request => JSON.stringify(request.headers) === JSON.stringify(requests[0].headers)),
    'retry preserves the same unauthenticated archive GET');
  return {result, requests, payload, root};
}

for (const name of ['catalog-bake.yml', 'cams-ingest.yml', 'publish-current-model-production.yml',
  'staging-wind100-recurring.yml', 'production-wind100-recurring.yml']) {
const commands = archiveCommands(name);
const {install, checksumOffset, download} = commands;
const fixture = (t, responses, options) => archiveFixture(t, commands, responses, options);

test(`${name}: archive download keeps exact release/hash/install and bounded transient-only recovery`, () => {
  assert.ok(checksumOffset > 0);
  assert.match(download, /timeout -k 10 300 curl --fail --silent --show-error --location/);
  assert.match(download, /--connect-timeout 15 --max-time 120/);
  assert.match(download, /--retry 2 --retry-delay 1 --retry-max-time 180/);
  assert.equal(download.split(url).length - 1, 1);
  assert.doesNotMatch(download, /--retry-all-errors|--retry-connrefused|\|\| true|https?:\/\/(?!github\.com\/rclone\/rclone\/releases\/download\/v1\.75\.0\/rclone-v1\.75\.0-linux-amd64\.zip)/);
  assert.ok(install.indexOf(archiveSha) > install.indexOf(url));
  assert.match(install, /sha256sum --check --status\n\s+unzip -q/);
  assert.match(install, /sudo install -m 0755 "\$RUNNER_TEMP\/rclone-v1\.75\.0-linux-amd64\/rclone" \/usr\/local\/bin\/rclone/);
  if (name !== 'publish-current-model-production.yml') {
    assert.match(commands.versionTail, /rclone version \| (?:head -1|sed -n '1p') \| grep -Fx 'rclone v1\.75\.0'/);
  }
});

test(`${name}: actual workflow curl recovers the observed HTTP504 and returns exact final bytes`, async t => {
  const f = await fixture(t, [{status: 504}, {status: 200}]);
  assert.equal(f.result.code, 0, f.result.stderr);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await readFile(join(f.root, 'rclone-v1.75.0-linux-amd64.zip')), f.payload);
  assert.match(f.result.stdout, /download-accepted/);
});

test(`${name}: actual workflow curl also recovers HTTP503 and respects bounded HTTP429 Retry-After`, async t => {
  for (const reply of [{status: 503}, {status: 429, headers: {'Retry-After': '1'}}]) {
    await t.test(String(reply.status), async child => {
      const f = await fixture(child, [reply, {status: 200}]);
      assert.equal(f.result.code, 0, f.result.stderr);
      assert.equal(f.requests.length, 2);
    });
  }
});

test(`${name}: three HTTP504 responses preserve terminal curl22 and never reach the next command`, async t => {
  const f = await fixture(t, [{status: 504}]);
  assert.equal(f.requests.length, 3);
  assert.equal(f.result.code, 22);
  assert.match(f.result.stderr, /504/);
  assert.doesNotMatch(f.result.stdout, /download-accepted/);
});

test(`${name}: zero-byte transfer timeout recovers on the next identical GET`, async t => {
  const f = await fixture(t, [{stall: true}, {status: 200}], {shortTransferTimeout: true});
  assert.equal(f.result.code, 0, f.result.stderr);
  assert.equal(f.requests.length, 2);
  assert.match(f.result.stderr, /0 bytes received/);
  assert.deepEqual(await readFile(join(f.root, 'rclone-v1.75.0-linux-amd64.zip')), f.payload);
});

test(`${name}: repeated zero-byte timeouts preserve terminal curl28 after three requests`, async t => {
  const f = await fixture(t, [{stall: true}], {shortTransferTimeout: true});
  assert.equal(f.result.code, 28);
  assert.equal(f.requests.length, 3);
  assert.doesNotMatch(f.result.stdout, /download-accepted/);
});

test(`${name}: HTTP401/403/404 are terminal on the first GET even when a later response could succeed`, async t => {
  for (const status of [401, 403, 404]) {
    await t.test(String(status), async child => {
      const f = await fixture(child, [{status}, {status: 200}]);
      assert.equal(f.requests.length, 1);
      assert.equal(f.result.code, 22);
      assert.doesNotMatch(f.result.stdout, /download-accepted/);
    });
  }
});

test(`${name}: HTTP200 checksum mismatch is terminal without retry or extraction/install`, async t => {
  const f = await fixture(t, [{status: 200}], {checksum: true});
  assert.equal(f.requests.length, 1);
  assert.equal(f.result.code, 1);
  assert.doesNotMatch(f.result.stdout, /download-accepted/);
});
}
