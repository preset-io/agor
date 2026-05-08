/**
 * Copilot Model Constants
 *
 * GitHub Copilot SDK ships `client.listModels()` for live discovery — the
 * daemon surfaces that as a Feathers endpoint, and the UI calls it on mount.
 * The static metadata below is the offline fallback (first-load, no token,
 * dynamic call fails) and the source for the agor_models_list MCP tool.
 */

/**
 * Default Copilot model used when no model is specified.
 * Sonnet 4.6 is the current broadly-available default in the Copilot CLI GA cohort.
 */
export const DEFAULT_COPILOT_MODEL = 'claude-sonnet-4.6';

/**
 * Static fallback list — best-effort. Source IDs from the SDK's `setModel`
 * examples and the Copilot CLI GA changelog (Feb 2026): Claude Opus 4.6,
 * Sonnet 4.6, GPT-5.3-Codex, Gemini 3 Pro, plus older entries kept so that
 * existing sessions with date-stamped IDs don't fall into "exact" mode in
 * the picker.
 *
 * This list is necessarily approximate. The authoritative source is the
 * `/copilot-models` daemon endpoint, which calls `client.listModels()`
 * against the user's GitHub token and returns the live, account-specific
 * lineup (including BYOK-configured models). Wire that up by setting
 * `COPILOT_GITHUB_TOKEN` (or `GH_TOKEN` / `GITHUB_TOKEN`) in the daemon.
 *
 * Order matters — the picker renders in this order, and the first entry
 * is what alias-mode falls back to.
 */
const _COPILOT_MODEL_METADATA = {
  // Feb 2026 GA cohort — Copilot CLI default lineup
  'claude-sonnet-4.6': {
    name: 'Claude Sonnet 4.6',
    description: 'Anthropic Sonnet 4.6 — balanced default for most tasks',
    provider: 'Anthropic',
  },
  'claude-opus-4.6': {
    name: 'Claude Opus 4.6',
    description: 'Anthropic Opus 4.6 — strongest model, slower',
    provider: 'Anthropic',
  },
  'gpt-5.3-codex': {
    name: 'GPT-5.3 Codex',
    description: 'OpenAI agentic-coding model — strong tool use, faster',
    provider: 'OpenAI',
  },
  'gemini-3-pro': {
    name: 'Gemini 3 Pro',
    description: 'Google Gemini 3 Pro',
    provider: 'Google',
  },
  // Stable legacy set — kept for compatibility with existing sessions
  'gpt-4o': {
    name: 'GPT-4o',
    description: 'OpenAI general-purpose multimodal model (legacy)',
    provider: 'OpenAI',
  },
  'gpt-4o-mini': {
    name: 'GPT-4o Mini',
    description: 'Smaller, faster GPT-4o variant (legacy)',
    provider: 'OpenAI',
  },
  'claude-sonnet-4-20250514': {
    name: 'Claude Sonnet 4 (2025-05-14)',
    description: 'Date-stamped Sonnet 4 snapshot (legacy)',
    provider: 'Anthropic',
  },
  'o3-mini': {
    name: 'o3 Mini',
    description: 'OpenAI reasoning model, smaller variant',
    provider: 'OpenAI',
  },
  'o4-mini': {
    name: 'o4 Mini',
    description: 'OpenAI reasoning model, smaller variant',
    provider: 'OpenAI',
  },
} as const satisfies Record<string, { name: string; description: string; provider: string }>;

export const COPILOT_MODEL_METADATA = _COPILOT_MODEL_METADATA;

/** Known Copilot model IDs (literal union from metadata) */
export type CopilotModel = keyof typeof _COPILOT_MODEL_METADATA;

/** Backwards-compat: tuple of known model IDs */
export const COPILOT_MODELS = Object.keys(COPILOT_MODEL_METADATA) as CopilotModel[];

const DEFAULT_COPILOT_CONTEXT_LIMIT = 128_000;

export const COPILOT_CONTEXT_LIMITS: Record<string, number> = {
  'claude-sonnet-4.6': 200_000,
  'claude-opus-4.6': 200_000,
  'gpt-5.3-codex': 400_000,
  'gemini-3-pro': 1_000_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'claude-sonnet-4-20250514': 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
};

export function getCopilotContextWindowLimit(model?: string): number {
  if (!model) return DEFAULT_COPILOT_CONTEXT_LIMIT;
  return COPILOT_CONTEXT_LIMITS[model] ?? DEFAULT_COPILOT_CONTEXT_LIMIT;
}
