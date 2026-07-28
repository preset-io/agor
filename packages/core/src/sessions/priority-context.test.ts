import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatPriorityContextMessage,
  readPriorityContextFiles,
  readPriorityContextManifest,
  resolvePriorityContextForWorktree,
} from './priority-context.js';

let worktree: string;

beforeEach(async () => {
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-priority-context-test-'));
});

afterEach(async () => {
  await fs.rm(worktree, { recursive: true, force: true });
});

async function writeFile(relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(worktree, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf-8');
}

async function writeManifest(manifest: unknown): Promise<void> {
  await writeFile('.agor/priority-context.json', JSON.stringify(manifest));
}

describe('readPriorityContextManifest', () => {
  it('returns undefined when no manifest exists (the common, opted-out case)', async () => {
    expect(await readPriorityContextManifest(worktree)).toBeUndefined();
  });

  it('reads a valid manifest', async () => {
    await writeManifest({ files: ['SOUL.md', 'IDENTITY.md'] });
    expect(await readPriorityContextManifest(worktree)).toEqual({
      files: ['SOUL.md', 'IDENTITY.md'],
    });
  });

  it('returns undefined and does not throw on malformed JSON', async () => {
    await writeFile('.agor/priority-context.json', '{ not valid json');
    expect(await readPriorityContextManifest(worktree)).toBeUndefined();
  });

  it('returns undefined and does not throw when `files` is missing or the wrong shape', async () => {
    await writeManifest({ onMissing: 'skip' });
    expect(await readPriorityContextManifest(worktree)).toBeUndefined();
  });
});

describe('readPriorityContextFiles', () => {
  it('reads listed files that exist', async () => {
    await writeFile('SOUL.md', 'Be warm and concise.');
    await writeFile('IDENTITY.md', 'You are Hodor.');

    const files = await readPriorityContextFiles(worktree, {
      files: ['SOUL.md', 'IDENTITY.md'],
    });

    expect(files).toEqual([
      { path: 'SOUL.md', content: 'Be warm and concise.' },
      { path: 'IDENTITY.md', content: 'You are Hodor.' },
    ]);
  });

  it('silently skips files that do not exist (onMissing: skip)', async () => {
    await writeFile('SOUL.md', 'Be warm and concise.');

    const files = await readPriorityContextFiles(worktree, {
      files: ['SOUL.md', 'MISSING.md'],
    });

    expect(files).toEqual([{ path: 'SOUL.md', content: 'Be warm and concise.' }]);
  });

  it('resolves a {today} path to the current date file when it exists', async () => {
    await writeFile('memory/2026-07-28.md', "today's log");

    const files = await readPriorityContextFiles(
      worktree,
      { files: ['memory/{today}.md'] },
      new Date('2026-07-28T12:00:00.000Z')
    );

    expect(files).toEqual([{ path: 'memory/2026-07-28.md', content: "today's log" }]);
  });

  it("falls back to the prior day when {today}'s file is missing", async () => {
    await writeFile('memory/2026-07-27.md', "yesterday's log");

    const files = await readPriorityContextFiles(
      worktree,
      { files: ['memory/{today}.md'] },
      new Date('2026-07-28T12:00:00.000Z')
    );

    expect(files).toEqual([{ path: 'memory/2026-07-27.md', content: "yesterday's log" }]);
  });

  it('skips a {today} entry when neither today nor yesterday exists', async () => {
    const files = await readPriorityContextFiles(
      worktree,
      { files: ['memory/{today}.md'] },
      new Date('2026-07-28T12:00:00.000Z')
    );

    expect(files).toEqual([]);
  });
});

describe('formatPriorityContextMessage', () => {
  it('returns undefined for an empty file list', () => {
    expect(formatPriorityContextMessage([])).toBeUndefined();
  });

  it('formats a header plus one section per file', () => {
    const message = formatPriorityContextMessage([
      { path: 'SOUL.md', content: 'Be warm.' },
      { path: 'IDENTITY.md', content: 'You are Hodor.' },
    ]);

    expect(message).toContain('SOUL.md');
    expect(message).toContain('Be warm.');
    expect(message).toContain('IDENTITY.md');
    expect(message).toContain('You are Hodor.');
    expect(message?.indexOf('SOUL.md')).toBeLessThan(message?.indexOf('IDENTITY.md') ?? 0);
  });
});

describe('resolvePriorityContextForWorktree (end-to-end)', () => {
  it('returns undefined when the repo has no manifest', async () => {
    expect(await resolvePriorityContextForWorktree(worktree)).toBeUndefined();
  });

  it('returns undefined when the manifest lists only missing files', async () => {
    await writeManifest({ files: ['NOPE.md'] });
    expect(await resolvePriorityContextForWorktree(worktree)).toBeUndefined();
  });

  it('resolves manifest + files into a single synthetic message', async () => {
    await writeManifest({ files: ['SOUL.md', 'BOARD.md'] });
    await writeFile('SOUL.md', 'Values and communication style.');
    await writeFile('BOARD.md', 'Board zones and workflow.');

    const message = await resolvePriorityContextForWorktree(worktree);

    expect(message).toContain('Values and communication style.');
    expect(message).toContain('Board zones and workflow.');
  });
});
