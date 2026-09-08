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
import { accessSync, closeSync, constants, openSync } from 'node:fs';
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
 * Can this bubblewrap build mount an already-open file descriptor?
 *
 * `--bind-fd` is required for actor-writable credential paths: validating a
 * pathname and later passing it to `--bind` leaves a symlink-swap race. The
 * descriptor form pins the validated inode and bubblewrap verifies that the
 * mounted inode still matches before it starts the sandboxed command.
 *
 * Debian backported this upstream 0.10 feature to its supported 0.8 package,
 * so a functional probe is more accurate than parsing the version string.
 */
export function probeBwrapBindFd(): boolean {
  if (process.platform !== 'linux' || !bwrapOnPath()) return false;
  let sourceFd: number | undefined;
  try {
    sourceFd = openSync('/dev/null', constants.O_RDONLY | constants.O_NOFOLLOW);
    const result = spawnSync(
      'bwrap',
      ['--unshare-user', '--ro-bind', '/', '/', '--ro-bind-fd', '3', '/dev/null', '--', 'true'],
      {
        stdio: ['ignore', 'ignore', 'ignore', sourceFd],
        timeout: 10_000,
      }
    );
    return result.status === 0;
  } catch {
    return false;
  } finally {
    if (sourceFd !== undefined) closeSync(sourceFd);
  }
}

/**
 * Does this bwrap include the sandbox-setup path resolution fix published in
 * 0.12.0 (GHSA-pxhw-h44j-8pfx)?
 *
 * Unlike `--bind-fd`, this cannot be established with a harmless feature
 * probe: the vulnerable and fixed binaries accept the same arguments. Parse
 * the upstream version instead. The fix was intentionally not backported to
 * older releases because it depends on a substantial setup-path rewrite.
 */
export function bwrapHasSafeSetupPathResolution(versionOutput: string): boolean {
  const match = versionOutput.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const [, majorText, minorText] = match;
  const major = Number.parseInt(majorText, 10);
  const minor = Number.parseInt(minorText, 10);
  return major > 0 || (major === 0 && minor >= 12);
}

export function probeBwrapSafeSetupPathResolution(): boolean {
  if (process.platform !== 'linux' || !bwrapOnPath()) return false;
  try {
    const result = spawnSync('bwrap', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return result.status === 0 && bwrapHasSafeSetupPathResolution(result.stdout);
  } catch {
    return false;
  }
}

/** Complete security/feature baseline required by Agor's local sandbox. */
export function probeBwrapSecurityBaseline(): boolean {
  return (
    process.platform === 'linux' &&
    bwrapOnPath() &&
    probeBwrapSafeSetupPathResolution() &&
    probeBwrapUserns() &&
    probeBwrapBindFd()
  );
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
