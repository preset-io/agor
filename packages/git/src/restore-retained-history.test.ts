import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { expect, it } from 'vitest';
import { createBranch, restoreBranchFilesystem } from './index';

it.each([false, true])(
  'restores retained history unchanged (pushed baseline: %s)',
  async (pushed) => {
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
      if (pushed) await git.push('origin', 'personal');
      const personal = simpleGit(home);
      await writeFile(join(home, 'personal.md'), 'retained personal work');
      await personal.add('.');
      await personal.commit('personal');
      const sha = await personal.revparse(['HEAD']);
      await git.raw(['worktree', 'remove', home]);
      expect(await restoreBranchFilesystem(base, home, 'personal', 'main')).toMatchObject({
        success: true,
        strategy: 'checkout',
      });
      expect(await git.revparse(['refs/heads/personal'])).toBe(sha);
      expect(await simpleGit(home).revparse(['HEAD'])).toBe(sha);
      expect(await readFile(join(home, 'personal.md'), 'utf8')).toBe('retained personal work');
      // A ref discovered only at worktree-add time must also survive the
      // reconstruction fallback's "already exists" path.
      await git.raw(['worktree', 'remove', home]);
      await createBranch(
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
        true
      );
      expect(await git.revparse(['refs/heads/personal'])).toBe(sha);
      expect(await simpleGit(home).revparse(['HEAD'])).toBe(sha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
