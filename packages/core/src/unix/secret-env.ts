/**
 * Secret-aware env classification and redaction.
 *
 * Pure logic — no I/O. Lives here (not in run-as-user.ts) so it can be
 * imported by log-hygiene paths without pulling in spawn/exec concerns.
 */

/**
 * Regex matching env var NAMES that are expected to hold secrets.
 *
 * Used by callers to decide whether to route a given env var through an
 * on-disk env file (keeps value out of argv/logs) vs inlining it into the
 * impersonated shell command. Also used by {@link redactSecretEnv} for log
 * hygiene.
 *
 * Intentionally broad: a false positive merely routes a non-secret through
 * the env-file path (no functional change, child still sees the var). A
 * false negative would leak the value into argv.
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
 * Partition an env map into secret vs non-secret ("inline") entries.
 *
 * Callers route `secret` through {@link import('./user-env-file.js').writeUserEnvFile}
 * and pass `inline` through the legacy `env <K>='<V>'` argv path.
 *
 * Undefined values are dropped.
 */
export function splitSecretEnv(env: Record<string, string | undefined>): {
  secret: Record<string, string>;
  inline: Record<string, string>;
} {
  const secret: Record<string, string> = {};
  const inline: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isSecretEnvKey(key)) {
      secret[key] = value;
    } else {
      inline[key] = value;
    }
  }
  return { secret, inline };
}
