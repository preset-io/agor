// src/types/pattern.ts

import type { PatternID, SessionID, TaskID, WorktreeID } from './id';

/**
 * Pattern categories for agent specialization
 *
 * Maps to different areas of development where patterns can be learned and applied.
 */
export const PatternCategory = {
  ARCHITECTURE: 'architecture',
  FRONTEND: 'frontend',
  BACKEND: 'backend',
  MOBILE: 'mobile',
  DEVOPS: 'devops',
  TESTING: 'testing',
  DOCUMENTATION: 'documentation',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  GENERAL: 'general',
} as const;

export type PatternCategory = (typeof PatternCategory)[keyof typeof PatternCategory];

/**
 * Pattern application outcome
 *
 * Tracks whether applying a pattern was successful, failed, or partially successful.
 * Used for reinforcement learning and confidence scoring.
 */
export const PatternOutcome = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  PARTIAL: 'partial',
} as const;

export type PatternOutcome = (typeof PatternOutcome)[keyof typeof PatternOutcome];

/**
 * Pattern - Learned development pattern
 *
 * Represents a reusable pattern discovered through successful task completions.
 * Patterns include context, implementation details, and confidence scores.
 */
export interface Pattern {
  /** Unique pattern identifier (UUIDv7) */
  pattern_id: PatternID;

  /** When this pattern was created */
  created_at: string;

  /** When this pattern was last updated */
  updated_at: string;

  /** Pattern category (architecture, frontend, backend, etc.) */
  category: PatternCategory;

  /** Confidence score (0-100) - updated based on usage outcomes */
  confidence: number;

  /** How many times this pattern has been applied */
  usage_count: number;

  /** How many times this pattern was successfully applied */
  success_count: number;

  /** User ID of the user who created this pattern */
  created_by: string;

  /** Short description of the pattern */
  summary: string;

  /** When/where this pattern applies */
  context: string;

  /** How to implement this pattern */
  implementation: string;

  /** Additional searchable tags */
  tags?: string[];

  /** Related pattern IDs */
  related_patterns?: PatternID[];

  /** Source tracking (where this pattern came from) */
  source?: {
    session_id?: SessionID;
    task_id?: TaskID;
    worktree_id?: WorktreeID;
  };
}

/**
 * Pattern Application - Record of pattern usage
 *
 * Tracks when patterns are applied to tasks and whether they succeeded.
 * Used for reinforcement learning and pattern confidence scoring.
 */
export interface PatternApplication {
  /** Unique application identifier (UUIDv7) */
  application_id: string;

  /** When this pattern was applied */
  created_at: string;

  /** Pattern that was applied */
  pattern_id: PatternID;

  /** Session where pattern was applied */
  session_id: SessionID;

  /** Task where pattern was applied (optional) */
  task_id?: TaskID;

  /** Outcome of applying this pattern */
  outcome: PatternOutcome;

  /** User ID of the user who applied this pattern */
  created_by: string;

  /** User feedback about pattern application */
  feedback?: string;

  /** How the pattern was adapted/modified */
  modifications?: string;
}

/**
 * Pattern search options
 *
 * Options for searching patterns with semantic search and filtering.
 */
export interface PatternSearchOptions {
  /** Pattern category to filter by */
  category?: PatternCategory;

  /** Minimum confidence score (0-100) */
  minConfidence?: number;

  /** Maximum number of results to return */
  limit?: number;

  /** Include patterns with these tags */
  tags?: string[];

  /** Exclude patterns below this usage count */
  minUsageCount?: number;
}

/**
 * Pattern suggestion
 *
 * A pattern with additional metadata for display in UI/suggestions.
 */
export interface PatternSuggestion extends Pattern {
  /** Relevance score (0-1) from semantic search */
  relevance?: number;

  /** Why this pattern was suggested */
  reason?: string;
}
