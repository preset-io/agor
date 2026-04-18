/**
 * Run As User - Central Unix Command Execution Utility
 *
 * Provides a unified interface for running commands as another Unix user.
 * When impersonation is needed, always uses `sudo -n -u $USER bash -c "..."`
 * to ensure fresh Unix group memberships are loaded.
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
 * Secret-aware classification (`isSecretEnvKey`, `redactSecretEnv`) lives in
 * {@link ./secret-env.js}. On-disk env-file primitives
 * (`writeUserEnvFile`, `prepareImpersonationEnv`, cleanup helpers) live in
 * {@link ./user-env-file.js}.
 *
 * @see context/guides/rbac-and-unix-isolation.md
 */

import { execSync } from 'node:child_process';

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
   * `writeUserEnvFile` + `envFilePath` instead.
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
   * Use `writeUserEnvFile` to produce a path that is owned by the target
   * user with mode 0600.
   *
   * Requires `asUser`: passing `envFilePath` without `asUser` throws, since
   * the env-file is only sourced inside the impersonated shell.
   */
  envFilePath?: string;

  /**
   * Treat `command` as a shell string (like `sh -c`) rather than an argv
   * entry. Affects the impersonated + `envFilePath` code path only — where
   * the default emits `exec "$@"` (argv mode, suitable for `buildSpawnArgs(
   * 'node', ['executor.js'], ...)`) and shell-mode emits `exec bash -c "$CMD"`
   * (suitable for user-authored commands like
   * `docker compose -p $NAME up -d --build` that embed env prefixes, `$(...)`
   * subshells, and argument globbing).
   *
   * Callers of env-command execution must set this to `true`; the executor
   * and zellij paths pass pre-tokenised argv and leave this unset.
   *
   * Default: `false`.
   */
  shell?: boolean;
}

/**
 * Build spawn arguments for running a command as another Unix user
 *
 * Returns command and args array suitable for Node's spawn() or pty.spawn().
 * Use this when you need to spawn a long-running process rather than exec.
 *
 * IMPORTANT: When impersonating (asUser is set), env vars passed to spawn()
 * are ignored because `sudo -u` starts a fresh environment. To pass env vars
 * to the inner command, provide them via the `env` option here — they will
 * be injected using the `env` command prefix — or (for secrets) via
 * `envFilePath`, which keeps values out of argv.
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
  const { asUser, env, envFilePath, shell } = opts;

  // envFilePath only makes sense when impersonating — the env-file is sourced
  // inside the impersonated shell. Fail loudly rather than silently dropping.
  if (envFilePath !== undefined && !asUser) {
    throw new Error(
      'buildSpawnArgs: envFilePath requires asUser (env-file is only sourced inside the impersonated shell)'
    );
  }

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
    // Structural validation only. The path is passed as a positional argv
    // entry and referenced as "$1" inside bash, so shell metachars (spaces,
    // parens, etc.) are safe and we must accept them — e.g. macOS TMPDIR
    // lives under `/var/folders/.../T/` with fine characters but Linux
    // sysadmins sometimes mount a shared TMPDIR with spaces.
    //
    // We reject: relative paths, NUL/newline/control chars (which would
    // break `. "$ENVFILE"` or allow line-splitting tricks).
    if (!envFilePath.startsWith('/')) {
      throw new Error(
        `buildSpawnArgs: envFilePath must be absolute: ${JSON.stringify(envFilePath)}`
      );
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: explicitly rejecting control chars
    if (/[\x00-\x1f\x7f]/.test(envFilePath)) {
      throw new Error(
        `buildSpawnArgs: envFilePath contains control characters: ${JSON.stringify(envFilePath)}`
      );
    }

    if (shell) {
      // Shell-mode: `command` is a user-authored shell string (possibly with
      // env-var prefixes, `$(...)` subshells, `&&` chaining, etc.). Any args
      // are shell-escaped and appended so a caller can optionally pass
      // additional argv tokens.
      //
      // Non-secret env vars are prepended via `env KEY='val' ...` so they
      // reach the process without bypassing the envFilePath secret path.
      let envPrefix = '';
      if (env && Object.keys(env).length > 0) {
        const envEntries = Object.entries(env)
          .map(([key, value]) => `${key}=${escapeShellArg(value)}`)
          .join(' ');
        envPrefix = `env ${envEntries} `;
      }
      const escapedArgs = args.map(escapeShellArg).join(' ');
      const userCommand =
        args.length > 0 ? `${envPrefix}${command} ${escapedArgs}` : `${envPrefix}${command}`;

      // Inner bash script:
      //   $1 = env file path, $2 = shell command (opaque string)
      //   - set -eu: if source fails, abort BEFORE rm+exec so we never
      //     launch the real process with missing secrets
      //   - source env into current shell (set -a auto-exports)
      //   - unlink file before exec so it does not linger on disk
      //   - exec bash -c "$2" — the inner bash parses the user command,
      //     honouring env-var prefixes, `$(...)`, quoting, etc.
      //   - trailing `agor-env` becomes $0 inside the inner shell, making
      //     error messages read `agor-env: line N: …` instead of `--: …`.
      const innerScript =
        'set -eu; ENVFILE="$1"; set -a; . "$ENVFILE"; set +a; rm -f -- "$ENVFILE"; exec bash -c "$2" agor-env';

      return {
        cmd: 'sudo',
        args: ['-n', '-u', asUser, 'bash', '-c', innerScript, '--', envFilePath, userCommand],
      };
    }

    // Argv-mode (default): caller passed pre-tokenised [command, ...args].
    // Used by the executor and zellij paths where the command is a known
    // binary with a known argv shape.
    //
    // Inner bash script:
    //   $1 = env file path, $2... = real command + args
    //   - set -eu: if source fails, abort BEFORE rm+exec so we never
    //     launch the real process with missing secrets
    //   - source env into current shell (set -a auto-exports)
    //   - unlink file before exec so it does not linger on disk
    //   - exec preserves env into the target process
    const innerScript =
      'set -eu; ENVFILE="$1"; shift; set -a; . "$ENVFILE"; set +a; rm -f -- "$ENVFILE"; exec "$@"';

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
