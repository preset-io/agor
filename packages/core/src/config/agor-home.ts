/**
 * Agor state-home creation policy.
 *
 * The default home contains deployment configuration, the standalone SQLite
 * database, daemon credentials, and runtime files. Agor-created homes are
 * therefore private to the process identity that initializes the deployment.
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

/** Get the default Agor state directory (`~/.agor`). */
export function getAgorHome(): string {
  return path.join(os.homedir(), '.agor');
}

/** Get the default operator configuration path (`~/.agor/config.yaml`). */
export function getConfigPath(): string {
  return path.join(getAgorHome(), 'config.yaml');
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
