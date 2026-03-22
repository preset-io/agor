// src/types/card.ts

import type { BoardID, UUID } from './id';

/**
 * Card identifier
 *
 * Uniquely identifies a card on a board.
 */
export type CardID = UUID;

/**
 * CardType identifier
 *
 * Uniquely identifies a global card type definition.
 */
export type CardTypeID = UUID;

/**
 * CardType - Global card type definition
 *
 * CardTypes are org-level templates defining a category of cards
 * with default emoji, color, and optional JSON Schema for data validation.
 * Global scope: usable on any board.
 */
export interface CardType {
  card_type_id: CardTypeID;
  name: string;
  emoji?: string;
  color?: string;
  json_schema?: Record<string, unknown>;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Card - Generic entity on a board
 *
 * Cards are visual work items managed by agents via MCP tools.
 * They live on boards alongside worktrees and can be placed in zones.
 *
 * Key fields:
 * - title: Always shown on card
 * - url: Makes title clickable to external resource
 * - description: Stable context about the entity, collapsed on card
 * - note: Agent's live commentary, always shown in full on card
 * - data: JSON blob for structured workflow state (not displayed on card)
 */
export interface Card {
  card_id: CardID;
  board_id: BoardID;
  card_type_id?: CardTypeID;
  title: string;
  url?: string;
  description?: string;
  note?: string;
  data?: Record<string, unknown>;
  color_override?: string;
  emoji_override?: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  archived: boolean;
  archived_at?: string;
}

/**
 * Card with resolved CardType info
 *
 * Used in API responses to include the effective emoji/color
 * (from override or inherited from CardType).
 */
export interface CardWithType extends Card {
  /** Resolved card type (if card_type_id is set) */
  card_type?: CardType;
  /** Effective emoji (override > card_type > undefined) */
  effective_emoji?: string;
  /** Effective color (override > card_type > undefined) */
  effective_color?: string;
}
