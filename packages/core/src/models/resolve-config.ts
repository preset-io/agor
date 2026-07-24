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
 *   stamp, conditional optional-field inclusion), avoiding drift.
 * - Makes it safe to add a new optional field (e.g. a future `temperature`)
 *   in exactly one place.
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
  notes?: string;
  effort?: EffortLevel;
  advisorModel?: string;
  provider?: string;
};

/**
 * Canonical persisted shape — a non-null `Session.model_config`.
 */
export type ResolvedModelConfig = NonNullable<Session['model_config']>;

/** Whether a model config already has the complete persisted shape. */
export function isResolvedModelConfig(
  input: Partial<ResolvedModelConfig> | null | undefined
): input is ResolvedModelConfig {
  return Boolean(input?.mode && input.model && input.updated_at);
}

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
 * - Optional fields are only included when explicitly defined, so
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
    ...(input.notes !== undefined && { notes: input.notes }),
    ...(input.effort !== undefined && { effort: input.effort }),
    ...(input.advisorModel !== undefined && { advisorModel: input.advisorModel }),
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
 * Static default model for a tool. Undefined for cursor / opencode whose
 * defaults are sourced elsewhere (async daemon fetch / provider+model pair).
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
      return undefined;
  }
}

/** Extract model-less overrides that are safe to carry onto a fallback model. */
function getModelLessFallbackOverrides(
  input: ModelConfigInput | undefined | null
): ModelConfigInput | undefined {
  const overrides: ModelConfigInput = {};
  if (input?.notes !== undefined) overrides.notes = input.notes;
  if (input?.effort !== undefined) overrides.effort = input.effort;
  if (input?.advisorModel !== undefined) overrides.advisorModel = input.advisorModel;
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

/** Merge model-less overrides, preserving higher-priority values already seen. */
function mergeModelLessFallbackOverrides(
  existing: ModelConfigInput | undefined,
  next: ModelConfigInput | undefined
): ModelConfigInput | undefined {
  if (!existing) return next;
  if (!next) return existing;
  return {
    ...next,
    ...existing,
  };
}

/**
 * Resolve model config at a session-create boundary.
 *
 * Full model configs remain first-wins and are not merged with lower-priority
 * sources. However, higher-priority sources that only carry model-less
 * overrides (for example `effort` or Claude Code `advisorModel`) are accumulated
 * with per-field precedence and merged onto the next source that supplies the
 * actual model, or onto the tool fallback.
 * We intentionally do not
 * carry model-less `mode` / `provider` because their meaning depends on the
 * missing model value. This prevents partial persisted model_config objects
 * while preserving explicit notes, effort, and advisor choices.
 */
export function resolveModelConfigWithFallback(
  tool: AgenticToolName,
  sources: Array<ModelConfigInput | undefined | null>,
  opts?: { now?: Date }
): ResolvedModelConfig | undefined {
  let pendingModelLessOverrides: ModelConfigInput | undefined;

  for (const source of sources) {
    if (source?.model) {
      return resolveModelConfig(
        pendingModelLessOverrides
          ? { ...source, ...pendingModelLessOverrides, model: source.model }
          : source,
        opts
      );
    }
    pendingModelLessOverrides = mergeModelLessFallbackOverrides(
      pendingModelLessOverrides,
      getModelLessFallbackOverrides(source)
    );
  }

  const toolDefault = getDefaultModelForTool(tool);
  if (!toolDefault) return undefined;
  return resolveModelConfig(
    pendingModelLessOverrides
      ? { mode: 'alias', ...pendingModelLessOverrides, model: toolDefault }
      : { mode: 'alias', model: toolDefault },
    opts
  );
}
