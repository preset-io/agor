// src/types/presence.ts

import type { BoardID } from './id';
import type { User } from './user';

/**
 * Cursor position event (client → server)
 */
export interface CursorMoveEvent {
  boardId: BoardID;
  x: number; // React Flow viewport coordinates
  y: number; // React Flow viewport coordinates
  timestamp: number;
}

/**
 * Cursor position broadcast (server → clients)
 */
export interface CursorMovedEvent {
  userId: string;
  boardId: BoardID;
  x: number;
  y: number;
  timestamp: number;
}

/**
 * Lightweight presence broadcast (server → clients).
 *
 * Used by global presence consumers like the navbar facepile. `boardId` is
 * present only on a board-authorized delivery; tenant-wide heartbeats omit it
 * so private board identity is not disclosed through presence metadata.
 */
export interface PresenceUpdatedEvent {
  userId: string;
  boardId?: BoardID;
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
