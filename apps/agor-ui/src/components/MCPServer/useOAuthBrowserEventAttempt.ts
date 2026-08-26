import type {
  MCPOAuthBrowserEventRequest,
  MCPOAuthBrowserOperation,
  MCPOAuthBrowserReservation,
  MCPOAuthBrowserReservationRequest,
  MCPOAuthOpenBrowserEvent,
} from '@agor/core/types';
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
}: OAuthBrowserEventAttemptOptions): {
  begin: (request: {
    operation: MCPOAuthBrowserOperation;
    mcpServerId?: string;
  }) => Promise<OAuthBrowserEventAttempt | null>;
} {
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
    begin: async ({ operation: operationKind, mcpServerId }) => {
      if (!client || !currentUserId || !authorityGuard.isCurrent()) return null;
      const operation = authorityGuard.begin();
      if (!operation.isCurrent()) return null;
      const reservationService = client.service(
        'mcp-servers/oauth-browser-reservations'
      ) as unknown as {
        create(data: MCPOAuthBrowserReservationRequest): Promise<MCPOAuthBrowserReservation>;
      };
      const reservation = await reservationService.create({
        operation: operationKind,
        ...(mcpServerId ? { mcp_server_id: mcpServerId as never } : {}),
      });
      if (
        !operation.isCurrent() ||
        !reservation ||
        typeof reservation.reservation_token !== 'string' ||
        !reservation.reservation_token ||
        typeof reservation.expires_at !== 'number' ||
        !Number.isFinite(reservation.expires_at) ||
        reservation.expires_at <= Date.now()
      ) {
        operation.cancel();
        return null;
      }
      const request: MCPOAuthBrowserEventRequest = {
        reservation_token: reservation.reservation_token,
      };
      let active = true;
      let expiryTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (!active) return;
        active = false;
        client.io.off('oauth:open_browser', listener);
        cleanupByOperationIdRef.current.delete(request.reservation_token);
        if (expiryTimer !== undefined) clearTimeout(expiryTimer);
        operation.cancel();
      };
      const listener = (event: MCPOAuthOpenBrowserEvent | null | undefined) => {
        if (Date.now() >= reservation.expires_at) {
          cleanup();
          return;
        }
        if (
          !event ||
          typeof event !== 'object' ||
          !active ||
          !operation.isCurrent() ||
          event.reservation_token !== request.reservation_token ||
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
      cleanupByOperationIdRef.current.set(request.reservation_token, cleanup);
      client.io.on('oauth:open_browser', listener);
      expiryTimer = setTimeout(cleanup, Math.max(0, reservation.expires_at - Date.now()));
      return { request, cleanup };
    },
  };
}
