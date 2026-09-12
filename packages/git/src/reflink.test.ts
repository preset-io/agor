import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createBranchAsReflink, createGit } from './index';

// Node's macOS copyfile implementation does not implement FICLONE_FORCE.
// Exercise Git/isolation semantics with copies here; EC2 proof requires real reflinks.
vi.mock('node:fs/promises', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return process.platform !== 'darwin'
    ? fs
    : {
        ...fs,
        cp: (source: string, destination: string, options?: import('node:fs').CopyOptions) =>
          fs.cp(source, destination, { ...options, mode: 0 }),
      };
});
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it('reflinks cached checkouts with private Git, fresh remote commits and no inherited hooks/config', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'agor-reflink-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  if (process.platform === 'linux') {
    const probe = join(root, 'probe');
    await writeFile(probe, 'reflink capability');
    try {
      await copyFile(probe, `${probe}.clone`, constants.COPYFILE_FICLONE_FORCE);
    } catch (error) {
      if (
        ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(
          (error as NodeJS.ErrnoException).code ?? ''
        )
      ) {
        context.skip();
        return;
      }
      throw error;
    }
  }
  const source = join(root, 'source');
  await mkdir(source);
  const g = createGit(source).git;
  await g.init();
  await g.addConfig('user.name', 'Test');
  await g.addConfig('user.email', 'test@example.test');
  await writeFile(join(source, 'README.md'), 'first\n');
  await writeFile(join(source, '.npmrc'), 'min-release-age=3\n');
  await mkdir(join(source, 'frontend'));
  await symlink('../.npmrc', join(source, 'frontend', '.npmrc'));
  await g.add(['README.md', '.npmrc', 'frontend/.npmrc']);
  await g.commit('first');
  await g.raw(['branch', '-M', 'main']);
  await g.addAnnotatedTag('v1', 'version');
  await g.raw(['update-ref', 'refs/remotes/origin/main', (await g.revparse(['HEAD'])).trim()]);
  await g.raw(['update-server-info']);
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    const name = resolve(
      source,
      '.git',
      `.${new URL(req.url!, 'http://localhost').pathname.replace(/^\/repo/, '')}`
    );
    if (!name.startsWith(`${join(source, '.git')}/`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      res.end(await readFile(name));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address === 'object');
  const remoteUrl = `http://127.0.0.1:${address.port}/repo`;
  const options = {
    remoteUrl,
    referencePath: source,
    cacheRoot: join(root, 'cache'),
    cacheScope: 'repo/user',
    ref: 'main',
  };
  await g.addConfig('credential.helper', 'must-not-copy');
  await writeFile(join(source, '.git', 'hooks', 'post-checkout'), 'must-not-copy');
  const a = join(root, 'a'),
    b = join(root, 'b');
  await createBranchAsReflink({ ...options, targetPath: a, newBranchName: 'feature/a' });
  const before = requests;
  await createBranchAsReflink({ ...options, targetPath: b, newBranchName: 'feature/b' });
  expect(requests).toBeGreaterThan(before);
  expect(await readFile(join(b, '.npmrc'), 'utf8')).toBe('min-release-age=3\n');
  expect(await readlink(join(b, 'frontend', '.npmrc'))).toBe('../.npmrc');
  const ga = createGit(a).git,
    gb = createGit(b).git;
  expect((await gb.raw(['describe', '--tags'])).trim()).toBe('v1');
  expect((await ga.status()).isClean()).toBe(true);
  expect((await gb.raw(['symbolic-ref', '--short', 'HEAD'])).trim()).toBe('feature/b');
  expect((await stat(join(a, '.git', 'index'))).ino).not.toBe(
    (await stat(join(b, '.git', 'index'))).ino
  );
  expect(await readFile(join(b, '.git', 'config'), 'utf8')).not.toContain('must-not-copy');
  expect(await readdir(join(b, '.git'))).not.toContain('commondir');
  await writeFile(join(a, 'README.md'), 'private');
  await ga.add('README.md');
  expect(await readFile(join(b, 'README.md'), 'utf8')).toBe('first\n');
  expect((await gb.status()).isClean()).toBe(true);
  await expect(createBranchAsReflink({ ...options, targetPath: b })).rejects.toThrow(
    'already exists'
  );
  await writeFile(join(source, 'README.md'), 'remote update\n');
  await g.add('README.md');
  await g.commit('second');
  await g.raw(['update-server-info']);
  const c = join(root, 'c');
  await createBranchAsReflink({ ...options, targetPath: c, newBranchName: 'feature/c' });
  expect(await readFile(join(c, 'README.md'), 'utf8')).toBe('remote update\n');
  expect((await createGit(c).git.revparse(['HEAD'])).trim()).toBe(
    (await g.revparse(['HEAD'])).trim()
  );
  expect(await readFile(join(b, 'README.md'), 'utf8')).toBe('first\n');
  const missing = join(root, 'missing');
  await expect(
    createBranchAsReflink({ ...options, ref: 'missing-ref', targetPath: missing })
  ).rejects.toThrow();
  await expect(stat(missing)).rejects.toThrow();
}, 30000);
