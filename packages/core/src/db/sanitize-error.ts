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

const STATEMENT_MARKER = /(?:failed\s+query|query|params?|parameters?)\s*:/i;

function asRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as ErrorRecord) : undefined;
}

/** Remove SQL/parameter sections that some database drivers embed in messages. */
export function sanitizeDbErrorMessage(message: string): string {
  const marker = STATEMENT_MARKER.exec(message);
  if (!marker) return message;

  const prefix = message
    .slice(0, marker.index)
    .trimEnd()
    .replace(/[:\s]+$/, '');
  return prefix ? `${prefix}: [database statement redacted]` : '[database statement redacted]';
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

  const messages: string[] = [];
  let code: string | undefined;
  let constraint: string | undefined;
  let current: unknown = error;
  const seen = new Set<unknown>();

  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = asRecord(current);
    const rawMessage =
      typeof record?.message === 'string'
        ? record.message
        : current instanceof Error
          ? current.message
          : undefined;
    if (rawMessage) {
      const safeMessage = sanitizeDbErrorMessage(rawMessage);
      if (!messages.includes(safeMessage)) messages.push(safeMessage);
    }

    if (!code && typeof record?.code === 'string') code = record.code;
    const candidateConstraint = record?.constraint_name ?? record?.constraint;
    if (!constraint && typeof candidateConstraint === 'string') constraint = candidateConstraint;

    current = record?.cause;
  }

  const message = messages.join(': ') || sanitizeDbErrorMessage(String(error));
  return {
    name,
    message,
    ...(code ? { code } : {}),
    ...(constraint ? { constraint } : {}),
  };
}
