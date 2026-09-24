import * as fs from 'node:fs/promises';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { findLatestJsonLine } from './rollout-tail.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open) };
});

it('reads the latest valid token record across giant lines, malformed tails, CRLF and split UTF-8', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rollout-tail-'));
  const file = path.join(dir, 'rollout.jsonl');
  const project = (value: unknown) => {
    const row = value as { type?: string; tokens?: number };
    return row.type === 'token_count' && typeof row.tokens === 'number' ? row.tokens : undefined;
  };
  try {
    for (const tail of ['', '\n', '\n{"type":"token_count",', '\nnot JSON\n']) {
      await writeFile(
        file,
        [
          JSON.stringify({ type: 'token_count', tokens: 1 }),
          JSON.stringify({ output: 'x'.repeat(2 * 1024 * 1024) }),
          JSON.stringify({ type: 'token_count', padding: '猫'.repeat(30_000), tokens: 42 }),
          JSON.stringify({ output: 'y'.repeat(2 * 1024 * 1024) }),
          JSON.stringify({ type: 'token_count', tokens: null }),
        ].join('\r\n') + tail
      );
      expect(await findLatestJsonLine(file, project)).toBe(42);
    }
    await writeFile(
      file,
      JSON.stringify({ type: 'token_count', tokens: 1 }) +
        '\n' +
        JSON.stringify({ type: 'token_count', tokens: 2, padding: 'x'.repeat(2 * 1024 * 1024) })
    );
    expect(await findLatestJsonLine(file, project)).toBeUndefined();
    await writeFile(file, 'x'.repeat(3 * 1024 * 1024));
    expect(await findLatestJsonLine(file, project)).toBeUndefined();
    await writeFile(file, '');
    expect(await findLatestJsonLine(file, project)).toBeUndefined();
    expect(await findLatestJsonLine(path.join(dir, 'missing'), project)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not join noncontiguous bytes after a concurrent file truncation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rollout-truncate-'));
  const filename = path.join(dir, 'rollout.jsonl');
  await writeFile(filename, JSON.stringify({ type: 'token_count', tokens: 42 }));
  const originalOpen = (await vi.importActual<typeof fs>('node:fs/promises')).open;
  const spy = vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    const file = await originalOpen(...args);
    const originalStat = file.stat.bind(file);
    Reflect.set(file, 'stat', async () => {
      const stat = await originalStat();
      await fs.truncate(filename, 0);
      return stat;
    });
    return file;
  });
  try {
    expect(await findLatestJsonLine(filename, () => 42)).toBeUndefined();
  } finally {
    spy.mockImplementation(originalOpen);
    await rm(dir, { recursive: true, force: true });
  }
});
