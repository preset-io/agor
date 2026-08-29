import { isPublicHttpUrl } from '../utils/url';

/**
 * Deliberately small, non-secret result returned by a managed-environment
 * Start action when the provider chooses URLs at runtime.
 *
 * Omission is meaningful: an empty object is a valid result, and static
 * rendered `app` / `health` values remain the fallback for omitted fields.
 */
export interface EnvironmentLifecycleResult {
  app?: string;
  health?: string;
}

const ENVIRONMENT_LIFECYCLE_RESULT_KEYS = new Set(['app', 'health']);

function normalizeLifecycleUrl(value: unknown, field: 'app' | 'health'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
    throw new Error(`environment result ${field} must be a non-empty URL`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`environment result ${field} is invalid`);
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `environment result ${field} must be an HTTP(S) URL without credentials, query, or fragment`
    );
  }
  return parsed.toString();
}

/** Validate and normalize the complete Start-result object. Unknown keys fail closed. */
export function validateEnvironmentLifecycleResult(value: unknown): EnvironmentLifecycleResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('environment result must be a JSON object');
  }

  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ENVIRONMENT_LIFECYCLE_RESULT_KEYS.has(key))) {
    throw new Error('environment result contains an unsupported field');
  }

  return {
    ...(Object.hasOwn(record, 'app') ? { app: normalizeLifecycleUrl(record.app, 'app') } : {}),
    ...(Object.hasOwn(record, 'health')
      ? { health: normalizeLifecycleUrl(record.health, 'health') }
      : {}),
  };
}

/**
 * Dynamic health destinations are command/provider output, not trusted
 * operator configuration. Apply the public-address URL policy here and DNS
 * pinning again at connection time.
 */
export function isAllowedDynamicEnvironmentHealthUrl(value: string): boolean {
  try {
    const normalized = validateEnvironmentLifecycleResult({ health: value }).health;
    return Boolean(normalized && isPublicHttpUrl(normalized));
  } catch {
    return false;
  }
}
