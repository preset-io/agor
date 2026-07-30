/**
 * Shared helpers for the `agor tenant …` portability commands (inspect, export,
 * import, verify, delete). These commands run non-interactively against the
 * runtime database configuration and print a single stable JSON object to
 * stdout; human audit lines go to stderr.
 */

import { dirname } from 'node:path';
import { getTenantDataRootAsync, loadConfig } from '@agor/core/config';

/** Exit code for rejected / invalid input (matches `tenant delete`). */
export const EXIT_INVALID_INPUT = 2;
/** Exit code for any failure after input validation. */
export const EXIT_FAILURE = 1;

/**
 * Best-effort redaction of connection-string credentials from an error or audit
 * message so nothing written to stderr can leak a database password.
 */
export function redactSecrets(message: string): string {
  return message.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1[redacted]@');
}

/** Convert any thrown value to a secret-safe message string. */
export function portabilityErrorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

/**
 * The runtime-resolved tenant filesystem root, or `null` when filesystem
 * isolation is disabled (in that mode the configured root is the shared data
 * home, not a tenant-specific directory, so it must not be treated as
 * tenant-owned). Also returns the tenants base folder used as the safety root
 * for deletion.
 */
export interface ResolvedTenantFilesystem {
  /** Absolute tenant-specific root (`<tenants_base_folder>/<tenantId>`). */
  root: string;
  /** Absolute tenants base folder (`<tenants_base_folder>`). */
  base: string;
}

/**
 * Resolve the tenant-specific filesystem root for a tenant, honouring the
 * runtime configuration. Returns `null` unless `multi_tenancy` filesystem
 * isolation is enabled, so callers never mistake the shared data home for a
 * tenant-owned tree.
 */
export async function resolveTenantFilesystem(
  tenantId: string
): Promise<ResolvedTenantFilesystem | null> {
  const config = await loadConfig();
  if (config.multi_tenancy?.filesystem_isolation_enabled !== true) {
    return null;
  }
  const root = await getTenantDataRootAsync(tenantId);
  return { root, base: dirname(root) };
}

/**
 * Write a stable machine-readable JSON object to stdout, fully flushing before
 * the caller exits (a bare `process.exit` can truncate an in-flight async write
 * to a pipe, and the postgres-js pool otherwise keeps the process alive).
 */
export function writeStdoutJson(value: unknown): Promise<void> {
  const json = `${JSON.stringify(value)}\n`;
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(json, (err) => (err ? reject(err) : resolve()));
  });
}

/** Wait until every stderr write queued so far has completed. */
export function flushStderr(): Promise<void> {
  return new Promise((resolve) => {
    process.stderr.write('', () => resolve());
  });
}
