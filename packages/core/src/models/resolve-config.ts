/**
 * Model configuration normalization
 *
 * Single source of truth for turning a partial model-config input (from an
 * MCP tool arg, a user default, a worktree setting, etc.) into the canonical
 * shape persisted on `Session['model_config']`.
 *
 * Callers compose these helpers into a precedence chain instead of hand-rolling
 * the normalization at every session-creation site (MCP create, spawn service,
 * worktree auto-create, gateway session creation, ...). Centralizing here:
 *
 * - Guarantees every site writes the same shape (mode default, updated_at
 *   stamp, conditional effort/provider inclusion), avoiding drift.
 * - Makes it safe to add a new optional field (e.g. a future `notes` or
 *   `temperature`) in exactly one place.
 * - Returns `undefined` when there is no usable model, so callers can chain
 *   with `??` or feed a list into `resolveModelConfigPrecedence`.
 */
import type { EffortLevel, Session } from '../types/session.js';

/**
 * Loose input shape accepted by the resolver.
 *
 * Mirrors `Session['model_config']` but every field is optional so we can
 * accept partials from MCP Zod schemas, user/tool defaults, worktree
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
 * worktree override > user default" pattern used at session-create time.
 *
 * Example:
 * ```ts
 * const modelConfig = resolveModelConfigPrecedence([
 *   args.modelConfig,              // explicit MCP arg
 *   worktree.modelConfig,          // worktree override
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
