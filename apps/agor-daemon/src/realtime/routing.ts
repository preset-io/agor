import type {
  BoardID,
  CursorMovedEvent,
  MCPOAuthAttemptID,
  MCPServerID,
  PresenceUpdatedEvent,
} from '@agor/core/types';

declare const tenantQualifiedSocketRoom: unique symbol;

/**
 * A room whose structured name includes an encoded tenant component. Native
 * Socket.IO packets can cross the Redis adapter only when addressed to this
 * branded type. The brand proves construction through this module; call sites
 * remain responsible for supplying tenant identity from trusted auth context.
 */
export type TenantQualifiedSocketRoom = string & {
  readonly [tenantQualifiedSocketRoom]: true;
};

/** Escape the room delimiter injectively while preserving ordinary UUID/slugs. */
function socketRoomComponent(value: string): string {
  return value.replaceAll('%', '%25').replaceAll(':', '%3A');
}

/** One authoritative naming scheme for Socket.IO rooms and Feathers channels. */
export function tenantChannelName(tenantId: string): TenantQualifiedSocketRoom {
  return `tenant:${socketRoomComponent(tenantId)}` as TenantQualifiedSocketRoom;
}

export function tenantUserChannelName(tenantId: string, userId: string): TenantQualifiedSocketRoom {
  return `tenant:${socketRoomComponent(tenantId)}:user:${socketRoomComponent(userId)}` as TenantQualifiedSocketRoom;
}

export function boardPresenceRoomName(
  tenantId: string,
  boardId: string
): TenantQualifiedSocketRoom {
  return `tenant:${socketRoomComponent(tenantId)}:board:${socketRoomComponent(boardId)}:presence` as TenantQualifiedSocketRoom;
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

type HaNativeSocketEvent = (typeof HA_NATIVE_SOCKET_EVENT_INVENTORY)[number];

type NativeSocketTarget = {
  emit(event: string, payload: unknown): unknown;
};

type NativeSocketRoomEmitter = {
  to(room: TenantQualifiedSocketRoom): NativeSocketTarget;
};

/**
 * Audited boundary for native cross-replica packets. Other room-targeted
 * Socket.IO emissions must opt into `.local` so a missed feature gate cannot
 * silently put a new payload onto Redis. Requiring the room separately makes
 * a plain string/global emitter a type error rather than relying on every call
 * site to remember tenant qualification.
 */
export function emitHaNativeSocketEvent<Event extends HaNativeSocketEvent>(
  emitter: NativeSocketRoomEmitter,
  room: TenantQualifiedSocketRoom,
  event: Event,
  payload: HaNativeSocketPayloads[Event]
): void {
  emitter.to(room).emit(event, payload);
}
