/**
 * bubblewrap capability probes, shared by the daemon (executor sandbox wrap)
 * and the CLI (`agor doctor`). ONE implementation so the two never drift on
 * what "sandbox is available" means.
 *
 * Presence on PATH is necessary but NOT sufficient: bwrap can be installed yet
 * unable to create an unprivileged user namespace (hardened kernels — Ubuntu
 * 24.04 AppArmor `apparmor_restrict_unprivileged_userns`,
 * `kernel.unprivileged_userns_clone=0`, some container runtimes). The daemon
 * must fail/degrade on the FUNCTIONAL result, not on PATH alone.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

/** Is an executable named `bwrap` resolvable + executable on PATH? (no subprocess) */
export function bwrapOnPath(pathEnv = process.env.PATH ?? ''): boolean {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, 'bwrap'), constants.X_OK);
      return true;
    } catch {
      // not here / not executable — keep scanning
    }
  }
  return false;
}

/**
 * Functionally probe that bwrap can actually create an unprivileged user +
 * mount namespace on THIS host. Runs a trivial `bwrap … -- true`. Returns false
 * on any nonzero exit / spawn error.
 */
export function probeBwrapUserns(): boolean {
  try {
    // Probe exactly what the executor sandbox uses (user + PID namespace +
    // proc), so an installed-but-restricted host is detected up front.
    const r = spawnSync(
      'bwrap',
      [
        '--unshare-user',
        '--unshare-pid',
        '--ro-bind',
        '/',
        '/',
        '--dev',
        '/dev',
        '--proc',
        '/proc',
        '--',
        'true',
      ],
      { stdio: 'ignore', timeout: 10_000 }
    );
    return r.status === 0;
  } catch {
    return false;
  }
}
