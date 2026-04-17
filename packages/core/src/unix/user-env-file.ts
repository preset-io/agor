/**
 * On-disk env-file primitive for passing secrets to impersonated processes
 * without putting their values in argv (`/proc/<pid>/cmdline`).
 *
 * Flow:
 * 1. {@link writeUserEnvFile} creates a 0600 file owned by the target user.
 * 2. {@link buildSpawnArgs} (see run-as-user.ts) emits a `bash -c` script
 *    that sources the file, unlinks it, and execs the real command.
 * 3. {@link attachEnvFileCleanup} wires a safety-net unlink on the spawned
 *    child's `error`/`exit` events, using sudo when the file is owned by
 *    a different user.
 *
 * {@link prepareImpersonationEnv} is the high-level helper that composes
 * {@link splitSecretEnv} + {@link writeUserEnvFile} so call sites don't
 * re-implement the split.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { escapeShellArg } from './run-as-user.js';
import { splitSecretEnv } from './secret-env.js';
import { isValidUnixUsername } from './user-manager.js';

/**
 * Default timeout for sudo helper commands (file write, cleanup).
 * 5 seconds matches `run-as-user` — more than enough for a local `cat > file`.
 */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Prefix used for env-file names in the system tempdir. Also used by any
 * future startup sweeper to identify stale files.
 */
const ENV_FILE_PREFIX = 'agor-env-';

/**
 * Write an env file owned by the target Unix user with mode 0600.
 *
 * Strategy: invoke `sudo -n -u <asUser> bash -c '...'` with stdin piped in.
 * The env content is passed via stdin (NOT argv), and the shell creates the
 * file under `umask 077` with `set -C` (noclobber) so pre-existing symlinks
 * or regular files cause a hard failure instead of being followed/truncated.
 *
 * The resulting file:
 * - Is owned by `asUser` (sudo switches uid before any write)
 * - Has mode 0600 (umask 077 applied to default 0666)
 * - Lives at an unpredictable path (16 random bytes = 128 bits of entropy)
 *   in the system tempdir
 * - Is created atomically relative to other files with the same name: if
 *   anything is there first, noclobber causes the shell to exit non-zero
 *
 * Values never appear in argv at any stage.
 *
 * Caller is responsible for ensuring cleanup. The generated spawn command
 * from `buildSpawnArgs` with `envFilePath` will `rm -f` the file inside
 * the impersonated shell before `exec`, so in the normal path the file is
 * gone by the time the real executor starts. As a safety net, callers
 * should still attach {@link attachEnvFileCleanup} on the child process.
 *
 * @param asUser - Target Unix user (must pass isValidUnixUsername)
 * @param env - Env vars to write
 * @returns Absolute path to the created env file
 * @throws if asUser is invalid, or sudo/bash fails (e.g. symlink race)
 */
export function writeUserEnvFile(asUser: string, env: Record<string, string>): string {
  if (!isValidUnixUsername(asUser)) {
    throw new Error(`writeUserEnvFile: invalid Unix username: ${JSON.stringify(asUser)}`);
  }

  // Unpredictable filename — 16 bytes = 128 bits of entropy.
  const nonce = randomBytes(16).toString('hex');
  const envFilePath = join(tmpdir(), `${ENV_FILE_PREFIX}${nonce}`);

  // Serialize env as `KEY='value'` lines, single-quote-escaped so they round-trip
  // through `. "$ENVFILE"`. Keys are already env-var identifiers; reject anything
  // else to avoid injection into the sourced file.
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`writeUserEnvFile: invalid env var name: ${JSON.stringify(key)}`);
    }
    lines.push(`${key}=${escapeShellArg(value)}`);
  }
  const content = `${lines.join('\n')}\n`;

  // Inner script:
  //   - umask 077 so cat > creates 0600
  //   - set -C (noclobber) so existing path (incl. symlink) aborts
  //   - redirect stdin to the target path via cat
  const script = 'umask 077; set -C; cat > "$1"';

  execFileSync('sudo', ['-n', '-u', asUser, 'bash', '-c', script, '--', envFilePath], {
    input: content,
    stdio: ['pipe', 'ignore', 'pipe'],
    timeout: DEFAULT_TIMEOUT_MS,
  });

  return envFilePath;
}

