import * as fs from 'node:fs/promises';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { filesystemStatus } from './branch-filesystem';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

afterEach(() => vi.clearAllMocks());

it('reports a real directory, missing checkout, regular file and symlink distinctly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agor-filesystem-status-'));
  try {
    await writeFile(join(root, 'file'), 'fixture');
    await symlink(root, join(root, 'link'));
    expect(await filesystemStatus(root)).toEqual({ exists: true, kind: 'directory' });
    expect(await filesystemStatus(join(root, 'missing'))).toEqual({
      exists: false,
      kind: 'missing',
    });
    expect(await filesystemStatus(join(root, 'file'))).toEqual({ exists: true, kind: 'file' });
    expect(await filesystemStatus(join(root, 'link'))).toEqual({ exists: true, kind: 'other' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['EACCES', 'EPERM', 'EIO', 'ENOTDIR'])(
  'never turns %s into an absent checkout',
  async (code) => {
    // Deterministic even when tests run as root; chmod is not an access-denial fixture.
    const error = Object.assign(new Error('filesystem failure'), { code });
    vi.mocked(fs.lstat).mockRejectedValueOnce(error);
    await expect(filesystemStatus('/disposable-fixture')).rejects.toBe(error);
  }
);
