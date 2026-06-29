const POSTGRES_UNIQUE_VIOLATION = '23505';
const SQLITE_CONSTRAINT_PREFIX = 'SQLITE_CONSTRAINT';

/**
 * Detect database unique-constraint violations across the supported drivers.
 *
 * postgres-js exposes SQLSTATE 23505. libsql/sqlite variants expose
 * SQLITE_CONSTRAINT* codes. Some repository wrappers preserve only the message,
 * so keep the message fallback narrow and constraint-specific.
 */
export function isUniqueConstraintError(err: unknown): boolean {
  if (!err) return false;

  const error = err as {
    code?: string;
    cause?: { code?: string };
    message?: string;
  };
  const code = error.code ?? error.cause?.code ?? '';
  if (code === POSTGRES_UNIQUE_VIOLATION) return true;
  if (code.startsWith(SQLITE_CONSTRAINT_PREFIX)) return true;

  const message = (error.message ?? '').toLowerCase();
  return message.includes('unique constraint') || message.includes('sqlite_constraint_unique');
}
