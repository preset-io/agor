import type { MCPDiscoveryRequest, MCPDiscoveryResult } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { useRef, useState } from 'react';
import {
  type AuthorityOperation,
  useAuthorityOperationGuard,
} from '@/hooks/useAuthorityOperationGuard';
import { useOAuthBrowserEventAttempt } from './useOAuthBrowserEventAttempt';

/** One discovery lifecycle for create/edit: bind results and browser events to the exact draft and caller. */
export function useMCPServerDiscovery(options: {
  client: AgorClient | null;
  authorityKey: string | null;
  currentUserId: string | null;
  authGeneration: number;
  formRevision: number;
  contextKey: string | null;
}) {
  const { client, authorityKey, currentUserId, authGeneration, formRevision, contextKey } = options;
  const guard = useAuthorityOperationGuard(
    authorityKey && contextKey
      ? [authorityKey, client, currentUserId, authGeneration, contextKey, formRevision]
      : null
  );
  const browserEvents = useOAuthBrowserEventAttempt({
    client,
    currentUserId,
    authGeneration,
    authorityGuard: guard,
  });
  const active = useRef<AuthorityOperation | null>(null);
  const [state, setState] = useState<{
    scope: typeof guard;
    testing: boolean;
    result: MCPDiscoveryResult | null;
  }>();

  const testConnection = async (
    prepare: (operation: AuthorityOperation) => Promise<MCPDiscoveryRequest | null>
  ) => {
    if (!client || !guard.isCurrent() || active.current?.isCurrent()) return;
    const operation = guard.begin();
    active.current = operation;
    setState({ scope: guard, testing: true, result: null });
    let browserAttempt: Awaited<ReturnType<typeof browserEvents.begin>> = null;
    try {
      const request = await prepare(operation);
      if (!request || !operation.isCurrent()) return;
      browserAttempt = await browserEvents.begin({
        operation: 'discover',
        mcpServerId: request.mcp_server_id,
      });
      if (!operation.isCurrent()) return;
      const result = (await client.service('mcp-servers/discover').create({
        ...request,
        ...(browserAttempt ? { oauth_browser_event: browserAttempt.request } : {}),
      })) as MCPDiscoveryResult;
      if (!operation.isCurrent()) return;
      setState({ scope: guard, testing: false, result });
    } catch {
      if (!operation.isCurrent()) return;
      setState({
        scope: guard,
        testing: false,
        result: {
          success: false,
          error: 'Connection test failed. Check the saved configuration and try again.',
        },
      });
    } finally {
      browserAttempt?.cleanup();
      if (operation.isCurrent())
        setState((current) =>
          current?.scope === guard ? { ...current, testing: false } : current
        );
      operation.cancel();
      if (active.current === operation) active.current = null;
    }
  };

  return {
    testing: state?.scope === guard && state.testing,
    testResult: state?.scope === guard ? state.result : null,
    testConnection,
  };
}
