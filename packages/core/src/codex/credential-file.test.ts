import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeBwrapBindFd } from '../unix/bwrap';
import {
  mutateCredentialFile,
  openCredentialFileForBind,
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
