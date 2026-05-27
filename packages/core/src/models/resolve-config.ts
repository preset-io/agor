/**
 * Model configuration normalization
 *
 * Single source of truth for turning a partial model-config input (from an
 * MCP tool arg, a user default, a branch setting, etc.) into the canonical
 * shape persisted on `Session['model_config']`.
 *
 * Callers compose these helpers into a precedence chain instead of hand-rolling
 * the normalization at every session-creation site (MCP create, spawn service,
 * branch auto-create, gateway session creation, ...). Centralizing here:
 *
 * - Guarantees every site writes the same shape (mode default, updated_at
 *   stamp, conditional effort/provider inclusion), avoiding drift.
 * - Makes it safe to add a new optional field (e.g. a future `notes` or
 *   `temperature`) in exactly one place.
 * - Returns `undefined` when there is no usable model, so callers can chain
 *   with `??` or feed a list into `resolveModelConfigPrecedence`.
 */
import type { AgenticToolName } from '../types/index.js';
import type { EffortLevel, Session } from '../types/session.js';
import { DEFAULT_CLAUDE_MODEL } from './claude.js';
import { DEFAULT_CODEX_MODEL } from './codex.js';
import { DEFAULT_COPILOT_MODEL } from './copilot.js';
import { DEFAULT_GEMINI_MODEL } from './gemini-shared.js';

/**
 * Loose input shape accepted by the resolver.
 *
 * Mirrors `Session['model_config']` but every field is optional so we can
 * accept partials from MCP Zod schemas, user/tool defaults, branch
 * overrides, and legacy callers — then either normalize or reject them
 * based on whether `model` is set.
 */
export type ModelConfigInput = {
  mode?: 'alias' | 'exact';
  model?: string;
  effort?: EffortLevel;
  provider?: string;
};

/**
 * Canonical persisted shape — a non-null `Session.model_config`.
 */
export type ResolvedModelConfig = NonNullable<Session['model_config']>;

/**
 * Normalize a partial model-config into the shape persisted on
 * `session.model_config`. Returns `undefined` if no usable `model` was
 * provided, so callers can fall through to the next source in a precedence
 * chain.
 *
 * Behavior:
 * - `mode` defaults to `'alias'` (matches every legacy call site).
 * - `updated_at` is stamped from `opts.now ?? new Date()` (injectable for
 *   determinism in tests).
 * - `effort` and `provider` are only included when explicitly defined, so
 *   we never write `undefined` values onto the persisted object.
 */
export function resolveModelConfig(
  input: ModelConfigInput | undefined | null,
  opts?: { now?: Date }
): ResolvedModelConfig | undefined {
  if (!input?.model) return undefined;
  return {
    mode: input.mode ?? 'alias',
    model: input.model,
    updated_at: (opts?.now ?? new Date()).toISOString(),
    ...(input.effort !== undefined && { effort: input.effort }),
    ...(input.provider !== undefined && { provider: input.provider }),
  };
}

/**
 * Walk a precedence list (highest priority first) and return the first
 * source that yields a resolvable model config. Mirrors the "explicit arg >
 * branch override > user default" pattern used at session-create time.
 *
 * Example:
 * ```ts
 * const modelConfig = resolveModelConfigPrecedence([
 *   args.modelConfig,              // explicit MCP arg
 *   branch.modelConfig,          // branch override
 *   userToolDefaults?.modelConfig, // user default
 * ]);
 * ```
 */
export function resolveModelConfigPrecedence(
  sources: Array<ModelConfigInput | undefined | null>,
  opts?: { now?: Date }
): ResolvedModelConfig | undefined {
  for (const src of sources) {
    const resolved = resolveModelConfig(src, opts);
    if (resolved) return resolved;
  }
  return undefined;
}

/**
 * Default model identifier for an agentic tool. Single source of truth used
 * by the UI form, the daemon's session-create hook, and any session-creation
 * helper that needs a final fallback when the user has expressed no
 * preference. Mirrors what the `ModelSelector` displays as its visual
 * default (the first entry per tool).
 *
 * Returns `undefined` for tools whose default depends on async data
 * (`cursor` — fetched live from the daemon's `cursor-models` service) or
 * structural choices the picker doesn't take statically (`opencode` — needs
 * a provider as well as a model).
 */
export function getDefaultModelForTool(tool: AgenticToolName): string | undefined {
  switch (tool) {
    case 'claude-code':
    case 'claude-code-cli':
      return DEFAULT_CLAUDE_MODEL;
    case 'codex':
      return DEFAULT_CODEX_MODEL;
    case 'gemini':
      return DEFAULT_GEMINI_MODEL;
    case 'copilot':
      return DEFAULT_COPILOT_MODEL;
    default:
      // cursor / opencode handled by their own selectors.
      return undefined;
  }
}

/**
 * Walk a precedence list AND fall back to the tool's static default when
 * nothing in the list matched. Returns `undefined` only for tools that have
 * no static default (cursor / opencode); the caller is expected to either
 * accept that or fetch the default through a tool-specific channel.
 *
 * This is the helper to reach for at the *session-create boundary* — the
 * single point that decides what gets persisted on `session.model_config`.
 * Downstream code (executor, normalizers, UI display) reads what was
 * persisted; it must not re-implement defaulting.
 *
 * Example:
 * ```ts
 * const modelConfig = resolveModelConfigWithFallback(tool, [
 *   args.modelConfig,
 *   userToolDefaults?.modelConfig,
 * ]);
 * ```
 */
export function resolveModelConfigWithFallback(
  tool: AgenticToolName,
  sources: Array<ModelConfigInput | undefined | null>,
  opts?: { now?: Date }
): ResolvedModelConfig | undefined {
  const fromSources = resolveModelConfigPrecedence(sources, opts);
  if (fromSources) return fromSources;
  const toolDefault = getDefaultModelForTool(tool);
  if (!toolDefault) return undefined;
  return resolveModelConfig({ mode: 'alias', model: toolDefault }, opts);
}
