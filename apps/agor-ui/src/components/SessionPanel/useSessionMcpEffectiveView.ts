import type { SessionMcpEntryState } from '@agor/core/mcp/effective-set';
import type { AgorClient, MCPServer } from '@agor-live/client';
import React from 'react';

export interface SessionMcpEffectiveEntry {
  mcp_server_id: string;
  source: 'global' | 'session';
  state: SessionMcpEntryState;
  server: MCPServer;
}

/**
 * The session's effective MCP set as the daemon resolves it for the runtime
 * (`resolveSessionMcpEntries`), so the pill shows what the agent loads.
 * `refreshKey` lists inputs whose change can change the answer (links, OAuth
 * status, server inventory, authority). Callers key the owning component
 * by session, so entries never carry over to another session.
 */
export function useSessionMcpEffectiveView(
  client: AgorClient | null,
  sessionId: string,
  enabled: boolean,
  refreshKey: readonly unknown[]
): { entries: SessionMcpEffectiveEntry[] | null; refresh: () => void } {
  const [nonce, setNonce] = React.useState(0);
  const [entries, setEntries] = React.useState<SessionMcpEffectiveEntry[] | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce and refreshKey are re-run triggers
  React.useEffect(() => {
    if (!client || !enabled) return;
    let active = true;
    void client
      .service(`sessions/${sessionId}/mcp-servers`)
      .find({ query: { effective: true } })
      .then((response) => {
        const view = response as unknown as { entries?: SessionMcpEffectiveEntry[] };
        if (active && Array.isArray(view?.entries)) setEntries(view.entries);
      })
      .catch(() => {
        // Keep the last answer; the pill falls back to the session links.
      });
    return () => {
      active = false;
    };
  }, [client, enabled, sessionId, nonce, ...refreshKey]);
  const refresh = React.useCallback(() => setNonce((value) => value + 1), []);
  return { entries: enabled ? entries : null, refresh };
}
