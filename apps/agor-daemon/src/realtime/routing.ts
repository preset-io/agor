import type { BoardID, CursorMovedEvent, PresenceUpdatedEvent } from '@agor/core/types';

/** One authoritative naming scheme for Socket.IO rooms and Feathers channels. */
export function tenantChannelName(tenantId: string): string {
  return `tenant:${tenantId}`;
}

export function tenantUserChannelName(tenantId: string, userId: string): string {
  return `tenant:${tenantId}:user:${userId}`;
}

export function boardPresenceRoomName(tenantId: string, boardId: string): string {
  return `tenant:${tenantId}:board:${boardId}:presence`;
}

interface HaNativeSocketPayloads {
  'cursor-moved': CursorMovedEvent;
  'cursor-left': { userId: string; boardId: BoardID; timestamp: number };
  'presence-updated': PresenceUpdatedEvent;
  'repo:cloneError': {
    slug: string;
    url: string;
    error: string;
    repo_id: string;
  };
}

/** Native Socket.IO packets intentionally permitted to cross the HA Redis adapter. */
export const HA_NATIVE_SOCKET_EVENT_INVENTORY = [
  'cursor-moved',
  'cursor-left',
  'presence-updated',
  'repo:cloneError',
] as const satisfies readonly (keyof HaNativeSocketPayloads)[];

type NativeSocketTarget = {
  emit(event: string, payload: unknown): unknown;
};

/**
 * Audited boundary for native cross-replica packets. Other room-targeted
 * Socket.IO emissions must opt into `.local` so a missed feature gate cannot
 * silently put a new payload onto Redis.
 */
export function emitHaNativeSocketEvent<Event extends keyof HaNativeSocketPayloads>(
  target: NativeSocketTarget,
  event: Event,
  payload: HaNativeSocketPayloads[Event]
): void {
  target.emit(event, payload);
}
