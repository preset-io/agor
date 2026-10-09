/**
 * Context Window Utilities
 *
 * Helpers for calculating and rendering context window progress indicators.
 */

import type { ContextUsageSnapshot, Task } from '@agor/core/types';
import type { ReactiveContextWindow } from '@agor-live/client';

export interface ContextWindowColors {
  normal: string;
  warning: string;
  critical: string;
}

/**
 * Get color for context window usage based on percentage
 *
 * @param percentage - Usage percentage (0-100)
 * @param colors - Theme-derived semantic surface colors
 * @returns the semantic color for the usage band
 */
export function getContextWindowColor(percentage: number, colors: ContextWindowColors): string {
  if (percentage < 50) {
    return colors.normal;
  }
  if (percentage < 80) {
    return colors.warning;
  }
  return colors.critical;
}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

/**
 * Resolve the percentage to display for a context-window indicator.
 *
 * When the executor produced an authoritative `ContextUsageSnapshot`
 * (via the SDK or CLI protocol — e.g. Codex applies a baseline-adjusted
 * formula that does not equal `used / limit`), use its `percentage`
 * verbatim so the UI matches the agent's own display. Otherwise fall
 * back to the raw `used / limit` ratio.
 */
export function resolveContextWindowPercentage(
  used: number | undefined,
  limit: number | undefined,
  snapshot?: ContextUsageSnapshot | null
): number {
  if (snapshot && Number.isFinite(snapshot.percentage)) {
    return clampPercentage(snapshot.percentage);
  }
  if (!used || !limit) return 0;
  return clampPercentage((used / limit) * 100);
}

/**
 * Create a horizontal gradient background for context window progress.
 *
 * Prefers the executor-supplied `ContextUsageSnapshot.percentage` when
 * available so the gradient stays in lockstep with the displayed pill
 * label.
 */
export function getContextWindowGradient(
  used: number | undefined,
  limit: number | undefined,
  snapshot: ContextUsageSnapshot | null | undefined,
  colors: ContextWindowColors
): string | undefined {
  if (!snapshot && (!used || !limit)) return undefined;

  const percentage = resolveContextWindowPercentage(used, limit, snapshot);
  const color = getContextWindowColor(percentage, colors);

  return `linear-gradient(to right, ${color} ${percentage}%, transparent ${percentage}%)`;
}

/**
 * Calculate context window usage percentage.
 *
 * @deprecated Prefer `resolveContextWindowPercentage` so an authoritative
 * `ContextUsageSnapshot.percentage` is honored when present. Kept for
 * callers that genuinely want the raw `used / limit` ratio.
 */
export function getContextWindowPercentage(
  used: number | undefined,
  limit: number | undefined
): number {
  return resolveContextWindowPercentage(used, limit, null);
}

/**
 * The footer's context-window indicator. Reads the session handle's projection,
 * which outlives the lean transcript trimming the turn it came from; the raw SDK
 * response (per-model breakdown) is only offered while that turn is loaded.
 */
export function selectLatestContextWindow(
  projection: ReactiveContextWindow | undefined,
  tasks: readonly Task[],
  agenticTool: string | undefined
) {
  if (!agenticTool || !projection) return null;
  const { contextWindowLimit, contextUsageSnapshot } = projection.normalized_sdk_response;
  return {
    used: projection.computed_context_window,
    limit: contextUsageSnapshot?.maxTokens ?? contextWindowLimit ?? 0,
    // Forward the full normalized response so ContextWindowPill can honor
    // `contextUsageSnapshot.percentage` instead of recomputing from raw
    // used/limit (which is wrong for Codex's baseline-adjusted display).
    taskMetadata: {
      model: projection.model,
      duration_ms: projection.duration_ms,
      agentic_tool: agenticTool,
      raw_sdk_response: tasks.find((task) => task.task_id === projection.task_id)?.raw_sdk_response,
      normalized_sdk_response: projection.normalized_sdk_response,
    },
  };
}
