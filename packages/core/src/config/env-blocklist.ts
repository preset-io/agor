/**
 * Structural validation for explicitly configured environment mappings.
 *
 * Source policy lives elsewhere: the daemon's own process environment uses a
 * small allowlist, while a user's stored mapping is intentionally passed
 * through to that user's executor. A semantic deny-list here would not be a
 * security boundary—the same user can export those names from a terminal—and
 * made the settings surface disagree with the runtime it represents.
 */

/** Portable name syntax used by managed settings and process boundaries. */
export const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** Per-value runtime limit, shared with persistence validation. */
export const MAX_ENV_VAR_VALUE_BYTES = 10 * 1024;

/** @deprecated User-configured names are not semantically blocklisted. */
export const BLOCKED_ENV_VARS = new Set<string>();

/** @deprecated User-configured names are not semantically blocklisted. */
export const BLOCKED_ENV_PATTERNS: readonly RegExp[] = Object.freeze([]);

/** Compatibility helper: a name is allowed when it is structurally valid. */
export function isEnvVarAllowed(varName: string): boolean {
  return ENV_VAR_NAME_PATTERN.test(varName);
}

/** Compatibility helper for older validation/UI call sites. */
export function getEnvVarBlockReason(varName: string): string | null {
  return isEnvVarAllowed(varName)
    ? null
    : `Variable name must match ${ENV_VAR_NAME_PATTERN.source}`;
}

export interface FilterEnvResult {
  env: Record<string, string>;
  rejected: string[];
}

/**
 * Enforce only process-map safety at the last boundary.
 *
 * This rejects malformed names, NULs, and legacy/imported oversized values.
 * It deliberately does not second-guess the behavior of explicitly configured
 * names such as PATH, NODE_OPTIONS, or LD_PRELOAD.
 */
export function filterEnv(
  env: Record<string, string | undefined> | undefined,
  onReject?: (key: string) => void
): FilterEnvResult {
  const out: Record<string, string> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) continue;
    if (
      !ENV_VAR_NAME_PATTERN.test(key) ||
      value.includes('\0') ||
      Buffer.byteLength(value, 'utf8') > MAX_ENV_VAR_VALUE_BYTES
    ) {
      rejected.push(key);
      onReject?.(key);
      continue;
    }
    out[key] = value;
  }

  return { env: out, rejected };
}
