import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const workflow = await readFile(new URL('../.github/workflows/bake.yml', import.meta.url), 'utf8');

assert.match(workflow, /actions\/setup-python@v5\n\s+if: \$\{\{ inputs\.code_only \|\| steps\.bake_plan\.outputs\.skip != 'true' \}\}/);
assert.match(workflow, /name: Road crop deps \(code-only\)/);
assert.match(workflow, /data\/\.venv\/bin\/pip install numpy==2\.4\.6 pillow==12\.2\.0/);

console.log('bake workflow Road crop contract: ok');
