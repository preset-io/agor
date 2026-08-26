/**
 * Caller-scoped MCP member policy.
 *
 * `can_configure` is not tenant configuration alone: it is the daemon's answer
 * for one authenticated identity. The socket client survives reconnects and
 * token replacement, so this hook scopes every answer to client + user + role +
 * successful authentication generation. A mismatched answer is never exposed,
 * even for the render before the refetch effect starts.
 */

import type { AgorClient, MCPMemberPolicy, User } from '@agor-live/client';
import { DEFAULT_MCP_MEMBER_POLICY, MCP_MEMBER_POLICY_CHANGED_EVENT } from '@agor-live/client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface McpMemberPolicyState {
  policy: MCPMemberPolicy;
  /**
   * The daemon's answer to whether this caller may configure servers at all —
   * false until an answer for the current authenticated scope succeeds.
   */
  canConfigure: boolean;
  loading: boolean;
  saving: boolean;
  /** A load or save failure, phrased for the reader. */
  error: string | null;
  /** Write the tenant-wide value. Refused by the daemon for non-admins. */
  save: (next: MCPMemberPolicy) => Promise<void>;
}

export interface McpMemberPolicyScope {
  /** Socket is connected, authenticated, and not in reconnect/reauth transition. */
  connectionReady: boolean;
  /** Identity whose caller-shaped capability the endpoint will answer. */
  currentUser?: Pick<User, 'user_id' | 'role'> | null;
  /** Monotonic successful socket-auth generation from useAgorClient. */
  authGeneration: number;
}

interface PolicySnapshot {
  client: AgorClient | null;
  scopeKey: string | null;
  policy: MCPMemberPolicy;
  canConfigure: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
}

const restrictiveSnapshot = (
  client: AgorClient | null,
  scopeKey: string | null,
  loading: boolean
): PolicySnapshot => ({
  client,
  scopeKey,
  policy: DEFAULT_MCP_MEMBER_POLICY,
  canConfigure: false,
  loading,
  saving: false,
  error: null,
});

const describeError = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export function useMcpMemberPolicy(
  client: AgorClient | null,
  { connectionReady, currentUser, authGeneration }: McpMemberPolicyScope
): McpMemberPolicyState {
  const [policyGeneration, setPolicyGeneration] = useState(0);
  const identityKey = currentUser
    ? `${currentUser.user_id}:${String(currentUser.role ?? '')}`
    : null;
  const establishedAuthorityRef = useRef<{
    client: AgorClient;
    identityKey: string;
    authGeneration: number;
  } | null>(null);
  const establishedAuthority = establishedAuthorityRef.current;
  const authorityMatchesEstablished =
    !!establishedAuthority &&
    establishedAuthority.client === client &&
    establishedAuthority.identityKey === identityKey &&
    authGeneration >= establishedAuthority.authGeneration;
  const authorityHasNewAuthentication =
    !establishedAuthority || authGeneration > establishedAuthority.authGeneration;
  const callerAuthorityReady =
    !!client &&
    connectionReady &&
    !!identityKey &&
    (authorityMatchesEstablished || authorityHasNewAuthentication);
  const scopeKey = callerAuthorityReady
    ? `${identityKey}:${authGeneration}:${policyGeneration}`
    : null;
  const [snapshot, setSnapshot] = useState<PolicySnapshot>(() =>
    restrictiveSnapshot(null, null, true)
  );

  useLayoutEffect(() => {
    if (!callerAuthorityReady || !client || !identityKey) return;
    establishedAuthorityRef.current = { client, identityKey, authGeneration };
  }, [authGeneration, callerAuthorityReady, client, identityKey]);

  // Policy writes can happen in another tab, browser, or daemon replica. The
  // daemon publishes an empty tenant-scoped invalidation only after commit;
  // refetching here preserves the endpoint as the authority for caller-shaped
  // `can_configure` and avoids broadcasting one user's answer to another.
  useEffect(() => {
    if (!client) return;
    const service = client.service('mcp-servers');
    const invalidate = () => setPolicyGeneration((generation) => generation + 1);
    service.on(MCP_MEMBER_POLICY_CHANGED_EVENT, invalidate);
    return () => service.removeListener(MCP_MEMBER_POLICY_CHANGED_EVENT, invalidate);
  }, [client]);

  useEffect(() => {
    if (!client || !scopeKey) return;

    let active = true;
    setSnapshot(restrictiveSnapshot(client, scopeKey, true));
    client
      .service('mcp-member-policy')
      .find()
      .then((result) => {
        if (!active) return;
        setSnapshot({
          client,
          scopeKey,
          policy: result.policy,
          // An answer without the field is not an answer: coerce rather than
          // let an undefined/non-boolean value read as a capability.
          canConfigure: result.can_configure === true,
          loading: false,
          saving: false,
          error: null,
        });
      })
      .catch((loadError: unknown) => {
        if (!active) return;
        setSnapshot({
          ...restrictiveSnapshot(client, scopeKey, false),
          error: describeError(loadError, 'Failed to load the MCP member policy'),
        });
      });

    return () => {
      active = false;
    };
  }, [client, scopeKey]);

  // Compare scope in render, not in an effect. On disconnect, demotion,
  // identity replacement, token reauth, reconnect, or policy invalidation the
  // previous permissive snapshot becomes unusable in this very render.
  const currentSnapshot =
    client && scopeKey && snapshot.client === client && snapshot.scopeKey === scopeKey
      ? snapshot
      : null;

  const effective = useMemo(() => {
    if (!client || !connectionReady) {
      return {
        ...restrictiveSnapshot(client, null, false),
        error: 'Not connected to the Agor daemon',
      };
    }
    if (!identityKey || !scopeKey || !currentSnapshot) {
      return restrictiveSnapshot(client, scopeKey, true);
    }
    return currentSnapshot;
  }, [client, connectionReady, currentSnapshot, identityKey, scopeKey]);

  const save = useCallback(
    async (next: MCPMemberPolicy) => {
      if (!client || !connectionReady || !scopeKey) return;

      const saveClient = client;
      const saveScopeKey = scopeKey;
      setSnapshot((current) =>
        current.client === saveClient && current.scopeKey === saveScopeKey
          ? { ...current, saving: true }
          : current
      );
      try {
        const result = await saveClient.service('mcp-member-policy').patch(null, { policy: next });
        setSnapshot((current) =>
          current.client === saveClient && current.scopeKey === saveScopeKey
            ? {
                ...current,
                policy: result.policy,
                canConfigure: result.can_configure === true,
                saving: false,
                error: null,
              }
            : current
        );
      } catch (saveError: unknown) {
        setSnapshot((current) =>
          current.client === saveClient && current.scopeKey === saveScopeKey
            ? {
                ...current,
                canConfigure: false,
                saving: false,
                error: describeError(saveError, 'Failed to change the MCP member policy'),
              }
            : current
        );
      }
    },
    [client, connectionReady, scopeKey]
  );

  return {
    policy: effective.policy,
    canConfigure: effective.canConfigure,
    loading: effective.loading,
    saving: effective.saving,
    error: effective.error,
    save,
  };
}
