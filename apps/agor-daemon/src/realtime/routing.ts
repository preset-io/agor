import type {
  BoardID,
  CursorMovedEvent,
  MCPOAuthAttemptID,
  MCPServerID,
  PresenceUpdatedEvent,
} from '@agor/core/types';

declare const tenantBoundSocketRoom: unique symbol;

/**
 * A room proven to carry tenant context in its name. Native Socket.IO packets
 * can cross the Redis adapter only when addressed to this branded type.
 */
export type TenantBoundSocketRoom = string & {
  readonly [tenantBoundSocketRoom]: true;
};

/** One authoritative naming scheme for Socket.IO rooms and Feathers channels. */
export function tenantChannelName(tenantId: string): TenantBoundSocketRoom {
  return `tenant:${tenantId}` as TenantBoundSocketRoom;
}

export function tenantUserChannelName(tenantId: string, userId: string): TenantBoundSocketRoom {
  return `tenant:${tenantId}:user:${userId}` as TenantBoundSocketRoom;
}

export function boardPresenceRoomName(tenantId: string, boardId: string): TenantBoundSocketRoom {
  return `tenant:${tenantId}:board:${boardId}:presence` as TenantBoundSocketRoom;
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
  'oauth:completed': {
    attempt_id: MCPOAuthAttemptID;
    success: boolean;
    mcp_server_id?: string;
    oauth_mode: 'per_user' | 'shared';
  };
  'oauth:disconnected': { mcp_server_id: MCPServerID };
}

/** Native Socket.IO packets intentionally permitted to cross the HA Redis adapter. */
export const HA_NATIVE_SOCKET_EVENT_INVENTORY = [
  'cursor-moved',
  'cursor-left',
  'presence-updated',
  'repo:cloneError',
  'oauth:completed',
  'oauth:disconnected',
] as const satisfies readonly (keyof HaNativeSocketPayloads)[];

type NativeSocketTarget = {
  emit(event: string, payload: unknown): unknown;
};

type NativeSocketRoomEmitter = {
  to(room: TenantBoundSocketRoom): NativeSocketTarget;
};

/**
 * Audited boundary for native cross-replica packets. Other room-targeted
 * Socket.IO emissions must opt into `.local` so a missed feature gate cannot
 * silently put a new payload onto Redis. Requiring the room separately makes
 * a plain string/global emitter a type error rather than relying on every call
 * site to remember tenant qualification.
 */
export function emitHaNativeSocketEvent<Event extends keyof HaNativeSocketPayloads>(
  emitter: NativeSocketRoomEmitter,
  room: TenantBoundSocketRoom,
  event: Event,
  payload: HaNativeSocketPayloads[Event]
): void {
  emitter.to(room).emit(event, payload);
}
