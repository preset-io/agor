import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addRuntimeTools } from './runtime-tools.mjs';

const codec = {
  load: JSON.parse,
  dump: JSON.stringify,
  isInstallableAgenticTool: (value) =>
    ['codex', 'claude-code', 'opencode', 'copilot', 'gemini'].includes(value),
};

test('adds tools atomically, preserving unrelated deployment state; repeat is a no-op', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'runtime-tools-'));
  try {
    const path = join(dir, 'config.yaml');
    const config = {
      daemon: { jwtSecret: 'synthetic-secret' },
      agentic_tools: { installed: ['gemini'], claude_subscription_oauth: false },
    };
    const original = JSON.stringify(config);
    await writeFile(path, original);
    const selection = 'codex,claude-code,opencode,copilot';
    assert.equal(await addRuntimeTools(path, selection, codec), true);
    const actual = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(actual.daemon, config.daemon);
    assert.equal(actual.agentic_tools.claude_subscription_oauth, false);
    assert.deepEqual(actual.agentic_tools.installed, ['gemini', ...selection.split(',')]);
    const backup = (await readdir(dir)).find((name) => name.includes('.before-tools-'));
    assert.equal(await readFile(join(dir, backup), 'utf8'), original);
    assert.equal((await stat(join(dir, backup))).mode & 0o777, 0o600);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await addRuntimeTools(path, selection, codec), false);
    assert.equal((await readdir(dir)).length, 2);
    await assert.rejects(addRuntimeTools(path, 'unknown', codec));
    const foreign = join(dir, 'foreign.yaml');
    await symlink(path, foreign);
    await assert.rejects(addRuntimeTools(foreign, 'codex', codec));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), actual);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
