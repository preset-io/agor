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
