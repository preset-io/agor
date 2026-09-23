import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { expect, it } from 'vitest';
import { createBranch, restoreBranchFilesystem } from './index';

it.each(['local-only', 'ahead', 'behind', 'diverged'])(
  'filesystem recovery preserves retained history with a missing checkout: %s',
  async (state) => {
    const root = await mkdtemp(join(tmpdir(), 'restore-history-'));
    try {
      const base = join(root, 'base');
      const remote = join(root, 'remote');
      const home = join(root, 'home');
      await mkdir(base);
      await mkdir(remote);
      await simpleGit(remote).init(true);
      const git = simpleGit(base);
      await git.init(['-b', 'main']);
      await git.addConfig('user.name', 'Fixture');
      await git.addConfig('user.email', 'fixture@example.test');
      await writeFile(join(base, 'README.md'), 'base');
      await git.add('.');
      await git.commit('base');
      await git.addRemote('origin', remote);
      await git.push('origin', 'main');
      await git.raw(['worktree', 'add', '-b', 'personal', home, 'main']);
      if (state !== 'local-only') await git.push('origin', 'personal');
      const personal = simpleGit(home);
      await writeFile(join(home, 'personal.md'), 'retained personal work');
      await personal.add('.');
      await personal.commit('personal');
      const sha = await personal.revparse(['HEAD']);
      if (state === 'behind') await personal.push('origin', 'personal');
      if (state === 'behind' || state === 'diverged') {
        const other = join(root, 'other');
        await git.clone(remote, other, ['--branch', 'personal']);
        const remoteWriter = simpleGit(other);
        await remoteWriter.addConfig('user.name', 'Fixture');
        await remoteWriter.addConfig('user.email', 'fixture@example.test');
        await writeFile(join(other, 'remote.md'), 'remote-only change');
        await remoteWriter.add('.');
        await remoteWriter.commit('remote change');
        await remoteWriter.push('origin', 'personal');
      }
      await git.raw(['worktree', 'remove', home]);
      expect(
        await restoreBranchFilesystem(
          base,
          home,
          'personal',
          'main',
          {},
          undefined,
          'branch',
          remote,
          true
        )
      ).toMatchObject({
        success: true,
        strategy: 'checkout',
      });
      expect(await git.revparse(['refs/heads/personal'])).toBe(sha);
      expect(await simpleGit(home).revparse(['HEAD'])).toBe(sha);
      expect(await readFile(join(home, 'personal.md'), 'utf8')).toBe('retained personal work');
      // If a retained ref is discovered only after remote I/O, fail closed
      // rather than deleting it through createBranch's ordinary collision path.
      await git.raw(['worktree', 'remove', home]);
      await expect(
        createBranch(
          base,
          home,
          'personal',
          true,
          false,
          'main',
          undefined,
          'branch',
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          true
        )
      ).rejects.toThrow('refusing to replace it');
      expect(await git.revparse(['refs/heads/personal'])).toBe(sha);
      expect(await git.show([`${sha.trim()}:personal.md`])).toBe('retained personal work');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
