import { chmod, lstat, mkdir } from 'node:fs/promises';

function assertOwned(stat: Awaited<ReturnType<typeof lstat>>, target: string): void {
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Refusing to use ${target}: owned by uid ${stat.uid}, daemon uid is ${uid}`);
  }
}

export async function secureOwnerDirectory(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Refusing to use ${target}: expected a daemon-owned directory`);
    assertOwned(stat, target);
    if ((stat.mode & 0o777) !== 0o700) await chmod(target, 0o700);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(target, { recursive: true, mode: 0o700 });
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Refusing to use ${target}: expected a daemon-owned directory`);
    assertOwned(stat, target);
    await chmod(target, 0o700);
  }
}

export async function secureOwnerFileIfPresent(target: string): Promise<void> {
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Refusing to use ${target}: expected a daemon-owned regular file`);
    assertOwned(stat, target);
    if ((stat.mode & 0o777) !== 0o600) await chmod(target, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function restrictDaemonUmask(): void {
  process.umask(0o077);
}
