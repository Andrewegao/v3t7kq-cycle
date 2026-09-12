import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/qualify-bake-throughput.yml', import.meta.url), 'utf8');
const tool = readFileSync(new URL('../tools/qualify-bake-throughput.py', import.meta.url), 'utf8');
const source = '0335a3b0a85b629c8659032a032bbc5ea0911eff';

test('qualification is manual, main-only, read-only and nonpublishing', () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /\n  (?:schedule|push|pull_request|workflow_run|repository_dispatch):/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /^    environment:\n      name: atmos-source-read-ui$/m);
  assert.deepEqual([...new Set([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]))], ['ATMOS_READONLY_KEY']);
  assert.doesNotMatch(workflow, /ATMOS_DEPLOY_KEY|CATALOG_|R2_|CLOUDFLARE|wrangler|upload-artifact|actions: write|issues: write|id-token: write/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  for (const match of workflow.matchAll(/uses: ([^\s]+)/g)) assert.match(match[1], /^[\w/-]+@[a-f0-9]{40}$/);
});

test('qualification fixes source and production-scale safety properties', () => {
  assert.equal((workflow.match(new RegExp(source, 'g')) ?? []).length, 2);
  assert.match(tool, new RegExp(`EXPECTED_SOURCE = "${source}"`));
  assert.match(tool, /default=72/);
  assert.match(tool, /default=721/);
  assert.match(tool, /default=1440/);
  assert.match(tool, /len\(core\) \+ len\(extras\) \+ len\(waves\) \+ 1 == 25/);
  assert.match(tool, /point_gust = core\["gust"\]\.copy\(\)/);
  assert.match(tool, /"wave": waves/);
  assert.match(tool, /workers=2/);
  assert.match(tool, /\("serial", "parallel", "serial", "parallel"\)/);
  assert.match(tool, /max\(timings\["parallel"\]\) < min\(timings\["serial"\]\) \* 0\.95/);
  assert.match(tool, /"exactPngHashes": all_hashes_equal/);
  assert.match(tool, /"peakProcessRssMiB": mib\(maximum_rss_bytes\(\)\)/);
  assert.match(tool, /minimum-headroom-mib.*default=1024/);
  assert.ok(tool.indexOf('args.receipt.write_text') < tool.indexOf('raise SystemExit'));
  assert.match(tool, /"published": False/);
  assert.match(tool, /"providerRequests": 0/);
});
