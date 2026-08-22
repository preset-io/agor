import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve, sep } from 'node:path';

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

interface CredentialDirectory {
  handle: FileHandle;
  path: string;
}

interface CredentialDirectoryTestOptions {
  /** Deterministic race-test seam; production callers must omit. */
  afterDirectoryOpenForTest?: () => Promise<void>;
}

// Keep this sensitive storage primitive's ambient filesystem authority behind
// five narrow adapters. Besides making the operations auditable by Agor's
// daemon-filesystem boundary registry, callers cannot accidentally bypass the
// directory-capability path with a one-off fs call.
async function openPath(path: string, flags: string | number, mode?: number): Promise<FileHandle> {
  return open(path, flags, mode);
}

async function createDirectory(
  path: string,
  options: { mode?: number; recursive?: boolean } = {}
): Promise<void> {
  await mkdir(path, options);
}

async function inspectLink(path: string) {
  return lstat(path);
}

async function replacePath(from: string, to: string): Promise<void> {
  await rename(from, to);
}

async function removePath(path: string, recursive = false): Promise<void> {
  await rm(path, { recursive, force: true });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function linuxDirectoryFlags(): number {
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

/**
 * Open each directory component relative to its already-open parent. The final
 * `/proc/self/fd` path stays attached to that inode even if a sandbox process
 * concurrently renames `.codex` and replaces it with a cross-home symlink.
 */
async function openLinuxDirectory(
  rawDirectory: string,
  create: boolean
): Promise<CredentialDirectory> {
  const absolute = resolve(rawDirectory);
  const root = parse(absolute).root;
  let current = await openPath(root, linuxDirectoryFlags());
  try {
    for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
      const child = join('/proc/self/fd', String(current.fd), component);
      if (create) {
        try {
          await createDirectory(child, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      const next = await openPath(child, linuxDirectoryFlags());
      await current.close();
      current = next;
    }
    if (create) await current.chmod(0o700);
    return { handle: current, path: `/proc/self/fd/${current.fd}` };
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Standalone macOS/Windows fallback. HA sandbox mode is Linux-only and always
 * uses the race-safe capability path above; this preserves local single-user
 * auth-file support on other platforms while still rejecting a static symlink.
 */
async function openPortableDirectory(
  rawDirectory: string,
  create: boolean
): Promise<CredentialDirectory> {
  const directory = resolve(rawDirectory);
  if (create) await createDirectory(directory, { recursive: true, mode: 0o700 });
  const metadata = await inspectLink(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('Credential directory must be a real directory');
  }
  const handle = await openPath(directory, 'r');
  if (create) await handle.chmod(0o700);
  return { handle, path: directory };
}

async function openCredentialDirectory(target: string, create: boolean) {
  const directory = dirname(resolve(target));
  return process.platform === 'linux'
    ? openLinuxDirectory(directory, create)
    : openPortableDirectory(directory, create);
}

async function syncDirectory(directory: CredentialDirectory): Promise<void> {
  try {
    await directory.handle.sync();
  } catch {
    // Some local filesystems cannot fsync directories. Files are still fsynced
    // before rename; Linux production paths exercise the durable arm.
  }
}

async function readNoFollow(path: string): Promise<string> {
  const flags =
    process.platform === 'linux' ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDONLY;
  const handle = await openPath(path, flags);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function atomicWrite(
  directory: CredentialDirectory,
  name: string,
  content: string,
  mode: number
): Promise<void> {
  const target = join(directory.path, name);
  const temporary = join(directory.path, `.${name}.${randomBytes(6).toString('hex')}`);
  const handle = await openPath(temporary, 'wx', mode);
  try {
    try {
      await handle.writeFile(content, 'utf8');
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replacePath(temporary, target);
    await syncDirectory(directory);
  } finally {
    await removePath(temporary);
  }
}

async function acquireLock(lockDir: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      await createDirectory(lockDir, { mode: 0o700 });
      return async () => removePath(lockDir, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const lock = await inspectLink(lockDir);
        if (!lock.isDirectory() || lock.isSymbolicLink()) {
          throw new Error('Credential mutation lock is not a directory');
        }
        if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) {
          await removePath(lockDir, true);
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Credential mutation lock timed out');
      await sleep(25);
    }
  }
}

async function currentGeneration(path: string): Promise<number> {
  try {
    const value = Number.parseInt(await readNoFollow(path), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

/** Read one credential file without following its directory or file symlinks. */
export async function readCredentialFile(
  target: string,
  testOptions: CredentialDirectoryTestOptions = {}
): Promise<string> {
  const directory = await openCredentialDirectory(target, false);
  try {
    await testOptions.afterDirectoryOpenForTest?.();
    return await readNoFollow(join(directory.path, basename(resolve(target))));
  } finally {
    await directory.handle.close();
  }
}

/**
 * Atomic credential mutation with a per-home generation fence. Linux callers
 * mutate through an opened directory capability, so path replacement cannot
 * redirect a daemon/helper into another user's home.
 */
export async function mutateCredentialFile(
  options: {
    target: string;
    content?: string;
    generation?: number;
  } & CredentialDirectoryTestOptions
): Promise<'applied' | 'stale'> {
  const directory = await openCredentialDirectory(options.target, true);
  const targetName = basename(resolve(options.target));
  const target = join(directory.path, targetName);
  try {
    await options.afterDirectoryOpenForTest?.();
    if (options.generation === undefined) {
      if (options.content === undefined) await removePath(target);
      else await atomicWrite(directory, targetName, options.content, 0o600);
      return 'applied';
    }
    if (!Number.isSafeInteger(options.generation) || options.generation <= 0) {
      throw new Error('Credential mutation generation is invalid');
    }

    const release = await acquireLock(join(directory.path, '.agor-auth-mutation.lock'));
    try {
      const generationPath = join(directory.path, '.agor-auth-generation');
      if (options.generation < (await currentGeneration(generationPath))) return 'stale';
      await atomicWrite(directory, '.agor-auth-generation', `${options.generation}\n`, 0o600);
      if (options.content === undefined) {
        await removePath(target);
        await syncDirectory(directory);
      } else {
        await atomicWrite(directory, targetName, options.content, 0o600);
      }
      return 'applied';
    } finally {
      await release();
    }
  } finally {
    await directory.handle.close();
  }
}
