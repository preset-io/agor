/**
 * Terminal-executor identity guard.
 *
 * A terminal-scoped executor token (see terminals.ts / ServiceJWTStrategy)
 * authenticates ONLY the Socket.IO terminal channel — those events are handled
 * in socketio.ts, outside Feathers, and are gated on `terminal_user_id`.
 *
 * As a REST/Feathers identity it must be REJECTED, not merely under-privileged:
 * its `role: 'terminal-executor'` is not a key in the RBAC rank table, so
 * `hasMinimumRole()` falls through to rank 0 (== viewer) and it would otherwise
 * pass `requireAuth` and any viewer-gated check. "Low" is not "none"; we make it
 * "none" here by rejecting the request outright at the shared auth chokepoint.
 */

import { Forbidden } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';

/** Whether an authenticated identity is a terminal-scoped executor token. */
export function isTerminalExecutorIdentity(user: unknown): boolean {
  return (user as { _isTerminalExecutor?: boolean } | undefined)?._isTerminalExecutor === true;
}

/**
 * Reject any REST/Feathers service call made by a terminal-executor identity.
 * Composed into `requireAuth` so it runs for every authenticated endpoint. The
 * authentication service itself is NOT gated by `requireAuth`, so the executor
 * can still (re)authenticate its socket.
 */
export async function rejectTerminalExecutorIdentity(context: HookContext): Promise<HookContext> {
  const user = (context.params as { user?: unknown } | undefined)?.user;
  if (isTerminalExecutorIdentity(user)) {
    throw new Forbidden('Terminal-executor tokens are not valid for API access.');
  }
  return context;
}
