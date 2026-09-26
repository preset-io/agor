/** Reserved ambient credential namespace for trusted operator launcher helpers only. */
export const TRUSTED_LAUNCHER_ENV_PREFIX = 'AGOR_CLOUD_';

/**
 * SECURITY: Allowlisted environment variable names that are safe to pass
 * to user/agent processes. Any variable NOT in this list (or matching a
 * prefix below) will be stripped.
 *
 * This is an allowlist (not a blocklist) so that new sensitive variables
 * added to the daemon environment don't accidentally leak to sessions.
 */
export const ALLOWED_ENV_VARS = new Set([
  // Shell essentials
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',

  // Temp directories
  'TMPDIR',
  'TMP',
  'TEMP',

  // Locale
  'LANG',
  'LANGUAGE',

  // Terminal
  'TERM',
  'COLORTERM',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',

  // Host SSH/GPG agent sockets are intentionally not forwarded. They are
  // credential capabilities, not inert process metadata; projecting the
  // daemon account's socket into a user, sandbox, or delegated executor would
  // let that executor authenticate as the daemon. Users may still configure
  // their own explicit env mapping where the execution substrate provides a
  // user-scoped agent.

  // Logging controls. Keep executor log filtering aligned with the daemon.
  'LOG_LEVEL',

  // Explicit operator-owned Git safety policy. This is resolved from
  // security.git_config_parameters at daemon startup; it is not arbitrary
  // shell context inherited from the account that launched the daemon.
  'GIT_CONFIG_PARAMETERS',

  // Agor session context (safe for executor/sessions)
  'DAEMON_URL',

  // Managed agentic tool runtime. These locate the version-aligned integration
  // tree (~/.agor/agentic-tools/<version>/<tool>) that loadManagedAgenticToolSdk
  // resolves against; they are host runtime metadata, identical for every
  // tenant, and carry no credentials.
  //
  // They must be allowlisted, not merely forwarded: session executors are
  // spawned with `preparedEnv` built by createUserProcessEnvironment(), which
  // takes precedence over spawn-executor's own forwarding. Without them here
  // the executor sees AGOR_MANAGED_AGENTIC_TOOLS unset, falls back to importing
  // the vendor SDK by bare specifier, and every session fails with
  // "Cannot find package '@openai/codex-sdk'".
  'AGOR_VERSION',
  'AGOR_AGENTIC_TOOLS_DIR',
  'AGOR_MANAGED_AGENTIC_TOOLS',
]);

/**
 * Environment variable prefixes that are safe to pass through.
 * Any variable starting with one of these prefixes is allowed.
 */
export const ALLOWED_ENV_PREFIXES = [
  'LC_', // Locale settings (LC_ALL, LC_CTYPE, etc.)
];

/**
 * Check if an environment variable name is allowed to be passed to child processes.
 */
export function isAllowedEnvVar(key: string): boolean {
  if (ALLOWED_ENV_VARS.has(key)) return true;
  for (const prefix of ALLOWED_ENV_PREFIXES) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}
