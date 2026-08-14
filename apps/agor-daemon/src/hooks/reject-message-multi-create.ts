import { BadRequest } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';

const MESSAGE_MULTI_CREATE_ERROR = 'Bulk Message create is not supported';

/** Keep ordinary Message CRUD single-record before any hooks inspect the payload. */
export function assertSingleMessageCreatePayload(data: unknown): void {
  if (Array.isArray(data)) throw new BadRequest(MESSAGE_MULTI_CREATE_ERROR);
}

/**
 * Reject arrays before RBAC hooks try to resolve one Session from create data.
 * Every Message write must pass through the canonical single-record boundary.
 */
export function rejectMessageMultiCreate(context: HookContext): HookContext {
  assertSingleMessageCreatePayload(context.data);
  return context;
}
