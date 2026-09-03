import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { filesystemStatus } from './branch-filesystem.js';

describe('filesystemStatus', () => {
  it('distinguishes directories, files, symlinks, and missing paths without following symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-filesystem-status-'));
    const directory = join(root, 'directory');
    const file = join(root, 'file');
    const link = join(root, 'link');
    const missing = join(root, 'missing');
    await mkdir(directory);
    await writeFile(file, 'content');
    await symlink(directory, link);

    await expect(filesystemStatus(directory)).resolves.toEqual({ exists: true, kind: 'directory' });
    await expect(filesystemStatus(file)).resolves.toEqual({ exists: true, kind: 'file' });
    await expect(filesystemStatus(link)).resolves.toEqual({ exists: true, kind: 'other' });
    await expect(filesystemStatus(missing)).resolves.toEqual({ exists: false, kind: 'missing' });
  });
});
