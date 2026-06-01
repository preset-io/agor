/**
 * Capability-driven secret resolution.
 *
 * Shared between JWT secret (`apps/agor-daemon/src/index.ts`) and
 * `AGOR_MASTER_SECRET` (`apps/agor-daemon/src/startup.ts`). Resolution
 * order:
 *
 *   1. Environment variable present     → use it; no FS touch
 *   2. Persisted value (already loaded) → use it
 *   3. config.yaml writable             → generate + persist
 *   4. None of the above                → fail-fast with concrete remediation
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

import { setConfigValue } from '@agor/core/config';

export interface PersistedSecretSpec {
  /** Human-readable name for error messages (e.g. "JWT secret"). */
  name: string;
  /** Environment variable to honor first. */
  envVar: string;
  /** Pre-existing value loaded from config, if any. */
  existing: string | undefined;
  /** Dotted config key to persist a freshly-generated value at. */
  configKey: string;
  /** Generator for new secrets (CSPRNG hex/random — caller's choice). */
  generate: () => string;
}

export interface PersistedSecretResult {
  /** The resolved secret value. */
  value: string;
  /** Where the value came from. Callers may use this to shape their logs. */
  source: 'env' | 'config' | 'generated';
}

/**
 * Resolve a persisted secret per the order above.
 *
 * Throws (with operator-actionable remediation) when no source is reachable.
 * The error always names both the environment-variable escape hatch and the
 * "make config.yaml writable" escape hatch, so on-call doesn't need to read
 * the code to recover.
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
  const generated = spec.generate();
  try {
    await setConfigValue(spec.configKey, generated);
  } catch (error) {
    throw new Error(
      [
        `${spec.name} is required and config.yaml is not writable.`,
        '',
        `Set the ${spec.envVar} environment variable to a hex-encoded`,
        '32-byte value (e.g. `openssl rand -hex 32`), or make',
        '~/.agor/config.yaml writable so the daemon can persist one.',
        '',
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
      ].join('\n')
    );
  }
  return { value: generated, source: 'generated' };
}
