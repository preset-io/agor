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
  /** Context capacity selected by this Claude Code model choice. */
  contextWindow: number;
}

export const CLAUDE_STANDARD_CONTEXT_WINDOW = 200_000;
export const CLAUDE_EXTENDED_CONTEXT_WINDOW = 1_000_000;

export function supportsClaudeExtendedContext(modelId: string): boolean {
  const normalizedId = modelId.toLowerCase().replace(/\[1m\]$/, '');
  return AVAILABLE_CLAUDE_MODEL_ALIASES.some((model) => model.id === `${normalizedId}[1m]`);
}

export function hasNativeMillionContext(modelId: string): boolean {
  const baseId = modelId.toLowerCase().replace(/\[1m\]$/, '');
  const selected = AVAILABLE_CLAUDE_MODEL_ALIASES.find((model) => model.id === baseId);
  return (
    selected?.contextWindow === CLAUDE_EXTENDED_CONTEXT_WINDOW &&
    !AVAILABLE_CLAUDE_MODEL_ALIASES.some((model) => model.id === `${baseId}[1m]`)
  );
}

/**
 * Deterministic accounting fallback for a persisted Claude Code selection.
 * Unknown/custom IDs deliberately return undefined rather than guessing 200k.
 */
export function getClaudeContextWindowLimit(modelId?: string): number | undefined {
  if (!modelId) return undefined;
  const normalizedId = modelId.toLowerCase();
  const known = AVAILABLE_CLAUDE_MODEL_ALIASES.find((entry) => entry.id === normalizedId);
  return known?.contextWindow;
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
    id: 'claude-fable-5-1',
    displayName: 'Claude Fable 5.1 · 1M',
    family: 'claude-5',
    description: 'Most capable model for demanding reasoning and long-horizon agentic work',
    contextWindow: CLAUDE_EXTENDED_CONTEXT_WINDOW,
  },
  {
    id: 'claude-fable-5',
    displayName: 'Claude Fable 5 · 1M',
    family: 'claude-5',
    description: 'Previous Fable model for complex reasoning and long-horizon agentic work',
    contextWindow: CLAUDE_EXTENDED_CONTEXT_WINDOW,
  },
  {
    id: 'claude-opus-5',
    displayName: 'Claude Opus 5 · 200k',
    family: 'claude-5',
    description: 'Frontier agentic coding and enterprise work; standard Claude Code context',
    contextWindow: CLAUDE_STANDARD_CONTEXT_WINDOW,
  },
  {
    id: 'claude-opus-5[1m]',
    displayName: 'Claude Opus 5 · 1M',
    family: 'claude-5',
    description: 'Opus 5 with Claude Code extended 1M context accounting',
    contextWindow: CLAUDE_EXTENDED_CONTEXT_WINDOW,
  },
  {
    id: 'claude-opus-4-8',
    displayName: 'Claude Opus 4.8 · 200k',
    family: 'claude-4',
    description:
      'Most capable model for complex reasoning, long-horizon agentic coding, and high-autonomy work',
    contextWindow: CLAUDE_STANDARD_CONTEXT_WINDOW,
  },
  {
    id: 'claude-opus-4-8[1m]',
    displayName: 'Claude Opus 4.8 · 1M',
    family: 'claude-4',
    description: 'Opus 4.8 with extended 1M token context window',
    contextWindow: CLAUDE_EXTENDED_CONTEXT_WINDOW,
  },
  {
    id: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5 · 1M',
    family: 'claude-5',
    description: 'Best combination of speed and intelligence; native 1M context window',
    contextWindow: CLAUDE_EXTENDED_CONTEXT_WINDOW,
  },
  {
    id: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7 · 200k',
    family: 'claude-4',
    description: 'Previous generation Opus model for agents and coding',
    contextWindow: CLAUDE_STANDARD_CONTEXT_WINDOW,
  },
  {
    id: 'claude-opus-4-7[1m]',
    displayName: 'Claude Opus 4.7 · 1M',
    family: 'claude-4',
    description: 'Opus 4.7 with extended 1M token context window',
    contextWindow: CLAUDE_EXTENDED_CONTEXT_WINDOW,
  },
  {
    id: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6 · 200k',
    family: 'claude-4',
    description: 'Best combination of speed and intelligence',
    contextWindow: CLAUDE_STANDARD_CONTEXT_WINDOW,
  },
  {
    id: 'claude-sonnet-4-6[1m]',
    displayName: 'Claude Sonnet 4.6 · 1M',
    family: 'claude-4',
    description: 'Sonnet 4.6 with extended 1M token context window',
    contextWindow: CLAUDE_EXTENDED_CONTEXT_WINDOW,
  },
  {
    id: 'claude-opus-4-6',
    displayName: 'Claude Opus 4.6 · 200k',
    family: 'claude-4',
    description: 'Previous generation Opus',
    contextWindow: CLAUDE_STANDARD_CONTEXT_WINDOW,
  },
  {
    id: 'claude-opus-4-6[1m]',
    displayName: 'Claude Opus 4.6 · 1M',
    family: 'claude-4',
    description: 'Opus 4.6 with extended 1M token context window',
    contextWindow: CLAUDE_EXTENDED_CONTEXT_WINDOW,
  },
  {
    id: 'claude-sonnet-4-5',
    displayName: 'Claude Sonnet 4.5',
    family: 'claude-4',
    description: 'Fast and capable',
    contextWindow: CLAUDE_STANDARD_CONTEXT_WINDOW,
  },
  {
    id: 'claude-opus-4-5',
    displayName: 'Claude Opus 4.5',
    family: 'claude-4',
    description: 'High-performance reasoning',
    contextWindow: CLAUDE_STANDARD_CONTEXT_WINDOW,
  },
  {
    id: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    family: 'claude-4',
    description: 'Fastest with near-frontier intelligence',
    contextWindow: CLAUDE_STANDARD_CONTEXT_WINDOW,
  },
  {
    id: 'claude-opus-4-1',
    displayName: 'Claude Opus 4.1',
    family: 'claude-4',
    description: 'Legacy reasoning model',
    contextWindow: CLAUDE_STANDARD_CONTEXT_WINDOW,
  },
  {
    id: 'claude-sonnet-4-0',
    displayName: 'Claude Sonnet 4.0',
    family: 'claude-4',
    description: 'Deprecated legacy balanced model; prefer Sonnet 4.6',
    contextWindow: CLAUDE_STANDARD_CONTEXT_WINDOW,
  },
];

/**
 * Default Claude model for new sessions (uses Sonnet 5 for best speed/intelligence balance)
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
