import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { simpleGit } from '@agor/git';
import { Header } from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertBundlePath,
  assertStandaloneClone,
  packBranchBundle,
  restoreBranchBundle,
} from './branch-bundle.js';

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'agor-bundle-'));
  fixtures.push(dir);
  const origin = join(dir, 'origin');
  const root = join(dir, 'clone');
  await mkdir(origin);
  const git = simpleGit(origin);
  await git.init();
  await git.addConfig('user.name', 'Bundle test');
  await git.addConfig('user.email', 'bundle@example.invalid');
  await writeFile(join(origin, 'tracked'), 'committed\n');
  await writeFile(join(origin, '.gitignore'), 'ignored/\n');
  await git.add('.');
  await git.commit('fixture');
  await simpleGit().clone(origin, root, ['--no-hardlinks']);
  return { dir, root, git: simpleGit(root) };
}

describe('workspace bundles', () => {
  it('roundtrips a real clone with index, dirty, untracked, ignored files, modes and symlinks', async () => {
    const { dir, root, git } = await fixture();
    await writeFile(join(root, 'tracked'), 'staged\n');
    await git.add('tracked');
    await writeFile(join(root, 'tracked'), 'dirty\n');
    await writeFile(join(root, 'untracked'), 'untracked\n');
    await chmod(join(root, 'untracked'), 0o751);
    await mkdir(join(root, 'ignored'));
    await writeFile(join(root, 'ignored', 'dependency'), 'ignored dependency\n');
    await symlink('../tracked', join(root, 'ignored', 'safe-link'));
    const before = await git.raw(['status', '--porcelain=v1', '--ignored']);
    const index = await readFile(join(root, '.git', 'index'));
    const archive = join(dir, 'bundle.tgz');
    const receipt = await packBranchBundle(root, createWriteStream(archive));
    const bytes = await readFile(archive);
    expect(receipt.bytes).toBe(bytes.length);
    const staging = join(dir, 'restored');
    await restoreBranchBundle(Readable.from(bytes), staging, receipt);
    expect(await readFile(join(staging, '.git', 'index'))).toEqual(index);
    expect(await simpleGit(staging).raw(['status', '--porcelain=v1', '--ignored'])).toBe(before);
    expect(await readFile(join(staging, 'tracked'), 'utf8')).toBe('dirty\n');
    expect(await readFile(join(staging, 'ignored', 'dependency'), 'utf8')).toBe(
      'ignored dependency\n'
    );
    expect((await lstat(join(staging, 'untracked'))).mode & 0o777).toBe(0o751);
    expect(await readlink(join(staging, 'ignored', 'safe-link'))).toBe('../tracked');
  });

  it('refuses worktrees, borrowed objects, config indirection and unsafe links without deleting the source', async () => {
    const { dir, root, git } = await fixture();
    const worktree = join(dir, 'worktree');
    await git.raw(['worktree', 'add', '-b', 'other', worktree]);
    await expect(assertStandaloneClone(worktree)).rejects.toThrow('self-contained');
    await expect(assertStandaloneClone(root)).rejects.toThrow('linked worktrees');
    await git.raw(['worktree', 'remove', worktree]);
    await writeFile(join(root, '.git', 'objects', 'info', 'alternates'), '/outside/objects\n');
    await expect(assertStandaloneClone(root)).rejects.toThrow('external Git');
    await rm(join(root, '.git', 'objects', 'info', 'alternates'));
    await symlink('../../outside', join(root, 'escape'));
    await expect(
      packBranchBundle(
        root,
        new Writable({
          write(_c, _e, cb) {
            cb();
          },
        })
      )
    ).rejects.toThrow('escapes');
    expect(await readFile(join(root, 'tracked'), 'utf8')).toBe('committed\n');
  });

  it('does not report a corrupt or interrupted restore as successful and refuses reused staging', async () => {
    const { dir, root } = await fixture();
    const chunks: Buffer[] = [];
    const receipt = await packBranchBundle(
      root,
      new Writable({
        write(c, _e, cb) {
          chunks.push(c);
          cb();
        },
      })
    );
    const body = Buffer.concat(chunks);
    const staging = join(dir, 'bad-digest');
    await expect(
      restoreBranchBundle(Readable.from(body), staging, { ...receipt, sha256: '0'.repeat(64) })
    ).rejects.toThrow('integrity');
    await expect(restoreBranchBundle(Readable.from(body), staging, receipt)).rejects.toThrow();
    await expect(
      restoreBranchBundle(
        Readable.from(body.subarray(0, body.length / 2)),
        join(dir, 'partial'),
        receipt
      )
    ).rejects.toThrow();
    // A matching digest must not make malformed compressed/archive data valid.
    const truncated = body.subarray(0, body.length / 2);
    await expect(
      restoreBranchBundle(Readable.from(truncated), join(dir, 'bad-archive'), {
        bytes: truncated.length,
        sha256: createHash('sha256').update(truncated).digest('hex'),
      })
    ).rejects.toThrow();
  });

  it.each([
    { path: '../outside', type: 'File' as const },
    { path: '/outside', type: 'File' as const },
    { path: 'escape', type: 'SymbolicLink' as const, linkpath: '../outside' },
    { path: 'escape', type: 'Link' as const, linkpath: '../outside' },
    { path: 'pipe', type: 'FIFO' as const },
  ])('rejects unsafe entries during actual extraction: $path $type', async (entry) => {
    const { dir } = await fixture();
    const header = new Header({ ...entry, mode: 0o644, size: 0 });
    const block = Buffer.alloc(512);
    header.encode(block);
    const body = Buffer.concat([block, Buffer.alloc(1024)]);
    const expected = {
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    await expect(
      restoreBranchBundle(Readable.from(body), join(dir, 'unsafe'), expected)
    ).rejects.toThrow();
    await expect(lstat(join(dir, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('propagates a failed upload sink without changing the workspace', async () => {
    const { root } = await fixture();
    await expect(
      packBranchBundle(
        root,
        new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error('transfer interrupted'));
          },
        })
      )
    ).rejects.toThrow('transfer interrupted');
    expect(await readFile(join(root, 'tracked'), 'utf8')).toBe('committed\n');
  });

  it.each(['/absolute', '../escape', 'a/../../escape', 'C:/drive', 'a\\b', 'a\0b'])(
    'rejects unsafe archive name %j',
    (name) => {
      expect(() => assertBundlePath(name)).toThrow('Unsafe');
    }
  );
});
