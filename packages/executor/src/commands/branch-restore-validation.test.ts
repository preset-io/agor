import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Branch, Repo } from '@agor/core/types';
import { expect, it } from 'vitest';
import { createGit } from '../git/index.js';
import { validateExistingRestore } from './branch-restore-validation.js';

it.each(['local', 'symlink', 'separate'] as const)(
  'validates clone metadata containment: %s',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'restore-validation-'));
    try {
      const home = join(root, 'home');
      await mkdir(home);
      const { git } = createGit(home);
      await git.init(['-b', 'personal']);
      await git.addConfig('user.name', 'Fixture');
      await git.addConfig('user.email', 'fixture@example.test');
      await writeFile(join(home, 'personal.md'), 'retained');
      await git.add('.');
      await git.commit('personal');
      await git.addRemote('origin', 'https://example.test/personal.git');
      if (kind !== 'local') {
        const external = join(root, 'external.git');
        await rename(join(home, '.git'), external);
        if (kind === 'symlink') await symlink(external, join(home, '.git'));
        else await writeFile(join(home, '.git'), `gitdir: ${external}\n`);
      }
      const branch = {
        branch_id: 'fixture',
        path: home,
        ref: 'personal',
        storage_mode: 'clone',
      } as Branch;
      const repo = { remote_url: 'https://example.test/personal.git' } as Repo;
      if (kind === 'local') expect(await validateExistingRestore(branch, repo)).toBe(true);
      else
        await expect(validateExistingRestore(branch, repo)).rejects.toThrow('invalid Git linkage');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
