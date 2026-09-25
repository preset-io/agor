import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { probeBwrapBindFd } from '../unix/bwrap';
import { ensureEmptyCredentialMountpoint, openCredentialFileForBind } from './credential-file';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agor-empty-mountpoint-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === 'linux')('empty branch credential mountpoint', () => {
  it('keeps one private empty inode across concurrent creation and repeated preparation', async () => {
    const root = await fixture();
    const target = join(root, 'tenant-a', 'branch', 'codex', 'auth.json');
    const inodes = await Promise.all(
      Array.from({ length: 16 }, async () => {
        await ensureEmptyCredentialMountpoint(target);
        return (await lstat(target)).ino;
      })
    );
    expect(new Set(inodes).size).toBe(1);
    for (let i = 0; i < 3; i++) await ensureEmptyCredentialMountpoint(target);
    const metadata = await lstat(target);
    expect(metadata.ino).toBe(inodes[0]);
    expect(metadata.mode & 0o777).toBe(0o600);
    expect(metadata.nlink).toBe(1);
    expect(await readFile(target, 'utf8')).toBe('');
    expect(await readdir(join(root, 'tenant-a', 'branch', 'codex'))).toEqual(['auth.json']);
  });

  it.each(['symlink', 'hardlink', 'directory', 'fifo', 'nonempty', 'permissions'])(
    'rejects a %s leaf without replacing it or mutating another tenant',
    async (kind) => {
      const root = await fixture();
      const home = join(root, 'tenant-a', 'branch', 'codex');
      const foreign = join(root, 'tenant-b', 'auth.json');
      await mkdir(home, { recursive: true });
      await mkdir(join(root, 'tenant-b'));
      await writeFile(foreign, '', { mode: 0o600 });
      const target = join(home, 'auth.json');
      if (kind === 'symlink') await symlink(foreign, target);
      if (kind === 'hardlink') await link(foreign, target);
      if (kind === 'directory') await mkdir(target);
      if (kind === 'fifo') {
        expect(spawnSync('mkfifo', [target]).status).toBe(0);
      }
      if (kind === 'nonempty') await writeFile(target, 'DUMMY-CORRUPT', { mode: 0o600 });
      if (kind === 'permissions') {
        await writeFile(target, '', { mode: 0o600 });
        await chmod(target, 0o644);
      }
      const before = await lstat(target);
      const foreignBefore = await lstat(foreign);
      await expect(ensureEmptyCredentialMountpoint(target)).rejects.toThrow();
      expect(await lstat(target)).toMatchObject({ ino: before.ino, mode: before.mode });
      expect(await lstat(foreign)).toMatchObject({
        ino: foreignBefore.ino,
        mode: foreignBefore.mode,
        size: 0,
      });
      if (kind === 'nonempty') expect(await readFile(target, 'utf8')).toBe('DUMMY-CORRUPT');
    }
  );

  it('refuses a symlinked parent and pins the directory across a cross-tenant substitution', async () => {
    const root = await fixture();
    const branch = join(root, 'tenant-a', 'branch');
    const home = join(branch, 'codex');
    const saved = join(branch, 'codex-opened');
    const foreign = join(root, 'tenant-b', 'codex');
    await mkdir(home, { recursive: true });
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, 'auth.json'), 'DUMMY-TENANT-B', { mode: 0o600 });
    await ensureEmptyCredentialMountpoint(join(home, 'auth.json'), {
      afterDirectoryOpenForTest: async () => {
        await rename(home, saved);
        await symlink(foreign, home);
      },
    });
    expect(await readFile(join(saved, 'auth.json'), 'utf8')).toBe('');
    await expect(ensureEmptyCredentialMountpoint(join(home, 'auth.json'))).rejects.toThrow();
    expect(await readFile(join(foreign, 'auth.json'), 'utf8')).toBe('DUMMY-TENANT-B');
    expect(await readdir(foreign)).toEqual(['auth.json']);
  });

  it.runIf(probeBwrapBindFd())(
    'real bubblewrap: refuses preparation over a mounted credential without truncating it',
    async () => {
      const root = await fixture();
      const home = join(root, 'branch', 'codex');
      const target = join(home, 'auth.json');
      const source = join(root, 'auth.json');
      await writeFile(source, 'DUMMY-MUST-SURVIVE', { mode: 0o600 });
      await ensureEmptyCredentialMountpoint(target);
      const handle = await openCredentialFileForBind(source);
      try {
        const moduleUrl = new URL('./credential-file.ts', import.meta.url).href;
        const script = `import { ensureEmptyCredentialMountpoint } from ${JSON.stringify(moduleUrl)};
          try { await ensureEmptyCredentialMountpoint(${JSON.stringify(target)}); process.exitCode = 1; }
          catch { process.exitCode = 42; }`;
        const result = spawnSync(
          'bwrap',
          [
            '--unshare-user',
            '--ro-bind',
            '/',
            '/',
            '--bind',
            home,
            home,
            '--bind-fd',
            '3',
            target,
            '--',
            process.execPath,
            '--import',
            createRequire(import.meta.url).resolve('tsx'),
            '--input-type=module',
            '-e',
            script,
          ],
          { stdio: ['ignore', 'pipe', 'pipe', handle.fd], env: {}, timeout: 8000 }
        );
        expect(result.status, result.stderr.toString()).toBe(42);
      } finally {
        await handle.close();
      }
      expect(await readFile(source, 'utf8')).toBe('DUMMY-MUST-SURVIVE');
      expect(await readFile(target, 'utf8')).toBe('');
    }
  );

  it.runIf(probeBwrapBindFd())(
    'real bubblewrap: preserves two caller overlays through repeated and concurrent launch preparation',
    async () => {
      const root = await fixture();
      const home = join(root, 'branch', 'codex');
      const target = join(home, 'auth.json');
      const sourceA = join(root, 'caller-a', 'auth.json');
      const sourceB = join(root, 'caller-b', 'auth.json');
      await mkdir(join(root, 'caller-a'));
      await mkdir(join(root, 'caller-b'));
      await writeFile(sourceA, 'DUMMY-A', { mode: 0o600 });
      await writeFile(sourceB, 'DUMMY-B', { mode: 0o600 });
      await ensureEmptyCredentialMountpoint(target);

      async function launch(source: string) {
        const handle = await openCredentialFileForBind(source);
        const child = spawn(
          'bwrap',
          [
            '--unshare-user',
            '--die-with-parent',
            '--ro-bind',
            '/',
            '/',
            '--bind',
            home,
            home,
            '--bind-fd',
            '3',
            target,
            '--',
            'sh',
            '-c',
            'while read -r command; do if [ "$command" = refresh ]; then printf DUMMY-REFRESHED > "$1"; fi; printf "<%s>\\n" "$(cat "$1")"; done',
            'sh',
            target,
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe', handle.fd],
            env: { PATH: process.env.PATH },
            timeout: 8000,
          }
        );
        const closed = once(child, 'close');
        await handle.close();
        const { stdin, stdout, stderr: stderrStream } = child;
        if (!stdin || !stdout || !stderrStream) {
          child.kill();
          await closed;
          throw new Error('Sandbox test requires piped standard streams');
        }
        const lines = createInterface({ input: stdout });
        const iterator = lines[Symbol.asyncIterator]();
        let stderr = '';
        stderrStream.on('data', (data) => {
          stderr += data.toString();
        });
        return {
          read: async (command = 'read') => {
            stdin.write(`${command}\n`);
            const line = await iterator.next();
            expect(line.done, stderr).toBe(false);
            return line.value;
          },
          close: async () => {
            stdin.end();
            await closed;
            lines.close();
          },
        };
      }

      const a = await launch(sourceA);
      let b: Awaited<ReturnType<typeof launch>> | undefined;
      try {
        expect(await a.read()).toBe('<DUMMY-A>');
        await ensureEmptyCredentialMountpoint(target);
        b = await launch(sourceB);
        expect(await b.read()).toBe('<DUMMY-B>');
        // The former atomic rename detaches A's existing destination mount.
        expect(await a.read()).toBe('<DUMMY-A>');
        await Promise.all(
          Array.from({ length: 12 }, () => ensureEmptyCredentialMountpoint(target))
        );
        expect(await a.read()).toBe('<DUMMY-A>');
        expect(await b.read()).toBe('<DUMMY-B>');
        expect(await a.read('refresh')).toBe('<DUMMY-REFRESHED>');
        expect(await readFile(sourceA, 'utf8')).toBe('DUMMY-REFRESHED');
        expect(await readFile(sourceB, 'utf8')).toBe('DUMMY-B');
        expect(await readFile(target, 'utf8')).toBe('');
      } finally {
        await Promise.all([a.close(), b?.close()]);
      }
    }
  );
});
