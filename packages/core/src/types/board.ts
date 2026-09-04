import type { PersistedAgenticToolName } from './agentic-tool';
import type { BranchPermissionLevel } from './branch';
import type { CardID } from './card';
import type { ArtifactID, BoardID, BranchID } from './id';

/**
 * Canvas position (x/y coordinates in board space)
 */
export type BoardPosition = { x: number; y: number };

/**
 * Board object types for canvas annotations
 */
export type BoardObjectType = 'text' | 'zone' | 'markdown' | 'app' | 'artifact';

/**
 * Entity type discriminator for board objects
 */
export type BoardEntityType = 'branch' | 'card';

/**
 * Positioned entity on a board (branch or card)
 *
 * Polymorphic placement: exactly one of branch_id or card_id is set.
 * The entity_type field indicates which one.
 */
export interface BoardEntityObject {
  /** Unique object identifier */
  object_id: string;

  /** Board this entity belongs to */
  board_id: BoardID;

  /** Branch reference (set when entity_type === 'branch') */
  branch_id?: BranchID;

  /** Card reference (set when entity_type === 'card') */
  card_id?: CardID;

  /** Computed entity type discriminator */
  entity_type: BoardEntityType;

  /** Position on canvas */
  position: BoardPosition;

  /** Last measured rendered size, used by server-side layout tools. */
  size?: { width: number; height: number };

  /** Shared compact presentation state for worktrees and generic cards with body content. */
  compact?: boolean;

  /** Zone this entity is pinned to (optional) */
  zone_id?: string;

  /** When this entity was added to the board */
  created_at: string;
}

/** One entity-row update in an atomic whole-board layout commit. */
export interface BoardLayoutPlacementUpdate {
  position: BoardPosition;
  size: { width: number; height: number };
  compact?: boolean;
}

/**
 * Complete persisted geometry for one canvas object in an atomic layout commit.
 *
 * Width and height remain conditional because not every board-object kind owns
 * those fields (markdown owns width but derives height from its contents). The
 * repository requires every dimension owned by the durable object to be
 * present before comparing or writing the snapshot.
 */
export interface BoardLayoutObjectUpdate {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** Canvas and entity geometry committed together after one shared layout plan. */
export interface BoardLayoutBatch {
  objects: Record<string, BoardLayoutObjectUpdate>;
  placements: Record<string, BoardLayoutPlacementUpdate>;
  /**
   * Optional pre-plan geometry snapshot. It must cover every submitted id and
   * may include unchanged obstacles/peers so the repository can reject any
   * board change that invalidated the plan under the board-row transaction
   * lock, preventing a delayed tab or observer from overwriting newer geometry.
   */
  expected?: {
    objects: Record<string, BoardLayoutObjectUpdate>;
    placements: Record<
      string,
      Omit<BoardLayoutPlacementUpdate, 'size'> & { size?: BoardLayoutPlacementUpdate['size'] }
    >;
  };
}

/** Result of filtering and committing one atomic board-layout request. */
export interface BoardLayoutApplyResult {
  board: Board;
  /** Authoritative rows for every placement in the submitted full snapshot. */
  placements: BoardEntityObject[];
  /** False means the request matched durable state and wrote nothing. */
  changed: boolean;
  /** Canvas-object ids whose durable geometry changed. */
  changed_object_ids: string[];
  /** Placement ids whose durable geometry changed. */
  changed_placement_ids: string[];
}

/** One realtime payload lets observers apply both halves without an intermediate frame. */
export interface BoardLayoutAppliedEvent {
  board_id: BoardID;
  board: Board;
  placements: BoardEntityObject[];
}

/** Relevant source state used to reject stale board-default writes. */
export interface BoardZoneLayoutDefaultsExpected {
  defaults: ZoneLayoutPolicy;
  zones: Record<
    string,
    {
      binding: ZoneLayoutBinding;
      layout: ZoneLayoutPolicy;
    }
  >;
}

/** Result of atomically changing board defaults and any intentional followers. */
export interface BoardZoneLayoutDefaultsApplyResult {
  board: Board;
  changed: boolean;
  changed_zone_ids: string[];
}

export const BOARD_LAYOUT_APPLIED_EVENT = 'layout-applied' as const;

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
  /** Explicit stacking order. Falls back to the per-type default when unset. */
  zIndex?: number;
}

/**
 * Zone trigger behavior modes for branch drops
 */
export type ZoneTriggerBehavior = 'always_new' | 'show_picker';

/**
 * Zone trigger configuration for branch drops
 *
 * When a branch is dropped on a zone with a trigger:
 * - 'always_new': Automatically create new root session and apply trigger
 * - 'show_picker': Open modal to select existing session or create new one
 */
