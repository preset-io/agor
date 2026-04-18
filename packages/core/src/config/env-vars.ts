/**
 * Env var storage helpers (v0.5 env-var-access).
 *
 * Users' env vars live as a JSON map on `users.data.env_vars`. Values come in
 * two historical shapes:
 *   - Legacy (pre-v0.5): `"GITHUB_TOKEN": "enc:..."` — plain encrypted string,
 *     implicitly global-scope.
 *   - v0.5+: `"GITHUB_TOKEN": { value_encrypted, scope, resource_id?, extra_config? }`.
 *
 * Reads normalize both into the object shape; writes always produce the object
 * shape. Scope values are validated in this layer (no SQL CHECK constraint)
 * so future scope values can ship without a schema migration.
 *
 * See `context/explorations/env-var-access.md`.
 */

import type { EnvVarScope } from '../types/user';

/** Persisted shape inside `users.data.env_vars`. */
export interface StoredEnvVar {
  value_encrypted: string;
  scope: EnvVarScope;
  resource_id?: string | null;
  extra_config?: Record<string, unknown> | null;
}

/** Raw shape as it may appear on disk (for backward compatibility). */
export type RawStoredEnvVar = string | StoredEnvVar;

/**
 * Validated scope values for v0.5. Other values ('repo', 'mcp_server',
 * 'artifact_feature', 'executor') are reserved in the type but rejected by
 * writes until v1 wires them up.
 */
export const V05_SCOPES: readonly EnvVarScope[] = ['global', 'session'] as const;
const V05_SCOPE_SET = new Set<EnvVarScope>(V05_SCOPES);

/**
 * Is this a valid, currently-usable scope? (v0.5: global|session)
 */
export function isValidV05Scope(scope: string): scope is EnvVarScope {
  return V05_SCOPE_SET.has(scope as EnvVarScope);
}

/**
 * Throw if `scope` is not a v0.5-valid value. Use in service hooks that accept
 * a scope from user input.
 */
export function assertV05Scope(scope: string): asserts scope is EnvVarScope {
  if (!isValidV05Scope(scope)) {
    throw new Error(
      `Invalid env var scope '${scope}'. Valid values in v0.5: ${V05_SCOPES.join(', ')}.`
    );
  }
}

/**
 * Normalize whatever we read from `users.data.env_vars` into the object shape.
 * A plain encrypted string → `{ value_encrypted, scope: 'global' }`.
 */
export function normalizeStoredEnvVar(raw: RawStoredEnvVar): StoredEnvVar {
  if (typeof raw === 'string') {
    return { value_encrypted: raw, scope: 'global' };
  }
  return {
    value_encrypted: raw.value_encrypted,
    scope: raw.scope,
    resource_id: raw.resource_id ?? null,
    extra_config: raw.extra_config ?? null,
  };
}

/**
 * Normalize a full map (skips malformed entries with a warning — same defensive
 * posture as the existing decrypt loop in env-resolver.ts).
 */
export function normalizeStoredEnvMap(
  raw: Record<string, RawStoredEnvVar> | undefined
): Record<string, StoredEnvVar> {
  const out: Record<string, StoredEnvVar> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    try {
      out[key] = normalizeStoredEnvVar(value);
    } catch (err) {
      console.warn(`[env-vars] Skipping malformed env var entry ${key}:`, err);
    }
  }
  return out;
}
