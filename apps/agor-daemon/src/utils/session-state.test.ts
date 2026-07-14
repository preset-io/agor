import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getCodexSessionRelativePath,
  resolveCodexSessionRelativePath,
  restoreFile,
  serializeFile,
} from './session-state.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Codex stateless session paths', () => {
  it('round-trips the original dated rollout path', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'agor-codex-path-'));
    tempDirs.push(codexHome);
    const original = path.join(
      codexHome,
      'sessions',
      '2026',
      '07',
      '13',
      'rollout-2026-07-13T12-00-00-thread-id.jsonl'
    );

    const relative = getCodexSessionRelativePath(codexHome, original);

    expect(relative).toBe('sessions/2026/07/13/rollout-2026-07-13T12-00-00-thread-id.jsonl');
    expect(resolveCodexSessionRelativePath(codexHome, relative)).toBe(original);
  });

  it('rejects paths outside the Codex sessions directory', () => {
    expect(() => resolveCodexSessionRelativePath('/tmp/codex', '../auth.json')).toThrow(
      'Invalid Codex session relative path'
    );
    expect(() => resolveCodexSessionRelativePath('/tmp/codex', 'auth.json')).toThrow(
      'Invalid Codex session relative path'
    );
  });

  it('restores a complete gzipped transcript through an atomic replacement', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agor-session-restore-'));
    tempDirs.push(dir);
    const source = path.join(dir, 'source.jsonl');
    const restored = path.join(dir, 'nested', 'restored.jsonl');
    await writeFile(source, '{"type":"session_meta"}\n');

    await restoreFile(restored, await serializeFile(source));

    expect(await readFile(restored, 'utf8')).toBe('{"type":"session_meta"}\n');
  });
});
