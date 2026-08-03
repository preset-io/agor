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

function asRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as ErrorRecord) : undefined;
}

/**
 * Convert an unknown database failure to log-safe scalar metadata.
 *
 * The cause chain is inspected only to recover postgres' code, constraint and
 * safe message; it is never retained on the result. Arbitrary driver fields
 * such as detail, query and params are intentionally ignored.
 */
export function sanitizeDbError(error: unknown): SanitizedDbError {
  const root = asRecord(error);
  const name =
    (typeof root?.name === 'string' && root.name) ||
    (error instanceof Error && error.name) ||
    'DatabaseError';

  let code: string | undefined;
  let constraint: string | undefined;
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = asRecord(current);
    if (!code && typeof record?.code === 'string') code = record.code;
    const candidateConstraint = record?.constraint_name ?? record?.constraint;
    if (!constraint && typeof candidateConstraint === 'string') constraint = candidateConstraint;

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
    name,
    message,
    ...(code ? { code } : {}),
    ...(constraint ? { constraint } : {}),
  };
}