/**
 * Best-effort removal of an env file from the daemon user.
 *
 * Used as a safety net when the daemon owns the file (no impersonation) or
 * when we simply don't know the owner. If the file is owned by a different
 * Unix user and `/tmp` is sticky, this will fail with EPERM — prefer
 * {@link tryUnlinkEnvFileAsUser} when `asUser` is known.
 */
export function tryUnlinkEnvFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort
  }
}

/**
 * Best-effort removal of an env file owned by another Unix user via
 * `sudo -n -u <asUser> rm -f -- <path>`. Used as the safety-net cleanup
 * path when the spawned child fails to launch (inner script's own `rm`
 * never ran) and the file is owned by the impersonated user, where the
 * daemon itself cannot `unlink()` due to sticky-tmp perms.
 *
 * Silently swallows failure.
 */
export function tryUnlinkEnvFileAsUser(asUser: string, path: string): void {
  if (!isValidUnixUsername(asUser)) return;
  if (!isEnvFilePath(path)) return;
  try {
    execFileSync('sudo', ['-n', '-u', asUser, 'rm', '-f', '--', path], {
      stdio: 'ignore',
      timeout: DEFAULT_TIMEOUT_MS,
    });
  } catch {
    // best-effort
  }
}

/**
 * Structural check that a path looks like one of our env-files: absolute,
 * basename starts with `agor-env-`, no NUL/newline/control chars. Guards
 * {@link tryUnlinkEnvFileAsUser} against being weaponized to remove
 * arbitrary files via the daemon-held sudoers grant.
 */
function isEnvFilePath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: we explicitly reject control chars in paths
  if (/[\x00-\x1f\x7f]/.test(path)) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.startsWith(ENV_FILE_PREFIX);
}

/**
 * Minimal subset of `ChildProcess` we touch for cleanup — lets callers pass
 * either a real `ChildProcess` or a mock without pulling in node:child_process.
 */
export interface CleanupTarget {
  once(event: 'error' | 'exit', listener: () => void): unknown;
}

/**
 * Register a safety-net `unlink` on the child's `error`/`exit` events. The
 * inner bash script `rm -f`s the file before `exec` in the normal path, so
 * this only fires when sudo/bash fails to launch at all (or when the source
 * step fails under `set -eu`).
 *
 * Uses sudo when `asUser` is set so it works under sticky `/tmp` where the
 * daemon user cannot unlink files owned by `asUser`.
 */
export function attachEnvFileCleanup(
  child: CleanupTarget,
  options: { envFilePath: string | undefined; asUser?: string }
): void {
  const { envFilePath, asUser } = options;
  if (!envFilePath) return;
  const capturedPath = envFilePath;
  const capturedAsUser = asUser;
  const cleanup = () => {
    if (capturedAsUser) {
      tryUnlinkEnvFileAsUser(capturedAsUser, capturedPath);
    } else {
      tryUnlinkEnvFile(capturedPath);
    }
  };
  child.once('error', cleanup);
  child.once('exit', cleanup);
}

/**
 * Split `env` into secret vs non-secret (see {@link splitSecretEnv}) and,
 * when impersonating, write the secrets to a 0600 env-file owned by
 * `asUser`. Returns the non-secret subset and the env-file path (or
 * `undefined` if no secrets were present).
 *
 * When `asUser` is undefined, no env-file is created — the daemon's own
 * process env is fine since nothing switches uid. Callers should pass the
 * whole `env` through to `spawn()` in that case.
 */
export interface PreparedImpersonationEnv {
  /** Non-secret env to inline into the `sudo bash -c` argv. */
  inlineEnv: Record<string, string>;
  /** Path to 0600 env-file with secrets, or undefined if none. */
  envFilePath: string | undefined;
}

export function prepareImpersonationEnv(options: {
  asUser: string;
  env: Record<string, string | undefined>;
}): PreparedImpersonationEnv {
  const { asUser, env } = options;
  const { secret, inline } = splitSecretEnv(env);
  const envFilePath = Object.keys(secret).length > 0 ? writeUserEnvFile(asUser, secret) : undefined;
  return { inlineEnv: inline, envFilePath };
}
