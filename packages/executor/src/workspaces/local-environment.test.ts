import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGit } from '@agor/git';
import { expect, it } from 'vitest';
import { exportGitSeed, installGitSeed } from './local-environment';

it('restores real history and index without overwriting source, and keeps independent local Git state', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'agor-local-git-'));
  try {
    const source = path.join(root, 'source');
    await mkdir(source);
    const { git } = createGit(source);
    await git.init();
    await git.addConfig('user.name', 'Fixture');
    await git.addConfig('user.email', 'fixture@example.test');
    await writeFile(path.join(source, 'file'), 'original');
    await git.add('file');
    await git.commit('original');
    const head = await git.revparse(['HEAD']);
    await git.addRemote('origin', 'https://user:secret@example.test/repo?token=secret');
    const seed = path.join(root, 'seed');
    await exportGitSeed(source, seed);
    expect(await readFile(path.join(seed, 'seed.json'), 'utf8')).not.toContain('secret');
    for (const name of ['one', 'two']) {
      const workspace = path.join(root, name);
      await mkdir(workspace);
      await writeFile(path.join(workspace, 'file'), 'coordinator revision');
      await installGitSeed(seed, workspace);
      expect(await createGit(workspace).git.revparse(['HEAD'])).toBe(head);
      expect((await createGit(workspace).git.status()).modified).toEqual(['file']);
    }
    const one = createGit(path.join(root, 'one')).git;
    await one.add('file');
    await one.commit('private commit');
    await installGitSeed(seed, path.join(root, 'one'));
    expect(await one.revparse(['HEAD'])).not.toBe(head);
    expect(await createGit(path.join(root, 'two')).git.revparse(['HEAD'])).toBe(head);
    expect(await readFile(path.join(root, 'two', 'file'), 'utf8')).toBe('coordinator revision');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
