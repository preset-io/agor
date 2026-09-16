import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createBranchAsClone, simpleGit } from './index';

it('creates independent full-history persona homes, without touching source or siblings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agor-local-home-'));
  try {
    const source = join(root, 'source');
    await mkdir(source);
    const git = simpleGit(source);
    await git.init();
    await git.addConfig('user.name', 'Fixture');
    await git.addConfig('user.email', 'fixture@example.test');
    await writeFile(join(source, 'IDENTITY.md'), 'Blank');
    await git.add('.');
    await git.commit('base');
    await git.checkoutLocalBranch('template/builder');
    await writeFile(join(source, 'IDENTITY.md'), 'Builder persona');
    await git.add('.');
    await git.commit('persona');
    await git.addRemote('origin', 'https://example.test/unchanged.git');
    const configBefore = await readFile(join(source, '.git/config'), 'utf8');
    const sourceHead = await git.revparse('HEAD');
    const homes = [join(root, 'one'), join(root, 'two')];
    for (const [index, home] of homes.entries()) {
      await createBranchAsClone({
        remoteUrl: source,
        targetPath: home,
        ref: 'template/builder',
        newBranchName: `private-${index}`,
        localHome: true,
      });
      expect((await stat(join(home, '.git'))).isDirectory()).toBe(true);
      await expect(stat(join(home, '.git/objects/info/alternates'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(home, 'IDENTITY.md'), 'utf8')).toBe('Builder persona');
      const local = simpleGit(home);
      expect(await local.getRemotes()).toEqual([]);
      expect(await local.raw(['rev-list', '--count', 'HEAD'])).toBe('2\n');
      const config = await readFile(join(home, '.git/config'), 'utf8');
      expect(config).not.toMatch(/remote =|merge =|\[remote /);
      await expect(local.push()).rejects.toThrow();
      await expect(local.push('origin', `private-${index}`)).rejects.toThrow();
    }
    const one = simpleGit(homes[0]);
    await one.addConfig('user.name', 'Fixture');
    await one.addConfig('user.email', 'fixture@example.test');
    await writeFile(join(homes[0], 'local-work'), 'Useful local work');
    await one.add('.');
    await one.commit('first value');
    await one.addRemote('backup', 'https://example.test/authorized-private.git');
    expect(await simpleGit(homes[1]).getRemotes()).toEqual([]);
    expect(await simpleGit(homes[1]).revparse('HEAD')).toBe(sourceHead);
    expect(await git.revparse('HEAD')).toBe(sourceHead);
    expect(await readFile(join(source, '.git/config'), 'utf8')).toBe(configBefore);
    await rm(source, { recursive: true });
    expect(await one.raw(['rev-list', '--count', 'HEAD'])).toBe('3\n');
    expect(await simpleGit(homes[1]).raw(['rev-list', '--count', 'HEAD'])).toBe('2\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects borrowing, shallow history, and an origin override for local homes before I/O', async () => {
  for (const extra of [
    { referencePath: '/cache' },
    { depth: 1 },
    { originRemoteUrl: 'https://example.test/private.git' },
  ]) {
    await expect(
      createBranchAsClone({
        remoteUrl: 'https://example.test/source.git',
        targetPath: '/unused',
        ref: 'main',
        localHome: true,
        ...extra,
      })
    ).rejects.toThrow('full history');
  }
});
