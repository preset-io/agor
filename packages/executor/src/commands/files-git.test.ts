import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createGit } from '../git/index.js';
import { readBoundedGit } from './files-git.js';

it('reads exact blob bytes and rejects output over budget without truncating', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agor-bounded-git-'));
  try {
    const { git } = createGit(root);
    await git.init();
    await writeFile(join(root, 'file.txt'), ' x\n'.repeat(100_000));
    await git.add('file.txt');
    const args = ['show', ':file.txt'];
    await expect(readBoundedGit(root, args, 400_000)).resolves.toBe(' x\n'.repeat(100_000));
    await expect(readBoundedGit(root, args, 128)).rejects.toThrow();
    await expect(readBoundedGit(root, ['show', ':missing'], 128)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
