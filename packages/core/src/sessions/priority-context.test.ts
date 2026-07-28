import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  canInjectPriorityContextForBranch,
  formatPriorityContextMessage,
  isRootSessionGenealogy,
  MAX_FILE_BYTES,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_FILES,
  MAX_TOTAL_BYTES,
  readPriorityContextFiles,
  readPriorityContextManifest,
  resolvePriorityContextForWorktree,
} from './priority-context.js';

describe('isRootSessionGenealogy', () => {
  it('is true for a session with no parent and no fork source', () => {
    expect(isRootSessionGenealogy({ children: [] } as never)).toBe(true);
    expect(isRootSessionGenealogy(undefined)).toBe(true);
    expect(isRootSessionGenealogy(null)).toBe(true);
  });

  it('is false for a spawned child session', () => {
    expect(isRootSessionGenealogy({ parent_session_id: 'session-1' })).toBe(false);
  });

  it('is false for a forked sibling session', () => {
    expect(isRootSessionGenealogy({ forked_from_session_id: 'session-1' })).toBe(false);
  });
});

describe('canInjectPriorityContextForBranch', () => {
  it('always allows injection for the branch owner, regardless of others_fs_access', () => {
    expect(canInjectPriorityContextForBranch({ isOwner: true, othersFsAccess: 'none' })).toBe(true);
    expect(canInjectPriorityContextForBranch({ isOwner: true, othersFsAccess: undefined })).toBe(
      true
    );
  });

  it('denies injection for a non-owner when others_fs_access is none', () => {
    expect(canInjectPriorityContextForBranch({ isOwner: false, othersFsAccess: 'none' })).toBe(
      false
    );
  });

  it('allows injection for a non-owner when others_fs_access grants read or write', () => {
    expect(canInjectPriorityContextForBranch({ isOwner: false, othersFsAccess: 'read' })).toBe(
      true
    );
    expect(canInjectPriorityContextForBranch({ isOwner: false, othersFsAccess: 'write' })).toBe(
      true
    );
  });

  it('defaults to allowed for a non-owner when others_fs_access is unset (open-access mode)', () => {
    expect(canInjectPriorityContextForBranch({ isOwner: false, othersFsAccess: undefined })).toBe(
      true
    );
  });
});

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

  it('rejects an unsupported `onMissing` value instead of silently ignoring it', async () => {
    await writeManifest({ files: ['SOUL.md'], onMissing: 'fail' });
    expect(await readPriorityContextManifest(worktree)).toBeUndefined();
  });

  it('caps the file list at MAX_MANIFEST_FILES and warns', async () => {
    const files = Array.from({ length: MAX_MANIFEST_FILES + 5 }, (_, i) => `file-${i}.md`);
    await writeManifest({ files });

    const manifest = await readPriorityContextManifest(worktree);

    expect(manifest?.files).toHaveLength(MAX_MANIFEST_FILES);
    expect(manifest?.files).toEqual(files.slice(0, MAX_MANIFEST_FILES));
  });

  it('rejects a manifest file that exceeds MAX_MANIFEST_BYTES, without fully parsing it', async () => {
    // Padded with a JSON string value so the file is valid-looking JSON
    // shape-wise, were it ever parsed -- the size cap must reject it before
    // JSON.parse runs at all, not because parsing itself fails.
    const padding = 'x'.repeat(MAX_MANIFEST_BYTES + 1);
    await writeFile('.agor/priority-context.json', JSON.stringify({ files: [], padding }));

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

  it('refuses to read a path that escapes the worktree via ../', async () => {
    const secretDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-priority-context-secret-'));
    try {
      await fs.writeFile(path.join(secretDir, 'secret.md'), 'top secret', 'utf-8');
      const traversal = `${path.relative(worktree, secretDir)}/secret.md`;

      const files = await readPriorityContextFiles(worktree, { files: [traversal] });

      expect(files).toEqual([]);
    } finally {
      await fs.rm(secretDir, { recursive: true, force: true });
    }
  });

  it('refuses to read an absolute path', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-priority-context-abs-'));
    try {
      const absoluteFile = path.join(outside, 'secret.md');
      await fs.writeFile(absoluteFile, 'top secret', 'utf-8');

      const files = await readPriorityContextFiles(worktree, { files: [absoluteFile] });

      expect(files).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses to follow a final-component symlink pointing outside the worktree', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-priority-context-symlink-'));
    try {
      await fs.writeFile(path.join(outside, 'secret.md'), 'top secret', 'utf-8');
      await fs.symlink(path.join(outside, 'secret.md'), path.join(worktree, 'LINK.md'));

      const files = await readPriorityContextFiles(worktree, { files: ['LINK.md'] });

      expect(files).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses to follow a symlinked ancestor directory pointing outside the worktree, even for a not-yet-existing file', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'agor-priority-context-ancestor-'));
    try {
      // The target file doesn't exist yet -- this is the "dangling target"
      // case: fs.realpath fails on the full path, so containment must be
      // checked by walking up to the symlinked ancestor, not by falling
      // back to the lexical (pre-symlink) path.
      await fs.symlink(outside, path.join(worktree, 'notes'));

      const files = await readPriorityContextFiles(worktree, { files: ['notes/today.md'] });
      expect(files).toEqual([]);

      // Now create the target after the fact and confirm it's still refused.
      await fs.writeFile(path.join(outside, 'today.md'), 'leaked', 'utf-8');
      const filesAfter = await readPriorityContextFiles(worktree, { files: ['notes/today.md'] });
      expect(filesAfter).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('skips a listed path that is not a regular file (e.g. a directory)', async () => {
    await fs.mkdir(path.join(worktree, 'NOT_A_FILE.md'), { recursive: true });
    await writeFile('SOUL.md', 'ok');

    const files = await readPriorityContextFiles(worktree, {
      files: ['NOT_A_FILE.md', 'SOUL.md'],
    });

    expect(files).toEqual([{ path: 'SOUL.md', content: 'ok' }]);
  });

  it('skips a FIFO with no writer instead of hanging (open() must not block)', {
    timeout: 5_000,
  }, async () => {
    const fifoPath = path.join(worktree, 'PIPE.md');
    execFileSync('mkfifo', [fifoPath]);
    await writeFile('SOUL.md', 'ok');

    // No writer ever connects to the FIFO. A plain blocking open() would
    // hang here indefinitely (while holding the daemon's per-session
    // prompt lock in production); this must return promptly instead.
    const files = await readPriorityContextFiles(worktree, {
      files: ['PIPE.md', 'SOUL.md'],
    });

    expect(files).toEqual([{ path: 'SOUL.md', content: 'ok' }]);
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

  it('skips a single file that exceeds the per-file byte limit', async () => {
    await writeFile('SOUL.md', 'ok');
    await writeFile('HUGE.md', 'x'.repeat(MAX_FILE_BYTES + 1));

    const files = await readPriorityContextFiles(worktree, { files: ['SOUL.md', 'HUGE.md'] });

    expect(files).toEqual([{ path: 'SOUL.md', content: 'ok' }]);
  });

  it('stops once the total byte budget is reached, keeping earlier files', async () => {
    const chunk = 'x'.repeat(MAX_FILE_BYTES);
    await writeFile('A.md', chunk);
    await writeFile('B.md', chunk);
    await writeFile('C.md', chunk);

    const files = await readPriorityContextFiles(worktree, { files: ['A.md', 'B.md', 'C.md'] });
    const totalBytes = files.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0);

    expect(files.map((f) => f.path)).toEqual(['A.md', 'B.md']);
    expect(totalBytes).toBeLessThanOrEqual(MAX_TOTAL_BYTES);
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
