import type { BoardID, WorktreeID } from './id';

/**
 * Board object types for canvas annotations
 */
export type BoardObjectType = 'text' | 'zone';

/**
 * Positioned worktree card on a board
 *
 * Boards display worktrees as primary units. Sessions are accessed
 * through the worktree card's session tree.
 */
export interface BoardEntityObject {
  /** Unique object identifier */
  object_id: string;

  /** Board this entity belongs to */
  board_id: BoardID;

  /** Worktree reference */
  worktree_id: WorktreeID;

  /** Position on canvas */
  position: { x: number; y: number };

  /** Zone this worktree is pinned to (optional) */
  zone_id?: string;

  /** When this entity was added to the board */
  created_at: string;
}

/**
 * Text annotation object
 */
export interface TextBoardObject {
  type: 'text';
  x: number;
  y: number;
  width?: number;
  height?: number;
  content: string;
  fontSize?: number;
  color?: string;
  background?: string;
}

/**
 * Zone trigger behavior modes for worktree drops
 */
export type ZoneTriggerBehavior = 'always_new' | 'show_picker';

/**
 * Zone trigger configuration for worktree drops
 *
 * When a worktree is dropped on a zone with a trigger:
 * - 'always_new': Automatically create new root session and apply trigger
 * - 'show_picker': Open modal to select existing session or create new one
 */
export interface ZoneTrigger {
  /** Handlebars template for the prompt */
  template: string;
  /** Trigger behavior mode (default: 'show_picker') */
  behavior: ZoneTriggerBehavior;
}

/**
 * Zone rectangle object (for organizing sessions visually)
 */
export interface ZoneBoardObject {
  type: 'zone';
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  /** Border color (supports alpha) - falls back to `color` for backwards compatibility */
  borderColor?: string;
  /** Background color (supports alpha) - falls back to derived from `color` for backwards compatibility */
  backgroundColor?: string;
  /** @deprecated Use borderColor instead. Kept for backwards compatibility */
  color?: string;
  status?: string;
  /** Lock zone to prevent dragging/resizing */
  locked?: boolean;
  /** Trigger configuration for sessions dropped into this zone */
  trigger?: ZoneTrigger;
}

/**
 * Union type for all board objects
 */
export type BoardObject = TextBoardObject | ZoneBoardObject;

export interface Board {
  /** Unique board identifier (UUIDv7) */
  board_id: BoardID;

  name: string;

  /**
   * Optional URL-friendly slug for board
   *
   * Examples: "main", "experiments", "bug-fixes"
   *
   * Allows CLI commands like:
   *   agor session list --board experiments
   * instead of:
   *   agor session list --board 01933e4a
   */
  slug?: string;

  description?: string;

  /**
   * DEPRECATED: Sessions and layout are now tracked in board_objects table
   *
   * Query board entities via:
   * - boardObjectsService.find({ query: { board_id } })
   *
   * Old fields removed:
   * - sessions: SessionID[]
   * - layout: { [sessionId: string]: { x, y, parentId? } }
   */

  /**
   * Canvas annotation objects (text labels, zones, etc.)
   *
   * Keys are object IDs (e.g., "text-123", "zone-456")
   * Use atomic backend methods: upsertBoardObject(), removeBoardObject()
   *
   * IMPORTANT: Do NOT directly replace this entire object from client.
   * Use atomic operations to prevent concurrent write conflicts.
   */
  objects?: {
    [objectId: string]: BoardObject;
  };

  created_at: string;
  last_updated: string;

  /** User ID of the user who created this board */
  created_by: string;

  /** Hex color for visual distinction */
  color?: string;

  /** Optional emoji/icon */
  icon?: string;

  /** Background color for the board canvas */
  background_color?: string;

  /**
   * Custom context for Handlebars templates (board-level)
   * Example: { "team": "Backend", "sprint": 42, "deadline": "2025-03-15" }
   * Access in templates: {{ board.context.team }}
   */
  custom_context?: Record<string, unknown>;
}