export interface ZoneTrigger {
  /** Handlebars template for the prompt */
  template: string;
  /** Trigger behavior mode (default: 'show_picker') */
  behavior: ZoneTriggerBehavior;
  /**
   * Preferred agent for auto-created sessions (default: 'claude-code').
   *
   * This is persisted board metadata, so removed identifiers remain readable.
   * Runtime trigger paths must narrow it to an active tool before execution.
   */
  agent?: PersistedAgenticToolName;
}

/** Whether a zone preserves spatial placement or continuously maintains its layout. */
export type ZoneLayoutMode = 'manual' | 'auto';

/** Whether a zone follows its board policy or owns a saved policy. */
export type ZoneLayoutBinding = 'inherit' | 'override';

/** Opinionated v1 presentation presets for the contents of a zone. */
export type ZoneLayoutPreset = 'grid' | 'compact_list';

/** Stable fields available for deterministic zone ordering. */
export type ZoneLayoutSortBy = 'position' | 'priority' | 'status' | 'updated' | 'created' | 'title';

export type ZoneLayoutSortDirection = 'asc' | 'desc';

/**
 * How far a zone may resize itself to hold its contents.
 *
 * `height` is the historical behaviour and cannot rescue a zone that is too
 * *narrow*: an item wider than the zone overflows no matter how tall the zone
 * grows, which is why a width-constrained arrange could only refuse. `both`
 * widens to the contents' required width first, then grows the height.
 */
export type ZoneResizeMode = 'fixed' | 'height' | 'both';

/**
 * What to do when a zone that grew now covers its neighbours.
 *
 * A zone is a rectangle on a shared canvas, so growing one moves its edges
 * onto whatever sits beside or below it. `report` names the covered zones and
 * leaves the board alone; `reflow_board` re-runs the justified zone layout so
 * the neighbours move out of the way.
 */
export type ZoneOverflowStrategy = 'report' | 'reflow_board';

/**
 * Persisted zone layout policy.
 *
 * Missing policies intentionally mean manual spatial placement for backwards
 * compatibility. Unknown future fields survive board-object shallow merges.
 */
export interface ZoneLayoutPolicy {
  mode: ZoneLayoutMode;
  preset: ZoneLayoutPreset;
  sortBy: ZoneLayoutSortBy;
  sortDirection: ZoneLayoutSortDirection;
  /** Preferred grid width. Compact lists always use one column. */
  columns?: number;
  /** Exact spacing between arranged items in board pixels. */
  gap?: number;
  /**
   * Grow or shrink the zone vertically to contain the arranged rectangles.
   *
   * @deprecated Superseded by {@link ZoneLayoutPolicy.resize}, which can also
   * widen a zone. `normalizeZoneLayoutPolicy` keeps writing it so readers that
   * predate `resize` still behave; when both are present, `resize` wins.
   */
  autoResizeHeight?: boolean;
  /** How far the zone may resize itself to hold its contents. */
  resize?: ZoneResizeMode;
  /** What to do when a resize pushes this zone into its neighbours. */
  onOverflow?: ZoneOverflowStrategy;
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
  /** Optional persisted sorting and automatic layout policy. */
  layout?: ZoneLayoutPolicy;
  /**
   * Board-default inheritance state. Missing means `override` so every zone
   * created before board defaults existed keeps its historical behaviour.
   */
  layout_binding?: ZoneLayoutBinding;
  /** Label/status font size in px. Falls back to the theme default when unset. */
  fontSize?: number;
  /** Explicit stacking order. Falls back to the per-type default when unset. */
  zIndex?: number;
}

/**
 * Markdown note annotation object
 * Rich text notes with markdown rendering, user-selected width, auto-expanding height
 */
export interface MarkdownBoardObject {
  type: 'markdown';
  x: number;
  y: number;
  width: number; // User-selected width (300-800px)
  content: string; // Markdown text
  // Optional future enhancements:
  fontSize?: number; // Font size multiplier (default: 1.0)
  backgroundColor?: string; // Background color with alpha (default: card background)
  /** Explicit stacking order. Falls back to the per-type default when unset. */
  zIndex?: number;
}

/**
 * Sandpack template options for app board objects
 */
export type SandpackTemplate =
  | 'static'
  | 'react'
  | 'react-ts'
  | 'vanilla'
  | 'vanilla-ts'
  | 'vue'
  | 'vue3'
  | 'svelte'
  | 'solid'
  | 'angular';

/**
 * Live web application rendered via Sandpack (in-browser bundler)
 *
 * Apps render as interactive iframes on the board canvas.
 * Agents can create/update apps via MCP tools.
 */
