/**
 * Process log context for one executor run, from its stdin payload.
 *
 * The session token's claims are decoded WITHOUT verification and used for
 * log correlation only; the daemon verifies the token on every call. The token
 * itself is never logged.
 */

import { readUnverifiedJwtPayload } from '@agor/core/utils/jwt';
import type { LogContext } from '@agor/core/utils/log-context';

interface ExecutorLogContextSource {
  sessionToken?: string;
  /** Prompt payloads carry `sessionId`/`taskId`; other commands may not. */
  params?: unknown;
}

function stringField(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object') return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export function executorLogContext(payload: ExecutorLogContextSource): LogContext {
  const claims =
    typeof payload.sessionToken === 'string'
      ? readUnverifiedJwtPayload(payload.sessionToken)
      : null;
  const context: Record<string, string | undefined> = {
    tenant_id: stringField(claims, 'tenant_id'),
    user_id: stringField(claims, 'sub'),
    branch_id: stringField(claims, 'branch_id'),
    session_id: stringField(payload.params, 'sessionId') ?? stringField(claims, 'session_id'),
    task_id: stringField(payload.params, 'taskId') ?? stringField(claims, 'task_id'),
  };
  return Object.fromEntries(
    Object.entries(context).filter((entry): entry is [string, string] => entry[1] !== undefined)
  ) as LogContext;
}
