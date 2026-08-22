import { mkdir, mkdtemp, readdir, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mutateCredentialFile, readCredentialFile } from './credential-file';

describe('credential file directory capability', () => {
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
