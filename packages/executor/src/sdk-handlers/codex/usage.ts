import type { ContextUsageSnapshot } from '@agor/core/types';
import type { TokenUsage } from '../../types/token-usage.js';

/**
 * Baseline overhead the Codex CLI subtracts from both `used` and `context_window`
 * before computing the displayed "Context XX% used" percentage.
 *
 * Mirrors `BASELINE_TOKENS` in codex-rs/protocol/src/protocol.rs (12_000 at the
 * time of writing). Represents the system prompt + tool schema overhead that
 * is always present in the context and is not user-controllable. Subtracting
 * it on both sides makes the percentage reflect user-visible context only.
 *
 * Ref: https://github.com/openai/codex (protocol.rs `percent_of_context_window_remaining`)
 */
export const CODEX_BASELINE_OVERHEAD_TOKENS = 12_000;

function normalizeNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function sanitizeTokenCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, value);
}

/**
 * Codex baseline-adjusted "% context used" — exact complement of
 * `percent_of_context_window_remaining(window)` in codex-rs
 * (protocol.rs), so our UI shows the same integer as the Codex TUI's
 * "Context XX% used" indicator.
 *
 * Implemented by computing `remaining` first and returning
 * `100 - round(remaining/effective * 100)`. Doing it the other way
 * (rounding `used/effective` directly) drifts by 1 at `.5` boundaries
 * because of how rounding is asymmetric around the midpoint.
 *
 * Both `usedTokens` and `contextWindow` have `CODEX_BASELINE_OVERHEAD_TOKENS`
 * subtracted before the division, so the percentage reflects
 * user-controllable context only. Returns a 0–100 integer; returns 0
 * when the window is at or below the baseline (degenerate).
 *
 * Exported so tests can assert against the production formula instead of
 * re-implementing it in a test helper.
 */
export function codexUsedPercentage(usedTokens: number, contextWindow: number): number {
  if (contextWindow <= CODEX_BASELINE_OVERHEAD_TOKENS) return 0;
  const effectiveWindow = contextWindow - CODEX_BASELINE_OVERHEAD_TOKENS;
  const used = Math.max(0, usedTokens - CODEX_BASELINE_OVERHEAD_TOKENS);
  const remaining = Math.max(0, effectiveWindow - used);
  const remainingPercent = Math.max(
    0,
    Math.min(100, Math.round((remaining / effectiveWindow) * 100))
  );
  return 100 - remainingPercent;
}

/**
 * Normalize Codex SDK usage payload into Agor's TokenUsage shape.
 *
 * Codex (@openai/codex-sdk >= 0.133) emits turn.completed events with a usage block:
 * {
 *   input_tokens,
 *   cached_input_tokens,
 *   output_tokens,
 *   reasoning_output_tokens   // subset of output_tokens (Responses API convention)
 * }
 *
 * Notes:
 * - We map cached_input_tokens → cache_read_tokens so downstream utilities
 *   (cost + context window) can treat Codex like Claude/Gemini.
 * - reasoning_output_tokens is intentionally NOT added to totals because
 *   per the OpenAI Responses API it is already included in output_tokens.
 *   It is preserved on the raw SDK response for debugging/UI surfacing.
 * - The SDK does NOT emit total_tokens. We derive it from input + output.
 */
export function extractCodexTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const payload = raw as Record<string, unknown>;
  const inputTokens = normalizeNumber(payload.input_tokens ?? payload.inputTokens);
  const outputTokens = normalizeNumber(payload.output_tokens ?? payload.outputTokens);
  const cacheReadTokens = normalizeNumber(
    payload.cached_input_tokens ?? payload.cachedInputTokens ?? payload.cache_read_tokens
  );
  const totalTokens = normalizeNumber(
    payload.total_tokens ??
      payload.totalTokens ??
      (inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens || 0) + (outputTokens || 0)
        : undefined)
  );

  const usage: TokenUsage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    total_tokens: totalTokens,
  };

  if (
    usage.input_tokens === undefined &&
    usage.output_tokens === undefined &&
    usage.cache_read_tokens === undefined &&
    usage.total_tokens === undefined
  ) {
    return undefined;
  }

  return usage;
}

