// src/types/presence.ts

import type { BoardID, SessionID } from './id';
import type { User } from './user';

/**
 * Cursor position event (client → server)
 */
export interface CursorMoveEvent {
  boardId: BoardID;
  x: number; // React Flow viewport coordinates
  y: number; // React Flow viewport coordinates
  timestamp: number;
  /** Short or full session ID the client is currently viewing, if any. */
  sessionId?: string;
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
  /** Session the emitting user is currently viewing, if any. */
  sessionId?: string;
}

/**
 * Lightweight presence broadcast (server → clients).
 *
 * Used by global presence consumers like the navbar facepile, which only need
 * to know that a user is active and which board they're on — not every cursor
 * coordinate sample.
 */
export interface PresenceUpdatedEvent {
  userId: string;
  boardId: BoardID;
  timestamp: number;
  /** Session the emitting user is currently viewing, if any. */
  sessionId?: string;
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
  sessionId?: SessionID; // Session the user is currently viewing, if any
  cursor?: {
    x: number;
    y: number;
  };
}