export interface AppBoardObject {
  type: 'app';
  x: number;
  y: number;
  width: number; // Default: 600, min: 300
  height: number; // Default: 400, min: 200
  /** App title shown in the card header */
  title: string;
  /** Optional description */
  description?: string;

  /** Sandpack template (default: 'react') */
  template: SandpackTemplate;
  /** File map: path -> code content */
  files: Record<string, string>;
  /** NPM dependencies beyond template defaults */
  dependencies?: Record<string, string>;
  /** Entry file path (default: determined by template) */
  entryFile?: string;
  /** Whether to show the code editor alongside preview */
  showEditor?: boolean;
  /** Whether to show the console output */
  showConsole?: boolean;
  /** Explicit stacking order. Falls back to the per-type default when unset. */
  zIndex?: number;
}

/**
 * Artifact board object - thin reference to an Artifact entity
 *
 * Unlike AppBoardObject (which inlines all code), this stores only the
 * artifact_id. The frontend fetches the payload from the daemon REST API.
 */
export interface ArtifactBoardObject {
  type: 'artifact';
  x: number;
  y: number;
  width: number; // Default: 600, min: 300
  height: number; // Default: 400, min: 200
  /** Reference to the artifact entity */
  artifact_id: ArtifactID;
  /** Lock artifact card to prevent dragging/resizing on the board */
  locked?: boolean;
  /** Explicit stacking order. Falls back to the per-type default when unset. */
  zIndex?: number;
}

/**
 * Union type for all board objects
 */
export type BoardObject =
  | TextBoardObject
  | ZoneBoardObject
  | MarkdownBoardObject
  | AppBoardObject
  | ArtifactBoardObject;

export interface TeammateWelcomeNoteRequest {
  /** Board to create/update the bundled teammate welcome note on. */
  boardId?: BoardID | string;
  /** Alias accepted by Feathers custom method callers. */
  id?: BoardID | string;
  /** User-provided teammate display name. */
  teammateName?: string;
  /** Optional user-provided teammate emoji/icon. */
  teammateEmoji?: string | null;
}

export type BoardAccessMode = 'private' | 'shared';
export type BoardDefaultFsAccess = 'none' | 'read' | 'write';

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
  primary_teammate_id?: BranchID;

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

  /** Immutable primary owner. This is intentionally independent of attribution. */
  primary_owner_user_id?: string;

  /** Board-level visibility. Existing boards default/read as 'shared'. */
  access_mode?: BoardAccessMode;

  /** Default app-layer permission for new/aligned branches on this board. */
  default_others_can?: BranchPermissionLevel;

  /** Default filesystem access for new/aligned branches on this board. */
  default_others_fs_access?: BoardDefaultFsAccess;

  /** Hex color for visual distinction */
  color?: string;

  /** Optional emoji/icon */
  icon?: string;

  /** Background color for the board canvas */
  background_color?: string;

  /**
   * Custom CSS for the board canvas (rendered in a scoped <style> tag).
   * Supports @keyframes, animation, background-size, and other CSS that
   * can't be expressed as inline styles. Sanitized before rendering.
   */
  custom_css?: string;

  /**
   * Custom context for Handlebars templates (board-level)
   * Example: { "team": "Backend", "sprint": 42, "deadline": "2025-03-15" }
   * Access in templates: {{ board.context.team }}
   */
  custom_context?: Record<string, unknown>;

  /** Authoritative layout policy inherited by newly-created/reset zones. */
  zone_layout_defaults?: ZoneLayoutPolicy;

  /**
   * External/user-facing URL for viewing this board in the UI.
   *
   * Computed property added by the repository layer.
   * Format: `{baseUrl}/ui/b/{slug-or-shortId}/`
   * Prefers the board's slug when set; falls back to the canonical
   * short ID.
   */
  url: string;

  /** Whether this board is archived (soft deleted) */
  archived: boolean;

  /** ISO 8601 timestamp when the board was archived */
  archived_at?: string;

  /** User ID of the user who archived this board */
  archived_by?: string;
}

/**
 * Portable board export format (shell only)
 *
 * Contains board metadata and annotations, but no branches or sessions.
 * Can be serialized to YAML/JSON for sharing or archival.
 */
export interface BoardExportBlob {
  // Core metadata
  name: string;
  slug?: string;
  description?: string;
  icon?: string;
  color?: string;
  background_color?: string;
  custom_css?: string;
  access_mode?: BoardAccessMode;
  default_others_can?: BranchPermissionLevel;
  default_others_fs_access?: BoardDefaultFsAccess;
  zone_layout_defaults?: ZoneLayoutPolicy;

  // Annotations (zones, text, markdown)
  objects?: {
    [objectId: string]: BoardObject;
  };

  // Custom context for templates
  custom_context?: Record<string, unknown>;
}
