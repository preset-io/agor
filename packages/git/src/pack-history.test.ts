import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readPackHistoryAdditions, simpleGit } from './index';

it('reports text added anywhere in packed history, including later-deleted files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agor-pack-history-'));
  try {
    const git = simpleGit(root);
    await git.init();
    await git.addConfig('user.name', 'Fixture');
    await git.addConfig('user.email', 'fixture@example.test');
    await writeFile(join(root, 'notes.md'), 'hello\n');
    await git.add('.');
    await git.commit('base');
    await writeFile(join(root, 'config.txt'), 'token: ghp_example\nsecond line\n');
    await git.add('.');
    await git.commit('add config');
    await git.rm('config.txt');
    await git.commit('remove config');

    const additions = await readPackHistoryAdditions(root, { localHome: true });
    expect(additions.get('config.txt')).toBe('token: ghp_example\nsecond line');
    expect(additions.get('notes.md')).toBe('hello');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('includes text a merge resolution introduced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agor-pack-history-'));
  try {
    const git = simpleGit(root);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'Fixture');
    await git.addConfig('user.email', 'fixture@example.test');
    await writeFile(join(root, 'app.env'), 'MODE=base\n');
    await git.add('.');
    await git.commit('base');
    await git.checkoutLocalBranch('side');
    await writeFile(join(root, 'app.env'), 'MODE=side\n');
    await git.commit('side', ['app.env']);
    await git.checkout('main');
    await writeFile(join(root, 'app.env'), 'MODE=main\n');
    await git.commit('main', ['app.env']);
    await git.merge(['side']).catch(() => undefined);
    await writeFile(join(root, 'app.env'), 'MODE=merged\nTOKEN=ghp_resolution\n');
    await git.add('app.env');
    await git.commit('merge side');

    const additions = await readPackHistoryAdditions(root, { localHome: true });
    expect(additions.get('app.env')).toContain('TOKEN=ghp_resolution');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
