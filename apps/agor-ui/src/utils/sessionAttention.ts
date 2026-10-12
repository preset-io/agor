import type { AgorClient } from '@agor-live/client';
import { agorStore } from '../store/agorStore';

/**
 * Opening a session clears its unopened-result flag and its branch's attention
 * flag, in both shells. Best-effort and silent: read-only callers (RBAC) may not
 * patch either, and a toast would be noise.
 */
export function clearOpenedSessionFlags(client: AgorClient | null, sessionId: string) {
  if (!client) return;
  // Call-time store read: callers keep a stable identity and never subscribe to these maps.
  const { sessionById, branchById } = agorStore.getState();
  const session = sessionById.get(sessionId);
  if (session?.ready_for_prompt) {
    client
      .service('sessions')
      .patch(sessionId, { ready_for_prompt: false })
      .catch(() => {});
  }
  const branch = session?.branch_id ? branchById.get(session.branch_id) : undefined;
  if (branch?.needs_attention) {
    client
      .service('branches')
      .patch(branch.branch_id, { needs_attention: false })
      .catch(() => {});
  }
}
