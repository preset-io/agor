export type StructuredLogLevel = 'info' | 'warn' | 'error';
export type StructuredLogValue = string | number | boolean | null | undefined;

const MAX_STRING_LOG_VALUE_LENGTH = 256;

function truncateLogString(value: string): string {
  if (value.length <= MAX_STRING_LOG_VALUE_LENGTH) return value;
  return `${value.slice(0, MAX_STRING_LOG_VALUE_LENGTH - 1)}…`;
}

export function formatStructuredLogValue(value: Exclude<StructuredLogValue, undefined>): string {
  return typeof value === 'string' ? JSON.stringify(truncateLogString(value)) : String(value);
}

export function formatStructuredLog(
  prefix: string,
  fields: Record<string, StructuredLogValue>
): string {
  const details = Object.entries(fields)
    .filter(
      (entry): entry is [string, Exclude<StructuredLogValue, undefined>] => entry[1] !== undefined
    )
    .map(([key, value]) => `${key}=${formatStructuredLogValue(value)}`)
    .join(' ');
  return details ? `${prefix} ${details}` : prefix;
}

/** Extract only a bounded, non-payload error category for operational logs. */
export function structuredLogErrorCode(error: unknown): string {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    if (typeof current !== 'object') break;
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(record.code)) {
      return record.code;
    }
    current = record.cause;
  }
  return 'operation_failed';
}
