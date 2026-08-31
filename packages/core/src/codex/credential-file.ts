import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { type FileHandle, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseCodexAuthJson } from './auth-file.js';

const LOCK_WAIT_MS = 10_000;
const FLOCK_EXECUTABLE = '/usr/bin/flock';

interface CredentialDirectory {
  handle: FileHandle;
  path: string;
}

interface CredentialDirectoryTestOptions {
  /** Deterministic race-test seam; production callers must omit. */
  afterDirectoryOpenForTest?: () => Promise<void>;
  /** Deterministic lock-contention test seam; production callers must omit. */
  afterLockAcquiredForTest?: () => Promise<void>;
}

interface CredentialLock {
  release: () => Promise<void>;
}

// Keep this sensitive storage primitive's ambient filesystem authority behind
// seven narrow adapters. Besides making the operations auditable by Agor's
// daemon-filesystem boundary registry, callers cannot accidentally bypass the
// directory-capability path with a one-off fs call.
async function openPath(path: string, flags: string | number, mode?: number): Promise<FileHandle> {
  return open(path, flags, mode);
}

// Resolve a trusted, admin/daemon-owned anchor path to its canonical form,
// following any STATIC symlinks in it (e.g. a root-owned `/home/<user>` ->
// `/var/lib/.../<user>` alias on non-standard hosts). Only ever applied to the
// credential directory's parent home, never to a component a sandboxed actor
// can write; the leaf stays O_NOFOLLOW.
async function resolveCanonicalDirectory(path: string): Promise<string> {
  return realpath(path);
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

function spawnLockAcquirer(lockHandle: FileHandle) {
  return spawn(FLOCK_EXECUTABLE, ['--exclusive', '--wait', String(LOCK_WAIT_MS / 1_000), '3'], {
    stdio: ['ignore', 'ignore', 'ignore', lockHandle.fd],
    detached: false,
    // The helper needs only fd 3. Do not copy database, signing, or
    // application secrets from the daemon.
    env: {},
  });
}

function linuxDirectoryFlags(): number {
  return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

/**
 * Open the credential directory as a race-safe capability. The credential
 * leaf (`.codex`) is opened with `O_NOFOLLOW` relative to its already-open
 * parent, so the final `/proc/self/fd` path stays attached to that inode even
 * if a sandbox process concurrently renames `.codex` and replaces it with a
 * cross-home symlink.
 *
 * The parent home is a distinct trust tier: it and its ancestors are admin- or
 * daemon-owned and not writable by a sandboxed actor, and on non-standard hosts
 * the home may be reached through a STATIC, root-owned symlink alias. We
 * therefore canonicalize the parent (following those static links) and keep
 * `O_NOFOLLOW` strictly for the sandbox-writable leaf, rather than walking the
 * whole path `O_NOFOLLOW` — which would fail closed on a legitimate home alias.
 */
async function openLinuxDirectory(
  rawDirectory: string,
  create: boolean
): Promise<CredentialDirectory> {
  const absolute = resolve(rawDirectory);
  const parent = await resolveCanonicalDirectory(dirname(absolute));
  const leaf = basename(absolute);
  // `parent` is canonical (symlink-free) and its terminal node is not
  // sandbox-renamable, so following it here is safe; the leaf below stays
  // O_NOFOLLOW.
  let current = await openPath(parent, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const child = join('/proc/self/fd', String(current.fd), leaf);
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

async function acquireLinuxLock(directory: CredentialDirectory): Promise<CredentialLock> {
  const lockHandle = await openPath(
    join(directory.path, '.agor-auth-mutation.lock'),
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const metadata = await lockHandle.stat();
    if (!metadata.isFile()) throw new Error('Credential mutation lock is not a regular file');
    await lockHandle.chmod(0o600);
    const child = spawnLockAcquirer(lockHandle);
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveClose, rejectClose) => {
        child.once('error', rejectClose);
        child.once('close', (code, signal) => resolveClose({ code, signal }));
      }
    );
    if (outcome.code !== 0) throw new Error('Credential mutation lock timed out');
  } catch (error) {
    await lockHandle.close().catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      // `flock` applied the lock to the open-file description shared with this
      // descriptor. Retaining it binds lock lifetime directly to the writer;
      // daemon death or this release closes the last local copy.
      await lockHandle.close();
    },
  };
}

async function acquirePortableLock(directory: CredentialDirectory): Promise<CredentialLock> {
  const lockDir = join(directory.path, '.agor-auth-mutation.lock');
  try {
    await createDirectory(lockDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Credential mutation lock is already held');
    }
    throw error;
  }
  return {
    release: async () => removePath(lockDir, true),
  };
}

/**
 * Linux asks a fixed, secret-free `flock` helper to lock the daemon's open-file
 * description, then retains the original descriptor for the mutation. A
 * database disconnect may release PostgreSQL authority while the callback is
 * still alive, but a retry cannot steal this lock. Process or container death
 * closes the descriptor and releases the kernel lock automatically.
 */
async function acquireLock(directory: CredentialDirectory): Promise<CredentialLock> {
  return process.platform === 'linux'
    ? acquireLinuxLock(directory)
    : acquirePortableLock(directory);
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
 * Open one credential file as a stable bind-mount capability.
 *
 * Linux bubblewrap's `--bind-fd` is the mount-side counterpart to this
 * helper: the daemon opens every directory component and the final file with
 * no-follow semantics, validates the resulting inode, then passes that exact
 * descriptor to bubblewrap. A sandbox process may rename or replace the
 * pathname after this function returns, but it cannot change the inode named
 * by the descriptor. This avoids the check-then-`--bind <path>` race that
 * would otherwise let an actor-controlled `auth.json` symlink select an
 * unrelated host file.
 *
 * The caller owns the returned handle and must keep it open through
 * `child_process.spawn()`, then close its parent-side copy.
 */
export async function openCredentialFileForBind(target: string): Promise<FileHandle> {
  if (process.platform !== 'linux') {
    throw new Error('Credential file descriptor binds require Linux');
  }

  const directory = await openCredentialDirectory(target, false);
  try {
    const handle = await openPath(
      join(directory.path, basename(resolve(target))),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) throw new Error('Credential bind source must be a regular file');
      // A second pathname to this inode would let an otherwise hidden file be
      // selected without a symlink. Agor's atomic credential writer always
      // produces a single-link file, so fail closed on unusual manual layouts.
      if (metadata.nlink !== 1) {
        throw new Error('Credential bind source must not have additional hard links');
      }
      return handle;
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
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

    const lock = await acquireLock(directory);
    try {
      await options.afterLockAcquiredForTest?.();
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
      await lock.release();
    }
  } finally {
    await directory.handle.close();
  }
}

export type VerifiedCodexAuthWrite =
  | { outcome: 'stale' }
  | {
      outcome: 'written';
      authMode: 'chatgpt' | 'api_key';
      planType?: string;
      lastRefresh?: string;
    };

/** Shared write/read-back/parse semantics for daemon-local and executor routes. */
export async function writeVerifiedCodexAuthFile(options: {
  target: string;
  content: string;
  generation?: number;
}): Promise<VerifiedCodexAuthWrite> {
  if (!parseCodexAuthJson(options.content).ok) {
    throw new Error('Codex credential content is malformed');
  }
  if ((await mutateCredentialFile(options)) === 'stale') return { outcome: 'stale' };

  let readBack: string;
  try {
    readBack = await readCredentialFile(options.target);
  } catch {
    readBack = await readCredentialFile(options.target);
  }
  if (readBack !== options.content) throw new Error('Codex credential write verification failed');
  const parsed = parseCodexAuthJson(readBack);
  if (!parsed.ok) throw new Error('Codex credential write verification failed');
  return {
    outcome: 'written',
    authMode: parsed.summary.authMode,
    ...(parsed.summary.planType ? { planType: parsed.summary.planType } : {}),
    ...(parsed.summary.lastRefresh ? { lastRefresh: parsed.summary.lastRefresh } : {}),
  };
}
