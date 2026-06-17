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
 * Static fallback list of Claude model aliases.
 *
 * The primary source is the Anthropic Models API (fetched live by the
 * /claude-models daemon service). This list is used when no API key is
 * configured or the API call fails.
 *
 * Models are listed with newest first in each family.
 * For details, see: https://docs.anthropic.com/en/docs/about-claude/models
 */
export const AVAILABLE_CLAUDE_MODEL_ALIASES: ClaudeModel[] = [
  {
    id: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8',
    family: 'claude-4',
    description:
      'Most capable model for complex reasoning, long-horizon agentic coding, and high-autonomy work',
  },
  {
    id: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    family: 'claude-4',
    description: 'Previous generation Opus model for agents and coding',
  },
  {
    id: 'claude-opus-4-7[1m]',
    displayName: 'Claude Opus 4.7 (1M context)',
    family: 'claude-4',
    description: 'Opus 4.7 with extended 1M token context window',
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    family: 'claude-4',
    description: 'Best combination of speed and intelligence',
  },
  {
    id: 'claude-sonnet-4-6[1m]',
    displayName: 'Claude Sonnet 4.6 (1M context)',
    family: 'claude-4',
    description: 'Sonnet 4.6 with extended 1M token context window',
  },
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6',
    family: 'claude-4',
    description: 'Previous generation Opus',
  },
  {
    id: 'claude-opus-4-6[1m]',
    displayName: 'Claude Opus 4.6 (1M context)',
    family: 'claude-4',
    description: 'Opus 4.6 with extended 1M token context window',
  },
  {
    id: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    family: 'claude-4',
    description: 'Fast and capable',
  },
  {
    id: 'claude-sonnet-4-5[1m]',
    displayName: 'Claude Sonnet 4.5 (1M context)',
    family: 'claude-4',
    description: 'Sonnet 4.5 with extended 1M token context window',
  },
  {
    id: 'claude-opus-4-5',
    displayName: 'Claude Opus 4.5',
    family: 'claude-4',
    description: 'High-performance reasoning',
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    family: 'claude-4',
    description: 'Fastest with near-frontier intelligence',
  },
  {
    id: 'claude-opus-4-1',
    displayName: 'Claude Opus 4.1',
    family: 'claude-4',
    description: 'Legacy reasoning model',
  },
  {
    id: 'claude-sonnet-4-0',
    displayName: 'Claude Sonnet 4.0',
    family: 'claude-4',
    description: 'Deprecated legacy balanced model; prefer Sonnet 4.6',
  },
];

/**
 * Default Claude model for new sessions (uses Sonnet 4.6 for best speed/intelligence balance)
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';
