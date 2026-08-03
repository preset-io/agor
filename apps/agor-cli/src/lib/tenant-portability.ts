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

export const TENANT_PORTABILITY_ERROR_MARKER = 'agor.tenant-portability.error' as const;
export const TENANT_PORTABILITY_ERROR_VERSION = 1 as const;

export type TenantPortabilityErrorCategory =
  | 'archive_invalid'
  | 'catalog_invariant'
  | 'database_constraint'
  | 'database_error'
  | 'filesystem_deletion_pending'
  | 'filesystem_error'
  | 'invalid_input'
  | 'unknown'
  | 'unsafe_archive_path'
  | 'unsupported_runtime'
  | 'verification_failed'
  | 'write_gate';

/** Stable, bounded failure marker written as one JSON line to stderr. */
export interface TenantPortabilityErrorMarkerV1 {
  marker: typeof TENANT_PORTABILITY_ERROR_MARKER;
  version: typeof TENANT_PORTABILITY_ERROR_VERSION;
  category: TenantPortabilityErrorCategory;
  sqlstate?: string;
  constraint?: string;
  table?: string;
  column?: string;
}

const CATEGORY_BY_ERROR_NAME: Readonly<Record<string, TenantPortabilityErrorCategory>> = {
  InvalidTenantIdError: 'invalid_input',
  MalformedArchiveError: 'archive_invalid',
  TenantCatalogError: 'catalog_invariant',
  TenantDeletionCatalogError: 'catalog_invariant',
  TenantDeletionUnsupportedError: 'unsupported_runtime',
  TenantDeletionVerificationError: 'verification_failed',
  TenantFilesystemDeletionPendingError: 'filesystem_deletion_pending',
  TenantPortabilityUnsupportedError: 'unsupported_runtime',
  TenantWriteGateActiveError: 'write_gate',
  TenantWriteGateGenerationError: 'write_gate',
  TenantWriteGateHeldError: 'write_gate',
  TenantWriteGateUnsupportedError: 'unsupported_runtime',
  UnsafeArchivePathError: 'unsafe_archive_path',
};

const FILESYSTEM_ERROR_CODES = new Set([
  'EACCES',
  'EEXIST',
  'EISDIR',
  'ELOOP',
  'ENOENT',
  'ENOSPC',
  'ENOTDIR',
  'EPERM',
  'EROFS',
  'EXDEV',
]);

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
    ? (value as Record<string, unknown>)
    : null;
}

function safeStringField(record: Record<string, unknown>, field: string): string | undefined {
  try {
    const value = record[field];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

function safeCause(record: Record<string, unknown>): unknown {
  try {
    return record.cause;
  } catch {
    return undefined;
  }
}

function isSafeSqlstate(value: string | undefined): value is string {
  return value !== undefined && /^[0-9A-Z]{5}$/.test(value);
}

function safePostgresIdentifier(value: string | undefined): string | undefined {
  if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) return undefined;
  return value;
}

function errorCauseChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<Record<string, unknown>>();
  let current: unknown = error;
  while (chain.length < 8) {
    const record = errorRecord(current);
    if (!record || seen.has(record)) break;
    seen.add(record);
    chain.push(record);
    current = safeCause(record);
  }
  return chain;
}

/**
 * Cause-aware allowlist formatter for portability failures. It deliberately
 * never reads or emits Error.message, query/parameter/detail/hint fields, row
 * data, paths, or arbitrary cause text. Only a fixed category and validated
 * PostgreSQL structural metadata can cross the CLI boundary.
 */
export function formatPortabilityError(error: unknown): string {
  const chain = errorCauseChain(error);
  let category: TenantPortabilityErrorCategory | undefined;
  let sqlstate: string | undefined;
  let constraint: string | undefined;
  let table: string | undefined;
  let column: string | undefined;
  let filesystemError = false;

  for (const record of chain) {
    const name = safeStringField(record, 'name');
    category ??= name ? CATEGORY_BY_ERROR_NAME[name] : undefined;

    const code = safeStringField(record, 'code');
    if (code && FILESYSTEM_ERROR_CODES.has(code)) {
      filesystemError = true;
      continue;
    }
    if (!isSafeSqlstate(code)) continue;
    if (!sqlstate) sqlstate = code;
    if (sqlstate !== code) continue;
    constraint ??= safePostgresIdentifier(safeStringField(record, 'constraint'));
    table ??= safePostgresIdentifier(safeStringField(record, 'table'));
    column ??= safePostgresIdentifier(safeStringField(record, 'column'));
  }

  category ??= sqlstate
    ? sqlstate.startsWith('23')
      ? 'database_constraint'
      : 'database_error'
    : filesystemError
      ? 'filesystem_error'
      : 'unknown';

  const marker: TenantPortabilityErrorMarkerV1 = {
    marker: TENANT_PORTABILITY_ERROR_MARKER,
    version: TENANT_PORTABILITY_ERROR_VERSION,
    category,
    ...(sqlstate ? { sqlstate } : {}),
    ...(constraint ? { constraint } : {}),
    ...(table ? { table } : {}),
    ...(column ? { column } : {}),
  };
  return JSON.stringify(marker);
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
  const json = serializeStdoutJson(value);
  return new Promise<void>((resolve, reject) => {
    process.stdout.write(json, (err) => (err ? reject(err) : resolve()));
  });
}

/** Stable one-line serialization shared by every tenant command's stdout contract. */
export function serializeStdoutJson(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/** Wait until every stderr write queued so far has completed. */
export function flushStderr(): Promise<void> {
  return new Promise((resolve) => {
    process.stderr.write('', () => resolve());
  });
}
