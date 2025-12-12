/**
 * Run As User - Central Unix Command Execution Utility
 *
 * Provides a unified interface for running commands as another Unix user.
 * When impersonation is needed, always uses `sudo su - $USER -c "..."` to ensure
 * fresh Unix group memberships are loaded.
 *
 * WHY `sudo su -` INSTEAD OF `sudo -u`:
 * Unix groups are cached at login time. If a user is added to a group after a process
 * starts (e.g., daemon added to a newly-created worktree group), `sudo -u` preserves
 * the caller's cached groups. Only `sudo su -` creates a fresh login shell that
 * re-reads /etc/group.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { execSync } from 'node:child_process';

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
 * When asUser is specified, runs via `sudo -n su - $USER -c "..."` to:
 * - Get fresh Unix group memberships (login shell)
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
    // Impersonate: use sudo su - for fresh group memberships
    // -n prevents password prompts (requires passwordless sudo configured)
    const escapedCommand = escapeShellArg(command);
    fullCommand = `sudo -n su - ${asUser} -c ${escapedCommand}`;
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
   * When impersonating (asUser is set), these env vars are injected into the
   * inner command using the `env` command prefix. This is necessary because
   * `sudo su -` creates a fresh login shell that ignores the env passed to spawn().
   *
   * When NOT impersonating, these env vars should be passed to spawn() directly
   * via the `env` option (this function doesn't modify them).
   */
  env?: Record<string, string>;
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
  const { asUser, env } = opts;

  if (!asUser) {
    // No impersonation: return command/args as-is
    // Caller should pass env to spawn() directly
    return { cmd: command, args };
  }

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

  // Impersonate: wrap with sudo su -
  // -n prevents password prompts
  return {
    cmd: 'sudo',
    args: ['-n', 'su', '-', asUser, '-c', innerCommand],
  };
}
