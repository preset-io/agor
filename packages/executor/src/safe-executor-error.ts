import { sanitizeDbError } from '@agor/core/db';
import { ClaudeExecutionError } from './sdk-handlers/claude/claude-error.js';

const MAX_FAILURE_MESSAGE_LENGTH = 1_024;

function hasDrizzleMessageShape(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value.startsWith('Failed query:') && value.includes('params:');
}

function isDatabaseFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current && !seen.has(current); depth++) {
    seen.add(current);
    if (typeof current !== 'object') return false;
    const value = current as Record<string, unknown>;
    if (
      'query' in value ||
      'params' in value ||
      hasDrizzleMessageShape(value.message) ||
      (typeof value.code === 'string' && /^[0-9A-Z]{5}$/.test(value.code))
    )
      return true;
    current = value.cause;
  }
  return false;
}

/** Safe text for durable task/message diagnostics; never includes DB query parameters. */
export function formatExecutorFailure(error: unknown): string {
  // Claude has already diagnosed this at its SDK boundary. Do not reinterpret
  // Node codes such as EPERM (or provider fields in cause) as SQLSTATE codes.
  // Local database/persistence errors never go through that provider boundary.
  if (error instanceof ClaudeExecutionError) return error.message;
  if (isDatabaseFailure(error)) {
    const diagnostic = sanitizeDbError(error);
    return diagnostic.code ? `${diagnostic.message} (${diagnostic.code})` : diagnostic.message;
  }
  const text = error instanceof Error ? error.message : String(error);
  if (text.length <= MAX_FAILURE_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_FAILURE_MESSAGE_LENGTH - 1)}…`;
}
