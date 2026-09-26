import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dependencyFingerprint, prepareCheckout, validateSource } from './runtime-checkout.mjs';

const repo = 'https://github.com/preset-io/agor.git';
const branch = 'runtime-test';
const workspaces = [
  'apps/agor-daemon',
  'apps/agor-cli',
  'apps/agor-ui',
  'packages/git',
  'packages/core',
  'packages/agentic-tool-opencode',
  'packages/agentic-tools',
  'packages/executor',
  'packages/client',
  'packages/agor-live',
  'packages/agor-claude',
  'packages/agor-codex',
  'packages/agor-copilot',
  'packages/agor-gemini',
  'packages/agor-opencode',
  'packages/agor-cursor',
];

test('cold clone then warm fetch/reset retains unrelated cached state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agor-runtime-test-'));
  try {
    const source = join(root, 'source');
    await mkdir(join(source, 'patches'), { recursive: true });
    for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      await writeFile(join(source, file), '{}');
    }
    for (const path of workspaces) {
      await mkdir(join(source, path), { recursive: true });
      await writeFile(join(source, path, 'package.json'), '{}');
    }
    const state = join(root, 'state');
    const calls = [];
    const git = () => ({
      clone: async (_repo, path) => {
        calls.push('clone');
        await cp(source, path, { recursive: true });
      },
      remote: async () => repo,
      fetch: async () => {
        calls.push('fetch');
      },
      reset: async (args) => {
        assert.deepEqual(args, ['--hard', 'FETCH_HEAD']);
        calls.push('reset');
      },
      revparse: async () => 'synthetic-sha',
    });
    const options = {
      state,
      repo,
      branch,
      git,
      expectedFingerprint: await dependencyFingerprint(source),
    };
    await prepareCheckout(options);
    await writeFile(join(state, 'cache-sentinel'), 'retained');
    await prepareCheckout(options);
    assert.deepEqual(calls, ['clone', 'fetch', 'reset']);
    assert.equal(await readFile(join(state, 'cache-sentinel'), 'utf8'), 'retained');
    await assert.rejects(prepareCheckout({ ...options, branch: 'another-branch' }), /unowned/);
    await assert.rejects(
      prepareCheckout({ ...options, expectedFingerprint: 'stale-image' }),
      /dependencies differ/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects foreign repositories and unsafe refs before clone', () => {
  assert.throws(() => validateSource('https://untrusted.example/repo', branch));
  for (const ref of ['', '--upload-pack=evil', '../main', 'main; echo evil']) {
    assert.throws(() => validateSource(repo, ref));
  }
});
