import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { cleanIgnoredWorkspace, simpleGit } from './index';

it('cleans ignored files only, preserving tracked changes, staged files, ordinary untracked files and stash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agor-ignored-cleanup-test-'));
  try {
    const git = simpleGit(directory);
    await git.init();
    await git.addConfig('user.name', 'Cleanup fixture');
    await git.addConfig('user.email', 'cleanup@example.test');
    await writeFile(join(directory, '.gitignore'), '*.disposable\n');
    await writeFile(join(directory, 'tracked'), 'base');
    await git.add(['.gitignore', 'tracked']);
    await git.commit('fixture');
    await writeFile(join(directory, 'tracked'), 'stashed change');
    await git.stash(['push', '-m', 'fixture stash']);
    const stashBefore = await git.raw(['rev-parse', 'refs/stash']);
    await writeFile(join(directory, 'tracked'), 'working change');
    await writeFile(join(directory, 'staged'), 'staged source');
    await git.add('staged');
    await writeFile(join(directory, 'untracked'), 'untracked source');
    await writeFile(join(directory, 'cache.disposable'), 'discard only this');
    const indexBefore = await git.diff(['--cached']);
    await cleanIgnoredWorkspace(directory, 5000);
    await expect(readFile(join(directory, 'cache.disposable'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(join(directory, 'tracked'), 'utf8')).toBe('working change');
    expect(await readFile(join(directory, 'staged'), 'utf8')).toBe('staged source');
    expect(await readFile(join(directory, 'untracked'), 'utf8')).toBe('untracked source');
    expect(await git.diff(['--cached'])).toBe(indexBefore);
    expect(await git.raw(['rev-parse', 'refs/stash'])).toBe(stashBefore);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
