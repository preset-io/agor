// src/tools/claude/models.ts

/**
 * Claude model metadata for UI display and selection
 */
export interface ClaudeModel {
  /** Model ID or alias (e.g., "claude-sonnet-4-5-latest" or "claude-sonnet-4-5-20250929") */
  id: string;
  /** Display name for UI (e.g., "Claude Sonnet 4.5") */
  displayName: string;
  /** Model family (e.g., "claude-4", "claude-3.5") */
  family: string;
  /** User-facing description */
  description: string;
}

/**
 * Available Claude model aliases (API-provided, auto-update to latest versions)
 *
 * Note: Anthropic's naming is inconsistent:
 * - Newer models (Claude 4.x) use version-based aliases: claude-sonnet-4-5, claude-opus-4-1
 * - Older models (Claude 3.x) use -latest suffix: claude-3-7-sonnet-latest
 */
export const AVAILABLE_CLAUDE_MODEL_ALIASES: ClaudeModel[] = [
  {
    id: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    family: 'claude-4',
    description: 'Best for coding (latest)',
  },
  {
    id: 'claude-opus-4-1',
    displayName: 'Claude Opus 4.1',
    family: 'claude-4',
    description: 'Most capable model (latest)',
  },
  {
    id: 'claude-sonnet-4-0',
    displayName: 'Claude Sonnet 4.0',
    family: 'claude-4',
    description: 'Sonnet 4.0 (previous)',
  },
  {
    id: 'claude-3-7-sonnet-latest',
    displayName: 'Claude 3.7 Sonnet',
    family: 'claude-3.7',
    description: 'Fast & balanced',
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    family: 'claude-4',
    description: 'Fastest (latest)',
  },
  {
    id: 'claude-3-5-haiku-latest',
    displayName: 'Claude 3.5 Haiku',
    family: 'claude-3.5',
    description: 'Fastest (previous)',
  },
];

/**
 * Default Claude model for new sessions (uses Sonnet 4.5 for best coding performance)
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5';
