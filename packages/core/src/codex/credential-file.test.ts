import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeBwrapBindFd } from '../unix/bwrap';
import {
  advanceCredentialFileGeneration,
  CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES,
  compareAndSwapCredentialFile,
  ensureCredentialAuthorityLayout,
  ensureCredentialAuthorityLayoutSync,
  mutateCredentialFile,
  openCredentialFileForBind,
  readCredentialAuthorityFile,
  readCredentialFile,
} from './credential-file';

describe('credential file directory capability', () => {
  it.runIf(process.platform === 'linux' && probeBwrapBindFd())(
    'persists writes through a bubblewrap fd bind without touching the mountpoint inode',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agor-credential-bwrap-'));
      const sourceHome = join(root, 'caller', '.codex');
      const branchHome = join(root, 'branch', 'codex');
      const source = join(sourceHome, 'auth.json');
      const destination = join(branchHome, 'auth.json');
      await mkdir(sourceHome, { recursive: true });
      await mkdir(branchHome, { recursive: true });
      await writeFile(source, 'before');
      await writeFile(destination, '');

      const handle = await openCredentialFileForBind(source);
      try {
        const result = spawnSync(
          'bwrap',
          [
            '--unshare-user',
            '--ro-bind',
            '/',
            '/',
            '--bind',
            root,
            root,
            '--bind-fd',
            '3',
            destination,
            '--',
            'sh',
            '-c',
            'printf refreshed > "$1"',
            'sh',
            destination,
          ],
          { stdio: ['ignore', 'pipe', 'pipe', handle.fd] }
        );
        expect(result.status, result.stderr.toString()).toBe(0);
      } finally {
        await handle.close();
      }

      await expect(readFile(source, 'utf8')).resolves.toBe('refreshed');
      await expect(readFile(destination, 'utf8')).resolves.toBe('');
    }
  );

  it.runIf(process.platform === 'linux')(
    'pins the validated auth inode across a pathname replacement',
    async () => {
      const codexHome = await mkdtemp(join(tmpdir(), 'agor-credential-bind-'));
      const target = join(codexHome, 'auth.json');
      const openedTarget = join(codexHome, 'auth.opened.json');
      await writeFile(target, 'original');

      const handle = await openCredentialFileForBind(target);
      try {
        await rename(target, openedTarget);
        await writeFile(target, 'replacement');

        await expect(handle.readFile('utf8')).resolves.toBe('original');
        await expect(readFile(target, 'utf8')).resolves.toBe('replacement');
      } finally {
        await handle.close();
      }
    }
  );

  it.runIf(process.platform === 'linux')(
    'rejects symlink and multiply-linked bind sources',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agor-credential-bind-reject-'));
      const real = join(root, 'real.json');
      const symlinked = join(root, 'symlink.json');
      const hardlinked = join(root, 'hardlink.json');
      await writeFile(real, 'credential');
      await symlink(real, symlinked);
      await expect(openCredentialFileForBind(symlinked)).rejects.toThrow();

      await link(real, hardlinked);
      await expect(openCredentialFileForBind(real)).rejects.toThrow(/hard links/);
    }
  );

  it.runIf(process.platform === 'linux')(
    'synchronously prepares stable authority leaves and fails closed on aliases',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agor-credential-layout-sync-'));
      const target = join(root, 'home', '.claude', '.credentials.json');
      ensureCredentialAuthorityLayoutSync(target);
      const paths = [
        target,
        ...CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES.map((name) =>
          join(root, 'home', '.claude', name)
        ),
      ];
      for (const path of paths) {
        expect((await lstat(path)).isFile()).toBe(true);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
      await writeFile(target, 'existing-authority');
      const originalInodes = await Promise.all(paths.map(async (path) => (await stat(path)).ino));
      ensureCredentialAuthorityLayoutSync(target);
      expect(await readFile(target, 'utf8')).toBe('existing-authority');
      expect(await Promise.all(paths.map(async (path) => (await stat(path)).ino))).toEqual(
        originalInodes
      );

      const symlinkRoot = join(root, 'symlink-home');
      const other = join(root, 'other');
      await mkdir(other);
      await mkdir(symlinkRoot);
      await symlink(other, join(symlinkRoot, '.claude'));
      expect(() =>
        ensureCredentialAuthorityLayoutSync(join(symlinkRoot, '.claude', '.credentials.json'))
      ).toThrow();

      const hardlinkDir = join(root, 'hardlink-home', '.claude');
      const outside = join(root, 'outside');
      await mkdir(hardlinkDir, { recursive: true });
      await writeFile(outside, 'must-not-change');
      await link(outside, join(hardlinkDir, '.credentials.json'));
      expect(() =>
        ensureCredentialAuthorityLayoutSync(join(hardlinkDir, '.credentials.json'))
      ).toThrow(/singly-linked/);
      expect(await readFile(outside, 'utf8')).toBe('must-not-change');
    }
  );

  it.runIf(process.platform === 'linux')(
    'safely materializes real authority leaves without truncating existing bytes',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'agor-credential-layout-'));
      const target = join(home, '.claude', '.credentials.json');
      await ensureCredentialAuthorityLayout(target);

      expect((await readdir(join(home, '.claude'))).sort()).toEqual(
        ['.credentials.json', ...CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES].sort()
      );
      for (const filename of ['.credentials.json', ...CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES]) {
        const path = join(home, '.claude', filename);
        expect((await lstat(path)).isFile()).toBe(true);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        expect(await readFile(path, 'utf8')).toBe('');
      }

      await writeFile(target, 'existing-authority');
      await writeFile(join(home, '.claude', CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES[0]), '7\n');
      await ensureCredentialAuthorityLayout(target);
      expect(await readFile(target, 'utf8')).toBe('existing-authority');
      expect(
        await readFile(join(home, '.claude', CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES[0]), 'utf8')
      ).toBe('7\n');
    }
  );

  it.runIf(process.platform === 'linux')(
    'rejects a symlinked Claude parent or authority leaf during preparation',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agor-credential-layout-symlink-'));
      const other = join(root, 'other');
      await mkdir(other);
      await symlink(other, join(root, '.claude'));
      await expect(
        ensureCredentialAuthorityLayout(join(root, '.claude', '.credentials.json'))
      ).rejects.toThrow();

      const safe = join(root, 'safe', '.claude');
      await mkdir(safe, { recursive: true });
      await symlink(join(other, 'credential'), join(safe, '.credentials.json'));
      await expect(
        ensureCredentialAuthorityLayout(join(safe, '.credentials.json'))
      ).rejects.toThrow();
    }
  );

  it.runIf(process.platform === 'linux')(
    'rejects hardlinked authority leaves before in-place mutation',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agor-credential-layout-hardlink-'));
      const authority = join(root, '.claude');
      const outside = join(root, 'outside');
      await mkdir(authority);
      await writeFile(outside, 'must-not-change');
      await link(outside, join(authority, '.credentials.json'));

      await expect(
        ensureCredentialAuthorityLayout(join(authority, '.credentials.json'))
      ).rejects.toThrow(/singly-linked/);
      await expect(
        mutateCredentialFile({
          target: join(authority, '.credentials.json'),
          content: 'attacker-controlled-target',
          preserveAuthorityInodes: true,
        })
      ).rejects.toThrow(/singly-linked/);
      expect(await readFile(outside, 'utf8')).toBe('must-not-change');
    }
  );

  it.runIf(process.platform === 'linux')(
    'keeps authority inodes stable across contained Claude write, CAS, fence, and tombstone',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'agor-credential-stable-inodes-'));
      const target = join(home, '.claude', '.credentials.json');
      await ensureCredentialAuthorityLayout(target);
      const paths = [
        target,
        ...CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES.map((name) => join(home, '.claude', name)),
      ];
      const originalInodes = await Promise.all(paths.map(async (path) => (await stat(path)).ino));

      await expect(
        mutateCredentialFile({
          target,
          content: 'first',
          generation: 1,
          preserveAuthorityInodes: true,
        })
      ).resolves.toBe('applied');
      await expect(
        compareAndSwapCredentialFile({
          target,
          expectedContent: 'first',
          content: 'second',
          generation: 2,
          preserveAuthorityInodes: true,
        })
      ).resolves.toEqual({ outcome: 'written' });
      await expect(
        advanceCredentialFileGeneration({
          target,
          generation: 3,
          preserveAuthorityInodes: true,
        })
      ).resolves.toBe('applied');
      expect(await readFile(target, 'utf8')).toBe('second');
      await expect(
        mutateCredentialFile({
          target,
          generation: 4,
          preserveAuthorityInodes: true,
        })
      ).resolves.toBe('applied');

      expect(await Promise.all(paths.map(async (path) => (await stat(path)).ino))).toEqual(
        originalInodes
      );
      expect(await readFile(target, 'utf8')).toBe('');
      expect(
        await readFile(join(home, '.claude', CREDENTIAL_AUTHORITY_SIDECAR_FILENAMES[0]), 'utf8')
      ).toBe('4\n');
    }
  );

  it.runIf(process.platform === 'linux')(
    'serializes stable-inode Claude readers with a writer',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'agor-credential-stable-reader-'));
      const target = join(home, '.claude', '.credentials.json');
      await ensureCredentialAuthorityLayout(target);
      await mutateCredentialFile({
        target,
        content: 'before',
        generation: 1,
        preserveAuthorityInodes: true,
      });

      let releaseTruncate!: () => void;
      const truncated = new Promise<void>((resolveTruncated) => {
        releaseTruncate = resolveTruncated;
      });
      let reachedTruncate!: () => void;
      const truncateReached = new Promise<void>((resolveReached) => {
        reachedTruncate = resolveReached;
      });
      let seamCalls = 0;
      const writer = mutateCredentialFile({
        target,
        content: 'after',
        generation: 2,
        preserveAuthorityInodes: true,
        afterStableTruncateForTest: async () => {
          seamCalls += 1;
          if (seamCalls !== 1) return;
          reachedTruncate();
          await truncated;
        },
      });
      await truncateReached;

      let readerSettled = false;
      const reader = readCredentialAuthorityFile(target).finally(() => {
        readerSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(readerSettled).toBe(false);
      releaseTruncate();

      await expect(writer).resolves.toBe('applied');
      await expect(reader).resolves.toBe('after');
    }
  );

  it('atomically adopts a winner instead of overwriting changed credential bytes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agor-credential-cas-'));
    const target = join(home, '.credentials.json');
    await writeFile(target, 'observed');

    await mutateCredentialFile({ target, content: 'winner', generation: 2 });
    await expect(
      compareAndSwapCredentialFile({
        target,
        expectedContent: 'observed',
        content: 'loser',
        generation: 1,
      })
    ).resolves.toEqual({ outcome: 'changed', content: 'winner' });
    await expect(readFile(target, 'utf8')).resolves.toBe('winner');
  });

  it('does not recreate a credential removed after the caller observed it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agor-credential-cas-delete-'));
    const target = join(home, '.credentials.json');
    await writeFile(target, 'observed');
    await mutateCredentialFile({ target, generation: 2 });

    await expect(
      compareAndSwapCredentialFile({
        target,
        expectedContent: 'observed',
        content: 'stale-refresh',
        generation: 1,
      })
    ).resolves.toEqual({ outcome: 'changed' });
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.platform === 'linux')(
    'advances a tombstone without changing credentials and rejects a delayed lower-generation writer',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'agor-credential-fence-'));
      const target = join(home, '.credentials.json');
      await expect(
        mutateCredentialFile({ target, content: 'existing-credential', generation: 3 })
      ).resolves.toBe('applied');
      await expect(advanceCredentialFileGeneration({ target, generation: 4 })).resolves.toBe(
        'applied'
      );
      await expect(readFile(target, 'utf8')).resolves.toBe('existing-credential');
      await expect(
        mutateCredentialFile({ target, content: 'delayed-oauth', generation: 3 })
      ).resolves.toBe('stale');
      await expect(readFile(target, 'utf8')).resolves.toBe('existing-credential');
      await expect(
        mutateCredentialFile({ target, content: 'newer-oauth', generation: 5 })
      ).resolves.toBe('applied');
      await expect(readFile(target, 'utf8')).resolves.toBe('newer-oauth');
    }
  );

  it.runIf(process.platform === 'linux')(
    'does not let a retry steal the lock from a still-live writer',
    async () => {
      const codexHome = await mkdtemp(join(tmpdir(), 'agor-credential-lock-'));
      const target = join(codexHome, 'auth.json');
      let allowFirst!: () => void;
      const firstBlocked = new Promise<void>((resolveBlocked) => {
        allowFirst = resolveBlocked;
      });
      let firstHasLock!: () => void;
      const firstAcquired = new Promise<void>((resolveAcquired) => {
        firstHasLock = resolveAcquired;
      });

      const first = mutateCredentialFile({
        target,
        content: 'first',
        generation: 1,
        afterLockAcquiredForTest: async () => {
          firstHasLock();
          await firstBlocked;
        },
      });
      await firstAcquired;

      let retrySettled = false;
      const retry = mutateCredentialFile({ target, content: 'retry', generation: 2 }).finally(
        () => {
          retrySettled = true;
        }
      );
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      expect(retrySettled).toBe(false);

      allowFirst();
      await expect(first).resolves.toBe('applied');
      await expect(retry).resolves.toBe('applied');
      await expect(readFile(target, 'utf8')).resolves.toBe('retry');
    }
  );

  it.runIf(process.platform === 'linux')(
    'rejects directory and file symlinks instead of inspecting another home',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agor-credential-boundary-'));
      const callerHome = join(root, 'caller');
      const otherCodexHome = join(root, 'other', '.codex');
      await mkdir(callerHome, { recursive: true });
      await mkdir(otherCodexHome, { recursive: true });
      await writeFile(join(otherCodexHome, 'auth.json'), 'other-user-secret');
      await symlink(otherCodexHome, join(callerHome, '.codex'));

      const directorySymlinkTarget = join(callerHome, '.codex', 'auth.json');
      await expect(readCredentialFile(directorySymlinkTarget)).rejects.toThrow();
      await expect(
        mutateCredentialFile({ target: directorySymlinkTarget, content: 'caller-secret' })
      ).rejects.toThrow();
      await expect(readFile(join(otherCodexHome, 'auth.json'), 'utf8')).resolves.toBe(
        'other-user-secret'
      );

      const realCodexHome = join(root, 'real', '.codex');
      await mkdir(realCodexHome, { recursive: true });
      await symlink(join(otherCodexHome, 'auth.json'), join(realCodexHome, 'auth.json'));
      await expect(readCredentialFile(join(realCodexHome, 'auth.json'))).rejects.toThrow();
    }
  );

  it.runIf(process.platform === 'linux')(
    'tolerates a static symlinked home but still refuses a symlinked credential leaf',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agor-credential-home-alias-'));
      const realHome = join(root, 'real-home');
      const codexHome = join(realHome, '.codex');
      await mkdir(codexHome, { recursive: true });
      await writeFile(join(codexHome, 'auth.json'), 'caller-secret');

      // A static, admin-owned home alias (e.g. /home/<user> ->
      // /var/lib/.../<user>). Reading and binding through it must succeed —
      // the old full-path O_NOFOLLOW walk failed closed here with ENOTDIR.
      const aliasHome = join(root, 'alias-home');
      await symlink(realHome, aliasHome);
      const aliasedAuth = join(aliasHome, '.codex', 'auth.json');
      await expect(readCredentialFile(aliasedAuth)).resolves.toBe('caller-secret');
      const handle = await openCredentialFileForBind(aliasedAuth);
      await handle.close();

      // ...but a symlinked LEAF `.codex` (the sandbox-writable component) is
      // still rejected, preserving the anti-cross-home-symlink guarantee.
      const swappedHome = join(root, 'swapped-home');
      const otherCodex = join(root, 'other', '.codex');
      await mkdir(swappedHome, { recursive: true });
      await mkdir(otherCodex, { recursive: true });
      await writeFile(join(otherCodex, 'auth.json'), 'other-secret');
      await symlink(otherCodex, join(swappedHome, '.codex'));
      await expect(readCredentialFile(join(swappedHome, '.codex', 'auth.json'))).rejects.toThrow();
    }
  );

  it.runIf(process.platform === 'linux')(
    'keeps mutation attached to the opened directory during a path swap',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agor-credential-swap-'));
      const codexHome = join(root, 'caller', '.codex');
      const openedHome = join(root, 'caller', '.codex-opened');
      const otherCodexHome = join(root, 'other', '.codex');
      await mkdir(codexHome, { recursive: true });
      await mkdir(otherCodexHome, { recursive: true });

      await mutateCredentialFile({
        target: join(codexHome, 'auth.json'),
        content: 'caller-secret',
        afterDirectoryOpenForTest: async () => {
          await rename(codexHome, openedHome);
          await symlink(otherCodexHome, codexHome);
        },
      });

      await expect(readFile(join(openedHome, 'auth.json'), 'utf8')).resolves.toBe('caller-secret');
      await expect(readdir(otherCodexHome)).resolves.toEqual([]);
    }
  );

  it.runIf(process.platform === 'linux')(
    'keeps inspection attached to the opened directory during a path swap',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agor-credential-read-swap-'));
      const codexHome = join(root, 'caller', '.codex');
      const openedHome = join(root, 'caller', '.codex-opened');
      const otherCodexHome = join(root, 'other', '.codex');
      await mkdir(codexHome, { recursive: true });
      await mkdir(otherCodexHome, { recursive: true });
      await writeFile(join(codexHome, 'auth.json'), 'caller-secret');
      await writeFile(join(otherCodexHome, 'auth.json'), 'other-user-secret');

      await expect(
        readCredentialFile(join(codexHome, 'auth.json'), {
          afterDirectoryOpenForTest: async () => {
            await rename(codexHome, openedHome);
            await symlink(otherCodexHome, codexHome);
          },
        })
      ).resolves.toBe('caller-secret');
    }
  );
});

import { spawnSync } from 'node:child_process';
