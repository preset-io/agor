import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');
const matrix = await readFile(join(root, 'scripts/ci-test-matrix.mjs'), 'utf8');
const workflow = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8');
const manifests = [];
for (const workspace of ['apps', 'packages']) {
  for (const entry of await readdir(join(root, workspace), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = await readFile(join(root, workspace, entry.name, 'package.json'), 'utf8');
      manifests.push([join(workspace, entry.name), manifest]);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

// Run the real checker against disposable manifests, never install or run tests
// from the fixture. Mutations exercise false-green paths without triggering CI.
async function check(t, { script = matrix, yaml = workflow, extraPackage = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agor-ci-matrix-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [path, manifest] of manifests) {
    await mkdir(join(directory, path), { recursive: true });
    await writeFile(join(directory, path, 'package.json'), manifest);
  }
  if (extraPackage) {
    await mkdir(join(directory, 'packages/unassigned'));
    await writeFile(
      join(directory, 'packages/unassigned/package.json'),
      JSON.stringify({ name: '@agor/unassigned', scripts: { test: 'vitest run' } })
    );
  }
  await mkdir(join(directory, 'scripts'));
  await mkdir(join(directory, '.github/workflows'), { recursive: true });
  await writeFile(join(directory, 'scripts/ci-test-matrix.mjs'), script);
  await writeFile(join(directory, '.github/workflows/ci.yml'), yaml);
  return spawnSync(process.execPath, ['scripts/ci-test-matrix.mjs'], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

test('the complete native shard matrix passes', async (t) => {
  const result = await check(t);
  assert.equal(result.status, 0, result.stderr);
});

for (const [name, options, message] of [
  ['duplicate UI shard', { script: matrix.replace('--shard=4/4', '--shard=3/4') }, /exactly once/],
  [
    'wrong UI denominator',
    { script: matrix.replace('--shard=4/4', '--shard=4/5') },
    /exactly once/,
  ],
  [
    'duplicate daemon shard',
    { script: matrix.replace('--shard=2/2', '--shard=1/2') },
    /exactly once/,
  ],
  [
    'filtered UI shard',
    { script: matrix.replace("'--shard=4/4'", "'--shard=4/4', 'src/components'") },
    /exactly once/,
  ],
  [
    'fail-fast unit matrix',
    { yaml: workflow.replace('fail-fast: false', 'fail-fast: true') },
    /failures must propagate/,
  ],
  ['missing matrix cell', { yaml: workflow.replace('ui-3, ', '') }, /missing from ci.yml/],
  [
    'duplicate matrix cell',
    { yaml: workflow.replace('ui-3, ', 'ui-3, ui-3, ') },
    /Duplicate groups/,
  ],
  ['unknown matrix cell', { yaml: workflow.replace('ui-3, ', 'unknown, ') }, /unknown groups/],
  ['unassigned workspace', { extraPackage: true }, /missing from CI matrix/],
  [
    'missing browser shard',
    { yaml: workflow.replace('shard: [1, 2]', 'shard: [1]') },
    /Browser lane/,
  ],
  [
    'duplicate browser shard',
    { yaml: workflow.replace('shard: [1, 2]', 'shard: [1, 1]') },
    /Browser lane/,
  ],
  [
    'wrong browser denominator',
    { yaml: workflow.replace(`--shard=\${{ matrix.shard }}/2`, `--shard=\${{ matrix.shard }}/3`) },
    /Browser lane/,
  ],
  [
    'viewport filtering',
    { yaml: workflow.replace('matrix.shard }}/2\n', 'matrix.shard }}/2 --project=desktop\n') },
    /Browser lane/,
  ],
  [
    'conditional unit shard',
    { yaml: workflow.replace('  unit:\n', '  unit:\n    if: false\n') },
    /unconditional/,
  ],
  [
    'ignored shard failure',
    { yaml: workflow.replace('  browser:\n', '  browser:\n    continue-on-error: true\n') },
    /failures must propagate/,
  ],
]) {
  test(`rejects ${name}`, async (t) => {
    const result = await check(t, options);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
  });
}

test('aggregate gate retains every lane and fails closed for non-success results', () => {
  const gate = workflow.split('\n  gate:\n')[1];
  assert.ok(gate.includes('name: Lint, typecheck, build, test'));
  assert.ok(gate.includes(`if: \${{ always() }}`));
  assert.ok(gate.includes('needs: [lint, build, unit, daemon-ha, browser]'));
  const shell = gate.split('        run: |\n')[1].replace(/^ {10}/gm, '');
  const passing = {
    LINT_RESULT: 'success',
    BUILD_RESULT: 'success',
    UNIT_RESULT: 'success',
    HA_RESULT: 'success',
    BROWSER_RESULT: 'success',
  };
  const run = (env) => spawnSync('bash', ['-c', shell], { env, encoding: 'utf8' });
  assert.equal(run(passing).status, 0);
  for (const key of Object.keys(passing)) {
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      assert.equal(run({ ...passing, [key]: result }).status, 1, `${key}=${result}`);
    }
  }
});
