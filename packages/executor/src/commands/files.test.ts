import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { browseBranchFiles, readBranchFile } from './files.js';

describe('branch file commands', () => {
  it('browses files while excluding ignored directories and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-files-'));
    await mkdir(join(root, 'src'));
    await mkdir(join(root, 'node_modules'));
    await writeFile(join(root, 'README.md'), '# Browser title\n');
    await writeFile(join(root, 'src', 'index.ts'), 'export {};\n');
    await writeFile(join(root, 'node_modules', 'ignored.js'), '');
    await symlink(join(root, 'src', 'index.ts'), join(root, 'link.ts'));

    const files = await browseBranchFiles(root);

    expect(files.map(({ path }) => path).sort()).toEqual(['README.md', 'src/index.ts']);
    expect(files.find(({ path }) => path === 'README.md')?.title).toBe('Browser title');
  });

  it('returns text and binary content with the original preview metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agor-files-'));
    await writeFile(join(root, 'notes.md'), '# Notes\nbody');
    await writeFile(join(root, 'image.png'), Buffer.from([0, 1, 2]));

    expect(await readBranchFile(root, 'notes.md')).toMatchObject({
      title: 'Notes',
      isText: true,
      content: '# Notes\nbody',
      encoding: 'utf-8',
    });
    expect(await readBranchFile(root, 'image.png')).toMatchObject({
      isText: false,
      content: 'AAEC',
      encoding: 'base64',
    });
  });

  it('rejects traversal and symlink escapes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'agor-files-'));
    const root = join(parent, 'branch');
    await mkdir(root);
    await writeFile(join(parent, 'secret.txt'), 'secret');
    await symlink(join(parent, 'secret.txt'), join(root, 'escape.txt'));

    await expect(readBranchFile(root, '../secret.txt')).rejects.toThrow(/path escapes branch/i);
    await expect(readBranchFile(root, 'escape.txt')).rejects.toThrow(/path escapes branch/i);
  });
});
