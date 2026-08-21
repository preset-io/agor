import type { MCPOAuthBrowserEventRequest, MCPOAuthOpenBrowserEvent } from '@agor/core/types';
import type { AgorClient } from '@agor-live/client';
import { useLayoutEffect, useRef } from 'react';
import type { AuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';

interface OAuthBrowserEventAttempt {
  request: MCPOAuthBrowserEventRequest;
  cleanup: () => void;
}

interface OAuthBrowserEventAttemptOptions {
  client: AgorClient | null;
  currentUserId: string | null;
  authGeneration: number;
  authorityGuard: AuthorityOperationGuard;
}

function newOperationId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Register an exact, one-shot listener before starting a blocking discovery.
 * Socket targeting alone is insufficient because launch auth can replace the
 * socket's caller in place while an A-era discovery is still running.
 */
export function useOAuthBrowserEventAttempt({
  client,
  currentUserId,
  authGeneration,
  authorityGuard,
}: OAuthBrowserEventAttemptOptions): { begin: () => OAuthBrowserEventAttempt | null } {
  const cleanupByOperationIdRef = useRef(new Map<string, () => void>());

  // biome-ignore lint/correctness/useExhaustiveDependencies: these values and guard identity are the authority transition keys that trigger listener teardown
  useLayoutEffect(
    () => () => {
      for (const cleanup of cleanupByOperationIdRef.current.values()) cleanup();
      cleanupByOperationIdRef.current.clear();
    },
    [client, currentUserId, authGeneration, authorityGuard]
  );

  return {
    begin: () => {
      if (!client || !currentUserId || !authorityGuard.isCurrent()) return null;
      const operation = authorityGuard.begin();
      if (!operation.isCurrent()) return null;
      const request: MCPOAuthBrowserEventRequest = {
        operation_id: newOperationId(),
        auth_generation: authGeneration,
      };
      let active = true;
      const cleanup = () => {
        if (!active) return;
        active = false;
        client.io.off('oauth:open_browser', listener);
        cleanupByOperationIdRef.current.delete(request.operation_id);
        operation.cancel();
      };
      const listener = (event: MCPOAuthOpenBrowserEvent) => {
        if (
          !active ||
          !operation.isCurrent() ||
          event.operation_id !== request.operation_id ||
          event.auth_generation !== authGeneration ||
          event.caller_user_id !== currentUserId ||
          typeof event.attempt_id !== 'string' ||
          !event.attempt_id ||
          typeof event.authUrl !== 'string' ||
          !event.authUrl
        ) {
          return;
        }
        // Remove first: a duplicate event dispatched synchronously by another
        // listener cannot open a second provider tab for the same attempt.
        cleanup();
        window.open(event.authUrl, '_blank', 'noopener,noreferrer');
      };
      cleanupByOperationIdRef.current.set(request.operation_id, cleanup);
      client.io.on('oauth:open_browser', listener);
      return { request, cleanup };
    },
  };
}
