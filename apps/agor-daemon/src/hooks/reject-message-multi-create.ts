import { BadRequest } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';

const MESSAGE_MULTI_CREATE_ERROR = 'Bulk Message create must use /messages/bulk';

/** Keep ordinary Message CRUD single-record before any hooks inspect the payload. */
export function assertSingleMessageCreatePayload(data: unknown): void {
  if (Array.isArray(data)) throw new BadRequest(MESSAGE_MULTI_CREATE_ERROR);
}

/**
 * Reject arrays before RBAC hooks try to resolve one Session from create data.
 * The bounded, single-Session bulk contract lives at /messages/bulk.
 */
export function rejectMessageMultiCreate(context: HookContext): HookContext {
  assertSingleMessageCreatePayload(context.data);
  return context;
}
