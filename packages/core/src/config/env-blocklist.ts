/**
 * Blocklist of dangerous environment variables that users cannot set.
 *
 * Covers two enforcement points:
 *
 * 1. **Ingest** — when a user or gateway payload tries to save an env var,
 *    `isEnvVarAllowed(name)` rejects names that land on this list.
 * 2. **Runtime** — when an executor or session spawns a child process and
 *    merges env from a caller-controlled map, `filterEnv(env)` strips any
 *    entries whose key is blocked.
 *
 * What we block:
 * - Library injection vectors (LD_*, DYLD_*)
 * - Python / Perl / Ruby interpreter hijacking (PYTHON*, PERL*, RUBY*, GEM_PATH)
 * - Node.js process hijacking (NODE_OPTIONS)
 * - Shell init hijacking (BASH_ENV, ENV)
 * - System identity / command path (PATH, SHELL, HOME, USER, LOGNAME)
 * - Agor encryption secret (AGOR_MASTER_SECRET)
 *
 * Special carve-out: names matching `PYTHON_AGOR_*` are allowed so Agor can
 * surface its own Python-related config without hitting the filter.
 */

/**
 * Exact-match blocklist. Compared case-insensitively via `isEnvVarAllowed`.
 */
export const BLOCKED_ENV_VARS = new Set([
  // Library injection vectors (Unix/Linux)
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_BIND_NOW',

  // Library injection vectors (macOS)
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',

  // Python interpreter hijacking
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONUSERBASE',
  'PYTHONEXECUTABLE',

  // Perl / Ruby
  'PERL5LIB',
  'PERL5OPT',
  'RUBYOPT',
  'RUBYLIB',
  'GEM_PATH',

  // Shell init
  'BASH_ENV',
  'ENV',

  // Node.js process hijacking
  'NODE_OPTIONS',

  // System environment (too dangerous to override)
  'PATH',
  'SHELL',
  'HOME',
  'USER',
  'LOGNAME',

  // Agor security
  'AGOR_MASTER_SECRET',
]);

/**
 * Pattern-based blocklist for wildcard families where any variant is unsafe.
 * `PYTHON_AGOR_*` is carved out so Agor-specific Python config is allowed.
 */
export const BLOCKED_ENV_PATTERNS: readonly RegExp[] = Object.freeze([
  /^LD_/i,
  /^DYLD_/i,
  /^PYTHON(?!_AGOR_)/i,
]);

/**
 * Validate environment variable name against the blocklist.
 *
 * Case-insensitive: `path` and `PATH` both resolve to `false`.
 *
 * @returns `true` if the name is safe to set, `false` if blocked.
 */
export function isEnvVarAllowed(varName: string): boolean {
  const upper = varName.toUpperCase();
  if (BLOCKED_ENV_VARS.has(upper)) return false;
  for (const pattern of BLOCKED_ENV_PATTERNS) {
    if (pattern.test(upper)) return false;
  }
  return true;
}

/**
 * Get human-readable reason why a variable is blocked.
 */
export function getEnvVarBlockReason(varName: string): string | null {
  const upper = varName.toUpperCase();

  if (isEnvVarAllowed(varName)) {
    return null;
  }

  const reasons: Record<string, string> = {
    LD_PRELOAD: 'LD_PRELOAD can be used for library injection attacks',
    LD_LIBRARY_PATH: 'LD_LIBRARY_PATH can hijack system library loading',
    DYLD_INSERT_LIBRARIES: 'DYLD_INSERT_LIBRARIES can be used for library injection attacks',
    DYLD_LIBRARY_PATH: 'DYLD_LIBRARY_PATH can hijack macOS library loading',
    PATH: 'PATH is too dangerous to override - it would break command execution',
    SHELL: 'SHELL selection could break terminal environments',
    HOME: 'HOME directory override could break filesystem operations',
    USER: 'USER context is system-critical and cannot be overridden',
    LOGNAME: 'LOGNAME is a system identifier and cannot be overridden',
    AGOR_MASTER_SECRET: 'AGOR_MASTER_SECRET is reserved for Agor encryption infrastructure',
    NODE_OPTIONS: 'NODE_OPTIONS can force Node to execute arbitrary code via --require',
    BASH_ENV: 'BASH_ENV can run arbitrary shell init when a non-login bash starts',
    ENV: 'ENV can run arbitrary shell init on POSIX shell startup',
  };

  return reasons[upper] || `${upper} can be used to hijack child processes and is blocked`;
}

export interface FilterEnvResult {
  env: Record<string, string>;
  rejected: string[];
}

/**
 * Strip blocked keys from an env map.
 *
 * Returns a new object containing only allowed entries, along with the list
 * of rejected keys (names only — never the values). If `onReject` is supplied
 * it is invoked for each rejected key.
 *
 * This is the right filter to apply at runtime ingress points where a child
 * process is about to receive a caller-controlled env map (e.g. the executor
 * CLI payload, or decrypted user env_vars).
 */
export function filterEnv(
  env: Record<string, string | undefined> | undefined,
  onReject?: (key: string) => void
): FilterEnvResult {
  const out: Record<string, string> = {};
  const rejected: string[] = [];

  if (!env) return { env: out, rejected };

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!isEnvVarAllowed(key)) {
      rejected.push(key);
      onReject?.(key);
      continue;
    }
    out[key] = value;
  }

  return { env: out, rejected };
}
