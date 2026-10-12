import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRailwayImageInput, shouldBuildRailwayImage } from './railway-image-inputs.mjs';

test('Railway Docker/runtime/dependency and gate changes require image checks', () => {
  for (const filename of [
    'docker/Dockerfile',
    'docker/runtime-watch.mjs',
    'docker/docker-entrypoint-runtime.sh',
    'patches/some-dependency.patch',
    'scripts/managed-environments/railway/image.mjs',
    'apps/agor-daemon/package.json',
    'packages/new-workspace/package.json',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    '.npmrc',
    '.dockerignore',
    '.agor.yml',
    '.github/workflows/build-image.yml',
    'scripts/check-image-publication-policy.mjs',
    'scripts/railway-image-inputs.mjs',
    'scripts/railway-image-inputs.test.mjs',
  ])
    assert.equal(isRailwayImageInput(filename), true, filename);
});

test('application source, tests, and docs do not rebuild Railway dependencies', () => {
  for (const filename of [
    'apps/agor-daemon/src/services/branches.ts',
    'packages/executor/src/commands/branch-deletion.test.ts',
    'apps/agor-ui/src/App.tsx',
    'apps/agor-docs/content/guide/branches.mdx',
    'README.md',
  ])
    assert.equal(isRailwayImageInput(filename), false, filename);
});

function request(files) {
  const listFiles = () => {};
  return {
    context: {
      eventName: 'pull_request',
      repo: { owner: 'preset-io', repo: 'agor' },
      payload: { pull_request: { number: 2943 } },
    },
    github: {
      rest: { pulls: { listFiles } },
      paginate: async (method, options) => {
        assert.equal(method, listFiles);
        assert.deepEqual(options, {
          owner: 'preset-io',
          repo: 'agor',
          pull_number: 2943,
          per_page: 100,
        });
        return files;
      },
    },
  };
}

test('use the whole paginated PR inventory, including deleted and renamed inputs', async () => {
  const ordinary = Array.from({ length: 100 }, () => ({ filename: 'README.md' }));
  assert.equal(await shouldBuildRailwayImage(request(ordinary)), false);
  for (const file of [
    { filename: 'pnpm-lock.yaml', status: 'modified' },
    { filename: 'patches/removed.patch', status: 'removed' },
    { filename: 'notes/old-manifest', previous_filename: 'packages/foo/package.json' },
  ])
    assert.equal(await shouldBuildRailwayImage(request([...ordinary, file])), true);
});

test('incomplete inventory builds conservatively; API failure cannot silently skip', async () => {
  assert.equal(
    await shouldBuildRailwayImage(request(Array(3000).fill({ filename: 'README.md' }))),
    true
  );
  const input = request([]);
  input.github.paginate = async () => {
    throw new Error('API unavailable');
  };
  await assert.rejects(shouldBuildRailwayImage(input), /API unavailable/);
});

test('main, tags, and manual runs build without requesting PR files', async () => {
  for (const eventName of ['workflow_run', 'push', 'workflow_dispatch']) {
    assert.equal(await shouldBuildRailwayImage({ context: { eventName } }), true);
  }
});
