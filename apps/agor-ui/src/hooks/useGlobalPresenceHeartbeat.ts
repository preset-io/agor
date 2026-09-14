import {
  type AgorClient,
  type BoardID,
  MAX_PRESENCE_BOARD_SUBSCRIPTIONS,
  PRESENCE_SOCKET_EVENTS,
  type PresenceSubscriptionAcknowledgement,
} from '@agor-live/client';
import { useEffect, useMemo, useRef } from 'react';
import { PRESENCE_CONFIG } from '../config/presence';

interface UseGlobalPresenceHeartbeatOptions {
  client: AgorClient | null;
  currentBoardId: BoardID | null;
  visibleBoardIds: BoardID[];
  enabled?: boolean;
}

function browserMayPublishBoardAssociation(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.hidden) return false;
  return typeof document.hasFocus !== 'function' || document.hasFocus();
}

/**
 * Publish one tab's liveness and subscribe its navbar to low-frequency board
 * associations for boards already returned by the authorized boards API.
 *
 * Hidden/blurred tabs remain tenant-online but publish no board identity. On a
 * focus/visibility/routing transition, the full desired subscription set is
 * re-authorized server-side before the next board-bearing heartbeat.
 */
export function useGlobalPresenceHeartbeat({
  client,
  currentBoardId,
  visibleBoardIds,
  enabled = true,
}: UseGlobalPresenceHeartbeatOptions): void {
  const subscribedBoardIds = useMemo(() => {
    const ids = new Set<BoardID>();
    if (currentBoardId) ids.add(currentBoardId);
    for (const boardId of visibleBoardIds) ids.add(boardId);
    return [...ids].slice(0, MAX_PRESENCE_BOARD_SUBSCRIPTIONS);
  }, [currentBoardId, visibleBoardIds]);
  const subscriptionKey = subscribedBoardIds.join('\0');

  const currentBoardRef = useRef(currentBoardId);
  currentBoardRef.current = currentBoardId;
  const subscribedBoardIdsRef = useRef(subscribedBoardIds);
  subscribedBoardIdsRef.current = subscribedBoardIds;
  const synchronizeRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled || !client?.io) return;
    let active = true;
    let synchronizationGeneration = 0;
    let authorizedGeneration = -1;
    let synchronizationInFlight = false;
    let synchronizationPending = false;

    const publishHeartbeat = () => {
      client.io.emit(PRESENCE_SOCKET_EVENTS.heartbeat, {
        boardId:
          browserMayPublishBoardAssociation() && authorizedGeneration === synchronizationGeneration
            ? currentBoardRef.current
            : null,
      });
    };
    const synchronize = () => {
      if (!active) return;
      // A route/list/focus/reconnect generation is untrusted until its own
      // acknowledgement succeeds. Retract the previous association now and
      // keep periodic heartbeats boardless while authorization is pending.
      synchronizationGeneration++;
      publishHeartbeat();
      if (synchronizationInFlight) {
        synchronizationPending = true;
        return;
      }
      synchronizationInFlight = true;
      const generation = synchronizationGeneration;
      client.io
        .timeout(PRESENCE_CONFIG.SUBSCRIPTION_ACK_TIMEOUT_MS)
        .emit(
          PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations,
          { boardIds: subscribedBoardIdsRef.current },
          (error: Error | null, result: PresenceSubscriptionAcknowledgement) => {
            synchronizationInFlight = false;
            const rerun = synchronizationPending;
            synchronizationPending = false;
            if (
              active &&
              !rerun &&
              !error &&
              generation === synchronizationGeneration &&
              result?.ok
            ) {
              authorizedGeneration = generation;
              publishHeartbeat();
            }
            if (active && rerun) synchronize();
          }
        );
    };
    synchronizeRef.current = synchronize;

    const handleVisibilityChange = () => {
      if (browserMayPublishBoardAssociation()) synchronize();
      else publishHeartbeat();
    };
    const handleFocus = () => synchronize();
    const handleBlur = () => publishHeartbeat();

    client.io.on('connect', synchronize);
    client.on('authenticated', synchronize);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
      window.addEventListener('focus', handleFocus);
      window.addEventListener('blur', handleBlur);
    }
    const heartbeatInterval = setInterval(publishHeartbeat, PRESENCE_CONFIG.HEARTBEAT_INTERVAL_MS);

    return () => {
      active = false;
      synchronizationGeneration++;
      synchronizeRef.current = () => undefined;
      clearInterval(heartbeatInterval);
      client.io.off('connect', synchronize);
      client.off('authenticated', synchronize);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('focus', handleFocus);
        window.removeEventListener('blur', handleBlur);
      }
      client.io.emit(PRESENCE_SOCKET_EVENTS.leave);
      client.io.emit(PRESENCE_SOCKET_EVENTS.subscribeBoardAssociations, { boardIds: [] });
    };
  }, [client, enabled]);

  useEffect(() => {
    if (enabled && client) synchronizeRef.current();
    // These values select when the ref-backed synchronizer must run without
    // rebuilding its transport listeners.
    void currentBoardId;
    void subscriptionKey;
  }, [client, currentBoardId, enabled, subscriptionKey]);
}
