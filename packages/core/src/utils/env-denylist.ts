/**
 * Environment variable denylist for subprocess spawns.
 *
 * A number of env vars interpreted by common runtimes can be used to hijack
 * a child process: load arbitrary native libraries (LD_PRELOAD, DYLD_*),
 * force Node to require arbitrary files at startup (NODE_OPTIONS=--require),
 * force Python to execute files at interpreter startup (PYTHONSTARTUP,
 * PYTHONPATH pointed at a sitecustomize), etc.
 *
 * When an executor or daemon spawns a child process and accepts env vars
 * from a payload, a caller-controlled env map, or a user config, the values
 * MUST be filtered through `filterEnv()` before being applied.
 *
 * Defence-in-depth: applied on both the daemon side (before spawning the
 * executor) and the executor side (before applying payload env to
 * `process.env`). A tight allowlist would be safer still, but would break
 * user env-var functionality; a denylist is the right first step.
 */

/**
 * Explicit exact-match denylist.
 *
 * These are called out individually (rather than relying solely on the
 * pattern-based check) so the intent is auditable and typos in the patterns
 * cannot weaken coverage.
 */
export const ENV_DENY_EXACT: readonly string[] = Object.freeze([
  // Node.js process hijacking
  'NODE_OPTIONS',
  'NODE_EXTRA_CA_CERTS',

  // glibc / Linux dynamic loader
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'LD_BIND_NOW',

  // macOS dynamic loader (dyld) — well-known exact names
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

  // Shell init hijacking
  'BASH_ENV',
  'ENV',

  // We set PATH ourselves — reject any caller override
  'PATH',
]);

/**
 * Pattern-based denylist, for wildcard families that are not safe to accept
 * any variant of. Special carve-out: `PYTHON_AGOR_*` is allowed so Agor can
 * surface its own Python-related config without hitting the filter.
 */
export const ENV_DENY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^LD_/,
  /^DYLD_/,
  /^PYTHON(?!_AGOR_)/,
]);

/**
 * True if the env var key is denied.
 */
export function isDeniedEnvKey(key: string): boolean {
  if (ENV_DENY_EXACT.includes(key)) return true;
  for (const pattern of ENV_DENY_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

export interface FilterEnvResult {
  env: Record<string, string>;
  rejected: string[];
}

/**
 * Strip denied keys from an env map.
 *
 * Returns a new object containing only allowed entries, along with the list
 * of rejected keys (so callers can log the names — never the values). If
 * `onReject` is supplied it is invoked for each rejected key.
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
    if (isDeniedEnvKey(key)) {
      rejected.push(key);
      onReject?.(key);
      continue;
    }
    out[key] = value;
  }

  return { env: out, rejected };
}
