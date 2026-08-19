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

function probeBwrap(extraArgs: string[]): boolean {
  try {
    const r = spawnSync(
      'bwrap',
      [
        '--unshare-user',
        ...extraArgs,
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

/**
 * BASELINE availability: bwrap can create an unprivileged user + mount namespace
 * and mount a fresh /proc on THIS host. This is the minimum the executor sandbox
 * needs (filesystem isolation). Returns false on any nonzero exit / spawn error.
 */
export function probeBwrapUserns(): boolean {
  return probeBwrap([]);
}

/**
 * ADDITIONAL hardening: can bwrap also create a PID namespace with a fresh
 * /proc? This closes the same-uid `/proc/<pid>/…` route around the fs masks,
 * but many container runtimes block mounting proc in a nested PID namespace
 * ("Operation not permitted") even when user namespaces work. Best-effort: the
 * daemon includes `--unshare-pid` only when this passes, and degrades to a
 * user+mount sandbox otherwise (in a container, the container itself is the
 * isolation boundary).
 */
export function probeBwrapPidNamespace(): boolean {
  return probeBwrap(['--unshare-pid']);
}
