/**
 * Run As User - Central Unix Command Execution Utility
 *
 * Provides a unified interface for running commands as another Unix user.
 * When impersonation is needed, always uses `sudo -u $USER bash -c "..."` to ensure
 * fresh Unix group memberships are loaded.
 *
 * HOW `sudo -u` PROVIDES FRESH GROUP MEMBERSHIPS:
 * When sudo switches users (via -u), it calls the initgroups() syscall which reads
 * /etc/group at that moment, giving the target user fresh group memberships.
 * This is different from the caller's cached groups - each sudo -u invocation
 * gets a fresh read from /etc/group.
 *
 * We use `bash -c` to execute the command to ensure proper environment setup
 * and command parsing. This works with the sudoers configuration line:
 * `agorpg ALL=(%agor_users) NOPASSWD: ALL`
 *
 * SECURITY NOTE: We use `sudo -u` instead of `sudo su` to avoid needing to
 * whitelist the /usr/bin/su binary in sudoers, which would be a security risk.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { execFileSync, execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isValidUnixUsername } from './user-manager.js';

/**
 * Default timeout for commands in milliseconds
 * 5 seconds is enough for most commands - prevents daemon from freezing if something hangs
 */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Escape a string for safe use in a shell command
 *
 * Uses single-quote escaping which is the safest approach:
 * - Wraps string in single quotes
 * - Escapes any single quotes within the string
 *
 * Example: "hello'world" becomes "'hello'\''world'"
 */
export function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * Options for runAsUser
 */
export interface RunAsUserOptions {
  /** Unix user to run command as. If undefined, runs as current user */
  asUser?: string;

  /** Timeout in milliseconds (default: 5000) */
  timeout?: number;

  /** Encoding for output (default: 'utf-8') */
  encoding?: BufferEncoding;
}

/**
 * Run a shell command, optionally as another Unix user
 *
 * When asUser is specified, runs via `sudo -n -u $USER bash -c "..."` to:
 * - Get fresh Unix group memberships (sudo calls initgroups())
 * - Prevent password prompts (-n flag)
 * - Have proper timeout handling
 *
 * @param command - Shell command to run
 * @param options - Execution options
 * @returns Command stdout
 * @throws Error if command fails or times out
 *
 * @example
 * ```ts
 * // Run as current user
 * runAsUser('whoami');
 *
 * // Run as another user with fresh groups
 * runAsUser('git status', { asUser: 'alice' });
 *
 * // Custom timeout
 * runAsUser('long-command', { timeout: 30000 });
 * ```
 */
export function runAsUser(command: string, options: RunAsUserOptions = {}): string {
  const { asUser, timeout = DEFAULT_TIMEOUT_MS, encoding = 'utf-8' } = options;

  let fullCommand: string;

  if (asUser) {
    // Impersonate: use sudo -u for fresh group memberships
    // -n prevents password prompts (requires passwordless sudo configured)
    // sudo -u calls initgroups() to get fresh group memberships from /etc/group
    const escapedCommand = escapeShellArg(command);
    fullCommand = `sudo -n -u ${asUser} bash -c ${escapedCommand}`;
  } else {
    // No impersonation: run directly
    fullCommand = command;
  }

  return execSync(fullCommand, {
    encoding,
    stdio: 'pipe',
    timeout,
  });
}

/**
 * Check if a command succeeds, optionally as another user
 *
 * @param command - Shell command to check
 * @param options - Execution options
 * @returns true if command exits with code 0
 */
