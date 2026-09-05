import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/catalog-bake.yml', import.meta.url), 'utf8');
const required = ['CATALOG_R2_REMOTE', 'COMPONENT_R2_REMOTE', 'CATALOG_ENDPOINT',
  'CATALOG_PROMOTION_KEY', 'RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID', 'RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY'];
const step = (source, name) => {
  const body = source.split(`      - name: ${name}\n`)[1]?.split('      - name:')[0];
  assert.ok(body, `missing step: ${name}`);
  return body;
};
function assertBindings(source, target) {
  const bake = step(source, `Bake, validate, upload, and CAS-promote one ${target} model`);
  const hydrate = step(source, `Restore only this model's last-known-good ${target} component`);
  for (const key of ['CATALOG_R2_REMOTE', 'COMPONENT_R2_REMOTE',
    'RCLONE_CONFIG_WEATHERX_ACCESS_KEY_ID', 'RCLONE_CONFIG_WEATHERX_SECRET_ACCESS_KEY']) {
    const value = body => body.match(new RegExp(`^          ${key}: (.+)$`, 'm'))?.[1];
    assert.ok(value(hydrate), `${key} hydration binding missing`);
    assert.equal(value(bake), value(hydrate), `${target} bake must retain its own ${key} binding`);
  }
  assert.match(bake, new RegExp(`CATALOG_R2_REMOTE: weatherx:weatherx-data-${target}`));
  const suffix = target === 'production' ? '_PRODUCTION' : '';
  for (const key of ['CATALOG_ENDPOINT', 'CATALOG_PROMOTION_KEY']) {
    assert.ok(bake.includes(`${key}: \${{ secrets.${key}${suffix} }}`));
  }
  return bake;
}

for (const target of ['staging', 'production']) {
  test(`${target} component bake has the same scoped transport as its hydration`, () => {
    assertBindings(workflow, target);
    const name = `Bake, validate, upload, and CAS-promote one ${target} model`;
    const body = step(workflow, name);
    for (const mutation of [
      body.replace(/^          CATALOG_R2_REMOTE: .+\n/m, ''),
      body.replace(`CATALOG_R2_REMOTE: weatherx:weatherx-data-${target}`,
        `CATALOG_R2_REMOTE: weatherx:weatherx-data-${target === 'production' ? 'staging' : 'production'}`),
    ]) assert.throws(() => assertBindings(workflow.replace(body, mutation), target));
  });

  test(`${target} rejects missing configuration before collecting, without leaking values`, () => {
    const body = assertBindings(workflow, target);
    const run = body.split('        run: |\n')[1]?.split('\n').map(line => line.replace(/^          /, '')).join('\n');
    assert.ok(run, 'component bake must run a preflight before the expensive producer');
    assert.match(run, /bash ops\/bake-model-component\.sh/);
    const sentinel = 'private-fixture-not-a-real-secret';
    const config = Object.fromEntries(required.map(key => [key, sentinel]));
    // Stub only the child invocation. Execute the exact workflow preflight in Bash;
    // a missing binding must exit before any collector/publication process starts.
    const execute = env => spawnSync('/bin/bash', ['-c',
      'bash() { printf "COLLECTOR_STARTED\\n"; };\n' + run],
      {env: {...env, PATH: '/usr/bin:/bin'}, encoding: 'utf8'});
    const positive = execute(config);
    assert.equal(positive.status, 0, positive.stderr);
    assert.equal(positive.stdout.trim(), 'COLLECTOR_STARTED');
    for (const key of required) {
      for (const value of [undefined, '']) {
        const env = {...config};
        if (value === undefined) delete env[key]; else env[key] = value;
        const result = execute(env);
        assert.notEqual(result.status, 0, `${key} must be nonempty`);
        assert.doesNotMatch(result.stdout, /COLLECTOR_STARTED/);
        assert.ok(!`${result.stdout}${result.stderr}`.includes(sentinel), 'preflight must not log secrets');
      }
    }
  });
}
