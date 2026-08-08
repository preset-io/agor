/**
 * The deliberately small, safe representation of a database error that may be
 * written to shared logs. Drizzle errors retain the SQL and bound parameter
 * values on `query`, `params`, and nested `cause` objects, so never return the
 * original error (or its cause chain) from this boundary.
 */
export interface SanitizedDbError {
  name: string;
  message: string;
  code?: string;
  constraint?: string;
}

type ErrorRecord = Record<string, unknown>;

const POSTGRES_SQLSTATE = /^[0-9A-Z]{5}$/;
const SQLITE_ERROR_CODE = /^SQLITE_[A-Z0-9_]{1,64}$/;
const DATABASE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

function asRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as ErrorRecord) : undefined;
}

/** Detect a PostgreSQL or SQLite unique/primary-key violation through wrappers. */
export function isDatabaseUniqueConstraintError(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = asRecord(current);
    const code = typeof record?.code === 'string' ? record.code : '';
    if (
      code === '23505' ||
      code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    ) {
      return true;
    }

    const message = typeof record?.message === 'string' ? record.message.toLowerCase() : '';
    if (
      message.includes('unique constraint') ||
      message.includes('sqlite_constraint_unique') ||
      message.includes('sqlite_constraint_primarykey')
    ) {
      return true;
    }
    current = record?.cause;
  }
  return false;
}

/**
 * Convert an unknown database failure to log-safe scalar metadata.
 *
 * The cause chain is inspected only to recover postgres' code, constraint and
 * safe message; it is never retained on the result. Arbitrary driver fields
 * such as detail, query and params are intentionally ignored.
 */
export function sanitizeDbError(error: unknown): SanitizedDbError {
  let code: string | undefined;
  let constraint: string | undefined;
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = asRecord(current);
    if (
      !code &&
      typeof record?.code === 'string' &&
      (POSTGRES_SQLSTATE.test(record.code) || SQLITE_ERROR_CODE.test(record.code))
    ) {
      code = record.code;
    }
    const candidateConstraint = record?.constraint_name ?? record?.constraint;
    if (
      !constraint &&
      typeof candidateConstraint === 'string' &&
      DATABASE_IDENTIFIER.test(candidateConstraint)
    ) {
      constraint = candidateConstraint;
    }

    current = record?.cause;
  }

  // Driver messages are not safe metadata. PostgreSQL commonly embeds rejected
  // values in otherwise ordinary messages (for example invalid UUID syntax),
  // without a `query:` or `params:` marker. Keep a stable diagnostic category
  // instead; code and constraint retain the actionable database context.
  const message = code?.startsWith('23')
    ? 'Database constraint violation'
    : 'Database operation failed';
  return {
    name: 'DatabaseError',
    message,
    ...(code ? { code } : {}),
    ...(constraint ? { constraint } : {}),
  };
}
