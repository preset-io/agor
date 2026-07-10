/**
 * Transport-neutral session ↔ MCP relationship store actions.
 *
 * REST mutation confirmations and websocket events both use these idempotent
 * actions. Bumping the hydration revision ensures either transport racing an
 * in-flight relationship snapshot causes that stale snapshot to be discarded.
 */
import { bumpRevision } from './agorHydration';
import { type AgorState, agorStore } from './agorStore';

const setMap: AgorState['setMap'] = (key, value) => agorStore.getState().setMap(key, value);

export function sessionMcpCreated(relationship: { session_id: string; mcp_server_id: string }) {
  bumpRevision('sessionMcp');
  setMap('sessionMcpServerIds', (prev) => {
    const sessionMcpIds = prev.get(relationship.session_id) || [];
    if (sessionMcpIds.includes(relationship.mcp_server_id)) return prev;

    const next = new Map(prev);
    next.set(relationship.session_id, [...sessionMcpIds, relationship.mcp_server_id]);
    return next;
  });
}

export function sessionMcpRemoved(relationship: { session_id: string; mcp_server_id: string }) {
  bumpRevision('sessionMcp');
  setMap('sessionMcpServerIds', (prev) => {
    const sessionMcpIds = prev.get(relationship.session_id) || [];
    const filtered = sessionMcpIds.filter((id) => id !== relationship.mcp_server_id);
    if (filtered.length === sessionMcpIds.length) return prev;

    const next = new Map(prev);
    if (filtered.length > 0) next.set(relationship.session_id, filtered);
    else next.delete(relationship.session_id);
    return next;
  });
}