/**
 * Extract a context-window estimate from an explicit context payload.
 *
 * IMPORTANT: `turn.completed.usage.input_tokens` is NOT used here. For Codex
 * that field is per model request/turn accounting, includes cached prefixes,
 * may include tool/system/context replay, and can be much larger than the
 * model context window on observed first turns. It is useful for token/cost
 * accounting, but it is not a reliable current context-window occupancy.
 *
 * The only Codex context-window source Agor currently trusts is
 * `event_msg` / `token_count` via `extractCodexContextSnapshotFromEvent()`.
 * This helper is deliberately narrow and only accepts future/legacy payloads
 * that name context tokens explicitly. When no explicit context field exists,
 * return undefined so the UI can hide context percentage instead of showing
 * a bogus 100% bar.
 */
export function extractCodexContextWindowUsage(raw: unknown): number | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const payload = raw as Record<string, unknown>;
  const usage =
    payload.usage && typeof payload.usage === 'object' && !Array.isArray(payload.usage)
      ? (payload.usage as Record<string, unknown>)
      : payload;

  return sanitizeTokenCount(
    normalizeNumber(
      usage.context_tokens ??
        usage.contextTokens ??
        usage.current_context_tokens ??
        usage.currentContextTokens
    )
  );
}

/**
 * Extract an authoritative context-window snapshot from a Codex
 * `event_msg` / `token_count` payload.
 *
 * Expected event shape (Codex CLI internal protocol, surfaced via
 * `--experimental-json` which `@openai/codex-sdk.runStreamed()` enables):
 *
 *   {
 *     type: "event_msg",
 *     payload: {
 *       type: "token_count",
 *       info: {
 *         last_token_usage:  { input_tokens, cached_input_tokens, output_tokens,
 *                              reasoning_output_tokens, total_tokens },
 *         total_token_usage: { ...same fields, CUMULATIVE across the whole thread },
 *         model_context_window: number
 *       }
 *     }
 *   }
 *
 * CRITICAL DISTINCTION (see https://github.com/openai/codex,
 * codex-rs/protocol/src/protocol.rs):
 *
 *  - `last_token_usage` is the MOST RECENT model API call's tokens. Because
 *    each call sees the assembled transcript, `last_token_usage.total_tokens`
 *    IS the current context-window occupancy. This is what the Codex CLI's
 *    TUI uses to render "Context XX% used".
 *
 *  - `total_token_usage` is the LIFETIME cumulative sum across every model
 *    API call the thread has made (each tool-loop iteration adds another
 *    API call, so a single user turn can rack up many). It grows unboundedly
 *    and routinely exceeds the model context window on tool-heavy sessions —
 *    using it as "current usage" produces nonsense numbers >100%.
 *
 * Earlier versions of this code used `total_token_usage.total_tokens` and
 * therefore showed wildly inflated context-usage on the first call of
 * tool-heavy sessions. We now prefer `last_token_usage`. The
 * `total_token_usage` fallback is only triggered for legacy events that
 * predate the `last_token_usage` field.
 *
 * The reported `percentage` mirrors codex-rs's `percent_of_context_window_remaining`:
 * both the used count and the context window have `CODEX_BASELINE_OVERHEAD_TOKENS`
 * subtracted before division, so the value matches what users see in the CLI.
 */
export function extractCodexContextSnapshotFromEvent(
  raw: unknown
): ContextUsageSnapshot | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const event = raw as Record<string, unknown>;
  if (event.type !== 'event_msg') {
    return undefined;
  }

  const payload =
    event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : undefined;
  if (payload?.type !== 'token_count') {
    return undefined;
  }

  const info =
    payload.info && typeof payload.info === 'object' && !Array.isArray(payload.info)
      ? (payload.info as Record<string, unknown>)
      : undefined;
  if (!info) {
    return undefined;
  }

  const asUsage = (value: unknown): Record<string, unknown> | undefined =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;

  const lastUsage = asUsage(info.last_token_usage ?? info.lastTokenUsage);
  const totalUsage = asUsage(info.total_token_usage ?? info.totalTokenUsage);

  // Prefer last_token_usage (current occupancy). Fall back to total_token_usage
  // only when last is missing — this is an inflated cumulative value, but it's
  // better than nothing for very old payloads.
  const totalTokens =
    sanitizeTokenCount(normalizeNumber(lastUsage?.total_tokens ?? lastUsage?.totalTokens)) ??
    sanitizeTokenCount(normalizeNumber(totalUsage?.total_tokens ?? totalUsage?.totalTokens));

  const maxTokens = sanitizeTokenCount(
    normalizeNumber(info.model_context_window ?? info.modelContextWindow)
  );

  if (totalTokens === undefined || maxTokens === undefined || maxTokens <= 0) {
    return undefined;
  }

  return {
    totalTokens,
    maxTokens,
    percentage: codexUsedPercentage(totalTokens, maxTokens),
  };
}
