/**
 * The tenant-wide MCP member policy, read once for whoever renders it.
 *
 * One value for the whole settings surface: the card that displays it and the
 * table that dims what it forbids read the same state, so the two can never
 * disagree about what the workspace allows.
 */

import type { AgorClient, MCPMemberPolicy } from '@agor-live/client';
import { DEFAULT_MCP_MEMBER_POLICY } from '@agor-live/client';
import { useCallback, useEffect, useState } from 'react';

export interface McpMemberPolicyState {
  policy: MCPMemberPolicy;
  /**
   * The daemon's answer to whether this caller may configure servers at all —
   * the role floor and the policy in one, so a client does not rebuild it.
   * False until the read succeeds: an unknown answer withholds.
   */
  canConfigure: boolean;
  loading: boolean;
  saving: boolean;
  /** A load or save failure, phrased for the reader. */
  error: string | null;
  /** Write the tenant-wide value. Refused by the daemon for non-admins. */
  save: (next: MCPMemberPolicy) => Promise<void>;
}

const describeError = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export function useMcpMemberPolicy(client: AgorClient | null): McpMemberPolicyState {
  // Start at the restrictive default rather than at "unknown": the value drives
  // which actions are offered, and a permissive guess would flash affordances
  // the workspace does not allow.
  const [policy, setPolicy] = useState<MCPMemberPolicy>(DEFAULT_MCP_MEMBER_POLICY);
  const [canConfigure, setCanConfigure] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) {
      // Disconnected is a knowable state, not a pending one: settle so callers
      // fall back to the restrictive default instead of waiting forever.
      setLoading(false);
      setError('Not connected to the Agor daemon');
      return;
    }
    let active = true;
    setLoading(true);
    client
      .service('mcp-member-policy')
      .find()
      .then((result) => {
        if (!active) return;
        setPolicy(result.policy);
        setCanConfigure(result.can_configure);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setError(describeError(loadError, 'Failed to load the MCP member policy'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client]);

  const save = useCallback(
    async (next: MCPMemberPolicy) => {
      if (!client) return;
      setSaving(true);
      try {
        const result = await client.service('mcp-member-policy').patch(null, { policy: next });
        setPolicy(result.policy);
        setCanConfigure(result.can_configure);
        setError(null);
      } catch (saveError: unknown) {
        setError(describeError(saveError, 'Failed to change the MCP member policy'));
      } finally {
        setSaving(false);
      }
    },
    [client]
  );

  return { policy, canConfigure, loading, saving, error, save };
}
