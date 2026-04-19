/**
 * Before-create hook that stamps `created_by` on incoming data.
 *
 * Why this hook exists
 * --------------------
 * The previous inline implementations on the sessions/tasks/boards services
 * used `if (!item.created_by) item.created_by = userId` — which let an
 * authenticated external caller POST `/sessions` (or `/tasks`, `/boards`)
 * with `created_by: <other_user_id>` and have the new resource attributed to
 * a different user. That is identity attribution forgery.
 *
 * Security model
 * --------------
 * - **External calls** (`params.provider != null` — REST, socketio, MCP):
 *   ALWAYS overwrite `data.created_by` with `params.user.user_id`. Any
 *   client-supplied value is silently discarded. Throws `NotAuthenticated`
 *   if no user is on `params` (defence-in-depth — auth hooks should have
 *   rejected the call already).
 * - **Internal calls** (`params.provider == null` — scheduler, callbacks,
 *   service-to-service): respect an explicitly-provided `data.created_by`,
 *   defaulting to the (usually absent) caller user_id or `'anonymous'`.
 *
 * Place this hook AFTER any role/permission gate (e.g. `requireMinimumRole`)
 * so that on external calls `params.user` is guaranteed to be populated.
 */

import { NotAuthenticated } from '@agor/core/feathers';
import type { HookContext } from '@agor/core/types';

export function injectCreatedBy() {
  return (context: HookContext): HookContext => {
    const isExternal = context.params.provider != null;
    const user = (context.params as { user?: { user_id?: string } }).user;
    const userId = user?.user_id;

    const apply = (item: Record<string, unknown>) => {
      if (isExternal) {
        if (!userId) {
          // Should be unreachable if auth hooks ran first; fail closed.
          throw new NotAuthenticated('Authentication required to create this resource');
        }
        // Unconditional overwrite — never trust client-supplied created_by.
        item.created_by = userId;
      } else if (!item.created_by) {
        // Internal: only fill the gap, never override.
        item.created_by = userId ?? 'anonymous';
      }
    };

    if (Array.isArray(context.data)) {
      (context.data as Record<string, unknown>[]).forEach(apply);
    } else if (context.data) {
      apply(context.data as Record<string, unknown>);
    }
    return context;
  };
}
