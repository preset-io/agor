/**
 * Agor state-home creation policy.
 *
 * The home contains deployment configuration, the standalone SQLite database,
 * daemon credentials, and runtime files. Agor-created homes are therefore
 * private to the process identity that initializes the deployment.
 *
 * `getAgorHome()` is the single source of truth for that location, including
 * the `AGOR_HOME` override.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const AGOR_HOME_MODE = 0o700;

/** Environment variable that relocates the Agor state home wholesale. */
export const AGOR_HOME_ENV = 'AGOR_HOME';

/** Expand a leading `~` against the operating-system home directory. */
function expandLeadingTilde(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  if (process.platform === 'win32' && input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

/**
 * Get the Agor state directory.
 *
 * Resolution order:
 * 1. `AGOR_HOME`, when set to a non-blank value.
 * 2. `<os.homedir()>/.agor`.
 *
 * `AGOR_HOME` is surrounding-whitespace-trimmed, `~`-expanded against the
 * operating-system home, and resolved to an absolute path (a relative value
 * resolves against the process working directory). A value that is empty or
 * only whitespace is treated as unset rather than as the filesystem root, so
 * `AGOR_HOME=` in an env file cannot silently redirect Agor's entire state to
 * `/`.
 *
 * This is the single root for Agor-owned state. Every derived path -
 * `config.yaml`, the standalone SQLite database, repos/worktrees, logs,
 * daemon credentials, and runtime files - resolves through this function (or
 * through `getDataHome()`, which falls back to it), so setting `AGOR_HOME`
 * moves all of them together. Resolution is read live from the environment on
 * each call and is never cached.
 */
export function getAgorHome(): string {
  const override = process.env[AGOR_HOME_ENV]?.trim();
  if (override) {
    return path.resolve(expandLeadingTilde(override));
  }
  return path.join(os.homedir(), '.agor');
}

/** Join path segments onto the Agor state home. */
export function agorHomePath(...segments: string[]): string {
  return path.join(getAgorHome(), ...segments);
}

/** Get the operator configuration path (`<agor home>/config.yaml`). */
export function getConfigPath(): string {
  return agorHomePath('config.yaml');
}

function assertOpenedDirectoryMatchesPath(
  homePath: string,
  pathStat: Stats,
  openedStat: Stats
): void {
  if (
    !openedStat.isDirectory() ||
    pathStat.dev !== openedStat.dev ||
    pathStat.ino !== openedStat.ino
  ) {
    throw new Error(`Refusing to secure Agor home because it changed during setup: ${homePath}`);
  }
}

async function enforcePrivateDirectoryMode(homePath: string): Promise<void> {
  const pathStat = await fs.lstat(homePath);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error(`Refusing to secure Agor home because it is not a directory: ${homePath}`);
  }

  // POSIX mode bits are not an effective Windows access-control boundary.
  if (process.platform === 'win32') return;

  // Open without following a replacement symlink, then chmod the opened inode
  // rather than resolving the path again. The inode comparison also catches a
  // directory swap between lstat() and open().
  const handle = await fs.open(
    homePath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const openedStat = await handle.stat();
    assertOpenedDirectoryMatchesPath(homePath, pathStat, openedStat);
    await handle.chmod(AGOR_HOME_MODE);
  } finally {
    await handle.close();
  }
}

function enforcePrivateDirectoryModeSync(homePath: string): void {
  const pathStat = lstatSync(homePath);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error(`Refusing to secure Agor home because it is not a directory: ${homePath}`);
  }

  if (process.platform === 'win32') return;

  const descriptor = openSync(
    homePath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const openedStat = fstatSync(descriptor);
    assertOpenedDirectoryMatchesPath(homePath, pathStat, openedStat);
    fchmodSync(descriptor, AGOR_HOME_MODE);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Ensure an Agor home exists under the managed-private creation policy.
 *
 * Newly created homes are chmodded through an opened directory descriptor so
 * the verified inode ends at exactly 0700 under normal POSIX mode semantics.
 * An unusual umask that removes owner read/execute permission can prevent the
 * descriptor from opening; setup then fails closed rather than using a
 * path-based chmod that could follow a replacement symlink.
 *
 * Existing directories (including symlinked directories) are operator-managed
 * and remain unchanged. Creation alone does not prove that Agor owns a
 * pre-created bind mount, group/ACL directory, or Kubernetes fsGroup volume;
 * changing those paths would be an explicit migration/repair operation.
 */
export async function ensureAgorHome(homePath = getAgorHome()): Promise<void> {
  const createdPath = await fs.mkdir(homePath, { recursive: true, mode: AGOR_HOME_MODE });
  if (createdPath !== undefined) {
    await enforcePrivateDirectoryMode(homePath);
  }
}

/** Synchronous variant for the CLI's detached-daemon file setup. */
export function ensureAgorHomeSync(homePath = getAgorHome()): void {
  const createdPath = mkdirSync(homePath, { recursive: true, mode: AGOR_HOME_MODE });
  if (createdPath !== undefined) {
    enforcePrivateDirectoryModeSync(homePath);
  }
}
