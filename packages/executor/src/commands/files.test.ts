import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileListItem } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGit } from '../git/index.js';
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

/**
 * Integration coverage for the git-status enrichment in `browseBranchFiles`.
 * Uses a real throwaway git repo so the porcelain parsing is exercised against
 * actual git output rather than a fixture.
 */
describe('browseBranchFiles git status', () => {
  let dir: string;

  const statusByPath = (files: FileListItem[]) => new Map(files.map((f) => [f.path, f.gitStatus]));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agor-files-git-'));
    const { git } = createGit(dir);
    await git.init();
    await git.addConfig('user.email', 'test@agor.test');
    await git.addConfig('user.name', 'Agor Test');
    await git.addConfig('commit.gpgsign', 'false');

    await writeFile(join(dir, 'keep.txt'), 'unchanged\n');
    await writeFile(join(dir, 'mod.txt'), 'original\n');
    await writeFile(join(dir, 'del.txt'), 'to be deleted\n');
    await writeFile(join(dir, 'old-name.txt'), 'rename me to a new path\n');
    await writeFile(join(dir, '.gitignore'), '*.log\n');
    await git.add('.');
    await git.commit('initial');

    // Working-tree mutations covering each VSCode-style status.
    await writeFile(join(dir, 'mod.txt'), 'original\nchanged\n');
    await unlink(join(dir, 'del.txt'));
    await git.mv('old-name.txt', 'new-name.txt');
    await writeFile(join(dir, 'fresh.txt'), 'brand new untracked\n');
    await writeFile(join(dir, 'debug.log'), 'ignored by *.log\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('tags each file with its working-tree status', async () => {
    const files = await browseBranchFiles(dir);
    const status = statusByPath(files);

    expect(status.get('keep.txt')).toBeUndefined();
    expect(status.get('mod.txt')).toBe('modified');
    expect(status.get('new-name.txt')).toBe('renamed');
    expect(status.get('fresh.txt')).toBe('untracked');
    expect(status.get('debug.log')).toBe('ignored');
  });

  it('appends deleted files as synthetic entries', async () => {
    const files = await browseBranchFiles(dir);
    const deleted = files.find((f) => f.path === 'del.txt');

    expect(deleted).toBeDefined();
    expect(deleted?.gitStatus).toBe('deleted');
    expect(deleted?.isText).toBe(true);
    // The renamed-away original path must not resurface as a deletion.
    expect(files.some((f) => f.path === 'old-name.txt')).toBe(false);
  });

  it('returns HEAD and working-tree text for content-level diffs', async () => {
    await expect(readBranchFile(dir, 'mod.txt')).resolves.toMatchObject({
      gitStatus: 'modified',
      content: 'original\nchanged\n',
      gitDiff: { baseContent: 'original\n' },
    });

    await expect(readBranchFile(dir, 'fresh.txt')).resolves.toMatchObject({
      gitStatus: 'untracked',
      content: 'brand new untracked\n',
      gitDiff: { baseContent: '' },
    });
  });

  it('reads deleted and renamed files from their original HEAD paths', async () => {
    await expect(readBranchFile(dir, 'del.txt')).resolves.toMatchObject({
      gitStatus: 'deleted',
      content: '',
      encoding: 'utf-8',
      gitDiff: { baseContent: 'to be deleted\n' },
    });

    await expect(readBranchFile(dir, 'new-name.txt')).resolves.toMatchObject({
      gitStatus: 'renamed',
      content: 'rename me to a new path\n',
      gitDiff: {
        basePath: 'old-name.txt',
        baseContent: 'rename me to a new path\n',
      },
    });
  });

  it('leaves the file list intact for a non-git directory', async () => {
    const plainDir = await mkdtemp(join(tmpdir(), 'agor-files-plain-'));
    try {
      await writeFile(join(plainDir, 'note.txt'), 'no repo here\n');
      const files = await browseBranchFiles(plainDir);
      expect(files.map((f) => f.path)).toContain('note.txt');
      expect(files.every((f) => f.gitStatus === undefined)).toBe(true);
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });
});