export function checkAsUser(command: string, options: RunAsUserOptions = {}): boolean {
  try {
    runAsUser(command, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Options for buildSpawnArgs
 */
export interface BuildSpawnArgsOptions {
  /** Unix user to run as. If undefined, runs as current user */
  asUser?: string;

  /**
   * Environment variables to pass to the inner command.
   *
   * When NOT impersonating, these env vars should be passed to spawn() directly
   * via the `env` option (this function doesn't modify them).
   *
   * When impersonating (asUser is set) AND `envFilePath` is not set, env vars
   * are inlined into the inner command via the `env` prefix. This path is
   * retained for non-secret env (e.g., TERM, PATH, DAEMON_URL) and tests.
   *
   * WARNING: values passed this way end up in the process's argv and are
   * visible via `ps`, `/proc/<pid>/cmdline`, audit logs, etc. Never pass
   * secrets (API keys, tokens) via `env` alone when impersonating — use
   * {@link writeUserEnvFile} + `envFilePath` instead.
   */
  env?: Record<string, string>;

  /**
   * Path to an on-disk env file to source before `exec`ing the inner command.
   *
   * When set together with `asUser`, the generated command sources this file
   * inside the impersonated shell, then removes it, then `exec`s the real
   * command. The env values never appear in argv. The path itself is in argv
   * but it is not secret.
   *
   * Use {@link writeUserEnvFile} to produce a path that is owned by the
   * target user with mode 0600.
   */
  envFilePath?: string;
}

/**
 * Build spawn arguments for running a command as another Unix user
 *
 * Returns command and args array suitable for Node's spawn() or pty.spawn().
 * Use this when you need to spawn a long-running process rather than exec.
 *
 * IMPORTANT: When impersonating (asUser is set), env vars passed to spawn()
 * are ignored because `sudo su -` creates a fresh login shell. To pass env vars
 * to the inner command, provide them via the `env` option here - they will be
 * injected using the `env` command prefix.
 *
 * @param command - Command to run (e.g., 'zellij')
 * @param args - Arguments to pass to the command
 * @param options - Options including asUser and env
 * @returns Object with cmd and args for spawn()
 *
 * @example
 * ```ts
 * // Spawn zellij as another user with env vars
 * const { cmd, args } = buildSpawnArgs('zellij', ['attach', 'session1'], {
 *   asUser: 'alice',
 *   env: { GITHUB_TOKEN: 'xxx', TERM: 'xterm-256color' }
 * });
 * // Inner command: env GITHUB_TOKEN='xxx' TERM='xterm-256color' zellij 'attach' 'session1'
 * pty.spawn(cmd, args, { cwd });
 *
 * // No impersonation - env should be passed to spawn() directly
 * const { cmd, args } = buildSpawnArgs('zellij', ['attach', 'session1']);
 * spawn(cmd, args, { env: myEnv });
 * ```
 */
export function buildSpawnArgs(
  command: string,
  args: string[] = [],
  options?: BuildSpawnArgsOptions | string // string for backward compat (asUser)
): { cmd: string; args: string[] } {
  // Handle backward compatibility: options can be a string (asUser) or object
  const opts: BuildSpawnArgsOptions =
    typeof options === 'string' ? { asUser: options } : (options ?? {});
  const { asUser, env, envFilePath } = opts;

  if (!asUser) {
    // No impersonation: return command/args as-is
    // Caller should pass env to spawn() directly
    return { cmd: command, args };
  }

  // Defence-in-depth: validate asUser format before it is used as an argv
  // token to `sudo -u`. `isValidUnixUsername` rejects anything outside
  // [a-z_][a-z0-9_-]{0,31} so it cannot be a shell metachar or a flag.
  if (!isValidUnixUsername(asUser)) {
    throw new Error(`buildSpawnArgs: invalid Unix username: ${JSON.stringify(asUser)}`);
  }

  // Prefer env-file sourcing: secrets stay out of argv entirely.
  if (envFilePath) {
    // Validate envFilePath too — it ends up in argv. It must not contain shell
    // metachars or newlines; a tempfile path will not.
    if (!/^[\w@%+=:,./-]+$/.test(envFilePath)) {
      throw new Error(`buildSpawnArgs: suspicious envFilePath: ${JSON.stringify(envFilePath)}`);
    }

    // Inner bash script:
    //   $1 = env file path, $2... = real command + args
    //   - source env into current shell
    //   - unlink file (best effort) before exec so it does not linger on disk
    //   - exec preserves env into the target process
    const innerScript =
      'ENVFILE="$1"; shift; set -a; . "$ENVFILE"; set +a; rm -f "$ENVFILE"; exec "$@"';

    return {
      cmd: 'sudo',
      args: ['-n', '-u', asUser, 'bash', '-c', innerScript, '--', envFilePath, command, ...args],
    };
  }

  // Legacy/non-secret path: inline env vars into argv.
  // Build env prefix if env vars provided
  // Format: env VAR1='val1' VAR2='val2' ...
  let envPrefix = '';
  if (env && Object.keys(env).length > 0) {
    const envEntries = Object.entries(env)
      .map(([key, value]) => `${key}=${escapeShellArg(value)}`)
      .join(' ');
    envPrefix = `env ${envEntries} `;
  }

  // Build the inner command string with escaped args
  const escapedArgs = args.map(escapeShellArg).join(' ');
  const innerCommand =
    args.length > 0 ? `${envPrefix}${command} ${escapedArgs}` : `${envPrefix}${command}`;

  // Impersonate: wrap with sudo -u and bash -c
  // -n prevents password prompts
  // bash -c ensures env vars and command are properly executed
  // sudo -u calls initgroups() to get fresh group memberships from /etc/group
  return {
    cmd: 'sudo',
    args: ['-n', '-u', asUser, 'bash', '-c', innerCommand],
  };
}

/**
 * Regex matching env var NAMES that are expected to hold secrets.
 *
 * Used by callers to decide whether to route a given env var through
 * {@link writeUserEnvFile} (keeps value out of argv/logs) vs inlining it
 * in the command. Also used by {@link redactSecretEnv} for log hygiene.
 */
export const SECRET_ENV_KEY_PATTERN = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD|_KEY)$|^OAUTH_/i;

/**
 * Returns true if an env var name matches a well-known secret pattern.
 */
export function isSecretEnvKey(name: string): boolean {
  return SECRET_ENV_KEY_PATTERN.test(name);
}

/**
 * Redact an env map for logging. Secret keys (per {@link isSecretEnvKey})
 * have their values replaced with `"***"` and their key is preserved only
 * if `keepKeys` is true. Default drops the key entirely so we never log
 * e.g. `ANTHROPIC_API_KEY` at all.
 */
export function redactSecretEnv(
  env: Record<string, string | undefined>,
  options: { keepKeys?: boolean } = {}
): Record<string, string> {
  const { keepKeys = false } = options;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isSecretEnvKey(key)) {
      if (keepKeys) out[key] = '***';
      continue;
    }
    out[key] = value;
  }
  return out;
}

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
 * - Lives at an unpredictable path (16 random bytes) in the system tempdir
 * - Is created atomically relative to other files with the same name: if
 *   anything is there first, noclobber causes the shell to exit non-zero
 *
 * Caller is responsible for ensuring cleanup. The generated spawn command
 * from {@link buildSpawnArgs} with `envFilePath` will `rm -f` the file
 * inside the impersonated shell before `exec`, so in the normal path the
 * file is gone by the time the real executor starts. As a safety net,
 * callers should still attempt `unlinkSync` (or equivalent) from an
 * `exit`/`error` handler.
 *
 * Values never appear in argv at any stage.
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
  const envFilePath = join(tmpdir(), `agor-env-${nonce}`);

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
 * Best-effort removal of an env file. Swallows ENOENT since the normal spawn
 * path `rm -f`s the file inside the impersonated shell before it execs.
 *
 * Note: if the file is owned by another user, `unlinkSync` from the daemon
 * will fail with EPERM. That is acceptable — the file is 0600 and unreadable
 * by the daemon anyway, and `/tmp` cleanup will reap it.
 */
export function tryUnlinkEnvFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort; see doc above
  }
}
