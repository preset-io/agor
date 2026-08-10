/**
 * Capability-driven secret resolution.
 *
 * Shared between JWT secret (`apps/agor-daemon/src/index.ts`) and
 * `AGOR_MASTER_SECRET` (`apps/agor-daemon/src/startup.ts`). Resolution
 * order:
 *
 *   1. Environment variable present     → use it; no FS touch
 *   2. Persisted value (already loaded) → use it
 *   3. None of the above                → fail-fast with concrete remediation
 *
 * Failing-fast matters: rotating these secrets on every restart is silently
 * catastrophic (invalidates every issued token / corrupts every stored
 * encrypted API key). Refusing to start beats thrashing.
 *
 * Admin password bootstrap is deliberately NOT routed through this helper —
 * it uses a factory-with-rollback inside `bootstrapFirstRunAdmin` so the
 * shape doesn't match. See `setup/first-run-admin.ts`.
 *
 * See context/explorations/daemon-fs-decoupling.md §1.5 (H3) for the
 * rationale.
 */

export interface PersistedSecretSpec {
  /** Human-readable name for error messages (e.g. "JWT secret"). */
  name: string;
  /** Environment variable to honor first. */
  envVar: string;
  /** Pre-existing value loaded from config, if any. */
  existing: string | undefined;
  /** Dotted config key accepted as an operator-provided value. */
  configKey: string;
}

export interface PersistedSecretResult {
  /** The resolved secret value. */
  value: string;
  /** Where the value came from. Callers may use this to shape their logs. */
  source: 'env' | 'config';
}

/**
 * Resolve a persisted secret per the order above.
 *
 * Throws (with operator-actionable remediation) when no source is reachable.
 * The error always names both operator-owned configuration sources.
 */
export async function resolvePersistedSecret(
  spec: PersistedSecretSpec
): Promise<PersistedSecretResult> {
  const fromEnv = process.env[spec.envVar];
  if (fromEnv) {
    return { value: fromEnv, source: 'env' };
  }
  if (spec.existing) {
    return { value: spec.existing, source: 'config' };
  }
  throw new Error(
    [
      `${spec.name} is required, but neither ${spec.envVar} nor ${spec.configKey} is configured.`,
      '',
      `Set ${spec.envVar} to a stable hex-encoded 32-byte value (for example,`,
      '`openssl rand -hex 32`) using your deployment secret manager, or add the',
      `${spec.configKey} value to config.yaml through your config-management workflow, then restart.`,
      'The daemon will not generate or rewrite config.yaml at runtime.',
    ].join('\n')
  );
}
