// src/types/presence.ts

import type { BoardID } from './id';
import type { User } from './user';

/**
 * Native Socket.IO event names owned by the multiplayer-presence protocol.
 * Keep browser and daemon consumers on this shared family rather than
 * reconstructing cross-process strings independently.
 */
export const PRESENCE_SOCKET_EVENTS = {
  watchBoardCursors: 'presence:watch-board',
  unwatchBoardCursors: 'presence:unwatch-board',
  subscribeBoardAssociations: 'presence:subscribe-boards',
  heartbeat: 'presence:heartbeat',
  leave: 'presence:leave',
  cursorMove: 'cursor-move',
  cursorLeave: 'cursor-leave',
  cursorMoved: 'cursor-moved',
  cursorLeft: 'cursor-left',
  updated: 'presence-updated',
  left: 'presence-left',
} as const;

/** Complete presence protocol inventory for diagnostics and event classification. */
export const PRESENCE_SOCKET_EVENT_NAMES = Object.values(PRESENCE_SOCKET_EVENTS);

/** Server-to-client presence events explicitly eligible for HA adapter relay. */
export const PRESENCE_HA_SOCKET_EVENTS = [
  PRESENCE_SOCKET_EVENTS.cursorMoved,
  PRESENCE_SOCKET_EVENTS.cursorLeft,
  PRESENCE_SOCKET_EVENTS.updated,
  PRESENCE_SOCKET_EVENTS.left,
] as const;

/** Bound per-socket board-room membership and client subscription payloads. */
export const MAX_PRESENCE_BOARD_SUBSCRIPTIONS = 512;

/**
 * Cursor position event (client → server)
 */
export interface CursorMoveEvent {
  boardId: BoardID;
  x: number; // React Flow viewport coordinates
  y: number; // React Flow viewport coordinates
}

/**
 * Cursor position broadcast (server → clients)
 */
export interface CursorMovedEvent {
  userId: string;
  /** Server-generated, connection-scoped identity for multi-tab convergence. */
  presenceId: string;
  boardId: BoardID;
  x: number;
  y: number;
  timestamp: number;
}

/**
 * Lightweight presence broadcast (server → clients).
 *
 * Used by global presence consumers like the navbar facepile. A tenant-wide
 * delivery deliberately omits `boardId`; the same heartbeat carries `boardId`
 * only through the board-association room whose admission was authorized by
 * the daemon. `presenceId` is random per Socket.IO connection and lets clients
 * merge multiple tabs/devices without one tab clearing another.
 */
export interface PresenceUpdatedEvent {
  userId: string;
  presenceId: string;
  boardId?: BoardID;
  timestamp: number;
}

/** Explicit removal for one connection's tenant or board-scoped presence. */
export type PresenceLeftEvent = PresenceUpdatedEvent;

/** Browser heartbeat. Identity and timestamp are always derived server-side. */
export interface PresenceHeartbeatEvent {
  boardId?: BoardID | null;
}

/**
 * Full desired board-association subscription set for one browser socket.
 * The daemon silently drops missing/foreign/denied/archived IDs.
 */
export interface BoardPresenceSubscriptionRequest {
  boardIds: BoardID[];
}

export interface PresenceSubscriptionAcknowledgement {
  ok: boolean;
}

/** Server → browser cursor removal scoped to one connection instance. */
export interface CursorLeftEvent {
  userId: string;
  presenceId: string;
  boardId: BoardID;
  timestamp: number;
}

/**
 * Cursor leave event (user navigates away from board)
 */
export interface CursorLeaveEvent {
  boardId: BoardID;
}

/**
 * Remote cursor state for rendering
 */
export interface RemoteCursor {
  userId: string;
  user: User;
  x: number;
  y: number;
  timestamp: number;
}

/**
 * Active user for facepile display
 */
export interface ActiveUser {
  user: User;
  lastSeen: number;
  boardId?: BoardID; // Which board the user is currently viewing
  cursor?: {
    x: number;
    y: number;
  };
}
